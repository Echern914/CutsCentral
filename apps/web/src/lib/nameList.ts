/**
 * Names the way a person says them: "Sam", "Sam and Lee", "Sam, Lee and Kai".
 * Past `max` the rest are counted, so a notice naming a big team stays one
 * line: "Sam, Lee and 4 more".
 */
export function nameList(names: string[], max = 3): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0]!;
  if (clean.length > max) {
    const shown = clean.slice(0, max - 1);
    return `${shown.join(", ")} and ${clean.length - shown.length} more`;
  }
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}
