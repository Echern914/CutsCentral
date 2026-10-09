import { describe, expect, it } from "vitest";
import { refusedOnlyNewKeys } from "./apiCompat";

/**
 * A new screen talking to the API it was written BEFORE (web and API deploy
 * separately): resend without the new fields only when that is the ONLY thing
 * the old API refused.
 */
const refusal = (messages: string[]) => ({
  status: 400,
  error: "invalid_input",
  issues: messages.map((message) => ({ path: [], message })),
});

describe("refusedOnlyNewKeys", () => {
  it("an old API refusing only the new fields: resend without them", () => {
    expect(
      refusedOnlyNewKeys(refusal(["Unrecognized key(s) in object: 'requestId'"]), ["requestId", "separateVisit"]),
    ).toBe(true);
    expect(
      refusedOnlyNewKeys(refusal(["Unrecognized key(s) in object: 'requestId', 'separateVisit'"]), [
        "requestId",
        "separateVisit",
      ]),
    ).toBe(true);
  });

  it("a field this caller did not add is a REAL refusal", () => {
    expect(refusedOnlyNewKeys(refusal(["Unrecognized key(s) in object: 'cardTypeId'"]), ["requestId"])).toBe(false);
    expect(
      refusedOnlyNewKeys(refusal(["Unrecognized key(s) in object: 'requestId', 'cardTypeId'"]), ["requestId"]),
    ).toBe(false);
  });

  it("any other validation problem alongside it is a real refusal", () => {
    expect(
      refusedOnlyNewKeys(refusal(["Unrecognized key(s) in object: 'requestId'", "Expected date, received string"]), [
        "requestId",
      ]),
    ).toBe(false);
  });

  it("anything that is not a 400 invalid_input is never retried", () => {
    expect(refusedOnlyNewKeys({ status: 409, error: "visit_on_books", issues: undefined }, ["requestId"])).toBe(false);
    expect(refusedOnlyNewKeys({ status: 0, error: "network_error", issues: undefined }, ["requestId"])).toBe(false);
    expect(refusedOnlyNewKeys({ status: 400, error: "invalid_input", issues: undefined }, ["requestId"])).toBe(false);
  });
});
