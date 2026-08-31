/**
 * The measurement vocabulary for the support evaluation.
 *
 * 🔴 THE TARGET TAXONOMY NOW LIVES IN @chairback/config, not here. PR 0
 * declared it locally because there was nothing to run it against; PR 1
 * promoted it to `supportEngine.ts`, which is the code that must actually
 * return one of those outcomes. Re-exported below so the eval and the engine
 * cannot end up describing outcomes differently.
 *
 * What remains genuinely local is `ObservedBehavior`: how the evaluation
 * CLASSIFIES a response after the fact. It is not something any runtime path
 * returns, and it deliberately includes failure classes the target taxonomy
 * exists to eliminate.
 */

export {
  SUPPORT_OUTCOMES,
  type KnowledgeAuthority,
  type SupportActor,
  type SupportChannel,
  type SupportOutcome,
} from "@chairback/config";

/** The channels a question can arrive on. */
export const SUPPORT_CHANNELS = ["in_app", "mcp"] as const;

/** Every actor, as an array — the type union's runtime twin, for the eval. */
export const SUPPORT_ACTORS = [
  "public_customer",
  "verified_customer",
  "barber",
  "manager",
  "owner",
  "platform_admin",
  "mcp_user",
] as const;

/** Authority ranking, as an array. Lower index never loses to a higher one. */
export const KNOWLEDGE_AUTHORITIES = [
  "live_state",
  "app_config",
  "help_corpus",
  "static_content",
  /**
   * Model general knowledge. Not part of the engine's authority union on
   * purpose — no ChairBack surface may ground an answer in it — but named
   * here so the ranking it sits at the bottom of is written down somewhere.
   */
  "model_general",
] as const;

/**
 * What the CURRENT surfaces were observed to do with one question.
 *
 * Ordered best → worst, and `wrong_answer` sorts below `shrug` deliberately:
 * a confidently wrong answer is the most expensive thing a help surface can
 * produce, because the asker acts on it.
 */
export const OBSERVED_BEHAVIORS = [
  /** Confident answer whose corpus id is in the capability's accepted set. */
  "correct_answer",
  /** No confident answer, but an accepted id appears among the suggestions. */
  "near_miss",
  /** No confident answer and no accepted id among the suggestions. */
  "shrug",
  /** Scored zero everywhere: the hard-coded fallback topic menu. */
  "generic_menu",
  /** Confident answer whose id is NOT accepted for this question. */
  "wrong_answer",
] as const;

export type ObservedBehavior = (typeof OBSERVED_BEHAVIORS)[number];
