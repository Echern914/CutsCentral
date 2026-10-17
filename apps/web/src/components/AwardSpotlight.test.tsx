import { beforeEach, describe, expect, it } from "vitest";
import { MotionGlobalConfig } from "framer-motion";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PublicAward } from "@chairback/config/providerAward";
import { AwardSpotlight } from "./AwardSpotlight";

/**
 * Provider of the Month on the winner's page: the card opens as the page
 * does, says who won, how and why, and closes to a pill that opens it again.
 * On the booking page (autoOpen off) it is only the pill.
 */
const award: PublicAward = {
  month: "2026-10",
  monthLabel: "October 2026",
  title: "Barber of the Month",
  winnerName: "Jera",
  specialty: "Lash extensions · Brow lamination",
  headline: "Most booked in October",
  description: "Every chair full, and her clients keep coming back.",
  stats: [{ key: "appointments", label: "Appointments in the last 30 days", value: "112" }],
};

// jsdom never finishes an exit animation; the behaviour is what is tested.
MotionGlobalConfig.skipAnimations = true;
beforeEach(() => window.sessionStorage.clear());

describe("the award on the winner's page", () => {
  it("🔴 opens on arrival: who, how, why and the stats", async () => {
    await act(async () => {
      render(<AwardSpotlight award={award} slug="jeracuts" />);
    });
    const card = screen.getByRole("dialog");
    expect(card.textContent).toContain("Barber of the Month");
    expect(card.textContent).toContain("October 2026");
    expect(card.textContent).toContain("Jera");
    // What she does - not every winner is a barber.
    expect(card.textContent).toContain("Lash extensions · Brow lamination");
    expect(card.textContent).toContain("Most booked in October");
    expect(card.textContent).toContain("Every chair full");
    expect(card.textContent).toContain("112");
  });

  it("closes to a pill that opens it again - and stays closed for the visit", async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<AwardSpotlight award={award} slug="jeracuts" />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See their page" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const pill = screen.getByRole("button", { name: /Barber of the Month · October 2026/ });
    view.unmount();
    // Back on the page in the same visit: not opened again by itself.
    await act(async () => {
      render(<AwardSpotlight award={award} slug="jeracuts" />);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Barber of the Month · October 2026/ }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(pill).toBeTruthy();
  });

  it("on the booking page it is only the pill - booking is never interrupted", async () => {
    await act(async () => {
      render(<AwardSpotlight award={award} slug="jeracuts" autoOpen={false} />);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /Barber of the Month/ })).toBeTruthy();
  });

  it("no award, nothing at all", () => {
    const { container } = render(<AwardSpotlight award={null} slug="x" />);
    expect(container.textContent).toBe("");
  });
});
