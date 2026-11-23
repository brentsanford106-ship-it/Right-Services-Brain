import { describe, expect, it } from "vitest";
import { groupIssues, issueStatusText } from "../src/issues";

describe("issues: words and groups", () => {
  it("says Sent back / Reopened instead of Open when that is what happened", () => {
    expect(issueStatusText({ status: "open", lastEvent: "reported" })).toBe("Open");
    expect(issueStatusText({ status: "open", lastEvent: "sent_back" })).toBe("Sent back");
    expect(issueStatusText({ status: "open", lastEvent: "reopened" })).toBe("Reopened");
    expect(issueStatusText({ status: "awaiting_review", lastEvent: "submitted" })).toBe("Waiting for review");
    expect(issueStatusText({ status: "resolved" })).toBe("Fixed");
  });
  it("every issue lands in exactly one group, in working order, and empty groups are left out", () => {
    const items = [
      { id: 1, status: "resolved" as const, assigneeId: "a" },
      { id: 2, status: "open" as const, assigneeId: null },
      { id: 3, status: "in_progress" as const, assigneeId: "a" },
      { id: 4, status: "awaiting_review" as const, assigneeId: "a" },
      { id: 5, status: "open" as const, assigneeId: "b" },
    ];
    const g = groupIssues(items);
    expect(g.map((x) => x.key)).toEqual(["review", "unassigned", "fixing", "fixed"]);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([[4], [2], [3, 5], [1]]);
    expect(g.flatMap((x) => x.items).length).toBe(items.length);
    expect(groupIssues([items[0]!]).map((x) => x.key)).toEqual(["fixed"]);
  });
});
