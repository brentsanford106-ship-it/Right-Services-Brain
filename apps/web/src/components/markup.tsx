import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PhotoMarkup } from "@rsb/contracts";
import {
  COLOR_HEX, MARKUP_COLORS, clampPoint, hitTest, markNames, pinNumbers, primitives, shapeProblem, thinPen, tooSmall,
  type MarkupColor, type MarkupKind, type MarkupShape, type MarkupSize, type Point, type Primitive,
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

/** Where a note box should sit for a shape: next to where the drawing ended, as fractions of the photo. */
function noteAnchor(s: MarkupShape): Point {
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  // Beside the drawing, not on top of it: to its right (or left, near the right edge), below it (or above, near the bottom).
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return [right > 0.6 ? Math.min(...xs) : right, bottom > 0.6 ? Math.min(...ys) : bottom];
}

/**
 * The drawing screen over one photo. Each mark is saved as soon as it's drawn (nothing is lost if the person closes
 * the photo), then a note box pops up next to it. A note becomes a comment about that mark, so it shows in Comments
 * and the person who took the photo gets an alert. Marks that aren't yours (and you can't manage) can't be removed here.
 */
export function MarkupEditor({ photoId, saved, w, h, imageEl, onDone }: {
  photoId: string; saved: PhotoMarkup[]; w: number; h: number; imageEl: React.ReactNode; onDone: () => void;
}) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const [tool, setTool] = useState<MarkupKind | "erase">("circle");
  const [color, setColor] = useState<MarkupColor>("red");
  const [size, setSize] = useState<MarkupSize>(2);
  const [text, setText] = useState("");
  const [live, setLive] = useState<MarkupShape | null>(null);
  const [pending, setPending] = useState<MarkupShape | null>(null); // drawn, being saved
  const [err, setErr] = useState<string | null>(null);
  const [mineThisTime, setMineThisTime] = useState<string[]>([]); // for Undo
  const [noteFor, setNoteFor] = useState<{ id: string; name: string; at: Point; left: boolean; up: boolean } | null>(null);
  const [note, setNote] = useState("");
  const drawing = useRef(false);
  const marks = saved as (PhotoMarkup & MarkupShape)[];
  const names = markNames(marks);

  const errorText = (e: unknown, what: string) =>
    e instanceof ApiRequestError && e.status === 403 ? "You don't have permission to draw on this photo." : `Couldn't ${what}. Check your connection and try again.`;
  const send = (body: { add: (MarkupShape & { clientRef: string })[]; remove: string[] }) =>
    api<{ items: PhotoMarkup[]; added?: { clientRef: string; id: string }[] }>(`/v1/orgs/${orgId}/photos/${photoId}/markups/changes`, { method: "POST", body });
  const afterChange = async (r: { items: PhotoMarkup[] }) => {
    qc.setQueryData(markupKey(orgId, photoId), r);
    await qc.invalidateQueries({ queryKey: [orgId], predicate: (q) => q.queryKey[1] !== "markups" });
  };

  const add = useMutation({
    mutationFn: (shape: MarkupShape) => {
      const clientRef = crypto.randomUUID();
      return send({ add: [{ ...shape, label: shape.label ?? null, clientRef }], remove: [] }).then((r) => ({ r, clientRef, shape }));
    },
    onSuccess: async ({ r, clientRef, shape }) => {
      setPending(null);
      setErr(null);
      const id = r.added?.find((a) => a.clientRef === clientRef)?.id ?? r.items[r.items.length - 1]?.id;
      if (id) {
        setMineThisTime((v) => [...v, id]);
        const i = r.items.findIndex((m) => m.id === id);
        setNote("");
        const at = noteAnchor(shape);
        setNoteFor({ id, name: markNames(r.items as MarkupShape[])[i] ?? "drawing", at, left: Math.max(...shape.points.map((p) => p[0])) > 0.6, up: Math.max(...shape.points.map((p) => p[1])) > 0.6 });
      }
      await afterChange(r);
    },
    onError: (e) => { setPending(null); setErr(errorText(e, "save the drawing")); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => send({ add: [], remove: [id] }).then((r) => ({ r, id })),
    onSuccess: async ({ r, id }) => {
      setErr(null);
      setMineThisTime((v) => v.filter((x) => x !== id));
      if (noteFor?.id === id) setNoteFor(null);
      await afterChange(r);
    },
    onError: (e) => setErr(errorText(e, "remove the drawing")),
  });
  const addNote = useMutation({
    mutationFn: (v: { markupId: string; body: string }) =>
      api(`/v1/orgs/${orgId}/photos/${photoId}/comments`, { method: "POST", body: { clientRef: crypto.randomUUID(), body: v.body, mentionIds: [], parentId: null, markupId: v.markupId } }),
    onSuccess: async () => {
      setErr(null);
      setNoteFor(null);
      setNote("");
      await qc.invalidateQueries({ queryKey: [orgId] });
    },
    onError: (e) => setErr(e instanceof ApiRequestError && e.status === 403 ? "You don't have permission to comment on this photo." : "Couldn't save the note. Check your connection and try again."),
  });
  const busy = add.isPending || remove.isPending || addNote.isPending;

  const commit = (shape: MarkupShape) => {
    const problem = shapeProblem(shape);
    if (problem) return setErr(problem);
    if (tooSmall(shape, w, h)) return;
    setErr(null);
    setPending(shape);
    add.mutate(shape);
  };

  const down = (e: RPointerEvent<SVGSVGElement>) => {
    if (busy) return;
    if (noteFor) setNoteFor(null); // drawing again means "no note" for the last one
    const p = toFraction(e);
    if (tool === "erase") {
      const i = hitTest(marks, p[0] * w, p[1] * h, w, h, Math.max(18, Math.min(w, h) * 0.02));
      const m = marks[i];
      if (!m) return;
      if (!m.canRemove) return setErr("You can only remove your own marks.");
      remove.mutate(m.id);
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
  const lastMine = mineThisTime[mineThisTime.length - 1];

  return (
    <div className="markup-editor">
      <div className="mk-stage">
        {imageEl}
        <MarksSvg marks={marks} w={w} h={h} preview={live ?? pending} highlight={noteFor ? marks.findIndex((m) => m.id === noteFor.id) : undefined}
          cursor={tool === "erase" ? "pointer" : "crosshair"} onPointerDown={down} onPointerMove={move} onPointerUp={up} />
        {noteFor && (
          <form className={`mk-note ${noteFor.left ? "left" : ""} ${noteFor.up ? "up" : ""}`} role="dialog" aria-label={`Note for the ${noteFor.name}`}
            style={{ left: `${noteFor.at[0] * 100}%`, top: `${noteFor.at[1] * 100}%` }}
            onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate({ markupId: noteFor.id, body: note.trim() }); }}>
            <label className="small"><strong>Note for the {noteFor.name}</strong> <span className="muted">(saved)</span></label>
            <textarea aria-label={`Note for the ${noteFor.name}`} autoFocus rows={3} maxLength={4000} placeholder="What should be done here?" value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } if (e.key === "Escape") setNoteFor(null); }} />
            <div className="mk-group">
              <button type="submit" className="primary" disabled={!note.trim() || addNote.isPending}>{addNote.isPending ? "Saving…" : "Add note"}</button>
              <button type="button" onClick={() => setNoteFor(null)}>No note</button>
              <button type="button" disabled={busy} onClick={() => remove.mutate(noteFor.id)}>Remove drawing</button>
            </div>
            <p className="muted small">The note goes in Comments, and whoever took the photo gets an alert.</p>
          </form>
        )}
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
          <button onClick={() => lastMine && remove.mutate(lastMine)} disabled={!lastMine || busy} aria-label="Undo">↶ Undo</button>
          <button className="primary" disabled={busy} onClick={onDone}>Done</button>
        </div>
        {(add.isPending || remove.isPending) && <p className="muted small" role="status">Saving…</p>}
        {err && <p className="error small" role="alert">{err}</p>}
        <p className="muted small">Click and drag to draw. Each drawing is saved straight away. The photo itself never changes.</p>
      </div>
    </div>
  );
}
