import { describe, expect, it } from "vitest";
import { clampView, pinchTo, touchToPhoto } from "../src/zoom";

const base = { w: 200, h: 400 }; // a tall photo, fitted
const area = { w: 400, h: 400 };
const start = { zoom: 1, x: 0, y: 0 };

describe("pinch to zoom on the drawing screen", () => {
  it("at zoom 1 a touch in the middle of the screen is the middle of the photo", () => {
    expect(touchToPhoto(200, 200, start, base, area)).toEqual([0.5, 0.5]);
    expect(touchToPhoto(100, 0, start, base, area)).toEqual([0, 0]);
  });

  it("spreading two fingers zooms in and keeps the spot between them under the fingers", () => {
    const mid: [number, number] = [200, 100];
    const before = touchToPhoto(...mid, start, base, area);
    const v = pinchTo({ start, mid, dist: 100 }, mid, 200, base, area);
    expect(v.zoom).toBe(2);
    const after = touchToPhoto(...mid, v, base, area);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("pinching zooms back out, never smaller than the whole photo or bigger than 5x", () => {
    const zoomed = { zoom: 3, x: 50, y: -80 };
    expect(pinchTo({ start: zoomed, mid: [200, 200], dist: 300 }, [200, 200], 10, base, area)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(pinchTo({ start, mid: [200, 200], dist: 10 }, [200, 200], 1000, base, area).zoom).toBe(5);
  });

  it("two fingers moving together move the zoomed photo, but it can't be dragged off screen", () => {
    const z = { zoom: 2, x: 0, y: 0 };
    const v = pinchTo({ start: z, mid: [200, 200], dist: 100 }, [230, 180], 100, base, area);
    expect(v).toEqual({ zoom: 2, x: 0, y: -20 }); // 400 wide at 2x: no room to move sideways in a 400 area
    expect(clampView({ zoom: 2, x: 0, y: 9999 }, base, area).y).toBe(200);
  });
});
