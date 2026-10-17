import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemberSetup } from "./MemberSetup";

/** A member's setup on the owner's Team page: yes/no per step, or "hidden". */
describe("a member's setup progress", () => {
  it("🔴 says how far they are, step by step, counting only the required steps", () => {
    render(
      <MemberSetup
        setup={{
          complete: false,
          steps: [
            { id: "booking", done: true },
            { id: "team", done: true },
            { id: "services", done: false },
            { id: "hours", done: false },
            { id: "clients", done: false },
          ],
        }}
      />,
    );
    expect(screen.getByText("Setting up · 2 of 4 done")).toBeTruthy();
    expect(screen.getByText("Services").closest("li")!.textContent).toContain("(not yet)");
    expect(screen.getByText("Booking method").closest("li")!.textContent).toContain("(done)");
  });

  it("says when clients can book them", () => {
    render(<MemberSetup setup={{ complete: true, steps: [{ id: "booking", done: true }, { id: "clients", done: false }] }} />);
    expect(screen.getByText(/Set up - clients can book them/)).toBeTruthy();
  });

  it("says it's hidden when the member hid it, and nothing for an older API", () => {
    const { container, rerender } = render(<MemberSetup setup={null} />);
    expect(container.textContent).toBe("Setup progress: hidden");
    rerender(<MemberSetup setup={undefined} />);
    expect(container.textContent).toBe("");
  });
});
