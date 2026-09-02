import { describe, expect, it } from "vitest";
import { applyEnvAliases } from "./env.js";

/**
 * A credential set under an accepted alternate name must light the feature
 * up. The Standard Connect door stayed dark in production (2026-09-02) because
 * the ca_ client id was saved as STRIPE_CONNECT_ID, one word short of the
 * canonical name, and nothing said so - the button simply never appeared.
 */
describe("applyEnvAliases", () => {
  it("folds STRIPE_CONNECT_ID onto STRIPE_CONNECT_CLIENT_ID when only the alias is set", () => {
    const out = applyEnvAliases({ STRIPE_CONNECT_ID: "ca_alias" });
    expect(out.STRIPE_CONNECT_CLIENT_ID).toBe("ca_alias");
  });

  it("the canonical name always wins over the alias", () => {
    const out = applyEnvAliases({
      STRIPE_CONNECT_CLIENT_ID: "ca_canonical",
      STRIPE_CONNECT_ID: "ca_alias",
    });
    expect(out.STRIPE_CONNECT_CLIENT_ID).toBe("ca_canonical");
  });

  it("an empty canonical value is treated as unset, so the alias still applies", () => {
    const out = applyEnvAliases({ STRIPE_CONNECT_CLIENT_ID: "", STRIPE_CONNECT_ID: "ca_alias" });
    expect(out.STRIPE_CONNECT_CLIENT_ID).toBe("ca_alias");
  });

  it("does nothing when neither is set, and never mutates its input", () => {
    const source: NodeJS.ProcessEnv = { OTHER: "x" };
    const out = applyEnvAliases(source);
    expect(out.STRIPE_CONNECT_CLIENT_ID).toBeUndefined();
    expect(source).toEqual({ OTHER: "x" });
  });
});
