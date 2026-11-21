import { NavLink, Outlet } from "react-router-dom";
import { useOrgContext, useOrgId } from "../lib/hooks";
import { session } from "../lib/api";
import { DevBanner, Status } from "./ui";

export function Layout() {
  const orgId = useOrgId();
  const ctx = useOrgContext();
  const can = (p: string) => ctx.data?.permissions.includes(p) ?? false;
  const nav = [
    { to: "", label: "Dashboard", show: true },
    { to: "jobs", label: "Jobs", show: true },
    { to: "receipts", label: "Receipts", show: can("receipts.read_own") || can("receipts.read_all") },
    { to: "vehicles", label: "Vehicles", show: can("vehicles.read_all") || can("vehicles.read_assigned") },
    { to: "employees", label: "Employees", show: can("members.read") },
    { to: "settings", label: "Settings", show: true },
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
        {nav.filter((n) => n.show).map((n) => (
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
