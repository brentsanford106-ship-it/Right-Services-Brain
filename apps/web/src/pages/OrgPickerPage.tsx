import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router-dom";
import type { MeResponse } from "@rsb/contracts";
import { api, session } from "../lib/api";
import { DevBanner, Status } from "../components/ui";

export function OrgPickerPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/v1/me") });
  return (
    <div className="shell center">
      <DevBanner />
      <main className="login">
        <Status query={me}>
          {(d) => {
            if (d.memberships.length === 1) return <Navigate to={`/orgs/${d.memberships[0]!.organizationId}`} replace />;
            return (
              <>
                <h1>Hi, {d.user.displayName}</h1>
                {d.memberships.length === 0 ? (
                  <p>Your account is not an active member of any company.</p>
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
