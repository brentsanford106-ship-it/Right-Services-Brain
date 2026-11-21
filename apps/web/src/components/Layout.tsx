import { NavLink, Outlet } from "react-router-dom";
import { useOrgContext, useOrgId } from "../lib/hooks";
import { session } from "../lib/api";
import { DevBanner, Status } from "./ui";

export function Layout() {
  const orgId = useOrgId();
  const ctx = useOrgContext();
  const nav = [
    { to: "", label: "Overview" },
    { to: "jobs", label: "Jobs" },
    { to: "photos", label: "Find photos" },
    { to: "settings", label: "Settings" },
  ];

  return (
    <div className="shell">
      <DevBanner />
      <header className="topbar">
        <strong>{ctx.data?.organization.name ?? "…"}</strong>
        <span className="muted">{ctx.data?.roles.join(", ")}</span>
        <button className="link" onClick={() => session.set(null)}>Sign out</button>
      </header>
      <nav className="sidenav" aria-label="Main">
        {nav.map((n) => (
          <NavLink key={n.to} to={`/orgs/${orgId}/${n.to}`} end={n.to === ""}>{n.label}</NavLink>
        ))}
        <NavLink to="/">Switch company</NavLink>
      </nav>
      <main className="content">
        <Status query={ctx}>{() => <Outlet />}</Status>
      </main>
    </div>
  );
}
