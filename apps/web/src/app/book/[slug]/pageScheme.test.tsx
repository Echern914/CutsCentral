import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { bookingScheme } from "./pageScheme";

/**
 * THE BOOKING PAGE WEARS THE SHOP PAGE'S COLOURS.
 *
 * Drick, 2026-10-22, with a screenshot of his booking page: "Any way i can
 * switch it to black? Not sure why it's white now". His shop page is black;
 * white & gold becoming ChairBack's main look turned the page clients book on
 * white, so they went from his black page into a white booking mid-tap.
 */

const nav = vi.hoisted(() => ({ pathname: "/book/drick" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { PageScheme } = await import("@/components/PageScheme");
const { ThemeScope } = await import("@/components/ThemeScope");

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  nav.pathname = "/book/drick";
});

describe("which look", () => {
  it("🔴 a dark shop page (Classic Gold, the default) books dark", () => {
    expect(bookingScheme({ theme: "classic" })).toBe("dark");
    expect(bookingScheme({ theme: "midnight" })).toBe("dark");
    expect(bookingScheme({ theme: "blade" })).toBe("dark");
  });

  it("a light shop page books light", () => {
    expect(bookingScheme({ theme: "crisp" })).toBe("light");
  });

  it("an unset or unknown theme is Classic Gold, exactly as the shop page reads it", () => {
    expect(bookingScheme({})).toBe("dark");
    expect(bookingScheme({ theme: null })).toBe("dark");
    expect(bookingScheme({ theme: "retired-theme" })).toBe("dark");
  });

  it("no page to match (read failed, or no public page): ChairBack's light", () => {
    expect(bookingScheme(null)).toBe("light");
  });
});

describe("on the page", () => {
  it("🔴 dark survives ThemeScope, which turns every other public page light", () => {
    render(
      <>
        <ThemeScope />
        <PageScheme scheme="dark" />
      </>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("🔴 moving between the booking pages (single -> group) stays dark", () => {
    // The /book/[slug] layout - and its PageScheme - persists across this
    // navigation, so its effect does NOT run again; only ThemeScope does, on
    // the new pathname. Without the marker check it would turn the page white.
    // Fresh elements each render: the real usePathname re-renders ThemeScope
    // on navigation, and a reused element would let React skip that.
    const tree = () => (
      <>
        <ThemeScope />
        <PageScheme scheme="dark" />
      </>
    );
    const { rerender } = render(tree());
    expect(document.documentElement.dataset.theme).toBe("dark");
    nav.pathname = "/book/drick/group";
    rerender(tree());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a light shop's booking page stays light", () => {
    render(
      <>
        <ThemeScope />
        <PageScheme scheme="light" />
      </>,
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("🔴 leaving for the dashboard keeps a barber's OWN dark - and their light", () => {
    const { rerender } = render(
      <>
        <ThemeScope />
        <PageScheme scheme="dark" />
      </>,
    );
    // Light-preferring barber: the booking page's dark must not follow them.
    nav.pathname = "/dashboard";
    rerender(<ThemeScope />);
    expect(document.documentElement.dataset.theme).toBeUndefined();

    // Dark-preferring barber: their choice is applied, and nothing wipes it.
    localStorage.setItem("cb-theme", "dark");
    nav.pathname = "/book/drick";
    rerender(
      <>
        <ThemeScope />
        <PageScheme scheme="dark" />
      </>,
    );
    nav.pathname = "/dashboard/booking";
    rerender(<ThemeScope />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaving for another public page drops the dark", () => {
    const { rerender } = render(
      <>
        <ThemeScope />
        <PageScheme scheme="dark" />
      </>,
    );
    nav.pathname = "/";
    rerender(<ThemeScope />);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
