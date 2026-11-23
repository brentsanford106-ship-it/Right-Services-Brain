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

// ---------------------------------------------------------------- who took it

/** "John Smith" -> "JS", "Avery" -> "AV". Used where there's no profile picture. */
export function initials(name: string | null): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** A stable color per person, so the same person always gets the same circle. */
const PERSON_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#4d7c0f", "#b45309"];
export function personColor(id: string | null): string {
  if (!id) return "#6b7280";
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}

export const takenByLabel = (p: Photo) => p.photographer ?? "Unknown";

/** "me" = photos I took, "unknown" = photographer not known, otherwise a person's id. Empty = everyone. */
export type PeopleFilter = ReadonlySet<string>;
export type Sort = "oldest" | "newest" | "photographer";
export const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "photographer", label: "By who took it" },
];

export function applyPeople(items: Photo[], people: PeopleFilter): Photo[] {
  if (people.size === 0) return items;
  return items.filter(
    (p) => (people.has("me") && p.takenByMe) || (p.photographerId ? people.has(p.photographerId) : people.has("unknown")),
  );
}

export function sortPhotos(items: Photo[], sort: Sort): Photo[] {
  const byTime = (a: Photo, b: Photo) => a.capturedAt.localeCompare(b.capturedAt);
  const out = [...items];
  if (sort === "oldest") out.sort(byTime);
  else if (sort === "newest") out.sort((a, b) => byTime(b, a));
  // Unknown photographers last; within one person, oldest first.
  else out.sort((a, b) => (a.photographer === null ? 1 : 0) - (b.photographer === null ? 1 : 0) || (a.photographer ?? "").localeCompare(b.photographer ?? "") || byTime(a, b));
  return out;
}

/** Everyone who took at least one of these photos, with how many, A to Z. */
export function peopleIn(items: Photo[]): { id: string; name: string; count: number }[] {
  const m = new Map<string, { id: string; name: string; count: number }>();
  for (const p of items) {
    const id = p.photographerId ?? "unknown";
    const e = m.get(id) ?? { id, name: p.photographer ?? "Unknown", count: 0 };
    e.count++;
    m.set(id, e);
  }
  return [...m.values()].sort((a, b) => (a.id === "unknown" ? 1 : 0) - (b.id === "unknown" ? 1 : 0) || a.name.localeCompare(b.name));
}

/** Small colored circle with someone's initials. */
export function PersonBadge({ id, name, className }: { id: string | null; name: string | null; className?: string }) {
  return (
    <span className={`person ${className ?? ""}`} style={{ background: personColor(id) }} title={name ? `Taken by ${name}` : "Who took this is unknown"} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** "People" picker (who took the photos) and the sort order. Works with the stage/flag chips. */
export function PeopleAndSort({ items, people, onPeople, sort, onSort }: { items: Photo[]; people: PeopleFilter; onPeople: (p: PeopleFilter) => void; sort: Sort; onSort: (s: Sort) => void }) {
  const list = peopleIn(items);
  const mine = items.filter((p) => p.takenByMe).length;
  const toggle = (id: string) => {
    const next = new Set(people);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPeople(next);
  };
  const summary = people.size === 0 ? "Everyone" : people.size === 1 && people.has("me") ? "Photos I took" : `${people.size} selected`;
  return (
    <div className="viewbar">
      <details className="people">
        <summary aria-label={`Taken by: ${summary}`}>Taken by: <strong>{summary}</strong></summary>
        <div className="peoplemenu" role="group" aria-label="Show photos taken by">
          <label><input type="checkbox" checked={people.size === 0} onChange={() => onPeople(new Set())} /> Everyone <span className="count">{items.length}</span></label>
          <label><input type="checkbox" checked={people.has("me")} onChange={() => toggle("me")} /> Photos I took <span className="count">{mine}</span></label>
          <hr />
          {list.map((x) => (
            <label key={x.id}>
              <input type="checkbox" checked={people.has(x.id)} onChange={() => toggle(x.id)} />
              <PersonBadge id={x.id === "unknown" ? null : x.id} name={x.id === "unknown" ? null : x.name} className="sm" /> {x.name} <span className="count">{x.count}</span>
            </label>
          ))}
        </div>
      </details>
      <label className="sort">
        Sort
        <select value={sort} onChange={(e) => onSort(e.target.value as Sort)}>
          {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </div>
  );
}

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
            aria-label={`${selected ? "Select" : "Open"} ${stageLabel(p.stage)} photo from ${new Date(p.capturedAt).toLocaleString()}, taken by ${takenByLabel(p)}${p.flagged ? ", flagged" : ""}`}
          >
            {selected && <span className={`pick ${selected.has(p.id) ? "on" : ""}`} aria-hidden>{selected.has(p.id) ? "✓" : ""}</span>}
            {p.hasPreview ? <AuthImage path={`/v1/orgs/${orgId}/photos/${p.id}/content?variant=thumb`} alt="" className="thumb" /> : <div className="imgph thumb">{p.uploadStatus === "pending" ? "File not uploaded yet" : "No preview"}</div>}
            {p.flagged && <span className="flagmark" aria-hidden>⚑</span>}
            <PersonBadge id={p.photographerId} name={p.photographer} className="onthumb" />
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
          <dt>Taken by</dt>
          <dd className="takenby"><PersonBadge id={p.photographerId} name={p.photographer} className="sm" /> {takenByLabel(p)}{p.takenByMe ? " (you)" : ""}</dd>
          {(p.captureSource !== "in_app_camera" || p.photographer !== p.uploadedBy) && (
            <>
              <dt>Uploaded by</dt>
              <dd>{p.uploadedBy}</dd>
            </>
          )}
          <dt>How</dt>
          <dd>{p.captureSource === "in_app_camera" ? "Taken in the app's camera" : p.captureSource === "imported" ? "Imported from a photo library" : "Uploaded on the website"}</dd>
          {p.storedAt && <><dt>Uploaded</dt><dd>{new Date(p.storedAt).toLocaleString()}</dd></>}
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
