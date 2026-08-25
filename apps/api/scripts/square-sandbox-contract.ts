/**
 * THE SQUARE SANDBOX CONTRACT.
 *
 * Fourteen questions that must be answered against a real Square Sandbox seller
 * before PR S2 (durable mirroring) may be written, because every one of them
 * changes the design and none of them can be settled from documentation alone.
 *
 * Run it:
 *
 *   SQUARE_SANDBOX_ACCESS_TOKEN=EAAA... \
 *   SQUARE_SANDBOX_LOCATION_ID=L...     \   # optional; auto-picked if omitted
 *   pnpm --filter @chairback/api exec tsx scripts/square-sandbox-contract.ts
 *
 * The token is a SANDBOX access token from the Square Developer Console
 * (Sandbox -> the test account -> Credentials -> Access token). It is NOT an
 * OAuth flow: the contract is about the Bookings API's behaviour, not about
 * consent, and a personal sandbox token exercises the identical endpoints
 * without a browser.
 *
 * SAFETY. The script refuses to run against production, twice:
 *
 *   - the host is hard-coded to connect.squareupsandbox.com; there is no flag
 *     to point it anywhere else, and
 *   - a token that does not start with the sandbox prefix is rejected before
 *     the first request.
 *
 * It writes ONLY to the sandbox seller it is given, and it cleans up after
 * itself (every booking it creates is cancelled in the finally block, and the
 * ids are printed either way so a failed run can be cleaned by hand).
 *
 * Output is a PASS/FAIL table plus the raw findings that S2 has to encode.
 * A finding of "Square does NOT do X" is as valuable as a pass - the point is
 * to stop guessing, not to make everything green.
 */

const SANDBOX_HOST = "https://connect.squareupsandbox.com";
const API_VERSION = process.env.SQUARE_API_VERSION ?? "2026-05-20";
const TOKEN = process.env.SQUARE_SANDBOX_ACCESS_TOKEN ?? "";

interface Finding {
  id: string;
  question: string;
  status: "PASS" | "FAIL" | "SKIP";
  answer: string;
}

const findings: Finding[] = [];
const created: string[] = [];

/**
 * Square answers CreateBooking with 201, not 200. Every write assertion here
 * originally tested `=== 200` and so read three real answers backwards.
 */
function wrote(status: number): boolean {
  return status === 200 || status === 201;
}

function record(id: string, question: string, status: Finding["status"], answer: string) {
  findings.push({ id, question, status, answer });
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${id}  ${question}\n        ${answer}\n`);
}

interface SquareCall {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<SquareCall> {
  const res = await fetch(`${SANDBOX_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
      "Square-Version": API_VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : JSON.stringify(idempotencyKey ? { idempotency_key: idempotencyKey, ...(body as object) } : body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

function errorsOf(body: Record<string, unknown>): string {
  const errs = body.errors as { code?: string; detail?: string }[] | undefined;
  if (!Array.isArray(errs) || errs.length === 0) return "";
  return errs.map((e) => `${e.code ?? "?"}: ${e.detail ?? ""}`.trim()).join(" | ");
}

/** A start time far enough out that no sandbox seller has real bookings there. */
function slotAt(dayOffset: number, hourUtc: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error(
      "SQUARE_SANDBOX_ACCESS_TOKEN is not set.\n\n" +
        "Square Developer Console -> your app -> Sandbox -> open the test account\n" +
        "-> Credentials -> Sandbox Access token. Then re-run.\n",
    );
    process.exit(2);
  }
  // A production token here would write into a REAL seller's calendar. Refuse
  // before the first request rather than trusting the host alone.
  if (!/^EAAA/.test(TOKEN) || TOKEN.includes("sq0atp")) {
    console.error("That does not look like a Square SANDBOX access token. Refusing to run.");
    process.exit(2);
  }

  //  C1  Business booking profile + seller-level write capability

  const profile = await call("GET", "/v2/bookings/business-booking-profile");
  const bbp = (profile.body.business_booking_profile ?? {}) as Record<string, unknown>;
  record(
    "C1",
    "RetrieveBusinessBookingProfile: is support_seller_level_writes reported?",
    profile.status === 200 && typeof bbp.support_seller_level_writes === "boolean" ? "PASS" : "FAIL",
    `status=${profile.status} booking_enabled=${String(bbp.booking_enabled)} ` +
      `support_seller_level_writes=${String(bbp.support_seller_level_writes)} ${errorsOf(profile.body)}`,
  );
  const sellerWrites = bbp.support_seller_level_writes === true;

  //  C2  Locations

  const locations = await call("GET", "/v2/locations");
  const locList = (locations.body.locations ?? []) as { id: string; name?: string; status?: string }[];
  const locationId =
    process.env.SQUARE_SANDBOX_LOCATION_ID ??
    locList.find((l) => l.status === "ACTIVE")?.id ??
    locList[0]?.id ??
    "";
  record(
    "C2",
    "ListLocations: can we enumerate and select a location?",
    locations.status === 200 && locationId ? "PASS" : "FAIL",
    `status=${locations.status} count=${locList.length} chosen=${locationId} ${errorsOf(locations.body)}`,
  );

  //  C3  Team member booking profiles

  const team = await call(
    "GET",
    `/v2/bookings/team-member-booking-profiles?bookable_only=true&limit=100&location_id=${encodeURIComponent(locationId)}`,
  );
  const profiles = (team.body.team_member_booking_profiles ?? []) as {
    team_member_id: string;
    display_name?: string;
    is_bookable?: boolean;
  }[];
  const teamMemberId = profiles[0]?.team_member_id ?? "";
  record(
    "C3",
    "ListTeamMemberBookingProfiles: are bookable profiles returned, and does bookable_only filter?",
    team.status === 200 && teamMemberId ? "PASS" : "FAIL",
    `status=${team.status} bookable=${profiles.length} chosen=${teamMemberId} ${errorsOf(team.body)}`,
  );

  //  C4  Service variations + versions

  const catalog = await call("GET", "/v2/catalog/list?types=ITEM");
  const items = (catalog.body.objects ?? []) as {
    id: string;
    is_deleted?: boolean;
    item_data?: {
      name?: string;
      product_type?: string;
      variations?: { id: string; version?: number | string }[];
    };
  }[];
  const serviceItems = items.filter(
    (i) => !i.is_deleted && i.item_data?.product_type === "APPOINTMENTS_SERVICE",
  );
  const variation = serviceItems[0]?.item_data?.variations?.[0];
  record(
    "C4",
    "ListCatalog: do APPOINTMENTS_SERVICE items carry variations WITH a version?",
    catalog.status === 200 && variation?.id && variation.version !== undefined ? "PASS" : "FAIL",
    `status=${catalog.status} serviceItems=${serviceItems.length} ` +
      `variation=${variation?.id ?? "none"} version=${String(variation?.version)} ${errorsOf(catalog.body)}`,
  );

  //  C5  A customer to book for
  //
  // Square has no blocked-time concept and customer_id is NOT optional, so a
  // mirrored appointment needs a customer record. Whether that should be a
  // single reusable "ChairBack hold" customer or a per-client record is an S2
  // decision this call informs.

  const customer = await call("POST", "/v2/customers", {
    given_name: "ChairBack",
    family_name: "Contract Test",
    reference_id: `chairback-contract-${Date.now()}`,
  });
  const customerId = ((customer.body.customer ?? {}) as { id?: string }).id ?? "";
  record(
    "C5",
    "CreateCustomer: can we mint the customer a Booking requires?",
    customer.status === 200 && customerId ? "PASS" : "FAIL",
    `status=${customer.status} customer=${customerId} ${errorsOf(customer.body)}`,
  );

  // 🔴 STOP BEFORE C7 IF THE PLAN CANNOT DO SELLER-LEVEL WRITES.
  //
  // On a Free seller, C7-C13 would exercise a code path S2 cannot use and every
  // answer they produced would be about the wrong account - green results that
  // mean nothing. Recording them would be worse than recording nothing.
  if (!sellerWrites) {
    record(
      "C6-C14",
      "The booking legs",
      "SKIP",
      "support_seller_level_writes is not true on this sandbox seller. " +
        "Upgrade the test account to Square Appointments Plus or Premium and re-run - " +
        "answers gathered from a Free plan would not be about the code path S2 uses.",
    );
    await cleanup(customerId);
    summarize();
    return;
  }

  if (!locationId || !teamMemberId || !variation?.id || !customerId) {
    record(
      "C6-C14",
      "The booking legs",
      "SKIP",
      "Missing a prerequisite above - fix the seller's setup and re-run.",
    );
    await cleanup(customerId);
    summarize();
    return;
  }

  const segment = {
    team_member_id: teamMemberId,
    service_variation_id: variation.id,
    service_variation_version: Number(variation.version),
  };
  const startAt = slotAt(9, 15);

  try {
    //  C6  Search availability

    const availability = await call("POST", "/v2/bookings/availability/search", {
      query: {
        filter: {
          start_at_range: { start_at: slotAt(9, 0), end_at: slotAt(9, 23) },
          location_id: locationId,
          segment_filters: [{ service_variation_id: variation.id }],
        },
      },
    });
    const slots = (availability.body.availabilities ?? []) as unknown[];
    record(
      "C6",
      "SearchAvailability: can we confirm a slot is free before writing?",
      availability.status === 200 ? "PASS" : "FAIL",
      `status=${availability.status} slots=${slots.length} ${errorsOf(availability.body)}`,
    );

    //  C7  Create a booking

    const idem = `chairback-contract-${Date.now()}`;
    const create = await call(
      "POST",
      "/v2/bookings",
      {
        booking: {
          location_id: locationId,
          customer_id: customerId,
          start_at: startAt,
          appointment_segments: [segment],
          seller_note: "ChairBack contract test - safe to delete",
        },
      },
      idem,
    );
    const booking = (create.body.booking ?? {}) as { id?: string; version?: number; status?: string };
    if (booking.id) created.push(booking.id);
    record(
      "C7",
      "CreateBooking: does a seller-level write land?",
      wrote(create.status) && booking.id ? "PASS" : "FAIL",
      `status=${create.status} id=${booking.id ?? "none"} bookingStatus=${booking.status} ` +
        `version=${String(booking.version)} ${errorsOf(create.body)}`,
    );

    //  C8  PENDING vs ACCEPTED
    //
    // A booking that lands PENDING is NOT protection: the time is not held
    // until a human accepts it, so a mirror that produces PENDING rows would
    // advertise a protection it does not deliver.

    record(
      "C8",
      "Does a seller-level write land ACCEPTED, or does it sit PENDING?",
      booking.status === "ACCEPTED" ? "PASS" : "FAIL",
      `status=${booking.status ?? "unknown"} - ` +
        (booking.status === "ACCEPTED"
          ? "the time is held immediately."
          : "NOT held until accepted; S2 must treat this as unprotected."),
    );

    //  C9  Idempotency: the same key must not produce a second booking

    const repeat = await call(
      "POST",
      "/v2/bookings",
      {
        booking: {
          location_id: locationId,
          customer_id: customerId,
          start_at: startAt,
          appointment_segments: [segment],
          seller_note: "ChairBack contract test - safe to delete",
        },
      },
      idem,
    );
    const repeatId = ((repeat.body.booking ?? {}) as { id?: string }).id;
    record(
      "C9",
      "Replaying the SAME idempotency key: one booking, or two?",
      wrote(repeat.status) && repeatId === booking.id ? "PASS" : "FAIL",
      `status=${repeat.status} id=${repeatId ?? "none"} ` +
        (repeatId === booking.id
          ? "same booking returned - a lost response is recoverable by replay."
          : "DIFFERENT booking - S2 cannot rely on idempotency keys and must recover by reference."),
    );

    //  C10  Overlap: does Square reject a double-book, or accept it?
    //
    // The single most important question in the whole contract. If seller-level
    // writes accept overlaps, then Square gives NO atomic collision rejection
    // and S2 must verify availability immediately before writing and document
    // the unavoidable cross-system race honestly.

    const overlap = await call(
      "POST",
      "/v2/bookings",
      {
        booking: {
          location_id: locationId,
          customer_id: customerId,
          start_at: startAt,
          appointment_segments: [segment],
          seller_note: "ChairBack contract test OVERLAP - safe to delete",
        },
      },
      `${idem}-overlap`,
    );
    const overlapId = ((overlap.body.booking ?? {}) as { id?: string }).id;
    if (overlapId) created.push(overlapId);
    record(
      "C10",
      "Does a seller-level write REJECT an overlapping booking?",
      // PASS only if NO second booking exists. Judging this by status code was
      // wrong twice over: CreateBooking answers 201, not 200, so `status !== 200`
      // called a successfully created double-book a rejection - the exact
      // opposite of the truth, on the one question that decides the design.
      !overlapId ? "PASS" : "FAIL",
      overlapId
        ? `ACCEPTED an overlap (status=${overlap.status} id=${overlapId}). Square gives NO atomic ` +
          "collision rejection at seller level: S2 must re-verify availability immediately before " +
          "writing and document the race."
        : `rejected: status=${overlap.status} ${errorsOf(overlap.body)}`,
    );

    //  C11  Versioned update - is it safe to reschedule in place?

    const currentVersion = booking.version;
    const update = await call("PUT", `/v2/bookings/${booking.id}`, {
      booking: {
        version: currentVersion,
        start_at: slotAt(9, 17),
        appointment_segments: [segment],
      },
      idempotency_key: `${idem}-update`,
    });
    const updated = (update.body.booking ?? {}) as { version?: number; start_at?: string };
    record(
      "C11",
      "UpdateBooking with the correct version: does an in-place reschedule work?",
      update.status === 200 ? "PASS" : "FAIL",
      `status=${update.status} newVersion=${String(updated.version)} start=${updated.start_at} ` +
        errorsOf(update.body) +
        (update.status === 200
          ? " - S2 SHOULD use versioned update, not Acuity's create-then-delete swap."
          : " - fall back to create-before-delete."),
    );

    //  C12  A STALE version must be rejected, or the version is not a guard

    const stale = await call("PUT", `/v2/bookings/${booking.id}`, {
      booking: { version: currentVersion, start_at: slotAt(9, 18), appointment_segments: [segment] },
      idempotency_key: `${idem}-stale`,
    });
    record(
      "C12",
      "UpdateBooking with a STALE version: is the conflict detected?",
      stale.status !== 200 ? "PASS" : "FAIL",
      stale.status === 200
        ? "ACCEPTED a stale version - the version is NOT an optimistic-concurrency guard."
        : `rejected: status=${stale.status} ${errorsOf(stale.body)}`,
    );

    //  C13  Cancel with the correct version

    const latest = await call("GET", `/v2/bookings/${booking.id}`);
    const latestVersion = ((latest.body.booking ?? {}) as { version?: number }).version;
    const cancel = await call("POST", `/v2/bookings/${booking.id}/cancel`, {
      booking_version: latestVersion,
      idempotency_key: `${idem}-cancel`,
    });
    const cancelled = (cancel.body.booking ?? {}) as { status?: string };
    record(
      "C13",
      "CancelBooking with the correct version: does the time come back?",
      cancel.status === 200 ? "PASS" : "FAIL",
      `status=${cancel.status} bookingStatus=${cancelled.status} ${errorsOf(cancel.body)}`,
    );
    if (cancel.status === 200) created.splice(created.indexOf(booking.id!), 1);

    //  C14  Does Square message the CUSTOMER about a seller-level API booking?
    //
    // Cannot be answered by an API response. It is recorded as a manual step
    // because a mirror that texts a stranger "your appointment is confirmed"
    // for a hold they never made is a worse bug than the double-booking.

    record(
      "C14",
      "Does Square email/SMS the customer for a seller-level API booking?",
      "SKIP",
      "MANUAL: check the sandbox customer's notification log / the test inbox for the booking " +
        `created above (${booking.id ?? "n/a"}). Square does not report this in the API response.`,
    );
  } finally {
    await cleanup(customerId);
  }

  summarize();

  //  The webhook legs cannot be driven from here.

  console.log(
    [
      "",
      "STILL MANUAL (webhook delivery cannot be triggered from a script):",
      "  W1  booking.created payload shape + a stable event_id",
      "  W2  booking.updated payload on a reschedule AND on a cancel",
      "  W3  an APP-ORIGIN booking (the one created above) must NOT import as a",
      "      second ChairBack Visit - point the sandbox webhook at a tunnel and",
      "      confirm the ledger dedupes it by event_id.",
      "",
      `Seller-level writes reported by this account: ${sellerWrites}.`,
      "If that is false, C7-C13 exercised a plan that cannot do what S2 needs -",
      "upgrade the sandbox seller to Appointments Plus and re-run before trusting",
      "any of the answers above.",
    ].join("\n"),
  );
}

/**
 * Undo everything this run created.
 *
 * Called from the finally block AND from every early return - an early exit is
 * exactly when a stray customer record is most likely to be left behind and
 * least likely to be noticed. Ids are printed either way so a failed cleanup is
 * a line to act on rather than a mystery row on the seller's account.
 */
async function cleanup(customerId: string): Promise<void> {
  for (const id of created) {
    const latest = await call("GET", `/v2/bookings/${id}`);
    const version = ((latest.body.booking ?? {}) as { version?: number }).version;
    const res = await call("POST", `/v2/bookings/${id}/cancel`, {
      booking_version: version,
      idempotency_key: `cleanup-${id}`,
    });
    console.log(
      `cleanup: booking ${id} -> ${res.status === 200 ? "cancelled" : `LEFT (status ${res.status})`}`,
    );
  }
  created.length = 0;
  if (customerId) {
    const res = await call("DELETE", `/v2/customers/${customerId}`);
    console.log(
      `cleanup: customer ${customerId} -> ${res.status === 200 ? "deleted" : `LEFT (status ${res.status})`}`,
    );
  }
}

function summarize(): void {
  const pass = findings.filter((f) => f.status === "PASS").length;
  const fail = findings.filter((f) => f.status === "FAIL").length;
  const skip = findings.filter((f) => f.status === "SKIP").length;
  console.log("\n" + "=".repeat(72));
  console.log(`CONTRACT: ${pass} pass, ${fail} fail, ${skip} manual/skipped`);
  for (const f of findings) console.log(`  ${f.status.padEnd(4)} ${f.id}  ${f.question}`);
  console.log("=".repeat(72));
  console.log(
    fail === 0
      ? "\nNo hard failures. Resolve the manual items, then S2 may be written.\n"
      : "\nS2 MUST NOT be written until every FAIL above is understood and encoded.\n",
  );
}

void main().catch((err) => {
  console.error("contract run failed:", err);
  process.exit(1);
});
