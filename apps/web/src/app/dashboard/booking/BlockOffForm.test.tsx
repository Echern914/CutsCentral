import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRow } from "./page";

type Reply = {
  ok: boolean;
  error?: string;
  reason?: string;
  conflicts?: string[];
  confirmation?: string;
  created?: number;
  message?: string;
};
const addBlock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as Reply),
);
vi.mock("./actions", () => ({ addBlockAction: addBlock }));

const { BlockOffForm } = await import("./BlockOffForm");

/**
 * The Block-off sheet: who, when (one day, several days, every week), the
 * hours, a note, and a REVIEW that says exactly what Save will do.
 *
 * What has to hold:
 *  - the calendar's day and tapped hour are the defaults;
 *  - everything leaves as SHOP-LOCAL day keys and minutes - the API resolves
 *    the instants, so no device zone can move a block;
 *  - "same hours each day" and "one stretch" are different requests, and say so;
 *  - a weekly repeat is bounded, and the review lists its dates;
 *  - several providers can be blocked at once;
 *  - a refusal over existing bookings is shown in the server's words, and
 *    "Block anyway" replays the exact confirmation it came with;
 *  - one Save is one request id: a retry re-sends it, a changed form does not;
 *  - nothing is squashed into a column on a phone.
 */
const staff: StaffRow[] = [
  { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];
const two: StaffRow[] = [
  ...staff,
  { id: "stf2", name: "Max", bio: null, imageUrl: null, active: true, sortOrder: 1 },
];
const TODAY = "2026-09-08";
const toast = vi.fn();
const onCreated = vi.fn();
const onClose = vi.fn();

function open(props: Partial<React.ComponentProps<typeof BlockOffForm>> = {}) {
  render(
    <BlockOffForm
      staff={staff}
      dayKey="2026-09-09"
      todayKey={TODAY}
      timezone="America/New_York"
      defaultFromHour={12}
      onClose={onClose}
      onCreated={onCreated}
      toast={toast}
      {...props}
    />,
  );
  // The dialog portals in after its first commit.
  return screen.findByRole("dialog");
}

const summaryText = () => document.querySelector('[data-qa="block-summary-line"]')!.textContent;
const reviewDays = () =>
  Array.from(document.querySelectorAll('[data-qa="block-review-days"] li')).map((li) => li.textContent);
const saveButton = () => screen.getByRole("button", { name: /Add block|Block \d+ (days|weeks)/ });
const submit = () => fireEvent.click(saveButton());
const sent = (call = 0) => addBlock.mock.calls[call]![0] as Record<string, unknown>;
const set = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  addBlock.mockReset();
  addBlock.mockResolvedValue({ ok: true, created: 1 });
  toast.mockReset();
  onCreated.mockReset();
  onClose.mockReset();
});

describe("the block-off sheet", () => {
  it("starts on the calendar's day with the tapped hour, and reviews it", async () => {
    await open();
    expect(screen.getByLabelText("Date")).toHaveValue("2026-09-09");
    expect(screen.getByLabelText("Date")).toHaveAttribute("min", TODAY);
    expect(screen.getByLabelText("From")).toHaveValue("12:00");
    expect(screen.getByLabelText("To")).toHaveValue("13:00");
    expect(summaryText()).toBe("Wednesday, September 9 · 12:00 PM–1:00 PM");
    expect(screen.getByRole("button", { name: "One day" })).toHaveAttribute("aria-pressed", "true");
  });

  it("starts on today when the calendar was sitting on a day that has passed", async () => {
    await open({ dayKey: "2026-09-01" });
    expect(screen.getByLabelText("Date")).toHaveValue(TODAY);
  });

  it("sends one timed day as a day key and shop-local minutes, with a request id", async () => {
    await open();
    set("Date", "2026-09-11");
    set("From", "14:00");
    set("To", "17:00");
    expect(summaryText()).toBe("Friday, September 11 · 2:00 PM–5:00 PM");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      staffIds: ["stf1"],
      when: { kind: "day", date: "2026-09-11", fromMin: 14 * 60, toMin: 17 * 60 },
    });
    expect(sent().requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(sent().confirmation).toBeUndefined();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Time blocked off", "success");
  });

  it("an end of 12:00 AM is the END of the day", async () => {
    await open({ defaultFromHour: 23 });
    expect(screen.getByLabelText("To")).toHaveValue("00:00");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toEqual({ kind: "day", date: "2026-09-09", fromMin: 23 * 60, toMin: 24 * 60 });
  });

  it("sends a whole day as its day key alone and lets the API find midnight", async () => {
    await open();
    press("All day");
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(summaryText()).toBe("September 9 · All day");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toEqual({ kind: "day", date: "2026-09-09" });
  });

  it("several days, SAME HOURS EACH DAY: the time between stays open, and the review lists every day", async () => {
    await open();
    press("Several days");
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-09-09");
    expect(screen.getByLabelText("End date")).toHaveValue("2026-09-09");
    set("End date", "2026-09-16");
    set("From", "09:00");
    set("To", "12:00");
    expect(screen.getByRole("button", { name: "Same hours each day" })).toHaveAttribute("aria-pressed", "true");
    expect(summaryText()).toBe("September 9–16 · 9:00 AM–12:00 PM each day · 8 days");
    expect(screen.getByText(/The rest of each day stays open/)).toBeInTheDocument();
    expect(reviewDays()).toEqual([
      "Wed, Sep 9",
      "Thu, Sep 10",
      "Fri, Sep 11",
      "Sat, Sep 12",
      "Sun, Sep 13",
      "Mon, Sep 14",
      "Tue, Sep 15",
      "Wed, Sep 16",
    ]);
    set("Only you see this", "Mornings off");
    addBlock.mockResolvedValueOnce({ ok: true, created: 8 });
    expect(saveButton()).toHaveTextContent("Block 8 days");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      staffIds: ["stf1"],
      when: { kind: "daily", fromDate: "2026-09-09", toDate: "2026-09-16", fromMin: 9 * 60, toMin: 12 * 60 },
      reason: "Mornings off",
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("8 days blocked off", "success"));
  });

  it("several days, ONE STRETCH: from the first day's start straight through the last day's end", async () => {
    await open();
    press("Several days");
    set("End date", "2026-09-11");
    press("One stretch");
    expect(screen.getByLabelText("Starts (first day)")).toHaveValue("12:00");
    set("Starts (first day)", "09:00");
    set("Ends (last day)", "17:00");
    expect(summaryText()).toBe(
      "Wednesday, September 9, 9:00 AM straight through Friday, September 11, 5:00 PM",
    );
    expect(screen.getByText(/nothing in between is bookable/)).toBeInTheDocument();
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toEqual({
      kind: "continuous",
      fromDate: "2026-09-09",
      fromMin: 9 * 60,
      toDate: "2026-09-11",
      toMin: 17 * 60,
    });
  });

  it("a range All day is whole days, never a stretch", async () => {
    await open();
    press("Several days");
    press("All day");
    expect(screen.queryByRole("button", { name: "One stretch" })).toBeNull();
    set("End date", "2026-09-16");
    expect(summaryText()).toBe("September 9–16 · All day · 8 days");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toEqual({ kind: "daily", fromDate: "2026-09-09", toDate: "2026-09-16" });
  });

  it("repeats the same block weekly for a number of weeks, and lists the dates", async () => {
    await open();
    press("Every week");
    set(/^Weeks/, "3");
    expect(summaryText()).toBe("Every Wednesday · 12:00 PM–1:00 PM · 3 weeks, September 9–23");
    expect(reviewDays()).toEqual(["Wed, Sep 9", "Wed, Sep 16", "Wed, Sep 23"]);
    expect(saveButton()).toHaveTextContent("Block 3 weeks");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toEqual({
      kind: "day",
      date: "2026-09-09",
      fromMin: 12 * 60,
      toMin: 13 * 60,
      repeat: { weeks: 3 },
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("3 weeks blocked off", "success"));
  });

  it("or until a date, and never more than 52 weeks", async () => {
    await open();
    press("Every week");
    set(/^Weeks/, "53");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Repeat up to 52 weeks.");
    expect(addBlock).not.toHaveBeenCalled();

    press("Until a date");
    set("Last date", "2026-09-30");
    expect(reviewDays()).toEqual(["Wed, Sep 9", "Wed, Sep 16", "Wed, Sep 23", "Wed, Sep 30"]);
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().when).toMatchObject({ kind: "day", date: "2026-09-09", repeat: { until: "2026-09-30" } });
  });

  it("blocks several providers at once, and the review says who", async () => {
    await open({ staff: two });
    expect(screen.getByText("No one picked yet.")).toBeInTheDocument();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick who to block.");
    expect(addBlock).not.toHaveBeenCalled();

    press("Everyone");
    expect(screen.getByRole("button", { name: "Dee" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Max" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-qa="block-review-who"]')).toHaveTextContent("For Dee, Max");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent().staffIds).toEqual(["stf1", "stf2"]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Time blocked off for 2 providers", "success"));
  });

  it("refuses a bad range or time before it reaches the server", async () => {
    await open();
    set("To", "11:00");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("End time must be after the start time.");
    set("Date", "2026-09-01");
    set("To", "15:00");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("That date has already passed.");

    press("Several days");
    set("Start date", "2026-09-16");
    set("End date", "2026-09-09");
    expect(summaryText()).toBe("Pick when to block.");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The end date must be on or after the start date.",
    );
    expect(addBlock).not.toHaveBeenCalled();
  });

  it("reviews the bookings it would sit on, in the server's words, and blocks anyway only with that confirmation", async () => {
    const REASON = "2 appointments are already booked during this time.";
    const LINES = [
      "Max · Thu, Sep 10, 2:00 PM–2:30 PM · Marcus Reed · Fade",
      "Dee · Fri, Sep 11, 10:00 AM–10:45 AM · Dee · Line up (request)",
    ];
    addBlock.mockResolvedValueOnce({
      ok: false,
      error: "appointments_overlap",
      reason: REASON,
      conflicts: LINES,
      confirmation: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
    await open({ staff: two });
    press("Everyone");
    press("Several days");
    set("End date", "2026-09-11");
    submit();

    const banner = await screen.findByRole("alertdialog");
    expect(banner).toHaveTextContent(REASON);
    for (const line of LINES) expect(banner).toHaveTextContent(line);
    expect(banner).toHaveTextContent("stay exactly as they are");
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(within(banner).getByRole("button", { name: "Block anyway" }));
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(2));
    expect(sent(1)).toMatchObject({
      when: { kind: "daily", fromDate: "2026-09-09", toDate: "2026-09-11" },
      confirmation: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
    // The same save: nothing was written by the refusal, so the same id.
    expect(sent(1).requestId).toBe(sent(0).requestId);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("🔴 a retry of the SAME save re-sends its request id; a changed save gets a new one", async () => {
    addBlock.mockResolvedValueOnce({ ok: false, error: "network_error" });
    addBlock.mockResolvedValueOnce({ ok: false, error: "network_error" });
    await open();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't add the block");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(2));
    expect(sent(1).requestId).toBe(sent(0).requestId);

    set("To", "14:00");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(3));
    expect(sent(2).requestId).not.toBe(sent(0).requestId);
  });

  it("keeps the sheet open on a refused input and says what the server said", async () => {
    addBlock.mockResolvedValueOnce({ ok: false, error: "invalid_input", message: "Those days have already passed." });
    await open();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Those days have already passed.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("says plainly that the block is not copied to Acuity - only when Acuity is connected", async () => {
    await open({ acuityConnected: true });
    expect(document.querySelector('[data-qa="block-acuity-note"]')).toHaveTextContent(
      "isn't copied to Acuity yet",
    );
  });

  it("no Acuity sentence for a shop without Acuity", async () => {
    await open();
    expect(document.querySelector('[data-qa="block-acuity-note"]')).toBeNull();
  });

  it("🔴 on a phone the choice rows share the width instead of stacking into a squashed column", async () => {
    await open();
    const spanRow = document.querySelector('[data-qa="block-span"]')!;
    expect(spanRow.className).toContain("flex");
    expect(spanRow.className).not.toContain("flex-col");
    for (const b of within(spanRow as HTMLElement).getAllByRole("button")) {
      expect(b.className).toContain("min-w-0");
      expect(b.className).toContain("flex-1");
    }
    press("Several days");
    const shapeRow = document.querySelector('[data-qa="block-days-shape"]')!;
    expect(shapeRow.className).not.toContain("flex-col");
    for (const b of within(shapeRow as HTMLElement).getAllByRole("button")) {
      expect(b.className).toContain("min-w-0");
      expect(b.className).toContain("flex-1");
    }
  });
});
