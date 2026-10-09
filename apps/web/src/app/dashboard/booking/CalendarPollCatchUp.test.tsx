import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * THE CALENDAR'S POLL UNDER AN OPEN DIALOG.
 *
 * The 20 s poll skips a tick while any dialog is open: a refresh that moved a
 * booking to another hour remounted its card and closed the sheet with its
 * result. The skipped tick is owed, and paid as soon as the last dialog
 * closes - not up to 20 s later - so whatever changed meanwhile shows at once.
 * (The picture behind a dialog never decides anything: saves are checked by
 * the server.)
 */
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const getAgendaAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: false })));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction,
}));

const { BookingCalendar } = await import("./BookingCalendar");

function renderCalendar() {
  const initial: AgendaResponse = { agenda: [], source: "appointment", timezone: "America/New_York", categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative={false}
      staff={[]}
      services={[]}
      toast={() => {}}
    />,
  );
}
function openDialog() {
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  document.body.appendChild(el);
  return el;
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  getAgendaAction.mockClear();
});
afterEach(() => {
  document.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
  vi.useRealTimers();
});

describe("the poll under an open dialog", () => {
  it("re-reads the calendar every 20 s when nothing is open", async () => {
    renderCalendar();
    await tick(20_000);
    expect(getAgendaAction).toHaveBeenCalledTimes(1);
  });

  it("🔴 skips while a dialog is open", async () => {
    renderCalendar();
    openDialog();
    await tick(45_000);
    expect(getAgendaAction).not.toHaveBeenCalled();
  });

  it("🔴 catches up within a second of the dialog closing, not at the next tick", async () => {
    renderCalendar();
    const dialog = openDialog();
    await tick(21_000);
    expect(getAgendaAction).not.toHaveBeenCalled();
    dialog.remove();
    await tick(600);
    expect(getAgendaAction).toHaveBeenCalledTimes(1);
    // Once: the owed tick is paid, not repaid.
    await tick(5_000);
    expect(getAgendaAction).toHaveBeenCalledTimes(1);
  });

  it("nothing is owed if no tick was skipped", async () => {
    renderCalendar();
    const dialog = openDialog();
    await tick(5_000);
    dialog.remove();
    await tick(2_000);
    expect(getAgendaAction).not.toHaveBeenCalled();
  });
});
