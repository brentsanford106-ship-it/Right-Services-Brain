import { describe, expect, it } from "vitest";
import { dateTakenFromExif } from "../src/index";

const NOW = Date.parse("2026-11-23T12:00:00Z");

describe("date taken, from a library photo's details", () => {
  it("uses the date and time zone the camera recorded (iOS layout)", () => {
    expect(dateTakenFromExif({ "{Exif}": { DateTimeOriginal: "2026:06:01 08:30:00", OffsetTimeOriginal: "-04:00" } }, NOW)).toBe("2026-06-01T12:30:00.000Z");
  });
  it("accepts the flat layout and the digitized time", () => {
    expect(dateTakenFromExif({ DateTimeDigitized: "2025:01:02 03:04:05", OffsetTime: "+0100" }, NOW)).toBe("2025-01-02T02:04:05.000Z");
  });
  it("without a time zone, reads it as this phone's local time", () => {
    expect(dateTakenFromExif({ DateTimeOriginal: "2026:06:01 08:30:00" }, NOW)).toBe(new Date(2026, 5, 1, 8, 30, 0).toISOString());
  });
  it("says unknown when there's no date, a broken date, or a date in the future", () => {
    expect(dateTakenFromExif(null, NOW)).toBeNull();
    expect(dateTakenFromExif({}, NOW)).toBeNull();
    expect(dateTakenFromExif({ DateTimeOriginal: "0000:00:00 00:00:00" }, NOW)).toBeNull();
    expect(dateTakenFromExif({ DateTimeOriginal: "yesterday" }, NOW)).toBeNull();
    expect(dateTakenFromExif({ DateTimeOriginal: "2027:01:01 00:00:00", OffsetTimeOriginal: "+00:00" }, NOW)).toBeNull();
  });
});
