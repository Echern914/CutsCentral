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

  it("a saver the app has connected opens their client profile", () => {
    render(<SavedByCard total={1} people={[{ ...person("Jaylon Reyes", 0), clientId: "client_123" }]} />);
    const link = screen.getByRole("link", { name: "Jaylon Reyes" });
    expect(link.getAttribute("href")).toBe("/dashboard/clients/client_123");
    expect(screen.queryByText("Not connected yet")).toBeNull();
  });

  it("anyone else is a plain name, marked 'Not connected yet'", () => {
    render(<SavedByCard total={1} people={[{ ...person("Abdallah", 0), clientId: null }]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Abdallah")).toBeTruthy();
    expect(screen.getByText("Not connected yet")).toBeTruthy();
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
