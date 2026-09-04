/**
 * A very small PDF writer: enough to lay out one branded page of text, rules,
 * filled boxes and a bar chart. No dependency, on purpose.
 *
 * 🔴 WHY HAND-ROLLED RATHER THAN A LIBRARY OR A HEADLESS BROWSER.
 *
 * The yearly report is a document a barber hands to an accountant, a landlord
 * or an awards panel, and the brief on it is absolute: one page, no client PII
 * anywhere in the file OR its metadata, nothing uploaded to a third party. A
 * headless browser would add a ~300MB dependency to a Railway container that
 * boots in seconds today, and a PDF library would put bytes in the file that
 * this repo neither wrote nor tests. Here every byte is ours, the layout is
 * fixed by construction so "one page" is not a hope, and `yearlyReportPdf` can
 * be asserted against in the ordinary API suite with no browser at all.
 *
 * Only the base-14 fonts are used (Helvetica and Helvetica-Bold), which every
 * PDF reader has built in - so nothing is embedded and the file stays ~10KB.
 * Text is WinAnsi-encoded, which covers Latin-1: a barber named Núñez prints
 * correctly, and anything outside that range degrades to a visible '?' rather
 * than corrupting the stream.
 */

/** PostScript points. 1pt = 1/72". */
export const PAGE_SIZES = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 },
} as const;

export type PaperSize = keyof typeof PAGE_SIZES;

/**
 * The box the whole report is drawn in, centred on whichever page.
 *
 * US Letter is WIDER but SHORTER than A4; A4 is NARROWER but TALLER. So the
 * area that exists on both is A4's width by Letter's height. Laying the
 * document out once inside that intersection - rather than reflowing per paper
 * size - is what makes "fits one Letter page" and "prints on A4 without
 * clipping" the same statement instead of two separate hopes.
 */
export const SAFE_BOX = {
  width: PAGE_SIZES.a4.width,
  height: PAGE_SIZES.letter.height,
} as const;

export type FontName = "F1" | "F2";
export const REGULAR: FontName = "F1";
export const BOLD: FontName = "F2";

// Adobe's published widths for the base-14 Helvetica faces, in 1/1000 em, for
// the printable ASCII range (32..126). Used for measuring, which is what makes
// truncation and centring exact instead of guessed.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Latin-1 accented letters vary little; one representative width is honest enough. */
const W_HIGH_REGULAR = 556;
const W_HIGH_BOLD = 611;

/** Width of `text` at `size`, in points. */
export function textWidth(text: string, size: number, font: FontName): number {
  const table = font === BOLD ? W_BOLD : W_REGULAR;
  const high = font === BOLD ? W_HIGH_BOLD : W_HIGH_REGULAR;
  let mils = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) mils += table[code - 32]!;
    else if (code >= 160 && code <= 255) mils += high;
    else mils += table[31]!; // the '?' we will actually draw
  }
  return (mils * size) / 1000;
}

/**
 * Shorten to fit `maxWidth`, ending in a real ellipsis character.
 *
 * Long shop and barber names are a stated requirement, not an edge case: a
 * name that runs past its column is the single thing that makes a printed
 * document look broken. Measuring means the cut lands at the last character
 * that fits, never at a guessed character count.
 */
export function fitText(
  text: string,
  maxWidth: number,
  size: number,
  font: FontName,
): string {
  if (textWidth(text, size, font) <= maxWidth) return text;
  const ell = "…";
  const ellWidth = textWidth(ell, size, font);
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = textWidth(ch, size, font);
    if (width + w + ellWidth > maxWidth) break;
    out += ch;
    width += w;
  }
  return `${out.trimEnd()}${ell}`;
}

/**
 * One character to one WinAnsi byte, with the PDF string escapes applied.
 *
 * Anything outside Latin-1 becomes '?'. That is deliberate: a mangled byte
 * sequence can break the content stream and produce a file no reader opens,
 * and a visible '?' in a name is far better than a report that will not print.
 */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else if (code === 0x2026) out += "..."; // ellipsis -> three dots, always safe
    else if (code === 0x2013 || code === 0x2014) out += "-";
    else out += "?";
  }
  return out;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** #RRGGBB -> the 0..1 triple PDF wants. */
export function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/**
 * Draws into one page's content stream.
 *
 * Coordinates are the CALLER'S: origin top-left, y growing downwards, measured
 * inside SAFE_BOX. `build()` translates the whole thing into PDF space (origin
 * bottom-left) and centres it on the chosen paper, so no layout code ever has
 * to think about either.
 */
export class PdfPage {
  private ops: string[] = [];

  fill(color: Rgb): this {
    this.ops.push(`${f(color.r)} ${f(color.g)} ${f(color.b)} rg`);
    return this;
  }

  stroke(color: Rgb): this {
    this.ops.push(`${f(color.r)} ${f(color.g)} ${f(color.b)} RG`);
    return this;
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): this {
    this.fill(color);
    this.ops.push(`${f(x)} ${f(SAFE_BOX.height - y - h)} ${f(w)} ${f(h)} re f`);
    return this;
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.5): this {
    this.stroke(color);
    this.ops.push(
      `${f(width)} w ${f(x1)} ${f(SAFE_BOX.height - y1)} m ${f(x2)} ${f(SAFE_BOX.height - y2)} l S`,
    );
    return this;
  }

  /** `y` is the text BASELINE, measured from the top of the safe box. */
  text(
    value: string,
    x: number,
    y: number,
    opts: { size: number; font?: FontName; color: Rgb; align?: "left" | "right" | "center" },
  ): this {
    const font = opts.font ?? REGULAR;
    let drawX = x;
    if (opts.align === "right") drawX = x - textWidth(value, opts.size, font);
    else if (opts.align === "center") drawX = x - textWidth(value, opts.size, font) / 2;
    this.fill(opts.color);
    this.ops.push(
      `BT /${font} ${f(opts.size)} Tf ${f(drawX)} ${f(SAFE_BOX.height - y)} Td (${pdfString(value)}) Tj ET`,
    );
    return this;
  }

  content(): string {
    return this.ops.join("\n");
  }
}

export interface PdfDocumentInput {
  page: PdfPage;
  paper: PaperSize;
  /**
   * The document title, written into the PDF /Info dictionary.
   *
   * 🔴 Metadata is part of the file a barber emails on. Nothing that could name
   * a CLIENT belongs here - the caller passes a generic title, and this module
   * writes no /Author and no /Subject at all rather than let a name leak into a
   * field nobody thinks to look at.
   */
  title: string;
  /** The instant stamped as /CreationDate. */
  now: Date;
}

/** D:YYYYMMDDHHmmSSZ - the PDF date form, always UTC so it carries no locale. */
function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Assemble the objects, the cross-reference table and the trailer. */
export function buildPdf(input: PdfDocumentInput): Buffer {
  const size = PAGE_SIZES[input.paper];
  // Centre the safe box on the real page. Both offsets are >= 0 by
  // construction (SAFE_BOX is the intersection of the two paper sizes), so
  // nothing can ever be pushed off an edge.
  const dx = (size.width - SAFE_BOX.width) / 2;
  const dy = (size.height - SAFE_BOX.height) / 2;
  const content = `q 1 0 0 1 ${f(dx)} ${f(dy)} cm\n${input.page.content()}\nQ`;
  const contentBytes = Buffer.from(content, "latin1");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(size.width)} ${f(size.height)}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title (${pdfString(input.title)}) /Producer (ChairBack) /Creator (ChairBack) ` +
      `/CreationDate (${pdfDate(input.now)}) >>`,
  ];

  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (s: string) => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    offset += b.length;
  };

  push("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
