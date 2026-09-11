import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setSendEmailForTests, ResendSendError, type SendEmailInput } from "../messaging/email.js";
import type { SendMessageInput } from "../messaging/provider.js";
import { logger } from "../logger.js";
import {
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  deliverSignInCode,
  kickSignInDelivery,
  runCustomerSignInOutbox,
} from "./customerSignInOutbox.js";
import {
  identifierDigest,
  issueSignInCode,
  verifySignInCode,
} from "../services/customerSignIn.js";

/**
 * THE PROMISE TO DELIVER A SIGN-IN CODE, KEPT ACROSS A CRASH.
 *
 * Everything here is about the seconds between "the code is committed" and
 * "the text left": a deploy, a frozen instance, a provider that never answers.
 * The old floating promise lost all of them silently, and the customer was
 * left holding a cooldown and no code.
 *
 * `now` is a parameter throughout, so an aged claim and an expired challenge
 * are tested without sleeping.
 */

let sms: SendMessageInput[] = [];
let mail: SendEmailInput[] = [];
const usedHashes = new Set<string>();
let seq = 0;

function freshPhone(): string {
  seq += 1;
  const phone = `+1415777${String(1000 + seq).padStart(4, "0")}`;
  usedHashes.add(identifierDigest("sms", phone));
  return phone;
}
function freshEmail(): string {
  seq += 1;
  const email = `outbox-${seq}-${randomToken(4).toLowerCase()}@test.local`;
  usedHashes.add(identifierDigest("email", email));
  return email;
}

function recordingSms() {
  __setMessageProviderForTests({
    channel: "SMS",
    send: async (input) => {
      sms.push(input);
      return { sid: `SM${sms.length}`, status: "sent" };
    },
  });
}
function recordingEmail() {
  __setSendEmailForTests(async (input) => {
    mail.push(input);
    return { id: `EM${mail.length}`, status: "sent" };
  });
}

/** Mint a challenge WITHOUT the request path's immediate kick. */
async function challenge(channel: "sms" | "email", identifier: string, now: Date) {
  const outcome = await issueSignInCode({
    channel,
    identifier,
    ip: `10.9.${seq % 200}.${(seq * 7) % 200}`,
    now,
  });
  if (!outcome.send) throw new Error(`refused: ${outcome.reason}`);
  return outcome;
}

const row = (id: string) =>
  prisma.customerSignInDelivery.findUniqueOrThrow({ where: { id } });

beforeAll(() => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.DRY_RUN = "true"; // a real provider must never be constructed here
  __resetEnvCacheForTests();
});

afterEach(async () => {
  sms = [];
  mail = [];
  __setMessageProviderForTests(undefined);
  __setSendEmailForTests(undefined);
  await prisma.customerSignInCode.deleteMany({
    where: { identifierHash: { in: [...usedHashes] } },
  });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custSms:" } } });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "custEmail:" } } });
});

afterAll(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

describe("the challenge and its delivery are one commit", () => {
  it("minting a code writes a pending delivery that holds the code sealed", async () => {
    recordingSms();
    const phone = freshPhone();
    const now = new Date();
    const { code, deliveryId } = await challenge("sms", phone, now);

    const d = await row(deliveryId);
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(0);
    // 🔴 Neither the code nor the destination is readable in the row.
    const raw = JSON.stringify(d);
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(phone.slice(2));
    expect(d.sealed).not.toBeNull();
    expect(sms).toHaveLength(0); // nothing has been sent yet - only promised
  });

  it("the worker delivers it, and wipes the code when it settles", async () => {
    recordingSms();
    const phone = freshPhone();
    const now = new Date();
    const { code, deliveryId } = await challenge("sms", phone, now);

    const result = await runCustomerSignInOutbox({ now });
    expect(result.sent).toBe(1);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.to).toBe(phone);
    expect(sms[0]!.body).toContain(code);

    const d = await row(deliveryId);
    expect(d.status).toBe("sent");
    expect(d.sealed).toBeNull();
    expect(d.claimToken).toBeNull();
    expect(d.lastAttemptAmbiguous).toBe(false);
    expect(d.attempts).toBe(1);
    // The code still works - delivery state is not identity state.
    expect(await verifySignInCode({ channel: "sms", identifier: phone, code, now })).toEqual({
      verified: true,
    });
  });
});

describe("a process that dies mid-send", () => {
  it("🔴 hands the row to the next worker, which sends under the SAME provider key", async () => {
    recordingEmail();
    const email = freshEmail();
    const now = new Date();
    const { deliveryId } = await challenge("email", email, now);

    // The provider call that never comes back: the process is gone after the
    // attempt was reserved and before anything could record its outcome.
    let release: (() => void) | null = null;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    __setSendEmailForTests(async (input) => {
      mail.push(input);
      await hang;
      return { id: "never", status: "sent" };
    });
    void kickSignInDelivery(deliveryId, now);
    await vi.waitFor(async () => expect((await row(deliveryId)).attempts).toBe(1));

    const stalled = await row(deliveryId);
    // The write-ahead marker is already on disk: an attempt MAY be in flight.
    expect(stalled.lastAttemptAmbiguous).toBe(true);
    expect(stalled.claimToken).not.toBeNull();
    expect(stalled.status).toBe("pending");

    // Until the claim ages out, nobody else touches it.
    expect((await runCustomerSignInOutbox({ now })).claimed).toBe(0);

    // Past the TTL, the sweeper takes over and delivers - through a provider
    // that answers, the way a restarted process would.
    recordingEmail();
    const later = new Date(now.getTime() + CLAIM_TTL_MS + 1000);
    const taken = await runCustomerSignInOutbox({ now: later });
    expect(taken.sent).toBe(1);
    expect(mail).toHaveLength(2);
    // 🔴 The same Idempotency-Key, so Resend collapses the pair rather than
    // mailing the customer two codes.
    expect(mail[1]!.idempotencyKey).toBe(mail[0]!.idempotencyKey);
    expect(mail[1]!.idempotencyKey).toMatch(/^customer-sign-in:/);

    // The dead worker finally comes back. It holds a claim nobody honours.
    release!();
    await hang;
    const settled = await row(deliveryId);
    expect(settled.status).toBe("sent");
    expect(settled.attempts).toBe(2);
  });

  it("a worker whose claim was taken over writes nothing at all", async () => {
    recordingSms();
    const phone = freshPhone();
    const now = new Date();
    const { deliveryId } = await challenge("sms", phone, now);

    // Worker A claims and delivers.
    await runCustomerSignInOutbox({ now });
    const afterA = await row(deliveryId);
    expect(afterA.status).toBe("sent");

    // Worker B wakes up holding A's old claim token and tries to settle.
    const outcome = await deliverSignInCode({
      deliveryId,
      claimToken: "a-token-nobody-holds",
      now,
    });
    expect(outcome).toBe("stale_claim");
    const afterB = await row(deliveryId);
    expect(afterB.status).toBe("sent");
    expect(afterB.attempts).toBe(afterA.attempts);
    expect(sms).toHaveLength(1);
  });
});

describe("what the provider answers", () => {
  it("an ambiguous failure backs off, keeps the marker, and retries the same code", async () => {
    const phone = freshPhone();
    const now = new Date();
    const { code, deliveryId } = await challenge("sms", phone, now);
    __setMessageProviderForTests({
      channel: "SMS",
      send: async () => {
        throw new Error("socket hang up"); // no status: nobody knows
      },
    });

    expect((await runCustomerSignInOutbox({ now })).retry).toBe(1);
    const after = await row(deliveryId);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(1);
    expect(after.lastAttemptAmbiguous).toBe(true);
    expect(after.lastError).toBe("transport_error");
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(after.claimToken).toBeNull(); // released for whoever is next

    // Not due yet.
    expect((await runCustomerSignInOutbox({ now })).claimed).toBe(0);

    recordingSms();
    const due = new Date(after.nextAttemptAt!.getTime() + 1000);
    expect((await runCustomerSignInOutbox({ now: due })).sent).toBe(1);
    // 🔴 The retry carries the code the customer was already told about -
    // never a second one that would also work.
    expect(sms[0]!.body).toContain(code);
    expect((await row(deliveryId)).lastAttemptAmbiguous).toBe(false);
  });

  it("a definitive rejection is retried, then failed - and never called ambiguous", async () => {
    const email = freshEmail();
    const now = new Date();
    const { deliveryId } = await challenge("email", email, now);
    __setSendEmailForTests(async () => {
      throw new ResendSendError(422);
    });

    let at = now;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runCustomerSignInOutbox({ now: at });
      const d = await row(deliveryId);
      at = new Date((d.nextAttemptAt ?? at).getTime() + 1000);
    }
    const done = await row(deliveryId);
    expect(done.status).toBe("failed");
    expect(done.attempts).toBe(MAX_ATTEMPTS);
    expect(done.lastError).toBe("domain");
    // Nothing was accepted, so nothing is ambiguous, and the code is gone.
    expect(done.lastAttemptAmbiguous).toBe(false);
    expect(done.sealed).toBeNull();
  });

  it("a channel that cannot send at all is suppressed without spending an attempt", async () => {
    // No test provider: DRY_RUN's Noop provider stands in, as in production
    // with texting switched off.
    __setMessageProviderForTests(undefined);
    const phone = freshPhone();
    const now = new Date();
    const { deliveryId } = await challenge("sms", phone, now);
    expect((await runCustomerSignInOutbox({ now })).suppressed).toBe(1);
    const d = await row(deliveryId);
    expect(d.status).toBe("suppressed");
    expect(d.attempts).toBe(0);
    expect(d.sealed).toBeNull();
  });

  it("🔴 a hostile provider error never reaches a log line", async () => {
    const phone = freshPhone();
    const now = new Date();
    const { code } = await challenge("sms", phone, now);
    const HOSTILE = "Authorization: Bearer SK_outbox_hostile";
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");
    __setMessageProviderForTests({
      channel: "SMS",
      send: async (input) => {
        throw new Error(`boom to=${input.to} body=${input.body} ${HOSTILE}`);
      },
    });
    try {
      await runCustomerSignInOutbox({ now });
      const everything = JSON.stringify([warn.mock.calls, info.mock.calls, error.mock.calls]);
      expect(everything).toContain("customer sign-in");
      expect(everything).not.toContain(phone);
      expect(everything).not.toContain(phone.slice(2));
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(HOSTILE);
    } finally {
      warn.mockRestore();
      info.mockRestore();
      error.mockRestore();
    }
  });
});

describe("one live code at a time", () => {
  it("re-issuing supersedes the pending delivery and wipes its code", async () => {
    recordingSms();
    const phone = freshPhone();
    const now = new Date();
    const first = await challenge("sms", phone, now);

    // Past the cooldown, the customer asks again.
    const later = new Date(now.getTime() + 5 * 60 * 1000);
    await prisma.customerSignInCode.updateMany({
      where: { identifierHash: identifierDigest("sms", phone) },
      data: { lastSentAt: new Date(later.getTime() - 2 * 60 * 1000) },
    });
    const second = await challenge("sms", phone, later);

    const old = await row(first.deliveryId);
    expect(old.status).toBe("superseded");
    expect(old.sealed).toBeNull();

    // Draining now sends the NEW code, once.
    await runCustomerSignInOutbox({ now: later });
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain(second.code);
    // 🔴 And the old code no longer opens anything.
    expect(
      await verifySignInCode({ channel: "sms", identifier: phone, code: first.code, now: later }),
    ).toEqual({ verified: false });
  });

  it("a challenge that expired before it could be delivered sends nothing", async () => {
    recordingSms();
    const phone = freshPhone();
    const now = new Date();
    const { deliveryId } = await challenge("sms", phone, now);
    const tooLate = new Date(now.getTime() + 60 * 60 * 1000);

    const result = await runCustomerSignInOutbox({ now: tooLate });
    expect(result.expired).toBe(1);
    expect(sms).toHaveLength(0);
    const d = await row(deliveryId);
    expect(d.status).toBe("expired");
    expect(d.sealed).toBeNull();
  });
});
