import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library does not auto-clean when vitest runs with globals but no
// afterEach hook registered by the framework adapter. Without this, a second
// render of the same component finds two matches and every getBy* throws.
afterEach(() => cleanup());

/**
 * jsdom implements neither `Element.scrollTo` nor `Element.scrollIntoView`, and
 * accessing them throws rather than no-oping. Real components call both for
 * good reasons - `ui/Dialog` resets its body scroll when it swaps pages, and a
 * form moves focus to the field a customer has to fix - so without these stubs
 * the first test to render either dies on a browser API rather than on
 * anything it meant to assert.
 *
 * Stubbed, not mocked: nothing here should assert that a scroll HAPPENED, only
 * that it did not blow up. Scroll position is not a thing jsdom can tell the
 * truth about anyway.
 */
if (typeof Element !== "undefined") {
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}
