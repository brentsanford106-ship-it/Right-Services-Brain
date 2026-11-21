import { useParams } from "react-router-dom";
import type { Vehicle } from "@rsb/contracts";
import { useOrgQuery } from "../lib/hooks";
import { Status } from "../components/ui";

type Detail = Vehicle & {
  mileage: { id: string; tripDate: string; odometerStart: number; odometerEnd: number; purpose: string | null }[];
  maintenance: { id: string; kind: string; description: string; status: string; createdAt: string }[];
};

export function VehicleDetailPage() {
  const { vehicleId } = useParams();
  const q = useOrgQuery<Detail>("vehicle", `/vehicles/${vehicleId}`);
  return (
    <Status query={q}>
      {(v) => (
        <>
          <h1>{v.unitNumber} · {v.make} {v.model}</h1>
          <h2>Mileage</h2>
          {v.mileage.length === 0 ? <p className="muted">No trips recorded.</p> : (
            <table>
              <thead><tr><th>Date</th><th className="num">Start</th><th className="num">End</th><th className="num">Miles</th><th>Purpose</th></tr></thead>
              <tbody>{v.mileage.map((m) => (
                <tr key={m.id}><td>{m.tripDate}</td><td className="num">{m.odometerStart}</td><td className="num">{m.odometerEnd}</td><td className="num">{m.odometerEnd - m.odometerStart}</td><td>{m.purpose ?? ""}</td></tr>
              ))}</tbody>
            </table>
          )}
          <h2>Maintenance</h2>
          {v.maintenance.length === 0 ? <p className="muted">No maintenance records.</p> : (
            <ul className="list">{v.maintenance.map((m) => (
              <li key={m.id} className="row static"><strong>{m.kind}</strong> {m.description} <span className="muted">({m.status})</span></li>
            ))}</ul>
          )}
        </>
      )}
    </Status>
  );
}
