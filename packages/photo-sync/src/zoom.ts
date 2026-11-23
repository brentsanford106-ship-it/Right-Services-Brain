/**
 * Pinch-to-zoom maths for the phone's drawing screen. Plain numbers, so it can be tested without a phone.
 *
 * The photo is shown centred in an area of `area` size. At zoom 1 it is `base` size (the whole photo fits).
 * `offset` moves the photo's centre away from the area's centre. All points are relative to the area's top-left.
 */
export interface Size { w: number; h: number }
export interface View { zoom: number; x: number; y: number }
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** Keep the photo from being dragged off screen: when it's bigger than the area its edges can't come inside it. */
export function clampView(v: View, base: Size, area: Size): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
  const mx = Math.max(0, (base.w * zoom - area.w) / 2);
  const my = Math.max(0, (base.h * zoom - area.h) / 2);
  return { zoom, x: Math.min(mx, Math.max(-mx, v.x)) + 0, y: Math.min(my, Math.max(-my, v.y)) + 0 }; // + 0 turns -0 into 0
}

/** The photo's top-left corner in the area, and its size on screen. */
export function photoRect(v: View, base: Size, area: Size) {
  const w = base.w * v.zoom;
  const h = base.h * v.zoom;
  return { left: area.w / 2 + v.x - w / 2, top: area.h / 2 + v.y - h / 2, w, h };
}

/** Where a touch is on the photo, as fractions (0 to 1 across and down). */
export function touchToPhoto(px: number, py: number, v: View, base: Size, area: Size): [number, number] {
  const r = photoRect(v, base, area);
  return [(px - r.left) / (r.w || 1), (py - r.top) / (r.h || 1)];
}

export interface Pinch { start: View; mid: [number, number]; dist: number }

/** Two fingers moved: zoom by how far apart they are now, keep the spot between them under the fingers, and follow them. */
export function pinchTo(p: Pinch, mid: [number, number], dist: number, base: Size, area: Size): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, p.start.zoom * (dist / (p.dist || 1))));
  // The spot under the fingers when the pinch started, measured from the photo's centre at zoom 1.
  const sx = (p.mid[0] - area.w / 2 - p.start.x) / p.start.zoom;
  const sy = (p.mid[1] - area.h / 2 - p.start.y) / p.start.zoom;
  return clampView({ zoom, x: mid[0] - area.w / 2 - sx * zoom, y: mid[1] - area.h / 2 - sy * zoom }, base, area);
}

export const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const midpoint = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
