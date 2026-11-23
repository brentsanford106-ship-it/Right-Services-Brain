import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DashboardResponse, Photo, PhotoIssue } from "@rsb/contracts";
import { useCan, useOrgId, useOrgQuery } from "../lib/hooks";
import { IssueList } from "../components/issues";
import { Card, Status } from "../components/ui";
import { Lightbox, PhotoGrid } from "../components/photos";

export function DashboardPage() {
  const orgId = useOrgId();
  const d = useOrgQuery<DashboardResponse>("dashboard", "/dashboard");
  const flagged = useOrgQuery<{ items: Photo[] }>("photos", "/photos?flagged=true&limit=24");
  const [open, setOpen] = useState<number | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canReview = useCan("photo_issues.manage");
  const mine = useOrgQuery<{ items: PhotoIssue[] }>("myIssues", "/photo-issues?assigned=me&status=active");
  const review = useOrgQuery<{ items: PhotoIssue[] }>("reviewIssues", "/photo-issues?status=awaiting_review", canReview);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: [orgId] }); };
  const openPhoto = (photoId: string, jobId: string) => navigate(`/orgs/${orgId}/jobs/${jobId}?photo=${photoId}`);
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
      {(mine.data?.items?.length ?? 0) > 0 && (
        <section aria-label="Assigned to me">
          <h2>🔧 Assigned to me ({mine.data!.items.length})</h2>
          <IssueList items={mine.data!.items} groups={false} empty="" onChanged={refresh} onOpenPhoto={openPhoto} />
        </section>
      )}
      {canReview && (review.data?.items?.length ?? 0) > 0 && (
        <section aria-label="Fixes waiting for review">
          <h2>Fixes waiting for review ({review.data!.items.length})</h2>
          <IssueList items={review.data!.items} groups={false} empty="" onChanged={refresh} onOpenPhoto={openPhoto} />
        </section>
      )}
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
