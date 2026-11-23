import { AlertSettings } from "../components/alerts";
import { useOrgContext, useOrgId, useOrgQuery } from "../lib/hooks";
import { api, ApiRequestError, putImage, session } from "../lib/api";
import { PersonBadge } from "../components/photos";
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
      <ProfilePictureSetting />
      <AlertSettings />
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

/** Your profile picture, shown on your photos instead of your initials. Everyone in the company can see it. */
function ProfilePictureSetting() {
  const ctx = useOrgContext();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const done = async () => {
    setErr(null);
    await qc.invalidateQueries({ queryKey: ["org", orgId] });
    await qc.invalidateQueries({ queryKey: [orgId] });
  };
  const upload = useMutation({
    mutationFn: (f: File) => putImage(`/v1/orgs/${orgId}/me/avatar`, f, f.type),
    onSuccess: done,
    onError: (e) => setErr(e instanceof ApiRequestError && e.status === 400 ? "That file isn't a JPEG or PNG picture." : "Couldn't save your picture. Try again."),
  });
  const remove = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/me/avatar`, { method: "DELETE" }),
    onSuccess: done,
    onError: () => setErr("Couldn't remove your picture. Try again."),
  });
  const c = ctx.data;
  if (!c) return null;
  return (
    <>
      <h2>Your profile picture</h2>
      <p className="muted small">Shown on the photos you take, instead of your initials. Everyone in {c.organization.name} can see it.</p>
      <div className="avatarrow">
        <PersonBadge id={c.membershipId} name={c.displayName ?? null} avatarAt={c.avatarAt} className="lg" />
        <label className="button">
          {c.avatarAt ? "Change picture" : "Add a picture"}
          <input
            type="file"
            accept="image/jpeg,image/png"
            hidden
            disabled={upload.isPending}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.type !== "image/jpeg" && f.type !== "image/png") return setErr("Choose a JPEG or PNG picture.");
              if (f.size > 10 * 1024 * 1024) return setErr("That picture is too big (10 MB at most).");
              upload.mutate(f);
            }}
          />
        </label>
        {c.avatarAt && <button disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>}
      </div>
      {upload.isPending && <p className="muted small">Saving…</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </>
  );
}
