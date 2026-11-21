import type { DashboardResponse } from "@rsb/contracts";
import { formatCents } from "@rsb/contracts";
import { useOrgQuery } from "../lib/hooks";
import { Card, Status } from "../components/ui";

export function DashboardPage() {
  const q = useOrgQuery<DashboardResponse>("dashboard", "/dashboard");
  return (
    <>
      <h1>Dashboard</h1>
      <Status query={q}>
        {(d) => (
          <div className="cards">
            <Card title="Active jobs" value={d.activeJobs} />
            {d.openPhotoFlags !== null && <Card title="Open photo flags" value={d.openPhotoFlags} />}
            {d.openMaintenanceIssues !== null && <Card title="Open vehicle issues" value={d.openMaintenanceIssues} />}
            {d.receiptsTotalCents !== null && <Card title="Receipts total" value={formatCents(d.receiptsTotalCents)} />}
          </div>
        )}
      </Status>
    </>
  );
}
