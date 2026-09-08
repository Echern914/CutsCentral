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
};
const addBlock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as Reply),
);
vi.mock("./actions", () => ({ addBlockAction: addBlock }));

const { BlockOffForm } = await import("./BlockOffForm");

/**
 * The Block-off sheet: a date that can be changed, "All day", "Block multiple
 * days", a summary that says what will happen, and a refusal it can answer.
 *
 * What has to hold:
 *  - the calendar's day is the default, and any later day can be picked in place;
 *  - a timed block leaves the form as instants converted through the SHOP's
 *    zone - never the device's;
 *  - whole days leave as day keys, so the API resolves the midnights;
 *  - the summary reads "September 9–16 · All day · 8 days" before saving;
 *  - a bad range never reaches the server;
 *  - a refusal over existing bookings is shown in the server's words, and
 *    "Block anyway" replays the exact confirmation it came with;
 *  - the calendar is told exactly once, on success.
 */
const staff: StaffRow[] = [
  { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
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

const summary = () => document.querySelector('[data-qa="block-summary"]');
const summaryText = () =>
  (document.querySelector('[data-qa="block-summary"] p:last-child') as HTMLElement).textContent;
const submit = () => fireEvent.click(screen.getByRole("button", { name: /Add block|Block \d+ days/ }));
const sent = (call = 0) => addBlock.mock.calls[call]![0] as Record<string, unknown>;
const set = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  addBlock.mockReset();
  addBlock.mockResolvedValue({ ok: true, created: 1 });
  toast.mockReset();
  onCreated.mockReset();
  onClose.mockReset();
});

describe("the block-off sheet", () => {
  it("starts on the calendar's day with the tapped hour, and says so", async () => {
    await open();
    expect(screen.getByLabelText("Date")).toHaveValue("2026-09-09");
    expect(screen.getByLabelText("Date")).toHaveAttribute("min", TODAY);
    expect(screen.getByLabelText("From")).toHaveValue("12:00");
    expect(screen.getByLabelText("To")).toHaveValue("13:00");
    expect(summaryText()).toBe("Wednesday, September 9 · 12:00 PM–1:00 PM");
    expect(summary()).toBeTruthy();
  });

  it("starts on today when the calendar was sitting on a day that has passed", async () => {
    await open({ dayKey: "2026-09-01" });
    expect(screen.getByLabelText("Date")).toHaveValue(TODAY);
  });

  it("sends a timed block as instants converted through the shop's zone", async () => {
    await open();
    set("Date", "2026-09-11");
    set("From", "14:00");
    set("To", "17:00");
    expect(summaryText()).toBe("Friday, September 11 · 2:00 PM–5:00 PM");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    // 2 PM New York on Sep 11 (EDT, -4) is 18:00Z - not 14:00Z, whatever zone
    // the test runner happens to be in.
    expect(sent()).toMatchObject({
      kind: "timed",
      staffId: "stf1",
      startsAt: "2026-09-11T18:00:00.000Z",
      endsAt: "2026-09-11T21:00:00.000Z",
    });
    expect(sent().confirmation).toBeUndefined();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Time blocked off", "success");
  });

  it("sends a whole day as its day key and lets the API find midnight", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "All day" }));
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(summaryText()).toBe("September 9 · All day");
    set("Date", "2026-09-30");
    expect(summaryText()).toBe("September 30 · All day");
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({
      kind: "days",
      staffId: "stf1",
      fromDate: "2026-09-30",
      toDate: "2026-09-30",
      reason: undefined,
      confirmation: undefined,
    });
  });

  it("blocks a range of days from a start date through an end date", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Block multiple days" }));
    // The time card goes away: a range is all day on every day.
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.queryByRole("button", { name: "All day" })).toBeNull();
    // The end starts on the start - never behind it.
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-09-09");
    expect(screen.getByLabelText("End date")).toHaveValue("2026-09-09");
    set("End date", "2026-09-16");
    expect(summaryText()).toBe("September 9–16 · All day · 8 days");
    expect(screen.getByRole("button", { name: "Block 8 days" })).toBeInTheDocument();
    set("Only you see this", "Vacation");
    addBlock.mockResolvedValueOnce({ ok: true, created: 8 });
    submit();
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({
      kind: "days",
      staffId: "stf1",
      fromDate: "2026-09-09",
      toDate: "2026-09-16",
      reason: "Vacation",
      confirmation: undefined,
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("8 days blocked off", "success");
  });

  it("drags the end date along when the start moves past it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Block multiple days" }));
    set("End date", "2026-09-12");
    set("Start date", "2026-09-20");
    expect(screen.getByLabelText("End date")).toHaveValue("2026-09-20");
    expect(screen.getByLabelText("End date")).toHaveAttribute("min", "2026-09-20");
  });

  it("refuses a bad range or time before it reaches the server", async () => {
    await open();
    set("To", "11:00");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "End time must be after the start time.",
    );
    set("Date", "2026-09-01");
    set("To", "15:00");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("That date has already passed.");

    fireEvent.click(screen.getByRole("button", { name: "Block multiple days" }));
    set("Start date", "2026-09-16");
    set("End date", "2026-09-09");
    expect(summaryText()).toBe("Pick when to block.");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The end date must be on or after the start date.",
    );
    expect(addBlock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows the bookings it would sit on, in the server's words, and blocks anyway only with that confirmation", async () => {
    const REASON = "2 appointments are already booked during this time.";
    const LINES = [
      "Thu, Sep 10, 2:00 PM–2:30 PM · Marcus Reed · Fade",
      "Fri, Sep 11, 10:00 AM–10:45 AM · Dee · Line up (request)",
    ];
    addBlock.mockResolvedValueOnce({
      ok: false,
      error: "appointments_overlap",
      reason: REASON,
      conflicts: LINES,
      confirmation: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Block multiple days" }));
    set("End date", "2026-09-11");
    submit();

    const banner = await screen.findByRole("alertdialog");
    expect(banner).toHaveTextContent(REASON);
    for (const line of LINES) expect(banner).toHaveTextContent(line);
    expect(banner).toHaveTextContent("stay exactly as they are");
    expect(document.activeElement).toBe(banner);
    // Nothing happened yet: no toast, no refresh, the dates still there.
    expect(onCreated).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByLabelText("End date")).toHaveValue("2026-09-11");

    fireEvent.click(within(banner).getByRole("button", { name: "Block anyway" }));
    await waitFor(() => expect(addBlock).toHaveBeenCalledTimes(2));
    expect(sent(1)).toMatchObject({
      kind: "days",
      fromDate: "2026-09-09",
      toDate: "2026-09-11",
      confirmation: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("3 days blocked off", "success");
  });

  it("a refusal without a confirmation can only be walked away from", async () => {
    addBlock.mockResolvedValueOnce({
      ok: false,
      error: "appointments_overlap",
      reason: "1 appointment is already booked during this time.",
    });
    await open();
    submit();
    const banner = await screen.findByRole("alertdialog");
    expect(within(banner).queryByRole("button", { name: "Block anyway" })).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: "Change the dates" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(addBlock).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet open on any other failure", async () => {
    addBlock.mockResolvedValueOnce({ ok: false, error: "network_error" });
    await open();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't add the block");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
