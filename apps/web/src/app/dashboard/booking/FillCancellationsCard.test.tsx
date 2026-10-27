import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FILL_CANCELLATIONS_SUMMARY, autoFillBlockerText } from "@chairback/config/fillCancellations";

const save = vi.hoisted(() => vi.fn(async (_on: boolean) => ({ ok: true })));
vi.mock("./actions", () => ({ saveAutoFillAction: save }));

const { FillCancellationsCard } = await import("./FillCancellationsCard");

/**
 * FILL CANCELLATIONS AUTOMATICALLY - the switch, and the reasons it cannot
 * run. Never a switch that silently does nothing.
 */
function open(initialEnabled: boolean, blockers: string[] = []) {
  render(<FillCancellationsCard initialEnabled={initialEnabled} blockers={blockers} />);
}
const toggle = () => screen.getByRole("button", { name: "Fill cancellations automatically" }) as HTMLButtonElement;

beforeEach(() => {
  save.mockReset();
  save.mockImplementation(async () => ({ ok: true }));
});

describe("FillCancellationsCard", () => {
  it("says what it does, in the barber's words", () => {
    open(false);
    expect(screen.getByText("Fill cancellations automatically")).toBeTruthy();
    expect(screen.getByText(FILL_CANCELLATIONS_SUMMARY)).toBeTruthy();
    expect(FILL_CANCELLATIONS_SUMMARY).toBe(
      "When someone cancels, Gold members get a 15-minute head start, then everyone with your app gets a notification. First to book gets it.",
    );
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("turns on: sends only the switch, and says so in the card", async () => {
    open(false);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Saved/));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(true);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("fill-cancellations-state").textContent).toMatch(/^On\./);
  });

  it("turns off", async () => {
    open(true);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/It's off/));
    expect(save).toHaveBeenCalledWith(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("a failed save keeps the switch where it was and says so in the card", async () => {
    save.mockImplementation(async () => ({ ok: false }));
    open(false);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Couldn't save/));
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("a double tap saves once", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    save.mockImplementation(() => new Promise((r) => (finish = r)));
    open(false);
    const b = toggle();
    fireEvent.click(b);
    fireEvent.click(b);
    await act(async () => finish({ ok: true }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  describe("🔴 can't run - says why, and won't turn on", () => {
    it("lists every reason in words, and the switch cannot be turned on", () => {
      open(false, ["rewards_off", "plan"]);
      const box = screen.getByTestId("fill-cancellations-blockers");
      expect(box.textContent).toMatch(/can't be turned on yet/);
      expect(box.textContent).toContain(autoFillBlockerText("rewards_off"));
      expect(box.textContent).toContain(autoFillBlockerText("plan"));
      expect(toggle().disabled).toBe(true);
      fireEvent.click(toggle());
      expect(save).not.toHaveBeenCalled();
    });

    it.each([
      ["not_native", /book somewhere other than ChairBack/],
      ["booking_page_off", /booking page is off/],
      ["rewards_off", /Rewards are off/],
      ["plan", /Premium/],
      ["receptionist_texting", /receptionist already fills cancellations/],
      ["pushes_paused", /notifications are paused/],
    ])("%s reads as a reason", (code, words) => {
      open(false, [code]);
      expect(screen.getByTestId("fill-cancellations-blockers").textContent).toMatch(words);
    });

    it("an unknown reason (a newer API) still shows a plain one", () => {
      open(false, ["something_new"]);
      expect(screen.getByTestId("fill-cancellations-blockers").textContent).toMatch(/setup is stopping it/);
    });

    it("already on and then blocked: says it is not running, and can still be turned off", async () => {
      open(true, ["pushes_paused"]);
      expect(screen.getByTestId("fill-cancellations-state").textContent).toMatch(/can't run right now/);
      expect(screen.getByTestId("fill-cancellations-blockers").textContent).toMatch(/not running because/);
      expect(toggle().disabled).toBe(false);
      fireEvent.click(toggle());
      await waitFor(() => expect(save).toHaveBeenCalledWith(false));
    });

    it("nothing in the way: no reasons shown", () => {
      open(false, []);
      expect(screen.queryByTestId("fill-cancellations-blockers")).toBeNull();
      expect(toggle().disabled).toBe(false);
    });
  });
});
