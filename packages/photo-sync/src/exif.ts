/**
 * Reads when a photo was taken from its EXIF details (as the photo library gives them).
 * Returns null when the file doesn't say, or says something impossible, so the app can mark the date as unknown
 * instead of guessing. Never returns a date in the future.
 */
export function dateTakenFromExif(exif: Record<string, unknown> | null | undefined, now = Date.now()): string | null {
  if (!exif) return null;
  // iOS nests the EXIF block under "{Exif}"; other platforms put the keys at the top level.
  const nested = (exif["{Exif}"] ?? null) as Record<string, unknown> | null;
  const pick = (k: string): string | null => {
    const v = nested?.[k] ?? exif[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const raw = pick("DateTimeOriginal") ?? pick("DateTimeDigitized");
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const offset = pick("OffsetTimeOriginal") ?? pick("OffsetTime");
  let ms: number;
  const om = offset ? /^([+-])(\d{2}):?(\d{2})$/.exec(offset) : null;
  if (om) {
    const sign = om[1] === "-" ? -1 : 1;
    ms = Date.UTC(y, mo - 1, d, h, mi, s) - sign * (Number(om[2]) * 60 + Number(om[3])) * 60_000;
  } else {
    // No time zone in the file: it's the phone's local time when the photo was taken.
    ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  if (!Number.isFinite(ms) || ms > now + 5 * 60_000) return null;
  return new Date(ms).toISOString();
}
