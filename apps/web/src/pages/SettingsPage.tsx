import { useOrgContext } from "../lib/hooks";
import { session } from "../lib/api";
import { useState } from "react";
import { Status } from "../components/ui";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";

export function SettingsPage() {
  const ctx = useOrgContext();
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  return (
    <>
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <div className="filters" role="radiogroup" aria-label="Appearance">
        {([["system", "Match this computer"], ["light", "Light"], ["dark", "Dark"]] as [ThemePref, string][]).map(([v, label]) => (
          <button
            key={v}
            role="radio"
            aria-checked={theme === v}
            className={`chip ${theme === v ? "on" : ""}`}
            onClick={() => {
              setTheme(v);
              setThemePref(v);
            }}
          >
            {label}
          </button>
        ))}
      </div>
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
