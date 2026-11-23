import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertValidKey, type ObjectStorage } from "./types.js";

/**
 * DEVELOPMENT/TEST storage on the local disk. Not used in staging/production
 * (config.ts refuses), where Azure Blob Storage with private containers,
 * encryption at rest and managed identity replaces it (Phase 2).
 */
export class LocalDiskStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, ...key.split("/"));
    // Defence in depth against path traversal.
    if (!full.startsWith(this.root + path.sep)) throw new Error("invalid storage path");
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, full);
  }

  async putIfAbsent(key: string, data: Buffer): Promise<boolean> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    try {
      // link() fails if the target exists, so the complete file appears at once, and only if there was none.
      await link(tmp, full);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
