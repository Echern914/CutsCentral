import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SavedByCard, type SavedByPerson } from "./SavedByCard";

const person = (name: string, i: number): SavedByPerson => ({
  name,
  savedAt: new Date(Date.UTC(2026, 8, 1 + i, 15)).toISOString(),
});

/**
 * The barber's "saved your shop" card: names and dates, the latest few up
 * front, and nothing at all until somebody has saved the shop.
 */
describe("SavedByCard", () => {
  it("renders nothing until somebody has saved the shop", () => {
    const { container } = render(<SavedByCard total={0} people={[]} />);
    expect(container.textContent).toBe("");
  });

  it("names who saved it, and counts them", () => {
    render(<SavedByCard total={2} people={[person("Pat Saver", 0), person("Lee Rowe", 1)]} />);
    expect(screen.getByText("2 people saved your shop")).toBeTruthy();
    expect(screen.getByText("Pat Saver")).toBeTruthy();
    expect(screen.getByText("Lee Rowe")).toBeTruthy();
  });

  it("folds everyone past the first five behind 'Show more'", () => {
    const people = Array.from({ length: 7 }, (_, i) => person(`Person ${i + 1}`, i));
    render(<SavedByCard total={7} people={people} />);
    expect(screen.getByText("Show 2 more")).toBeTruthy();
  });

  it("says when the list is only the latest of many", () => {
    const people = Array.from({ length: 3 }, (_, i) => person(`Person ${i + 1}`, i));
    render(<SavedByCard total={140} people={people} />);
    expect(screen.getByText("140 people saved your shop")).toBeTruthy();
    expect(screen.getByText("Showing the latest 3.")).toBeTruthy();
  });
});
