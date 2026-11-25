import { useEffect, useState } from "react";
import { Icon } from "../components/icons";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeletedPhoto, Job, Photo, PhotoIssue } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";
import { JobForm, type JobFormValues } from "../components/JobForm";
import { IssueList } from "../components/issues";
import { applyFilter, applyPeople, downloadPhotos, FilterBar, Lightbox, PeopleAndSort, PhotoGrid, sortPhotos, SORTS, type Filter, type PeopleFilter, type Sort } from "../components/photos";

export function JobDetailPage() {
  const { jobId = "" } = useParams();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const job = useOrgQuery<Job>("job", `/jobs/${jobId}`);
  const photos = useOrgQuery<{ items: Photo[] }>("jobPhotos", `/jobs/${jobId}/photos`);
  const canManage = useCan("jobs.manage");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [people, setPeople] = useState<PeopleFilter>(new Set());
  const [sort, setSort] = useState<Sort>("oldest");
  const [open, setOpen] = useState<number | null>(null);
  // Select mode, like the iPhone Photos app.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const canExport = useCan("photos.export");
  const canDeleteAny = useCan("photos.delete_any");
  const canPurge = useCan("photos.purge");
  const deleted = useOrgQuery<{ items: DeletedPhoto[] }>("jobPhotosDeleted", `/jobs/${jobId}/photos/deleted`, canDeleteAny);
  const issues = useOrgQuery<{ items: PhotoIssue[] }>("jobIssues", `/jobs/${jobId}/issues`);
  const refresh = () => qc.invalidateQueries({ queryKey: [orgId] });
  // Open one photo (from an issue, or a link like ?photo=<id>), clearing filters so it is in the list.
  const openPhoto = (photoId: string): boolean => {
    const all = sortPhotos(photos.data?.items ?? [], sort);
    const k = all.findIndex((p) => p.id === photoId);
    if (k < 0) return false;
    setFilter("all");
    setPeople(new Set());
    setSelected(null);
    setOpen(k);
    return true;
  };
  const [search, setSearch] = useSearchParams();
  const wanted = search.get("photo");
  useEffect(() => {
    if (wanted && photos.data && openPhoto(wanted)) setSearch({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, photos.data]);
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
  const purge = useMutation({
    mutationFn: (ids: string[]) => api(`/v1/orgs/${orgId}/photos/purge`, { method: "POST", body: { photoIds: ids } }),
    onSuccess: refresh,
  });
  const confirmPurge = (ids: string[]) => {
    const what = ids.length === 1 ? "this photo" : `these ${ids.length} photos`;
    const typed = window.prompt(`Delete ${what} forever?\n\nThe picture will be erased and can NOT be restored by anyone. The activity log keeps a note that it existed.\n\nType DELETE to confirm.`);
    if (typed?.trim().toUpperCase() === "DELETE") purge.mutate(ids);
  };
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
          <div className="jobhead">
            <div className="headrow">
              <h1>{j.jobNumber} · {j.title}</h1>
              {canManage && !editing && <button onClick={() => setEditing(true)}><Icon name="edit" /> Edit job</button>}
            </div>
            {!editing && (
              <dl className="facts">
                <dt>Status</dt><dd><span className={`pill status ${j.status}`}>{pretty(j.status)}</span></dd>
                <dt>Site</dt><dd>{j.siteName ?? "—"}</dd>
                <dt>Address</dt><dd>{j.siteAddress ?? "—"}</dd>
              </dl>
            )}
          </div>
          {editing && (
            <div className="card">
              <JobForm editing initial={{ ...j }} submitLabel="Save" busy={save.isPending} error={save.error instanceof ApiRequestError ? save.error.message : save.error ? "Couldn't save." : null} onSubmit={(v) => save.mutate(v)} onCancel={() => setEditing(false)} />
            </div>
          )}
          {(issues.data?.items?.length ?? 0) > 0 && (
            <section aria-label="Issues on this job">
              <h2>Issues to fix ({issues.data!.items.filter((i) => i.status !== "resolved").length} active)</h2>
              <IssueList items={issues.data!.items} empty="" onChanged={refresh} onOpenPhoto={(pid) => { if (!openPhoto(pid)) window.alert("That photo isn't in the gallery (it may have been deleted)."); }} />
            </section>
          )}
          <h2>Photos</h2>
          <Status query={photos}>
            {(d) => {
              const byPeople = applyPeople(d.items, people);
              const shown = sortPhotos(applyFilter(byPeople, filter), sort);
              const pending = d.items.filter((p) => p.uploadStatus === "pending").length;
              return (
                <>
                  <p className="muted small">
                    {d.items.length} photo{d.items.length === 1 ? "" : "s"}, {SORTS.find((o) => o.value === sort)!.label.toLowerCase()}
                    {pending ? ` · ${pending} still uploading from a phone` : ""}
                  </p>
                  <PeopleAndSort items={d.items} people={people} onPeople={(x) => { setPeople(x); setOpen(null); }} sort={sort} onSort={(x) => { setSort(x); setOpen(null); }} />
                  <div className="headrow">
                    <FilterBar value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} items={byPeople} />
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
                      {canPurge && deleted.data.items.length > 1 && (
                        <div className="actions">
                          <button className="danger" disabled={purge.isPending} onClick={() => confirmPurge(deleted.data!.items.map((p) => p.id))}>Delete all forever</button>
                        </div>
                      )}
                      {purge.error && <p className="error" role="alert">{purge.error instanceof ApiRequestError ? purge.error.message : "Couldn't delete."}</p>}
                      <ul className="list">
                        {deleted.data.items.map((p) => (
                          <li key={p.id} className="row static">
                            <strong>{p.stage}</strong> · taken {new Date(p.capturedAt).toLocaleString()} by {p.uploadedBy}
                            <div className="muted small">Deleted {new Date(p.deletedAt).toLocaleString()} by {p.deletedBy}{p.note ? ` · “${p.note}”` : ""}</div>
                            <div className="muted small">Removed for good on {new Date(p.purgeAfter).toLocaleDateString()}</div>
                            <div className="actions">
                              <button disabled={restore.isPending} onClick={() => restore.mutate(p.id)}>Restore</button>
                              {canPurge && <button className="danger" disabled={purge.isPending} onClick={() => confirmPurge([p.id])}>Delete forever</button>}
                            </div>
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
