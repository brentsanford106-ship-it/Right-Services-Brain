import type { Member } from "@rsb/contracts";
import { useOrgQuery } from "../lib/hooks";
import { Status } from "../components/ui";

export function EmployeesPage() {
  const q = useOrgQuery<{ items: Member[] }>("members", "/members");
  return (
    <>
      <h1>Employees</h1>
      <Status query={q}>
        {(d) => (
          <table>
            <thead><tr><th>Name</th><th>Title</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>{d.items.map((m) => (
              <tr key={m.membershipId}><td>{m.displayName}</td><td>{m.jobTitle ?? "—"}</td><td>{m.roles.join(", ")}</td><td>{m.status}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Status>
      <p className="muted small">Inviting, removing and changing roles arrives in Phase 2.</p>
    </>
  );
}
