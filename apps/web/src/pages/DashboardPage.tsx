import { useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardResponse, Photo } from "@rsb/contracts";
import { useOrgId, useOrgQuery } from "../lib/hooks";
import { Card, Status } from "../components/ui";
import { Lightbox, PhotoGrid } from "../components/photos";

export function DashboardPage() {
  const orgId = useOrgId();
  const d = useOrgQuery<DashboardResponse>("dashboard", "/dashboard");
  const flagged = useOrgQuery<{ items: Photo[] }>("photos", "/photos?flagged=true&limit=24");
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <h1>Overview</h1>
      <Status query={d}>
        {(x) => (
          <div className="cards">
            <Card title="Active jobs" value={<Link to={`/orgs/${orgId}/jobs`}>{x.activeJobs}</Link>} />
            <Card title="Photos in the last 7 days" value={x.photosLast7Days} />
            <Card title="Flagged photos" value={x.flaggedPhotos} />
            <Card title="Waiting for file from a phone" value={x.photosAwaitingUpload} />
          </div>
        )}
      </Status>
      <h2>Flagged photos</h2>
      <Status query={flagged}>
        {(x) => (
          <>
            <PhotoGrid items={x.items} onOpen={setOpen} showJob />
            {open !== null && <Lightbox items={x.items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} invalidate={[[orgId]]} />}
          </>
        )}
      </Status>
    </>
  );
}
