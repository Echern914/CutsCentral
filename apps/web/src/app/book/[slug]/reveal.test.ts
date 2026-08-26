import { afterEach, describe, expect, it, vi } from "vitest";
import { revealElement } from "./reveal";

/**
 * The scroll that makes "select and continue" visible on a phone.
 *
 * Thin, but the two things worth pinning down are the ones that break quietly:
 * a customer with reduced motion must still ARRIVE at the new step (just
 * without the flight), and a webview missing `matchMedia` must not take the
 * booking page down on a tap.
 */
function elementWithSpy(): { el: HTMLElement; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn();
  const el = { scrollIntoView: spy } as unknown as HTMLElement;
  return { el, spy };
}

function setReducedMotion(matches: boolean | "throws" | "missing"): void {
  if (matches === "missing") {
    // @ts-expect-error deliberately removing the API to model an old webview
    window.matchMedia = undefined;
    return;
  }
  window.matchMedia = vi.fn((query: string) => {
    if (matches === "throws") throw new Error("matchMedia exploded");
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
}

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
  vi.restoreAllMocks();
});

describe("revealElement", () => {
  it("scrolls smoothly to the TOP of the step by default", () => {
    setReducedMotion(false);
    const { el, spy } = elementWithSpy();
    revealElement(el);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("still arrives, instantly, under reduced motion", () => {
    // The customer must end up at the new step either way - reduced motion
    // means "don't fly me there", not "don't take me there".
    setReducedMotion(true);
    const { el, spy } = elementWithSpy();
    revealElement(el);
    expect(spy).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("does nothing, and does not throw, without an element", () => {
    setReducedMotion(false);
    expect(() => revealElement(null)).not.toThrow();
  });

  it("still scrolls when matchMedia is missing entirely", () => {
    setReducedMotion("missing");
    const { el, spy } = elementWithSpy();
    revealElement(el);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("still scrolls when matchMedia throws", () => {
    // A missing accessibility API must degrade to "animate", never to a crash
    // that takes the booking page down on a tap.
    setReducedMotion("throws");
    const { el, spy } = elementWithSpy();
    revealElement(el);
    expect(spy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("re-reads the preference on every call", () => {
    // Cached at module load, a mid-session change would keep animating.
    const { el, spy } = elementWithSpy();
    setReducedMotion(false);
    revealElement(el);
    setReducedMotion(true);
    revealElement(el);
    expect(spy.mock.calls[0]![0]).toMatchObject({ behavior: "smooth" });
    expect(spy.mock.calls[1]![0]).toMatchObject({ behavior: "auto" });
  });
});
