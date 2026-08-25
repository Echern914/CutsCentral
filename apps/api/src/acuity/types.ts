import { z } from "zod";

/**
 * Zod schemas for Acuity API responses. Validated at the boundary so the rest
 * of the code works with trusted, typed data. Fields we don't use are allowed
 * through (passthrough) but not required.
 */

/**
 * Intake form answers on an appointment (present when fetched with
 * `pastFormAnswers=true`). Each form has a `values` array of answered fields.
 * A checkbox/yes-no answer surfaces in `value` - the exact encoding is confirmed
 * by the probe (packages/db/prisma/probe-acuity-consent.ts); see
 * isAcuityCheckboxChecked() in consent.ts for the interpretation.
 */
export const acuityFormValueSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullish(),
    fieldID: z.union([z.number(), z.string()]).nullish(),
    name: z.string().nullish(), // the question text / label
    // Current answer. Probe-confirmed: a checked checkbox => "yes", unchecked
    // => "". (There is also a sibling `pastValue` holding the PRIOR answer -
    // deliberately ignored; we only ever read the current `value`.)
    value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
    // Acuity widget type. Probe-confirmed: 5 === single checkbox. Used as the
    // primary signal so rewording the question text can't break matching.
    fieldWidget: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

export const acuityFormSchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullish(),
    name: z.string().nullish(), // the form's name
    values: z.array(acuityFormValueSchema).default([]),
  })
  .passthrough();

export type AcuityFormValue = z.infer<typeof acuityFormValueSchema>;
export type AcuityForm = z.infer<typeof acuityFormSchema>;

export const acuityAppointmentSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    phone: z.string().nullish(),
    email: z.string().nullish(),
    datetime: z.string(), // ISO 8601 with offset
    endTime: z.string().nullish(),
    date: z.string().nullish(),
    time: z.string().nullish(),
    price: z.string().nullish(),
    type: z.string().nullish(), // service name
    appointmentTypeID: z.union([z.number(), z.string()]).nullish(),
    calendarID: z.union([z.number(), z.string()]).nullish(),
    canceled: z.boolean().nullish(),
    noShow: z.boolean().nullish(),
    duration: z.union([z.number(), z.string()]).nullish(),
    timezone: z.string().nullish(),
    // Intake answers - only populated when requested with pastFormAnswers=true.
    forms: z.array(acuityFormSchema).nullish(),
  })
  .passthrough();

export type AcuityAppointment = z.infer<typeof acuityAppointmentSchema>;

/**
 * Blocked-off time on an Acuity calendar (GET /blocks).
 *
 * Acuity documents the CREATE side (start/end/calendarID/notes) but not the
 * list response's exact shape, so this parses defensively: every field except
 * the id is optional, `start`/`end` accept Acuity's several spellings, and
 * unknown keys pass through. A block we can't read a start+end from is skipped
 * at ingest rather than throwing - one odd row must never stop the sweep.
 * [VERIFY LIVE] confirm the field names against a real account's response.
 */
export const acuityBlockSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    calendarID: z.union([z.number(), z.string()]).nullish(),
    start: z.string().nullish(),
    end: z.string().nullish(),
    // Seen on some payloads as start/endTime instead.
    startTime: z.string().nullish(),
    endTime: z.string().nullish(),
    notes: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

export type AcuityBlock = z.infer<typeof acuityBlockSchema>;

/**
 * A calendar on the connected Acuity account (GET /calendars). One calendar is
 * one bookable resource - for a barbershop, one chair. This is the mapping
 * target for Staff.acuityCalendarId: blocks are calendar-scoped, so without a
 * per-chair id an outbound block would land on whatever calendar Acuity picks
 * by default and take the WRONG barber off the board.
 *
 * `name` is business data (the chair/barber label the owner typed into Acuity),
 * not customer data - it is shown in the mapping UI so the owner can match
 * chairs by eye. Nothing else from the payload is surfaced.
 */
export const acuityCalendarSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    name: z.string().nullish(),
    timezone: z.string().nullish(),
  })
  .passthrough();

export type AcuityCalendar = z.infer<typeof acuityCalendarSchema>;

export const acuityMeSchema = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    email: z.string().nullish(),
    name: z.string().nullish(),
    timezone: z.string().nullish(),
  })
  .passthrough();

export type AcuityMe = z.infer<typeof acuityMeSchema>;

export const acuityTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().default("Bearer"),
    scope: z.string().nullish(),
    expires_in: z.number().nullish(),
    refresh_token: z.string().nullish(),
  })
  .passthrough();

export type AcuityToken = z.infer<typeof acuityTokenSchema>;
