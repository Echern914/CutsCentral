import { z } from "zod";

/**
 * Zod schemas for Google OAuth + Calendar API responses, validated at the
 * boundary so the rest of the code works with trusted, typed data. Mirrors
 * square/types.ts. Unused fields pass through (.passthrough) but aren't required.
 */

// Token endpoint response. Google uses a RELATIVE expires_in (seconds) — like
// Acuity, unlike Square's absolute expires_at. refresh_token is only issued
// when access_type=offline AND the user goes through the consent screen; we
// force prompt=consent so every (re)connect re-issues one. On refresh_token
// grants Google normally OMITS refresh_token (the old one stays valid).
export const gcalTokenSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number(),
    refresh_token: z.string().nullish(),
    scope: z.string().nullish(),
    token_type: z.string().default("Bearer"),
    id_token: z.string().nullish(), // JWT carrying the account email (openid+email scopes)
  })
  .passthrough();

export type GcalToken = z.infer<typeof gcalTokenSchema>;

// Event start/end. Timed events carry `dateTime` (RFC3339 with offset);
// all-day events carry only `date` — the mapping skips those (birthdays,
// blocks, holidays are not bookings).
export const gcalEventTimeSchema = z
  .object({
    dateTime: z.string().nullish(),
    date: z.string().nullish(),
    timeZone: z.string().nullish(),
  })
  .passthrough();

export const gcalAttendeeSchema = z
  .object({
    email: z.string().nullish(),
    displayName: z.string().nullish(),
    organizer: z.boolean().nullish(),
    self: z.boolean().nullish(),
    resource: z.boolean().nullish(), // rooms/equipment — never a client
    responseStatus: z.string().nullish(),
  })
  .passthrough();

export type GcalAttendee = z.infer<typeof gcalAttendeeSchema>;

// A Calendar event. With showDeleted=true, cancelled events arrive as
// TOMBSTONES: { id, status: "cancelled" } and little else — start/summary are
// absent, so almost everything is nullish here and the ingest branches on
// status before touching the rest.
export const gcalEventSchema = z
  .object({
    id: z.string(),
    status: z.string().nullish(), // confirmed | tentative | cancelled
    summary: z.string().nullish(),
    description: z.string().nullish(),
    start: gcalEventTimeSchema.nullish(),
    end: gcalEventTimeSchema.nullish(),
    attendees: z.array(gcalAttendeeSchema).nullish(),
    // "transparent" = marked Free (an FYI overlay, not a real appointment).
    transparency: z.string().nullish(),
    // default | outOfOffice | focusTime | workingLocation | birthday | fromGmail.
    // Only "default" events are booking candidates.
    eventType: z.string().nullish(),
    recurringEventId: z.string().nullish(),
  })
  .passthrough();

export type GcalEvent = z.infer<typeof gcalEventSchema>;

// One page of the events list. nextSyncToken arrives ONLY on the last page of
// a walk; persist it and the next sweep is a cheap delta query.
export const gcalEventsPageSchema = z
  .object({
    items: z.array(gcalEventSchema).default([]),
    nextPageToken: z.string().nullish(),
    nextSyncToken: z.string().nullish(),
  })
  .passthrough();

export type GcalEventsPage = z.infer<typeof gcalEventsPageSchema>;
