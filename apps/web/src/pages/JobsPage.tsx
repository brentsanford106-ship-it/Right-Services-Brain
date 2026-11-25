import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Job } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";
import { Icon } from "../components/icons";
import { JobForm, type JobFormValues } from "../components/JobForm";

export function JobsPage() {
  const orgId = useOrgId();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const canManage = useCan("jobs.manage");
  const nav = useNavigate();
  const qc = useQueryClient();
  const term = q.trim();
  const list = useOrgQuery<{ items: Job[] }>("jobs", `/jobs?limit=200${term ? `&q=${encodeURIComponent(term)}` : ""}`);
  const create = useMutation({
    mutationFn: (v: JobFormValues) => api<Job>(`/v1/orgs/${orgId}/jobs`, { method: "POST", body: v }),
    onSuccess: async (j) => {
      await qc.invalidateQueries({ queryKey: [orgId] });
      nav(`/orgs/${orgId}/jobs/${j.id}`);
    },
  });
  const createError = create.error instanceof ApiRequestError ? (create.error.status === 409 ? "That job number is already used." : create.error.message) : create.error ? "Couldn't create the job." : null;

  return (
    <>
      <div className="headrow">
        <h1>Jobs</h1>
        {canManage && !creating && <button className="primary" onClick={() => setCreating(true)}><Icon name="plus" /> New job</button>}
      </div>
      {creating && (
        <div className="card">
          <h2>New job</h2>
          <JobForm submitLabel="Create job" busy={create.isPending} error={createError} onSubmit={(v) => create.mutate(v)} onCancel={() => setCreating(false)} />
        </div>
      )}
      <div className="searchbox"><Icon name="search" /><input className="search" type="search" placeholder="Search by job number, job name, or site" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" /></div>
      <Status query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="muted">{term ? "No jobs match that search." : "No jobs to show."}</p>
          ) : (
            <table>
              <thead>
                <tr><th>Job #</th><th>Name</th><th>Site</th><th>Status</th></tr>
              </thead>
              <tbody>
                {d.items.map((j) => (
                  <tr key={j.id}>
                    <td><Link className="jobnum" to={`/orgs/${orgId}/jobs/${j.id}`}>{j.jobNumber}</Link></td>
                    <td><strong>{j.title}</strong></td>
                    <td className="muted">{j.siteName ?? "—"}</td>
                    <td><span className={`pill status ${j.status}`}>{pretty(j.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Status>
    </>
  );
}
