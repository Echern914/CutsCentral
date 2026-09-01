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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "email-missing-frustrated": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "cancel-email-missing": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "email-spam": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "apple-calendar": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "apple-calendar-para": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "apple-wallet": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "rewards-link-broken": {
      "in_app": "correct_answer"
    },
    "rewards-qr-broken": {
      "in_app": "correct_answer"
    },
    "rewards-recover": {
      "in_app": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "hours-set": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "location": {
      "in_app": "near_miss"
    },
    "services": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "times": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "go-live-terse": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "bookings-unavailable": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "bookings-unavailable-page": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "slot-missing": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "notify-missing": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "biz-type-para": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "holiday-pricing-terse": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
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
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "deposit-example": {
      "mcp": "correct_answer"
    },
    "inject-ignore": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "inject-tool": {
      "in_app": "correct_answer",
      "mcp": "correct_answer"
    },
    "cross-tenant": {
      "in_app": "correct_answer"
    },
    "identity-guess": {
      "in_app": "correct_answer"
    }
  },
  "inApp": {
    "correct_answer": 47,
    "near_miss": 5,
    "shrug": 3,
    "generic_menu": 0,
    "wrong_answer": 0
  },
  "mcp": {
    "correct_answer": 43,
    "near_miss": 4,
    "shrug": 3,
    "generic_menu": 0,
    "wrong_answer": 0
  },
  "channelAgreement": {
    "agree": 49,
    "of": 49
  },
  "answerableMissedInApp": [
    "waitlist-join",
    "waitlist-check",
    "location",
    "refunds",
    "deposits",
    "waitlist-manage",
    "plans",
    "plans-terse"
  ],
  "wrongInApp": [],
  "corpusGapCapabilities": [],
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
    "inApp": 0,
    "mcp": 0
  }
};
