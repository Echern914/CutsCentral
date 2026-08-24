/**
 * Shop + barber launch readiness: "can this shop actually take a real customer
 * yet, and if not, what exactly is missing?"
 *
 * WHY THIS EXISTS. Creating a shop writes a Shop row, one Reward and the owner's
 * seat - and nothing else. No Staff, no Service, no AvailabilityRule, while
 * `publicPageEnabled` defaults TRUE. So a brand-new shop has a live, reachable
 * public URL and literally nothing behind it, and the only things that ever said
 * so were a hard-coded card that hides itself once a client exists and a
 * `staff.length === 0 || services.length === 0` check on the Booking tab that
 * misses the commonest real failure (staff and services both present, but no
 * ServiceStaff pair joining them, so nothing is bookable).
 *
 * THE SHAPE IS DELIBERATELY ops/preflight.ts's. That module answers the same
 * question one level up ("is this DEPLOYMENT configured?") and has held up: a
 * PURE function over injected facts, returning a flat list of checks with a
 * severity, what is true right now, and what breaks while it is false. It is
 * unit-testable with no database and cannot drift from the subsystems it
 * describes, because it never re-implements their rules - it is handed their
 * answers. Everything here follows that, and the platform capability booleans
 * are literally the same helpers, so the shop engine and the operator preflight
 * can never disagree about what the platform can do.
 *
 * TWO LAYERS, ONE SOURCE OF TRUTH. `items` are the granular verified checks;
 * `milestones` are exactly four fixed customer-facing groups computed FROM those
 * items. The split exists because a new barber must never be shown "6 of 11
 * complete" - they get "2 of 4" - while Settings still needs the real list. Both
 * come out of this one function, so a future dashboard card and a future
 * settings page cannot group the rules differently.
 *
 * READ-ONLY, ALWAYS. Nothing in this module or its callers writes. Readiness
 * reports; it never repairs, never toggles a flag, and in particular never
 * touches `publicPageEnabled`. An existing live shop can fail a check here and
 * stays live - see `goLiveGateApplies` in the report and the note on it.
 *
 * NO STORED COMPLETION STATE. There is no checklist table and there must never
 * be one: a stored "done" is a claim, and claims drift from the data they
 * describe. Every answer below is derived from canonical rows at read time.
 */

/** How hard an item is. */
export type ReadinessClass = "required" | "conditional" | "recommended" | "info";

/** Who a check belongs to. */
export type ReadinessScope = "shop" | "staff";

/**
 * The four customer-facing groups. FIXED AND EXHAUSTIVE - future UI renders
 * these and only these, so the order here is the order a barber sees.
 */
export const MILESTONE_IDS = [
  "shop",
  "services_and_barber",
  "hours_and_alerts",
  "preview_and_go_live",
] as const;
export type MilestoneId = (typeof MILESTONE_IDS)[number];

const MILESTONE_TITLES: Record<MilestoneId, string> = {
  shop: "Your shop",
  services_and_barber: "Services and barber",
  hours_and_alerts: "Hours and alerts",
  preview_and_go_live: "Preview and go live",
};

/** Minimum bookable service length. Mirrors the API's own service schema
 *  (`durationMin: z.number().int().min(5)` in routes/booking.dashboard.ts) so a
 *  service that could never have been saved is not reported as a problem. */
export const MIN_SERVICE_MINUTES = 5;

/** The lowest role that can actually resolve an item. */
export type ReadinessRole = "owner" | "manager" | "barber";

export interface ReadinessCta {
  /** Plain-language button text. */
  label: string;
  /** Dashboard path, deep-linked (?tab=/#anchor) where the surface supports it. */
  href: string;
}

export interface ReadinessItem {
  /** Stable across releases. UI, analytics and the defer list key off this. */
  id: string;
  scope: ReadinessScope;
  /** Which of the four groups this rolls up into. null = post-launch polish. */
  milestone: MilestoneId | null;
  title: string;
  /** One line: why a customer's booking depends on this. Always safe to show. */
  why: string;
  klass: ReadinessClass;
  /** false = not relevant to this shop right now; hidden entirely. */
  applicable: boolean;
  /** VERIFIED from canonical data. Never self-reported. */
  done: boolean;
  /**
   * Never render while `done`. The automatic technical checks (name, slug,
   * timezone, booking source, pair validity, booking window) are noise when
   * green and the only thing that matters when red.
   */
  silentWhenDone: boolean;
  /** What is true right now, in plain language. NEVER contains customer data. */
  evidence: string;
  /** required && applicable && !done. Precomputed so no caller re-derives it. */
  blocksLaunch: boolean;
  /** Recommended items may be dismissed by a future UI; nothing else may. */
  deferrable: boolean;
  role: ReadinessRole;
  /** Where a future UI will send someone to fix it. null = nothing to open. */
  cta: ReadinessCta | null;
  /** Set on scope === "staff". Identifies the chair, never the person. */
  staffId?: string;
}

export interface Milestone {
  id: MilestoneId;
  title: string;
  /** Every APPLICABLE REQUIRED item in this group is done. */
  done: boolean;
  /** The applicable required items in this group that are not done. */
  blocking: ReadinessItem[];
  /** Denominator/numerator for this group alone (required + applicable conditional). */
  applicableCount: number;
  completeCount: number;
}

export interface StaffReadiness {
  staffId: string;
  /** Chair name. Business data, not personal contact data. */
  name: string;
  active: boolean;
  items: ReadinessItem[];
  blocking: ReadinessItem[];
  applicableCount: number;
  completeCount: number;
  /** This chair alone could take a booking (active, hours, a service, reachable). */
  bookable: boolean;
}

export interface ReadinessReport {
  shopId: string;
  /** The public page is on AND the booking source can actually serve it. */
  liveNow: boolean;
  /** No applicable required item is outstanding. */
  canGoLive: boolean;
  /**
   * Whether a future go-live gate would apply to THIS shop.
   *
   * Always false here, on purpose. B1 ships no gate and no `Shop.goLiveAt`
   * column, and an already-published shop must never be blocked retroactively.
   * The field exists now so the report shape does not change when the gate
   * lands, and so no caller invents its own rule in the meantime.
   */
  goLiveGateApplies: boolean;
  /** Exactly four, always, in MILESTONE_IDS order. */
  milestones: Milestone[];
  /** 0..4 - the ONLY progress number a new shop is shown. */
  milestonesComplete: number;
  /** How many of the four have at least one blocking item. */
  milestonesBlocking: number;
  /** Every applicable required item that is outstanding, across all groups. */
  blocking: ReadinessItem[];
  /** The granular checks, for the detailed Settings view. */
  items: ReadinessItem[];
  /** Post-launch polish. Never blocks; all deferrable. */
  improve: ReadinessItem[];
  /** Detailed-view counts: required + APPLICABLE conditional. Recommended and
   *  info are excluded, so polishing a bio can never inflate progress and
   *  turning a feature on can legitimately lower it. */
  applicableRequiredCount: number;
  completeRequiredCount: number;
  /** Per-chair readiness for every chair (owner/manager view). */
  staff: StaffReadiness[];
}

// ---------------------------------------------------------------------------
// Facts - what the collector must hand in. Counts, booleans and ids only: no
// customer rows, no phone numbers, no email addresses.
// ---------------------------------------------------------------------------

/** One chair, plus everything needed to judge it. */
export interface StaffFacts {
  id: string;
  name: string;
  active: boolean;
  /** Weekly AvailabilityRule rows for this chair. */
  availabilityRuleCount: number;
  /** ServiceStaff rows joining this chair to an ACTIVE service. Answers "does
   *  this chair offer anything at all", NOT "can it be booked". */
  activeServiceLinkCount: number;
  /**
   * ServiceStaff rows joining this chair to a service that is active AND long
   * enough AND open on at least one weekday - i.e. a link a customer could
   * really book.
   *
   * 🔑 SEPARATE FROM activeServiceLinkCount ON PURPOSE. A chair linked only to a
   * service that is closed every weekday has an active link and zero bookable
   * ones, and an unrelated open service elsewhere in the shop must not paper
   * over that. Bookability decisions read THIS field.
   */
  bookableServiceLinkCount: number;
  hasPhoto: boolean;
  hasBio: boolean;
  /** ShopMember.staffId points at this chair (the seat that works it). */
  seatLinked: boolean;
  /** Who alerts for this chair go to: Staff.userId, else the owner (#269). */
  recipientUserId: string;
  /** True when the recipient is the owner only because no seat holds the chair. */
  recipientIsOwnerFallback: boolean;
}

/**
 * A person's alert reachability. Counts and booleans only - never an endpoint,
 * token, phone number or email address.
 */
export interface RecipientFacts {
  userId: string;
  /** Resolved prefs (absent row = NOTIFY_DEFAULTS, resolved by the collector). */
  pushEnabled: boolean;
  smsEnabled: boolean;
  emailEnabled: boolean;
  /**
   * The per-EVENT switch for "someone just booked". A recipient with every
   * channel wired up but this off is told nothing about a new booking, which is
   * precisely the event launch readiness is about.
   */
  newBookingEnabled: boolean;
  /**
   * Web-push subscriptions, SPLIT FROM Expo because they need different things:
   * a web subscription is undeliverable without VAPID, while an Expo token is
   * posted to Expo and needs no server key at all. One undifferentiated device
   * count cannot answer "is this person reachable" on a deployment with no VAPID.
   */
  webDeviceCount: number;
  /** Native-app (Expo) devices. Deliverable without VAPID. */
  expoDeviceCount: number;
  /** A number exists (own pref, else the shop's alert line). */
  hasPhone: boolean;
  /** The user account has an email address on file. */
  hasEmail: boolean;
}

export interface ServiceFacts {
  id: string;
  name: string;
  active: boolean;
  durationMin: number;
  hasPrice: boolean;
  /** ServiceStaff rows joining this service to an ACTIVE chair. */
  activeStaffLinkCount: number;
  /** hoursWindows says "not offered" on every weekday - active but unbookable. */
  closedEveryWeekday: boolean;
}

export interface ReadinessFacts {
  shopId: string;
  name: string;
  timezone: string;
  /** Whether `timezone` is a zone this runtime can actually resolve. */
  timezoneValid: boolean;
  slug: string | null;
  publicPageEnabled: boolean;
  bookingMode: string;
  bookingUrl: string | null;
  bookingLeadHours: number;
  bookingMaxDays: number;
  /** hasActiveAccess(shop) - trial, subscription or comp. */
  hasActiveAccess: boolean;

  staff: StaffFacts[];
  services: ServiceFacts[];
  /** Distinct (active service, active chair) pairs. The real bookability test. */
  activeOfferingPairs: number;
  recipients: RecipientFacts[];
  /** A shop-wide alert number is set. Boolean only. */
  shopNotifyPhone: boolean;
  /** Any Appointment has ever existed (the offered test booking is satisfied). */
  hasAnyAppointment: boolean;

  // Feature switches - each turns its conditional item on.
  paymentsMode: string;
  connectChargesEnabled: boolean;
  hasConnectAccount: boolean;
  depositAmountCents: number | null;
  payDirectEnabled: boolean;
  payDirectHandleCount: number;
  cancelWindowHours: number;
  cancelFeeBps: number;
  requireBookingApproval: boolean;
  waitlistEnabled: boolean;
  takesRequests: boolean;
  rewardsEnabled: boolean;
  activeRewardCount: number;
  receptionistEnabled: boolean;
  receptionistTermsAccepted: boolean;
  receptionistEntitled: boolean;
  /** The OAuth row for the shop's chosen external booking source exists. */
  integrationConnected: boolean;
}

/**
 * Platform-wide capabilities, injected rather than imported so this stays pure.
 * Each maps 1:1 to the subsystem helper of the same name - the same ones
 * ops/preflight.ts is fed.
 */
export interface ReadinessCapabilities {
  /** Resend configured. Says nothing about DRY_RUN - see below. */
  email: boolean;
  /** VAPID configured. WEB push only; Expo does not need it. */
  webPush: boolean;
  /** A real Twilio transport is configured. */
  sms: boolean;
  connect: boolean;
  receptionist: boolean;
  /**
   * DRY_RUN - the global kill switch. Kept SEPARATE from each transport's own
   * "configured" flag so readiness can say which of the two is wrong. It
   * suppresses every channel: web push and Expo (messaging/push.ts returns
   * early), SMS (getMessageProvider returns the Noop provider) and email
   * (sendEmail returns status "dry_run"). A configured key therefore does NOT
   * mean anything is deliverable while this is true.
   */
  dryRun: boolean;
  /** A2P campaigns configured; 0 = no shop ever gets its own number. */
  messagingCampaigns: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface ItemInput {
  id: string;
  scope?: ReadinessScope;
  milestone: MilestoneId | null;
  title: string;
  why: string;
  klass: ReadinessClass;
  applicable?: boolean;
  done: boolean;
  silentWhenDone?: boolean;
  evidence: string;
  role?: ReadinessRole;
  cta?: ReadinessCta | null;
  staffId?: string;
}

function item(i: ItemInput): ReadinessItem {
  const applicable = i.applicable ?? true;
  return {
    id: i.id,
    scope: i.scope ?? "shop",
    milestone: i.milestone,
    title: i.title,
    why: i.why,
    klass: i.klass,
    applicable,
    done: i.done,
    silentWhenDone: i.silentWhenDone ?? false,
    evidence: i.evidence,
    blocksLaunch: i.klass === "required" && applicable && !i.done,
    deferrable: i.klass === "recommended",
    role: i.role ?? "manager",
    cta: i.cta ?? null,
    ...(i.staffId ? { staffId: i.staffId } : {}),
  };
}

const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;

/** Native booking means ChairBack itself serves the slots and takes the booking. */
function isNative(f: ReadinessFacts): boolean {
  return f.bookingMode === "native";
}

/**
 * Can this ONE chair take a booking by itself? Active, works some day, offers a
 * service that is really bookable, and a new booking on it genuinely reaches
 * somebody.
 *
 * 🔴 ALL FOUR ON THE SAME CHAIR. Checking them independently across the shop
 * passes a shop where chair A has hours but no service and chair B has a service
 * but no hours - every individual check is satisfied by SOMEBODY and nothing is
 * bookable. That is what `shop.bookable_chair` exists to catch.
 */
function chairBookable(
  s: StaffFacts,
  recipient: RecipientFacts | undefined,
  caps: ReadinessCapabilities,
): boolean {
  return (
    s.active &&
    s.availabilityRuleCount > 0 &&
    // Bookable, not merely linked: a chair whose only service is closed every
    // weekday offers nothing, however many other services the shop has.
    s.bookableServiceLinkCount > 0 &&
    reachable(recipient, caps)
  );
}

/**
 * Would a NEW-BOOKING alert to this person actually be delivered?
 *
 * Four things have to line up, and the earlier version checked only the last
 * two - a stored preference and a stored destination - which is not evidence of
 * delivery:
 *
 *   1. the per-event switch is on (`newBookingEnabled`); a recipient wired up on
 *      every channel who turned new-booking alerts off hears nothing,
 *   2. DRY_RUN is off; while it is on EVERY transport is suppressed and a
 *      "configured" key delivers nothing,
 *   3. that specific transport is configured, and
 *   4. a destination for it exists.
 *
 * The transports genuinely differ, so they are evaluated separately rather than
 * as one device count:
 *   - WEB push needs VAPID. Without it a web subscription is undeliverable.
 *   - EXPO push is posted to Expo and needs no server key, so a native device is
 *     deliverable on a deployment with no VAPID at all.
 *   - SMS needs a real Twilio transport, not just a saved number.
 *   - EMAIL needs the Resend seam AND an address on the account.
 */
function reachable(
  r: RecipientFacts | undefined,
  caps: ReadinessCapabilities,
): boolean {
  return deliverableChannels(r, caps).length > 0;
}

/** Which channels would really carry a new-booking alert. Names only. */
function deliverableChannels(
  r: RecipientFacts | undefined,
  caps: ReadinessCapabilities,
): Array<"app" | "browser" | "text" | "email"> {
  if (!r) return [];
  // The per-event switch and the global kill switch gate every channel at once.
  if (!r.newBookingEnabled) return [];
  if (caps.dryRun) return [];
  const out: Array<"app" | "browser" | "text" | "email"> = [];
  if (r.pushEnabled && r.expoDeviceCount > 0) out.push("app");
  if (r.pushEnabled && caps.webPush && r.webDeviceCount > 0) out.push("browser");
  if (r.smsEnabled && caps.sms && r.hasPhone) out.push("text");
  if (r.emailEnabled && caps.email && r.hasEmail) out.push("email");
  return out;
}

/** Why a recipient is NOT reachable, in the customer's words. */
function unreachableReason(
  r: RecipientFacts | undefined,
  caps: ReadinessCapabilities,
): string {
  if (!r) return "No one is set to receive these alerts";
  if (caps.dryRun) {
    return "Message sending is switched off on this ChairBack deployment - no alert would actually be delivered";
  }
  if (!r.newBookingEnabled) {
    return "New-booking alerts are switched off, so a booking would notify nobody";
  }
  const hasWebOnly =
    r.pushEnabled && r.webDeviceCount > 0 && r.expoDeviceCount === 0 && !caps.webPush;
  if (hasWebOnly) {
    return "The only registered device is a browser, and browser notifications are not configured on this deployment";
  }
  if (r.smsEnabled && r.hasPhone && !caps.sms) {
    return "A text number is saved but texting is not configured on this deployment";
  }
  if (r.emailEnabled && r.hasEmail && !caps.email) {
    return "Email alerts are on but email is not configured on this deployment";
  }
  return "No registered device and no alert number - a booking would reach nobody";
}

function recipientOf(
  facts: ReadinessFacts,
  s: StaffFacts,
): RecipientFacts | undefined {
  return facts.recipients.find((r) => r.userId === s.recipientUserId);
}

/** Per-chair items. Business data only - a chair's name, never a person's. */
function staffItems(
  facts: ReadinessFacts,
  s: StaffFacts,
  caps: ReadinessCapabilities,
): ReadinessItem[] {
  const r = recipientOf(facts, s);
  const channels = deliverableChannels(r, caps);
  const shopHasSeats = facts.staff.some((x) => x.seatLinked);
  return [
    item({
      id: "staff.active",
      scope: "staff",
      staffId: s.id,
      milestone: "services_and_barber",
      title: "Chair is active",
      why: "An inactive chair is hidden from customers entirely.",
      klass: "required",
      done: s.active,
      evidence: s.active ? "Active" : "Deactivated - customers cannot see this chair",
      role: "manager",
      cta: { label: "Open Staff", href: "/dashboard/booking?tab=Staff" },
    }),
    item({
      id: "staff.hours",
      scope: "staff",
      staffId: s.id,
      milestone: "hours_and_alerts",
      title: "Weekly hours are set",
      why: "Without hours this chair offers no times at all.",
      klass: "required",
      done: s.availabilityRuleCount > 0,
      evidence:
        s.availabilityRuleCount > 0
          ? `${plural(s.availabilityRuleCount, "weekly time block")} saved`
          : "No weekly hours saved",
      role: "manager",
      cta: { label: "Set hours", href: "/dashboard/booking?tab=Staff" },
    }),
    item({
      id: "staff.services",
      scope: "staff",
      staffId: s.id,
      milestone: "services_and_barber",
      title: "Offers at least one service",
      why: "A chair with no services assigned cannot be booked for anything.",
      klass: "required",
      done: s.activeServiceLinkCount > 0,
      evidence:
        s.activeServiceLinkCount > 0
          ? `Offers ${plural(s.activeServiceLinkCount, "service")}`
          : "No services assigned to this chair",
      role: "manager",
      cta: { label: "Assign services", href: "/dashboard/booking?tab=Services" },
    }),
    item({
      id: "staff.alerts_reachable",
      scope: "staff",
      staffId: s.id,
      milestone: "hours_and_alerts",
      title: "Bookings reach whoever works this chair",
      why: "A booking nobody is told about is a missed appointment.",
      klass: "required",
      done: channels.length > 0,
      evidence:
        channels.length > 0
          ? `Delivered by ${channels.join(", ")}`
          : unreachableReason(r, caps),
      role: "barber",
      cta: { label: "Turn on alerts", href: "/dashboard/account" },
    }),
    item({
      id: "staff.seat_linked",
      scope: "staff",
      staffId: s.id,
      milestone: "hours_and_alerts",
      // Only meaningful once the shop actually has team logins. A solo shop's
      // single chair correctly routes to the owner and must not be nagged.
      applicable: shopHasSeats && s.active,
      title: "Chair is linked to a login",
      why: "Until the chair is linked to someone's login, its bookings alert the owner instead of them.",
      klass: "conditional",
      done: s.seatLinked,
      evidence: s.seatLinked
        ? "Linked to a team member"
        : "Not linked - this chair's alerts go to the shop owner",
      role: "owner",
      cta: { label: "Link a login", href: "/dashboard/team" },
    }),
    item({
      id: "staff.photo_bio",
      scope: "staff",
      staffId: s.id,
      milestone: null,
      title: "Photo and short bio",
      why: "Customers pick a barber they can see. Nothing breaks without it.",
      klass: "recommended",
      done: s.hasPhoto && s.hasBio,
      evidence:
        s.hasPhoto && s.hasBio
          ? "Photo and bio added"
          : s.hasPhoto
            ? "Photo added, no bio yet"
            : s.hasBio
              ? "Bio added, no photo yet"
              : "No photo or bio yet",
      role: "manager",
      cta: { label: "Edit chair", href: "/dashboard/booking?tab=Staff" },
    }),
  ];
}

/** Shop-wide items. */
function shopItems(
  facts: ReadinessFacts,
  caps: ReadinessCapabilities,
  bookableChairs: StaffFacts[],
): ReadinessItem[] {
  const native = isNative(facts);
  const activeStaff = facts.staff.filter((s) => s.active);
  const activeServices = facts.services.filter((s) => s.active);
  const validDuration = activeServices.filter(
    (s) => s.durationMin >= MIN_SERVICE_MINUTES,
  );
  const closedAllWeek = activeServices.filter((s) => s.closedEveryWeekday);
  const externalMode = !native && facts.bookingMode !== "link";
  const leadDays = facts.bookingLeadHours / 24;
  const windowOk = leadDays < facts.bookingMaxDays;
  const pricedServices = activeServices.filter((s) => s.hasPrice);
  const paymentsOn = facts.paymentsMode !== "off";
  // Anyone who would actually be told about a booking. `recipients` is already
  // "every active chair's recipient, plus the owner as the fallback", so a shop
  // with no chairs yet still has the owner here - which is correct: the owner is
  // who a booking would alert.
  const reachableRecipients = facts.recipients.filter((r) => reachable(r, caps));
  // Which channels would really carry an alert to ANY of them - used for the
  // evidence line, so it names transports rather than a device tally.
  const shopChannels = [
    ...new Set(reachableRecipients.flatMap((r) => deliverableChannels(r, caps))),
  ];

  const items: ReadinessItem[] = [
    // ----- Milestone 1: your shop (all silent while passing) -----
    item({
      id: "shop.name",
      milestone: "shop",
      title: "Shop name",
      why: "Your name appears on the booking page and in every message to a customer.",
      klass: "required",
      done: facts.name.trim().length > 0,
      silentWhenDone: true,
      evidence: facts.name.trim() ? `Set to "${facts.name.trim()}"` : "Not set",
      cta: { label: "Open settings", href: "/dashboard" },
    }),
    item({
      id: "shop.timezone",
      milestone: "shop",
      title: "Time zone",
      why: "Every opening time, reminder and quiet-hours rule is read in this zone. A wrong one shifts every slot.",
      klass: "required",
      done: facts.timezoneValid,
      silentWhenDone: true,
      evidence: facts.timezoneValid
        ? `Set to ${facts.timezone}`
        : `"${facts.timezone}" is not a time zone this system recognises`,
      cta: { label: "Open settings", href: "/dashboard" },
    }),
    item({
      id: "shop.slug",
      milestone: "shop",
      title: "Booking link",
      why: "The link you share with customers. Without one there is no page to send anyone to.",
      klass: "required",
      done: Boolean(facts.slug),
      silentWhenDone: true,
      evidence: facts.slug ? `getchairback.com/book/${facts.slug}` : "No link yet",
      cta: { label: "Open your page", href: "/dashboard/site" },
    }),
    item({
      id: "shop.booking_source",
      milestone: "shop",
      title: "Booking source",
      why: "Customers need one working way to book - ChairBack's own booking, or a link to the system you already use.",
      klass: "required",
      done: native || Boolean(facts.bookingUrl?.trim()),
      silentWhenDone: true,
      evidence: native
        ? "ChairBack booking is on"
        : facts.bookingUrl?.trim()
          ? `Sending customers to your ${facts.bookingMode} link`
          : `Set to ${facts.bookingMode}, but no booking link is saved - your page has no way to book`,
      cta: { label: "Booking settings", href: "/dashboard/booking?tab=Settings" },
    }),

    // ----- Milestone 2: services and barber -----
    item({
      id: "shop.staff.active",
      milestone: "services_and_barber",
      title: "At least one barber",
      why: "Customers pick a barber before they pick a time.",
      klass: "required",
      done: activeStaff.length > 0,
      evidence:
        activeStaff.length > 0
          ? `${plural(activeStaff.length, "active barber")}`
          : "No active barbers yet",
      cta: { label: "Add a barber", href: "/dashboard/booking?tab=Staff" },
    }),
    item({
      id: "shop.service.active",
      milestone: "services_and_barber",
      title: "At least one service",
      why: "The service is what a customer actually books.",
      klass: "required",
      done: activeServices.length > 0,
      evidence:
        activeServices.length > 0
          ? `${plural(activeServices.length, "active service")}`
          : "No active services yet",
      cta: { label: "Add a service", href: "/dashboard/booking?tab=Services" },
    }),
    item({
      id: "shop.service.duration",
      milestone: "services_and_barber",
      // Only meaningful once a service exists; otherwise it duplicates the item
      // above and reports the same gap twice.
      applicable: activeServices.length > 0,
      title: "Services have a real length",
      why: "The length decides how much of the day a booking takes and where the next slot starts.",
      klass: "required",
      done: validDuration.length > 0,
      silentWhenDone: true,
      evidence:
        validDuration.length > 0
          ? `${plural(validDuration.length, "service")} with a valid length`
          : `No active service is at least ${MIN_SERVICE_MINUTES} minutes long`,
      cta: { label: "Edit services", href: "/dashboard/booking?tab=Services" },
    }),
    item({
      id: "shop.offering.pair",
      milestone: "services_and_barber",
      // Native only (an external source keeps its own map), and only once there
      // is something on BOTH sides to join. With no barbers or no services the
      // gap is already named by its own item, and reporting the same root cause
      // twice makes one fix look like two.
      applicable: native && activeStaff.length > 0 && activeServices.length > 0,
      title: "A service is assigned to a barber",
      why: "Barbers and services can both exist while no barber actually offers any of them - which leaves nothing bookable.",
      klass: "required",
      done: facts.activeOfferingPairs > 0,
      evidence:
        facts.activeOfferingPairs > 0
          ? `${plural(facts.activeOfferingPairs, "service-to-barber assignment")}`
          : activeStaff.length > 0 && activeServices.length > 0
            ? "You have barbers and services, but none are assigned to each other"
            : "Nothing assigned yet",
      cta: { label: "Assign services", href: "/dashboard/booking?tab=Services" },
    }),
    item({
      id: "shop.service.hours_open",
      milestone: "services_and_barber",
      applicable: native && activeServices.length > 0,
      title: "Services are offered on some day",
      why: "A service can be switched off for every weekday and still look active - it will simply never appear.",
      klass: "required",
      done: closedAllWeek.length < activeServices.length,
      silentWhenDone: true,
      evidence:
        closedAllWeek.length === 0
          ? "All services are offered on at least one day"
          : closedAllWeek.length < activeServices.length
            ? `${plural(closedAllWeek.length, "service is", "services are")} closed every day of the week`
            : "Every active service is closed on every day of the week",
      cta: { label: "Edit services", href: "/dashboard/booking?tab=Services" },
    }),

    item({
      id: "shop.bookable_chair",
      milestone: "services_and_barber",
      // Only once there is a barber AND a service; before that the gap is
      // already named by its own item.
      applicable: native && activeStaff.length > 0 && activeServices.length > 0,
      title: "One barber is completely ready",
      why: "Every other check can be satisfied by a DIFFERENT barber - one has hours, another has a service - and still leave nothing a customer can actually book. This is the one that says a single chair works end to end.",
      klass: "required",
      done: bookableChairs.length > 0,
      evidence:
        bookableChairs.length > 0
          ? `${bookableChairs.map((c) => c.name).join(", ")} ${bookableChairs.length === 1 ? "is" : "are"} ready to take bookings`
          : activeStaff.length === 0
            ? "No active barbers"
            : // Name the nearest chair and what it is missing, so this is one
              // fix rather than a puzzle.
              (() => {
                const nearest = activeStaff[0]!;
                const missing = [
                  nearest.availabilityRuleCount === 0 ? "weekly hours" : null,
                  nearest.bookableServiceLinkCount === 0
                    ? nearest.activeServiceLinkCount > 0
                      ? "a service that is open on some day"
                      : "a service"
                    : null,
                  reachable(recipientOf(facts, nearest), caps) ? null : "a working alert",
                ].filter(Boolean);
                return `No single barber is fully set up - ${nearest.name} still needs ${missing.join(" and ")}`;
              })(),
      cta: { label: "Open Staff", href: "/dashboard/booking?tab=Staff" },
    }),

    // ----- Milestone 3: hours and alerts -----
    item({
      id: "shop.availability.rule",
      milestone: "hours_and_alerts",
      // Only meaningful once someone exists to have hours; otherwise this
      // restates "you have no barbers".
      applicable: native && activeStaff.length > 0,
      title: "Someone works some day",
      why: "With no hours anywhere, the calendar has no day a customer can pick.",
      klass: "required",
      done: activeStaff.some((s) => s.availabilityRuleCount > 0),
      evidence: activeStaff.some((s) => s.availabilityRuleCount > 0)
        ? `${plural(activeStaff.filter((s) => s.availabilityRuleCount > 0).length, "barber has", "barbers have")} hours set`
        : "No barber has any weekly hours",
      cta: { label: "Set hours", href: "/dashboard/booking?tab=Staff" },
    }),
    item({
      id: "shop.booking.window",
      milestone: "hours_and_alerts",
      applicable: native,
      title: "Booking window makes sense",
      why: "If the earliest bookable time is further out than the furthest bookable date, every slot falls outside the window and the calendar is permanently empty.",
      klass: "required",
      done: windowOk,
      silentWhenDone: true,
      evidence: windowOk
        ? `Bookable from ${facts.bookingLeadHours}h ahead, up to ${facts.bookingMaxDays} days out`
        : `Earliest booking is ${facts.bookingLeadHours}h away but the furthest is ${facts.bookingMaxDays} day${facts.bookingMaxDays === 1 ? "" : "s"} - nothing can be booked`,
      cta: { label: "Booking settings", href: "/dashboard/booking?tab=Settings" },
    }),
    item({
      id: "shop.alerts.reachable",
      milestone: "hours_and_alerts",
      title: "You hear about a booking",
      why: "A new shop's default is push on with no device registered and texts on with no number saved - which reaches nobody at all.",
      klass: "required",
      // REACHABILITY ONLY, deliberately not "a chair is fully set up". Whether a
      // chair has hours or services is already checked by its own items, and
      // reporting the same root cause twice ("no barber" AND "alerts reach
      // nobody") makes a one-fix problem look like two.
      done: reachableRecipients.length > 0,
      evidence:
        reachableRecipients.length > 0
          ? `A new booking would reach you by ${shopChannels.join(", ")}`
          : unreachableReason(facts.recipients[0], caps),
      role: "barber",
      cta: { label: "Turn on alerts", href: "/dashboard/account" },
    }),
    item({
      id: "platform.email",
      milestone: "hours_and_alerts",
      // Only when ChairBack itself takes the booking and owes the confirmation.
      applicable: native,
      title: "Customer confirmations can be sent",
      why: "Booking confirmations go out by email only - the confirmation text is deliberately off for cost - so without email a customer is told nothing at all.",
      klass: "required",
      // DRY_RUN suppresses email exactly like every other channel (sendEmail
      // returns status "dry_run"), so a configured Resend key does NOT mean a
      // customer would receive anything.
      done: caps.email && !caps.dryRun,
      silentWhenDone: true,
      evidence: caps.dryRun
        ? "Message sending is switched off on this ChairBack deployment - a customer would get no confirmation"
        : caps.email
          ? "Confirmation emails are configured"
          : "Email is not configured on this ChairBack deployment - contact support; this is not something you can fix in settings",
      role: "owner",
      cta: null,
    }),

    // ----- Milestone 4: preview and go live -----
    // shop.preflight is appended by the builder once every other item is known.
    item({
      id: "shop.test_booking",
      milestone: "preview_and_go_live",
      title: "See a booking come through",
      why: "The fastest way to know it all works end to end. Offered, never required - a real customer booking counts too.",
      klass: "recommended",
      done: facts.hasAnyAppointment,
      evidence: facts.hasAnyAppointment
        ? "A booking has come through"
        : "No bookings yet",
      cta: { label: "Try a test booking", href: "/dashboard/booking?tab=Appointments" },
    }),
  ];

  // ----- Conditional: only when the shop chose the feature -----
  items.push(
    item({
      id: "payments.connect_ready",
      milestone: "hours_and_alerts",
      applicable: paymentsOn,
      title: "Card payments are ready to charge",
      why: "Payments are switched on, so a customer would be sent to a checkout that has to be able to settle.",
      klass: "conditional",
      done: caps.connect && facts.hasConnectAccount && facts.connectChargesEnabled,
      evidence: !caps.connect
        ? "Card payments are not configured on this ChairBack deployment"
        : !facts.hasConnectAccount
          ? "No payout account connected yet"
          : facts.connectChargesEnabled
            ? "Connected and able to take payments"
            : "Connected, but Stripe has not enabled charges yet",
      role: "owner",
      cta: { label: "Open payments", href: "/dashboard/payments" },
    }),
    item({
      id: "payments.deposit_amount",
      milestone: "hours_and_alerts",
      applicable: facts.paymentsMode === "deposit",
      title: "Deposit amount is set",
      why: "In deposit mode with no amount saved, the booking goes through and charges nothing - silently.",
      klass: "conditional",
      done: (facts.depositAmountCents ?? 0) > 0,
      evidence:
        (facts.depositAmountCents ?? 0) > 0
          ? `Taking $${((facts.depositAmountCents ?? 0) / 100).toFixed(2)} at booking`
          : "Deposit mode is on but no amount is set - nothing would be charged",
      role: "owner",
      cta: { label: "Open payments", href: "/dashboard/payments" },
    }),
    item({
      id: "payments.priced_services",
      milestone: "hours_and_alerts",
      applicable: paymentsOn && activeServices.length > 0,
      title: "Services you charge for have a price",
      why: "A service with no price cannot be charged, so the booking completes without taking any money.",
      klass: "conditional",
      done: pricedServices.length === activeServices.length,
      evidence:
        pricedServices.length === activeServices.length
          ? "Every active service has a price"
          : `${plural(activeServices.length - pricedServices.length, "active service has", "active services have")} no price`,
      cta: { label: "Edit services", href: "/dashboard/booking?tab=Services" },
    }),
    item({
      id: "payments.pay_direct_handle",
      milestone: null,
      applicable: facts.payDirectEnabled,
      title: "A pay-direct handle is saved",
      why: "Pay-direct is on, so the confirmation screen promises a way to pay you directly.",
      klass: "conditional",
      done: facts.payDirectHandleCount > 0,
      evidence:
        facts.payDirectHandleCount > 0
          ? `${plural(facts.payDirectHandleCount, "payment handle")} saved`
          : "Pay-direct is on but no Zelle, Venmo or Cash App handle is saved",
      role: "owner",
      cta: { label: "Open payments", href: "/dashboard/payments" },
    }),
    item({
      id: "policy.cancel_fee_inert",
      milestone: null,
      // Only worth saying when a fee is configured but nothing can collect it.
      applicable: facts.cancelWindowHours > 0 && facts.cancelFeeBps > 0 && !paymentsOn,
      title: "Your cancellation fee cannot be charged",
      why: "A late-cancellation fee is only ever taken from a card payment, and card payments are off - so the policy currently does nothing.",
      klass: "info",
      done: true,
      evidence: `A ${facts.cancelFeeBps / 100}% fee inside ${facts.cancelWindowHours}h is configured, but payments are off`,
      role: "owner",
      cta: { label: "Open payments", href: "/dashboard/payments" },
    }),
    item({
      id: "approval.watched",
      milestone: "hours_and_alerts",
      applicable: facts.requireBookingApproval,
      title: "Someone is watching for booking requests",
      why: "Requests hold the slot and send no confirmation until you approve them, so an unwatched request is a customer left waiting.",
      klass: "conditional",
      done: reachableRecipients.length > 0,
      evidence:
        reachableRecipients.length > 0
          ? "Requests will alert you"
          : "Approval is required but nothing would alert you to a new request",
      role: "barber",
      cta: { label: "Turn on alerts", href: "/dashboard/account" },
    }),
    item({
      id: "waitlist.alert_phone",
      milestone: null,
      applicable: facts.waitlistEnabled,
      title: "Waitlist joins reach you",
      why: "The waitlist alert uses the shop's alert number; without one, joins only appear in the dashboard.",
      klass: "conditional",
      done: facts.shopNotifyPhone,
      evidence: facts.shopNotifyPhone
        ? "An alert number is saved"
        : "No shop alert number - waitlist joins land in the dashboard only",
      cta: { label: "Booking settings", href: "/dashboard/booking?tab=Settings" },
    }),
    item({
      id: "requests.alert_phone",
      milestone: null,
      applicable: facts.takesRequests,
      title: "Appointment requests reach you",
      why: "The lead form texts the shop's alert number on each new request; without one they only appear in the inbox.",
      klass: "conditional",
      done: facts.shopNotifyPhone,
      evidence: facts.shopNotifyPhone
        ? "An alert number is saved"
        : "No shop alert number - requests land in the inbox only",
      cta: { label: "Open your page", href: "/dashboard/site" },
    }),
    item({
      id: "rewards.active_reward",
      milestone: null,
      applicable: facts.rewardsEnabled,
      title: "At least one reward to earn",
      why: "Punch cards are on, so customers are collecting punches toward something.",
      klass: "conditional",
      done: facts.activeRewardCount > 0,
      evidence:
        facts.activeRewardCount > 0
          ? `${plural(facts.activeRewardCount, "reward")} available`
          : "Punch cards are on but there is nothing to redeem",
      cta: { label: "Open rewards", href: "/dashboard/rewards" },
    }),
    item({
      id: "receptionist.ready",
      milestone: null,
      applicable: facts.receptionistEnabled,
      title: "AI receptionist can answer",
      why: "The receptionist needs ChairBack booking, the add-on, and your acknowledgement before it can reply to anyone.",
      klass: "conditional",
      done:
        caps.receptionist &&
        native &&
        facts.receptionistTermsAccepted &&
        facts.receptionistEntitled,
      evidence: !caps.receptionist
        ? "The receptionist is not configured on this ChairBack deployment"
        : !native
          ? "The receptionist only works with ChairBack booking"
          : !facts.receptionistEntitled
            ? "The receptionist add-on is not active"
            : facts.receptionistTermsAccepted
              ? "Ready to answer"
              : "Waiting on your acknowledgement",
      role: "owner",
      cta: { label: "Open billing", href: "/dashboard/billing" },
    }),
    item({
      id: "integration.connected",
      milestone: "shop",
      applicable: externalMode,
      title: `${facts.bookingMode} is connected`,
      why: "Your booking source is set to an outside system, so appointments only appear here while that connection is live.",
      klass: "conditional",
      done: facts.integrationConnected,
      evidence: facts.integrationConnected
        ? `${facts.bookingMode} is connected and syncing`
        : `Booking is set to ${facts.bookingMode} but no connection is active`,
      role: "owner",
      cta: { label: "Connect booking", href: "/dashboard/booking?tab=Settings" },
    }),

    // ----- Informational: true things a barber cannot action -----
    item({
      id: "info.billing_access",
      milestone: "shop",
      applicable: !facts.hasActiveAccess,
      title: "Booking is paused",
      why: "Your trial or subscription has lapsed, so new bookings are refused until it is active again.",
      klass: "info",
      done: false,
      evidence: "Customers see a 'booking paused' notice instead of your times",
      role: "owner",
      cta: { label: "See plans", href: "/dashboard/billing" },
    }),
    item({
      id: "info.customer_sms",
      milestone: null,
      title: "Texting customers is limited",
      why: "Carrier registration (10DLC) and per-customer consent both gate outbound texts, so texting is not a channel to rely on at launch. Confirmations go by email.",
      klass: "info",
      done: true,
      evidence: caps.dryRun
        ? "Message sending is in test mode on this deployment - nothing reaches a real phone"
        : caps.messagingCampaigns > 0
          ? "Texting is registered; each customer still has to agree to texts individually"
          : "No carrier registration on this deployment - shops share the platform number",
      role: "owner",
      cta: null,
    }),
  );

  // ----- Post-launch polish -----
  const otherIncompleteChairs = activeStaff.filter(
    (s) => !chairBookable(s, recipientOf(facts, s), caps),
  );
  items.push(
    item({
      id: "improve.other_chairs",
      milestone: null,
      // A shop launches on ONE working chair. Every other unfinished chair is a
      // recommendation, never a blocker - otherwise hiring a second barber
      // would take a live shop offline.
      applicable: bookableChairs.length > 0 && otherIncompleteChairs.length > 0,
      title: "Finish setting up your other chairs",
      why: "Customers can pick these barbers and find nothing available.",
      klass: "recommended",
      done: false,
      evidence: `${plural(otherIncompleteChairs.length, "other chair is", "other chairs are")} not fully set up`,
      cta: { label: "Open Staff", href: "/dashboard/booking?tab=Staff" },
    }),
    item({
      id: "improve.service_prices",
      milestone: null,
      applicable: !paymentsOn && activeServices.length > 0,
      title: "Show your prices",
      why: "Customers decide faster when the price is on the card. Not required - some shops quote at the chair.",
      klass: "recommended",
      done: pricedServices.length === activeServices.length,
      evidence:
        pricedServices.length === activeServices.length
          ? "Every active service shows a price"
          : `${plural(activeServices.length - pricedServices.length, "service has", "services have")} no price`,
      cta: { label: "Edit services", href: "/dashboard/booking?tab=Services" },
    }),
  );

  return items;
}

/**
 * Build the report. PURE - no Prisma, no clock, no env; everything arrives in
 * `facts` and `caps` so this is exhaustively testable without a database.
 */
export function buildReadiness(
  facts: ReadinessFacts,
  caps: ReadinessCapabilities,
): ReadinessReport {
  const bookableChairs = facts.staff.filter((s) =>
    chairBookable(s, recipientOf(facts, s), caps),
  );

  const shopScoped = shopItems(facts, caps, bookableChairs);
  const perChair = facts.staff.map((s) => ({ s, items: staffItems(facts, s, caps) }));

  // The go-live preflight is derived from every OTHER required item, so it can
  // never disagree with them. Computed here, after the rest exist.
  const preLaunchBlockers = shopScoped.filter((i) => i.blocksLaunch);
  const preflight = item({
    id: "shop.preflight",
    milestone: "preview_and_go_live",
    title: "Everything needed to take a booking",
    why: "The last check before your page goes live: every requirement above passing at the same time.",
    klass: "required",
    done: preLaunchBlockers.length === 0,
    evidence:
      preLaunchBlockers.length === 0
        ? "All checks pass - you're ready to go live"
        : `${plural(preLaunchBlockers.length, "thing")} still to do before customers can book`,
    cta: { label: "See what's left", href: "/dashboard" },
  });

  const allShopItems = [...shopScoped, preflight];
  // Staff items inform the per-chair view and the recommendations above; they
  // are deliberately NOT folded into the shop milestones, because a shop
  // launches on one working chair, not on every chair being finished.
  const milestoneItems = allShopItems.filter((i) => i.milestone !== null);
  const improve = allShopItems.filter(
    (i) => i.milestone === null && i.applicable,
  );

  const milestones: Milestone[] = MILESTONE_IDS.map((id) => {
    const mine = milestoneItems.filter((i) => i.milestone === id && i.applicable);
    const blocking = mine.filter((i) => i.blocksLaunch);
    const counted = mine.filter(
      (i) => i.klass === "required" || i.klass === "conditional",
    );
    return {
      id,
      title: MILESTONE_TITLES[id],
      done: blocking.length === 0,
      blocking,
      applicableCount: counted.length,
      completeCount: counted.filter((i) => i.done).length,
    };
  });

  const staff: StaffReadiness[] = perChair.map(({ s, items: its }) => {
    const applicable = its.filter((i) => i.applicable);
    const counted = applicable.filter(
      (i) => i.klass === "required" || i.klass === "conditional",
    );
    return {
      staffId: s.id,
      name: s.name,
      active: s.active,
      items: its,
      blocking: applicable.filter((i) => i.blocksLaunch),
      applicableCount: counted.length,
      completeCount: counted.filter((i) => i.done).length,
      bookable: chairBookable(s, recipientOf(facts, s), caps),
    };
  });

  const applicableCounted = allShopItems.filter(
    (i) => i.applicable && (i.klass === "required" || i.klass === "conditional"),
  );
  const blocking = allShopItems.filter((i) => i.blocksLaunch);

  return {
    shopId: facts.shopId,
    liveNow:
      facts.publicPageEnabled &&
      facts.hasActiveAccess &&
      (isNative(facts) ? Boolean(facts.slug) : Boolean(facts.bookingUrl?.trim())),
    canGoLive: blocking.length === 0,
    // B1 ships no gate. See the field's note on ReadinessReport - an existing
    // published shop must never be blocked retroactively.
    goLiveGateApplies: false,
    milestones,
    milestonesComplete: milestones.filter((m) => m.done).length,
    milestonesBlocking: milestones.filter((m) => !m.done).length,
    blocking,
    items: allShopItems,
    improve,
    applicableRequiredCount: applicableCounted.length,
    completeRequiredCount: applicableCounted.filter((i) => i.done).length,
    staff,
  };
}

/**
 * The BARBER view: their own chair and the items they can personally act on.
 *
 * Shop-wide progress, other chairs, money and the milestone counts are all
 * dropped - an employee's readiness is their own chair, and showing them a shop
 * percentage they cannot move is noise. The caller resolves which chair from the
 * authenticated seat; this never takes a staffId from a request.
 */
export interface BarberReadiness {
  staffId: string | null;
  /** null when their seat is not linked to a chair - the UI says what to ask for. */
  chair: StaffReadiness | null;
  /** Items this barber can complete themselves. */
  personal: ReadinessItem[];
  /** Items about their chair that only a manager can resolve. */
  managerOwned: ReadinessItem[];
  complete: number;
  applicable: number;
}

export function buildBarberReadiness(
  report: ReadinessReport,
  staffId: string | null,
): BarberReadiness {
  const chair = staffId
    ? (report.staff.find((s) => s.staffId === staffId) ?? null)
    : null;
  const applicable = (chair?.items ?? []).filter((i) => i.applicable);
  return {
    staffId,
    chair,
    personal: applicable.filter((i) => i.role === "barber"),
    managerOwned: applicable.filter((i) => i.role !== "barber"),
    complete: chair?.completeCount ?? 0,
    applicable: chair?.applicableCount ?? 0,
  };
}
