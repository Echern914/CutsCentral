import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * REACHING THE CLIENT FROM AN APPOINTMENT — the Acuity-parity bug.
 *
 * A barber opens a booking, taps Contact, taps Text, and iPhone Messages comes
 * up with the client in the To field. In Acuity that is instant. In ChairBack
 * it did nothing, and there were THREE independent reasons, each of which this
 * file pins:
 *
 *  1. Text was DISABLED unless SMS consent was on file. Every Acuity-synced
 *     client starts with none, so for a migrating shop the row was inert for
 *     the entire book. `sms:` sends nothing — it opens the barber's own
 *     Messages app — so MISSING consent no longer gates it.
 *
 *     🔴 AN EXPLICIT OPT-OUT STILL DOES. "Nobody asked" and "they texted
 *     STOP" are different facts, and only the second is a person's decision
 *     to respect. Both halves of that are asserted below, and Call is
 *     asserted to survive an opt-out, because withdrawing consent to be
 *     TEXTED is not withdrawing a phone number.
 *
 *  2. The menu closed on BLUR whenever `relatedTarget` was null. On iOS a tap
 *     does not focus a link but does blur whatever was focused — so tapping
 *     any row other than the auto-focused first one unmounted the menu, and
 *     the anchor, before Safari could follow the href. Call (the focused row)
 *     worked; Text and Email did not. That asymmetry is the tell, and it is
 *     asserted here.
 *
 *  3. The click handler itself closed the menu in the same tick. React flushes
 *     that synchronously, so the anchor left the document mid-dispatch, and a
 *     disconnected anchor does not navigate.
 *
 * 🔴 (2) AND (3) ARE ONLY VISIBLE AS "IS THE ANCHOR STILL IN THE DOCUMENT WHEN
 * THE BROWSER WOULD ACT ON IT". jsdom will not navigate for us, so that is
 * exactly what these tests measure, from a document-level listener that runs
 * after React's own handler.
 */

const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "external",
    originLabel: "Acuity",
    status: "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Marcus Reed",
    serviceName: "Fade",
    staffName: "Dee",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:30:00.000Z",
    durationMin: 30,
    timezone: "America/New_York",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: {
      phone: "+18455551212",
      phoneDisplay: "(845) 555-1212",
      email: "marcus@example.com",
    },
    // The Acuity default: nobody ever captured an opt-in.
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: { state: "unpaid" },
    checkedOutAt: null,
    // Acuity owns this booking, so the sheet renders read-only - which is
    // exactly the case the bug was reported from.
    editable: false,
    readOnlyReason: "external",
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

const toast = vi.fn();

/** Open the sheet and its Contact menu, and hand back the menu. */
async function openContactMenu(detail = detailFor()) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(
    <AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={vi.fn()} />,
  );
  const contact = await screen.findByRole("button", { name: /contact/i });
  fireEvent.click(contact);
  return await screen.findByRole("menu", { name: /reach your client/i });
}

beforeEach(() => {
  toast.mockClear();
  getDetail.mockReset();
});

describe("the Contact menu offers only handoffs that work", () => {
  it("TEXTS A CLIENT WHO NEVER OPTED IN — consent is not this gate", async () => {
    // 🔴 The whole bug. `sms:` opens the BARBER's Messages app; ChairBack
    // sends nothing, so TCPA consent has no part in whether the row is live.
    const menu = await openContactMenu(detailFor());
    const text = within(menu).getByRole("menuitem", { name: /^text$/i });
    expect(text.tagName).toBe("A");
    expect(text).toHaveAttribute("href", "sms:+18455551212");
    expect(text).not.toHaveAttribute("aria-disabled");
  });

  it("builds tel: and mailto: from the record", async () => {
    const menu = await openContactMenu();
    expect(within(menu).getByRole("menuitem", { name: /^call$/i })).toHaveAttribute(
      "href",
      "tel:+18455551212",
    );
    expect(within(menu).getByRole("menuitem", { name: /^email$/i })).toHaveAttribute(
      "href",
      "mailto:marcus@example.com",
    );
  });

  it("REFUSES TEXT when the client opted out, and says whose call it is", async () => {
    // 🔴 They texted STOP. Not a note on a live row — no row to tap at all,
    // and no href anywhere near it.
    const menu = await openContactMenu(
      detailFor({ sms: { state: "opted_out", consentAt: null } }),
    );
    const text = within(menu).getByRole("menuitem", { name: /text/i });
    expect(text).not.toHaveAttribute("href");
    expect(text.tagName).not.toBe("A");
    expect(text).toHaveAttribute("aria-disabled");
    // Still VISIBLE, and explicit that the barber cannot undo it.
    expect(text).toHaveTextContent(/texted STOP/i);
    expect(text).toHaveTextContent(/only they can undo it/i);
  });

  it("keeps Call and Copy phone live for a client who opted out", async () => {
    // An opt-out withdraws consent to be TEXTED. It is not a withdrawn number,
    // and a barber may still need to ring them about today's chair.
    const menu = await openContactMenu(
      detailFor({ sms: { state: "opted_out", consentAt: null } }),
    );
    expect(within(menu).getByRole("menuitem", { name: /^call$/i })).toHaveAttribute(
      "href",
      "tel:+18455551212",
    );
    expect(within(menu).getByRole("menuitem", { name: /copy phone number/i })).toBeTruthy();
  });

  it("hides Call and Text when there is no dialable number", async () => {
    const menu = await openContactMenu(
      detailFor({
        contact: { phone: null, phoneDisplay: null, email: "marcus@example.com" },
      }),
    );
    expect(within(menu).queryByRole("menuitem", { name: /^call$/i })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /^text$/i })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /copy phone/i })).toBeNull();
    // Email is unaffected by a missing phone.
    expect(within(menu).getByRole("menuitem", { name: /^email$/i })).toBeTruthy();
  });

  it("hides Email and Copy email when the address is not usable", async () => {
    const menu = await openContactMenu(
      detailFor({
        contact: {
          phone: "+18455551212",
          phoneDisplay: "(845) 555-1212",
          email: "nobody@",
        },
      }),
    );
    expect(within(menu).queryByRole("menuitem", { name: /^email$/i })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /copy email/i })).toBeNull();
    // 🔴 And nothing is left that LOOKS usable and isn't.
    for (const item of within(menu).getAllByRole("menuitem")) {
      if (item.tagName === "A") {
        expect(item.getAttribute("href")).toMatch(/^(sms|tel|mailto):/);
      }
    }
  });
});

describe("the tap reaches the operating system", () => {
  /**
   * React attaches its listeners at the root container, so a listener added to
   * `document` in the bubble phase runs AFTER React's onClick — the closest
   * stand-in for "the browser is about to follow this href".
   */
  function watchConnectedness() {
    const seen: { connected: boolean; defaultPrevented: boolean }[] = [];
    const onClick = (e: Event) => {
      const a = e.target as HTMLElement;
      seen.push({ connected: a.isConnected, defaultPrevented: e.defaultPrevented });
    };
    document.addEventListener("click", onClick);
    return { seen, stop: () => document.removeEventListener("click", onClick) };
  }

  it("lets the tap through — nothing cancels the navigation", async () => {
    const menu = await openContactMenu();
    const text = within(menu).getByRole("menuitem", { name: /^text$/i });
    const watch = watchConnectedness();
    fireEvent.click(text);
    watch.stop();
    expect(watch.seen).toHaveLength(1);
    expect(watch.seen[0]!.connected).toBe(true);
    // Nothing between the tap and the OS: no preventDefault, no interception.
    expect(watch.seen[0]!.defaultPrevented).toBe(false);
  });

  it("DOES NOT UNMOUNT THE ANCHOR INSIDE THE TAP'S OWN TASK", async () => {
    // Defect (3). In a real browser React 18 flushes a discrete event's state
    // update synchronously, so closing the menu from onClick pulls this <a>
    // out of the document while the click is still being dispatched — and a
    // disconnected anchor never follows its href.
    //
    // 🔴 jsdom CANNOT REPRODUCE THAT FAILURE, and an earlier version of this
    // test pretended otherwise: Testing Library wraps fireEvent in act(), which
    // batches the update to AFTER the dispatch whether the code defers or not,
    // so asserting "the anchor was still connected" passed with the fix
    // removed. What IS measurable is the invariant that makes the browser case
    // impossible — the close must not land in the tap's own task. Fake timers
    // hold the deferred close, so the menu has to still be standing.
    const menu = await openContactMenu();
    const text = within(menu).getByRole("menuitem", { name: /^text$/i });
    vi.useFakeTimers();
    try {
      fireEvent.click(text);
      expect(text.isConnected).toBe(true);
      expect(screen.getByRole("menu", { name: /reach your client/i })).toBeTruthy();
      // ...and once the task boundary is crossed, it closes on its own.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole("menu", { name: /reach your client/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the menu once the handoff has been made", async () => {
    const menu = await openContactMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^text$/i }));
    // A later task, not this one — and the barber still sees it close at once.
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: /reach your client/i })).toBeNull(),
    );
    // Returning to the app must find the appointment, not a blank sheet.
    expect(screen.getByText("Marcus Reed")).toBeTruthy();
  });

  it("DOES NOT CLOSE when a row blurs to nowhere — the iOS tap", async () => {
    const menu = await openContactMenu();
    const call = within(menu).getByRole("menuitem", { name: /^call$/i });
    const text = within(menu).getByRole("menuitem", { name: /^text$/i });
    // Exactly what iOS does when the barber taps Text: the auto-focused first
    // row loses focus and nothing takes it. Defect (2) closed the menu here,
    // so the tap that followed landed on a node that no longer existed.
    fireEvent.blur(call, { relatedTarget: null });
    expect(screen.getByRole("menu", { name: /reach your client/i })).toBeTruthy();
    expect(text.isConnected).toBe(true);
  });

  it("still closes when focus really does leave the menu", async () => {
    const menu = await openContactMenu();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.blur(within(menu).getByRole("menuitem", { name: /^call$/i }), {
      relatedTarget: outside,
    });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: /reach your client/i })).toBeNull(),
    );
    outside.remove();
  });

  it("launches ONCE however fast the barber taps twice", async () => {
    const menu = await openContactMenu();
    const text = within(menu).getByRole("menuitem", { name: /^text$/i });
    const watch = watchConnectedness();
    // Two taps inside one task, before the deferred close can run.
    fireEvent.click(text);
    fireEvent.click(text);
    watch.stop();
    expect(watch.seen).toHaveLength(2);
    expect(watch.seen[0]!.defaultPrevented).toBe(false);
    // The second is refused, so the OS is handed exactly one draft.
    expect(watch.seen[1]!.defaultPrevented).toBe(true);
  });
});

describe("copying a contact detail", () => {
  it("copies the number a human reads, and says so without naming it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const menu = await openContactMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /copy phone number/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("(845) 555-1212"));
    expect(toast).toHaveBeenCalledWith("Phone number copied", "success");
    // 🔴 The toast must not carry the value.
    for (const [msg] of toast.mock.calls) expect(msg).not.toContain("845");
    vi.unstubAllGlobals();
  });

  it("copies the email and confirms", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const menu = await openContactMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /copy email/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("marcus@example.com"));
    expect(toast).toHaveBeenCalledWith("Email copied", "success");
    vi.unstubAllGlobals();
  });

  it("tells the barber what to do instead when the clipboard is refused", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    // jsdom has no execCommand either, so BOTH ways are gone.
    const menu = await openContactMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /copy phone number/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/press and hold/i), "error"),
    );
    vi.unstubAllGlobals();
  });
});
