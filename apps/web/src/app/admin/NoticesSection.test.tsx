import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * SERVICE NOTICES on the admin page: what is posted here shows on EVERY
 * barber's dashboard, and "notify phones" buzzes every shop owner. So:
 *  - posting sends exactly what was typed, with times as instants;
 *  - the page says plainly whether phones were notified (DRY_RUN says no);
 *  - delete asks first.
 */

const create = vi.fn();
const update = vi.fn();
const resolve = vi.fn();
const remove = vi.fn();
vi.mock("./actions", () => ({
  createPlatformNoticeAction: (...a: unknown[]) => create(...a),
  updatePlatformNoticeAction: (...a: unknown[]) => update(...a),
  resolvePlatformNoticeAction: (...a: unknown[]) => resolve(...a),
  deletePlatformNoticeAction: (...a: unknown[]) => remove(...a),
}));

const { NoticesSection } = await import("./NoticesSection");

const live = {
  id: "n1",
  title: "Texts are delayed",
  body: "We're on it",
  severity: "issue" as const,
  state: "active" as const,
  startsAt: "2026-10-27T14:00:00.000Z",
  endsAt: null,
  resolvedAt: null,
  pushedAt: "2026-10-27T14:00:01.000Z",
  createdAt: "2026-10-27T14:00:00.000Z",
  updatedAt: "2026-10-27T14:00:00.000Z",
};

const q = (qa: string) => document.querySelector<HTMLInputElement>(`[data-qa="${qa}"]`)!;

afterEach(() => {
  cleanup();
  for (const f of [create, update, resolve, remove]) f.mockReset();
});

describe("service notices (admin)", () => {
  it("🔴 posts what was typed and says when phones were NOT notified (DRY_RUN)", async () => {
    create.mockResolvedValue({ ok: true, push: "dry_run" });
    render(<NoticesSection notices={[]} />);
    fireEvent.change(q("notice-title"), { target: { value: "  Payments are down " } });
    fireEvent.change(q("notice-body"), { target: { value: "Card payments fail. Cash works." } });
    fireEvent.change(q("notice-severity"), { target: { value: "maintenance" } });
    fireEvent.click(q("notice-notify"));
    fireEvent.click(q("notice-submit"));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      title: "Payments are down",
      body: "Card payments fail. Cash works.",
      severity: "maintenance",
      endsAt: null,
      notifyPhones: true,
    });
    await waitFor(() => expect(q("notice-outcome").textContent).toMatch(/NOT notified.*DRY_RUN/));
  });

  it("a refused window is explained, and the draft stays", async () => {
    create.mockResolvedValue({ ok: false, error: "invalid_window" });
    render(<NoticesSection notices={[]} />);
    fireEvent.change(q("notice-title"), { target: { value: "Planned work" } });
    fireEvent.change(q("notice-body"), { target: { value: "Tonight" } });
    fireEvent.click(q("notice-submit"));
    await waitFor(() => expect(q("notice-outcome").textContent).toMatch(/end has to be after the start/));
    expect(q("notice-title").value).toBe("Planned work");
  });

  it("editing one that already pushed cannot push again", () => {
    render(<NoticesSection notices={[live]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(q("notice-title").value).toBe("Texts are delayed");
    expect(q("notice-notify").disabled).toBe(true);
    expect(screen.getByText(/already notified/)).toBeTruthy();
  });

  it("marks one resolved", async () => {
    resolve.mockResolvedValue({ ok: true });
    render(<NoticesSection notices={[live]} />);
    fireEvent.click(q("notice-resolve"));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("n1"));
  });

  it("🔴 delete asks first", async () => {
    remove.mockResolvedValue({ ok: true });
    render(<NoticesSection notices={[live]} />);
    fireEvent.click(q("notice-delete"));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(q("notice-delete-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("n1"));
  });
});
