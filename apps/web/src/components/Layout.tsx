import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import type { MeResponse } from "@rsb/contracts";
import { useOrgContext, useOrgId } from "../lib/hooks";
import { api, session } from "../lib/api";
import { DevBanner, Status } from "./ui";
import { AlertsBell } from "./alerts";

export function Layout() {
  const orgId = useOrgId();
  const ctx = useOrgContext();
  // Most people belong to one company; only show the switcher to someone who belongs to several.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/v1/me") });
  const manyCompanies = (me.data?.memberships?.length ?? 0) > 1;
  const perms = ctx.data?.permissions ?? [];
  const seesTeam = perms.includes("roles.manage") || perms.includes("members.read");
  const nav = [
    { to: "", label: "Overview" },
    { to: "jobs", label: "Jobs" },
    { to: "photos", label: "Find photos" },
    ...(seesTeam ? [{ to: "team", label: "Team & roles" }] : []),
    { to: "settings", label: "Settings" },
  ];

  return (
    <div className="shell">
      <DevBanner />
      <header className="topbar">
        <img src="/favicon.png" alt="Right Services" className="logo-mark" />
        <strong>{ctx.data?.organization.name ?? "…"}</strong>
        <span className="muted">{ctx.data?.roles.join(", ")}</span>
        <span className="spacer" />
        {ctx.data && <AlertsBell />}
        <button className="link" onClick={() => session.set(null)}>Sign out</button>
      </header>
      <nav className="sidenav" aria-label="Main">
        {nav.map((n) => (
          <NavLink key={n.to} to={`/orgs/${orgId}/${n.to}`} end={n.to === ""}>{n.label}</NavLink>
        ))}
        {manyCompanies && <NavLink to="/">Switch company</NavLink>}
      </nav>
      <main className="content">
        <Status query={ctx}>{() => <Outlet />}</Status>
      </main>
    </div>
  );
}
