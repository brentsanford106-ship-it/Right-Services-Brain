import { useOrgContext, useOrgId, useOrgQuery } from "../lib/hooks";
import { api, ApiRequestError, session } from "../lib/api";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RETENTION_DAY_OPTIONS, SIGN_IN_DAY_OPTIONS, type OrgSettings } from "@rsb/contracts";
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
      <SignInAgainSetting />
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

/** How often people must sign in again with Microsoft. Owners can change it. */
export function SignInAgainSetting() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const settings = useOrgQuery<OrgSettings>("settings", "/settings");
  const save = useMutation({
    mutationFn: (days: number) => api<OrgSettings>(`/v1/orgs/${orgId}/settings`, { method: "PATCH", body: { signInEveryDays: days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [orgId] }),
  });
  const label = (d: number) => (d === 1 ? "every day" : `every ${d} days`);
  return (
    <>
      <h2>Sign in again</h2>
      <Status query={settings}>
        {(s) => (
          <>
            <p className="muted small">
              How often everyone has to sign in again on their phone. It's only checked when the phone has signal, so taking photos without service is never
              interrupted and photos not yet sent are always kept. On this website, closing the page always means signing in again, and a website sign-in never
              lasts more than a day.
            </p>
            {s.canEdit ? (
              <label>
                Sign in again{" "}
                <select value={s.signInEveryDays} disabled={save.isPending} onChange={(e) => save.mutate(Number(e.target.value))}>
                  {SIGN_IN_DAY_OPTIONS.map((d) => <option key={d} value={d}>{label(d)}</option>)}
                </select>
              </label>
            ) : (
              <p>Everyone signs in again <strong>{label(s.signInEveryDays)}</strong>. Only an owner can change this.</p>
            )}
            {save.isSuccess && <p className="muted small" role="status">Saved.</p>}
            {save.error && <p className="error" role="alert">{save.error instanceof ApiRequestError ? save.error.message : "Couldn't save."}</p>}
          </>
        )}
      </Status>
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
