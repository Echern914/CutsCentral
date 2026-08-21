/**
 * Barber-configured upgrade prompts: "when someone books any of THESE, offer
 * them THAT instead."
 *
 * 🔑 A RULE ONLY CHOOSES CANDIDATES. Whether an upgrade is actually offered is
 * still decided by the availability engine at the customer's exact instant -
 * grid alignment, service hours, blocked time, the daily limit, targeted slots,
 * and the next appointment. A rule can never conjure a bookable time, and the
 * booking POST re-validates regardless. This module answers one question only:
 * WHICH services is it even worth asking the engine about.
 */

/** An upgrade edge: one source service may be upgraded to one destination. */
export interface UpgradeEdge {
  sourceServiceId: string;
  destinationServiceId: string;
}

export type RuleError =
  | { code: "no_sources"; message: string }
  | { code: "self_upgrade"; message: string }
  | { code: "cycle"; message: string };

/**
 * Would this rule be valid, given everything else already configured?
 *
 * Two ways a rule is nonsense:
 *
 *  1. SELF-UPGRADE. Offering a service as an upgrade of itself is a prompt that
 *     says "swap this for the same thing". Caught directly.
 *
 *  2. A CYCLE. A -> B and B -> A means each is an upgrade of the other, so
 *     whichever the customer picks they are told the other one is the better
 *     deal - and if both are "longer and dearer" than each other, one of them
 *     is lying. Longer chains do the same thing more quietly (A -> B -> C ->
 *     A), so this walks the whole graph rather than only checking the direct
 *     reverse.
 *
 * `existing` should be the shop's OTHER active edges (exclude the rule being
 * edited, or editing a rule always trips over itself).
 */
export function validateUpgradeRule(
  candidate: { sourceServiceIds: string[]; destinationServiceId: string },
  existing: UpgradeEdge[],
): RuleError | null {
  const sources = [...new Set(candidate.sourceServiceIds)];
  if (sources.length === 0) {
    return { code: "no_sources", message: "Pick at least one service to upgrade from" };
  }
  if (sources.includes(candidate.destinationServiceId)) {
    return {
      code: "self_upgrade",
      message: "A service can't be an upgrade of itself",
    };
  }

  // Adjacency over the edges that WOULD exist if this rule were saved.
  const next = new Map<string, string[]>();
  const add = (from: string, to: string) =>
    next.set(from, [...(next.get(from) ?? []), to]);
  for (const e of existing) add(e.sourceServiceId, e.destinationServiceId);
  for (const s of sources) add(s, candidate.destinationServiceId);

  // A cycle exists iff, from the new destination, we can walk back to any of
  // the new sources. Only the new edges can introduce one - everything already
  // stored was validated the same way when it was saved.
  const seen = new Set<string>();
  const stack = [candidate.destinationServiceId];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (sources.includes(at)) {
      return {
        code: "cycle",
        message:
          "That would make two services upgrades of each other — pick a different one",
      };
    }
    for (const to of next.get(at) ?? []) stack.push(to);
  }
  return null;
}

/**
 * The destination services configured as upgrades of `serviceId`.
 *
 * Returns null when the shop has configured NO active rules at all, which the
 * endpoint reads as "fall back to the automatic suggestions". That distinction
 * matters: an empty ARRAY means "this shop has rules and none apply to this
 * service, so offer nothing", while null means "this shop has never configured
 * upsells, keep doing what it has always done". Collapsing the two would
 * silently switch every existing shop's upsells off.
 */
export function destinationsFor(
  serviceId: string,
  activeEdges: UpgradeEdge[],
): string[] | null {
  if (activeEdges.length === 0) return null;
  return [
    ...new Set(
      activeEdges
        .filter((e) => e.sourceServiceId === serviceId)
        .map((e) => e.destinationServiceId),
    ),
  ];
}
