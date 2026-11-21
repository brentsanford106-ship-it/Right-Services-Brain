import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiRequestError } from "../lib/api";

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

export function Card({ title, value }: { title: string; value: ReactNode }) {
  return (
    <div className="card">
      <div className="muted">{title}</div>
      <div className="big">{value}</div>
    </div>
  );
}

export const pretty = (s: string) => s.replace(/_/g, " ");
