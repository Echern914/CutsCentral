"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  countVCards,
  looksLikeVCard,
  parseDelimited,
  parseVCards,
  rowsFromTable,
  type ImportRowDraft,
} from "@chairback/config/clientImportParse";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { importClientsAction, type ImportClientRow, type ImportResult } from "../actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/**
 * Client import - the "bring your book off Booksy/TheCut/Fresha/Vagaro" flow.
 * The file is read ENTIRELY in the browser (no upload): a CSV export, or a
 * phone's contacts file (.vcf), which is the only way out of TheCut - it has
 * no export, and its barbers keep their clients in their phone's contacts.
 * Parsing lives in `@chairback/config/clientImportParse`.
 *
 * Everything found is shown as a REVIEW LIST before anything is sent: phone
 * contacts include friends and family, so the barber unticks whoever isn't a
 * client, and only the ticked rows are imported. An import never makes anyone
 * textable, and the UI says so (a contact list is not proof that anyone agreed
 * to texts).
 *
 * The browser sends in batches of 500 so a big book doesn't hit the
 * per-request cap; results are summed across batches, and every skipped row is
 * numbered by where it sits in the FILE, not in the batch that was sent.
 */
const BATCH = 500;
/** How many matched rows to list by name; the count always shows. */
const REVIEW_SHOWN = 50;

type FileKind = "csv" | "contacts";

/** The fields the import route takes - the draft's file position stays here. */
function toImportRow(d: ImportRowDraft): ImportClientRow {
  return { firstName: d.firstName, lastName: d.lastName, phone: d.phone, email: d.email, notes: d.notes };
}

function fullName(d: { firstName: string; lastName?: string }): string {
  return [d.firstName, d.lastName].filter(Boolean).join(" ");
}

export function ImportClients({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<ImportRowDraft[]>([]);
  // Indexes into `drafts` that will be imported. Everyone starts ticked.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind>("csv");
  // Contact cards left out for having no name, or no phone or email.
  const [dropped, setDropped] = useState(0);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A CSV is read by rows; a contacts file by contact cards.
  const unit = kind === "contacts" ? "contact" : "row";
  const Unit = kind === "contacts" ? "Contact" : "Row";

  function load(next: ImportRowDraft[], nextKind: FileKind, nextDropped: number) {
    setDrafts(next);
    setSelected(new Set(next.map((_, i) => i)));
    setKind(nextKind);
    setDropped(nextDropped);
  }

  function clear() {
    load([], "csv", 0);
    setQuery("");
    setFileName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setQuery("");
    setFileName(file.name);
    if (/\.(xlsx|xls|numbers)$/i.test(file.name)) {
      toast("That's a spreadsheet, not a CSV. Open it, save or download it as CSV, then pick that file.", "error");
      load([], "csv", 0);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (/\.(vcf|vcard)$/i.test(file.name) || looksLikeVCard(text)) {
        const rows = parseVCards(text);
        const cards = countVCards(text);
        if (rows.length === 0) {
          toast(
            cards > 0
              ? "None of those contacts has a name and a phone number or email to import."
              : "No contacts found in that file.",
            "error",
          );
          load([], "contacts", 0);
          return;
        }
        load(rows, "contacts", Math.max(0, cards - rows.length));
        return;
      }
      const { rows, missingName } = rowsFromTable(parseDelimited(text));
      if (missingName) {
        toast("Couldn't find a name column. Add a header row with First name / Name.", "error");
        load([], "csv", 0);
        return;
      }
      if (rows.length === 0) {
        toast("No client rows found in that file.", "error");
        load([], "csv", 0);
        return;
      }
      load(rows, "csv", 0);
    };
    reader.onerror = () => toast("Couldn't read that file. Try picking it again.", "error");
    reader.readAsText(file);
  }

  // The rows the search shows. Filtering only hides rows: whoever is ticked
  // stays ticked while hidden, and Select all/none act on the shown rows only.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts.map((_, i) => i);
    const digits = q.replace(/\D/g, "");
    const out: number[] = [];
    drafts.forEach((d, i) => {
      const hit =
        fullName(d).toLowerCase().includes(q) ||
        (d.email ?? "").toLowerCase().includes(q) ||
        (d.phone ?? "").toLowerCase().includes(q) ||
        (digits !== "" && (d.phone ?? "").replace(/\D/g, "").includes(digits));
      if (hit) out.push(i);
    });
    return out;
  }, [drafts, query]);

  function toggle(i: number, on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(i);
      else next.delete(i);
      return next;
    });
  }

  function setShown(on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const i of visible) {
        if (on) next.add(i);
        else next.delete(i);
      }
      return next;
    });
  }

  function doImport() {
    // In file order, whatever order they were ticked in.
    const chosen = drafts.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    start(async () => {
      const totals: ImportResult = {
        ok: true,
        created: 0,
        unchanged: 0,
        total: 0,
        skipped: [],
      };
      for (let i = 0; i < chosen.length; i += BATCH) {
        const batch = chosen.slice(i, i + BATCH);
        const r = await importClientsAction(batch.map(toImportRow));
        if (!r.ok) {
          // Earlier batches are already in. Say what was, and from where in
          // the file it stopped, instead of only "Import failed".
          if (i > 0) {
            setResult(totals);
            toast(
              `Imported up to ${unit} ${chosen[i - 1]!.row}. The ticked ${unit}s from ${unit} ${batch[0]!.row} on weren't added - import the file again to add them.`,
              "error",
            );
          } else {
            toast(r.error ?? "Import failed.", "error");
          }
          return;
        }
        totals.created! += r.created ?? 0;
        totals.unchanged! += r.unchanged ?? 0;
        totals.total! += r.total ?? 0;
        // The server numbers rows within the batch it was sent; the owner
        // reads the FILE, and unticked rows were never sent at all.
        totals.skipped!.push(
          ...(r.skipped ?? []).map((s) => ({ ...s, row: batch[s.row - 1]?.row ?? s.row + i })),
        );
      }
      setResult(totals);
      toast(
        `Imported ${totals.created} new` +
          (totals.skipped!.length ? `, skipped ${totals.skipped!.length}` : ""),
        "success",
      );
    });
  }

  /** "rows 3, 7 and 12" - capped, so one bad column cannot print a thousand numbers. A contact reads by name. */
  function skipList(rows: { row: number }[]): string {
    const shown = rows.slice(0, 10);
    const more = rows.length - shown.length;
    const tail = more > 0 ? ` and ${more} more` : "";
    if (kind === "contacts") {
      const byRow = new Map(drafts.map((d) => [d.row, d]));
      return (
        shown.map((r) => (byRow.has(r.row) ? fullName(byRow.get(r.row)!) : `contact ${r.row}`)).join(", ") + tail
      );
    }
    return `row${rows.length === 1 ? "" : "s"} ${shown.map((r) => r.row).join(", ")}${tail}`;
  }

  // Each kind of skip has its own next step, so they are shown apart.
  const skipped = result?.skipped ?? [];
  const matched = skipped.filter((s) => s.reason === "matches_existing");
  const sameName = skipped.filter((s) => s.reason === "same_name");
  const badPhone = skipped.filter((s) => s.reason === "invalid_phone");
  const failed = skipped.filter(
    (s) => s.reason !== "matches_existing" && s.reason !== "same_name" && s.reason !== "invalid_phone",
  );
  const count = selected.size;

  return (
    <Card className="p-5">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-base">Import your client list</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Pick a CSV export (from Booksy, Fresha, Vagaro or a spreadsheet) or a
            contacts file (.vcf) from your phone. We match columns named First
            name, Last name, Phone, Email and Notes (a single &ldquo;Name&rdquo;
            column works too). You&apos;ll see everyone before anything is added.
            Your book is yours — bring it with you.
          </p>
          <Link href="/dashboard/clients/switch" className="mt-1 inline-block text-xs text-gold hover:underline">
            Switching from Booksy or TheCut? Here&apos;s how
          </Link>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".csv,.vcf,text/csv,text/vcard,text/x-vcard"
          onChange={onFile}
          aria-label="Choose a CSV or contacts file"
          className="block w-full min-w-0 text-sm text-muted file:mr-3 file:rounded-full file:border-0 file:bg-gold file:px-4 file:py-2 file:text-sm file:font-semibold file:text-charcoal hover:file:bg-gold-muted"
        />

        {drafts.length > 0 && !result && (
          <>
            <p className="min-w-0 break-words text-sm text-offwhite">
              Found <span className="font-semibold text-gold">{drafts.length}</span>{" "}
              {kind === "contacts"
                ? `contact${drafts.length === 1 ? "" : "s"}`
                : `client${drafts.length === 1 ? "" : "s"}`}{" "}
              in <span className="text-muted">{fileName}</span>.
            </p>

            {kind === "contacts" && (
              <p className="rounded-xl border border-gold/30 bg-gold/10 p-3 text-xs leading-relaxed text-offwhite">
                Your phone&apos;s contacts include friends and family. Untick anyone
                who isn&apos;t a client before you import.
              </p>
            )}
            {dropped > 0 && (
              <p className="text-xs leading-relaxed text-muted">
                {dropped} more contact{dropped === 1 ? " was" : "s were"} left out: no
                name, or no phone number or email to reach them by.
              </p>
            )}

            <div className="flex min-w-0 flex-col gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, phone or email"
                aria-label="Search the list"
                className={field}
              />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="text-xs text-muted" role="status">
                  <span className="font-semibold text-offwhite">{count}</span> selected of {drafts.length}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <button type="button" onClick={() => setShown(true)} className="text-xs text-gold hover:underline">
                    {query.trim() ? "Select all shown" : "Select all"}
                  </button>
                  <button type="button" onClick={() => setShown(false)} className="text-xs text-gold hover:underline">
                    {query.trim() ? "Select none shown" : "Select none"}
                  </button>
                </div>
              </div>
              <ul
                aria-label="People in the file"
                className="max-h-80 min-w-0 overflow-y-auto overscroll-contain rounded-xl border border-subtle"
              >
                {visible.map((i) => {
                  const d = drafts[i]!;
                  const name = fullName(d);
                  const contact = [d.phone, d.email].filter(Boolean).join(" · ");
                  return (
                    <li key={i} className="border-b border-subtle/60 last:border-b-0">
                      <label className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={(e) => toggle(i, e.target.checked)}
                          aria-label={name}
                          className="h-4 w-4 shrink-0 accent-gold"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-offwhite">{name}</span>
                          <span className="block truncate text-xs text-muted">
                            {contact || "No phone or email"}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
                {visible.length === 0 && (
                  <li className="break-words px-3 py-4 text-center text-xs text-muted">
                    No one matches &ldquo;{query.trim()}&rdquo;.
                  </li>
                )}
              </ul>
            </div>

            <p className="rounded-xl border border-subtle bg-charcoal-700/50 p-3 text-xs leading-relaxed text-muted">
              Imported clients won&apos;t be texted until they opt in themselves —
              a contact list isn&apos;t proof that anyone agreed to texts. Clients
              you already have keep the consent they have.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={doImport}
                disabled={pending || count === 0}
                className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50"
              >
                {pending ? "Importing…" : `Import ${count} client${count === 1 ? "" : "s"}`}
              </button>
              <button onClick={clear} className="text-sm text-muted hover:text-offwhite">
                Clear
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="min-w-0 rounded-xl border border-subtle bg-charcoal-700/50 p-4 text-sm">
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
                      {Unit} {r.row} · {r.name}{" "}
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
                      {Unit} {r.row} · <span className="text-muted">You already have someone named</span>{" "}
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
              <p className="mt-2 break-words text-xs text-muted">
                {badPhone.length} skipped for a phone number we couldn&apos;t read (
                {skipList(badPhone)}) —{" "}
                {kind === "contacts"
                  ? "fix the number in your phone's contacts, then export and import the file again."
                  : `fix ${badPhone.length === 1 ? "that row" : "those rows"} in your file and import it again.`}
              </p>
            )}
            {failed.length > 0 && (
              <p className="mt-2 break-words text-xs text-muted">
                {failed.length} couldn&apos;t be saved ({skipList(failed)}) — import the file
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
