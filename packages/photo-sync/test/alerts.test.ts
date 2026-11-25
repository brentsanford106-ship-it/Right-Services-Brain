import { describe, expect, it } from "vitest";
import { ALERT_KINDS, alertAge, alertText, type AlertKind } from "../src/alerts";

describe("alert words", () => {
  it("every kind has a setting and a sentence naming who and which job", () => {
    const all: AlertKind[] = ["mention", "reply", "photo_comment", "issue_assigned", "issue_reported", "issue_submitted", "issue_approved", "issue_sent_back", "issue_reopened"];
    expect(ALERT_KINDS.map((k) => k.kind).sort()).toEqual([...all].sort());
    for (const kind of all) {
      const s = alertText({ kind, actor: "Morgan Manager", jobNumber: "HP-1001", issueTitle: "Missing bolt" });
      expect(s).toMatch(/^Morgan Manager .*HP-1001$/);
      if (kind.startsWith("issue_")) expect(s).toContain("“Missing bolt”");
    }
    expect(alertText({ kind: "issue_assigned", actor: "A", jobNumber: "J", issueTitle: null })).toBe("A assigned you an issue on J");
  });
  it("short ages", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(alertAge("2026-11-23T11:59:50Z", now)).toBe("now");
    expect(alertAge("2026-11-23T11:55:00Z", now)).toBe("5m");
    expect(alertAge("2026-11-23T09:00:00Z", now)).toBe("3h");
    expect(alertAge("2026-11-21T12:00:00Z", now)).toBe("2d");
  });
});
