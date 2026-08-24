import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WaitlistForm, rowToWindow } from "./WaitlistForm";

vi.mock("./actions", () => ({
  joinWaitlistAction: vi.fn(async () => ({ ok: true })),
}));

/**
 * The waitlist form's own half of the contract.
 *
 * The server validates everything again - these tests are about what the
 * customer is allowed to build and what they are told when it is wrong, which
 * the API tests cannot see.
 */

const row = (over: Partial<Parameters<typeof rowToWindow>[0]> = {}) => ({
  dateMode: "any" as const,
  startDate: "",
  endDate: "",
  timeMode: "any" as const,
  startTime: "09:00",
  endTime: "17:00",
  ...over,
});

describe("a row becomes a window", () => {
  it("🔑 the default is Any date / Any time - all nulls", () => {
    // The one-tap case, and the exact shape every pre-existing entry has.
    const r = rowToWindow(row());
    expect(r).toEqual({
      ok: true,
      window: { startDate: null, endDate: null, startMin: null, endMin: null },
    });
  });

  it("a single date sets both ends to the same day", () => {
    const r = rowToWindow(row({ dateMode: "on", startDate: "2026-08-29" }));
    expect(r).toMatchObject({
      ok: true,
      window: { startDate: "2026-08-29", endDate: "2026-08-29" },
    });
  });

  it("a range keeps both ends", () => {
    const r = rowToWindow(
      row({ dateMode: "between", startDate: "2026-08-29", endDate: "2026-09-02" }),
    );
    expect(r).toMatchObject({
      ok: true,
      window: { startDate: "2026-08-29", endDate: "2026-09-02" },
    });
  });

  it("converts times to minutes past midnight", () => {
    const r = rowToWindow(row({ timeMode: "between", startTime: "09:30", endTime: "12:00" }));
    expect(r).toMatchObject({ ok: true, window: { startMin: 570, endMin: 720 } });
  });

  it("asks for the missing half rather than sending it", () => {
    expect(rowToWindow(row({ dateMode: "on" }))).toEqual({
      ok: false,
      error: "Pick a date.",
    });
    expect(rowToWindow(row({ dateMode: "between", startDate: "2026-08-29" }))).toEqual({
      ok: false,
      error: "Pick both dates.",
    });
  });

  it("catches a backwards range and a backwards time in the browser", () => {
    expect(
      rowToWindow(
        row({ dateMode: "between", startDate: "2026-09-02", endDate: "2026-08-29" }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      rowToWindow(row({ timeMode: "between", startTime: "17:00", endTime: "09:00" })),
    ).toMatchObject({ ok: false });
    // End-exclusive: equal is an empty window, not a moment.
    expect(
      rowToWindow(row({ timeMode: "between", startTime: "09:00", endTime: "09:00" })),
    ).toMatchObject({ ok: false });
  });
});

describe("the form", () => {
  const props = { slug: "cuts", shopName: "Cuts", accent: "#c9a24a" };

  it("🔴 the consent box appears only with a phone, and starts UNCHECKED", () => {
    render(<WaitlistForm {...props} />);
    // No phone yet: nothing to consent about.
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    // Pre-ticking would make the record worthless as evidence, which is the
    // only reason to collect it.
    expect(box.checked).toBe(false);
    expect(screen.getByText(/Reply STOP to opt out/i)).toBeTruthy();
  });

  it("offers up to five options and no more", () => {
    render(<WaitlistForm {...props} />);
    const add = () => screen.queryByText("+ Add another option");
    for (let i = 0; i < 4; i++) {
      expect(add(), `add link before option ${i + 2}`).toBeTruthy();
      fireEvent.click(add()!);
    }
    expect(screen.getByText("Option 5")).toBeTruthy();
    expect(add()).toBeNull();
  });

  it("will not submit without a name or a way to reach them", () => {
    render(<WaitlistForm {...props} />);
    fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
    expect(screen.getByRole("alert").textContent).toMatch(/name/i);

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Wanda" } });
    fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
    expect(screen.getByRole("alert").textContent).toMatch(/phone or email/i);
  });

  it("every control is reachable by an accessible name", () => {
    // The date/time chips are the only new interactive surface; a screen
    // reader user has to be able to tell option 1 from option 2.
    render(<WaitlistForm {...props} />);
    expect(screen.getByRole("group", { name: "Dates for option 1" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Times for option 1" })).toBeTruthy();
    fireEvent.click(screen.getByText("A date"));
    expect(screen.getByLabelText("Option 1 date")).toBeTruthy();
    fireEvent.click(screen.getByText("A time range"));
    expect(screen.getByLabelText("Option 1 start time")).toBeTruthy();
    expect(screen.getByLabelText("Option 1 end time")).toBeTruthy();
  });
});

describe("both entry points", () => {
  // BookingClient renders this component from two distinct places:
  //   STANDING - the header join, and the paused-shop page. No service.
  //   SLOT     - a fully-booked day, carrying serviceId/staffId/serviceLabel.
  // They share one component, so the risk is not that one lacks the fields but
  // that a prop shape changes what renders. Both are asserted directly.
  const base = { slug: "cuts", shopName: "Cuts", accent: "#c9a24a" };

  it("STANDING: windows and consent are offered", () => {
    render(<WaitlistForm {...base} />);
    expect(screen.getByRole("group", { name: "Dates for option 1" })).toBeTruthy();
    expect(screen.getByText("Any date")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("SLOT: the same windows and consent, plus what they are waiting for", () => {
    // The old form deliberately HID the preference input on a slot join. It is
    // shown now: the service is already chosen, so the open question is which
    // day - which makes windows more relevant here, not less.
    render(
      <WaitlistForm
        {...base}
        serviceId="svc_1"
        staffId="stf_1"
        serviceLabel="Mens Haircut with Drick"
      />,
    );
    expect(screen.getByText(/Mens Haircut with Drick/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Dates for option 1" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("🔴 phone-only is told the truth: automatic offers travel by EMAIL", async () => {
    // Customer SMS is off until carrier approval, so a phone-only joiner is
    // on the manual path - the form says so BEFORE they join, and the
    // confirmation repeats it after.
    render(<WaitlistForm {...base} />);
    expect(screen.queryByText(/reach out personally/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    expect(screen.getByText(/automatic offers .* go out by/i)).toBeTruthy();
    // Adding an email clears the warning - they're on the automatic path now.
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "w@test.local" },
    });
    expect(screen.queryByText(/reach out personally instead/i)).toBeNull();
  });

  it("a phone-only confirmation says the shop reaches out personally", async () => {
    render(<WaitlistForm {...base} />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Wanda" } });
    fireEvent.change(screen.getByLabelText("Mobile number"), {
      target: { value: "3025550100" },
    });
    fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/reach out personally when\s+something opens/i)).toBeTruthy();
    expect(screen.queryByText(/take yourself back off the list/i)).toBeNull();
  });

  it("both land on a confirmation screen that mentions the cancel link", async () => {
    render(<WaitlistForm {...base} />);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Wanda" } });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "w@test.local" },
    });
    fireEvent.click(screen.getByText("Join the waitlist", { selector: "button" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/on the waitlist/i)).toBeTruthy();
    // The cancel link only exists if we emailed them.
    expect(screen.getByText(/take yourself back off the list/i)).toBeTruthy();
  });
});
