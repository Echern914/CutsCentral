import { z } from "zod";

/**
 * Zod schemas for Acuity API responses. Validated at the boundary so the rest
 * of the code works with trusted, typed data. Fields we don't use are allowed
 * through (passthrough) but not required.
 */

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
