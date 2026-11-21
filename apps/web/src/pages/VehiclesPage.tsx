import { Link } from "react-router-dom";
import type { Vehicle } from "@rsb/contracts";
import { useOrgId, useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";

export function VehiclesPage() {
  const orgId = useOrgId();
  const q = useOrgQuery<{ items: Vehicle[] }>("vehicles", "/vehicles");
  return (
    <>
      <h1>Vehicles</h1>
      <Status query={q}>
        {(d) => (
          <table>
            <thead><tr><th>Unit</th><th>Vehicle</th><th>Plate</th><th className="num">Odometer</th><th>Open issues</th><th>Status</th></tr></thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.id}>
                  <td><Link to={`/orgs/${orgId}/vehicles/${v.id}`}>{v.unitNumber}</Link></td>
                  <td>{v.modelYear ?? ""} {v.make} {v.model}</td><td>{v.licensePlate ?? "—"}</td>
                  <td className="num">{v.currentOdometer?.toLocaleString() ?? "—"}</td><td>{v.openIssues}</td><td>{pretty(v.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Status>
    </>
  );
}
