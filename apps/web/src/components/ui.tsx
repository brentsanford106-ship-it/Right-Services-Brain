import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiRequestError } from "../lib/api";
import { Icon, type IconName } from "./icons";

export function DevBanner() {
  return (
    <div className="devbanner" role="status">
      DEVELOPMENT BUILD · synthetic data only · development sign-in is NOT secure authentication
    </div>
  );
}

export function Status<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) {
    const e = query.error;
    const msg = e instanceof ApiRequestError
      ? e.status === 403 ? "You don't have permission to view this." : e.status === 404 ? "Not found." : e.message
      : "Could not reach the server.";
    return <p className="error" role="alert">{msg}</p>;
  }
  return <>{children(query.data)}</>;
}

/** A number tile on the Overview page, with an optional icon in a coloured square. */
export function Card({ title, value, icon, tone = "brand" }: { title: string; value: ReactNode; icon?: IconName; tone?: "brand" | "info" | "flag" | "warn" | "ok" }) {
  return (
    <div className="card kpi">
      {icon && <span className={`kpi-icon ${tone}`}><Icon name={icon} size={22} /></span>}
      <div>
        <div className="big">{value}</div>
        <div className="muted small kpi-label">{title}</div>
      </div>
    </div>
  );
}

export const pretty = (s: string) => s.replace(/_/g, " ");
