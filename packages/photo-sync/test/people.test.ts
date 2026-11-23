import { describe, expect, it } from "vitest";
import { applyPeople, initials, peopleOf, personColor, sortByView, type Attributed } from "../src/index";

const item = (personKey: string, personName: string | null, capturedAt: string): Attributed => ({ personKey, personName, capturedAt });

describe("who took it (phone gallery helpers)", () => {
  it("makes initials from a name", () => {
    expect(initials("John Smith")).toBe("JS");
    expect(initials("  mary  ann   lee ")).toBe("ML");
    expect(initials("Avery")).toBe("AV");
    expect(initials(null)).toBe("?");
    expect(initials("   ")).toBe("?");
  });

  it("gives the same person the same color, and unknown grey", () => {
    expect(personColor("abc")).toBe(personColor("abc"));
    expect(personColor(null)).toBe("#6b7280");
  });

  const items = [
    item("me", "Eli Employee", "2026-11-20T10:00:00Z"),
    item("p-john", "John Smith", "2026-11-20T09:00:00Z"),
    item("unknown", null, "2026-11-20T11:00:00Z"),
    item("p-ann", "Ann Lee", "2026-11-20T12:00:00Z"),
    item("p-john", "John Smith", "2026-11-20T08:00:00Z"),
  ];

  it("filters to one person, several people, or my own photos", () => {
    expect(applyPeople(items, new Set())).toHaveLength(5);
    expect(applyPeople(items, new Set(["p-john"])).map((i) => i.capturedAt)).toEqual(["2026-11-20T09:00:00Z", "2026-11-20T08:00:00Z"]);
    expect(applyPeople(items, new Set(["p-john", "p-ann"]))).toHaveLength(3);
    expect(applyPeople(items, new Set(["me"]))).toEqual([items[0]]);
  });

  it("sorts newest, oldest, or by who took it with unknown last", () => {
    expect(sortByView(items, "oldest").map((i) => i.capturedAt.slice(11, 13))).toEqual(["08", "09", "10", "11", "12"]);
    expect(sortByView(items, "newest").map((i) => i.capturedAt.slice(11, 13))).toEqual(["12", "11", "10", "09", "08"]);
    expect(sortByView(items, "photographer").map((i) => i.personName)).toEqual(["Ann Lee", "Eli Employee", "John Smith", "John Smith", null]);
  });

  it("lists people with counts: me first, unknown last", () => {
    expect(peopleOf(items)).toEqual([
      { key: "me", name: "Eli Employee", count: 1 },
      { key: "p-ann", name: "Ann Lee", count: 1 },
      { key: "p-john", name: "John Smith", count: 2 },
      { key: "unknown", name: null, count: 1 },
    ]);
  });
});
