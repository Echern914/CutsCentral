# Off-site backups → Cloudflare R2

ChairBack's prod data lives in Supabase (Postgres + Storage). Supabase keeps its
own automated backups, but those live inside the same account — if the account is
lost, suspended, or fat-fingered, they go with it. This is a **second, independent
copy** in a different provider (Cloudflare R2), which is what "off-site backup"
means.

**What gets backed up** (nightly, plus a manual button):

| What | Source | Lands in R2 as | Cadence |
|---|---|---|---|
| Postgres database | prod Supabase (direct 5432) | `db/YYYY/MM/DD/HHMMSSZ.dump` (pg_dump custom format) | nightly, dated, pruned after 30d |
| Shop photos | Supabase Storage `shop-media` | `storage/shop-media/…` (live mirror) | nightly, mirrored (not dated) |

Runs as a GitHub Action: [`.github/workflows/backup.yml`](../.github/workflows/backup.yml),
which calls [`scripts/backup/run-backup.sh`](../scripts/backup/run-backup.sh).
Schedule: **07:15 UTC daily** (~03:15 ET). No app infra touched; runs even if your
laptop is off.

> 🔒 **The DB dump contains client PII and TCPA consent records.** The R2 bucket
> MUST be private (R2 buckets are private by default — do not attach a public
> `r2.dev` domain or a custom domain to it). All credentials live in GitHub Actions
> secrets, never in the repo. Adding Cloudflare as a data location means Cloudflare
> should be listed as a subprocessor in the privacy policy (see
> `LEGAL-CHECKLIST.md` §4) before this handles real customer data long-term.

---

## One-time setup (your clicks)

### 1. Create the R2 bucket
1. Cloudflare dashboard → **R2** → **Create bucket**. Name it `chairback-backups`.
   Leave it **private** (default). Note your **Account ID** (shown on the R2
   overview page / bucket page).
2. R2 → **Manage R2 API Tokens** → **Create API token**.
   - Permission: **Object Read & Write**.
   - Scope it to the `chairback-backups` bucket (least privilege).
   - Create → copy the **Access Key ID** and **Secret Access Key** (shown once).

### 2. Get Supabase Storage S3 credentials (for the photo mirror)
Supabase Storage speaks the S3 API, which is how we mirror the bucket.
1. Supabase dashboard → **prod** project → **Project Settings → Storage** (or
   Settings → API, "S3 Connection" section).
2. Note the **S3 endpoint** — looks like
   `https://<projectref>.storage.supabase.co/storage/v1/s3` — and the **region**
   (e.g. `us-east-1`).
3. **New access key** → copy the **Access Key ID** and **Secret Access Key**.

### 3. Get the prod DB direct URL
You already have it — it's the `PROD_DIRECT_URL` you use for `prisma migrate deploy`
(kept in `DEPLOY.md`, gitignored; the **direct** connection, port **5432**, not the
pooler). It looks like:
`postgresql://postgres.<ref>:<PASS>@aws-0-<region>.pooler.supabase.com:5432/postgres`
(the `@` in the password must be URL-encoded as `%40`).

### 4. Add the GitHub Actions secrets
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**,
one per row:

| Secret name | Value |
|---|---|
| `PROD_DIRECT_URL` | prod Postgres direct (5432) connection string |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | `chairback-backups` |
| `SUPABASE_S3_ENDPOINT` | `https://<ref>.storage.supabase.co/storage/v1/s3` |
| `SUPABASE_S3_REGION` | e.g. `us-east-1` |
| `SUPABASE_S3_ACCESS_KEY_ID` | Supabase Storage S3 access key |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | Supabase Storage S3 secret |
| `SUPABASE_STORAGE_BUCKET` | `shop-media` |

Optional: a repo **Variable** (not secret) `BACKUP_RETENTION_DAYS` (default `30`;
set `0` to keep DB dumps forever).

### 5. Run it once by hand
GitHub → **Actions** → **Backup to Cloudflare R2** → **Run workflow**. Watch it go
green, then confirm objects appear in the R2 bucket (`db/…` and `storage/shop-media/…`).
After that, the nightly schedule takes over.

---

## Restoring (test this at least once — an untested backup isn't a backup)

**Database** — download a dump from R2, then restore into a *fresh* Supabase project
(never straight over prod):
```bash
# download the dump you want (R2 → local) with rclone or the dashboard, then:
pg_restore --no-owner --no-acl --clean --if-exists \
  --dbname="postgresql://postgres.<NEWref>:<PASS>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  chairback-2026-01-01-...dump
```
`--clean --if-exists` lets you re-run it; `pg_restore -l dump` lists contents if you
want a selective restore of one table.

**Photos** — mirror the R2 copy back into a Storage bucket with `rclone sync` (reverse
of the backup direction), or serve them directly from R2.

---

## Local one-off run (optional)
The script runs anywhere with `bash`, `pg_dump` (client v15+), and `rclone`. Export
the same vars listed at the top of `scripts/backup/run-backup.sh` and run it:
```bash
bash scripts/backup/run-backup.sh
```
On this Windows box, use the Git Bash / WSL shell and install `rclone` +
`postgresql-client`. The GitHub Action is the supported path; local is for spot checks.
