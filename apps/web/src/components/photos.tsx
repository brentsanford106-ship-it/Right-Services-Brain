import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Photo } from "@rsb/contracts";
import { api, ApiRequestError, fetchImage } from "../lib/api";
import { useCan, useOrgId } from "../lib/hooks";

export type Filter = "all" | "before" | "during" | "after" | "flagged";
export const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "flagged", label: "⚑ Flagged" },
];
export const STAGES = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
] as const;

export function applyFilter(items: Photo[], f: Filter): Photo[] {
  if (f === "all") return items;
  if (f === "flagged") return items.filter((p) => p.flagged);
  return items.filter((p) => p.stage === f);
}

export const stageLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Upload state as the office sees it. "pending" means the phone recorded it but the file hasn't arrived yet. */
export function SyncBadge({ p }: { p: Photo }) {
  if (p.uploadStatus === "stored") return <span className="pill ok">Uploaded</span>;
  if (p.uploadStatus === "rejected") return <span className="pill err">Rejected</span>;
  return <span className="pill warn" title="The phone saved this photo but the image file has not arrived yet.">Waiting for file</span>;
}

/** An image loaded with the signed-in person's token. Freed from memory when it leaves the screen. */
export function AuthImage({ path, alt, className }: { path: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchImage(path)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  if (failed) return <div className={`imgph ${className ?? ""}`}>Image unavailable</div>;
  if (!url) return <div className={`imgph ${className ?? ""}`} aria-busy="true" />;
  return <img src={url} alt={alt} className={className} />;
}

export function FilterBar({ value, onChange, items }: { value: Filter; onChange: (f: Filter) => void; items: Photo[] }) {
  return (
    <div className="filters" role="group" aria-label="Filter photos">
      {FILTERS.map((f) => (
        <button key={f.value} className={`chip ${value === f.value ? "on" : ""} ${f.value === "flagged" ? "flagchip" : ""}`} aria-pressed={value === f.value} onClick={() => onChange(f.value)}>
          {f.label} <span className="count">{applyFilter(items, f.value).length}</span>
        </button>
      ))}
    </div>
  );
}

/** Records the export on the server, then saves each photo (display-size JPEG, no location data) to the computer. */
export async function downloadPhotos(orgId: string, photos: Photo[]): Promise<void> {
  const ready = photos.filter((p) => p.uploadStatus === "stored");
  if (!ready.length) throw new Error("None of these photos have finished uploading yet.");
  await api(`/v1/orgs/${orgId}/photos/exports`, { method: "POST", body: { photoIds: ready.map((p) => p.id), channel: "download" } });
  for (const [n, p] of ready.entries()) {
    const url = await fetchImage(`/v1/orgs/${orgId}/photos/${p.id}/content`);
    const a = document.createElement("a");
    a.href = url;
    a.download = `RightServices-${p.jobNumber}-${n + 1}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function PhotoGrid({ items, onOpen, showJob, selected, onToggle }: { items: Photo[]; onOpen: (index: number) => void; showJob?: boolean; selected?: Set<string>; onToggle?: (id: string) => void }) {
  const orgId = useOrgId();
  if (items.length === 0) return <p className="muted">No photos match.</p>;
  return (
    <ul className="grid" aria-label="Photos">
      {items.map((p, i) => (
        <li key={p.id} className={`tile ${p.flagged ? "flagged" : ""} ${selected?.has(p.id) ? "picked" : ""}`}>
          <button
            onClick={() => (selected && onToggle ? onToggle(p.id) : onOpen(i))}
            aria-pressed={selected ? selected.has(p.id) : undefined}
            aria-label={`${selected ? "Select" : "Open"} ${stageLabel(p.stage)} photo from ${new Date(p.capturedAt).toLocaleString()}${p.flagged ? ", flagged" : ""}`}
          >
            {selected && <span className={`pick ${selected.has(p.id) ? "on" : ""}`} aria-hidden>{selected.has(p.id) ? "✓" : ""}</span>}
            {p.hasPreview ? <AuthImage path={`/v1/orgs/${orgId}/photos/${p.id}/content`} alt="" className="thumb" /> : <div className="imgph thumb">{p.uploadStatus === "pending" ? "File not uploaded yet" : "No preview"}</div>}
            {p.flagged && <span className="flagmark" aria-hidden>⚑</span>}
          </button>
          <div className="meta">
            <span>{stageLabel(p.stage)}</span>
            {showJob && <strong>{p.jobNumber}</strong>}
            <span className="muted small">{new Date(p.capturedAt).toLocaleDateString()}</span>
          </div>
          {p.uploadStatus !== "stored" && <SyncBadge p={p} />}
          {p.note && <p className="note small">{p.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Full-screen viewer with flag/unflag, note and stage editing. Arrow keys move between photos; Esc closes. */
export function Lightbox({ items, index, onIndex, onClose, invalidate }: { items: Photo[]; index: number; onIndex: (i: number) => void; onClose: () => void; invalidate: unknown[][] }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const p = items[index];
  const canOriginal = useCan("photos.read_original");
  const canManage = useCan("photo_flags.manage");
  const canExport = useCan("photos.export");
  const [note, setNote] = useState(p?.note ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setNote(p?.note ?? ""), [p?.id, p?.note]);

  const prev = useCallback(() => index > 0 && onIndex(index - 1), [index, onIndex]);
  const next = useCallback(() => index < items.length - 1 && onIndex(index + 1), [index, items.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  const update = useMutation({
    mutationFn: (body: { flagged?: boolean; note?: string | null; stage?: string }) => api<Photo>(`/v1/orgs/${orgId}/photos/${p!.id}`, { method: "PATCH", body }),
    onSuccess: async () => {
      setErr(null);
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onError: (e) => setErr(e instanceof ApiRequestError && e.status === 403 ? "You don't have permission to change this photo." : "Couldn't save. Try again."),
  });

  const remove = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/photos/${p!.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setErr(null);
      if (items.length <= 1) onClose();
      else if (index === items.length - 1) onIndex(index - 1);
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onError: () => setErr("Couldn't delete this photo."),
  });

  const downloadOriginal = async () => {
    try {
      const url = await fetchImage(`/v1/orgs/${orgId}/photos/${p!.id}/content?variant=original`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${p!.jobNumber}-${p!.capturedAt.replace(/[:.]/g, "-")}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setErr("Original could not be downloaded.");
    }
  };

  if (!p) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div className="lb-image">
        <button className="lb-close" onClick={onClose} aria-label="Close">✕</button>
        <button className="lb-nav left" onClick={prev} disabled={index === 0} aria-label="Previous photo">‹</button>
        {p.hasPreview ? <AuthImage key={p.id} path={`/v1/orgs/${orgId}/photos/${p.id}/content`} alt={`${p.jobNumber} ${stageLabel(p.stage)} photo`} className={`full ${p.flagged ? "flagged" : ""}`} /> : <div className="imgph full">{p.uploadStatus === "pending" ? "The phone hasn't uploaded this file yet." : "No preview available (e.g. HEIC). Download the original."}</div>}
        <button className="lb-nav right" onClick={next} disabled={index === items.length - 1} aria-label="Next photo">›</button>
      </div>
      <aside className="lb-side">
        <div className="muted small">
          {index + 1} of {items.length}
        </div>
        <h2>{p.jobNumber}</h2>
        {p.siteName && <div className="muted">{p.siteName}</div>}
        <dl className="facts">
          <dt>Taken</dt>
          <dd>{new Date(p.capturedAt).toLocaleString()}</dd>
          <dt>By</dt>
          <dd>{p.uploadedBy}</dd>
          <dt>Status</dt>
          <dd><SyncBadge p={p} /></dd>
          <dt>Location</dt>
          <dd>{p.latitude != null && p.longitude != null ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}` : "Not recorded"}</dd>
          {p.widthPx && <><dt>Size</dt><dd>{p.widthPx} × {p.heightPx}</dd></>}
        </dl>
        <button className={`flagbtn ${p.flagged ? "on" : ""}`} disabled={!canManage || update.isPending} onClick={() => update.mutate({ flagged: !p.flagged })}>
          {p.flagged ? "⚑ Flagged — click to unflag" : "⚑ Flag this photo"}
        </button>
        <div>
          <div className="label">Stage</div>
          <div className="filters">
            {STAGES.map((s) => (
              <button key={s.value} className={`chip ${p.stage === s.value ? "on" : ""}`} aria-pressed={p.stage === s.value} disabled={!canManage || update.isPending} onClick={() => update.mutate({ stage: s.value })}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <label className="label" htmlFor="note">Note</label>
        <textarea id="note" rows={4} maxLength={2000} value={note} disabled={!canManage} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
        {note !== (p.note ?? "") && (
          <button className="primary" disabled={update.isPending} onClick={() => update.mutate({ note: note.trim() || null })}>
            Save note
          </button>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        {canExport && p.uploadStatus === "stored" && (
          <button onClick={() => void downloadPhotos(orgId, [p]).catch(() => setErr("Couldn't download this photo."))}>Download photo</button>
        )}
        {p.canDelete && (
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this photo? An owner or manager can restore it from Recently deleted.")) remove.mutate();
            }}
          >
            Delete photo
          </button>
        )}
        {canOriginal && p.uploadStatus === "stored" && (
          <button onClick={() => void downloadOriginal()}>Download original (full resolution)</button>
        )}
      </aside>
    </div>
  );
}
