import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImportClients } from "./ImportClients";

const importRows = vi.fn();
vi.mock("../actions", () => ({
  importClientsAction: (...args: unknown[]) => importRows(...args),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

/* Every name, phone and email here is invented; phones are 555 numbers. */

/** Pick a file and wait for the review list to show its rows. */
async function pick(content: string, name = "clients.csv", type = "text/csv") {
  const { container } = render(<ImportClients onDone={() => {}} />);
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([content], name, { type })] } });
  await screen.findByText(/selected of/);
}

async function clickImport(count: number) {
  const button = await screen.findByRole("button", { name: `Import ${count} client${count === 1 ? "" : "s"}` });
  await act(async () => {
    fireEvent.click(button);
  });
}

/** Pick a CSV, wait for the preview, and import it. */
async function importFile(csv: string, rowCount: number) {
  await pick(csv);
  await clickImport(rowCount);
}

const sentNames = (call = 0) =>
  (importRows.mock.calls[call]![0] as { firstName: string; lastName?: string }[]).map((r) =>
    [r.firstName, r.lastName].filter(Boolean).join(" "),
  );

const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

/**
 * A name-only row whose name is already in the book comes back "same_name".
 * It gets its own next step - never the "couldn't be saved, import again"
 * line, because importing again would skip it again.
 */
describe("ImportClients - a row with only a name that is already in the book", () => {
  beforeEach(() => importRows.mockReset());

  it("says why it was skipped and what to do if it's someone else", async () => {
    importRows.mockResolvedValue({
      ok: true,
      created: 1,
      unchanged: 0,
      total: 2,
      skipped: [{ row: 2, reason: "same_name", name: "Rowan Pike" }],
    });
    await importFile("First name,Last name\nTheo,Lark\nRowan,Pike\n", 2);

    await waitFor(() => expect(screen.getByText(/1 skipped because it has only/)).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).toContain("you already have someone by that name");
    expect(text).toContain("if it's a different person, add them by hand with Add client.");
    expect(text).toContain("Row 2 · You already have someone named Rowan Pike");
    expect(text).not.toContain("couldn't be saved");
  });
});

/**
 * 🔴 ONE LONG CELL NEVER FAILS A WHOLE BATCH. The API caps phone (40), email
 * (160) and notes (2000) per row and refused the WHOLE 500-row request for one
 * cell over, with no row number. Every field now leaves within its cap.
 */
describe("ImportClients - fields leave within the API's caps", () => {
  beforeEach(() => importRows.mockReset());

  it("clips a runaway phone, email and note", async () => {
    importRows.mockResolvedValue({ ok: true, created: 1, unchanged: 0, total: 1, skipped: [] });
    const long = (n: number) => "9".repeat(n);
    await importFile(
      `First name,Phone,Email,Notes\nTheo,${long(60)},${"a".repeat(170)}@x.com,${"n".repeat(2100)}\nRowan,,,\n`,
      2,
    );
    await waitFor(() => expect(importRows).toHaveBeenCalled());
    const [row] = importRows.mock.calls[0]![0] as { phone: string; email: string; notes: string }[];
    expect(row!.phone.length).toBeLessThanOrEqual(40);
    expect(row!.email.length).toBeLessThanOrEqual(160);
    expect(row!.notes.length).toBeLessThanOrEqual(2000);
  });
});

/**
 * 🔑 THECUT HAS NO EXPORT, so a barber brings their phone's contacts (.vcf).
 * Those include friends and family: everything is listed for review first,
 * and only the rows still ticked are sent.
 */
describe("ImportClients - a contacts file is reviewed before anything is sent", () => {
  beforeEach(() => importRows.mockReset());

  const VCF = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Lark;Theo;;;",
    "FN:Theo Lark",
    "TEL;type=CELL:(302) 555-0101",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Mom",
    "TEL;type=CELL:(302) 555-0199",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Pike;Rowan;;;",
    "EMAIL:rowan@example.com",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Name Only",
    "END:VCARD",
  ].join("\r\n");

  it("lists every contact, says to untick friends and family, and imports only the ticked ones", async () => {
    importRows.mockResolvedValue({ ok: true, created: 2, unchanged: 0, total: 2, skipped: [] });
    await pick(VCF, "contacts.vcf", "text/vcard");

    expect(screen.getByText(/contacts include friends and family/)).toBeTruthy();
    expect(screen.getByText(/1 more contact was left out/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Found 3 contacts in contacts\.vcf/);
    for (const name of ["Theo Lark", "Mom", "Rowan Pike"]) expect(checkbox(name).checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Name Only" })).toBeNull();

    fireEvent.click(checkbox("Mom"));
    expect(screen.getByRole("status").textContent).toMatch(/2 selected of 3/);
    await clickImport(2);

    await waitFor(() => expect(importRows).toHaveBeenCalledTimes(1));
    expect(sentNames()).toEqual(["Theo Lark", "Rowan Pike"]);
    // Only the import route's fields go out - the file position stays here.
    expect(importRows.mock.calls[0]![0][0]).toEqual({
      firstName: "Theo",
      lastName: "Lark",
      phone: "(302) 555-0101",
      email: undefined,
      notes: undefined,
    });
  });

  it("recognises a contacts file by its content when the name doesn't say .vcf", async () => {
    await pick(VCF, "export.txt", "text/plain");
    expect(screen.getByText(/contacts include friends and family/)).toBeTruthy();
  });
});

describe("ImportClients - search and selection", () => {
  beforeEach(() => importRows.mockReset());

  const CSV =
    "First name,Last name,Phone,Email\nTheo,Lark,302-555-0101,theo@example.com\nRowan,Pike,302-555-0102,\nIvy,Stone,302-555-0103,ivy@example.com\n";

  it("🔴 filtering never changes who is ticked among the hidden rows", async () => {
    importRows.mockResolvedValue({ ok: true, created: 2, unchanged: 0, total: 2, skipped: [] });
    await pick(CSV);

    const search = screen.getByRole("searchbox", { name: "Search the list" });
    fireEvent.change(search, { target: { value: "rowan" } });
    expect(screen.queryByRole("checkbox", { name: "Theo Lark" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select none shown" }));
    expect(checkbox("Rowan Pike").checked).toBe(false);

    fireEvent.change(search, { target: { value: "" } });
    expect(checkbox("Theo Lark").checked).toBe(true);
    expect(checkbox("Ivy Stone").checked).toBe(true);
    expect(checkbox("Rowan Pike").checked).toBe(false);
    expect(screen.getByRole("status").textContent).toMatch(/2 selected of 3/);

    // A phone search matches on digits, whatever the punctuation.
    fireEvent.change(search, { target: { value: "5550103" } });
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Ivy Stone"]);
    fireEvent.change(search, { target: { value: "" } });

    await clickImport(2);
    await waitFor(() => expect(importRows).toHaveBeenCalledTimes(1));
    expect(sentNames()).toEqual(["Theo Lark", "Ivy Stone"]);
  });

  it("Select none leaves nothing to import, and Select all brings everyone back", async () => {
    await pick(CSV);
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect((screen.getByRole("button", { name: "Import 0 clients" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Import 3 clients" })).toBeTruthy();
  });

  it("🔑 numbers a skipped row by where it sits in the FILE, even with rows unticked", async () => {
    // Theo is unticked, so the route sees [Rowan, Ivy] and says ITS row 2.
    importRows.mockResolvedValue({
      ok: true,
      created: 1,
      unchanged: 0,
      total: 2,
      skipped: [{ row: 2, reason: "same_name", name: "Ivy Stone" }],
    });
    await pick(CSV);
    fireEvent.click(checkbox("Theo Lark"));
    await clickImport(2);
    await waitFor(() => expect(screen.getByText(/1 skipped because it has only/)).toBeTruthy());
    expect(document.body.textContent).toContain("Row 3 · You already have someone named Ivy Stone");
  });
});

describe("ImportClients - a Booksy-style export", () => {
  beforeEach(() => importRows.mockReset());

  it("reads a semicolon file with a byte-order mark and Booksy-like headers", async () => {
    importRows.mockResolvedValue({ ok: true, created: 1, unchanged: 0, total: 1, skipped: [] });
    await importFile(
      "﻿Customer name;Mobile phone;E-mail;Notes\r\nTheo Lark;302-555-0101;theo@example.com;skin fade, no beard\r\n",
      1,
    );
    await waitFor(() => expect(importRows).toHaveBeenCalledTimes(1));
    expect(importRows.mock.calls[0]![0]).toEqual([
      {
        firstName: "Theo",
        lastName: "Lark",
        phone: "302-555-0101",
        email: "theo@example.com",
        notes: "skin fade, no beard",
      },
    ]);
  });
});
