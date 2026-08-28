import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The REAL readiness mapping and the REAL poke result vocabulary - no seam.
 *
 * `pass.ts` reads `apiEnv()` once at module load, so each case mocks the
 * config module and re-imports the module fresh. That is a test mock, not a
 * production bypass: the shipped code has no branch that behaves differently
 * under test.
 *
 * Why this file exists: "we had nothing to send" and "we could not send" were
 * once the same boolean, which would have let a wallet outage mark a rotation
 * run's pass refreshes SUCCEEDED while every customer's QR stayed stale.
 */

const findMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
/** The owner-transaction seam. Tests make the LOOKUP fail by throwing here:
 * a synchronous throw exercises the same try/catch as a rejected query
 * without leaving a floating rejection for the runner to attribute
 * elsewhere. */
const runAsOwner = vi.hoisted(() =>
  vi.fn((fn: (tx: unknown) => unknown) =>
    fn({ walletPassRegistration: { findMany, deleteMany: vi.fn() } }),
  ),
);
vi.mock("@chairback/db", () => ({ prisma: {}, runAsOwner }));

const WALLET_CONFIGURED = {
  WALLET_PASS_TYPE_ID: "pass.com.test",
  WALLET_TEAM_ID: "TEAM123",
  WALLET_PASS_CERT_BASE64: "Y2VydA==",
  WALLET_PASS_KEY_BASE64: "a2V5",
  WALLET_WWDR_CERT_BASE64: "d3dkcg==",
};

/** Load pass.ts against a specific environment. */
async function loadPass(over: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("@chairback/config", async (importOriginal) => {
    const real = await importOriginal<typeof import("@chairback/config")>();
    return {
      ...real,
      apiEnv: () => ({
        ...real.apiEnv(),
        WALLET_PASS_TYPE_ID: undefined,
        WALLET_TEAM_ID: undefined,
        WALLET_PASS_CERT_BASE64: undefined,
        WALLET_PASS_KEY_BASE64: undefined,
        WALLET_WWDR_CERT_BASE64: undefined,
        DRY_RUN: false,
        ...over,
      }),
    };
  });
  return import("./pass.js");
}

beforeEach(() => {
  findMany.mockReset();
  runAsOwner.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ walletPassRegistration: { findMany, deleteMany: vi.fn() } }),
  );
});
afterEach(() => vi.doUnmock("@chairback/config"));

describe("walletDeliveryReadiness", () => {
  it("is unconfigured when the WALLET_* vars are missing", async () => {
    const { walletDeliveryReadiness } = await loadPass({});
    expect(walletDeliveryReadiness()).toBe("unconfigured");
  });

  it("is suppressed under DRY_RUN even when fully configured", async () => {
    const { walletDeliveryReadiness } = await loadPass({
      ...WALLET_CONFIGURED,
      DRY_RUN: true,
    });
    expect(walletDeliveryReadiness()).toBe("suppressed");
  });

  it("is ready only when configured AND dispatching", async () => {
    const { walletDeliveryReadiness } = await loadPass(WALLET_CONFIGURED);
    expect(walletDeliveryReadiness()).toBe("ready");
  });
});

describe("pokeWalletPass results", () => {
  it("is nothing_to_do when the client holds no registration", async () => {
    findMany.mockResolvedValue([]);
    const { pokeWalletPass } = await loadPass(WALLET_CONFIGURED);
    // 🔴 The distinction that matters: nothing to refresh is DONE, not
    // "unavailable" - a pass task on this client can safely close.
    expect(await pokeWalletPass("c1")).toBe("nothing_to_do");
  });

  it("is retryable_unavailable - never delivered - when wallet is unconfigured", async () => {
    findMany.mockResolvedValue([{ id: "r1", pushToken: "tok" }]);
    const { pokeWalletPass } = await loadPass({});
    expect(await pokeWalletPass("c1")).toBe("retryable_unavailable");
  });

  it("is retryable_unavailable - never delivered - under DRY_RUN", async () => {
    findMany.mockResolvedValue([{ id: "r1", pushToken: "tok" }]);
    const { pokeWalletPass } = await loadPass({
      ...WALLET_CONFIGURED,
      DRY_RUN: true,
    });
    expect(await pokeWalletPass("c1")).toBe("retryable_unavailable");
  });

  it("is retryable_unavailable when the registration lookup fails, and logs no raw error", async () => {
    runAsOwner.mockImplementation(() => {
      throw new Error("PG down: host=db pw=hunter2");
    });
    const { pokeWalletPass } = await loadPass(WALLET_CONFIGURED);
    const { logger } = await import("../logger.js");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      expect(await pokeWalletPass("c1")).toBe("retryable_unavailable");
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).not.toContain("hunter2");
      expect(logged).not.toContain("PG down");
      expect(logged).toContain("registration_lookup_failed"); // fixed class only
    } finally {
      errSpy.mockRestore();
    }
  });

  it("never throws - a wallet problem cannot break a punch or loyalty flow", async () => {
    runAsOwner.mockImplementation(() => {
      throw new Error("boom");
    });
    const { pokeWalletPass } = await loadPass({});
    await expect(pokeWalletPass("c1")).resolves.toBe("retryable_unavailable");
  });

  it("logs no push token when it declines to dispatch", async () => {
    findMany.mockResolvedValue([{ id: "r1", pushToken: "PUSHTOKEN-SECRET" }]);
    const { pokeWalletPass } = await loadPass({
      ...WALLET_CONFIGURED,
      DRY_RUN: true,
    });
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      await pokeWalletPass("c1");
      expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("PUSHTOKEN-SECRET");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
