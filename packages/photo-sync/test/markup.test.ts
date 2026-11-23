import { describe, expect, it } from "vitest";
import { MarkupDraft, describeMark, hitTest, marksToSvg, pinNumbers, primitives, shapeProblem, thinPen, tooSmall, type MarkupShape, type SavedMarkup } from "../src/index";

const circle: MarkupShape = { kind: "circle", color: "red", size: 2, points: [[0.1, 0.1], [0.3, 0.5]] };
let n = 0;
const key = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe("drawing on photos", () => {
  it("checks marks before saving: on the photo, right number of points, words only on text and pins", () => {
    expect(shapeProblem(circle)).toBeNull();
    expect(shapeProblem({ ...circle, points: [[0.1, 0.1], [1.2, 0.5]] })).toMatch(/stay on the photo/);
    expect(shapeProblem({ ...circle, points: [[0.1, 0.1]] })).toMatch(/needs 2/);
    expect(shapeProblem({ kind: "text", color: "red", size: 1, points: [[0.5, 0.5]], label: "  " })).toMatch(/Type the text/);
    expect(shapeProblem({ kind: "pin", color: "red", size: 1, points: [[0.5, 0.5]] })).toBeNull();
    expect(shapeProblem({ ...circle, label: "hi" })).toMatch(/Only text and pins/);
    expect(shapeProblem({ ...circle, color: "pink" as never })).toMatch(/color/);
    expect(shapeProblem({ kind: "pen", color: "red", size: 1, points: Array.from({ length: 2001 }, () => [0.5, 0.5]) })).toMatch(/2 to 2000/);
  });

  it("draws in pixels of the shown photo, so marks stay in place at any size", () => {
    const [e] = primitives(circle, 1000, 500);
    expect(e).toMatchObject({ t: "ellipse", cx: 200, cy: 150, rx: 100, ry: 100 });
    const [e2] = primitives(circle, 2000, 1000);
    expect(e2).toMatchObject({ cx: 400, cy: 300, rx: 200, ry: 200 });
    const arrow = primitives({ kind: "arrow", color: "blue", size: 1, points: [[0, 0], [0.5, 0.5]] }, 100, 100);
    expect(arrow).toHaveLength(2); // the line and its head
  });

  it("numbers pins in order and names marks plainly", () => {
    const shapes: MarkupShape[] = [circle, { kind: "pin", color: "yellow", size: 1, points: [[0.2, 0.2]] }, { kind: "pin", color: "red", size: 1, points: [[0.4, 0.2]] }];
    expect(pinNumbers(shapes)).toEqual([null, 1, 2]);
    expect(describeMark(shapes[2]!, 2)).toBe("red pin 2");
    expect(describeMark(circle)).toBe("red circle");
  });

  it("makes a safe SVG for an annotated copy (typed words can't inject anything)", () => {
    const svg = marksToSvg([{ kind: "text", color: "white", size: 2, points: [[0.1, 0.1]], label: `<script>alert("x")</script> & fix` }], 800, 600);
    expect(svg).toContain('width="800" height="600"');
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("finds the mark nearest a tap", () => {
    const shapes: MarkupShape[] = [circle, { kind: "rect", color: "green", size: 1, points: [[0.6, 0.6], [0.9, 0.9]] }];
    expect(hitTest(shapes, 200, 50, 1000, 500)).toBe(0); // top of the circle's outline
    expect(hitTest(shapes, 600, 400, 1000, 500)).toBe(1); // left edge of the box
    expect(hitTest(shapes, 500, 100, 1000, 500)).toBe(-1);
  });

  it("thins pen lines and ignores a tap that was meant as a drag", () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i / 1000, 0.5] as [number, number]);
    expect(thinPen(pts, 1000, 1000).length).toBeLessThan(40);
    expect(tooSmall({ ...circle, points: [[0.5, 0.5], [0.501, 0.5]] }, 1000, 1000)).toBe(true);
    expect(tooSmall(circle, 1000, 1000)).toBe(false);
  });

  it("undo and redo, and Save sends only what changed", () => {
    const saved: SavedMarkup = { ...circle, id: "s1", authorId: "m", author: "Morgan", createdAt: "", mine: true, canRemove: true };
    const d = new MarkupDraft([saved], key);
    expect(d.dirty).toBe(false);
    const a = d.add({ kind: "arrow", color: "red", size: 2, points: [[0, 0], [0.5, 0.5]] });
    d.remove("s1");
    expect(d.current.map((m) => m.key)).toEqual([a.key]);
    expect(d.changes()).toEqual({ add: [expect.objectContaining({ kind: "arrow", clientRef: a.key })], remove: ["s1"] });
    d.undo(); // brings back the saved circle
    expect(d.current.map((m) => m.key)).toEqual(["s1", a.key]);
    expect(d.changes().remove).toEqual([]);
    d.undo(); // removes the arrow
    expect(d.dirty).toBe(false);
    d.redo();
    expect(d.current).toHaveLength(2);
    d.add(circle); // a new mark clears redo
    expect(d.canRedo).toBe(false);
  });
});

describe("drawings still waiting on the phone", () => {
  it("hide marks waiting to be removed and show marks waiting to be added", async () => {
    const { withWaitingMarks } = await import("../src/markup");
    const base = { authorId: "a", author: "A", createdAt: "", mine: true, canRemove: true, color: "red" as const, size: 2 as const, label: null };
    const saved = [{ ...base, id: "s1", kind: "circle" as const, points: [[0.1, 0.1], [0.2, 0.2]] as [number, number][] }, { ...base, id: "s2", kind: "rect" as const, points: [[0.3, 0.3], [0.4, 0.4]] as [number, number][] }];
    const r = withWaitingMarks(saved, [{ body: { add: [{ kind: "arrow", color: "blue", size: 1, points: [[0, 0], [1, 1]], label: null, clientRef: "n1" }], remove: ["s1"] } }], { id: "me", name: "Me" });
    expect(r.marks.map((m) => m.id)).toEqual(["s2", "n1"]);
    expect([...r.waiting]).toEqual(["n1"]);
    expect(r.marks[1]).toMatchObject({ kind: "arrow", color: "blue", canRemove: false });
  });
});
