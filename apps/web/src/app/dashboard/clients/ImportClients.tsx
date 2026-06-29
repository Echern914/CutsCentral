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
 * preview, then POST JSON rows. Consent is OFF unless the barber attests, and the
 * UI says so loudly (importing a contact list is not proof of SMS consent).
 *
 * The browser sends in batches of 500 so a big book doesn't hit the per-request
 * cap; results are summed across batches.
 */
const BATCH = 500;

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
      phone: get(iPhone) || undefined,
      email: get(iEmail) || undefined,
      notes: get(iNotes) || undefined,
    });
  }
  return { rows: out };
}

export function ImportClients({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<ImportClientRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [attest, setAttest] = useState(false);
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
      const totals: ImportResult = { ok: true, created: 0, updated: 0, total: 0, skipped: [] };
      for (let i = 0; i < rows.length; i += BATCH) {
        const r = await importClientsAction(rows.slice(i, i + BATCH), attest);
        if (!r.ok) {
          toast(r.error ?? "Import failed.", "error");
          return;
        }
        totals.created! += r.created ?? 0;
        totals.updated! += r.updated ?? 0;
        totals.total! += r.total ?? 0;
        totals.skipped!.push(...(r.skipped ?? []));
      }
      setResult(totals);
      toast(
        `Imported ${totals.created} new, updated ${totals.updated}` +
          (totals.skipped!.length ? `, skipped ${totals.skipped!.length}` : ""),
        "success",
      );
    });
  }

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

            <label className="flex items-start gap-2.5 rounded-xl border border-subtle bg-charcoal-700/50 p-3 text-xs leading-relaxed text-muted">
              <input
                type="checkbox"
                checked={attest}
                onChange={(e) => setAttest(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
              />
              <span>
                I confirm these clients agreed to receive text messages from my
                shop. <span className="text-offwhite">Leave this unchecked</span> if
                you&apos;re not sure — imported clients won&apos;t be texted until
                they opt in, and you can always collect consent later. (Texting
                people who didn&apos;t opt in violates the TCPA.)
              </span>
            </label>

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
              Done — <span className="font-semibold text-gold">{result.created}</span> added,{" "}
              <span className="font-semibold">{result.updated}</span> updated
              {result.skipped && result.skipped.length > 0 && (
                <>
                  , <span className="text-danger-soft">{result.skipped.length}</span> skipped
                </>
              )}
              .
            </p>
            {result.skipped && result.skipped.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                Skipped rows had an invalid phone number — fix them in your file and
                re-import (already-added clients won&apos;t duplicate).
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
