import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMMENT_MAX, type JobPerson, type PhotoComment } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId } from "../lib/hooks";
import { PersonBadge } from "./photos";

/** Keeps only the people whose "@Name" is still in the text (so deleting the name also drops the mention). */
export function mentionsIn(body: string, picked: JobPerson[]): string[] {
  return [...new Set(picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id))];
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError && e.status === 403) return "You don't have permission to do that.";
  if (e instanceof ApiRequestError && e.status === 400) return e.message || "Check the comment and try again.";
  return "Couldn't save. Check your connection and try again.";
}

/** The comment box, used for new comments, replies and edits. */
function Composer({ jobId, initial = "", label, onSend, onCancel, busy }: {
  jobId: string; initial?: string; label: string; busy: boolean;
  onSend: (body: string, mentionIds: string[]) => void; onCancel?: () => void;
}) {
  const orgId = useOrgId();
  const [body, setBody] = useState(initial);
  const [picked, setPicked] = useState<JobPerson[]>([]);
  const people = useQuery({
    queryKey: [orgId, "job-people", jobId],
    queryFn: () => api<{ items: JobPerson[] }>(`/v1/orgs/${orgId}/jobs/${jobId}/people`),
    staleTime: 60_000,
    refetchInterval: false, // the job's people rarely change; no need to re-check every 30 s
  });
  const mention = (id: string) => {
    const p = people.data?.items.find((x) => x.id === id);
    if (!p) return;
    setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, p]));
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@${p.name} `);
  };
  const send = () => {
    const text = body.trim();
    if (!text) return;
    onSend(text, mentionsIn(text, picked));
  };
  return (
    <div className="composer">
      <textarea
        aria-label={label}
        rows={2}
        maxLength={COMMENT_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={label}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
      />
      <div className="row">
        <select aria-label="Mention someone" value="" onChange={(e) => mention(e.target.value)} disabled={!people.data}>
          <option value="">@ Mention…</option>
          {people.data?.items.filter((p) => !p.me).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={busy || !body.trim()} onClick={send}>{initial ? "Save" : "Send"}</button>
      </div>
    </div>
  );
}

type MarkRef = { id: string; name: string };

function CommentView({ c, jobId, onReply, invalidate, marks, onShowMark }: { c: PhotoComment; jobId: string; onReply?: () => void; invalidate: () => Promise<void>; marks: MarkRef[]; onShowMark?: (id: string) => void }) {
  const orgId = useOrgId();
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (v: { body: string; mentionIds: string[] }) => api(`/v1/orgs/${orgId}/photo-comments/${c.id}`, { method: "PATCH", body: v }),
    onSuccess: async () => { setEditing(false); setErr(null); await invalidate(); },
    onError: (e) => setErr(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/photo-comments/${c.id}`, { method: "DELETE" }),
    onSuccess: async () => { setErr(null); await invalidate(); },
    onError: (e) => setErr(errorText(e)),
  });
  return (
    <div className={`comment ${c.parentId ? "reply" : ""}`} data-testid="comment">
      <PersonBadge id={c.authorId} name={c.author} avatarAt={c.authorAvatarAt} className="sm" />
      <div className="cbody">
        <div className="small"><strong>{c.author}</strong>{c.mine ? " (you)" : ""} <span className="muted">{when(c.createdAt)}{c.editedAt && !c.deletedAt ? " · edited" : ""}</span></div>
        {c.markupId && !c.deletedAt && (() => {
          const m = marks.find((x) => x.id === c.markupId);
          return m ? <button className="link small" onClick={() => onShowMark?.(m.id)}>📍 About the {m.name}</button> : <span className="muted small">📍 About a mark that was removed</span>;
        })()}
        {c.deletedAt ? (
          <p className="muted small"><em>Comment deleted{c.deletedBy ? ` by ${c.deletedBy}` : ""}</em></p>
        ) : editing ? (
          <Composer jobId={jobId} initial={c.body ?? ""} label="Edit comment" busy={edit.isPending} onCancel={() => setEditing(false)} onSend={(body, mentionIds) => edit.mutate({ body, mentionIds })} />
        ) : (
          <p className="ctext">{c.body}</p>
        )}
        {!editing && !c.deletedAt && (
          <div className="cactions small">
            {onReply && <button className="link" onClick={onReply}>Reply</button>}
            {c.canEdit && <button className="link" onClick={() => setEditing(true)}>Edit</button>}
            {c.canDelete && (
              <button className="link danger" disabled={remove.isPending} onClick={() => { if (window.confirm("Delete this comment? It will show as \"Comment deleted\".")) remove.mutate(); }}>Delete</button>
            )}
          </div>
        )}
        {err && <p className="error small" role="alert">{err}</p>}
      </div>
    </div>
  );
}

/** Comments and one level of replies on one photo, inside the photo viewer. */
export function CommentsPanel({ photoId, jobId, onChanged, marks = [], aboutMark = null, onClearMark, onShowMark }: {
  photoId: string; jobId: string; onChanged: () => Promise<void>;
  /** Marks drawn on the photo, so a comment can be about one of them. */
  marks?: MarkRef[]; aboutMark?: MarkRef | null; onClearMark?: () => void; onShowMark?: (id: string) => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const canComment = useCan("photo_comments.create");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(0); // clears the box only after a comment was saved
  const key = [orgId, "comments", photoId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: PhotoComment[] }>(`/v1/orgs/${orgId}/photos/${photoId}/comments`) });
  const invalidate = async () => { await qc.invalidateQueries({ queryKey: key }); await onChanged(); };
  const add = useMutation({
    mutationFn: (v: { body: string; mentionIds: string[]; parentId: string | null; markupId?: string | null }) =>
      api<PhotoComment>(`/v1/orgs/${orgId}/photos/${photoId}/comments`, { method: "POST", body: { clientRef: crypto.randomUUID(), ...v } }),
    onSuccess: async () => { setErr(null); setReplyTo(null); setSent((n) => n + 1); onClearMark?.(); await invalidate(); },
    onError: (e) => setErr(errorText(e)),
  });

  const items = q.data?.items ?? [];
  const tops = items.filter((c) => !c.parentId);
  const repliesTo = (id: string) => items.filter((c) => c.parentId === id);
  const live = items.filter((c) => !c.deletedAt).length;

  return (
    <section className="comments" aria-label="Comments">
      <div className="label">Comments{live ? ` (${live})` : ""}</div>
      {q.isLoading && <p className="muted small">Loading comments…</p>}
      {q.isError && <p className="error small">Comments couldn't be loaded.</p>}
      {q.data && !tops.length && <p className="muted small">No comments yet.</p>}
      {tops.map((c) => (
        <div key={c.id} className="thread">
          <CommentView c={c} jobId={jobId} invalidate={invalidate} marks={marks} onShowMark={onShowMark} onReply={canComment ? () => setReplyTo(c.id) : undefined} />
          {repliesTo(c.id).map((r) => <CommentView key={r.id} c={r} jobId={jobId} invalidate={invalidate} marks={marks} onShowMark={onShowMark} />)}
          {replyTo === c.id && (
            <div className="reply">
              <Composer key={`reply-${c.id}`} jobId={jobId} label={`Reply to ${c.author}`} busy={add.isPending} onCancel={() => setReplyTo(null)} onSend={(body, mentionIds) => add.mutate({ body, mentionIds, parentId: c.id })} />
            </div>
          )}
        </div>
      ))}
      {canComment && aboutMark && (
        <div className="about-mark small">📍 Commenting on the {aboutMark.name} <button className="link" onClick={onClearMark} aria-label="Not about this mark">✕</button></div>
      )}
      {canComment && <Composer key={`new-${photoId}-${sent}`} jobId={jobId} label={aboutMark ? `Comment on the ${aboutMark.name}` : "Add a comment"} busy={add.isPending} onSend={(body, mentionIds) => add.mutate({ body, mentionIds, parentId: null, markupId: aboutMark?.id ?? null })} />}
      {canComment && !aboutMark && marks.length > 0 && <p className="muted small">Tip: click a drawing on the photo to comment on it.</p>}
      {err && <p className="error small" role="alert">{err}</p>}
    </section>
  );
}
