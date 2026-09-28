import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClientEmailMarketing } from "./EmailMarketing";

/**
 * A client's marketing-email standing on their page: said yes (when and how),
 * not yet, or unsubscribed - and the shop recording one client's yes, or
 * taking back one it recorded.
 */

const recordEmailYesAction = vi.fn();
const removeEmailYesAction = vi.fn();
vi.mock("../../actions", () => ({
  recordEmailYesAction: (...a: unknown[]) => recordEmailYesAction(...a),
  removeEmailYesAction: (...a: unknown[]) => removeEmailYesAction(...a),
}));

const { EmailMarketing } = await import("./EmailMarketing");

beforeEach(() => {
  recordEmailYesAction.mockReset();
  removeEmailYesAction.mockReset();
});

const TZ = "America/New_York";
const notYet: ClientEmailMarketing = { state: "needs_consent", at: null, source: null };
const yes = (source: string): ClientEmailMarketing => ({
  state: "opted_in",
  at: "2026-09-28T15:00:00.000Z",
  source,
});

const stateLine = () => document.querySelector('[data-qa="email-marketing-state"]')?.textContent;
const recordButton = () => screen.queryByRole("button", { name: "Record their yes" });
const removeButton = () => screen.queryByRole("button", { name: "Remove" });

function show(initial: ClientEmailMarketing | undefined, hasEmail = true) {
  return render(<EmailMarketing clientId="c1" hasEmail={hasEmail} initial={initial} timezone={TZ} />);
}

describe("the three states", () => {
  it("said yes: when, and how", () => {
    show(yes("booking_page"));
    expect(stateLine()).toBe("Said yes on Sep 28, 2026, on your booking page.");
    show(yes("customer_settings"));
    expect(screen.getByText("Said yes on Sep 28, 2026, on their rewards page.")).toBeTruthy();
  });

  it("🔴 a yes the customer gave themselves has no Remove", () => {
    show(yes("customer_settings"));
    expect(removeButton()).toBeNull();
    expect(recordButton()).toBeNull();
  });

  it("a yes the shop recorded says so, and can be removed", () => {
    show(yes("staff:paper_form"));
    expect(stateLine()).toBe("Said yes on Sep 28, 2026, on a paper form, recorded by your shop.");
    expect(removeButton()).toBeTruthy();
  });

  it("not yet, with an email: the shop can record their yes", () => {
    show(notYet);
    expect(stateLine()).toBe("Not yet.");
    expect(recordButton()).toBeTruthy();
  });

  it("not yet, with no email: nothing to record a yes for", () => {
    show(notYet, false);
    expect(stateLine()).toBe("Not yet. Add their email address to record a yes.");
    expect(recordButton()).toBeNull();
  });

  it("🔴 unsubscribed: explained, and nothing on offer - only they can opt back in", () => {
    show({ state: "opted_out", at: "2026-01-01T00:00:00.000Z", source: "booking_page" });
    expect(stateLine()).toBe(
      "Unsubscribed. Only they can turn your emails back on, from the Unsubscribe link at the bottom of one of your emails.",
    );
    expect(recordButton()).toBeNull();
    expect(removeButton()).toBeNull();
  });

  it("an API from before this sends nothing, and nothing is shown", () => {
    const { container } = show(undefined);
    expect(container.textContent).toBe("");
  });
});

describe("recording a yes", () => {
  it("asks how they said yes, sends it, and redraws from the answer", async () => {
    recordEmailYesAction.mockResolvedValue({ ok: true, status: 200, emailMarketing: yes("staff:by_text") });
    show(notYet);
    fireEvent.click(recordButton()!);
    const choices = Array.from(
      document.querySelectorAll('[role="group"][aria-label="How did they say yes?"] button'),
    ).map((b) => b.textContent);
    expect(choices).toEqual(["In person", "By text", "By email", "Paper form"]);
    fireEvent.click(screen.getByRole("button", { name: "By text" }));
    await waitFor(() => expect(recordEmailYesAction).toHaveBeenCalledWith("c1", "by_text"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
    expect(stateLine()).toBe("Said yes on Sep 28, 2026, by text, recorded by your shop.");
  });

  it("a refusal is explained inline and changes nothing", async () => {
    recordEmailYesAction.mockResolvedValue({
      ok: false,
      status: 409,
      error: "unsubscribed",
      message: "They unsubscribed from your emails. Only they can turn them back on, from the Unsubscribe link at the bottom of one of your emails.",
    });
    show(notYet);
    fireEvent.click(recordButton()!);
    fireEvent.click(screen.getByRole("button", { name: "In person" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Only they can turn them back on/),
    );
    expect(stateLine()).toBe("Not yet.");
  });

  it("the shop takes back a yes it recorded", async () => {
    removeEmailYesAction.mockResolvedValue({ ok: true, status: 200, emailMarketing: notYet });
    show(yes("staff:in_person"));
    fireEvent.click(removeButton()!);
    await waitFor(() => expect(removeEmailYesAction).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(stateLine()).toBe("Not yet."));
  });
});
