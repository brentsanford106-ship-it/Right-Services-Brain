import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import type { MeResponse, PendingInvite } from "@rsb/contracts";
import { api, session } from "../lib/api";
import { DevBanner, Status } from "../components/ui";

function InviteCard({ invite }: { invite: PendingInvite }) {
  const qc = useQueryClient();
  const respond = useMutation({
    mutationFn: (accept: boolean) => api(`/v1/invites/${invite.inviteId}/${accept ? "accept" : "decline"}`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <li className="row static">
      <strong>{invite.organizationName}</strong>
      <div className="muted small">
        Added by {invite.invitedBy} as {invite.roles.join(", ") || "a member"}. Accept by {new Date(invite.expiresAt).toLocaleDateString()}.
      </div>
      <div className="headrow" style={{ justifyContent: "flex-start", gap: 8, marginTop: 8 }}>
        <button disabled={respond.isPending} onClick={() => respond.mutate(true)}>Accept</button>
        <button
          className="link"
          disabled={respond.isPending}
          onClick={() => {
            if (window.confirm(`Decline ${invite.organizationName}? An owner would have to add you again.`)) respond.mutate(false);
          }}
        >
          Decline
        </button>
      </div>
      {respond.error && <p className="error" role="alert">{(respond.error as Error).message}</p>}
    </li>
  );
}

export function OrgPickerPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/v1/me") });
  return (
    <div className="shell center">
      <DevBanner />
      <main className="login">
        <Status query={me}>
          {(d) => {
            const invites = d.invites ?? [];
            if (invites.length === 0 && d.memberships.length === 1) return <Navigate to={`/orgs/${d.memberships[0]!.organizationId}`} replace />;
            return (
              <>
                <h1>Hi, {d.user.displayName}</h1>
                {invites.length > 0 && (
                  <>
                    <h3>You've been added</h3>
                    <p className="muted small">Join only companies you work for. You can't see anything of a company until you accept.</p>
                    <ul className="list">
                      {invites.map((i) => <InviteCard key={i.inviteId} invite={i} />)}
                    </ul>
                  </>
                )}
                {d.memberships.length === 0 ? (
                  invites.length === 0 && <p>You're not in a company yet. Ask an owner to add your email address.</p>
                ) : (
                  <ul className="list">
                    {d.memberships.map((m) => (
                      <li key={m.organizationId}>
                        <Link className="row" to={`/orgs/${m.organizationId}`}>{m.organizationName}</Link>
                      </li>
                    ))}
                  </ul>
                )}
                <button className="link" onClick={() => session.set(null)}>Sign out</button>
              </>
            );
          }}
        </Status>
      </main>
    </div>
  );
}
