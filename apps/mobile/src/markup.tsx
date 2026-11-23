import React, { useCallback, useEffect, useState } from "react";
import Svg, { Circle, Ellipse, G, Path, Rect, Text as SvgText } from "react-native-svg";
import { markNames, pinNumbers, primitives, type MarkupShape, type Primitive, type SavedMarkup } from "@rsb/photo-sync";
import { useApp } from "./state";

export { markNames };

/** Where a photo of imgW x imgH actually shows inside a box when it is fitted ("contain"). */
export function fitRect(boxW: number, boxH: number, imgW: number, imgH: number) {
  if (!boxW || !boxH || !imgW || !imgH) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function Prim({ p, glow }: { p: Primitive; glow?: boolean }) {
  const extra = glow ? { strokeOpacity: 1, opacity: 1 } : {};
  switch (p.t) {
    case "ellipse": return <Ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill="none" stroke={p.stroke} strokeWidth={glow ? p.sw * 1.8 : p.sw} {...extra} />;
    case "rect": return <Rect x={p.x} y={p.y} width={p.w} height={p.h} fill="none" stroke={p.stroke} strokeWidth={glow ? p.sw * 1.8 : p.sw} />;
    case "path": return <Path d={p.d} fill={p.fill ?? "none"} stroke={p.stroke} strokeWidth={glow ? p.sw * 1.8 : p.sw} strokeLinecap="round" strokeLinejoin="round" />;
    case "circleFill": return <Circle cx={p.cx} cy={p.cy} r={glow ? p.r * 1.2 : p.r} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} />;
    case "text":
      return (
        <SvgText x={p.x} y={p.y} fontSize={p.size} fontWeight={p.bold ? "700" : "400"} textAnchor={p.anchor} fill={p.fill}
          stroke={p.outline} strokeWidth={p.size * 0.06}>{p.text}</SvgText>
      );
  }
}

/**
 * The marks drawn over a photo. Give it the photo's own size (`w` x `h`) and the size it shows at on screen;
 * the drawing scales to match. Doesn't take touches (the screen handles them).
 */
export function MarksLayer({ marks, w, h, width, height, highlight, preview }: {
  marks: readonly MarkupShape[]; w: number; h: number; width: number; height: number; highlight?: number; preview?: MarkupShape | null;
}) {
  const all = preview ? [...marks, preview] : [...marks];
  const nums = pinNumbers(all);
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0 }}>
      {all.map((m, i) => (
        <G key={i} opacity={preview && i === all.length - 1 ? 0.85 : 1}>
          {primitives(m, w, h, nums[i]).map((p, j) => <Prim key={j} p={p} glow={highlight === i} />)}
        </G>
      ))}
    </Svg>
  );
}

/**
 * Marks on one server photo. Loaded from the server; the last copy seen is kept (encrypted) so they still show
 * without signal.
 */
export function useMarks(photoId: string | null) {
  const app = useApp();
  const orgId = app.session?.orgId ?? "";
  const [marks, setMarks] = useState<SavedMarkup[]>([]);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [cached, setCached] = useState(false);
  const load = useCallback(async () => {
    if (!photoId) return;
    const key = `marks-${photoId}`;
    try {
      const r = await app.api.get<{ items: SavedMarkup[] }>(`/v1/orgs/${orgId}/photos/${photoId}/markups`);
      setMarks(r.items);
      setOffline(false);
      setLoaded(true);
      await app.cache.put(key, r.items);
    } catch {
      setOffline(true);
      const cached = await app.cache.get<SavedMarkup[]>(key);
      if (cached) { setMarks(cached); setCached(true); }
    }
  }, [app.api, app.cache, orgId, photoId]);
  useEffect(() => { void load(); }, [load]);
  /** loaded: the server's current marks are here. cached: no signal, but the copy saved on this phone is. */
  return { marks, offline, loaded, cached, reload: load };
}
