import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * 🔴 A REFUSED APPROVE / HIDE SAYS SO. The result used to be thrown away
 * (`void setReviewStatusAction(...)`), so the pill stayed put with no word and
 * the barber believed the review was live. The request status pills had the
 * same bug and the same fix.
 */

const setReviewStatusAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ setReviewStatusAction }));
const setRequestStatusAction = vi.hoisted(() => vi.fn());
vi.mock("../requests/actions", () => ({ setRequestStatusAction }));

const { ReviewModeration } = await import("./ReviewModeration");
const { StatusControl } = await import("../requests/StatusControl");

describe("status pills", () => {
  it("🔴 a refused approve shows Didn't save", async () => {
    setReviewStatusAction.mockResolvedValue({ ok: false });
    render(<ReviewModeration id="r1" status="PENDING" />);
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn't save");
  });

  it("a dropped connection counts as refused", async () => {
    setReviewStatusAction.mockImplementation(async () => {
      throw new Error("Failed to fetch");
    });
    render(<ReviewModeration id="r1" status="PENDING" />);
    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn't save");
  });

  it("a refused request status shows Didn't save too", async () => {
    setRequestStatusAction.mockResolvedValue({ ok: false });
    render(<StatusControl id="q1" status="NEW" />);
    fireEvent.click(screen.getByRole("button", { name: "contacted" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Didn't save");
  });
});
