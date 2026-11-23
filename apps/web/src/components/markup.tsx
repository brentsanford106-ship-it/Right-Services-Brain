import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PhotoMarkup } from "@rsb/contracts";
import {
  COLOR_HEX, MARKUP_COLORS, MarkupDraft, clampPoint, hitTest, markNames, pinNumbers, primitives, shapeProblem, thinPen, tooSmall,
  type MarkupColor, type MarkupKind, type MarkupShape, type MarkupSize, type Point, type Primitive, type SavedMarkup,
} from "@rsb/photo-sync";
import { api, ApiRequestError } from "../lib/api";
import { useOrgId } from "../lib/hooks";

export type { PhotoMarkup };
export const markupKey = (orgId: string, photoId: string) => [orgId, "markups", photoId];

export function useMarks(photoId: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: markupKey(orgId, photoId),
    queryFn: () => api<{ items: PhotoMarkup[] }>(`/v1/orgs/${orgId}/photos/${photoId}/markups`),
    enabled,
  });
}

export { markNames };

function Prim({ p, highlight }: { p: Primitive; highlight?: boolean }) {
  const glow = highlight ? { filter: "drop-shadow(0 0 6px #fff) drop-shadow(0 0 3px #000)" } : undefined;
  switch (p.t) {
    case "ellipse": return <ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill="none" stroke={p.stroke} strokeWidth={p.sw} style={glow} />;
    case "rect": return <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="none" stroke={p.stroke} strokeWidth={p.sw} style={glow} />;
    case "path": return <path d={p.d} fill={p.fill ?? "none"} stroke={p.stroke} strokeWidth={p.sw} strokeLinecap="round" strokeLinejoin="round" style={glow} />;
    case "circleFill": return <circle cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} style={glow} />;
    case "text":
      return (
        <text x={p.x} y={p.y} fontSize={p.size} fontWeight={p.bold ? 700 : 400} textAnchor={p.anchor} fill={p.fill} stroke={p.outline}
          strokeWidth={p.size * 0.12} paintOrder="stroke" fontFamily="Helvetica, Arial, sans-serif" style={glow}>{p.text}</text>
      );
  }
}

/** All marks, drawn over the photo. `w` x `h` is the photo's own size (the SVG scales with the image). */
export function MarksSvg({ marks, w, h, highlight, preview, onPointerDown, onPointerMove, onPointerUp, cursor }: {
  marks: MarkupShape[]; w: number; h: number; highlight?: number; preview?: MarkupShape | null; cursor?: string;
  onPointerDown?: (e: RPointerEvent<SVGSVGElement>) => void; onPointerMove?: (e: RPointerEvent<SVGSVGElement>) => void; onPointerUp?: (e: RPointerEvent<SVGSVGElement>) => void;
}) {
  const nums = pinNumbers(preview ? [...marks, preview] : marks);
  return (
    <svg className="marks" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`${marks.length} drawing${marks.length === 1 ? "" : "s"} on this photo`} role="img"
      style={{ cursor, pointerEvents: onPointerDown ? "auto" : "none", touchAction: onPointerDown ? "none" : undefined }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {marks.map((m, i) => <g key={i} data-mark={i}>{primitives(m, w, h, nums[i]).map((p, j) => <Prim key={j} p={p} highlight={highlight === i} />)}</g>)}
      {preview ? <g opacity={0.85}>{primitives(preview, w, h, nums[marks.length]).map((p, j) => <Prim key={j} p={p} />)}</g> : null}
    </svg>
  );
}

const TOOLS: { value: MarkupKind | "erase"; label: string; title: string }[] = [
  { value: "circle", label: "◯", title: "Circle" },
  { value: "arrow", label: "➜", title: "Arrow" },
  { value: "pen", label: "✎", title: "Pen" },
  { value: "rect", label: "▭", title: "Box" },
  { value: "text", label: "T", title: "Text" },
  { value: "pin", label: "📍", title: "Numbered pin" },
  { value: "erase", label: "⌫", title: "Remove a mark (click it)" },
];
const SIZES: { value: MarkupSize; label: string }[] = [{ value: 1, label: "Thin" }, { value: 2, label: "Medium" }, { value: 3, label: "Thick" }];

/** Where a pointer is on the photo, as fractions (works at any zoom: the box already includes it). */
function toFraction(e: { clientX: number; clientY: number; currentTarget: Element }): Point {
  const r = e.currentTarget.getBoundingClientRect();
  return clampPoint([(e.clientX - r.left) / (r.width || 1), (e.clientY - r.top) / (r.height || 1)]);
}

/**
 * The drawing screen over one photo. Marks are only sent when the person taps Save; Cancel throws the session away.
 * Saved marks that aren't yours (and you can't manage) can't be removed here.
 */
export function MarkupEditor({ photoId, saved, w, h, imageEl, onDone }: {
  photoId: string; saved: PhotoMarkup[]; w: number; h: number; imageEl: React.ReactNode; onDone: () => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // Made once per drawing session, so a refresh in the background can't wipe what's being drawn.
  const [draft] = useState(() => new MarkupDraft(saved as SavedMarkup[], () => crypto.randomUUID()));
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const [tool, setTool] = useState<MarkupKind | "erase">("circle");
  const [color, setColor] = useState<MarkupColor>("red");
  const [size, setSize] = useState<MarkupSize>(2);
  const [text, setText] = useState("");
  const [live, setLive] = useState<MarkupShape | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const drawing = useRef(false);
  const removable = new Set(saved.filter((m) => m.canRemove).map((m) => m.id));

  const save = useMutation({
    mutationFn: () => api<{ items: PhotoMarkup[] }>(`/v1/orgs/${orgId}/photos/${photoId}/markups/changes`, { method: "POST", body: draft.changes() }),
    onSuccess: async (r) => {
      qc.setQueryData(markupKey(orgId, photoId), r);
      await qc.invalidateQueries({ queryKey: [orgId] });
      onDone();
    },
    onError: (e) => setErr(e instanceof ApiRequestError && e.status === 403 ? "You don't have permission to draw on this photo." : "Couldn't save the drawing. Check your connection and try again."),
  });

  const commit = (shape: MarkupShape) => {
    const problem = shapeProblem(shape);
    if (problem) return setErr(problem);
    if (tooSmall(shape, w, h)) return;
    setErr(null);
    draft.add(shape);
    rerender();
  };

  const down = (e: RPointerEvent<SVGSVGElement>) => {
    const p = toFraction(e);
    if (tool === "erase") {
      const i = hitTest([...draft.current] as MarkupShape[], p[0] * w, p[1] * h, w, h, Math.max(18, Math.min(w, h) * 0.02));
      const m = draft.current[i];
      if (!m) return;
      if (m.savedId && !removable.has(m.savedId)) return setErr("You can only remove your own marks.");
      draft.remove(m.key);
      rerender();
      return;
    }
    if (tool === "text" || tool === "pin") {
      commit({ kind: tool, color, size, points: [p], label: text.trim() || null });
      if (tool === "text") setText("");
      return;
    }
    drawing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setLive({ kind: tool, color, size, points: [p, p] });
  };
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drawing.current || !live) return;
    const p = toFraction(e);
    setLive(live.kind === "pen" ? { ...live, points: [...live.points, p] } : { ...live, points: [live.points[0]!, p] });
  };
  const up = () => {
    if (!drawing.current || !live) return;
    drawing.current = false;
    commit(live.kind === "pen" ? { ...live, points: thinPen(live.points, w, h) } : live);
    setLive(null);
  };

  const cancel = () => {
    if (draft.dirty && !window.confirm("Throw away the changes to this drawing?")) return;
    onDone();
  };

  return (
    <div className="markup-editor">
      <div className="mk-stage">
        {imageEl}
        <MarksSvg marks={[...draft.current] as MarkupShape[]} w={w} h={h} preview={live} cursor={tool === "erase" ? "pointer" : "crosshair"} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      </div>
      <div className="mk-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="mk-group">
          {TOOLS.map((t) => (
            <button key={t.value} className={`chip ${tool === t.value ? "on" : ""}`} aria-pressed={tool === t.value} title={t.title} aria-label={t.title} onClick={() => setTool(t.value)}>{t.label}</button>
          ))}
        </div>
        <div className="mk-group" role="radiogroup" aria-label="Color">
          {MARKUP_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={color === c} aria-label={c} title={c} className={`swatch ${color === c ? "on" : ""}`} style={{ background: COLOR_HEX[c] }} onClick={() => setColor(c)} />
          ))}
        </div>
        <select aria-label="Line size" value={size} onChange={(e) => setSize(Number(e.target.value) as MarkupSize)}>
          {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {(tool === "text" || tool === "pin") && (
          <input aria-label={tool === "text" ? "Text to place" : "Pin label (optional)"} placeholder={tool === "text" ? "Type, then click the photo" : "Optional label, then click"} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <div className="mk-group">
          <button onClick={() => { draft.undo(); rerender(); }} disabled={!draft.canUndo} aria-label="Undo">↶ Undo</button>
          <button onClick={() => { draft.redo(); rerender(); }} disabled={!draft.canRedo} aria-label="Redo">↷ Redo</button>
        </div>
        <div className="mk-group">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" disabled={!draft.dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save drawing"}</button>
        </div>
        {err && <p className="error small" role="alert">{err}</p>}
        <p className="muted small">Drawings are saved separately. The photo itself never changes.</p>
      </div>
    </div>
  );
}
