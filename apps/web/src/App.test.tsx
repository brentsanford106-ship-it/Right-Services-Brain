import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { session } from "./lib/api";

function renderApp(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); session.set(null); vi.unstubAllGlobals(); });

describe("web dashboard", () => {
  it("company walls: signing out forgets all loaded company data (shared computers)", async () => {
    session.set("x.y.z");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ warning: "dev", items: [] }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["company-a", "jobs"], { items: [{ jobNumber: "SECRET-1" }] });
    render(<QueryClientProvider client={qc}><MemoryRouter><App /></MemoryRouter></QueryClientProvider>);
    expect(qc.getQueryData(["company-a", "jobs"])).toBeTruthy();
    session.set(null);
    await waitFor(() => expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[0] === "company-a")).toEqual([]));
  });

  it("shows the development sign-in with a clear warning when signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ warning: "dev", items: [{ subject: "dev-a", displayName: "Avery Owner", description: "Owner" }] }), { status: 200 })));
    renderApp();
    expect(await screen.findByText("Avery Owner")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/NOT secure authentication/);
  });

  it("returns to sign-in when the API rejects the session (401)", async () => {
    session.set("x.y.z");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/v1/me")
      ? new Response(JSON.stringify({ error: { code: "unauthenticated", message: "expired", requestId: "r" } }), { status: 401 })
      : new Response(JSON.stringify({ warning: "dev", items: [] }), { status: 200 })));
    renderApp();
    expect(await screen.findByText("Development sign-in")).toBeTruthy();
    expect(session.token).toBeNull();
  });

  it("shows a permission message instead of data on 403", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["employee"], permissions: ["org.read"] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/jobs/j1")
      ? new Response(JSON.stringify({ error: { code: "forbidden", message: "no", requestId: "r" } }), { status: 403 })
      : new Response(JSON.stringify(org), { status: 200 })));
    renderApp("/orgs/o/jobs/j1");
    expect(await screen.findByText("You don't have permission to view this.")).toBeTruthy();
  });

  it("has no receipts, vehicles or employees sections in Phase 1", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["owner"], permissions: ["org.read", "receipts.read_all", "vehicles.read_all", "members.read"] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(org), { status: 200 })));
    renderApp("/orgs/o/settings");
    expect(await screen.findByRole("link", { name: "Find photos" })).toBeTruthy();
    for (const name of ["Receipts", "Vehicles", "Employees"]) expect(screen.queryByRole("link", { name })).toBeNull();
  });

  it("job gallery: filters, loads images with the sign-in token (no shareable links), and flags from the viewer", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["manager"], permissions: ["org.read", "photo_flags.manage", "jobs.manage"] };
    const job = { id: "j1", jobNumber: "HP-1001", title: "Pump island (DEMO)", status: "active", siteName: "Station 1", siteAddress: null, customerName: null, scheduledStart: null, scheduledEnd: null, assignees: null };
    const photo = (id: string, stage: string, flagged: boolean) => ({ id, jobId: "j1", jobNumber: "HP-1001", siteName: null, stage, note: null, flagged, flaggedAt: null, capturedAt: "2026-11-10T15:30:00Z", uploadStatus: "stored", uploadedBy: "Eli Employee", openFlags: 0, latitude: null, longitude: null, widthPx: 10, heightPx: 10, hasPreview: true, storedAt: "2026-11-10T16:00:00Z" });
    const photos = [photo("p1", "before", false), photo("p2", "after", true)];
    const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", auth: h.authorization ?? null, body: init?.body as string | undefined });
      if (url.endsWith("/content")) return new Response(new Blob(["img"]), { status: 200 });
      if (init?.method === "PATCH") return new Response(JSON.stringify({ ...photos[0], flagged: true }), { status: 200 });
      if (url.endsWith("/jobs/j1/photos")) return new Response(JSON.stringify({ items: photos }), { status: 200 });
      if (url.endsWith("/jobs/j1")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response(JSON.stringify(org), { status: 200 });
    }));
    renderApp("/orgs/o/jobs/j1");
    expect(await screen.findByText(/HP-1001 · Pump island/)).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /Open .* photo/ })).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /Flagged/ }));
    expect(screen.getAllByRole("button", { name: /Open .* photo/ }).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /Open Before photo/ })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "⚑ Flag this photo" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toMatch(/\/v1\/orgs\/o\/photos\/p1$/);
    expect(JSON.parse(patch.body!)).toEqual({ flagged: true });
    const images = calls.filter((c) => c.url.endsWith("/content"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((c) => c.auth === "Bearer x.y.z")).toBe(true);
  });
});
