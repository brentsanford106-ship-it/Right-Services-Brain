import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { Notification } from "@rsb/contracts";
import { ALERT_KINDS, alertAge, alertText, type AlertKind } from "@rsb/photo-sync";
import { api } from "../lib/api";
import { useCan, useOrgId } from "../lib/hooks";
import { PersonBadge } from "./photos";

type List = { items: Notification[]; unreadCount: number };

/** The 🔔 in the top bar: unread count, the latest alerts, and a click takes you to the photo. */
export function AlertsBell() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const key = [orgId, "alerts"];
  // Checked every minute while the page is open (in-app alerts; no push messages yet).
  const q = useQuery({ queryKey: key, queryFn: () => api<List>(`/v1/orgs/${orgId}/notifications?limit=30`), refetchInterval: 60_000 });
  const read = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => api<{ unreadCount: number }>(`/v1/orgs/${orgId}/notifications/read`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];
  const go = (n: Notification) => {
    if (!n.readAt) read.mutate({ ids: [n.id] });
    setOpen(false);
    navigate(`/orgs/${orgId}/jobs/${n.jobId}?photo=${n.photoId}`);
  };
  return (
    <div className="bell" ref={box}>
      <button className="bellbtn" aria-label={unread ? `Alerts, ${unread} new` : "Alerts"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        🔔{unread > 0 && <span className="bellcount">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="bellmenu" role="dialog" aria-label="Alerts">
          <div className="bellhead">
            <strong>Alerts</strong>
            {unread > 0 && <button className="link small" onClick={() => read.mutate({ all: true })}>Mark all read</button>}
          </div>
          {q.isError && <p className="error small">Alerts couldn't be loaded.</p>}
          {q.data && !items.length && <p className="muted small">Nothing yet. You'll see mentions, replies and issues here.</p>}
          <ul>
            {items.map((n) => (
              <li key={n.id} className={n.readAt ? "" : "unread"}>
                <button onClick={() => go(n)}>
                  <PersonBadge id={n.actorId} name={n.actor} avatarAt={n.actorAvatarAt} className="sm" />
                  <span className="btext">
                    <span>{alertText(n)}</span>
                    {n.snippet && <span className="muted small">“{n.snippet}”</span>}
                  </span>
                  <span className="muted small">{alertAge(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Which alerts this person gets (their own choice, per company). */
export function AlertSettings() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const manager = useCan("photo_issues.manage");
  const key = [orgId, "alert-settings"];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ muted: AlertKind[] }>(`/v1/orgs/${orgId}/notification-settings`) });
  const save = useMutation({
    mutationFn: (muted: AlertKind[]) => api<{ muted: AlertKind[] }>(`/v1/orgs/${orgId}/notification-settings`, { method: "PATCH", body: { muted } }),
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  const muted = q.data?.muted ?? [];
  return (
    <section aria-label="Alerts">
      <h2>Alerts</h2>
      <p className="muted small">Shown under 🔔 at the top of the page and on the phone's Home screen. Only for jobs you can see.</p>
      {q.isError && <p className="error small">Couldn't load your alert settings.</p>}
      {q.data && (
        <ul className="alertsettings">
          {ALERT_KINDS.filter((k) => manager || !k.managers).map((k) => (
            <li key={k.kind}>
              <label>
                <input type="checkbox" checked={!muted.includes(k.kind)} disabled={save.isPending}
                  onChange={(e) => save.mutate(e.target.checked ? muted.filter((m) => m !== k.kind) : [...muted, k.kind])} />
                {k.label}
              </label>
            </li>
          ))}
        </ul>
      )}
      {save.isError && <p className="error small" role="alert">Couldn't save. Try again.</p>}
    </section>
  );
}
