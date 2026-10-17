import { describe, expect, it } from "vitest";
import { findHelp } from "./helpMatch.js";

/**
 * The Assistant knows what shipped in October 2026 (Eric, 2026-10-17: "update
 * everything that has been done to the AI assistant"). Each way a barber
 * might ask reaches the answer written for it - in the app and over MCP, which
 * read this same corpus.
 */
const answerFor = (q: string) => findHelp(q).answer?.id ?? null;

describe("the Assistant knows the recent features", () => {
  it.each([
    ["how do I see a client's note before they come in", "client-notes"],
    ["where do I see what the client wrote", "client-notes"],
    ["my client left a note where is it", "client-notes"],
    ["how do i change my time zone", "shop-time-zone"],
    ["my timezone is wrong", "shop-time-zone"],
    ["is my team set up", "team-setup-progress"],
    ["how do I see my barbers setup progress", "team-setup-progress"],
    ["is there a tour", "take-the-tour"],
    ["can you show me around", "take-the-tour"],
    ["how do I get set up", "get-started"],
    ["paste my menu from booksy", "add-services"],
    ["how do i become barber of the month", "provider-of-the-month"],
    ["apply for the award", "provider-of-the-month"],
  ])("%s", (q, id) => {
    expect(answerFor(q)).toBe(id);
  });
});
