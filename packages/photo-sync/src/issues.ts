/** Words and grouping for "issues to fix", shared by the website and the phone. */
export type IssueStatus = "open" | "in_progress" | "awaiting_review" | "resolved";

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  awaiting_review: "Waiting for review",
  resolved: "Fixed",
};

export const ISSUE_EVENT_LABEL: Record<string, string> = {
  reported: "reported it",
  assigned: "assigned it",
  unassigned: "took the person off it",
  started: "started on it",
  submitted: "sent a fix for review",
  approved: "approved the fix",
  sent_back: "sent it back",
  reopened: "reopened it",
  edited: "changed the wording",
  fix_photo_added: "added a fix photo",
};

/** "Sent back" reads better than "Open" when a fix was turned down. */
export function issueStatusText(i: { status: IssueStatus; lastEvent?: string | null }): string {
  if (i.status === "open" && i.lastEvent === "sent_back") return "Sent back";
  if (i.status === "open" && i.lastEvent === "reopened") return "Reopened";
  return ISSUE_STATUS_LABEL[i.status];
}

export interface IssueGroupable { status: IssueStatus; assigneeId: string | null }

/** Groups for a job's Issues list, in the order a manager works through them. Empty groups are left out. */
export function groupIssues<T extends IssueGroupable>(items: readonly T[]): { title: string; key: string; items: T[] }[] {
  const groups = [
    { key: "review", title: "Waiting for review", test: (i: T) => i.status === "awaiting_review" },
    { key: "unassigned", title: "Not assigned yet", test: (i: T) => i.status !== "resolved" && i.status !== "awaiting_review" && !i.assigneeId },
    { key: "fixing", title: "Being fixed", test: (i: T) => (i.status === "open" || i.status === "in_progress") && !!i.assigneeId },
    { key: "fixed", title: "Fixed", test: (i: T) => i.status === "resolved" },
  ];
  return groups.map((g) => ({ key: g.key, title: g.title, items: items.filter(g.test) })).filter((g) => g.items.length > 0);
}
