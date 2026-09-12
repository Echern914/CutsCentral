import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DuplicateReview, type DuplicateGroupView } from "./DuplicateReview";
import { dismissDuplicatesAction, mergeClientAction } from "../../actions";

vi.mock("../../actions", () => ({
  mergeClientAction: vi.fn(async () => ({ ok: true })),
  dismissDuplicatesAction: vi.fn(async () => ({ ok: true })),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * The duplicates review as a barber uses it: the suggested record is kept by
 * default, nothing merges without a confirm, the keeper can be changed, a record
 * can be left out, and "not the same person" dismisses the whole group.
 */
const pair: DuplicateGroupView = {
  key: "a,b",
  matchedOn: ["phone"],
  clients: [
    {
      id: "a",
      name: "Marcus Hill",
      phone: "+15555550100",
      email: null,
      completedVisits: 6,
      lastVisitAt: "2026-08-20T15:00:00.000Z",
      createdAt: "2025-01-10T15:00:00.000Z",
    },
    {
      id: "b",
      name: "Marc Hill",
      phone: "+15555550100",
      email: "marc@example.com",
      completedVisits: 0,
      lastVisitAt: null,
      createdAt: "2026-08-01T15:00:00.000Z",
    },
  ],
};

const trio: DuplicateGroupView = {
  key: "c,d,e",
  matchedOn: ["phone", "email"],
  clients: [
    { id: "c", name: "Dana", phone: "+15555550111", email: null, completedVisits: 3, lastVisitAt: null, createdAt: "2025-01-01T00:00:00.000Z" },
    { id: "d", name: "Dana R", phone: "+15555550111", email: "d@example.com", completedVisits: 1, lastVisitAt: null, createdAt: "2025-02-01T00:00:00.000Z" },
    { id: "e", name: "Danny", phone: null, email: "d@example.com", completedVisits: 0, lastVisitAt: null, createdAt: "2025-03-01T00:00:00.000Z" },
  ],
};

beforeEach(() => {
  vi.mocked(mergeClientAction).mockClear();
  vi.mocked(dismissDuplicatesAction).mockClear();
  refresh.mockClear();
  toast.mockClear();
});

describe("DuplicateReview", () => {
  it("says so plainly when there is nothing to review", () => {
    render(<DuplicateReview groups={[]} />);
    expect(screen.getByText(/No possible duplicates/)).toBeTruthy();
  });

  it("keeps the suggested record and merges only after a confirm", async () => {
    render(<DuplicateReview groups={[pair]} />);
    expect(screen.getByText("Same phone number")).toBeTruthy();
    expect((screen.getByLabelText("Keep Marcus Hill") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Merge into Marcus Hill" }));
    expect(mergeClientAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Their visits, appointments and punches move to Marcus Hill/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Yes, merge" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mergeClientAction).toHaveBeenCalledWith("a", "b", "Duplicates review: same phone number");
    expect(toast).toHaveBeenCalledWith("Merged Marc Hill into Marcus Hill", "success");
  });

  it("merges the other way when the barber picks the other record to keep", async () => {
    render(<DuplicateReview groups={[pair]} />);
    fireEvent.click(screen.getByLabelText("Keep Marc Hill"));
    fireEvent.click(screen.getByRole("button", { name: "Merge into Marc Hill" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge" }));
    await waitFor(() => expect(mergeClientAction).toHaveBeenCalledWith("b", "a", expect.any(String)));
  });

  it("leaves out a record the barber unticks", async () => {
    render(<DuplicateReview groups={[trio]} />);
    expect(screen.getByText("Same phone number and email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge 2 into Dana" })).toBeTruthy();

    const boxes = screen.getAllByRole("checkbox", { name: "Merge" });
    fireEvent.click(boxes[1]!); // Danny stays separate
    fireEvent.click(screen.getByRole("button", { name: "Merge into Dana" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mergeClientAction).toHaveBeenCalledTimes(1);
    expect(mergeClientAction).toHaveBeenCalledWith("c", "d", expect.any(String));
  });

  it("can't merge when every other record is unticked", () => {
    render(<DuplicateReview groups={[pair]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge" }));
    expect((screen.getByRole("button", { name: "Merge into Marcus Hill" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Not the same person' dismisses the group without merging", async () => {
    render(<DuplicateReview groups={[pair]} />);
    fireEvent.click(screen.getByRole("button", { name: "Not the same person" }));
    await waitFor(() => expect(dismissDuplicatesAction).toHaveBeenCalledWith(["a", "b"]));
    expect(mergeClientAction).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("stops at the first failed merge and says how far it got", async () => {
    vi.mocked(mergeClientAction)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "not_found" });
    render(<DuplicateReview groups={[trio]} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge 2 into Dana" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, merge" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Merged 1 of 2. The rest are still here to try again.",
        "error",
      ),
    );
  });
});
