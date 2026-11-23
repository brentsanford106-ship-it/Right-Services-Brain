/**
 * Drawing on photos: the shape data and how to draw it. Shared by the website, the phone and (later) the server's
 * "annotated copy" export, so a mark looks the same everywhere. No platform imports.
 *
 * Points are fractions (0 to 1) of the upright photo, so marks stay in place at any screen size or zoom.
 * The photo file itself is never changed.
 */

export const MARKUP_KINDS = ["circle", "arrow", "pen", "rect", "text", "pin"] as const;
export type MarkupKind = (typeof MARKUP_KINDS)[number];
export const MARKUP_COLORS = ["red", "yellow", "green", "blue", "white", "black"] as const;
export type MarkupColor = (typeof MARKUP_COLORS)[number];
export type MarkupSize = 1 | 2 | 3;
export type Point = [number, number];

export const COLOR_HEX: Record<MarkupColor, string> = {
  red: "#E53935", yellow: "#FDD835", green: "#43A047", blue: "#1E88E5", white: "#FFFFFF", black: "#111111",
};
export const KIND_LABELS: Record<MarkupKind, string> = {
  circle: "circle", arrow: "arrow", pen: "pen line", rect: "box", text: "text", pin: "pin",
};
export const LABEL_MAX = 200;
export const PEN_MAX_POINTS = 2000;

/** One mark as drawn (before or after saving). */
export interface MarkupShape {
  kind: MarkupKind;
  color: MarkupColor;
  size: MarkupSize;
  points: Point[];
  label?: string | null;
}

/** A saved mark as the server returns it. */
export interface SavedMarkup extends MarkupShape {
  id: string;
  authorId: string;
  author: string;
  createdAt: string;
  mine: boolean;
  canRemove: boolean;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
export const clampPoint = (p: Point): Point => [clamp01(p[0]), clamp01(p[1])];

/** Checks a mark before it is saved. Returns a plain-language problem, or null when it's fine. */
export function shapeProblem(s: MarkupShape): string | null {
  if (!MARKUP_KINDS.includes(s.kind)) return "Unknown kind of mark.";
  if (!MARKUP_COLORS.includes(s.color)) return "Unknown color.";
  if (![1, 2, 3].includes(s.size)) return "Unknown size.";
  if (!Array.isArray(s.points) || s.points.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1))) {
    return "Marks must stay on the photo.";
  }
  const need = s.kind === "pen" ? [2, PEN_MAX_POINTS] : s.kind === "text" || s.kind === "pin" ? [1, 1] : [2, 2];
  if (s.points.length < need[0]! || s.points.length > need[1]!) return `A ${KIND_LABELS[s.kind]} needs ${need[0] === need[1] ? need[0] : `${need[0]} to ${need[1]}`} point${need[1] === 1 ? "" : "s"}.`;
  const label = s.label?.trim() ?? "";
  if (s.kind === "text" && !label) return "Type the text first.";
  if (label.length > LABEL_MAX) return `Text can be up to ${LABEL_MAX} characters.`;
  if (s.kind !== "text" && s.kind !== "pin" && label) return "Only text and pins have words.";
  return null;
}

/** "red circle", "yellow pin 2" */
export function describeMark(s: MarkupShape, pinNumber?: number): string {
  return `${s.color} ${KIND_LABELS[s.kind]}${s.kind === "pin" && pinNumber ? ` ${pinNumber}` : ""}`;
}

/** Pins are numbered in the order they were added. */
export function pinNumbers(shapes: readonly { kind: MarkupKind }[]): (number | null)[] {
  let n = 0;
  return shapes.map((s) => (s.kind === "pin" ? ++n : null));
}

// ----------------------------------------------------------------- drawing (in pixels of the displayed photo)

/** Basic drawing pieces, easy to turn into SVG on any platform. */
export type Primitive =
  | { t: "ellipse"; cx: number; cy: number; rx: number; ry: number; stroke: string; sw: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; stroke: string; sw: number }
  | { t: "path"; d: string; stroke: string; sw: number; fill?: string }
  | { t: "circleFill"; cx: number; cy: number; r: number; fill: string; stroke: string; sw: number }
  | { t: "text"; x: number; y: number; text: string; size: number; fill: string; outline: string; anchor: "start" | "middle"; bold: boolean };

const SW = [0.005, 0.009, 0.015];
export const strokeWidth = (size: MarkupSize, w: number, h: number) => Math.max(2, Math.min(w, h) * SW[size - 1]!);
const outlineFor = (color: MarkupColor) => (color === "white" || color === "yellow" ? "#000000" : "#FFFFFF");
const fmt = (n: number) => Math.round(n * 10) / 10;

/** The drawing pieces for one mark on a photo shown at w x h pixels. */
export function primitives(s: MarkupShape, w: number, h: number, pinNumber?: number | null): Primitive[] {
  const stroke = COLOR_HEX[s.color];
  const sw = strokeWidth(s.size, w, h);
  const px = s.points.map(([x, y]) => [x * w, y * h] as Point);
  const base = Math.min(w, h);
  switch (s.kind) {
    case "circle": {
      const [[x1, y1], [x2, y2]] = px as [Point, Point];
      return [{ t: "ellipse", cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.abs(x2 - x1) / 2, ry: Math.abs(y2 - y1) / 2, stroke, sw }];
    }
    case "rect": {
      const [[x1, y1], [x2, y2]] = px as [Point, Point];
      return [{ t: "rect", x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), stroke, sw }];
    }
    case "arrow": {
      const [[x1, y1], [x2, y2]] = px as [Point, Point];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const head = Math.min(len * 0.45, Math.max(sw * 4, base * 0.04));
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const wing = (a: number) => [x2 - head * Math.cos(ang + a), y2 - head * Math.sin(ang + a)] as Point;
      const [l, r] = [wing(Math.PI / 7), wing(-Math.PI / 7)];
      return [
        { t: "path", d: `M${fmt(x1)} ${fmt(y1)} L${fmt(x2)} ${fmt(y2)}`, stroke, sw },
        { t: "path", d: `M${fmt(l[0])} ${fmt(l[1])} L${fmt(x2)} ${fmt(y2)} L${fmt(r[0])} ${fmt(r[1])} Z`, stroke, sw, fill: stroke },
      ];
    }
    case "pen":
      return [{ t: "path", d: px.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)} ${fmt(y)}`).join(" "), stroke, sw }];
    case "text": {
      const [[x, y]] = px as [Point];
      const size = base * [0.035, 0.05, 0.07][s.size - 1]!;
      return [{ t: "text", x, y, text: s.label ?? "", size, fill: stroke, outline: outlineFor(s.color), anchor: "start", bold: true }];
    }
    case "pin": {
      const [[x, y]] = px as [Point];
      const r = base * [0.022, 0.03, 0.04][s.size - 1]!;
      const out: Primitive[] = [
        { t: "circleFill", cx: x, cy: y, r, fill: stroke, stroke: outlineFor(s.color), sw: Math.max(1.5, r * 0.15) },
        { t: "text", x, y: y + r * 0.38, text: String(pinNumber ?? ""), size: r * 1.1, fill: outlineFor(s.color), outline: stroke, anchor: "middle", bold: true },
      ];
      if (s.label) out.push({ t: "text", x: x + r * 1.4, y: y + r * 0.38, text: s.label, size: r * 1.1, fill: stroke, outline: outlineFor(s.color), anchor: "start", bold: true });
      return out;
    }
  }
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A complete SVG of all marks at w x h, for an annotated copy (the server lays it over a copy of the photo). */
export function marksToSvg(shapes: MarkupShape[], w: number, h: number): string {
  const nums = pinNumbers(shapes);
  const parts = shapes.flatMap((s, i) => primitives(s, w, h, nums[i])).map((p) => {
    switch (p.t) {
      case "ellipse": return `<ellipse cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" rx="${fmt(p.rx)}" ry="${fmt(p.ry)}" fill="none" stroke="${p.stroke}" stroke-width="${fmt(p.sw)}"/>`;
      case "rect": return `<rect x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(p.w)}" height="${fmt(p.h)}" fill="none" stroke="${p.stroke}" stroke-width="${fmt(p.sw)}"/>`;
      case "path": return `<path d="${p.d}" fill="${p.fill ?? "none"}" stroke="${p.stroke}" stroke-width="${fmt(p.sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      case "circleFill": return `<circle cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" r="${fmt(p.r)}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${fmt(p.sw)}"/>`;
      case "text": return `<text x="${fmt(p.x)}" y="${fmt(p.y)}" font-family="Helvetica, Arial, sans-serif" font-size="${fmt(p.size)}" font-weight="${p.bold ? 700 : 400}" text-anchor="${p.anchor}" fill="${p.fill}" stroke="${p.outline}" stroke-width="${fmt(p.size * 0.12)}" paint-order="stroke">${esc(p.text)}</text>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

// ----------------------------------------------------------------- editing

/** Distance (pixels) from a tap to a mark, for "tap a mark to select it". */
export function distanceTo(s: MarkupShape, x: number, y: number, w: number, h: number): number {
  const px = s.points.map(([a, b]) => [a * w, b * h] as Point);
  const seg = (a: Point, b: Point) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  };
  if (s.kind === "text" || s.kind === "pin") return Math.hypot(x - px[0]![0], y - px[0]![1]) - Math.min(w, h) * 0.03;
  if (s.kind === "pen" || s.kind === "arrow") return Math.min(...px.slice(1).map((p, i) => seg(px[i]!, p)));
  const [[x1, y1], [x2, y2]] = px as [Point, Point];
  if (s.kind === "rect") {
    const c: Point[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    return Math.min(...c.map((p, i) => seg(p, c[(i + 1) % 4]!)));
  }
  // ellipse: distance from the outline, approximately
  const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, Math.abs(x2 - x1) / 2), Math.max(1, Math.abs(y2 - y1) / 2)];
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return Math.abs(k - 1) * Math.min(rx, ry);
}

/** The mark nearest to a tap (within reach), or -1. Later marks win ties, like the drawing order. */
export function hitTest(shapes: MarkupShape[], x: number, y: number, w: number, h: number, reach = 18): number {
  let best = -1;
  let bestD = reach;
  shapes.forEach((s, i) => {
    const d = distanceTo(s, x, y, w, h);
    if (d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

/** Thins a pen line: drops points closer than `minGap` pixels to the last kept one (keeps the last point). */
export function thinPen(points: Point[], w: number, h: number, minGap = 3): Point[] {
  if (points.length <= 2) return points;
  const out: Point[] = [points[0]!];
  for (const p of points.slice(1, -1)) {
    const last = out[out.length - 1]!;
    if (Math.hypot((p[0] - last[0]) * w, (p[1] - last[1]) * h) >= minGap) out.push(p);
  }
  out.push(points[points.length - 1]!);
  return out.slice(0, PEN_MAX_POINTS);
}

/** A two-point mark that is too small to be deliberate (a tap rather than a drag). */
export const tooSmall = (s: MarkupShape, w: number, h: number) =>
  (s.kind === "circle" || s.kind === "rect" || s.kind === "arrow") && s.points.length === 2 &&
  Math.hypot((s.points[1]![0] - s.points[0]![0]) * w, (s.points[1]![1] - s.points[0]![1]) * h) < 8;

/**
 * Undo/redo for one drawing session. Marks already saved can be removed; new marks can be added.
 * `changes()` says what to send when the person taps Save.
 */
export interface DraftMark extends MarkupShape { key: string; savedId: string | null }
type Op = { t: "add"; mark: DraftMark } | { t: "remove"; mark: DraftMark; index: number };

export class MarkupDraft {
  private marks: DraftMark[];
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private removedSaved = new Set<string>();

  constructor(saved: SavedMarkup[], private readonly newKey: () => string) {
    this.marks = saved.map((s) => ({ kind: s.kind, color: s.color, size: s.size, points: s.points, label: s.label ?? null, key: s.id, savedId: s.id }));
  }

  get current(): readonly DraftMark[] {
    return this.marks;
  }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get dirty(): boolean { return this.changes().add.length > 0 || this.changes().remove.length > 0; }

  add(shape: MarkupShape): DraftMark {
    const mark: DraftMark = { ...shape, key: this.newKey(), savedId: null };
    this.apply({ t: "add", mark });
    this.redoStack = [];
    return mark;
  }

  remove(key: string): void {
    const index = this.marks.findIndex((m) => m.key === key);
    if (index < 0) return;
    this.apply({ t: "remove", mark: this.marks[index]!, index });
    this.redoStack = [];
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.t === "add") this.marks = this.marks.filter((m) => m.key !== op.mark.key);
    else {
      this.marks = [...this.marks.slice(0, op.index), op.mark, ...this.marks.slice(op.index)];
      if (op.mark.savedId) this.removedSaved.delete(op.mark.savedId);
    }
    this.redoStack.push(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (op) this.apply(op);
  }

  private apply(op: Op): void {
    if (op.t === "add") this.marks = [...this.marks, op.mark];
    else {
      this.marks = this.marks.filter((m) => m.key !== op.mark.key);
      if (op.mark.savedId) this.removedSaved.add(op.mark.savedId);
    }
    this.undoStack.push(op);
  }

  /** New marks to add (each with its own id so a resend is safe) and saved marks to remove. */
  changes(): { add: (MarkupShape & { clientRef: string })[]; remove: string[] } {
    return {
      add: this.marks.filter((m) => !m.savedId).map(({ key, savedId: _s, ...shape }) => ({ ...shape, label: shape.label ?? null, clientRef: key })),
      remove: [...this.removedSaved],
    };
  }
}

/** "red circle", "yellow pin 2", for each mark in order. */
export function markNames(marks: readonly MarkupShape[]): string[] {
  const nums = pinNumbers(marks);
  return marks.map((m, i) => describeMark(m, nums[i] ?? undefined));
}
