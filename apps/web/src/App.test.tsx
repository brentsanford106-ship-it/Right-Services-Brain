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

afterEach(() => { cleanup(); session.set(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it("who took it: initials on thumbnails, filter by one or several people or Photos I took, small thumbnails", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["manager"], permissions: ["org.read", "jobs.read_all"] };
    const job = { id: "j1", jobNumber: "HP-1001", title: "Pump island (DEMO)", status: "active", siteName: null, siteAddress: null, customerName: null, scheduledStart: null, scheduledEnd: null, assignees: null };
    const base = { jobId: "j1", jobNumber: "HP-1001", siteName: null, stage: "during", note: null, flagged: false, flaggedAt: null, uploadStatus: "stored", openFlags: 0, latitude: null, longitude: null, widthPx: 10, heightPx: 10, hasPreview: true, storedAt: null, captureSource: "in_app_camera", uploadedByMe: false, canDelete: false };
    const by = (id: string, pid: string | null, name: string | null, at: string, mine = false) => ({ ...base, id, capturedAt: at, capturedAtKnown: true, photographerAvatarAt: null as string | null, photographerId: pid, photographer: name, uploadedBy: name ?? "Someone", takenByMe: mine, uploadedByMe: mine });
    const photos = [
      by("p1", "john", "John Smith", "2026-11-10T09:00:00Z"),
      by("p2", "john", "John Smith", "2026-11-10T10:00:00Z"),
      { ...by("p3", "ann", "Ann Lee", "2026-11-10T11:00:00Z"), photographerAvatarAt: "2026-11-20T00:00:00Z" },
      by("p4", "me", "Morgan Manager", "2026-11-10T12:00:00Z", true),
      { ...by("p5", null, null, "2026-11-10T13:00:00Z"), captureSource: "imported" },
    ];
    const urls: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/content") || url.endsWith("/avatar")) return new Response("img", { status: 200 });
      if (url.endsWith("/jobs/j1/photos")) return new Response(JSON.stringify({ items: photos }), { status: 200 });
      if (url.endsWith("/jobs/j1")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response(JSON.stringify(org), { status: 200 });
    }));
    renderApp("/orgs/o/jobs/j1");
    const tiles = await screen.findAllByRole("button", { name: /Open .* photo/ });
    expect(tiles.length).toBe(5);
    expect(screen.getAllByTitle("Taken by John Smith").length).toBeGreaterThan(0);
    expect(screen.getAllByText("JS").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("Who took this is unknown").length).toBeGreaterThan(0);
    // Grids ask for the small thumbnail.
    await waitFor(() => expect(urls.some((u) => u.endsWith("/content?variant=thumb"))).toBe(true));
    // Ann has a profile picture: it is loaded once (with the sign-in token) and shown instead of her initials.
    await waitFor(() => expect(urls.filter((u) => u.endsWith("/members/ann/avatar")).length).toBe(1));
    await waitFor(() => expect(screen.queryAllByText("AL")).toHaveLength(0));

    const shown = () => screen.getAllByRole("button", { name: /Open .* photo/ }).map((b) => b.getAttribute("aria-label")!.replace(/^.*taken by /, "").replace(/,.*$/, ""));
    fireEvent.click(screen.getByRole("checkbox", { name: /John Smith/ }));
    expect(shown()).toEqual(["John Smith", "John Smith"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ann Lee/ }));
    expect(shown().sort()).toEqual(["Ann Lee", "John Smith", "John Smith"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Everyone/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Photos I took/ }));
    expect(shown()).toEqual(["Morgan Manager"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /Everyone/ }));
    // Sort by who took it: unknown last.
    fireEvent.change(screen.getByRole("combobox", { name: /Sort/ }), { target: { value: "photographer" } });
    expect(shown()).toEqual(["Ann Lee", "John Smith", "John Smith", "Morgan Manager", "Unknown"]);
    // The viewer says who took it, and that an imported photo's photographer is unknown.
    fireEvent.click(screen.getAllByRole("button", { name: /taken by Unknown/ })[0]!);
    expect(await screen.findByText("Imported from a photo library")).toBeTruthy();
    expect(screen.getByText("Uploaded by")).toBeTruthy();
  });
  it("comments: count badge and filter, read and reply, @mention, and deleted comments show as deleted", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["manager"], permissions: ["org.read", "jobs.read_all", "photo_comments.create"] };
    const job = { id: "j1", jobNumber: "HP-1001", title: "Pump island (DEMO)", status: "active", siteName: null, siteAddress: null, customerName: null, scheduledStart: null, scheduledEnd: null, assignees: null };
    const base = { jobId: "j1", jobNumber: "HP-1001", siteName: null, stage: "during", note: null, flagged: false, flaggedAt: null, uploadStatus: "stored", openFlags: 0, latitude: null, longitude: null, widthPx: 10, heightPx: 10, hasPreview: true, storedAt: null, captureSource: "in_app_camera", uploadedByMe: false, canDelete: false, capturedAtKnown: true, photographerAvatarAt: null, photographerId: "eli", photographer: "Eli Employee", uploadedBy: "Eli Employee", takenByMe: false, lastCommentAt: null };
    const photos = [
      { ...base, id: "p1", capturedAt: "2026-11-10T09:00:00Z", commentCount: 2 },
      { ...base, id: "p2", capturedAt: "2026-11-10T10:00:00Z", commentCount: 0 },
    ];
    const c = { photoId: "p1", authorAvatarAt: null, mentions: [], editedAt: null, deletedAt: null, deletedBy: null, canEdit: false, canDelete: false, mine: false };
    const comments = [
      { ...c, id: "c1", parentId: null, authorId: "eli", author: "Eli Employee", body: "Strap is loose here", createdAt: "2026-11-10T09:05:00Z" },
      { ...c, id: "c2", parentId: "c1", authorId: "m", author: "Morgan Manager", body: null, createdAt: "2026-11-10T09:06:00Z", deletedAt: "2026-11-10T09:07:00Z", deletedBy: "Morgan Manager" },
    ];
    const posts: unknown[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/content") || url.endsWith("/avatar")) return new Response("img", { status: 200 });
      if (url.endsWith("/photos/p1/comments") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ...c, id: "c3", parentId: "c1", authorId: "m", author: "Morgan Manager", body: "Fixed", createdAt: "2026-11-10T09:10:00Z" }), { status: 201 });
      }
      if (url.endsWith("/photos/p1/comments")) return new Response(JSON.stringify({ items: comments }), { status: 200 });
      if (url.endsWith("/jobs/j1/people")) return new Response(JSON.stringify({ items: [{ id: "eli", name: "Eli Employee", avatarAt: null, me: false }, { id: "m", name: "Morgan Manager", avatarAt: null, me: true }] }), { status: 200 });
      if (url.endsWith("/jobs/j1/photos")) return new Response(JSON.stringify({ items: photos }), { status: 200 });
      if (url.endsWith("/jobs/j1")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response(JSON.stringify(org), { status: 200 });
    }));
    renderApp("/orgs/o/jobs/j1");
    expect(await screen.findByTitle("2 comments")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));
    expect(screen.getAllByRole("button", { name: /Open .* photo/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /2 comments/ }));
    expect(await screen.findByText("Strap is loose here")).toBeTruthy();
    expect(screen.getByText(/Comment deleted by Morgan Manager/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByRole("textbox", { name: "Reply to Eli Employee" });
    fireEvent.change(box, { target: { value: "Fixed" } });
    // The mention list shows the people on the job (not yourself), and picking one adds @Name.
    await waitFor(() => expect(screen.getAllByRole("option", { name: "Eli Employee" }).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole("option", { name: "Morgan Manager" })).toHaveLength(0);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Mention someone" })[0]!, { target: { value: "eli" } });
    expect((box as HTMLTextAreaElement).value).toBe("Fixed @Eli Employee ");
    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ body: "Fixed @Eli Employee", parentId: "c1", mentionIds: ["eli"] });
  });
  it("drawing: shows saved marks, hide/show, draw an arrow, undo, save sends only the change, comment on a mark", async () => {
    session.set("x.y.z");
    const org = { organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["manager"], permissions: ["org.read", "jobs.read_all", "photo_comments.create", "photo_markups.create"] };
    const job = { id: "j1", jobNumber: "HP-1001", title: "Pump island (DEMO)", status: "active", siteName: null, siteAddress: null, customerName: null, scheduledStart: null, scheduledEnd: null, assignees: null };
    const photo = { jobId: "j1", jobNumber: "HP-1001", siteName: null, stage: "during", note: null, flagged: false, flaggedAt: null, uploadStatus: "stored", openFlags: 0, latitude: null, longitude: null, widthPx: 1000, heightPx: 750, hasPreview: true, storedAt: null, captureSource: "in_app_camera", uploadedByMe: false, canDelete: false, capturedAtKnown: true, photographerAvatarAt: null, photographerId: "eli", photographer: "Eli Employee", uploadedBy: "Eli Employee", takenByMe: false, lastCommentAt: null, commentCount: 0, markupCount: 1, id: "p1", capturedAt: "2026-11-10T09:00:00Z" };
    const saved = { id: "k1", kind: "circle", color: "red", size: 2, points: [[0.1, 0.1], [0.3, 0.3]], label: null, authorId: "m", author: "Morgan Manager", createdAt: "2026-11-10T09:05:00Z", mine: true, canRemove: true };
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes("/content") || url.endsWith("/avatar")) return new Response("img", { status: 200 });
      if (url.endsWith("/markups/changes")) return new Response(JSON.stringify({ items: [saved] }), { status: 200 });
      if (url.endsWith("/photos/p1/markups")) return new Response(JSON.stringify({ items: [saved] }), { status: 200 });
      if (url.endsWith("/photos/p1/comments") && init?.method === "POST") return new Response(JSON.stringify({ id: "c9", parentId: null, markupId: "k1", authorId: "m", author: "Morgan Manager", authorAvatarAt: null, body: "Fix", mentions: [], createdAt: "2026-11-10T09:10:00Z", editedAt: null, deletedAt: null, deletedBy: null, mine: true, canEdit: true, canDelete: true, photoId: "p1" }), { status: 201 });
      if (url.endsWith("/photos/p1/comments")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith("/jobs/j1/people")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith("/jobs/j1/photos")) return new Response(JSON.stringify({ items: [photo] }), { status: 200 });
      if (url.endsWith("/jobs/j1")) return new Response(JSON.stringify(job), { status: 200 });
      return new Response(JSON.stringify(org), { status: 200 });
    }));
    // The drawing area is 100 x 100 pixels on screen in this test.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    renderApp("/orgs/o/jobs/j1");
    fireEvent.click(await screen.findByRole("button", { name: /Open .* photo/ }));
    expect(await screen.findByRole("img", { name: "1 drawing on this photo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide drawings (1)" }));
    expect(screen.queryByRole("img", { name: "1 drawing on this photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show drawings (1)" }));

    // Comment on the circle: click on its outline.
    fireEvent.pointerDown(screen.getByRole("img", { name: "1 drawing on this photo" }), { clientX: 20, clientY: 10 });
    expect(await screen.findByText(/Commenting on the red circle/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Comment on the red circle" }), { target: { value: "Fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts.find((p) => p.url.endsWith("/comments"))?.body).toMatchObject({ body: "Fix", markupId: "k1" }));

    // Draw an arrow, undo it, redo it, save.
    fireEvent.click(screen.getByRole("button", { name: "✎ Draw" }));
    fireEvent.click(screen.getByRole("button", { name: "Arrow" }));
    const area = screen.getByRole("img", { name: "1 drawing on this photo" });
    fireEvent.pointerDown(area, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(area, { clientX: 80, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(area, { clientX: 80, clientY: 70, pointerId: 1 });
    expect(screen.getByRole("img", { name: "2 drawings on this photo" })).toBeTruthy();
    const saveBtn = () => screen.getByRole("button", { name: "Save drawing" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/markups/changes"))).toBe(true));
    const sent = posts.find((p) => p.url.endsWith("/markups/changes"))!.body as { add: { kind: string; points: number[][]; color: string }[]; remove: string[] };
    expect(sent.remove).toEqual([]);
    expect(sent.add).toHaveLength(1);
    expect(sent.add[0]).toMatchObject({ kind: "arrow", color: "red", points: [[0.5, 0.5], [0.8, 0.7]] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save drawing" })).toBeNull()); // back to viewing
  });
  it("issues: to-fix badge and filter, job Issues list, approve a fix, and an employee reports an issue without assigning it", async () => {
    session.set("x.y.z");
    let perms = ["org.read", "jobs.read_all", "photo_comments.create", "photo_issues.create", "photo_issues.manage"];
    const org = () => ({ organization: { id: "o", name: "Demo Co", slug: "demo" }, membershipId: "m", roles: ["manager"], permissions: perms });
    const job = { id: "j1", jobNumber: "HP-1001", title: "Pump island (DEMO)", status: "active", siteName: null, siteAddress: null, customerName: null, scheduledStart: null, scheduledEnd: null, assignees: null };
    const base = { jobId: "j1", jobNumber: "HP-1001", siteName: null, stage: "during", note: null, flagged: false, flaggedAt: null, uploadStatus: "stored", openFlags: 0, latitude: null, longitude: null, widthPx: 10, heightPx: 10, hasPreview: true, storedAt: null, captureSource: "in_app_camera", uploadedByMe: false, canDelete: false, capturedAtKnown: true, photographerAvatarAt: null, photographerId: "eli", photographer: "Eli Employee", uploadedBy: "Eli Employee", takenByMe: false, lastCommentAt: null, commentCount: 0, markupCount: 0 };
    const photos = [
      { ...base, id: "p1", capturedAt: "2026-11-10T09:00:00Z", openIssueCount: 1 },
      { ...base, id: "p2", capturedAt: "2026-11-10T10:00:00Z", stage: "after", openIssueCount: 0 },
    ];
    const none = { assign: false, start: false, submit: false, approve: false, sendBack: false, reopen: false, edit: false };
    const issue = { id: "i1", jobId: "j1", jobNumber: "HP-1001", photoId: "p1", photoDeleted: false, markupId: null, title: "Re-seal the pump base", details: null, status: "awaiting_review", assigneeId: "eli", assignee: "Eli Employee", createdById: "m", createdBy: "Morgan Manager", submittedBy: "Eli Employee", resolvedBy: null, resolvedAt: null, createdAt: "2026-11-10T09:05:00Z", updatedAt: "2026-11-10T11:00:00Z", lastEvent: "submitted", fixPhotoIds: ["p2"], can: { ...none, assign: true, approve: true, sendBack: true, edit: true } };
    const actions: Record<string, unknown>[] = [];
    const reports: Record<string, unknown>[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes("/content") || url.endsWith("/avatar")) return new Response("img", { status: 200 });
      if (url.endsWith("/photo-issues/i1/actions")) { actions.push(JSON.parse(String(init!.body))); return json({ ...issue, status: "resolved", can: none }); }
      if (url.endsWith("/photo-issues/i1")) return json({ issue, history: [{ id: "e1", kind: "submitted", actor: "Eli Employee", fromStatus: "in_progress", toStatus: "awaiting_review", note: "Sealed it", assignee: null, photoId: null, createdAt: "2026-11-10T11:00:00Z" }] });
      if (url.endsWith("/photos/p2/issues") && init?.method === "POST") { reports.push(JSON.parse(String(init.body))); return json({ ...issue, id: "i2", status: "open", assigneeId: null, assignee: null, can: none }, 201); }
      if (url.endsWith("/photos/p1/issues")) return json({ items: [issue] });
      if (url.endsWith("/photos/p2/issues")) return json({ items: [] });
      if (url.endsWith("/jobs/j1/issues")) return json({ items: [issue] });
      if (url.endsWith("/comments")) return json({ items: [] });
      if (url.endsWith("/markups")) return json({ items: [] });
      if (url.endsWith("/jobs/j1/people")) return json({ items: [{ id: "eli", name: "Eli Employee", avatarAt: null, me: false }, { id: "m", name: "Morgan Manager", avatarAt: null, me: true }] });
      if (url.endsWith("/jobs/j1/photos")) return json({ items: photos });
      if (url.endsWith("/jobs/j1")) return json(job);
      return json(org());
    }));
    const view = renderApp("/orgs/o/jobs/j1");
    expect(await screen.findByTitle("1 to fix")).toBeTruthy();
    // The job's Issues list groups it under "Waiting for review".
    expect(await screen.findByRole("heading", { name: "Waiting for review (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /To fix/ }));
    expect(screen.getAllByRole("button", { name: /^Open .* photo from/ })).toHaveLength(1);
    // Open the photo from the issue: the viewer shows the same issue with Approve / Send back.
    fireEvent.click(screen.getByRole("button", { name: "Open the photo" }));
    const viewer = await screen.findByRole("dialog");
    await waitFor(() => expect(viewer.querySelectorAll("[data-testid=issue]").length).toBe(1));
    const sendBack = Array.from(viewer.querySelectorAll("button")).find((b) => b.textContent === "Send back")!;
    fireEvent.click(sendBack);
    // Sending back needs a note.
    const sbButtons = () => Array.from(viewer.querySelectorAll("button")).filter((b) => b.textContent === "Send back");
    expect(sbButtons().at(-1)!.disabled).toBe(true);
    fireEvent.click(Array.from(viewer.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!);
    fireEvent.click(Array.from(viewer.querySelectorAll("button")).find((b) => b.textContent === "Approve")!);
    fireEvent.click(Array.from(viewer.querySelectorAll("button")).find((b) => b.textContent === "Approve fix")!);
    await waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0]).toMatchObject({ action: "approve", expectedStatus: "awaiting_review" });
    // History shows who did what.
    fireEvent.click(Array.from(viewer.querySelectorAll("button")).find((b) => b.textContent === "History")!);
    expect(await screen.findByText(/Sealed it/)).toBeTruthy();
    view.unmount();

    // An employee reports an issue: no "Assign to" choice, it goes to the job list for a manager.
    perms = ["org.read", "jobs.read_all", "photo_comments.create", "photo_issues.create"];
    renderApp("/orgs/o/jobs/j1");
    await screen.findByTitle("1 to fix");
    fireEvent.click(screen.getByRole("button", { name: /Open After photo/ }));
    const v2 = await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: "🔧 Report issue" }));
    expect(screen.getByText(/A manager will see this/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "What needs fixing" }), { target: { value: "Missing bolt" } });
    fireEvent.click(Array.from(v2.querySelectorAll("button")).find((b) => b.textContent === "Report issue")!);
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({ title: "Missing bolt", markupId: null });
    expect(reports[0]).not.toHaveProperty("assigneeId");
  });
});
