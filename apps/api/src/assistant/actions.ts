import { z } from "zod";

/**
 * THE BOOKING CHAT'S WHOLE VOCABULARY.
 *
 * Every turn ends as exactly one of these actions: from a menu tap, from a
 * signed button, or from the server's rules reading a typed message
 * (guided.ts). Nothing here writes a reply the person reads - the server runs
 * the action and writes every sentence from live data. Anything that changes
 * a booking needs a confirm token, minted from a preview and redeemed by the
 * person's own tap (assistant/confirm.ts).
 *
 * Default-deny: an action not in this table is refused (`decideAction`), and
 * the actions marked `buttonOnly` are refused when they come from typed text.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
/** A short reference the SERVER handed out this turn ("A1"), never a raw id. */
const APPT_REF = z.string().regex(/^A\d{1,2}$/, "an appointment ref like A1");
/** Only ever inside a SIGNED button (confirm.ts signPick). */
const ID = z.string().min(1).max(64);
const SLOT = z.string().min(1).max(200);
const PART = z.enum(["morning", "afternoon"]);

export const ACTION_ARGS = {
  list_services: z.object({}).strict(),
  find_openings: z
    .object({
      service: z.string().min(1).max(60),
      date: DATE.optional(),
      to_date: DATE.optional(),
      barber: z.string().min(1).max(60).optional(),
      part: PART.optional(),
    })
    .strict(),
  my_appointments: z.object({}).strict(),
  reschedule: z.object({ appointment: APPT_REF, date: DATE.optional(), part: PART.optional() }).strict(),
  cancel: z.object({ appointment: APPT_REF }).strict(),
  ask_shop: z.object({}).strict(),
  // ── only from a TAP on something the server drew ───────────────────────
  pick_slot: z.object({ slot_id: SLOT }).strict(),
  pick_new_slot: z.object({ appointment_id: ID, slot_id: SLOT }).strict(),
  pick_move: z.object({ appointment_id: ID, from: DATE.optional() }).strict(),
  pick_cancel: z.object({ appointment_id: ID }).strict(),
  // ── the menu: reliable choices, reachable by tapping (and from text) ───
  menu: z.object({}).strict(),
  book_start: z.object({}).strict(),
  /** `from`: the "Later dates" page of the day buttons. */
  book_service: z.object({ service: z.string().min(1).max(60), from: DATE.optional() }).strict(),
  move_start: z.object({}).strict(),
  move_day: z.object({ appointment_id: ID, date: DATE, part: PART.optional() }).strict(),
  cancel_start: z.object({}).strict(),
  // ── server rules ───────────────────────────────────────────────────────
  /** Several bookings fit the words: the person picks one (real date, time, service shown). */
  choose_appointment: z.object({ intent: z.enum(["cancel", "move"]), refs: z.array(APPT_REF).min(2).max(6) }).strict(),
  /** "Never mind" / "keep it": withdraw what was on the table, truthfully. */
  never_mind: z.object({}).strict(),
  /** Two services at once: offered one at a time, as buttons. */
  one_at_a_time: z.object({ services: z.array(z.string().min(1).max(60)).min(2).max(3), date: DATE.optional() }).strict(),
  /** A message that tries to change the rules, or acts for someone else: refused, no action. */
  unsupported: z.object({ reason: z.enum(["bypass", "someone_else"]) }).strict(),
  /** Not enough to act on: the SERVER asks a fixed question for `missing`. */
  clarify: z.object({ missing: z.enum(["service", "date", "appointment", "what"]) }).strict(),
} as const;

export type ActionName = keyof typeof ACTION_ARGS;

/**
 * Which actions change a booking (preview first, then a confirm token), and
 * which can only arrive from a signed button - typed text naming them, however
 * it is worded, is refused.
 */
export const ACTION_RULES: Record<ActionName, { write: boolean; buttonOnly: boolean }> = {
  list_services: { write: false, buttonOnly: false },
  find_openings: { write: false, buttonOnly: false },
  my_appointments: { write: false, buttonOnly: false },
  // Proposing a move is a READ (it lists new times); the move itself is pick_new_slot.
  reschedule: { write: false, buttonOnly: false },
  cancel: { write: true, buttonOnly: false },
  ask_shop: { write: false, buttonOnly: false },
  pick_slot: { write: true, buttonOnly: true },
  pick_new_slot: { write: true, buttonOnly: true },
  pick_move: { write: false, buttonOnly: true },
  pick_cancel: { write: true, buttonOnly: true },
  menu: { write: false, buttonOnly: false },
  book_start: { write: false, buttonOnly: false },
  book_service: { write: false, buttonOnly: true },
  move_start: { write: false, buttonOnly: false },
  move_day: { write: false, buttonOnly: true },
  cancel_start: { write: false, buttonOnly: false },
  choose_appointment: { write: false, buttonOnly: false },
  never_mind: { write: false, buttonOnly: false },
  one_at_a_time: { write: false, buttonOnly: false },
  unsupported: { write: false, buttonOnly: false },
  clarify: { write: false, buttonOnly: false },
};

export interface ProposedAction {
  name: ActionName;
  args: Record<string, unknown>;
}

export type ActionDecision =
  | { ok: true; name: ActionName; args: Record<string, unknown>; write: boolean }
  | { ok: false; reason: "unknown_action" | "button_only" | "bad_args"; detail?: string };

/**
 * The one gate every action passes. `fromText` refuses the button-only actions
 * (a slot, a specific appointment id) - those exist only inside a button the
 * server signed for this person.
 */
export function decideAction(proposal: { name: string; args: unknown }, fromText: boolean): ActionDecision {
  if (!Object.prototype.hasOwnProperty.call(ACTION_RULES, proposal.name)) {
    return { ok: false, reason: "unknown_action" };
  }
  const name = proposal.name as ActionName;
  const rule = ACTION_RULES[name];
  if (fromText && rule.buttonOnly) return { ok: false, reason: "button_only" };
  const parsed = ACTION_ARGS[name].safeParse(proposal.args ?? {});
  if (!parsed.success) {
    return { ok: false, reason: "bad_args", detail: parsed.error.issues[0]?.message };
  }
  return { ok: true, name, args: parsed.data as Record<string, unknown>, write: rule.write };
}
