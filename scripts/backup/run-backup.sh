#!/usr/bin/env bash
#
# Off-site backup of ChairBack prod → Cloudflare R2.
#
# Backs up two things that are NOT in git:
#   1. The prod Postgres database (pg_dump, custom/compressed format, restorable)
#   2. The Supabase Storage "shop-media" bucket (shop logo/hero/gallery/avatar photos)
#
# Designed to run on a Linux GitHub Actions runner, but works anywhere with
# bash + pg_dump (client v15+) + rclone installed. Every input is an env var so
# no secret ever touches disk or the repo.
#
# Required env (see .github/workflows/backup.yml + docs/BACKUP.md for where each comes from):
#   PROD_DIRECT_URL              Postgres DIRECT (5432) connection string for prod
#   R2_ACCOUNT_ID                Cloudflare account id
#   R2_ACCESS_KEY_ID             R2 API token access key
#   R2_SECRET_ACCESS_KEY         R2 API token secret
#   R2_BUCKET                    destination R2 bucket name (e.g. chairback-backups)
#   SUPABASE_S3_ENDPOINT         Supabase Storage S3 endpoint (https://<ref>.storage.supabase.co/storage/v1/s3)
#   SUPABASE_S3_REGION           Supabase project region (e.g. us-east-1)
#   SUPABASE_S3_ACCESS_KEY_ID    Supabase Storage S3 access key
#   SUPABASE_S3_SECRET_ACCESS_KEY Supabase Storage S3 secret key
#   SUPABASE_STORAGE_BUCKET      source bucket name (default: shop-media)
# Optional:
#   RETENTION_DAYS               delete DB dumps in R2 older than this (default 30; 0 = keep forever)

set -euo pipefail

# --- required-var check (fail fast with a clear message, never a half-run) ---
require() {
  local missing=0
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then
      echo "::error::missing required env var: $v" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || { echo "Aborting: set the vars above." >&2; exit 2; }
}
require PROD_DIRECT_URL \
        R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET \
        SUPABASE_S3_ENDPOINT SUPABASE_S3_REGION \
        SUPABASE_S3_ACCESS_KEY_ID SUPABASE_S3_SECRET_ACCESS_KEY

# Pasting a secret into the GitHub UI easily appends stray characters — a trailing
# newline, CR, non-breaking space (U+00A0), or a zero-width/BOM char — none of which
# `[[:space:]]` reliably matches. A stray char on the connection URL makes pg_dump
# read the db name as "postgres\n" and fail with `database "postgres" does not exist`.
# Nuke every ASCII control char (0x00-0x1F, 0x7F) and surrounding whitespace from the
# values we interpolate, using `tr` (handles \r \n \t) then a whitespace trim.
sanitize() {
  local v
  v="$(printf '%s' "$1" | tr -d '\000-\037\177')"        # strip all C0 controls + DEL
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"  # trim edge whitespace
  printf '%s' "$v"
}
PROD_DIRECT_URL="$(sanitize "$PROD_DIRECT_URL")"
SUPABASE_S3_ENDPOINT="$(sanitize "$SUPABASE_S3_ENDPOINT")"
SUPABASE_S3_REGION="$(sanitize "$SUPABASE_S3_REGION")"
R2_ACCOUNT_ID="$(sanitize "$R2_ACCOUNT_ID")"
R2_BUCKET="$(sanitize "$R2_BUCKET")"

# One-line diagnostic (NO secrets): confirm the URL parses to the expected db name.
# If this ever prints a db other than "postgres", the value has hidden chars we
# didn't strip — surfaces the problem instead of a cryptic pg_dump failure.
_db="${PROD_DIRECT_URL##*/}"
echo "==> parsed target database: [${_db}] (expect: [postgres]), url length: ${#PROD_DIRECT_URL}"

SRC_BUCKET="${SUPABASE_STORAGE_BUCKET:-shop-media}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# A UTC datestamp for object keys. Passed in by the workflow (scripts can't call
# `date` deterministically in every context); fall back to `date` when run locally.
STAMP="${BACKUP_STAMP:-$(date -u +%Y/%m/%d/%H%M%SZ)}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> ChairBack backup @ ${STAMP} (UTC)"

# --- rclone config, entirely in-env (no config file on disk) ---
# R2 is S3-compatible; Cloudflare's S3 endpoint is account-scoped.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACL=private
# Supabase Storage also speaks S3 — mount it as a second rclone remote.
export RCLONE_CONFIG_SB_TYPE=s3
export RCLONE_CONFIG_SB_PROVIDER=Other
export RCLONE_CONFIG_SB_ACCESS_KEY_ID="$SUPABASE_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_SB_SECRET_ACCESS_KEY="$SUPABASE_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_SB_ENDPOINT="$SUPABASE_S3_ENDPOINT"
export RCLONE_CONFIG_SB_REGION="$SUPABASE_S3_REGION"

# ============================================================
# 1) DATABASE  →  R2:<bucket>/db/<stamp>.dump
# ============================================================
DUMP="$WORKDIR/chairback-${STAMP//\//-}.dump"
echo "==> pg_dump prod database..."
# -Fc = custom format: compressed AND restorable with pg_restore (schema + data,
# selective restore possible). --no-owner/--no-acl so it restores cleanly into a
# fresh project regardless of role names.
pg_dump "$PROD_DIRECT_URL" \
  --format=custom --no-owner --no-acl --verbose \
  --file="$DUMP"
DUMP_BYTES=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
echo "    dump size: ${DUMP_BYTES} bytes"
# Guard against a silent empty dump (a broken connection can yield a tiny file).
if [ "$DUMP_BYTES" -lt 1024 ]; then
  echo "::error::dump is suspiciously small (${DUMP_BYTES}B) — treating as failure" >&2
  exit 3
fi

echo "==> uploading dump to R2..."
rclone copyto "$DUMP" "R2:${R2_BUCKET}/db/${STAMP}.dump" --s3-no-check-bucket

# ============================================================
# 2) PHOTOS  →  R2:<bucket>/storage/shop-media/  (mirror)
# ============================================================
echo "==> syncing Supabase Storage bucket '${SRC_BUCKET}' → R2..."
# `sync` mirrors (adds new, updates changed, deletes removed) so R2 always matches
# live storage. Photos are namespaced by shop already; we keep a single live mirror
# rather than dated copies (they're large and rarely change).
rclone sync "SB:${SRC_BUCKET}" "R2:${R2_BUCKET}/storage/${SRC_BUCKET}" \
  --s3-no-check-bucket --fast-list

# ============================================================
# 3) RETENTION  — prune old DB dumps (photos mirror is not dated)
# ============================================================
if [ "$RETENTION_DAYS" -gt 0 ]; then
  echo "==> pruning db dumps older than ${RETENTION_DAYS}d..."
  rclone delete "R2:${R2_BUCKET}/db" --min-age "${RETENTION_DAYS}d" --s3-no-check-bucket || true
fi

echo "==> done. DB dump: R2:${R2_BUCKET}/db/${STAMP}.dump"
echo "==> photos mirror: R2:${R2_BUCKET}/storage/${SRC_BUCKET}/"
