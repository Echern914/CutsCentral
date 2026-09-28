import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImportClients } from "./ImportClients";

const importRows = vi.fn();
vi.mock("../actions", () => ({
  importClientsAction: (...args: unknown[]) => importRows(...args),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

/** Pick a CSV, wait for the preview, and import it. */
async function importFile(csv: string, rowCount: number) {
  const { container } = render(<ImportClients onDone={() => {}} />);
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([csv], "clients.csv", { type: "text/csv" })] } });
  const button = await screen.findByRole("button", { name: `Import ${rowCount} clients` });
  await act(async () => {
    fireEvent.click(button);
  });
}

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
