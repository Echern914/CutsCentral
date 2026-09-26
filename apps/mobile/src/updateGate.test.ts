import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MOBILE_APP } from "../../../packages/config/src/constants";
import {
  APP_STORE_URL,
  APP_VERSION_PATH,
  checkForRequiredUpdate,
  mustUpdate,
} from "./updateGate";

/**
 * The "Update ChairBack" screen stops a customer using the app, so the rule
 * for showing it is pinned in both directions: it appears for a build below
 * the minimum, and for NOTHING else - no network, a broken API, or an answer
 * we can't read must never lock anyone out.
 */

describe("the app and the API agree on where to look", () => {
  it("the App Store link is the listing in @chairback/config", () => {
    expect(APP_STORE_URL).toBe(MOBILE_APP.appStoreUrl);
  });

  it("the path is the one the API mounts", () => {
    // A drifted path would fail OPEN, silently: every check 404s and nobody is
    // ever asked to update. Only a test can notice that.
    const here = dirname(fileURLToPath(import.meta.url));
    const appTs = readFileSync(join(here, "../../api/src/app.ts"), "utf8");
    expect(appTs).toContain(`app.use("${APP_VERSION_PATH}", appVersionRouter)`);
  });
});

describe("mustUpdate", () => {
  it("a build below the minimum must update", () => {
    expect(mustUpdate("48", { iosMinimumBuild: 49 })).toBe(true);
  });

  it("the minimum itself, and anything newer, carries on", () => {
    expect(mustUpdate("49", { iosMinimumBuild: 49 })).toBe(false);
    expect(mustUpdate("50", { iosMinimumBuild: 49 })).toBe(false);
  });

  it("compares as numbers, not text", () => {
    // "100" < "99" as strings; a build 100 must not be told to update.
    expect(mustUpdate("100", { iosMinimumBuild: 99 })).toBe(false);
    expect(mustUpdate("9", { iosMinimumBuild: 10 })).toBe(true);
  });

  it("no minimum means nobody updates", () => {
    expect(mustUpdate("1", { iosMinimumBuild: null })).toBe(false);
    expect(mustUpdate("1", {})).toBe(false);
  });

  it("an unreadable build number carries on rather than locking the app", () => {
    for (const build of [null, undefined, "", "abc", "1.1.4", "-3", 0]) {
      expect(mustUpdate(build, { iosMinimumBuild: 49 })).toBe(false);
    }
  });

  it("an answer that isn't the expected shape carries on", () => {
    for (const answer of [null, "49", 49, [], { iosMinimumBuild: "forty-nine" }, { iosMinimumBuild: -1 }]) {
      expect(mustUpdate("1", answer)).toBe(false);
    }
  });
});

function answering(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("checkForRequiredUpdate", () => {
  const origin = "https://api.example.test";

  it("asks the API at its path and applies the rule", async () => {
    let asked = "";
    const fetchImpl = async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ iosMinimumBuild: 49 }), { status: 200 });
    };
    expect(await checkForRequiredUpdate(fetchImpl, origin, "48")).toBe(true);
    expect(asked).toBe(`${origin}/api/app-version`);
    expect(await checkForRequiredUpdate(fetchImpl, origin, "49")).toBe(false);
  });

  it("no network: can't tell (null), so the caller carries on", async () => {
    const offline = async () => {
      throw new TypeError("Network request failed");
    };
    expect(await checkForRequiredUpdate(offline, origin, "1")).toBeNull();
  });

  it("an API error or an API from before the route existed: can't tell", async () => {
    expect(await checkForRequiredUpdate(answering(500, {}), origin, "1")).toBeNull();
    expect(await checkForRequiredUpdate(answering(404, { error: "not_found" }), origin, "1")).toBeNull();
  });

  it("a body that isn't JSON: can't tell", async () => {
    const html = async () => new Response("<html>bad gateway</html>", { status: 200 });
    expect(await checkForRequiredUpdate(html, origin, "1")).toBeNull();
  });

  it("an API that never answers is given up on", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await checkForRequiredUpdate(hang, origin, "1", 20)).toBeNull();
  });
});
