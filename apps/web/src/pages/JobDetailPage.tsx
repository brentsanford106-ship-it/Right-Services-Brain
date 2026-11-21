import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeletedPhoto, Job, Photo } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";
import { JobForm, type JobFormValues } from "../components/JobForm";
import { applyFilter, downloadPhotos, FilterBar, Lightbox, PhotoGrid, type Filter } from "../components/photos";

export function JobDetailPage() {
  const { jobId = "" } = useParams();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const job = useOrgQuery<Job>("job", `/jobs/${jobId}`);
  const photos = useOrgQuery<{ items: Photo[] }>("jobPhotos", `/jobs/${jobId}/photos`);
  const canManage = useCan("jobs.manage");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  // Select mode, like the iPhone Photos app.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const canExport = useCan("photos.export");
  const canDeleteAny = useCan("photos.delete_any");
  const deleted = useOrgQuery<{ items: DeletedPhoto[] }>("jobPhotosDeleted", `/jobs/${jobId}/photos/deleted`, canDeleteAny);
  const refresh = () => qc.invalidateQueries({ queryKey: [orgId] });
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const restore = useMutation({
    mutationFn: (id: string) => api<Photo>(`/v1/orgs/${orgId}/photos/${id}/restore`, { method: "POST" }),
    onSuccess: refresh,
  });
  const save = useMutation({
    mutationFn: (v: JobFormValues) => api<Job>(`/v1/orgs/${orgId}/jobs/${jobId}`, { method: "PATCH", body: v }),
    onSuccess: async () => {
      setEditing(false);
      await qc.invalidateQueries({ queryKey: [orgId] });
    },
  });

  return (
    <Status query={job}>
      {(j) => (
        <>
          <div className="headrow">
            <h1>{j.jobNumber} · {j.title}</h1>
            {canManage && !editing && <button onClick={() => setEditing(true)}>Edit job</button>}
          </div>
          {editing ? (
            <div className="card">
              <JobForm editing initial={{ ...j }} submitLabel="Save" busy={save.isPending} error={save.error instanceof ApiRequestError ? save.error.message : save.error ? "Couldn't save." : null} onSubmit={(v) => save.mutate(v)} onCancel={() => setEditing(false)} />
            </div>
          ) : (
            <dl className="facts">
              <dt>Status</dt><dd>{pretty(j.status)}</dd>
              <dt>Site</dt><dd>{j.siteName ?? "—"}</dd>
              <dt>Address</dt><dd>{j.siteAddress ?? "—"}</dd>
            </dl>
          )}
          <h2>Photos</h2>
          <Status query={photos}>
            {(d) => {
              const shown = applyFilter(d.items, filter);
              const pending = d.items.filter((p) => p.uploadStatus === "pending").length;
              return (
                <>
                  <p className="muted small">
                    {d.items.length} photo{d.items.length === 1 ? "" : "s"}, oldest first
                    {pending ? ` · ${pending} still uploading from a phone` : ""}
                  </p>
                  <div className="headrow">
                    <FilterBar value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} items={d.items} />
                    {d.items.length > 0 && (
                      <button onClick={() => { setSelected(selected ? null : new Set()); setActionError(null); }}>{selected ? "Cancel" : "Select"}</button>
                    )}
                  </div>
                  {selected && (() => {
                    const chosen = d.items.filter((p) => selected.has(p.id));
                    const deletable = chosen.filter((p) => p.canDelete);
                    return (
                      <div className="selectbar" role="toolbar" aria-label="Selected photos">
                        <button className="link" onClick={() => setSelected(new Set(shown.every((p) => selected.has(p.id)) ? [] : shown.map((p) => p.id)))}>
                          {shown.length > 0 && shown.every((p) => selected.has(p.id)) ? "Deselect all" : "Select all"}
                        </button>
                        <strong>{chosen.length ? `${chosen.length} photo${chosen.length > 1 ? "s" : ""} selected` : "Click photos to select them"}</strong>
                        <span className="spacer" />
                        {canExport && (
                          <button
                            disabled={!chosen.length || working}
                            onClick={async () => {
                              setWorking(true);
                              setActionError(null);
                              try {
                                await downloadPhotos(orgId, chosen);
                              } catch (e) {
                                setActionError(e instanceof Error ? e.message : "Couldn't download.");
                              } finally {
                                setWorking(false);
                              }
                            }}
                          >
                            Download
                          </button>
                        )}
                        <button
                          className="danger"
                          disabled={!deletable.length || working}
                          onClick={async () => {
                            const kept = chosen.length - deletable.length;
                            const msg = `Delete ${deletable.length} photo${deletable.length > 1 ? "s" : ""}? An owner or manager can restore them from Recently deleted.${kept ? `\n\n${kept} selected photo${kept > 1 ? "s were" : " was"} taken by someone else and will be kept.` : ""}`;
                            if (!window.confirm(msg)) return;
                            setWorking(true);
                            setActionError(null);
                            let failed = 0;
                            for (const p of deletable) {
                              try {
                                await api(`/v1/orgs/${orgId}/photos/${p.id}`, { method: "DELETE" });
                              } catch (e) {
                                if (!(e instanceof ApiRequestError && e.status === 404)) failed++;
                              }
                            }
                            setWorking(false);
                            setSelected(null);
                            if (failed) setActionError(`${failed} photo${failed > 1 ? "s" : ""} couldn't be deleted.`);
                            await refresh();
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    );
                  })()}
                  {actionError && <p className="error" role="alert">{actionError}</p>}
                  <PhotoGrid items={shown} onOpen={setOpen} selected={selected ?? undefined} onToggle={toggle} />
                  {open !== null && !selected && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} invalidate={[[orgId]]} />}
                  {canDeleteAny && deleted.data && deleted.data.items.length > 0 && (
                    <details className="deleted">
                      <summary>Recently deleted ({deleted.data.items.length})</summary>
                      <ul className="list">
                        {deleted.data.items.map((p) => (
                          <li key={p.id} className="row static">
                            <strong>{p.stage}</strong> · taken {new Date(p.capturedAt).toLocaleString()} by {p.uploadedBy}
                            <div className="muted small">Deleted {new Date(p.deletedAt).toLocaleString()} by {p.deletedBy}{p.note ? ` · “${p.note}”` : ""}</div>
                            <button disabled={restore.isPending} onClick={() => restore.mutate(p.id)}>Restore</button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              );
            }}
          </Status>
        </>
      )}
    </Status>
  );
}
