import { describe, expect, it } from "vitest";
import * as shared from "../../../../packages/config/src/clientIdentity";
import { INVALID_INSTAGRAM_MESSAGE, joinDetailsMessage, TELL_APART_MESSAGE } from "./joinDetails";

/**
 * The app cannot import @chairback/config, so it keeps its own copy of the two
 * sentences. This is what stops that copy drifting from the web forms and the
 * API: the same words, and the same codes the API sends for them.
 */
describe("the Join screen says what the web and the API say", () => {
  it("the same sentences, word for word", () => {
    expect(TELL_APART_MESSAGE).toBe(shared.TELL_APART_MESSAGE);
    expect(INVALID_INSTAGRAM_MESSAGE).toBe(shared.INVALID_INSTAGRAM_MESSAGE);
  });

  it("maps each refusal code the API sends to its sentence", () => {
    expect(joinDetailsMessage(shared.tellApartRefusal("NAME_OR_INSTAGRAM_REQUIRED").error)).toBe(
      shared.TELL_APART_MESSAGE,
    );
    expect(joinDetailsMessage(shared.tellApartRefusal("INVALID_INSTAGRAM").error)).toBe(
      shared.INVALID_INSTAGRAM_MESSAGE,
    );
  });

  it("anything else is not ours to word", () => {
    expect(joinDetailsMessage("name_required")).toBeNull();
    expect(joinDetailsMessage(null)).toBeNull();
  });
});
