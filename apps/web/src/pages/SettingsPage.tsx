import { useOrgContext, useOrgId, useOrgQuery } from "../lib/hooks";
import { api, ApiRequestError, session } from "../lib/api";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RETENTION_DAY_OPTIONS, type OrgSettings } from "@rsb/contracts";
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
      <RecentlyDeletedSetting />
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

/** How long Recently Deleted keeps photos before they are removed for good. Owners can change it. */
function RecentlyDeletedSetting() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const settings = useOrgQuery<OrgSettings>("settings", "/settings");
  const save = useMutation({
    mutationFn: (days: number) => api<OrgSettings>(`/v1/orgs/${orgId}/settings`, { method: "PATCH", body: { deletedPhotoRetentionDays: days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [orgId] }),
  });
  return (
    <>
      <h2>Recently Deleted</h2>
      <Status query={settings}>
        {(s) => (
          <>
            <p className="muted small">
              Deleted photos stay in Recently Deleted so they can be restored. After this many days they are removed for good, automatically.
            </p>
            {s.canEdit ? (
              <label>
                Keep deleted photos for{" "}
                <select value={s.deletedPhotoRetentionDays} disabled={save.isPending} onChange={(e) => save.mutate(Number(e.target.value))}>
                  {RETENTION_DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </label>
            ) : (
              <p>Deleted photos are kept for <strong>{s.deletedPhotoRetentionDays} days</strong>. Only an owner can change this.</p>
            )}
            {save.isSuccess && <p className="muted small" role="status">Saved.</p>}
            {save.error && <p className="error" role="alert">{save.error instanceof ApiRequestError ? save.error.message : "Couldn't save."}</p>}
          </>
        )}
      </Status>
    </>
  );
}
