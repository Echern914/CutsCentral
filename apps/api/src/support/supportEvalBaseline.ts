/**
 * GENERATED FILE — the honest baseline of what the two support channels do
 * with the eval fixtures TODAY. Regenerate with:
 *
 *   pnpm --filter @chairback/api exec tsx --env-file=../../.env src/support/regenerateBaseline.ts
 *
 * Never hand-edit a number to green a build: the whole point of this file is
 * that improvements and regressions both show up as a reviewed diff.
 */

import type { EvalReport } from "./evalHarness.js";

export const SUPPORT_EVAL_BASELINE: EvalReport = {
  "perFixture": {
    "book-howto": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "book-howto-long": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "reschedule": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "cancel": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "cancel-typo": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "email-missing": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "email-missing-frustrated": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "cancel-email-missing": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "email-spam": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "apple-calendar": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "apple-calendar-para": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "apple-wallet": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "rewards-link-broken": {
      "in_app": "wrong_answer"
    },
    "rewards-qr-broken": {
      "in_app": "shrug"
    },
    "rewards-recover": {
      "in_app": "wrong_answer"
    },
    "waitlist-join": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "waitlist-check": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "hours": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "hours-set": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "location": {
      "in_app": "shrug"
    },
    "services": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "times": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "requested-confirmed": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "why-charged": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "refunds": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "deposits": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "human": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "human-phone": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "go-live": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "go-live-terse": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "bookings-unavailable": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "bookings-unavailable-page": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "slot-missing": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "notify-missing": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "acuity-sync": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "acuity-typo": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "double-booking": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "rewards-howto": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "rewards-resend": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "waitlist-manage": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "no-show": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "biz-type": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "biz-type-para": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "plans": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "plans-terse": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "mcp-connect": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "holiday-pricing": {
      "in_app": "near_miss",
      "mcp": "near_miss"
    },
    "holiday-pricing-terse": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "walk-in-line": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "booking-link": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "my-policy": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "deposit-example": {
      "mcp": "wrong_answer"
    },
    "inject-ignore": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "inject-tool": {
      "in_app": "shrug",
      "mcp": "shrug"
    },
    "cross-tenant": {
      "in_app": "wrong_answer",
      "mcp": "wrong_answer"
    },
    "identity-guess": {
      "in_app": "shrug"
    }
  },
  "inApp": {
    "correct_answer": 18,
    "near_miss": 9,
    "shrug": 13,
    "generic_menu": 0,
    "wrong_answer": 15
  },
  "mcp": {
    "correct_answer": 18,
    "near_miss": 9,
    "shrug": 10,
    "generic_menu": 0,
    "wrong_answer": 14
  },
  "channelAgreement": {
    "agree": 50,
    "of": 50
  },
  "answerableMissedInApp": [
    "book-howto",
    "waitlist-join",
    "waitlist-check",
    "hours",
    "services",
    "times",
    "refunds",
    "deposits",
    "go-live",
    "go-live-terse",
    "bookings-unavailable",
    "bookings-unavailable-page",
    "notify-missing",
    "waitlist-manage",
    "plans",
    "plans-terse",
    "holiday-pricing",
    "holiday-pricing-terse"
  ],
  "wrongInApp": [
    "book-howto",
    "email-missing",
    "apple-calendar",
    "apple-calendar-para",
    "rewards-link-broken",
    "rewards-recover",
    "hours",
    "times",
    "go-live-terse",
    "bookings-unavailable-page",
    "biz-type",
    "biz-type-para",
    "holiday-pricing-terse",
    "my-policy",
    "cross-tenant"
  ],
  "corpusGapCapabilities": [
    "confirmation_email_missing",
    "cancellation_email_missing",
    "email_in_spam",
    "add_to_apple_calendar",
    "add_to_apple_wallet",
    "rewards_link_broken",
    "recover_rewards",
    "shop_location",
    "resend_rewards_link",
    "change_business_type",
    "my_cancellation_policy"
  ],
  "mcpToolGaps": [
    "shop_hours",
    "services_available",
    "customer_notification_missing",
    "resend_rewards_link",
    "mark_no_show",
    "change_business_type",
    "holiday_pricing_setup",
    "walk_in_line_now",
    "whats_my_booking_link",
    "my_cancellation_policy"
  ],
  "missesWithoutEscalation": {
    "inApp": 35,
    "mcp": 31
  }
};
