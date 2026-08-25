import { z } from "zod";

/**
 * Zod schemas for Square API responses, validated at the boundary so the rest of
 * the code works with trusted, typed data. Mirrors acuity/types.ts. Unused
 * fields pass through (.passthrough) but aren't required.
 *
 * [VERIFY IN SANDBOX] field presence/shape against the pinned Square-Version —
 * Square's Booking object references catalog/team ids rather than inline service
 * names, and `phone_number` is not contractually E.164 (normalize defensively).
 */

// ObtainToken / refresh response. Square uses an absolute `expires_at` (ISO),
// NOT Acuity's relative `expires_in`. refresh_token is REQUIRED in the code flow
// (long-lived, multi-use); merchant_id ties the connection to a seller.
export const squareTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().default("Bearer"),
    expires_at: z.string(), // ISO 8601
    merchant_id: z.string(),
    refresh_token: z.string(),
    short_lived: z.boolean().nullish(),
  })
  .passthrough();

export type SquareToken = z.infer<typeof squareTokenSchema>;

// A single segment of a booking (service + team member + duration). A booking
// can have multiple, but v1 reads the first for duration/service hints.
export const squareAppointmentSegmentSchema = z
  .object({
    duration_minutes: z.number().nullish(),
    service_variation_id: z.string().nullish(),
    team_member_id: z.string().nullish(),
    service_variation_version: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

// Square Booking. status is an enum: PENDING | ACCEPTED | CANCELLED_BY_CUSTOMER
// | CANCELLED_BY_SELLER | DECLINED | NO_SHOW | ACCEPTED ... (see mapping.ts).
export const squareBookingSchema = z
  .object({
    id: z.string(),
    version: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    start_at: z.string(), // ISO 8601 with offset
    location_id: z.string().nullish(),
    customer_id: z.string().nullish(),
    customer_note: z.string().nullish(),
    // Present in the real webhook payload (verified against a live sandbox
    // delivery, 2026-08-25) and load-bearing: it carries the outbox row id that
    // identifies a booking as ChairBack's own before squareBookingId is stored.
    seller_note: z.string().nullish(),
    appointment_segments: z.array(squareAppointmentSegmentSchema).default([]),
  })
  .passthrough();

export type SquareBooking = z.infer<typeof squareBookingSchema>;

// Square Customer (contact details for the client mapping).
export const squareCustomerSchema = z
  .object({
    id: z.string(),
    given_name: z.string().nullish(),
    family_name: z.string().nullish(),
    email_address: z.string().nullish(),
    phone_number: z.string().nullish(),
  })
  .passthrough();

export type SquareCustomer = z.infer<typeof squareCustomerSchema>;

// Webhook envelope: { merchant_id, type, event_id, data: { object: { booking } } }.
export const squareWebhookEnvelopeSchema = z
  .object({
    merchant_id: z.string().nullish(),
    type: z.string().nullish(),
    event_id: z.string().nullish(),
    data: z
      .object({
        type: z.string().nullish(),
        id: z.string().nullish(),
        object: z
          .object({ booking: squareBookingSchema.nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();


//  OUTBOUND SETUP (S1) - all read-only responses
//
// Every schema below backs a GET the SETUP screen makes. None of them describes
// a write: PR S1 adds no Square mutation of any kind, which is why the seller's
// calendar cannot be touched no matter what a manager clicks.

// A seller location. Bookings are location-scoped, so outbound writes need ONE
// chosen deliberately (see SquareConnection.outboundLocationId).
export const squareLocationSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    status: z.string().nullish(), // ACTIVE | INACTIVE
    timezone: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

export type SquareLocation = z.infer<typeof squareLocationSchema>;

/**
 * RetrieveBusinessBookingProfile.
 *
 * `support_seller_level_writes` is THE capability gate for calendar protection:
 * Square refuses seller-level booking writes on plans below Appointments Plus,
 * and a shop that arms enforcement without it would fail on the first real
 * customer instead of on the setup screen. `booking_enabled` is the seller's own
 * on/off switch for online booking.
 *
 * [VERIFY IN SANDBOX] the exact field names at the pinned API version, and
 * whether a Free-plan seller returns `false` or omits the field entirely - the
 * schema treats a MISSING field as unknown (null), never as `true`.
 */
export const squareBusinessBookingProfileSchema = z
  .object({
    seller_id: z.string().nullish(),
    booking_enabled: z.boolean().nullish(),
    support_seller_level_writes: z.boolean().nullish(),
    customer_timezone_choice: z.string().nullish(),
    booking_policy: z.string().nullish(),
  })
  .passthrough();

export type SquareBusinessBookingProfile = z.infer<
  typeof squareBusinessBookingProfileSchema
>;

/**
 * A team member's BOOKING profile - not the same thing as a team member. Only a
 * profile with `is_bookable` can receive a booking, so the setup screen offers
 * exactly these and no more: mapping a chair to a non-bookable team member would
 * store a mapping that reads valid and fails at write time.
 */
export const squareTeamMemberBookingProfileSchema = z
  .object({
    team_member_id: z.string(),
    display_name: z.string().nullish(),
    is_bookable: z.boolean().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

export type SquareTeamMemberBookingProfile = z.infer<
  typeof squareTeamMemberBookingProfileSchema
>;

/**
 * A catalog ITEM with its variations, as returned by ListCatalog.
 *
 * Square models a bookable service as an ITEM whose `product_type` is
 * APPOINTMENTS_SERVICE; the thing a booking actually references is one of its
 * ITEM_VARIATIONs. The variation's `version` matters as much as its id - Square
 * rejects a booking whose service_variation_version is behind the catalog - so
 * both are carried through to the mapping.
 */
export const squareCatalogItemVariationSchema = z
  .object({
    id: z.string(),
    version: z.union([z.number(), z.string()]).nullish(),
    is_deleted: z.boolean().nullish(),
    item_variation_data: z
      .object({
        name: z.string().nullish(),
        service_duration: z.union([z.number(), z.string()]).nullish(), // milliseconds
        price_money: z
          .object({ amount: z.union([z.number(), z.string()]).nullish(), currency: z.string().nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export const squareCatalogItemSchema = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    is_deleted: z.boolean().nullish(),
    item_data: z
      .object({
        name: z.string().nullish(),
        product_type: z.string().nullish(), // APPOINTMENTS_SERVICE for bookable services
        variations: z.array(squareCatalogItemVariationSchema).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type SquareCatalogItem = z.infer<typeof squareCatalogItemSchema>;

/**
 * RetrieveTokenStatus - the ONLY way to learn what a token was actually granted.
 * ObtainToken's response does not echo the scopes, so without this call the
 * stored `scope` is a record of what we ASKED for, which is worthless as a
 * permission check.
 *
 * [VERIFY IN SANDBOX] method + path (`POST /oauth2/token/status` with the seller
 * token as the bearer) and the exact casing of the returned scope strings.
 */
export const squareTokenStatusSchema = z
  .object({
    scopes: z.array(z.string()).nullish(),
    expires_at: z.string().nullish(),
    client_id: z.string().nullish(),
    merchant_id: z.string().nullish(),
  })
  .passthrough();

export type SquareTokenStatus = z.infer<typeof squareTokenStatusSchema>;

//  OUTBOUND MIRRORING (S2) - the write half

/**
 * One availability slot from SearchAvailability.
 *
 * The mitigation for Square's documented behaviour that a SELLER-LEVEL write
 * can create a double booking where a buyer-level one cannot: if Square will
 * not reject the collision for us, the only thing left is to ask, immediately
 * before writing, whether the slot is still free. That narrows the race to the
 * round trip; it does not close it, and nothing in this codebase claims it does.
 */
export const squareAvailabilitySchema = z
  .object({
    start_at: z.string(),
    location_id: z.string().nullish(),
    appointment_segments: z.array(squareAppointmentSegmentSchema).nullish(),
  })
  .passthrough();

export type SquareAvailability = z.infer<typeof squareAvailabilitySchema>;

