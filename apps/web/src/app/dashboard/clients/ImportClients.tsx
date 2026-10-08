"use client";

import { useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { importClientsAction, type ImportClientRow, type ImportResult } from "../actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/**
 * CSV client import — the "bring your book off Booksy/Fresha/Vagaro" flow. The
 * file is parsed ENTIRELY in the browser (no upload); we map columns by header,
 * preview, then POST JSON rows. An import never makes anyone textable, and the
 * UI says so (a contact list is not proof that anyone agreed to texts).
 *
 * The browser sends in batches of 500 so a big book doesn't hit the per-request
 * cap; results are summed across batches.
 */
const BATCH = 500;
/** How many matched rows to list by name; the count always shows. */
const REVIEW_SHOWN = 50;

/** "rows 3, 7 and 12" - capped, so one bad column cannot print a thousand numbers. */
function rowList(rows: { row: number }[]): string {
  const shown = rows.slice(0, 10).map((r) => r.row);
  const more = rows.length - shown.length;
  return `row${rows.length === 1 ? "" : "s"} ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Minimal RFC-4180-ish CSV parser: handles quotes, escaped "", CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Find a column index whose header matches any of the given aliases. */
function findCol(header: string[], aliases: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  for (const a of aliases) {
    const idx = norm.indexOf(a);
    if (idx !== -1) return idx;
  }
  return -1;
}

function mapRows(grid: string[][]): { rows: ImportClientRow[]; warning?: string } {
  if (grid.length < 1) return { rows: [] };
  const header = grid[0]!;
  const iFirst = findCol(header, ["firstname", "first", "fname", "givenname"]);
  const iLast = findCol(header, ["lastname", "last", "lname", "surname", "familyname"]);
  const iName = findCol(header, ["name", "fullname", "client", "customer", "customername"]);
  const iPhone = findCol(header, ["phone", "mobile", "cell", "phonenumber", "tel", "telephone"]);
  const iEmail = findCol(header, ["email", "emailaddress", "mail"]);
  const iNotes = findCol(header, ["notes", "note", "comment", "comments"]);

  // Need at least a name source.
  if (iFirst === -1 && iName === -1) {
    return { rows: [], warning: "Couldn't find a name column. Add a header row with First name / Name." };
  }

  const out: ImportClientRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!;
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i]!.trim() : "");
    let firstName = get(iFirst);
    let lastName = get(iLast);
    if (!firstName && iName !== -1) {
      // Split a single "Full Name" into first + rest.
      const full = get(iName);
      const parts = full.split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }
    if (!firstName) continue; // a row with no name is unusable
    out.push({
      firstName: firstName.slice(0, 80),
      lastName: lastName ? lastName.slice(0, 80) : undefined,
      // Every field within the API's caps: one long cell used to fail the
      // WHOLE 500-row batch with no row number. Over 40 characters is never
      // one phone number, so the server reports it as that row's skip.
      phone: get(iPhone).slice(0, 40) || undefined,
      email: get(iEmail).slice(0, 160) || undefined,
      notes: get(iNotes).slice(0, 2000) || undefined,
    });
  }
  return { rows: out };
}

export function ImportClients({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<ImportClientRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const { rows: mapped, warning } = mapRows(parseCsv(String(reader.result ?? "")));
      if (warning) {
        toast(warning, "error");
        setRows([]);
        return;
      }
      if (mapped.length === 0) {
        toast("No client rows found in that file.", "error");
        setRows([]);
        return;
      }
      setRows(mapped);
    };
    reader.readAsText(file);
  }

  function doImport() {
    start(async () => {
      const totals: ImportResult = {
        ok: true,
        created: 0,
        unchanged: 0,
        total: 0,
        skipped: [],
      };
      for (let i = 0; i < rows.length; i += BATCH) {
        const r = await importClientsAction(rows.slice(i, i + BATCH));
        if (!r.ok) {
          // Earlier batches are already in. Say what was, and from which row
          // it stopped, instead of only "Import failed".
          if (i > 0) {
            setResult(totals);
            toast(`Imported up to row ${i}. Rows ${i + 1} on weren't added - fix the file and import them again.`, "error");
          } else {
            toast(r.error ?? "Import failed.", "error");
          }
          return;
        }
        totals.created! += r.created ?? 0;
        totals.unchanged! += r.unchanged ?? 0;
        totals.total! += r.total ?? 0;
        // The server numbers rows within its batch; the owner reads the FILE.
        totals.skipped!.push(...(r.skipped ?? []).map((s) => ({ ...s, row: s.row + i })));
      }
      setResult(totals);
      toast(
        `Imported ${totals.created} new` +
          (totals.skipped!.length ? `, skipped ${totals.skipped!.length}` : ""),
        "success",
      );
    });
  }

  // Each kind of skip has its own next step, so they are shown apart.
  const skipped = result?.skipped ?? [];
  const matched = skipped.filter((s) => s.reason === "matches_existing");
  const sameName = skipped.filter((s) => s.reason === "same_name");
  const badPhone = skipped.filter((s) => s.reason === "invalid_phone");
  const failed = skipped.filter(
    (s) => s.reason !== "matches_existing" && s.reason !== "same_name" && s.reason !== "invalid_phone",
  );

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-display text-base">Import your client list</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Coming from Booksy, Fresha, Vagaro, or a spreadsheet? Export your
            clients to a CSV and drop it here. We match columns named First name,
            Last name, Phone, Email, and Notes (a single &ldquo;Name&rdquo; column
            works too). Your book is yours — bring it with you.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="block w-full text-sm text-muted file:mr-3 file:rounded-full file:border-0 file:bg-gold file:px-4 file:py-2 file:text-sm file:font-semibold file:text-charcoal hover:file:bg-gold-muted"
        />

        {rows.length > 0 && !result && (
          <>
            <p className="text-sm text-offwhite">
              <span className="font-semibold text-gold">{rows.length}</span> client
              {rows.length === 1 ? "" : "s"} ready to import from{" "}
              <span className="text-muted">{fileName}</span>.
            </p>

            <p className="rounded-xl border border-subtle bg-charcoal-700/50 p-3 text-xs leading-relaxed text-muted">
              Imported clients won&apos;t be texted until they opt in themselves —
              a contact list isn&apos;t proof that anyone agreed to texts. Clients
              you already have keep the consent they have.
            </p>

            <div className="flex items-center gap-3">
              <button
                onClick={doImport}
                disabled={pending}
                className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50"
              >
                {pending ? "Importing…" : `Import ${rows.length} client${rows.length === 1 ? "" : "s"}`}
              </button>
              <button
                onClick={() => {
                  setRows([]);
                  setFileName("");
                  if (inputRef.current) inputRef.current.value = "";
                }}
                className="text-sm text-muted hover:text-offwhite"
              >
                Clear
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="rounded-xl border border-subtle bg-charcoal-700/50 p-4 text-sm">
            <p className="text-offwhite">
              Done — <span className="font-semibold text-gold">{result.created}</span> added
              {(result.unchanged ?? 0) > 0 && (
                <>
                  , <span className="font-semibold">{result.unchanged}</span> already up to date
                </>
              )}
              {skipped.length > 0 && (
                <>
                  , <span className="text-danger-soft">{skipped.length}</span> skipped
                </>
              )}
              .
            </p>
            {matched.length > 0 && (
              <div className="mt-2">
                <p className="text-xs leading-relaxed text-muted">
                  {matched.length} skipped because {matched.length === 1 ? "it shares" : "they share"} a
                  phone or email with a client you already have, and we can&apos;t tell whether
                  it&apos;s the same person — families often share a phone. Your clients were not
                  changed, even where the file only had details they were missing.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  <span className="text-offwhite">Next step:</span> if it&apos;s the same person,
                  open that client and update their details there. If it&apos;s someone else, add
                  them with Add client using their own phone or email — not the shared one, which
                  already belongs to the client you have.
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  {matched.slice(0, REVIEW_SHOWN).map((r) => (
                    <li key={r.row} className="min-w-0 truncate text-offwhite">
                      Row {r.row} · {r.name}{" "}
                      <span className="text-muted">
                        — same {r.matchedBy} as {r.existingName || "an existing client"}
                      </span>
                    </li>
                  ))}
                </ul>
                {matched.length > REVIEW_SHOWN && (
                  <p className="mt-1 text-xs text-muted">and {matched.length - REVIEW_SHOWN} more.</p>
                )}
              </div>
            )}
            {sameName.length > 0 && (
              <div className="mt-2">
                <p className="text-xs leading-relaxed text-muted">
                  {sameName.length} skipped because {sameName.length === 1 ? "it has" : "they have"} only
                  a name, no phone or email, and you already have someone by that name. We can&apos;t
                  tell whether it&apos;s the same person, so we didn&apos;t add a second one.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  <span className="text-offwhite">Next step:</span> if it&apos;s a different person, add
                  them by hand with Add client.
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  {sameName.slice(0, REVIEW_SHOWN).map((r) => (
                    <li key={r.row} className="min-w-0 truncate text-offwhite">
                      Row {r.row} · <span className="text-muted">You already have someone named</span>{" "}
                      {r.name}
                    </li>
                  ))}
                </ul>
                {sameName.length > REVIEW_SHOWN && (
                  <p className="mt-1 text-xs text-muted">and {sameName.length - REVIEW_SHOWN} more.</p>
                )}
              </div>
            )}
            {badPhone.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                {badPhone.length} skipped for a phone number we couldn&apos;t read (
                {rowList(badPhone)}) — fix {badPhone.length === 1 ? "that row" : "those rows"} in
                your file and import it again.
              </p>
            )}
            {failed.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                {failed.length} couldn&apos;t be saved ({rowList(failed)}) — import the file
                again to retry {failed.length === 1 ? "it" : "them"}.
              </p>
            )}
            <button onClick={onDone} className="mt-3 text-sm text-gold hover:underline">
              Done
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
