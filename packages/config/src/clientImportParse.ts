/**
 * SWITCHING FROM BOOKSY OR THECUT - reading what a shop brings with it.
 *
 * Three readers, all pure and safe in the browser (no node built-ins), because
 * the files never leave the barber's device: the web parses them, shows a
 * review list, and posts only the rows the barber ticked.
 *
 *  - `parseDelimited` + `rowsFromTable`: a client list exported as CSV. Booksy
 *    Biz exports one (Customers -> Export to CSV), but its column headers are
 *    not documented anywhere public, and a European export is often
 *    semicolon-separated. So the delimiter is sniffed from the header line and
 *    the headers are matched through a generous alias list.
 *  - `parseVCards`: a phone's contacts file (.vcf). TheCut has NO export; a
 *    barber on TheCut keeps their clients in their phone's contacts (TheCut
 *    imports from them), so exporting those contacts is the only way out.
 *    Phone contacts include friends and family, which is why the web shows
 *    every card for review before anything is imported.
 *  - `parseWeeklyHours`: a week of hours copied from an old profile (Booksy,
 *    TheCut, Google) and pasted into the hours editor. It fills the editor;
 *    it never saves anything by itself.
 *
 * 🔴 NONE OF THIS GRANTS CONSENT. A row read here is a name and a contact,
 * never proof that anyone agreed to texts or marketing email - the import
 * route starts every new client with no consent, whatever the file says.
 */

/** One client read from a file, before the barber reviews it. */
export interface ImportRowDraft {
  /**
   * Where it sits in the file, counting from 1: the data row (the header row
   * not counted) for a CSV, the contact card for a contacts file. Skipped-row
   * messages use it, so they point at the file even when some rows were
   * unticked and never sent.
   */
  row: number;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

/**
 * The import route's per-field caps. One long cell used to fail a whole
 * 500-row batch with no row number, so every field leaves within its cap; a
 * "phone" over 40 characters is never one phone number, and the route then
 * reports it as that row's skip.
 */
export const IMPORT_FIELD_LIMITS = {
  firstName: 80,
  lastName: 80,
  phone: 40,
  email: 160,
  notes: 2000,
} as const;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function draft(
  row: number,
  fields: { firstName: string; lastName?: string; phone?: string; email?: string; notes?: string },
): ImportRowDraft {
  const L = IMPORT_FIELD_LIMITS;
  const lastName = fields.lastName?.trim().slice(0, L.lastName);
  const phone = fields.phone?.trim().slice(0, L.phone);
  const email = fields.email?.trim().slice(0, L.email);
  const notes = fields.notes?.trim().slice(0, L.notes);
  return {
    row,
    firstName: fields.firstName.trim().slice(0, L.firstName),
    lastName: lastName || undefined,
    phone: phone || undefined,
    email: email || undefined,
    notes: notes || undefined,
  };
}

/* ============================== CSV ===================================== */

const DELIMITERS = [",", ";", "\t"] as const;

/**
 * The delimiter the header row uses.
 *
 * The header is found first: the first of the opening lines that, split on
 * comma, semicolon or tab, has a name column - an export can open with a
 * title line ("Customers, exported 10/15") above it. Counting delimiters over
 * the data instead would be fooled by an unquoted note full of semicolons in
 * a comma file. With no recognisable header, whichever delimiter appears most
 * on the first line wins (a tie is a comma).
 */
function sniffDelimiter(src: string): string {
  const lines = src.slice(0, 16384).split(/\r\n|\r|\n/).slice(0, HEADER_SEARCH_ROWS);
  for (const line of lines) {
    for (const d of DELIMITERS) {
      const cells = splitOutsideQuotes(line, d);
      if (cells.length > 1 && (findCol(cells, FIRST_ALIASES) !== -1 || findCol(cells, NAME_ALIASES) !== -1)) {
        return d;
      }
    }
  }
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of lines[0] ?? "") {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  let best = ",";
  for (const d of DELIMITERS) if ((counts[d] ?? 0) > (counts[best] ?? 0)) best = d;
  return best;
}

/**
 * A delimited text file as rows of cells.
 *
 * Strips a UTF-8 byte-order mark (Excel writes one), sniffs comma, semicolon
 * or tab from the header row (or obeys Excel's `sep=;` hint line), reads
 * quoted fields with `""` escapes and line breaks inside them, accepts CRLF, CR
 * or LF, and drops rows with nothing in them. A quote only opens a quoted
 * field at the start of a cell, so `Marcus "Moe" Reed` stays one name.
 */
export function parseDelimited(text: string): string[][] {
  let src = stripBom(text ?? "");
  const firstBreak = src.search(/\r|\n/);
  const firstLine = firstBreak === -1 ? src : src.slice(0, firstBreak);
  let delim: string;
  const hint = /^sep=(.)\s*$/i.exec(firstLine);
  if (hint) {
    delim = hint[1]!;
    src = firstBreak === -1 ? "" : src.slice(firstBreak).replace(/^(\r\n|\r|\n)/, "");
  } else {
    delim = sniffDelimiter(src);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === "") {
      cell = "";
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
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

/**
 * Header aliases, compared lowercased with everything but a-z removed - so
 * "E-mail", "Email address", "Phone Number" and "Customer name" all land.
 * Earlier aliases win when a file has more than one matching column. The
 * first entries of each list are the ones the importer has always matched;
 * the rest are the names a Booksy, Fresha or Vagaro export is likely to use.
 */
const FIRST_ALIASES = ["firstname", "first", "fname", "givenname", "customerfirstname", "clientfirstname", "forename"];
const LAST_ALIASES = ["lastname", "last", "lname", "surname", "familyname", "customerlastname", "clientlastname"];
const NAME_ALIASES = [
  "name", "fullname", "client", "customer", "customername",
  "clientname", "customerfullname", "clientfullname", "contactname", "displayname",
];
const PHONE_ALIASES = [
  "phone", "mobile", "cell", "phonenumber", "tel", "telephone",
  "mobilephone", "mobilenumber", "mobilephonenumber", "cellphone", "cellnumber", "cellphonenumber",
  "phonemobile", "telephonenumber", "customerphone", "clientphone", "customerphonenumber",
  "clientphonenumber", "customermobile", "clientmobile", "primaryphone", "phones",
];
const EMAIL_ALIASES = [
  "email", "emailaddress", "mail",
  "customeremail", "clientemail", "customeremailaddress", "clientemailaddress", "emails", "emailaddresses",
];
const NOTES_ALIASES = [
  "notes", "note", "comment", "comments",
  "customernotes", "clientnotes", "customernote", "clientnote", "remarks",
];

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z]/g, "");

/** How far down a file the header row may start (after a title line or two). */
const HEADER_SEARCH_ROWS = 5;

/** Index of the first column whose header matches an alias, by alias order; -1 if none. */
function findCol(header: string[], aliases: string[]): number {
  const norm = header.map(normHeader);
  for (const a of aliases) {
    const idx = norm.indexOf(a);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Client rows from a parsed table with a header row.
 *
 * The header is the first row with a name column (First name, or one Name
 * column), looked for in the first few rows because an export can open with
 * a title line ("Customers - exported 10/15") before it. `missingName` is true
 * when there is none - nothing can be imported then, and the barber needs to
 * know why rather than see "no rows". A single Name column is split into
 * first name + the rest. A row with no name is left out: the import needs one.
 */
export function rowsFromTable(table: string[][]): { rows: ImportRowDraft[]; missingName: boolean } {
  if (table.length < 1) return { rows: [], missingName: false };
  let headerAt = -1;
  for (let h = 0; h < Math.min(HEADER_SEARCH_ROWS, table.length); h++) {
    if (findCol(table[h]!, FIRST_ALIASES) !== -1 || findCol(table[h]!, NAME_ALIASES) !== -1) {
      headerAt = h;
      break;
    }
  }
  if (headerAt === -1) return { rows: [], missingName: true };
  const header = table[headerAt]!;
  const iFirst = findCol(header, FIRST_ALIASES);
  const iLast = findCol(header, LAST_ALIASES);
  const iName = findCol(header, NAME_ALIASES);
  const iPhone = findCol(header, PHONE_ALIASES);
  const iEmail = findCol(header, EMAIL_ALIASES);
  const iNotes = findCol(header, NOTES_ALIASES);

  const rows: ImportRowDraft[] = [];
  for (let r = headerAt + 1; r < table.length; r++) {
    const cells = table[r]!;
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i]!.trim() : "");
    let firstName = get(iFirst);
    let lastName = get(iLast);
    if (!firstName && iName !== -1) {
      const parts = get(iName).split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }
    if (!firstName) continue;
    rows.push(
      draft(r - headerAt, { firstName, lastName, phone: get(iPhone), email: get(iEmail), notes: get(iNotes) }),
    );
  }
  return { rows, missingName: false };
}

/* ============================ vCard ===================================== */

/** Does this text look like a contacts file rather than a CSV? */
export function looksLikeVCard(text: string): boolean {
  return /^\s*BEGIN:VCARD\s*$/im.test(stripBom(text ?? "").slice(0, 4096));
}

/** How many contact cards the file holds, kept or not. */
export function countVCards(text: string): number {
  return (stripBom(text ?? "").match(/^[ \t]*BEGIN:VCARD[ \t]*$/gim) ?? []).length;
}

/** Properties that carry a picture or a key: never needed, and they can be megabytes. */
const BLOB_PROPS = new Set(["PHOTO", "LOGO", "SOUND", "KEY"]);
/** The start of a property line: `NAME;` or `NAME:`, with an optional `item1.` group. */
const PROP_START = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?[;:]/;

interface CardAcc {
  index: number;
  n: string[] | null;
  fn: string;
  tels: { value: string; types: string[] }[];
  emails: { value: string; types: string[] }[];
  notes: string[];
}

/** Index of the first `:` outside double quotes (a quoted parameter can hold one). */
function valueColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) return i;
  }
  return -1;
}

/** Split on `sep` outside double quotes. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === sep && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Split a structured value (N) on `;` that is not escaped as `\;`. */
function splitStructured(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** vCard text escapes: `\,` `\;` `\\` and `\n` (a line break inside a note). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\,;nN:])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    // An unknown charset label: UTF-8 is what every phone writes today.
  }
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  }
}

/**
 * Quoted-printable (vCard 2.1, what Android writes for any name with an accent
 * or emoji): each run of `=XX` bytes is decoded together, so a multi-byte
 * UTF-8 character survives. Soft line breaks were already joined while
 * unfolding; a stray trailing `=` is dropped.
 */
function decodeQuotedPrintable(value: string, charset: string): string {
  return value
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => {
      const bytes = new Uint8Array(run.length / 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
      return decodeBytes(bytes, charset);
    })
    .replace(/=$/, "");
}

function pickTel(tels: CardAcc["tels"]): string | undefined {
  const usable = tels.filter((t) => t.value);
  const notFax = usable.filter((t) => !t.types.some((x) => x.includes("fax") || x === "pager"));
  const pool = notFax.length > 0 ? notFax : usable;
  const isCell = (t: { types: string[] }) => t.types.some((x) => /cell|mobile|iphone/.test(x));
  const isPref = (t: { types: string[] }) => t.types.includes("pref");
  return (pool.find((t) => isCell(t) && isPref(t)) ?? pool.find(isCell) ?? pool.find(isPref) ?? pool[0])
    ?.value;
}

function pickEmail(emails: CardAcc["emails"]): string | undefined {
  const usable = emails.filter((e) => e.value);
  return (usable.find((e) => e.types.includes("pref")) ?? usable[0])?.value;
}

/**
 * The client a card describes, or null when it is not one we can use.
 *
 * 🔑 KEPT ONLY WITH A NAME AND A WAY TO REACH THEM (a phone or an email). A
 * card with neither is noise; a name-only card is a birthday or a note, not
 * someone a client book can ever contact; and a number with no name gives the
 * import nothing to call them (it needs a first name). The web says how many
 * cards were left out.
 */
function finishCard(card: CardAcc): ImportRowDraft | null {
  let first = "";
  let last = "";
  if (card.n) {
    const [family = "", given = "", , , suffix = ""] = card.n.map((s) => unescapeText(s).trim());
    first = given;
    last = [family, suffix].filter(Boolean).join(" ");
  }
  if (!first) {
    const fn = unescapeText(card.fn).trim();
    if (fn) {
      const parts = fn.split(/\s+/);
      first = parts[0] ?? "";
      last = parts.slice(1).join(" ");
    }
  }
  if (!first && last) {
    first = last;
    last = "";
  }
  const phone = pickTel(card.tels);
  const email = pickEmail(card.emails);
  if (!first || (!phone && !email)) return null;
  const notes = card.notes.join("\n");
  return draft(card.index, { firstName: first, lastName: last, phone, email, notes });
}

/**
 * The clients in a contacts file - vCard 2.1, 3.0 or 4.0, as an iPhone or an
 * Android phone exports them.
 *
 * Unfolds folded lines (a line break followed by a space or tab), joins 2.1's
 * quoted-printable soft line breaks and decodes the bytes in their CHARSET
 * (UTF-8 by default), takes the name from `N` (Family;Given;...) and falls
 * back to splitting `FN`, picks a mobile or preferred `TEL` over the first
 * one, the preferred or first `EMAIL`, and every `NOTE`. Group prefixes
 * (`item1.TEL`) work. Photos and other base64 blobs are skipped line by line
 * without being joined, so a file full of contact photos stays cheap.
 *
 * Cards without a name and a phone or email are left out - see `finishCard`.
 */
export function parseVCards(text: string): ImportRowDraft[] {
  const out: ImportRowDraft[] = [];
  const lines = stripBom(text ?? "").split(/\r\n|\r|\n/);
  // The card being read, and how many have begun (a card's number in the file).
  const state: { card: CardAcc | null; cards: number } = { card: null, cards: 0 };
  // The physical lines of the property being read, joined when it ends.
  let current: string[] | null = null;
  let currentQp = false;
  // Inside a PHOTO (or other blob) and its continuation lines.
  let skipping = false;

  const closeCard = () => {
    if (state.card) {
      const kept = finishCard(state.card);
      if (kept) out.push(kept);
    }
    state.card = null;
  };

  const handle = (logical: string) => {
    const colon = valueColon(logical);
    if (colon === -1) return;
    const head = splitOutsideQuotes(logical.slice(0, colon), ";");
    const rawValue = logical.slice(colon + 1);
    const nameWithGroup = head[0] ?? "";
    const name = nameWithGroup.slice(nameWithGroup.lastIndexOf(".") + 1).trim().toUpperCase();

    if (name === "BEGIN" && rawValue.trim().toUpperCase() === "VCARD") {
      closeCard();
      state.cards++;
      state.card = { index: state.cards, n: null, fn: "", tels: [], emails: [], notes: [] };
      return;
    }
    if (name === "END" && rawValue.trim().toUpperCase() === "VCARD") {
      closeCard();
      return;
    }
    const card = state.card;
    if (!card) return;
    if (name !== "N" && name !== "FN" && name !== "TEL" && name !== "EMAIL" && name !== "NOTE") return;

    let encoding = "";
    let charset = "";
    const types: string[] = [];
    for (const param of head.slice(1)) {
      const eq = param.indexOf("=");
      if (eq === -1) {
        // vCard 2.1 writes bare parameters: TEL;CELL;PREF or NOTE;QUOTED-PRINTABLE.
        const bare = param.trim().toLowerCase();
        if (bare === "quoted-printable" || bare === "base64" || bare === "b") encoding = bare;
        else if (bare) types.push(bare);
        continue;
      }
      const key = param.slice(0, eq).trim().toUpperCase();
      const values = param
        .slice(eq + 1)
        .split(",")
        .map((v) => v.replace(/"/g, "").trim().toLowerCase())
        .filter(Boolean);
      if (key === "ENCODING") encoding = values[0] ?? "";
      else if (key === "CHARSET") charset = values[0] ?? "";
      else if (key === "TYPE") types.push(...values);
      else if (key === "PREF") types.push("pref");
    }
    const value = encoding === "quoted-printable" ? decodeQuotedPrintable(rawValue, charset) : rawValue;

    if (name === "N") card.n = splitStructured(value);
    else if (name === "FN") card.fn = value;
    else if (name === "TEL") {
      card.tels.push({ value: unescapeText(value).replace(/^tel:/i, "").trim(), types });
    } else if (name === "EMAIL") {
      card.emails.push({ value: unescapeText(value).replace(/^mailto:/i, "").trim(), types });
    } else if (name === "NOTE") {
      const note = unescapeText(value).trim();
      if (note) card.notes.push(note);
    }
  };

  const flush = () => {
    if (current) {
      handle(current.join(""));
      current = null;
    }
  };

  for (const line of lines) {
    // A quoted-printable value that ends in "=" continues on the next line.
    if (current && currentQp && current[current.length - 1]!.endsWith("=")) {
      current[current.length - 1] = current[current.length - 1]!.slice(0, -1);
      current.push(line);
      continue;
    }
    const lead = line.charAt(0);
    if (lead === " " || lead === "\t") {
      // A folded continuation. Blob data is dropped without being joined.
      if (!skipping && current) current.push(line.slice(1));
      continue;
    }
    if (skipping) {
      // vCard 2.1 base64 runs unfolded until a blank line; base64 never
      // contains ";" or ":", so the next property line ends it.
      if (!PROP_START.test(line)) continue;
      skipping = false;
    }
    flush();
    if (line.trim() === "") continue;
    const colon = valueColon(line);
    const head = colon === -1 ? line : line.slice(0, colon);
    const rawName = head.split(";")[0] ?? "";
    const name = rawName.slice(rawName.lastIndexOf(".") + 1).trim().toUpperCase();
    if (BLOB_PROPS.has(name) || /(^|;)\s*ENCODING=(B|BASE64)\s*(;|$)/i.test(head) || /;\s*BASE64\s*(;|$)/i.test(head)) {
      skipping = true;
      continue;
    }
    current = [line];
    currentQp = /QUOTED-PRINTABLE/i.test(head);
  }
  flush();
  // A file cut off before its last END:VCARD still yields that card.
  closeCard();
  return out;
}

/* ========================= Weekly hours ================================= */

/** One open stretch of a day, in minutes after midnight (end may be 1440). */
export interface HoursWindow {
  startMin: number;
  endMin: number;
}

export interface ParsedWeek {
  /** Weekday (0 = Sunday ... 6 = Saturday) -> its open windows, or closed. Days not mentioned are absent. */
  days: Map<number, HoursWindow[] | "closed">;
  /** Lines that could not be read, as pasted, for the barber to set by hand. */
  unread: string[];
}

const DAY_WORDS: [string, number][] = [
  ["sunday", 0], ["monday", 1], ["tuesday", 2], ["wednesday", 3], ["thursday", 4], ["friday", 5], ["saturday", 6],
  ["thurs", 4], ["tues", 2], ["weds", 3],
  ["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["thur", 4], ["fri", 5], ["sat", 6],
  ["su", 0], ["mo", 1], ["tu", 2], ["we", 3], ["th", 4], ["fr", 5], ["sa", 6],
];
// Longest first, so "thurs" is tried before "thu" and "th".
DAY_WORDS.sort((a, b) => b[0].length - a[0].length);

const GROUP_WORDS: [string, number[]][] = [
  ["every day", [0, 1, 2, 3, 4, 5, 6]],
  ["everyday", [0, 1, 2, 3, 4, 5, 6]],
  ["daily", [0, 1, 2, 3, 4, 5, 6]],
  ["weekdays", [1, 2, 3, 4, 5]],
  ["weekday", [1, 2, 3, 4, 5]],
  ["weekends", [0, 6]],
  ["weekend", [0, 6]],
];

const isLetter = (ch: string | undefined) => ch !== undefined && ch >= "a" && ch <= "z";

function matchDay(s: string, at: number): { day: number; end: number } | null {
  for (const [word, day] of DAY_WORDS) {
    if (!s.startsWith(word, at)) continue;
    let end = at + word.length;
    if (word.length > 3 && s[end] === "s" && !isLetter(s[end + 1])) end++; // Mondays
    if (s[end] === ".") end++; // Mon.
    // A whole word only: "mo" is not the start of "morning", and "we" in
    // "we're" is not Wednesday.
    if (isLetter(s[end]) || (word.length === 2 && s[end] === "'")) continue;
    return { day, end };
  }
  return null;
}

function matchGroup(s: string, at: number): { days: number[]; end: number } | null {
  for (const [word, days] of GROUP_WORDS) {
    if (s.startsWith(word, at) && !isLetter(s[at + word.length])) return { days, end: at + word.length };
  }
  return null;
}

/** "mon-fri", "sat & sun", "weekdays", "tue, thu" at the start of a line; null when there is no day. */
function readDaySpec(s: string): { days: number[]; rest: string } | null {
  const days = new Set<number>();
  let p = 0;
  let any = false;
  for (;;) {
    while (s[p] === " ") p++;
    const group = matchGroup(s, p);
    if (group) {
      for (const d of group.days) days.add(d);
      p = group.end;
      any = true;
    } else {
      const d1 = matchDay(s, p);
      if (!d1) break;
      any = true;
      p = d1.end;
      const conn = /^\s*(-|to|through|thru|till|until)\s*/.exec(s.slice(p));
      const d2 = conn ? matchDay(s, p + conn[0].length) : null;
      if (d2) {
        // A range wraps the week: Fri-Mon is Fri, Sat, Sun, Mon.
        for (let d = d1.day; ; d = (d + 1) % 7) {
          days.add(d);
          if (d === d2.day) break;
        }
        p = d2.end;
      } else days.add(d1.day);
    }
    const sep = /^\s*(,|&|and|\/|\+)\s*/.exec(s.slice(p));
    if (sep) {
      const after = p + sep[0].length;
      if (matchDay(s, after) || matchGroup(s, after)) {
        p = after;
        continue;
      }
    }
    break;
  }
  return any ? { days: [...days], rest: s.slice(p) } : null;
}

interface ClockTime {
  h: number;
  m: number;
  mer: "am" | "pm" | null;
  word: "noon" | "midnight" | null;
  /** Written the 24-hour way: 13:00, 0900, 09:00, 00:30. */
  looks24: boolean;
}

const TIME = String.raw`(noon|midday|midnight|\d{1,4}(?:[:.]\d{2})?(?:\s*(?:am|pm|a|p)(?![a-z]))?)`;
const RANGE_RE = new RegExp(`${TIME}\\s*(?:-|to|until|till|through|thru)\\s*${TIME}`, "g");

function readClock(token: string): ClockTime | null {
  const t = token.trim();
  if (t === "noon" || t === "midday") return { h: 12, m: 0, mer: "pm", word: "noon", looks24: false };
  if (t === "midnight") return { h: 0, m: 0, mer: "am", word: "midnight", looks24: false };
  const m = /^(\d{1,4})(?:[:.](\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  const digits = m[1]!;
  let h: number;
  let min: number;
  if (m[2] !== undefined) {
    if (digits.length > 2) return null;
    h = Number(digits);
    min = Number(m[2]);
  } else if (digits.length >= 3) {
    h = Math.floor(Number(digits) / 100);
    min = Number(digits) % 100;
  } else {
    h = Number(digits);
    min = 0;
  }
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  const mer = m[3] ? (m[3].startsWith("a") ? "am" : "pm") : null;
  if (mer && (h === 0 || h > 12)) return null;
  const looks24 = h > 12 || h === 0 || (digits.length >= 2 && digits.startsWith("0"));
  return { h, m: min, mer, word: null, looks24 };
}

/** Minutes after midnight when the clock time says so by itself; null for a bare 1-12 hour. */
function definite(t: ClockTime, asEnd: boolean, line24: boolean): number | null {
  if (t.word === "noon") return 720;
  if (t.word === "midnight") return asEnd ? 1440 : 0;
  if (t.mer) {
    const v = ((t.h % 12) + (t.mer === "pm" ? 12 : 0)) * 60 + t.m;
    return asEnd && v === 0 ? 1440 : v;
  }
  if (line24 || t.looks24) {
    const v = t.h * 60 + t.m;
    return asEnd && v === 0 ? 1440 : v;
  }
  return null;
}

/** A bare hour's two readings (and midnight, for an end at 12). */
function readings(t: ClockTime, asEnd: boolean): number[] {
  const am = (t.h % 12) * 60 + t.m;
  return asEnd && am === 0 ? [am, am + 720, 1440] : [am, am + 720];
}

/**
 * The open windows in the times part of a line ("9am-6pm", "9-12, 1-6").
 *
 * 🔑 THE BARE-HOUR RULE. "9-5" has no am/pm, so: a bare hour is read as the
 * first time at or after 6 AM (9 is 9 AM, 12 is noon, 5 is 5 PM), and every
 * later time on the line as the first one after the time before it. So
 * "9-12, 1-6" is 9 AM-noon and 1-6 PM, and "12-8" is noon-8 PM. When the
 * other end of a range says am/pm, the bare end is read to fit it: "9-5pm" is
 * 9 AM-5 PM, "1-5pm" is 1-5 PM. A line written the 24-hour way anywhere
 * (13:00, 09:00, 0900) is read as 24-hour throughout. The barber sees every
 * filled-in time before saving, which is what makes a guess acceptable here.
 */
function readTimes(rest: string): HoursWindow[] | "closed" | "empty" | null {
  const s = rest.replace(/^[\s:=|,\-]+/, "").replace(/\s+$/, "");
  if (s === "" || s === "-") return "empty";
  const hasDigit = /\d/.test(s);
  if (!hasDigit && /\b(closed|off|day off|not open|not working|unavailable)\b/.test(s)) return "closed";
  if (/\b(open 24 hours|24 hours|24 hrs|24\/7|all day)\b/.test(s)) return [{ startMin: 0, endMin: 1440 }];

  const pairs: [ClockTime, ClockTime][] = [];
  let leftover = s;
  for (const m of s.matchAll(RANGE_RE)) {
    const a = readClock(m[1]!);
    const b = readClock(m[2]!);
    if (!a || !b) return null;
    pairs.push([a, b]);
    leftover = leftover.replace(m[0], " ");
  }
  if (pairs.length === 0) return null;
  // Anything still holding a digit was a time we could not pair up.
  if (/\d/.test(leftover)) return null;

  const line24 = pairs.some(([a, b]) => (!a.mer && !a.word && a.looks24) || (!b.mer && !b.word && b.looks24));
  const windows: HoursWindow[] = [];
  let floor = 6 * 60;
  for (const [a, b] of pairs) {
    let start = definite(a, false, line24);
    let end = definite(b, true, line24);
    if (start === null && end === null) {
      start = readings(a, false).find((v) => v >= floor) ?? null;
      end = start === null ? null : (readings(b, true).find((v) => v > start!) ?? null);
    } else if (start === null) {
      const below = readings(a, false).filter((v) => v < end!);
      start = below.length > 0 ? below[below.length - 1]! : null;
    } else if (end === null) {
      end = readings(b, true).find((v) => v > start!) ?? null;
    }
    if (start === null || end === null || start >= end || start < 0 || end > 1440) return null;
    windows.push({ startMin: start, endMin: end });
    floor = end;
  }
  return mergeWindows(windows);
}

function mergeWindows(windows: HoursWindow[]): HoursWindow[] {
  const sorted = [...windows].sort((x, y) => x.startMin - y.startMin);
  const out: HoursWindow[] = [];
  for (const w of sorted) {
    const prev = out[out.length - 1];
    if (prev && w.startMin <= prev.endMin) prev.endMin = Math.max(prev.endMin, w.endMin);
    else out.push({ ...w });
  }
  return out;
}

function normalizeHoursLine(line: string): string {
  return line
    .replace(/\u200B/g, "") // zero-width space
    .replace(/\([^)]*\)/g, " ") // "(Labor Day)", "(last booking 5:30)"
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D~]/g, "-") // en/em dashes, minus
    .toLowerCase()
    .replace(/(^|[^a-z])([ap])\.\s?m\.?/g, "$1$2m") // a.m. -> am
    .replace(/\s+/g, " ") // tabs, and Google's narrow no-break space before AM
    .trim();
}

/** Split "mon-fri 9-5, sat 10-4" into one piece per day spec. */
function splitSegments(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== "," && ch !== ";" && ch !== "|") continue;
    const piece = line.slice(start, i);
    // Only split once this piece has its times: "mon, wed, fri 9-5" is one spec.
    if (!/\d|closed|off|noon|midnight/.test(piece)) continue;
    let j = i + 1;
    while (line[j] === " ") j++;
    if (matchDay(line, j) || matchGroup(line, j)) {
      out.push(piece);
      start = j;
    }
  }
  out.push(line.slice(start));
  return out;
}

const HEADING = /^((business|opening|open|working|store|shop|regular)\s+)?hours( of operation)?:?$/;

/**
 * A week of hours pasted from another app's profile: "Monday 9:00 AM - 6:00 PM",
 * "Mon: 9am–6pm", "Tuesday 10:00 – 19:00", "Sunday Closed", "Mon-Fri 9-5",
 * "Weekends 10am to 4pm", "Mon 9-12, 1-6" (a split shift), or Google's copy
 * where the day and its hours sit on two lines. See `readTimes` for how a bare
 * "9-5" is read. Lines it cannot read are returned in `unread`, word for word.
 * Never throws: a paste is untrusted text.
 */
export function parseWeeklyHours(text: string): ParsedWeek {
  const days = new Map<number, HoursWindow[] | "closed">();
  const unread: string[] = [];
  const set = (ds: number[], value: HoursWindow[] | "closed") => {
    for (const d of ds) {
      const had = days.get(d);
      days.set(d, value !== "closed" && Array.isArray(had) ? mergeWindows([...had, ...value]) : value);
    }
  };
  // A day on a line of its own waits for the hours on the next line.
  let pending: { days: number[]; line: string } | null = null;

  let lines: string[] = [];
  try {
    lines = String(text ?? "").split(/\r\n|\r|\n/);
  } catch {
    return { days, unread };
  }
  for (const raw of lines) {
    try {
      const original = raw.trim();
      const line = normalizeHoursLine(raw);
      if (!line || HEADING.test(line) || !/[a-z0-9]/.test(line)) continue;
      for (const segment of splitSegments(line)) {
        const spec = readDaySpec(segment);
        if (!spec) {
          const times = readTimes(segment);
          if (pending && times !== null && times !== "empty") {
            set(pending.days, times);
            pending = null;
          } else unread.push(original);
          continue;
        }
        if (pending) {
          unread.push(pending.line);
          pending = null;
        }
        const times = readTimes(spec.rest);
        if (times === "empty") pending = { days: spec.days, line: original };
        else if (times === null) unread.push(original);
        else set(spec.days, times);
      }
    } catch {
      unread.push(raw.trim());
    }
  }
  if (pending) unread.push(pending.line);
  return { days, unread: [...new Set(unread)] };
}
