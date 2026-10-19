import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";

/**
 * Snow (2026-10-19): on Booking, "Everything else" -> Services & pricing
 * closed the sheet and stayed on Appointments until the app was reopened. The
 * menu links to /dashboard/booking?tab=Services - a client-side navigation
 * that keeps the page mounted, and the tab was read from the address once.
 */

// The address as next/navigation sees it; a link or history.replaceState
// changes it, and the component re-renders with the new value.
let search = new URLSearchParams();
const listeners = new Set<() => void>();
function setAddress(qs: string) {
  search = new URLSearchParams(qs);
  window.history.replaceState(null, "", `/dashboard/booking${qs ? `?${qs}` : ""}`);
  listeners.forEach((l) => l());
}

vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    useSearchParams: () => {
      const [, bump] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        listeners.add(bump);
        return () => {
          listeners.delete(bump);
        };
      }, []);
      return search;
    },
  };
});

const { useUrlTab } = await import("./useUrlTab");

const TABS = ["Appointments", "Services", "Staff"] as const;
type Tab = (typeof TABS)[number];

let shown: Tab;
let tapTab: (t: Tab) => void;
let refuse = false;

function Page({ initial }: { initial: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  shown = tab;
  const request = (next: Tab) => {
    if (refuse) return false;
    setTab(next);
    return true;
  };
  tapTab = (t) => request(t);
  useUrlTab({ tabs: TABS, current: tab, onRequest: request });
  return null;
}

const spyReplace = () => vi.spyOn(window.history, "replaceState");
let replace: ReturnType<typeof spyReplace>;
beforeEach(() => {
  refuse = false;
  setAddress("");
  // The test's own setAddress calls go through the real replaceState; the spy
  // records the hook's writes made after this point.
  replace = spyReplace();
  // Writes from the hook must also reach useSearchParams, as they do in Next.
  replace.mockImplementation((data, unused, url) => {
    History.prototype.replaceState.call(window.history, data, unused, url);
    search = new URL(window.location.href).searchParams;
    listeners.forEach((l) => l());
  });
});
afterEach(() => {
  replace.mockRestore();
});

describe("a link to another tab of the page you're on", () => {
  it("🔴 switches to it without reopening the page (Snow's Services & pricing)", () => {
    render(<Page initial="Appointments" />);
    expect(shown).toBe("Appointments");
    act(() => setAddress("tab=Services"));
    expect(shown).toBe("Services");
  });

  it("🔴 works again after the tab bar was used (the second tap on the same entry)", () => {
    setAddress("tab=Services");
    render(<Page initial="Services" />);
    act(() => tapTab("Appointments"));
    expect(shown).toBe("Appointments");
    expect(window.location.search).toBe("?tab=Appointments");
    act(() => setAddress("tab=Services"));
    expect(shown).toBe("Services");
  });

  it("a refused switch (unsaved edits) puts the address back on the tab shown", () => {
    render(<Page initial="Appointments" />);
    refuse = true;
    act(() => setAddress("tab=Staff"));
    expect(shown).toBe("Appointments");
    expect(window.location.search).toBe("?tab=Appointments");
  });

  it("an unknown tab in the address changes nothing", () => {
    render(<Page initial="Appointments" />);
    act(() => setAddress("tab=Nope"));
    expect(shown).toBe("Appointments");
  });

  it("the first render does not rewrite the address", () => {
    render(<Page initial="Appointments" />);
    expect(replace).not.toHaveBeenCalled();
  });
});
