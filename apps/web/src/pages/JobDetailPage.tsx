import { useParams } from "react-router-dom";
import type { Job, Photo } from "@rsb/contracts";
import { useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";

type JobDetail = Job & { assignees: { membershipId: string; displayName: string }[] | null };

export function JobDetailPage() {
  const { jobId } = useParams();
  const job = useOrgQuery<JobDetail>("job", `/jobs/${jobId}`);
  const photos = useOrgQuery<{ items: Photo[] }>("photos", `/jobs/${jobId}/photos`);
  return (
    <Status query={job}>
      {(j) => (
        <>
          <h1>{j.jobNumber} · {j.title}</h1>
          <dl className="facts">
            <dt>Status</dt><dd>{pretty(j.status)}</dd>
            <dt>Site</dt><dd>{j.siteName ?? "—"}{j.siteAddress ? `, ${j.siteAddress}` : ""}</dd>
            {j.customerName && (<><dt>Customer</dt><dd>{j.customerName}</dd></>)}
            {j.assignees && (<><dt>Assigned</dt><dd>{j.assignees.map((a) => a.displayName).join(", ") || "Nobody"}</dd></>)}
          </dl>
          <h2>Photos</h2>
          <Status query={photos}>
            {(p) => p.items.length === 0 ? <p className="muted">No photos yet.</p> : (
              <div className="photos">
                {p.items.map((ph) => (
                  <figure key={ph.id} className="photo">
                    <div className="placeholder" aria-hidden>📷</div>
                    <figcaption>
                      <span className={`pill ${ph.stage}`}>{ph.stage}</span> {ph.caption ?? ""}
                      {ph.openFlags > 0 && <span className="pill flag"> ⚑ {ph.openFlags} flag</span>}
                      <div className="muted">{ph.uploadedBy} · {new Date(ph.capturedAt).toLocaleString()}</div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </Status>
          <p className="muted small">Photo files are not stored in Phase 1 (metadata only). Secure upload arrives in Phase 2.</p>
        </>
      )}
    </Status>
  );
}
