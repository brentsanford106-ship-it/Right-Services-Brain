import { useOrgContext } from "../lib/hooks";
import { session } from "../lib/api";
import { Status } from "../components/ui";

export function SettingsPage() {
  const ctx = useOrgContext();
  return (
    <>
      <h1>Settings</h1>
      <Status query={ctx}>
        {(c) => (
          <>
            <dl className="facts">
              <dt>Company</dt><dd>{c.organization.name}</dd>
              <dt>Your role</dt><dd>{c.roles.join(", ")}</dd>
            </dl>
            <h2>Your permissions</h2>
            <p className="muted small">Enforced by the server. Shown here for transparency.</p>
            <ul className="chips">{c.permissions.map((p) => <li key={p}>{p}</li>)}</ul>
          </>
        )}
      </Status>
      <button onClick={() => session.set(null)}>Sign out</button>
    </>
  );
}
