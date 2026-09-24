import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewForm } from "./ReviewForm";
import { submitReviewAction } from "./actions";

vi.mock("./actions", () => ({
  submitReviewAction: vi.fn(async () => ({ ok: true })),
}));

/**
 * A REVIEW NEEDS A NAME.
 *
 * Drick: "make people's name / nickname mandatory." The API refuses a review
 * without one (reviews.test.ts); this is the form saying so first, in words,
 * instead of a customer tapping Submit and getting "Something went wrong".
 * Text stays optional - but a star-only review is never shown as a card, so
 * its confirmation must not promise one.
 */

const theme = {
  surface: "#141414",
  border: "#333333",
  muted: "#999999",
  scheme: "dark" as const,
  radius: "1rem",
  buttonRadius: "9999px",
};
const props = { slug: "fresh", shopName: "Fresh Studio", accent: "#c9a24a", theme };
const mockSubmit = vi.mocked(submitReviewAction);

const nameField = () => screen.getByLabelText("Your name or nickname");
const stars = (n: number) =>
  fireEvent.click(screen.getByRole("radio", { name: `${n} star${n === 1 ? "" : "s"}` }));
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

beforeEach(() => mockSubmit.mockClear());

describe("the name is required", () => {
  it("🔴 blocks a review with no name, and says what to do", () => {
    render(<ReviewForm {...props} />);
    stars(5);
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Add your name or a nickname.");
    expect(mockSubmit).not.toHaveBeenCalled();
    // Pointed at the field that needs it.
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(nameField()).toHaveAttribute("aria-describedby", "review-error");
  });

  it("🔴 spaces are not a name", () => {
    render(<ReviewForm {...props} />);
    stars(4);
    fireEvent.change(nameField(), { target: { value: "    " } });
    fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "Great" } });
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Add your name or a nickname.");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("asks for a name or a nickname - and no longer calls it optional", () => {
    render(<ReviewForm {...props} />);
    expect(nameField()).toHaveAttribute("placeholder", "Your name or nickname");
    expect(nameField()).toHaveAttribute("aria-required", "true");
    expect(screen.queryByPlaceholderText(/name \(optional\)/i)).toBeNull();
  });

  it("still asks for the stars first", () => {
    render(<ReviewForm {...props} />);
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Please tap a star rating.");
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe("what it sends", () => {
  it("the trimmed name, and text only when there is some", async () => {
    render(<ReviewForm {...props} />);
    stars(4);
    fireEvent.change(nameField(), { target: { value: "  Dre  " } });
    submit();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith("fresh", { rating: 4, authorName: "Dre" });
    expect(mockSubmit.mock.calls[0]![1].body).toBeUndefined();
  });

  it("text and name together", async () => {
    render(<ReviewForm {...props} />);
    stars(5);
    fireEvent.change(screen.getByLabelText("Your review"), { target: { value: " So good. " } });
    fireEvent.change(nameField(), { target: { value: "Marcus" } });
    submit();
    await screen.findByRole("status");
    expect(mockSubmit).toHaveBeenCalledWith("fresh", {
      rating: 5,
      body: "So good.",
      authorName: "Marcus",
    });
  });
});

describe("the thank-you promises only what will happen", () => {
  it("with words: it will appear on the page once approved", async () => {
    render(<ReviewForm {...props} />);
    stars(5);
    fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "So good" } });
    fireEvent.change(nameField(), { target: { value: "Marcus" } });
    submit();
    expect(await screen.findByRole("status")).toHaveTextContent("Once approved it appears here.");
  });

  it("🔴 stars only: it counts toward the rating, and is not promised as a card", async () => {
    render(<ReviewForm {...props} />);
    stars(3);
    fireEvent.change(nameField(), { target: { value: "Robin" } });
    submit();
    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("your stars count toward the rating shown here");
    expect(done).not.toHaveTextContent("appears here");
  });
});
