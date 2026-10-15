/**
 * Which services the Block off form offers under "Selected services".
 *
 * A block names what it stops on EVERY chair it covers, and the API refuses a
 * service one of the chosen providers does not offer (services/blockOff.ts),
 * so the list is the services every chosen provider offers. With no provider
 * picked yet it is every service someone offers, so the list is never empty
 * just because "Who" comes first.
 */

export interface BlockableService {
  id: string;
  name: string;
  active: boolean;
  staffIds: string[];
  sortOrder: number;
}

export function blockableServices<S extends BlockableService>(
  services: readonly S[],
  staffIds: readonly string[],
): S[] {
  return services
    .filter((s) => s.active)
    .filter((s) =>
      staffIds.length === 0
        ? s.staffIds.length > 0
        : staffIds.every((id) => s.staffIds.includes(id)),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * The ids a save sends: what was ticked AND is still on the list. Changing
 * "Who" can take a ticked service off it; it is dropped rather than sent and
 * refused.
 */
export function scopedServiceIds(
  picked: readonly string[],
  offered: readonly { id: string }[],
): string[] {
  const on = new Set(offered.map((s) => s.id));
  return picked.filter((id) => on.has(id));
}
