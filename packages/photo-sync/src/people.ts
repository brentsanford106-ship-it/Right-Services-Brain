/**
 * "Who took it" helpers for the phone gallery: initials circles, the People filter and sorting.
 * Pure functions with no React, so they can be tested here.
 */

/** "John Smith" -> "JS", "Avery" -> "AV", unknown -> "?". Used where there's no profile picture. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

const PERSON_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#4d7c0f", "#b45309"];

/** The same person always gets the same color. Unknown is grey. */
export function personColor(key: string | null | undefined): string {
  if (!key) return "#6b7280";
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

/** What the gallery needs to know about who took a photo. */
export interface Attributed {
  capturedAt: string;
  /** "me" for my own photos, a person's id, or "unknown". */
  personKey: string;
  personName: string | null;
}

export type Sort = "oldest" | "newest" | "photographer";
export const SORT_LABELS: Record<Sort, string> = { newest: "Newest first", oldest: "Oldest first", photographer: "By who took it" };

/** Empty set = everyone. Otherwise only photos whose personKey is in the set. */
export function applyPeople<T extends Attributed>(items: T[], people: ReadonlySet<string>): T[] {
  return people.size === 0 ? items : items.filter((i) => people.has(i.personKey));
}

export function sortByView<T extends Attributed>(items: T[], sort: Sort): T[] {
  const byTime = (a: T, b: T) => a.capturedAt.localeCompare(b.capturedAt);
  const out = [...items];
  if (sort === "oldest") out.sort(byTime);
  else if (sort === "newest") out.sort((a, b) => byTime(b, a));
  else {
    const unknownLast = (x: T) => (x.personName === null ? 1 : 0);
    out.sort((a, b) => unknownLast(a) - unknownLast(b) || (a.personName ?? "").localeCompare(b.personName ?? "") || byTime(a, b));
  }
  return out;
}

/** Everyone who took at least one of these photos, with counts. Me first, unknown last, others A to Z. */
export function peopleOf<T extends Attributed>(items: T[]): { key: string; name: string | null; count: number }[] {
  const m = new Map<string, { key: string; name: string | null; count: number }>();
  for (const i of items) {
    const e = m.get(i.personKey) ?? { key: i.personKey, name: i.personName, count: 0 };
    e.count++;
    m.set(i.personKey, e);
  }
  const rank = (k: string) => (k === "me" ? 0 : k === "unknown" ? 2 : 1);
  return [...m.values()].sort((a, b) => rank(a.key) - rank(b.key) || (a.name ?? "").localeCompare(b.name ?? ""));
}
