import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { Notification } from "@rsb/contracts";
import { ALERT_KINDS, alertAge, alertText, type AlertKind } from "@rsb/photo-sync";
import { api } from "../lib/api";
import { useCan, useOrgId } from "../lib/hooks";
import { PersonBadge } from "./photos";
import { Icon } from "./icons";

type List = { items: Notification[]; unreadCount: number };

/** The latest alerts and "mark read", shared by the 🔔 and the Overview page (one query, so both stay in step). */
function useAlerts() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = [orgId, "alerts"];
  // Checked every minute while the page is open (in-app alerts; no push messages yet).
  const q = useQuery({ queryKey: key, queryFn: () => api<List>(`/v1/orgs/${orgId}/notifications?limit=30`) });
  const read = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => api<{ unreadCount: number }>(`/v1/orgs/${orgId}/notifications/read`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const go = (n: Notification) => {
    if (!n.readAt) read.mutate({ ids: [n.id] });
    navigate(`/orgs/${orgId}/jobs/${n.jobId}?photo=${n.photoId}`);
  };
  return { q, read, go, unread: q.data?.unreadCount ?? 0, items: q.data?.items ?? [] };
}

function AlertItems({ items, onOpen }: { items: Notification[]; onOpen: (n: Notification) => void }) {
  return (
    <ul>
      {items.map((n) => (
        <li key={n.id} className={n.readAt ? "" : "unread"}>
          <button onClick={() => onOpen(n)}>
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
  );
}

const EMPTY = "Nothing yet. You'll see mentions, replies and issues here.";

/** The 🔔 in the top bar: unread count, the latest alerts, and a click takes you to the photo. */
export function AlertsBell() {
  const { q, read, go, unread, items } = useAlerts();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="bell" ref={box}>
      <button className="bellbtn" aria-label={unread ? `Alerts, ${unread} new` : "Alerts"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="bell" size={20} />{unread > 0 && <span className="bellcount">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="bellmenu" role="dialog" aria-label="Alerts">
          <div className="bellhead">
            <strong>Alerts</strong>
            {unread > 0 && <button className="link small" onClick={() => read.mutate({ all: true })}>Mark all read</button>}
          </div>
          {q.isError && <p className="error small">Alerts couldn't be loaded.</p>}
          {q.data && !items.length && <p className="muted small">{EMPTY}</p>}
          <AlertItems items={items} onOpen={(n) => { setOpen(false); go(n); }} />
        </div>
      )}
    </div>
  );
}

/** The "Your alerts" section on the Overview page: new alerts first, then the latest read ones. */
export function AlertsSection({ max = 8 }: { max?: number }) {
  const { q, read, go, unread, items } = useAlerts();
  const shown = [...items.filter((n) => !n.readAt), ...items.filter((n) => n.readAt)].slice(0, max);
  return (
    <section aria-label="Your alerts" className="alertsection">
      <div className="bellhead">
        <h2><Icon name="bell" /> Your alerts{unread > 0 ? ` (${unread} new)` : ""}</h2>
        {unread > 0 && <button className="link small" onClick={() => read.mutate({ all: true })}>Mark all read</button>}
      </div>
      {q.isError && <p className="error small">Alerts couldn't be loaded.</p>}
      {q.data && !items.length && <p className="muted small">{EMPTY}</p>}
      <AlertItems items={shown} onOpen={go} />
      {items.length > shown.length && <p className="muted small">Older alerts are under the bell at the top of the page.</p>}
    </section>
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
      <p className="muted small">Shown under the bell at the top of the page and on the phone's Home screen. Only for jobs you can see.</p>
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
