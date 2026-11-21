import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { OrgContextResponse } from "@rsb/contracts";
import { api } from "./api";

export function useOrgId(): string {
  const { orgId } = useParams();
  return orgId ?? "";
}

/** Server-provided permissions. Used ONLY to hide UI; the API enforces every check. */
export function useOrgContext() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ["org", orgId], queryFn: () => api<OrgContextResponse>(`/v1/orgs/${orgId}`) });
}

export function useCan(permission: string): boolean {
  const ctx = useOrgContext();
  return ctx.data?.permissions.includes(permission) ?? false;
}

export function useOrgQuery<T>(key: string, path: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: [orgId, key, path], queryFn: () => api<T>(`/v1/orgs/${orgId}${path}`), enabled });
}
