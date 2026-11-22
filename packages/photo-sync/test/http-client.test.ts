import { describe, expect, it } from "vitest";
import { ApiError, HttpClient, NetworkError, type FetchLike } from "../src/index";

/**
 * Answers that did NOT come from our server (a Wi-Fi sign-in page, Azure's error page while the server restarts,
 * an empty proxy error) must count as "no connection": the photo is retried later. Before this fix they made the
 * photo "needs attention" (stuck until someone tapped Retry), and an Azure 404 page could look like "you were removed".
 */
const reply = (status: number, text: string): ReturnType<FetchLike> =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, text: async () => text });

function client(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({ baseUrl: "https://api.example.test", getToken: async () => "a.b.c", fetch, ...extra });
}

describe("HttpClient: what counts as a real answer from our server", () => {
  it("a Wi-Fi sign-in page (200 with a web page) is treated as no connection", async () => {
    const c = client(() => reply(200, "<html><body>Please accept the terms to use Wi-Fi</body></html>"));
    await expect(c.get("/v1/me")).rejects.toBeInstanceOf(NetworkError);
  });

  it("Azure's own 502/503 web page while the server restarts is treated as no connection", async () => {
    const c = client(() => reply(503, "<!DOCTYPE html><title>Service Unavailable</title>"));
    await expect(c.get("/v1/me")).rejects.toBeInstanceOf(NetworkError);
  });

  it("a 404 that is not our server's (no request id) is NOT 'you were removed'", async () => {
    await expect(client(() => reply(404, "<h1>404 Web Site not found</h1>")).get("/v1/orgs/x")).rejects.toBeInstanceOf(NetworkError);
    await expect(client(() => reply(404, "")).get("/v1/orgs/x")).rejects.toBeInstanceOf(NetworkError);
    await expect(client(() => reply(404, '{"message":"nope"}')).get("/v1/orgs/x")).rejects.toBeInstanceOf(NetworkError);
  });

  it("our server's real errors still come through as they are", async () => {
    const body = JSON.stringify({ error: { code: "not_found", message: "Not found.", requestId: "req-1" } });
    const err = await client(() => reply(404, body)).get("/v1/orgs/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "not_found", requestId: "req-1" });
    const conflict = JSON.stringify({ error: { code: "conflict", message: "This photo already has a different file.", requestId: "req-2" } });
    await expect(client(() => reply(409, conflict)).get("/x")).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("a 401 without our error shape still means 'sign in again' (keeps photos, asks to sign in)", async () => {
    await expect(client(() => reply(401, "")).get("/v1/me")).rejects.toMatchObject({ status: 401 });
  });

  it("successful answers, including empty ones (204), work as before", async () => {
    expect(await client(() => reply(200, '{"ok":true}')).get("/x")).toEqual({ ok: true });
    expect(await client(() => reply(204, "")).delete("/x")).toBeNull();
  });

  it("a photo upload that hangs gives up after the time limit, so the next photos aren't held up", async () => {
    const never: FetchLike = () => new Promise(() => undefined);
    const c = client(never, { uploadTimeoutMs: 50 });
    const started = Date.now();
    await expect(c.uploadContent("o", "p", new Uint8Array([1, 2, 3]), "image/jpeg")).rejects.toBeInstanceOf(NetworkError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the phone's own uploader (putBytes) is held to the same time limit", async () => {
    const c = client(() => reply(200, "{}"), { uploadTimeoutMs: 50, putBytes: () => new Promise(() => undefined) });
    await expect(c.uploadContent("o", "p", new Uint8Array([1]), "image/jpeg")).rejects.toBeInstanceOf(NetworkError);
  });

  it("an upload answered by a Wi-Fi sign-in page is retried later, not marked as refused", async () => {
    const c = client(() => reply(200, "<html>Sign in to Wi-Fi</html>"), { putBytes: () => reply(200, "<html>Sign in to Wi-Fi</html>") });
    await expect(c.uploadContent("o", "p", new Uint8Array([1]), "image/jpeg")).rejects.toBeInstanceOf(NetworkError);
  });
});
