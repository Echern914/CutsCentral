import { afterEach, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests } from "@chairback/config";
import {
  SmsDisabledError,
  SmsDisabledProvider,
  __setMessageProviderForTests,
  getMessageProvider,
  getSignInMessageProvider,
  signInTextsEnabled,
  smsConfigured,
  smsEnabled,
} from "./twilio.js";
import type { SendMessageInput } from "./provider.js";
import { resolveIdentifier } from "../routes/customerAuth.js";
import { NOTIFY_DEFAULTS } from "../services/barberNotify.js";
import { channelEnabled } from "../services/reviewNotify.js";
import { RESEND_REFUSAL_HTTP, resendRewardsLink } from "../services/rewardsLinkResend.js";

/**
 * THE TEXTING SWITCH (SMS_ENABLED). Texts cost money and email and push do
 * not, so the platform can stop texting without silencing anything else.
 *
 * What these pin:
 *  - off is the DEFAULT, and off beats everything - an injected fake included;
 *  - a send that slips past every gate is REFUSED, never faked as sent;
 *  - the doors that can only text answer "texting is off" (or the answer the
 *    shipped app already understands) instead of promising a text;
 *  - EXCEPT one-time sign-in codes, which keep going unless
 *    SMS_SIGNIN_ENABLED=false too - and only through their own provider;
 *  - an alert someone asked for by text arrives by email instead.
 *
 * The flows are covered where they live: booking alerts in
 * booking.barberNotify.test.ts, the AI receptionist in inbound.test.ts.
 */

function texting(on: boolean | undefined): void {
  if (on === undefined) delete process.env.SMS_ENABLED;
  else process.env.SMS_ENABLED = on ? "true" : "false";
  __resetEnvCacheForTests();
}

const sent: SendMessageInput[] = [];
const fake = {
  channel: "SMS" as const,
  send: async (input: SendMessageInput) => {
    sent.push(input);
    return { sid: `SM-fake-${sent.length}`, status: "queued" };
  },
};

function signInTexts(on: boolean | undefined): void {
  if (on === undefined) delete process.env.SMS_SIGNIN_ENABLED;
  else process.env.SMS_SIGNIN_ENABLED = on ? "true" : "false";
  __resetEnvCacheForTests();
}

afterEach(() => {
  signInTexts(undefined);
  texting(true); // the suites' default (vitest.setup.ts)
  __setMessageProviderForTests(undefined);
  sent.length = 0;
});

describe("the switch", () => {
  it("🔴 is OFF unless SMS_ENABLED says true", () => {
    texting(undefined);
    expect(smsEnabled()).toBe(false);
    texting(true);
    expect(smsEnabled()).toBe(true);
  });

  it("🔴 off beats an injected provider: nothing reaches a fake, let alone Twilio", async () => {
    __setMessageProviderForTests(fake);
    texting(false);
    const provider = getMessageProvider();
    expect(provider).toBeInstanceOf(SmsDisabledProvider);
    await expect(provider.send({ to: "+12015550123", body: "hi" })).rejects.toBeInstanceOf(
      SmsDisabledError,
    );
    expect(sent).toHaveLength(0);
  });

  it("a send that slips past every gate is refused, never recorded as sent", async () => {
    texting(false);
    const err = await getMessageProvider()
      .send({ to: "+12015550123", body: "hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsDisabledError);
    expect((err as SmsDisabledError).code).toBe("sms_disabled");
  });

  it("readiness sees no text channel while it is off", () => {
    __setMessageProviderForTests(fake);
    texting(false);
    expect(smsConfigured()).toBe(false);
    texting(true);
    expect(smsConfigured()).toBe(true);
  });

  it("on: the injected provider is used exactly as before", async () => {
    __setMessageProviderForTests(fake);
    texting(true);
    await getMessageProvider().send({ to: "+12015550123", body: "hi" });
    expect(sent).toHaveLength(1);
  });
});

describe("customer sign-in codes: the one text that keeps going", () => {
  // Email cannot stand in for a phone here: an imported book shares emails
  // across records far more than phones, and a shared contact lands the
  // customer on "Needs connecting". See signInTextsEnabled().

  it("🔴 texting off still lets a phone sign in", () => {
    texting(false);
    expect(signInTextsEnabled()).toBe(true);
    expect(resolveIdentifier({ channel: "sms", phone: "(201) 555-0123" })).toEqual({
      channel: "sms",
      identifier: "+12015550123",
    });
  });

  it("🔴 the sign-in provider sends while every other path is still refused", async () => {
    __setMessageProviderForTests(fake);
    texting(false);
    await getSignInMessageProvider().send({ to: "+12015550123", body: "123456" });
    expect(sent).toHaveLength(1);
    // Nothing else got a way through: reminders, nudges and the receptionist
    // all use getMessageProvider().
    expect(getMessageProvider()).toBeInstanceOf(SmsDisabledProvider);
  });

  it("SMS_SIGNIN_ENABLED=false as well: the answer every shipped app turns into 'use your email'", async () => {
    __setMessageProviderForTests(fake);
    texting(false);
    signInTexts(false);
    expect(signInTextsEnabled()).toBe(false);
    expect(resolveIdentifier({ channel: "sms", phone: "(201) 555-0123" })).toEqual({
      error: "phone_not_supported",
    });
    await expect(
      getSignInMessageProvider().send({ to: "+12015550123", body: "123456" }),
    ).rejects.toBeInstanceOf(SmsDisabledError);
    expect(sent).toHaveLength(0);
  });

  it("texting on sends them whatever SMS_SIGNIN_ENABLED says", () => {
    texting(true);
    signInTexts(false);
    expect(signInTextsEnabled()).toBe(true);
  });

  it("email sign-in is untouched either way", () => {
    texting(false);
    signInTexts(false);
    expect(resolveIdentifier({ channel: "email", email: "Pat@Example.com" })).toEqual({
      channel: "email",
      identifier: "pat@example.com",
    });
  });
});

describe("new-review alerts", () => {
  it("🔴 nothing is queued for SMS, and a text subscriber gets email instead", () => {
    const prefs = { ...NOTIFY_DEFAULTS }; // push on, texts on, email off
    texting(false);
    expect(channelEnabled(prefs, "sms")).toBe(false);
    expect(channelEnabled(prefs, "email")).toBe(true);
    expect(channelEnabled(prefs, "push")).toBe(true);
    // Someone who wanted neither texts nor email still gets no email.
    expect(channelEnabled({ ...prefs, smsEnabled: false }, "email")).toBe(false);

    texting(true);
    expect(channelEnabled(prefs, "sms")).toBe(true);
    expect(channelEnabled(prefs, "email")).toBe(false);
  });
});

describe("the rewards-link button", () => {
  it("says texting is off before any cooldown, cap or budget is touched", async () => {
    texting(false);
    // No database work happens on this path: the refusal comes first.
    const res = await resendRewardsLink({
      shopId: "shop_never_read",
      client: {
        id: "client_never_read",
        phone: "+12015550123",
        optedOut: false,
        optOutSource: null,
        smsConsentAt: new Date(),
        magicToken: "token",
      },
      twilioNumber: null,
    });
    expect(res).toEqual({ ok: false, refusal: "texting_off" });
    expect(RESEND_REFUSAL_HTTP.texting_off).toMatchObject({ status: 503, error: "texting_off" });
  });
});
