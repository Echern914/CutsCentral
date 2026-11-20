import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { nameList } from "@/lib/nameList";

/**
 * People who take appointments and have no hours yet.
 *
 * Accepting an invitation makes that person bookable-by-name with an empty
 * week. That must NOT put an established shop back into setup mode (the shop is
 * open; one person isn't), so it is a notice that names who is missing and goes
 * to where hours are set - and nothing at all when everyone has hours, which is
 * every one-person shop that finished setup.
 */
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { HoursMissingNotice } = await import("./HoursMissingNotice");

describe("the no-hours notice", () => {
  it("🔴 everyone has hours: renders nothing", () => {
    const { container } = render(<HoursMissingNotice names={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("🔴 names who is missing, says everyone else is open, and links to where hours are set", () => {
    render(<HoursMissingNotice names={["Dee"]} />);
    const notice = screen.getByTestId("hours-missing");
    expect(notice.textContent).toMatch(/Dee has no hours yet/);
    expect(notice.textContent).toMatch(/Everyone else is open as usual/);
    expect(screen.getByRole("link", { name: "Set hours" }).getAttribute("href")).toBe("/dashboard/booking?tab=Staff");
  });

  it("several people read as a sentence, and a long list is counted", () => {
    const { rerender } = render(<HoursMissingNotice names={["Dee", "Kai"]} />);
    expect(screen.getByTestId("hours-missing").textContent).toMatch(/Dee and Kai have no hours yet/);
    rerender(<HoursMissingNotice names={["Dee", "Kai", "Lee", "Sam", "Rae"]} />);
    expect(screen.getByTestId("hours-missing").textContent).toMatch(/Dee, Kai and 3 more have no hours yet/);
  });
});

describe("nameList", () => {
  it("reads the way a person says it", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["Sam"])).toBe("Sam");
    expect(nameList(["Sam", "Lee"])).toBe("Sam and Lee");
    expect(nameList(["Sam", "Lee", "Kai"])).toBe("Sam, Lee and Kai");
    expect(nameList(["Sam", "Lee", "Kai", "Dee", "Rae", "Jo"])).toBe("Sam, Lee and 4 more");
    expect(nameList([" Sam ", "", "Lee"])).toBe("Sam and Lee");
  });
});
