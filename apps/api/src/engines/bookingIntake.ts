import { forShop } from "@chairback/db";
import { isLikelyEmail, type BookingQuestionKindId } from "@chairback/config";

/**
 * BOOKING QUESTIONS - what a shop must ask before it can do the job.
 *
 * A barber needs a name and a time. A MOBILE MECHANIC needs the street he is
 * driving to and the year, make and model of the car, or he arrives at the
 * wrong house with the wrong parts and cannot quote at all. Same booking
 * engine; the difference is entirely in what the form asks.
 *
 * This module owns both halves of that:
 *  - the shop's live questions, read once and shared by the public form and
 *    the create handler, so what is ASKED and what is ENFORCED cannot drift;
 *  - resolving a customer's answers into the snapshot frozen onto
 *    Appointment.intake.
 *
 * 🔴 THE SNAPSHOT IS THE RECORD. Answers are stored with their label and kind,
 * never as a join. Renaming "Service address" or deleting it must not rewrite
 * what a customer already answered, and a job booked last week has to keep
 * showing the address it was booked with. Same contract as
 * ServiceAddOn -> Appointment.addOns.
 *
 * 🔴 A REQUIRED QUESTION CAN COST A BOOKING, so the validation refuses
 * precisely and says which field failed - never a blanket "invalid input" that
 * leaves a customer hunting. Unknown ids are dropped in silence (a stale or
 * crafted id buys nothing); it is only what the shop ASKED that can fail.
 */

/** One live question, as the public booking form receives it. */
export interface PublicBookingQuestion {
  id: string;
  label: string;
  helpText: string | null;
  kind: BookingQuestionKindId;
  required: boolean;
  options: string[];
  /**
   * Which services ask it. [] = all of them; non-empty = only those. Sent to
   * the public form so it can add and remove fields as the customer changes
   * service, without another round trip - exactly how add-ons behave.
   */
  serviceIds: string[];
}

/** One answer, frozen onto the appointment. */
export interface IntakeAnswer {
  questionId: string;
  label: string;
  kind: BookingQuestionKindId;
  value: string;
}

export type IntakeResult =
  | { ok: true; snapshot: IntakeAnswer[] }
  | { ok: false; questionId: string; message: string };

/**
 * Per-kind ceilings. Generous - the point is to stop something pathological
 * reaching the database, not to police how someone describes a noise their
 * car makes.
 */
const MAX_LENGTH: Record<BookingQuestionKindId, number> = {
  text: 200,
  textarea: 2000,
  address: 300,
  select: 200,
  phone: 40,
  email: 200,
  number: 40,
};

/** This shop's live questions, in the order the owner arranged them. */
export async function bookingQuestionsForShop(
  shopId: string,
): Promise<PublicBookingQuestion[]> {
  const rows = await forShop(shopId).bookingQuestion.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      label: true,
      helpText: true,
      kind: true,
      required: true,
      options: true,
      serviceIds: true,
    },
  });
  return (rows as unknown as PublicBookingQuestion[]).map((r) => ({
    id: r.id,
    label: r.label,
    helpText: r.helpText ?? null,
    kind: r.kind,
    required: r.required,
    options: r.options ?? [],
    serviceIds: r.serviceIds ?? [],
  }));
}

/**
 * The questions THIS service asks: the shop-wide ones plus any scoped to it.
 *
 * 🔴 THE ENFORCED LIST MUST MATCH THE ASKED LIST. The public form filters the
 * same way (it is sent `serviceIds` with each question), so a question the
 * customer never saw can never refuse their booking, and one they did see is
 * always the one validated. Pure, given the questions - so the create handler
 * and the form cannot drift apart.
 */
export function questionsForService(
  questions: PublicBookingQuestion[],
  serviceId: string,
): PublicBookingQuestion[] {
  return questions.filter(
    (q) => q.serviceIds.length === 0 || q.serviceIds.includes(serviceId),
  );
}

/**
 * Validate the customer's answers against the questions the shop actually
 * asked, and produce the snapshot to freeze onto the appointment.
 *
 * Pure, so every refusal below is directly testable without a database.
 *
 * The rules, in the order they bite:
 *  1. An answer to a question this shop does not ask is DROPPED, silently.
 *  2. A required question with no answer refuses the booking, naming itself.
 *  3. A too-long answer is refused rather than truncated - silently storing
 *     half an address is worse than saying it is too long.
 *  4. `select` must be one of the offered options; anything else is refused,
 *     so the stored value is always one the shop can act on.
 *  5. Blank optional answers are simply left out of the snapshot: an empty
 *     row on the barber's sheet is noise, not information.
 */
export function resolveIntake(
  questions: PublicBookingQuestion[],
  answers: { questionId: string; value: string }[] | undefined,
): IntakeResult {
  const byId = new Map(questions.map((q) => [q.id, q]));
  // Last answer wins for a repeated id - a duplicate is a client bug, not a
  // reason to refuse someone's booking.
  const given = new Map<string, string>();
  for (const a of answers ?? []) {
    if (byId.has(a.questionId)) given.set(a.questionId, a.value);
  }

  const snapshot: IntakeAnswer[] = [];
  // Iterate the QUESTIONS, not the answers, so the snapshot is always in the
  // shop's own order and a missing required answer is noticed.
  for (const q of questions) {
    const value = (given.get(q.id) ?? "").trim();
    if (value === "") {
      if (q.required) {
        return {
          ok: false,
          questionId: q.id,
          message: `${q.label} is required.`,
        };
      }
      continue;
    }
    if (value.length > MAX_LENGTH[q.kind]) {
      return {
        ok: false,
        questionId: q.id,
        message: `${q.label} is too long (max ${MAX_LENGTH[q.kind]} characters).`,
      };
    }
    if (q.kind === "select" && !q.options.includes(value)) {
      return { ok: false, questionId: q.id, message: `Choose one of the options for ${q.label}.` };
    }
    if (q.kind === "email" && !isLikelyEmail(value)) {
      return { ok: false, questionId: q.id, message: `${q.label} doesn't look like an email address.` };
    }
    if (q.kind === "number" && !Number.isFinite(Number(value))) {
      return { ok: false, questionId: q.id, message: `${q.label} should be a number.` };
    }
    snapshot.push({ questionId: q.id, label: q.label, kind: q.kind, value });
  }
  return { ok: true, snapshot };
}

/**
 * Read a stored snapshot back for display. Tolerant by design: this renders on
 * the barber's appointment sheet, and a row written by an older or newer shape
 * must degrade to "show what is readable" rather than break the sheet.
 */
export function readIntakeSnapshot(raw: unknown): IntakeAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: IntakeAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { questionId, label, kind, value } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof value !== "string") continue;
    out.push({
      questionId: typeof questionId === "string" ? questionId : "",
      label,
      kind: isKind(kind) ? kind : "text",
      value,
    });
  }
  return out;
}

const KINDS: readonly BookingQuestionKindId[] = [
  "text",
  "textarea",
  "address",
  "select",
  "phone",
  "email",
  "number",
];

function isKind(v: unknown): v is BookingQuestionKindId {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** Every kind, for the tests that pin config and the database enum together. */
export const BOOKING_QUESTION_KINDS = KINDS;
