import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * Paste your menu from another app (Services tab).
 *
 *  - the paste becomes a list to check: names, lengths and prices as read;
 *  - a missing length is asked for, never guessed - Add waits for it;
 *  - unticked rows and names already on the menu are not sent;
 *  - lines it couldn't read are shown word for word;
 *  - two taps send once; a lost answer says retrying is safe.
 */
const bulk = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ createServicesBulkAction: bulk }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { PasteMenu } = await import("./PasteMenu");

const toast = vi.fn();
beforeEach(() => {
  bulk.mockReset();
  toast.mockReset();
});

function show(over: Partial<Parameters<typeof PasteMenu>[0]> = {}) {
  return render(<PasteMenu existingNames={[]} defaultOpen toast={toast} {...over} />);
}
function paste(text: string) {
  fireEvent.change(screen.getByLabelText("Your menu"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Read my menu" }));
}
const rows = () => screen.getAllByTestId("paste-menu-row");
const addButton = () => screen.getByRole("button", { name: /^Add \d+ services?$/ });

describe("paste your menu", () => {
  it("🔴 reads the paste into a list and adds exactly what it shows", async () => {
    bulk.mockResolvedValue({ ok: true, created: 2, skipped: [] });
    show();
    paste("Taper\n45min\n$40.00\nBook\nBeard trim - $20 (15 min)");
    expect(rows()).toHaveLength(2);
    expect((screen.getByLabelText("Minutes for Taper") as HTMLInputElement).value).toBe("45");
    expect((screen.getByLabelText("Price for Taper") as HTMLInputElement).value).toBe("40");

    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(bulk).toHaveBeenCalledWith([
      { name: "Taper", durationMin: 45, price: 40 },
      { name: "Beard trim", durationMin: 15, price: 20 },
    ]);
    expect(toast).toHaveBeenCalledWith("Added 2 services.", "success");
  });

  it("🔴 a row with no length is asked for, and Add waits until it has one", async () => {
    bulk.mockResolvedValue({ ok: true, created: 1, skipped: [] });
    show();
    paste("Taper $40");
    expect(screen.getByRole("alert").textContent).toMatch(/Add how long it takes\./);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    // The greyed-out Add says why, beside it.
    expect(screen.getByTestId("paste-menu-blocked").textContent).toBe("Taper: add how long it takes.");

    fireEvent.change(screen.getByLabelText("Minutes for Taper"), { target: { value: "30" } });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(bulk).toHaveBeenCalledWith([{ name: "Taper", durationMin: 30, price: 40 }]);
  });

  it("an unticked row, and a name already on the menu, are not sent", async () => {
    bulk.mockResolvedValue({ ok: true, created: 1, skipped: [] });
    show({ existingNames: ["  TAPER "] });
    paste("Taper $40 45 min\nBeard $20 15 min\nShave $35 30 min");
    expect(screen.getByText("Already on your menu - left as it is.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Add Shave"));
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(bulk).toHaveBeenCalledWith([{ name: "Beard", durationMin: 15, price: 20 }]);
  });

  it("lines it couldn't read are shown word for word", () => {
    show();
    paste("Fades\nMid $40 45 min");
    const help = screen.getByText(/These lines had no price or length to go on/).parentElement!;
    expect(within(help).getByText("Fades")).toBeTruthy();
  });

  it("two rows renamed to the same name can't be added", () => {
    show();
    paste("Taper $40 45 min\nBeard $20 15 min");
    fireEvent.change(screen.getAllByLabelText("Name")[1]!, { target: { value: "taper" } });
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/can't share a name/);
  });

  it("🔴 two taps send once", async () => {
    let answer!: (v: unknown) => void;
    bulk.mockReturnValue(new Promise((r) => (answer = r)));
    show();
    paste("Taper $40 45 min");
    const add = addButton();
    await act(async () => {
      add.click();
      add.click();
    });
    expect(bulk).toHaveBeenCalledTimes(1);
    await act(async () => answer({ ok: true, created: 1, skipped: [] }));
  });

  it("no answer says trying again is safe; a refusal says nothing changed", async () => {
    bulk.mockResolvedValueOnce({ ok: false, answered: false });
    show();
    paste("Taper $40 45 min");
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(screen.getByRole("alert").textContent).toMatch(/No answer from ChairBack\. Tap Add again: anything already added is skipped/);

    bulk.mockResolvedValueOnce({ ok: false, answered: true });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Nothing was changed/);
    expect(toast).not.toHaveBeenCalled();
  });

  it("says which names were already there", async () => {
    bulk.mockResolvedValue({ ok: true, created: 1, skipped: ["Beard"] });
    show();
    paste("Taper $40 45 min\nBeard $20 15 min");
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(toast).toHaveBeenCalledWith("Added 1 service. Beard was already on your menu.", "success");
  });

  it("closed on a shop that has services: a link opens it", () => {
    show({ defaultOpen: false });
    expect(screen.queryByLabelText("Your menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Paste your menu from another app" }));
    expect(screen.getByLabelText("Your menu")).toBeTruthy();
  });
});
