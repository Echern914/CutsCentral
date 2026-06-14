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
