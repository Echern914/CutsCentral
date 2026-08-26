import { resolveHref } from "@chairback/config/features";
import { apiGet } from "./api";

/**
 * One thing that wants the barber's attention right now.
 *
 * `count` is always > 0 — a signal with nothing outstanding is dropped rather
 * than listed as a zero, because a bell that opens onto "0 waiting, 0 to reply"
 * is a bell that teaches you to ignore it.
 */
export interface BellSignal {
  key: string;
  /** One line, already pluralised. Written as a thing to DO, not a category. */
  label: string;
  count: number;
  /** Resolved from the feature registry — never a route typed here. */
  href: string;
}

/**
 * Where a signal sends you. The bell used to point every waitlist alert at the
 * bare calendar route, which lands on the APPOINTMENTS tab - the queue it was
 * telling you about is one tab over. The registry knows which tab each feature
 * lives on; this stops the bell having its own opinion.
 *
 * No fallback route: a signal whose destination the registry withholds is
 * dropped instead, on the same principle as a zero count. A badge you cannot
 * act on is worse than no badge.
 */
function hrefFor(featureId: string): string | null {
  return resolveHref(featureId);
}

/**
 * What the header bell shows.
 *
 * DERIVED, never stored. There is no notifications table in this schema and no
 * read-state column anywhere, so there is deliberately nothing here that marks
 * anything "seen": the badge means "N things need you right now" and decays to
 * zero as the barber works the queues. Adding a seen-flag would mean adding the
 * whole notifications backend this is specifically avoiding.
 *
 * Every source is a count that already existed and is already rendered
 * somewhere else in the product; the bell just stops those numbers being
 * invisible until you happen to open the page they live on.
 *
 * Failure is ALWAYS silent. These endpoints have different gates — the waitlist
 * and inbox are manager-only and behind the paywall, readiness is neither — so
 * a 403 or 402 here is a normal answer for an employee seat or a lapsed shop,
 * not an error. A signal that cannot be read is simply not shown; the header
 * must never break because a count was unavailable.
 */
export async function collectNotificationSignals(opts: {
  /** Employee seat: the manager-only counts would 403, so they aren't asked for. */
  barberOnly: boolean;
  /** Premium AI locked: the receptionist inbox is permanently 0 for this shop. */
  premiumAiLocked: boolean;
}): Promise<BellSignal[]> {
  const [readiness, waitlist, inbox] = await Promise.all([
    apiGet<ReadinessSummary>("/api/readiness/summary"),
    opts.barberOnly
      ? null
      : apiGet<{ counts?: { WAITING?: number } }>(
          // limit=1 — the rows are thrown away, only `counts` is wanted. Same
          // trick the calendar's waitlist badge uses.
          "/api/dashboard/waitlist?status=WAITING&limit=1",
        ),
    opts.barberOnly || opts.premiumAiLocked
      ? null
      : apiGet<{ escalatedCount?: number }>(
          "/api/dashboard/receptionist/conversations",
        ),
  ]);

  const out: BellSignal[] = [];

  // Setup first: it is the only signal an employee seat or a lapsed shop can
  // see, and it is the one that blocks a shop from taking real bookings.
  const setup = readinessCount(readiness.ok ? readiness.data : null);
  if (setup) out.push(setup);

  const waiting = waitlist?.ok ? (waitlist.data?.counts?.WAITING ?? 0) : 0;
  const waitlistHref = hrefFor("waitlist");
  if (waiting > 0 && waitlistHref) {
    out.push({
      key: "waitlist",
      label: `${waiting} ${waiting === 1 ? "person" : "people"} waiting`,
      count: waiting,
      href: waitlistHref,
    });
  }

  const escalated = inbox?.ok ? (inbox.data?.escalatedCount ?? 0) : 0;
  const inboxHref = hrefFor("inbox");
  if (escalated > 0 && inboxHref) {
    out.push({
      key: "inbox",
      label: `${escalated} ${escalated === 1 ? "conversation needs" : "conversations need"} a reply`,
      count: escalated,
      href: inboxHref,
    });
  }

  return out;
}

interface ReadinessSummary {
  scope?: "shop" | "barber";
  /** Manager shape: milestones that block going live. */
  milestonesBlocking?: number;
  /** Employee shape: only what THEY can finish. */
  incompletePersonal?: number;
}

/**
 * Readiness answers in two shapes depending on who is asking — the route is
 * role-aware, so a manager gets shop milestones and an employee gets only the
 * tasks they personally can complete. Reading the wrong field would show an
 * employee a number they cannot act on.
 */
function readinessCount(data: ReadinessSummary | null): BellSignal | null {
  if (!data) return null;
  const n =
    data.scope === "barber"
      ? (data.incompletePersonal ?? 0)
      : (data.milestonesBlocking ?? 0);
  if (n <= 0) return null;
  const href = hrefFor("assistant");
  if (!href) return null;
  return {
    key: "readiness",
    label:
      data.scope === "barber"
        ? `${n} thing${n === 1 ? "" : "s"} left to set up`
        : `${n} step${n === 1 ? "" : "s"} before you can go live`,
    count: n,
    // Setup now has a home of its own: the Assistant's Continue-setup card,
    // which shows the next milestone rather than the whole eleven-item list.
    href,
  };
}
