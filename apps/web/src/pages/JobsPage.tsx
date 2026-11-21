import { Link } from "react-router-dom";
import type { Job } from "@rsb/contracts";
import { useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";

export function JobsPage() {
  const orgId = useOrgId();
  const q = useOrgQuery<{ items: Job[] }>("jobs", "/jobs");
  return (
    <>
      <h1>Jobs</h1>
      <Status query={q}>
        {(d) => d.items.length === 0 ? <p className="muted">No jobs to show.</p> : (
          <table>
            <thead><tr><th>Job #</th><th>Title</th><th>Site</th><th>Status</th></tr></thead>
            <tbody>
              {d.items.map((j) => (
                <tr key={j.id}>
                  <td><Link to={`/orgs/${orgId}/jobs/${j.id}`}>{j.jobNumber}</Link></td>
                  <td>{j.title}</td>
                  <td>{j.siteName ?? "—"}</td>
                  <td><span className={`pill ${j.status}`}>{pretty(j.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Status>
    </>
  );
}
