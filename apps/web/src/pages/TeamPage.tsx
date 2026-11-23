import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PermissionInfo, TeamInvite, TeamMember, TeamRole } from "@rsb/contracts";
import { api, ApiRequestError } from "../lib/api";
import { useCan, useOrgContext, useOrgId, useOrgQuery } from "../lib/hooks";
import { Status } from "../components/ui";

const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : e ? "Something went wrong. Please try again." : null);

/** Mirrors the server rule: a broader permission covers its narrower twin. The SERVER decides; this only greys out boxes. */
const COVERED_BY: Record<string, string> = {
  "jobs.read_assigned": "jobs.read_all",
  "vehicles.read_assigned": "vehicles.read_all",
  "receipts.read_own": "receipts.read_all",
};

/**
 * Team & Roles. Owners (or anyone given "Create and edit roles") choose what each role may do and who has which roles.
 * Every rule is enforced by the server; this page only shows and hides controls.
 */
export function TeamPage() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const ctx = useOrgContext();
  const canManage = useCan("roles.manage");
  const canPeople = useCan("members.manage");
  const invites = useOrgQuery<{ items: TeamInvite[] }>("team-invites", "/team/invites", canPeople || canManage);
  const [adding, setAdding] = useState(false);
  const members = useOrgQuery<{ items: TeamMember[] }>("team-members", "/team/members");
  const roles = useOrgQuery<{ items: TeamRole[] }>("team-roles", "/team/roles");
  const perms = useOrgQuery<{ items: PermissionInfo[] }>("team-perms", "/team/permissions");
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<string | "new" | null>(null);
  const mine = useMemo(() => new Set(ctx.data?.permissions ?? []), [ctx.data]);
  const holds = (p: string) => mine.has(p) || (COVERED_BY[p] !== undefined && mine.has(COVERED_BY[p]!));
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: [orgId] });
    await qc.invalidateQueries({ queryKey: ["org", orgId] });
  };

  return (
    <>
      <h1>Team &amp; roles</h1>
      <p className="muted">
        A <strong>role</strong> is a set of things a person is allowed to do. Give each person one or more roles.
        {canManage ? " You can only give out permissions that you have yourself." : " Only owners can change roles."}
      </p>
      <div className="headrow">
        <h2>People</h2>
        {canPeople && !adding && <button onClick={() => setAdding(true)}>+ Add person</button>}
      </div>
      {adding && (
        <Status query={roles}>
          {(r) => <AddPerson roles={r.items} holds={holds} onDone={async (changed) => { setAdding(false); if (changed) await refresh(); }} />}
        </Status>
      )}
      <Status query={members}>
        {(m) => (
          <Status query={roles}>
            {(r) => (
              <ul className="list">
                {m.items.filter((p) => p.status !== "removed").map((p) => (
                  <li key={p.membershipId} className="row static">
                    <div className="headrow">
                      <div>
                        <strong>{p.displayName}</strong>
                        {p.isYou && <span className="badge">You</span>}
                        {p.status !== "active" && <span className="badge warn">{p.status}</span>}
                        <div className="muted small">{p.jobTitle ?? ""}</div>
                      </div>
                      <div className="actions">
                        {canManage && editingMember !== p.membershipId && (
                          <button onClick={() => setEditingMember(p.membershipId)}>Change roles</button>
                        )}
                        {canPeople && !p.isYou && editingMember !== p.membershipId && <AccessButtons member={p} roles={r.items} holds={holds} onChanged={refresh} />}
                      </div>
                    </div>
                    {editingMember === p.membershipId ? (
                      <MemberRolesEditor
                        member={p}
                        roles={r.items}
                        holds={holds}
                        onDone={async (changed) => {
                          setEditingMember(null);
                          if (changed) await refresh();
                        }}
                      />
                    ) : (
                      <ul className="chips">{p.roles.map((x) => <li key={x.id}>{x.name}</li>)}</ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Status>
        )}
      </Status>

      {(canPeople || canManage) && invites.data && invites.data.items.length > 0 && (
        <>
          <h3>Added, waiting for them to accept</h3>
          <ul className="list">
            {invites.data.items.map((i) => (
              <InviteRow key={i.id} invite={i} canWithdraw={canPeople} onChanged={refresh} />
            ))}
          </ul>
        </>
      )}

      <div className="headrow">
        <h2>Roles</h2>
        {canManage && editingRole === null && <button onClick={() => setEditingRole("new")}>+ New role</button>}
      </div>
      <Status query={roles}>
        {(r) => (
          <Status query={perms}>
            {(catalog) => (
              <ul className="list">
                {editingRole === "new" && (
                  <li className="row static">
                    <RoleEditor catalog={catalog.items} holds={holds} onDone={async (changed) => { setEditingRole(null); if (changed) await refresh(); }} />
                  </li>
                )}
                {r.items.map((role) => (
                  <li key={role.id} className="row static">
                    {editingRole === role.id ? (
                      <RoleEditor role={role} catalog={catalog.items} holds={holds} onDone={async (changed) => { setEditingRole(null); if (changed) await refresh(); }} />
                    ) : (
                      <>
                        <div className="headrow">
                          <div>
                            <strong>{role.name}</strong>
                            <span className="badge">{role.builtIn ? "Built-in" : "Custom"}</span>
                            <div className="muted small">
                              {role.memberCount} {role.memberCount === 1 ? "person" : "people"} · {role.locked ? "Always has every permission" : `${role.permissions.length} permissions`}
                            </div>
                          </div>
                          {canManage && !role.locked && editingRole === null && <button onClick={() => setEditingRole(role.id)}>Edit</button>}
                        </div>
                        <PermissionSummary role={role} catalog={catalog.items} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Status>
        )}
      </Status>
    </>
  );
}

function PermissionSummary({ role, catalog }: { role: TeamRole; catalog: PermissionInfo[] }) {
  const shown = catalog.filter((p) => p.inUse && role.permissions.includes(p.key));
  return (
    <details>
      <summary className="small">What this role can do</summary>
      <ul className="small">{shown.map((p) => <li key={p.key}>{p.label}</li>)}</ul>
    </details>
  );
}

function MemberRolesEditor({ member, roles, holds, onDone }: { member: TeamMember; roles: TeamRole[]; holds: (p: string) => boolean; onDone: (changed: boolean) => void }) {
  const orgId = useOrgId();
  const [picked, setPicked] = useState<Set<string>>(new Set(member.roles.map((r) => r.id)));
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/team/members/${member.membershipId}`, { method: "PATCH", body: { roleIds: [...picked] } }),
    onSuccess: () => onDone(true),
  });
  const removingOwnOwner = member.isYou && member.roles.some((r) => r.key === "owner") && !roles.some((r) => r.key === "owner" && picked.has(r.id));
  return (
    <div className="editor">
      {roles.map((r) => {
        const allowed = r.permissions.every(holds);
        return (
          <label key={r.id} className={`check ${allowed ? "" : "disabled"}`}>
            <input
              type="checkbox"
              checked={picked.has(r.id)}
              disabled={!allowed}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(r.id);
                else next.delete(r.id);
                setPicked(next);
              }}
            />
            {r.name}
            {!allowed && <span className="muted small"> (has permissions you don't)</span>}
          </label>
        );
      })}
      {removingOwnOwner && <p className="warnbox small">You're removing your own Owner role. You'll lose access to this page. This only works if someone else is also an owner.</p>}
      {picked.size === 0 && <p className="muted small">Everyone needs at least one role.</p>}
      {save.error && <p className="error" role="alert">{errText(save.error)}</p>}
      <div className="actions">
        <button className="primary" disabled={picked.size === 0 || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button onClick={() => onDone(false)}>Cancel</button>
      </div>
    </div>
  );
}

function RoleEditor({ role, catalog, holds, onDone }: { role?: TeamRole; catalog: PermissionInfo[]; holds: (p: string) => boolean; onDone: (changed: boolean) => void }) {
  const orgId = useOrgId();
  const [name, setName] = useState(role?.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const groups = useMemo(() => {
    const g = new Map<string, PermissionInfo[]>();
    for (const p of catalog) g.set(p.group, [...(g.get(p.group) ?? []), p]);
    return [...g.entries()];
  }, [catalog]);
  const save = useMutation({
    mutationFn: () =>
      role
        ? api(`/v1/orgs/${orgId}/team/roles/${role.id}`, { method: "PATCH", body: { name: name.trim(), permissions: [...picked] } })
        : api(`/v1/orgs/${orgId}/team/roles`, { method: "POST", body: { name: name.trim(), permissions: [...picked] } }),
    onSuccess: () => onDone(true),
  });
  const remove = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/team/roles/${role!.id}`, { method: "DELETE" }),
    onSuccess: () => onDone(true),
  });
  return (
    <div className="editor">
      <label>
        Role name
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead Technician" />
      </label>
      {groups.map(([group, items]) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {items.map((p) => {
            const allowed = holds(p.key);
            return (
              <label key={p.key} className={`check ${allowed ? "" : "disabled"}`}>
                <input
                  type="checkbox"
                  checked={picked.has(p.key)}
                  disabled={!allowed}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(p.key);
                    else next.delete(p.key);
                    setPicked(next);
                  }}
                />
                {p.label}
                {!p.inUse && <span className="muted small"> (not used yet)</span>}
              </label>
            );
          })}
        </fieldset>
      ))}
      {(save.error || remove.error) && <p className="error" role="alert">{errText(save.error ?? remove.error)}</p>}
      <div className="actions">
        <button className="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>{role ? "Save" : "Create role"}</button>
        <button onClick={() => onDone(false)}>Cancel</button>
        {role && !role.builtIn && (
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete the role "${role.name}"? This can't be undone.`)) remove.mutate();
            }}
          >
            Delete role
          </button>
        )}
      </div>
    </div>
  );
}

function AddPerson({ roles, holds, onDone }: { roles: TeamRole[]; holds: (p: string) => boolean; onDone: (changed: boolean) => void }) {
  const orgId = useOrgId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(roles.filter((r) => r.key === "employee").map((r) => r.id)));
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/orgs/${orgId}/team/invites`, {
        method: "POST",
        body: { email: email.trim(), displayName: name.trim(), ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}), roleIds: [...picked] },
      }),
    onSuccess: () => onDone(true),
  });
  const ready = name.trim() !== "" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && picked.size > 0;
  return (
    <div className="editor row static">
      <p className="muted small">
        They sign in with this email address. Microsoft sends them a code to prove it's theirs, so no password is needed. Nothing is emailed by us: tell them to open the app and tap Sign in.
      </p>
      <label>Name<input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></label>
      <label>Email<input type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
      <label>Job title (optional)<input value={jobTitle} maxLength={120} onChange={(e) => setJobTitle(e.target.value)} placeholder="Technician" /></label>
      <fieldset>
        <legend>Roles</legend>
        {roles.map((r) => {
          const allowed = r.permissions.every(holds);
          return (
            <label key={r.id} className={`check ${allowed ? "" : "disabled"}`}>
              <input
                type="checkbox"
                checked={picked.has(r.id)}
                disabled={!allowed}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                  setPicked(next);
                }}
              />
              {r.name}
              {!allowed && <span className="muted small"> (has permissions you don't)</span>}
            </label>
          );
        })}
      </fieldset>
      {add.error && <p className="error" role="alert">{errText(add.error)}</p>}
      <div className="actions">
        <button className="primary" disabled={!ready || add.isPending} onClick={() => add.mutate()}>Add person</button>
        <button onClick={() => onDone(false)}>Cancel</button>
      </div>
    </div>
  );
}

function InviteRow({ invite, canWithdraw, onChanged }: { invite: TeamInvite; canWithdraw: boolean; onChanged: () => Promise<void> }) {
  const orgId = useOrgId();
  const withdraw = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/team/invites/${invite.id}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });
  const renew = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/team/invites/${invite.id}/renew`, { method: "POST" }),
    onSuccess: onChanged,
  });
  const until = new Date(invite.expiresAt).toLocaleDateString();
  return (
    <li className="row static">
      <div className="headrow">
        <div>
          <strong>{invite.displayName}</strong>
          <span className="badge">{invite.expired ? "Expired" : "Waiting to accept"}</span>
          <div className="muted small">
            {invite.email} · {invite.roles.map((r) => r.name).join(", ")} · {invite.expired ? `expired ${until}` : `can accept until ${until}`}
          </div>
        </div>
        {canWithdraw && (
          <button disabled={renew.isPending} onClick={() => renew.mutate()} title="Gives them 14 more days from today">
            Renew
          </button>
        )}
        {canWithdraw && (
          <button
            disabled={withdraw.isPending}
            onClick={() => {
              if (window.confirm(`Withdraw ${invite.displayName}? ${invite.email} won't be able to sign in.`)) withdraw.mutate();
            }}
          >
            Withdraw
          </button>
        )}
      </div>
      {withdraw.error && <p className="error" role="alert">{errText(withdraw.error)}</p>}
      {renew.error && <p className="error" role="alert">{errText(renew.error)}</p>}
    </li>
  );
}

function AccessButtons({ member, roles, holds, onChanged }: { member: TeamMember; roles: TeamRole[]; holds: (p: string) => boolean; onChanged: () => Promise<void> }) {
  const orgId = useOrgId();
  const set = useMutation({
    mutationFn: (status: "active" | "suspended" | "removed") => api(`/v1/orgs/${orgId}/team/members/${member.membershipId}/status`, { method: "PATCH", body: { status } }),
    onSuccess: onChanged,
    onError: (e) => window.alert(errText(e)),
  });
  const allowed = member.roles.every((x) => (roles.find((r) => r.id === x.id)?.permissions ?? []).every(holds));
  if (!allowed) return null;
  return (
    <>
      {member.status === "suspended" ? (
        <button disabled={set.isPending} onClick={() => set.mutate("active")}>Restore access</button>
      ) : (
        <button disabled={set.isPending} onClick={() => window.confirm(`Suspend ${member.displayName}? They lose access until you restore them, and their phone deletes this company's data (including photos it hasn't uploaded yet) next time it connects.`) && set.mutate("suspended")}>Suspend</button>
      )}
      <button
        className="danger"
        disabled={set.isPending}
        onClick={() =>
          window.confirm(`Remove ${member.displayName} from the company? They lose access straight away and their phone deletes this company's data, including photos it hasn't uploaded yet, next time it connects. To bring them back, add them again.`) &&
          set.mutate("removed")
        }
      >
        Remove
      </button>
    </>
  );
}
