import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BookedOutBrief } from "@chairback/config/bookedOut";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { AskField } = await import("./AskField");

/**
 * The Assistant's answer to "how do I get booked out more?" when the shop's
 * own numbers loaded: the headline, a card per thing to work on with the
 * number behind it and a button to the screen that fixes it, what is already
 * going well, and what it was read from. Without the numbers, the written
 * advice - never an empty card.
 */
const BRIEF: BookedOutBrief = {
  scope: "shop",
  headline: "The next 2 weeks are 38% booked, with about 62 hours still open.",
  items: [
    {
      id: "overdue_regulars",
      title: "Bring back regulars who are due",
      finding: "12 regular clients are past their usual gap between visits with nothing booked.",
      fix: "A short message with your booking link is the cheapest booking there is.",
      action: { label: "Find overdue clients", featureId: "rebook-nudges" },
    },
    {
      id: "slow_weekday",
      title: "Fill your Tuesdays",
      finding: "Tuesdays run 22% booked, against 84% on Saturdays.",
      fix: "Run a Tuesday special at a set price.",
      action: { label: "Add a special", featureId: "targeted-slots" },
    },
  ],
  strengths: ["70% of clients came back within 6 weeks."],
  basis: "Based on your shop's appointments over the last 8 weeks and the next 2.",
};

function open(bookedOut: BookedOutBrief | null) {
  render(
    <AskField role="OWNER" rewardsEnabled affiliateProgramEnabled={false} bookedOut={bookedOut} />,
  );
}

beforeEach(() => push.mockReset());

describe("How do I get booked out more?", () => {
  it("is the first example under the field", () => {
    open(BRIEF);
    expect(screen.getAllByRole("button")[1]).toHaveTextContent("How do I get booked out more?");
  });

  it("🔴 answers from the shop's numbers: headline, cards with numbers, a button each", () => {
    open(BRIEF);
    fireEvent.click(screen.getByRole("button", { name: "How do I get booked out more?" }));
    expect(screen.getByText(BRIEF.headline)).toBeInTheDocument();
    const list = document.querySelector('[data-qa="booked-out-items"]') as HTMLElement;
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("1. Bring back regulars who are due");
    expect(cards[0]).toHaveTextContent("12 regular clients are past their usual gap");
    expect(cards[1]).toHaveTextContent("Tuesdays run 22% booked, against 84% on Saturdays.");
    fireEvent.click(within(cards[0]!).getByRole("button", { name: /Find overdue clients/ }));
    expect(push).toHaveBeenCalledWith("/dashboard/nudges");
    expect(document.querySelector('[data-qa="booked-out-strengths"]')).toHaveTextContent(
      "Going well: 70% of clients came back within 6 weeks.",
    );
    expect(screen.getByText(BRIEF.basis)).toBeInTheDocument();
  });

  it("answers Drick's own wording typed in", () => {
    open(BRIEF);
    fireEvent.change(screen.getByLabelText("What do you want to do?"), {
      target: { value: "what should i do to get booked out more" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(document.querySelector('[data-qa="booked-out-items"]')).not.toBeNull();
  });

  it("without the numbers: the written advice, no empty cards", () => {
    open(null);
    fireEvent.click(screen.getByRole("button", { name: "How do I get booked out more?" }));
    expect(screen.getByText(/Three things, in the order that actually works/)).toBeInTheDocument();
    expect(document.querySelector('[data-qa="booked-out-items"]')).toBeNull();
  });
});
