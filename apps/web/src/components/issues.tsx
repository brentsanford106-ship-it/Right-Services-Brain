import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueAction, JobPerson, Photo, PhotoIssue, PhotoIssueEvent } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId } from "../lib/hooks";
import { ISSUE_EVENT_LABEL as EVENT_LABEL, ISSUE_STATUS_LABEL, groupIssues, issueStatusText } from "@rsb/photo-sync";
import { AuthImage, stageLabel } from "./photos";

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError && (e.status === 403 || e.status === 409 || e.status === 400)) return e.message || "That didn't work.";
  if (e instanceof ApiRequestError && e.status === 404) return "This issue or photo is no longer there.";
  return "Couldn't save. Check your connection and try again.";
}

function useJobPeople(jobId: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: [orgId, "job-people", jobId],
    queryFn: () => api<{ items: JobPerson[] }>(`/v1/orgs/${orgId}/jobs/${jobId}/people`),
    staleTime: 60_000,
    enabled,
  });
}

export function IssueStatusBadge({ issue }: { issue: Pick<PhotoIssue, "status" | "lastEvent"> }) {
  return <span className={`istatus ${issue.status} ${issue.lastEvent === "sent_back" && issue.status === "open" ? "sentback" : ""}`}>{issueStatusText(issue)}</span>;
}

/** Choose one photo from the same job for the Before or After box of a fix. */
function FixPhotoPicker({ jobId, exclude, stage, onPick }: { jobId: string; exclude: string; stage: "before" | "after"; onPick: (id: string) => void }) {
  const orgId = useOrgId();
  const photos = useQuery({
    queryKey: [orgId, "jobPhotos", `/jobs/${jobId}/photos`],
    queryFn: () => api<{ items: Photo[] }>(`/v1/orgs/${orgId}/jobs/${jobId}/photos`),
  });
  // Photos of the matching stage first, newest first.
  const items = (photos.data?.items ?? []).filter((p) => p.id !== exclude && p.uploadStatus === "stored")
    .sort((a, b) => Number(b.stage === stage) - Number(a.stage === stage) || b.capturedAt.localeCompare(a.capturedAt));
  if (photos.isLoading) return <p className="muted small">Loading the job's photos…</p>;
  if (!items.length) return <p className="muted small">No photos on this job yet. Take one on the phone (choose {stageLabel(stage)}), then pick it here.</p>;
  return (
    <ul className="fixpick" aria-label={`Choose the ${stageLabel(stage)} photo`}>
      {items.slice(0, 60).map((p) => (
        <li key={p.id}>
          <button aria-label={`${stageLabel(p.stage)} photo from ${new Date(p.capturedAt).toLocaleString()}`} onClick={() => onPick(p.id)}>
            {p.hasPreview ? <AuthImage path={`/v1/orgs/${orgId}/photos/${p.id}/content?variant=thumb`} alt="" className="thumb" /> : <div className="imgph thumb">No preview</div>}
            <span className="small">{stageLabel(p.stage)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A Before box and an After box. With onPick it's for choosing (empty boxes say what to do); otherwise for looking. */
function BeforeAfter({ beforeId, afterId, onOpen, onPick, picking }: {
  beforeId: string | null; afterId: string | null; onOpen?: (id: string) => void; onPick?: (stage: "before" | "after") => void; picking?: "before" | "after" | null;
}) {
  const orgId = useOrgId();
  const box = (stage: "before" | "after", id: string | null) => (
    <button key={stage} className={`fixbox ${id ? "filled" : "empty"} ${picking === stage ? "on" : ""}`}
      aria-label={`${stage === "before" ? "Before" : "After"} photo${id ? "" : stage === "after" ? " (needed)" : " (optional)"}`}
      onClick={() => (onPick ? onPick(stage) : id && onOpen?.(id))} disabled={!onPick && (!id || !onOpen)}>
      {id ? <AuthImage path={`/v1/orgs/${orgId}/photos/${id}/content?variant=thumb`} alt="" className="thumb" /> : <span className="muted small">{onPick ? `Choose a photo${stage === "after" ? " (needed)" : " (optional)"}` : "None"}</span>}
      <span className="fixtag">{stage === "before" ? "BEFORE" : "AFTER"}</span>
    </button>
  );
  return <div className="fixboxes">{box("before", beforeId)}{box("after", afterId)}</div>;
}

type Mode = null | "submit" | "approve" | "send_back" | "reopen" | "edit";

/** One issue with what the viewer may do with it. */
export function IssueCard({ issue, onChanged, onOpenPhoto, markName, onShowMark, showPhotoLink }: {
  issue: PhotoIssue; onChanged: () => Promise<void>;
  onOpenPhoto?: (photoId: string) => void; markName?: string | null; onShowMark?: () => void; showPhotoLink?: boolean;
}) {
  const orgId = useOrgId();
  const i = issue;
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [picking, setPicking] = useState<"before" | "after" | null>(null);
  const [title, setTitle] = useState(i.title);
  const [details, setDetails] = useState(i.details ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const people = useJobPeople(i.jobId, i.can.assign);
  const history = useQuery({
    queryKey: [orgId, "issue", i.id, i.updatedAt],
    queryFn: () => api<{ issue: PhotoIssue; history: PhotoIssueEvent[] }>(`/v1/orgs/${orgId}/photo-issues/${i.id}`),
    enabled: showHistory,
  });
  const act = useMutation({
    mutationFn: (body: { action: IssueAction; note?: string | null; assigneeId?: string | null; fixPhotoIds?: string[]; title?: string; details?: string | null }) =>
      api<PhotoIssue>(`/v1/orgs/${orgId}/photo-issues/${i.id}/actions`, { method: "POST", body: { clientRef: crypto.randomUUID(), expectedStatus: i.status, ...body } }),
    onSuccess: async () => { setErr(null); setMode(null); setNote(""); setBefore(null); setAfter(null); setPicking(null); await onChanged(); },
    onError: async (e) => { setErr(errorText(e)); if (e instanceof ApiRequestError && e.status === 409) await onChanged(); },
  });
  const open = (m: Mode) => { setErr(null); setNote(""); setBefore(null); setAfter(null); setPicking(m === "submit" ? "after" : null); setTitle(i.title); setDetails(i.details ?? ""); setMode(m); };

  return (
    <div className={`issue ${i.status}`} data-testid="issue">
      <div className="ihead">
        <strong className="ititle">🔧 {i.title}</strong>
        <IssueStatusBadge issue={i} />
      </div>
      {i.details && <p className="small idetails">{i.details}</p>}
      <div className="muted small">
        {i.assignee ? <>Assigned to <strong>{i.assignee}</strong></> : <>Not assigned yet</>} · reported by {i.createdBy} {when(i.createdAt)}
        {i.status === "awaiting_review" && i.submittedBy ? ` · fix sent by ${i.submittedBy}` : ""}
        {i.status === "resolved" && i.resolvedBy ? ` · approved by ${i.resolvedBy}` : ""}
      </div>
      {markName !== undefined && i.markupId && (
        markName ? <button className="link small" onClick={onShowMark}>📍 About the {markName}</button> : <span className="muted small">📍 About a mark that was removed</span>
      )}
      {showPhotoLink && (i.photoDeleted
        ? <span className="muted small">The photo was deleted (an owner or manager can restore it).</span>
        : <button className="link small" onClick={() => onOpenPhoto?.(i.photoId)}>Open the photo</button>)}
      {i.fixPhotoIds.length > 0 && mode !== "submit" && (
        <BeforeAfter onOpen={onOpenPhoto}
          beforeId={i.fixPhotoIds.find((_, n) => i.fixPhotoStages?.[n] === "before") ?? (i.photoDeleted ? null : i.photoId)}
          afterId={i.fixPhotoIds.filter((_, n) => i.fixPhotoStages?.[n] !== "before").at(-1) ?? null} />
      )}

      {mode === null && (
        <div className="iactions">
          {i.can.start && <button disabled={act.isPending} onClick={() => act.mutate({ action: "start" })}>Start</button>}
          {i.can.submit && <button className="primary" onClick={() => open("submit")}>Send fix for review</button>}
          {i.can.approve && <button className="primary" onClick={() => open("approve")}>Approve</button>}
          {i.can.sendBack && <button onClick={() => open("send_back")}>Send back</button>}
          {i.can.reopen && <button onClick={() => open("reopen")}>Reopen</button>}
          {i.can.edit && <button className="link" onClick={() => open("edit")}>Edit</button>}
          {i.can.assign && (
            <select aria-label="Assign to" value={i.assigneeId ?? ""} disabled={act.isPending || !people.data}
              onChange={(e) => act.mutate({ action: "assign", assigneeId: e.target.value || null })}>
              <option value="">{i.assigneeId ? "Take off this person" : "Assign to…"}</option>
              {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}{p.me ? " (me)" : ""}</option>)}
              {i.assigneeId && !people.data?.items.some((p) => p.id === i.assigneeId) && <option value={i.assigneeId}>{i.assignee}</option>}
            </select>
          )}
          {i.status === "awaiting_review" && !i.can.approve && i.submittedBy && i.can.assign && (
            <span className="muted small">Someone else has to approve a fix you sent.</span>
          )}
        </div>
      )}

      {mode === "submit" && (
        <div className="iform">
<BeforeAfter beforeId={before} afterId={after} picking={picking} onPick={(st) => setPicking(picking === st ? null : st)} />
          {picking && (
            <>
              <div className="label">Choose the {picking === "before" ? "Before" : "After"} photo{(picking === "before" ? before : after) ? <> · <button className="link small" onClick={() => { (picking === "before" ? setBefore : setAfter)(null); }}>Remove it</button></> : null}</div>
              <FixPhotoPicker jobId={i.jobId} exclude={i.photoId} stage={picking} onPick={(id) => { (picking === "before" ? setBefore : setAfter)(id); setPicking(picking === "before" && !after ? "after" : null); }} />
            </>
          )}
          <textarea aria-label="Note about the fix" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you do? (optional)" />
          <div className="row">
            <button onClick={() => setMode(null)}>Cancel</button>
            <button className="primary" disabled={act.isPending || !after} onClick={() => act.mutate({ action: "submit", note: note.trim() || null, fixPhotoIds: [after!, ...(before ? [before] : [])] })}>{after ? "Send for review" : "Choose an After photo"}</button>
          </div>
        </div>
      )}
      {(mode === "approve" || mode === "reopen") && (
        <div className="iform">
          <textarea aria-label="Note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "approve" ? "Note (optional)" : "Why is it being reopened? (optional)"} />
          <div className="row">
            <button onClick={() => setMode(null)}>Cancel</button>
            <button className="primary" disabled={act.isPending} onClick={() => act.mutate({ action: mode, note: note.trim() || null })}>{mode === "approve" ? "Approve fix" : "Reopen"}</button>
          </div>
        </div>
      )}
      {mode === "send_back" && (
        <div className="iform">
          <textarea aria-label="What still needs fixing" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What still needs fixing? (needed)" />
          <div className="row">
            <button onClick={() => setMode(null)}>Cancel</button>
            <button className="primary" disabled={act.isPending || !note.trim()} onClick={() => act.mutate({ action: "send_back", note: note.trim() })}>Send back</button>
          </div>
        </div>
      )}
      {mode === "edit" && (
        <div className="iform">
          <input aria-label="What needs fixing" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label="Details" rows={2} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Details (optional)" />
          <div className="row">
            <button onClick={() => setMode(null)}>Cancel</button>
            <button className="primary" disabled={act.isPending || !title.trim()} onClick={() => act.mutate({ action: "edit", title: title.trim(), details: details.trim() || null })}>Save</button>
          </div>
        </div>
      )}
      {err && <p className="error small" role="alert">{err}</p>}

      <button className="link small" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>{showHistory ? "Hide history" : "History"}</button>
      {showHistory && (
        history.isLoading ? <p className="muted small">Loading…</p>
          : history.isError ? <p className="error small">History couldn't be loaded.</p>
            : (
              <ol className="ihistory small" aria-label="Issue history">
                {history.data?.history.map((e) => (
                  <li key={e.id}>
                    <strong>{e.actor}</strong> {EVENT_LABEL[e.kind] ?? e.kind}
                    {(e.kind === "assigned") && e.assignee ? ` to ${e.assignee}` : ""}
                    {e.toStatus && e.fromStatus && e.toStatus !== e.fromStatus ? ` (${ISSUE_STATUS_LABEL[e.toStatus]})` : ""}
                    <span className="muted"> · {when(e.createdAt)}</span>
                    {e.note && <div className="inote">“{e.note}”</div>}
                  </li>
                ))}
              </ol>
            )
      )}
    </div>
  );
}

/** "Report issue" form. Managers can assign it straight away; others leave it for a manager. */
function ReportForm({ photoId, jobId, aboutMark, onDone, onCancel }: {
  photoId: string; jobId: string; aboutMark: { id: string; name: string } | null; onDone: () => Promise<void>; onCancel: () => void;
}) {
  const orgId = useOrgId();
  const canManage = useCan("photo_issues.manage");
  const people = useJobPeople(jobId, canManage);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ref] = useState(() => crypto.randomUUID()); // the same report sent twice is only saved once
  const add = useMutation({
    mutationFn: () => api<PhotoIssue>(`/v1/orgs/${orgId}/photos/${photoId}/issues`, {
      method: "POST",
      body: { clientRef: ref, title: title.trim(), details: details.trim() || null, markupId: aboutMark?.id ?? null, ...(canManage && assignee ? { assigneeId: assignee } : {}) },
    }),
    onSuccess: async () => { setErr(null); await onDone(); },
    onError: (e) => setErr(errorText(e)),
  });
  return (
    <div className="iform report">
      {aboutMark && <div className="small">📍 About the {aboutMark.name}</div>}
      <input aria-label="What needs fixing" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs fixing? e.g. Fix the gap in the caulk" autoFocus />
      <textarea aria-label="Details" rows={2} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Details (optional)" />
      {canManage ? (
        <select aria-label="Assign to" value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={!people.data}>
          <option value="">Don't assign yet</option>
          {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}{p.me ? " (me)" : ""}</option>)}
        </select>
      ) : (
        <p className="muted small">A manager will see this in the job's Issues list and assign it.</p>
      )}
      <div className="row">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={add.isPending || !title.trim()} onClick={() => add.mutate()}>Report issue</button>
      </div>
      {err && <p className="error small" role="alert">{err}</p>}
    </div>
  );
}

/** Issues on one photo, inside the photo viewer. */
export function IssuesPanel({ photoId, jobId, marks = [], aboutMark = null, onShowMark, onChanged, onOpenPhoto }: {
  photoId: string; jobId: string; marks?: { id: string; name: string }[]; aboutMark?: { id: string; name: string } | null;
  onShowMark?: (id: string) => void; onChanged: () => Promise<void>; onOpenPhoto?: (photoId: string) => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const canReport = useCan("photo_issues.create");
  const [reporting, setReporting] = useState(false);
  const key = [orgId, "photo-issues", photoId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: PhotoIssue[] }>(`/v1/orgs/${orgId}/photos/${photoId}/issues`) });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: key }); await onChanged(); };
  const items = q.data?.items ?? [];
  const active = items.filter((i) => i.status !== "resolved").length;
  return (
    <section className="issues" aria-label="Issues to fix">
      <div className="ihead">
        <div className="label">To fix{active ? ` (${active})` : ""}</div>
        {canReport && !reporting && <button onClick={() => setReporting(true)}>🔧 Report issue{aboutMark ? ` about the ${aboutMark.name}` : ""}</button>}
      </div>
      {q.isError && <p className="error small">Issues couldn't be loaded.</p>}
      {reporting && <ReportForm photoId={photoId} jobId={jobId} aboutMark={aboutMark} onCancel={() => setReporting(false)} onDone={async () => { setReporting(false); await refresh(); }} />}
      {q.data && !items.length && !reporting && <p className="muted small">Nothing to fix on this photo.</p>}
      {items.map((i) => (
        <IssueCard key={i.id} issue={i} onChanged={refresh} onOpenPhoto={onOpenPhoto}
          markName={i.markupId ? marks.find((m) => m.id === i.markupId)?.name ?? null : undefined}
          onShowMark={i.markupId ? () => onShowMark?.(i.markupId!) : undefined} />
      ))}
    </section>
  );
}

/** A list of issues grouped by where they are (the job's Issues section, or "assigned to me"). */
export function IssueList({ items, onChanged, onOpenPhoto, empty, groups = true }: {
  items: PhotoIssue[]; onChanged: () => Promise<void>; onOpenPhoto: (photoId: string, jobId: string) => void; empty: string; groups?: boolean;
}) {
  const [showFixed, setShowFixed] = useState(false);
  if (!items.length) return <p className="muted">{empty}</p>;
  const card = (i: PhotoIssue) => (
    <IssueCard key={i.id} issue={i} onChanged={onChanged} showPhotoLink onOpenPhoto={(pid) => onOpenPhoto(pid, i.jobId)} />
  );
  if (!groups) return <div className="issuelist">{items.map(card)}</div>;
  return (
    <div className="issuelist">
      {groupIssues(items).map((g) => {
        const these = g.items;
        if (g.key === "fixed") {
          return (
            <details key={g.title} open={showFixed} onToggle={(e) => setShowFixed((e.target as HTMLDetailsElement).open)}>
              <summary>{g.title} ({these.length})</summary>
              {showFixed && these.map(card)}
            </details>
          );
        }
        return (
          <div key={g.title} className="igroup">
            <h3>{g.title} ({these.length})</h3>
            {these.map(card)}
          </div>
        );
      })}
    </div>
  );
}
