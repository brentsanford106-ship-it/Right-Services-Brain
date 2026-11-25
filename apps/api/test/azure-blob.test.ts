import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { AzureBlobStorage } from "../src/storage/azureBlob.js";
import { photoKey } from "../src/storage/types.js";
import { createTestApp, F, ORG_A, uuid, type TestApp } from "./helpers.js";

/**
 * The production photo storage code, run against Azurite (Microsoft's official Azure Storage emulator) on
 * this computer. Azurite needs its published test key; the real deployment uses managed identity and has
 * key access switched off, so that part can only be checked in Azure.
 */
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DEV_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONN = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${DEV_KEY};BlobEndpoint=http://127.0.0.1:${PORT}/devstoreaccount1;`;

let proc: ChildProcess;
let container: ContainerClient;
let store: AzureBlobStorage;
let t: TestApp;

beforeAll(async () => {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/azurite-blob");
  proc = spawn(bin, ["--blobPort", String(PORT), "--inMemoryPersistence", "--silent", "--skipApiVersionCheck"], { stdio: "ignore" });
  container = BlobServiceClient.fromConnectionString(CONN).getContainerClient("photos");
  for (let i = 0; i < 50; i++) {
    try {
      await container.createIfNotExists(); // private: no public access level
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  store = new AzureBlobStorage(container);
  t = await createTestApp({}, { storage: store });
}, 30_000);
afterAll(async () => {
  await t?.close();
  proc?.kill();
});

describe("Azure Blob photo storage", () => {
  const key = photoKey("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");

  it("stores, reads back byte-for-byte, and deletes; missing files read as 'not there'", async () => {
    const data = Buffer.from([1, 2, 3, 250, 251]);
    await store.put(key, data, "image/jpeg");
    expect((await store.get(key))?.equals(data)).toBe(true);
    const props = await container.getBlockBlobClient(key).getProperties();
    expect(props.contentType).toBe("image/jpeg");
    expect(props.cacheControl).toBe("private, no-store");
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key); // deleting twice is fine
  });

  it("write-once: a second write to the same photo original is refused and changes nothing", async () => {
    const once = photoKey("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-0000000000f1") + "/original";
    const first = Buffer.from([9, 9, 9]);
    expect(await store.putIfAbsent(once, first, "image/jpeg")).toBe(true);
    expect(await store.putIfAbsent(once, Buffer.from([1, 1, 1]), "image/jpeg")).toBe(false);
    expect((await store.get(once))?.equals(first)).toBe(true);
    expect((await container.getBlockBlobClient(once).getProperties()).cacheControl).toBe("private, no-store");
    await store.delete(once);
  });

  it("the container is private: no anonymous reading", async () => {
    await store.put(key, Buffer.from("x"), "image/jpeg");
    const res = await fetch(`http://127.0.0.1:${PORT}/devstoreaccount1/photos/${key}`);
    expect(res.status).not.toBe(200);
    expect((await container.getAccessPolicy()).blobPublicAccess).toBeUndefined();
  });

  it("refuses keys that aren't server-made photo keys", async () => {
    await expect(store.put("../etc/passwd", Buffer.from("x"), "text/plain")).rejects.toThrow(/invalid storage key/);
    await expect(store.get("org/x/photos/y")).rejects.toThrow(/invalid storage key/);
  });

  it("end to end: a phone upload lands in Blob storage and the office downloads the exact original", async () => {
    const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#c20d36" } }).jpeg().toBuffer();
    const base = `/v1/orgs/${ORG_A}`;
    const rec = await t.as("dev-eli-employee").post(`${base}/jobs/${F.jobs[0].id}/photos`, {
      clientRef: uuid(), stage: "before", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg",
    });
    expect(rec.status).toBe(201);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpeg, "image/jpeg")).status).toBeLessThan(300);
    const original = await t.as("dev-avery-owner").raw(`${base}/photos/${rec.body.id}/content?variant=original`);
    expect(original.status).toBe(200);
    expect(original.data.equals(jpeg)).toBe(true);
    const names: string[] = [];
    for await (const b of container.listBlobsFlat({ prefix: `org/${ORG_A}/photos/${rec.body.id}` })) names.push(b.name);
    expect(names.length).toBeGreaterThanOrEqual(1);
  });
});
