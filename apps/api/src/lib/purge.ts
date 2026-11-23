import type { FastifyBaseLogger } from "fastify";
import type { Database, Tx } from "./db.js";
import type { ObjectStorage } from "../storage/types.js";

/**
 * Permanently removes one photo that is already in Recently Deleted, inside the current
 * company's transaction. Returns null if it isn't there (already purged, restored, or
 * not in this company). The caller deletes the files AFTER the transaction commits, so a
 * rolled-back purge never loses a file.
 */
export async function purgeDeletedPhoto(tx: Tx, photoId: string): Promise<{ jobId: string; keys: string[] } | null> {
  const { rows } = await tx.query<{ job_id: string; storage_key: string | null; preview_storage_key: string | null }>(
    "SELECT job_id, storage_key, preview_storage_key FROM app.purge_deleted_photo($1)",
    [photoId],
  );
  const r = rows[0];
  if (!r) return null;
  // The gallery thumbnail sits next to the preview (see thumbKeyFor in routes/photos.ts).
  const thumb = r.preview_storage_key ? r.preview_storage_key.replace(/\/preview$/, "/thumb") : null;
  return { jobId: r.job_id, keys: [r.storage_key, r.preview_storage_key, thumb].filter((k): k is string => !!k) };
}

/** Deletes stored files; failures are logged (without the key's contents) and never thrown. */
export async function removeFiles(storage: ObjectStorage, keys: string[], log: FastifyBaseLogger): Promise<void> {
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (e) {
      log.error({ errName: (e as Error).name }, "failed to delete a purged photo file; it will need manual clean-up");
    }
  }
}

/**
 * Removes every deleted photo that is past its company's keep time (Settings > Recently Deleted).
 * Each photo is removed inside its own company's context and audited as `photo.purged`.
 */
export async function purgeExpiredPhotos(db: Database, storage: ObjectStorage, log: FastifyBaseLogger, batch = 200): Promise<number> {
  const due = await db.anonymous(async (tx) => {
    const { rows } = await tx.query<{ organization_id: string; photo_id: string }>(
      "SELECT organization_id, photo_id FROM app.photos_past_retention($1)",
      [batch],
    );
    return rows;
  });
  let purged = 0;
  for (const d of due) {
    const done = await db.asSystemInOrg(d.organization_id, async (tx) => {
      const { rows: o } = await tx.query<{ days: number }>("SELECT deleted_photo_retention_days AS days FROM organizations WHERE id = $1", [d.organization_id]);
      const res = await purgeDeletedPhoto(tx, d.photo_id);
      if (!res) return null;
      await tx.query(
        `INSERT INTO audit_events (organization_id, actor_user_id, actor_membership_id, action, outcome, target_type, target_id, request_id, metadata)
         VALUES ($1, NULL, NULL, 'photo.purged', 'success', 'photo', $2, 'scheduled-cleanup', $3)`,
        [d.organization_id, d.photo_id, { jobId: res.jobId, trigger: "retention", keepDays: o[0]?.days ?? null }],
      );
      return res;
    });
    if (done) {
      purged++;
      await removeFiles(storage, done.keys, log);
    }
  }
  if (purged) log.info({ purged }, "removed photos past their Recently Deleted keep time");
  return purged;
}

/** Runs the clean-up shortly after start-up and then every `everyMs`. Returns a stop function. */
export function startPurgeSchedule(db: Database, storage: ObjectStorage, log: FastifyBaseLogger, everyMs = 60 * 60 * 1000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await purgeExpiredPhotos(db, storage, log);
    } catch (e) {
      log.error({ errName: (e as Error).name }, "Recently Deleted clean-up failed; will retry next hour");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), everyMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
