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

export type SquareWebhookEnvelope = z.infer<typeof squareWebhookEnvelopeSchema>;
