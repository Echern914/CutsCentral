import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const save = vi.hoisted(() => vi.fn(async (_note: string | null) => ({ ok: true })));
vi.mock("./actions", () => ({ saveClientNoteAction: save }));

const { ClientNoteCard } = await import("./ClientNoteCard");
const { ClientNoteBlock } = await import("../../book/ClientNoteBlock");

/**
 * NOTE FOR CLIENTS (a barber: "add notes to the confirmations - please arrive
 * 10 minutes early"). The settings card, and the block clients read.
 */
function open(initialNote: string | null = null) {
  render(<ClientNoteCard shopName="Fade Street" initialNote={initialNote} toast={vi.fn()} />);
}
const box = () => screen.getByLabelText("Note") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: /Save note|Saving/ }) as HTMLButtonElement;

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
});

describe("the settings card", () => {
  it("says where the note shows - and that texts don't carry it", () => {
    open();
    expect(document.body.textContent).toMatch(/booked screen, their appointment page, and the confirmation and reminder emails/);
    expect(document.body.textContent).toMatch(/Not in text messages/);
  });

  it("🔴 previews it the way clients read it, and saves it cleaned", async () => {
    open();
    fireEvent.change(box(), { target: { value: "  Please arrive 10 minutes early.  " } });
    expect(screen.getByTestId("client-note-preview").textContent).toContain("A note from Fade Street");
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledWith("Please arrive 10 minutes early."));
    expect(await screen.findByText("Saved. New confirmations carry this now.")).toBeTruthy();
  });

  it("clearing it saves null, and says confirmations show no note", async () => {
    open("Arrive early.");
    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledWith(null));
    expect(await screen.findByText("Saved. Confirmations show no note.")).toBeTruthy();
  });

  it("Save stays off until something changed", () => {
    open("Arrive early.");
    expect(saveButton().disabled).toBe(true);
  });

  it("a failed save says so, beside the button", async () => {
    save.mockResolvedValue({ ok: false });
    open();
    fireEvent.change(box(), { target: { value: "Arrive early." } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
  });
});

describe("the block clients see", () => {
  it("🔴 renders the owner's words as text, line breaks kept", () => {
    render(<ClientNoteBlock shopName="Fade Street" note={"<b>Arrive early</b>\nParking out back"} />);
    const block = screen.getByTestId("client-note");
    expect(block.textContent).toContain("A note from Fade Street");
    expect(block.textContent).toContain("<b>Arrive early</b>");
    expect(block.querySelector("b")).toBeNull();
  });

  it("renders nothing without a note", () => {
    const { container } = render(<ClientNoteBlock shopName="Fade Street" note={"  "} />);
    expect(container.innerHTML).toBe("");
  });
});
