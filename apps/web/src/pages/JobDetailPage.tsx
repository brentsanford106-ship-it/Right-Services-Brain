import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Job, Photo } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";
import { JobForm, type JobFormValues } from "../components/JobForm";
import { applyFilter, FilterBar, Lightbox, PhotoGrid, type Filter } from "../components/photos";

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
                  <FilterBar value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} items={d.items} />
                  <PhotoGrid items={shown} onOpen={setOpen} />
                  {open !== null && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} invalidate={[[orgId]]} />}
                </>
              );
            }}
          </Status>
        </>
      )}
    </Status>
  );
}
