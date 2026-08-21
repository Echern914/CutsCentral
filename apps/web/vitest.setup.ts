import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library does not auto-clean when vitest runs with globals but no
// afterEach hook registered by the framework adapter. Without this, a second
// render of the same component finds two matches and every getBy* throws.
afterEach(() => cleanup());
