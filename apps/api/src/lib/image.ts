import { createHash } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "./errors.js";

sharp.cache(false);

const MAX_PIXELS = 50_000_000; // decompression-bomb guard
const PREVIEW_EDGE = 2048;
const THUMB_EDGE = 480;

export type ImageType = "image/jpeg" | "image/png" | "image/heic";

export interface ProcessedUpload {
  originalSha256: string;
  /** Re-encoded, metadata-free JPEG for everyday viewing. null if the format can't be decoded here (e.g. HEIC). */
  preview: { data: Buffer; width: number; height: number } | null;
  /** Small JPEG for gallery grids (made from the preview, so also metadata-free). null when there is no preview. */
  thumb: Buffer | null;
}

/** Detects the real file type from its first bytes. The declared type and file name are never trusted. */
export function sniff(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Validates an uploaded original WITHOUT modifying it, and builds a separate preview:
 *  1. Real type must match the declared type.
 *  2. JPEG/PNG must fully decode within a pixel limit (rejects corrupt files and decompression bombs).
 *  3. The preview is re-encoded, which discards embedded metadata (EXIF incl. GPS), scripts,
 *     trailing data and polyglot payloads. The original is kept byte-for-byte for record keeping.
 */
export async function processUpload(buf: Buffer, declaredType: string): Promise<ProcessedUpload> {
  const actual = sniff(buf);
  if (!actual || actual !== declaredType) {
    throw new HttpError("validation_failed", "The file is not a valid image of the declared type.");
  }
  const originalSha256 = sha256(buf);
  if (actual === "image/heic") {
    // HEIC decoding isn't available in the server image library; the original is kept and a preview is created in a later phase.
    return { originalSha256, preview: null, thumb: null };
  }
  try {
    const out = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: "error", animated: false })
      .rotate()
      .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(out.data, { failOn: "error" })
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { originalSha256, preview: { data: out.data, width: out.info.width, height: out.info.height }, thumb };
  } catch {
    throw new HttpError("validation_failed", "The image could not be read.");
  }
}
