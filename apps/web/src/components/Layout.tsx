import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router-dom";
import type { MeResponse } from "@rsb/contracts";
import { useOrgContext, useOrgId } from "../lib/hooks";
import { api, session } from "../lib/api";
import { DevBanner, Status } from "./ui";
import { AlertsBell } from "./alerts";
import { Icon, type IconName } from "./icons";
import { BRAND } from "../brand";

export function Layout() {
  const orgId = useOrgId();
  const ctx = useOrgContext();
  // Most people belong to one company; only show the switcher to someone who belongs to several.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<MeResponse>("/v1/me") });
  const manyCompanies = (me.data?.memberships?.length ?? 0) > 1;
  const perms = ctx.data?.permissions ?? [];
  const seesTeam = perms.includes("roles.manage") || perms.includes("members.read");
  const nav: { to: string; label: string; icon: IconName }[] = [
    { to: "", label: "Overview", icon: "grid" },
    { to: "jobs", label: "Jobs", icon: "briefcase" },
    { to: "photos", label: "Find photos", icon: "image" },
    ...(seesTeam ? [{ to: "team", label: "Team & roles", icon: "users" as const }] : []),
    { to: "settings", label: "Settings", icon: "settings" },
  ];

  return (
    <div className="shell">
      <DevBanner />
      <nav className="sidenav" aria-label="Main">
        <div className="sidebrand"><img src={BRAND.logo} alt={BRAND.name} /></div>
        {nav.map((n) => (
          <NavLink key={n.to} to={`/orgs/${orgId}/${n.to}`} end={n.to === ""}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </NavLink>
        ))}
        {manyCompanies && (
          <NavLink to="/">
            <Icon name="swap" />
            <span>Switch company</span>
          </NavLink>
        )}
      </nav>
      <header className="topbar">
        <img src={BRAND.mark} alt="" className="logo-mark" />
        <div className="orgname">
          <strong>{ctx.data?.organization.name ?? "…"}</strong>
          <span className="muted small">{ctx.data?.roles.join(", ")}</span>
        </div>
        <span className="spacer" />
        {ctx.data && <AlertsBell />}
        <button className="ghost" onClick={() => session.set(null)}>
          <Icon name="logout" />
          <span>Sign out</span>
        </button>
      </header>
      <main className="content">
        <Status query={ctx}>{() => <Outlet />}</Status>
      </main>
    </div>
  );
}
