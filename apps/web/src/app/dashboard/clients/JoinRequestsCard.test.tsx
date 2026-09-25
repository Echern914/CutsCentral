import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JoinRequestsCard, type JoinRequest } from "./JoinRequestsCard";

const answer = vi.fn();
vi.mock("./joinRequestActions", () => ({
  answerJoinRequestAction: (...args: unknown[]) => answer(...args),
}));

const req = (id: string, name: string): JoinRequest => ({
  id,
  name,
  phone: "+16265550142",
  email: `${id}@example.com`,
  requestedAt: new Date(Date.UTC(2026, 8, 24, 15)).toISOString(),
});

/**
 * Join requests from the customer app: who is asking, and Accept / Decline.
 * A row leaves only when the server said yes.
 */
describe("JoinRequestsCard", () => {
  beforeEach(() => answer.mockReset());

  it("renders nothing without a request", () => {
    const { container } = render(<JoinRequestsCard requests={[]} />);
    expect(container.textContent).toBe("");
  });

  it("shows who is asking, with the contacts they agreed to share", () => {
    render(<JoinRequestsCard requests={[req("a", "Pat Joiner"), req("b", "Lee Rowe")]} />);
    expect(screen.getByText("2 people want to join")).toBeTruthy();
    expect(screen.getByText("Pat Joiner")).toBeTruthy();
    expect(screen.getByText(/\+16265550142 · a@example\.com/)).toBeTruthy();
  });

  it("shows the Instagram handle a first-name-only asker gave, linked", () => {
    render(<JoinRequestsCard requests={[{ ...req("a", "Mike"), instagram: "mike.fades" }, req("b", "Mike")]} />);
    const link = screen.getByRole("link", { name: "@mike.fades" });
    expect(link.getAttribute("href")).toBe("https://instagram.com/mike.fades");
  });

  it("accepting removes the row once the server confirms", async () => {
    answer.mockResolvedValue({ ok: true });
    render(<JoinRequestsCard requests={[req("a", "Pat Joiner"), req("b", "Lee Rowe")]} />);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    });
    await waitFor(() => expect(screen.queryByText("Pat Joiner")).toBeNull());
    expect(answer).toHaveBeenCalledWith("a", "accept");
    expect(screen.getByText("1 person wants to join")).toBeTruthy();
  });

  it("a failed answer keeps the row and says so", async () => {
    answer.mockResolvedValue({ ok: false, error: "Couldn't save that. Try again." });
    render(<JoinRequestsCard requests={[req("a", "Pat Joiner")]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't save that"));
    expect(screen.getByText("Pat Joiner")).toBeTruthy();
    expect(answer).toHaveBeenCalledWith("a", "decline");
  });
});
