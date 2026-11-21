import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/members")
      ? new Response(JSON.stringify({ error: { code: "forbidden", message: "no", requestId: "r" } }), { status: 403 })
      : new Response(JSON.stringify(org), { status: 200 })));
    renderApp("/orgs/o/employees");
    expect(await screen.findByText("You don't have permission to view this.")).toBeTruthy();
    // Navigation hides links the member cannot use (UI only; the API enforces access).
    expect(screen.queryByRole("link", { name: "Employees" })).toBeNull();
  });
});
