import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vocabularyFor } from "@chairback/config/businessTypes";

/**
 * Mentorship from a member's side. What must hold:
 *  - as a student: every switch starts Hidden, reads "Saving…" until the
 *    server answers, and the preview is the mentor's own view;
 *  - as a mentor: read-only - only what the student shares, "Hidden" otherwise;
 *  - either side can end it, and it disappears only once the server agreed.
 */
const setMentorSharingAction = vi.fn();
const endMentorshipAction = vi.fn();
const toast = vi.fn();
vi.mock("./actions", () => ({
  setMentorSharingAction: (...a: unknown[]) => setMentorSharingAction(...a),
  endMentorshipAction: (...a: unknown[]) => endMentorshipAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { MentorshipSection } = await import("./MentorshipSection");
const vocab = vocabularyFor("barber");
const NONE = { shareCuts: false, shareRevenue: false, shareClients: false, shareRating: false };
const NOTHING = { cuts: null, revenueCents: null, clients: null, rating: null, previous: { cuts: null, revenueCents: null, clients: null } };
const tiles = (qa: string, root: ParentNode = document) =>
  [...root.querySelectorAll(`[data-qa="${qa}"] > div`)].map((d) => d.textContent);

beforeEach(() => {
  setMentorSharingAction.mockReset();
  endMentorshipAction.mockReset();
  toast.mockReset();
});

describe("as a student", () => {
  const mentors = [{ id: "ms1", mentor: { name: "Will Fades" }, since: "2026-10-15T00:00:00Z", sharing: NONE, theySee: NOTHING }];

  it("🔴 starts with everything hidden, and the preview is the mentor's own view", () => {
    render(<MentorshipSection mentors={mentors} mentoring={[]} vocab={vocab} />);
    for (const key of ["shareCuts", "shareRevenue", "shareClients", "shareRating"]) {
      const sw = document.querySelector(`[data-qa="mentor-share-${key}"]`)!;
      expect(sw.textContent).toBe("Hidden");
      expect(sw.getAttribute("aria-checked")).toBe("false");
    }
    expect(screen.getByText("How you look to Will Fades")).toBeTruthy();
    expect(tiles("mentor-sees")).toEqual(["CutsHidden", "RevenueHidden", "ClientsHidden", "RatingHidden"]);
  });

  it("🔴 a switch reads Saving… until the server answers, then shows the server's answer", async () => {
    let resolve!: (v: unknown) => void;
    setMentorSharingAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<MentorshipSection mentors={mentors} mentoring={[]} vocab={vocab} />);
    const sw = () => document.querySelector('[data-qa="mentor-share-shareCuts"]')!;
    fireEvent.click(sw());
    expect(setMentorSharingAction).toHaveBeenCalledWith("ms1", { shareCuts: true });
    expect(sw().textContent).toBe("Saving…");
    resolve({
      ok: true,
      sharing: { ...NONE, shareCuts: true },
      theySee: { ...NOTHING, cuts: 3, previous: { cuts: 1, revenueCents: null, clients: null } },
    });
    await waitFor(() => expect(sw().textContent).toBe("Shared"));
    expect(tiles("mentor-sees")).toEqual(["Cuts3↑ 200%", "RevenueHidden", "ClientsHidden", "RatingHidden"]);
  });

  it("a failed save changes nothing and says so", async () => {
    setMentorSharingAction.mockResolvedValue({ ok: false, error: "network" });
    render(<MentorshipSection mentors={mentors} mentoring={[]} vocab={vocab} />);
    fireEvent.click(document.querySelector('[data-qa="mentor-share-shareRevenue"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that - nothing changed", "error"));
    expect(document.querySelector('[data-qa="mentor-share-shareRevenue"]')!.textContent).toBe("Hidden");
  });
});

describe("as a mentor", () => {
  const mentoring = [
    {
      id: "ms2",
      student: { name: "Chris Clipz" },
      since: "2026-10-15T00:00:00Z",
      numbers: { ...NOTHING, cuts: 4, previous: { cuts: 2, revenueCents: null, clients: null } },
    },
  ];

  it("🔴 read-only: only what the student shares, Hidden otherwise, and no switches", () => {
    render(<MentorshipSection mentors={[]} mentoring={mentoring} vocab={vocab} />);
    const card = document.querySelector('[data-qa="my-student"]') as HTMLElement;
    expect(card.textContent).toContain("You mentor");
    expect(card.textContent).toContain("Chris Clipz");
    expect([...card.querySelectorAll("dl > div")].map((d) => d.textContent)).toEqual([
      "Cuts4↑ 100%",
      "RevenueHidden",
      "ClientsHidden",
      "RatingHidden",
    ]);
    expect(within(card).queryAllByRole("switch")).toEqual([]);
  });

  it("ending it removes the card once the server agrees", async () => {
    endMentorshipAction.mockResolvedValue({ ok: true });
    render(<MentorshipSection mentors={[]} mentoring={mentoring} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(endMentorshipAction).toHaveBeenCalledWith("ms2");
    await waitFor(() => expect(document.querySelector('[data-qa="my-student"]')).toBeNull());
    expect(toast).toHaveBeenCalledWith("Mentorship with Chris Clipz ended", "success");
  });

  it("a failed end keeps the card", async () => {
    endMentorshipAction.mockResolvedValue({ ok: false, error: "network" });
    render(<MentorshipSection mentors={[]} mentoring={mentoring} vocab={vocab} />);
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't end it - try again", "error"));
    expect(document.querySelector('[data-qa="my-student"]')).not.toBeNull();
  });
});

it("renders nothing when there is no mentorship", () => {
  const { container } = render(<MentorshipSection mentors={[]} mentoring={[]} vocab={vocab} />);
  expect(container.textContent).toBe("");
});
