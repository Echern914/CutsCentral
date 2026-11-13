/**
 * The Services tab's three sections, and the menu's grouping.
 *
 * The tab was one long page: the add form, the list, upgrade prompts, groups,
 * holiday pricing, special days, add-ons and targeted slots, one under the
 * other. A barber looking for a price scrolled past all of it. Now the menu
 * is the first thing and the only thing; days that run differently and the
 * extras each get their own section.
 */

export const SERVICES_SECTIONS = ["menu", "dates", "extras"] as const;
export type ServicesSection = (typeof SERVICES_SECTIONS)[number];

export const SERVICES_SECTION_OPTIONS: readonly { key: ServicesSection; label: string }[] = [
  { key: "menu", label: "Menu" },
  { key: "dates", label: "Special dates" },
  { key: "extras", label: "Extras" },
];

/** A `?section=` value, or null when it is not one of ours (typo, old link). */
export function asServicesSection(raw: string | null | undefined): ServicesSection | null {
  return (SERVICES_SECTIONS as readonly string[]).includes(raw ?? "") ? (raw as ServicesSection) : null;
}

export interface MenuSection<S> {
  id: string;
  name: string;
  services: S[];
}

/**
 * The menu the way a client reads it on the booking page: each group that has
 * services, in the groups' order, with its services in the group's own saved
 * order; then every service that is in no live group.
 *
 * `services` must already be in the shop's display order (it decides the order
 * of the ungrouped ones). A group's `serviceIds` come from the API in the
 * group's saved order. A shop with no groups gets no sections and the same
 * flat list it always had.
 */
export function menuSections<S extends { id: string }>(
  services: readonly S[],
  groups: readonly { id: string; name: string; active: boolean; sortOrder: number; serviceIds: string[] }[],
): { sections: MenuSection<S>[]; ungrouped: S[] } {
  const byId = new Map(services.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const sections: MenuSection<S>[] = [];
  for (const g of groups.filter((x) => x.active).slice().sort((a, b) => a.sortOrder - b.sortOrder)) {
    const members: S[] = [];
    for (const id of g.serviceIds) {
      const s = byId.get(id);
      // First group wins: a service can only be drawn once.
      if (!s || placed.has(id)) continue;
      placed.add(id);
      members.push(s);
    }
    if (members.length > 0) sections.push({ id: g.id, name: g.name, services: members });
  }
  return { sections, ungrouped: services.filter((s) => !placed.has(s.id)) };
}
