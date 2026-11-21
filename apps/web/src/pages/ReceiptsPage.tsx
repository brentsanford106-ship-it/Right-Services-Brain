import { formatCents, type Receipt } from "@rsb/contracts";
import { useOrgQuery } from "../lib/hooks";
import { pretty, Status } from "../components/ui";

export function ReceiptsPage() {
  const q = useOrgQuery<{ items: Receipt[]; scope: "own" | "all" }>("receipts", "/receipts");
  return (
    <>
      <h1>Receipts</h1>
      <Status query={q}>
        {(d) => (
          <>
            <p className="muted">{d.scope === "all" ? "All company receipts" : "Receipts you submitted"}</p>
            <table>
              <thead><tr><th>Date</th><th>Vendor</th><th>Job</th><th>Category</th><th className="num">Amount</th><th>By</th><th>Status</th></tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.purchasedOn}</td><td>{r.vendor}</td><td>{r.jobNumber ?? "—"}</td><td>{pretty(r.category)}</td>
                    <td className="num">{formatCents(r.amountCents, r.currency)}</td><td>{r.submittedBy}</td><td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Status>
    </>
  );
}
