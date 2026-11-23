/** Words for in-app alerts, shared by the website and the phone. */
export type AlertKind =
  | "mention" | "reply" | "photo_comment"
  | "issue_assigned" | "issue_reported" | "issue_submitted" | "issue_approved" | "issue_sent_back" | "issue_reopened";

/** For the alert settings screen, in the order shown. `managers` = only useful to people who assign and approve. */
export const ALERT_KINDS: { kind: AlertKind; label: string; managers?: boolean }[] = [
  { kind: "mention", label: "Someone @mentions me" },
  { kind: "reply", label: "Someone replies to my comment" },
  { kind: "photo_comment", label: "Someone comments on a photo I took" },
  { kind: "issue_assigned", label: "An issue is assigned to me" },
  { kind: "issue_sent_back", label: "My fix is sent back" },
  { kind: "issue_approved", label: "My fix is approved" },
  { kind: "issue_reopened", label: "An issue I fixed is reopened" },
  { kind: "issue_reported", label: "Someone reports an issue (managers)", managers: true },
  { kind: "issue_submitted", label: "A fix is waiting for my review (managers)", managers: true },
];

export interface AlertLike {
  kind: AlertKind;
  actor: string;
  jobNumber: string;
  issueTitle?: string | null;
  snippet?: string | null;
}

/** One line, e.g. "Morgan Manager assigned you “Missing bolt” on HP-1001". */
export function alertText(a: AlertLike): string {
  const issue = a.issueTitle ? `“${a.issueTitle}”` : "an issue";
  switch (a.kind) {
    case "mention": return `${a.actor} mentioned you on ${a.jobNumber}`;
    case "reply": return `${a.actor} replied to your comment on ${a.jobNumber}`;
    case "photo_comment": return `${a.actor} commented on your photo on ${a.jobNumber}`;
    case "issue_assigned": return `${a.actor} assigned you ${issue} on ${a.jobNumber}`;
    case "issue_reported": return `${a.actor} reported ${issue} on ${a.jobNumber}`;
    case "issue_submitted": return `${a.actor} sent a fix for ${issue} on ${a.jobNumber}`;
    case "issue_approved": return `${a.actor} approved your fix for ${issue} on ${a.jobNumber}`;
    case "issue_sent_back": return `${a.actor} sent back ${issue} on ${a.jobNumber}`;
    case "issue_reopened": return `${a.actor} reopened ${issue} on ${a.jobNumber}`;
    default: return `${a.actor} did something on ${a.jobNumber}`;
  }
}

/** "5m", "3h", "2d", or a date. */
export function alertAge(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / 1440)}d`;
  return new Date(iso).toLocaleDateString();
}
