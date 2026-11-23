import React, { useMemo, useRef, useState } from "react";
import { Alert, PanResponder, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import {
  COLOR_HEX, LABEL_MAX, MARKUP_COLORS, MarkupDraft, NetworkError, ApiError, clampPoint, hitTest, shapeProblem, thinPen, tooSmall,
  type MarkupColor, type MarkupKind, type MarkupShape, type MarkupSize, type Point,
} from "@rsb/photo-sync";
import { useApp } from "../../src/state";
import { ServerImage } from "../../src/photos";
import { MarksLayer, fitRect, useMarks } from "../../src/markup";
import { Button, C, s } from "../../src/ui";

type Tool = MarkupKind | "erase" | "move";
const TOOLS: { value: Tool; label: string; name: string }[] = [
  { value: "circle", label: "◯", name: "Circle" },
  { value: "arrow", label: "➜", name: "Arrow" },
  { value: "pen", label: "✎", name: "Pen" },
  { value: "rect", label: "▭", name: "Box" },
  { value: "text", label: "T", name: "Text" },
  { value: "pin", label: "📍", name: "Pin" },
  { value: "erase", label: "⌫", name: "Remove a mark" },
  { value: "move", label: "✋", name: "Move (when zoomed)" },
];
const ZOOMS = [1, 2, 3];

/**
 * Drawing on one photo (owners and managers). Nothing is sent until Save. The photo itself never changes.
 * Saving needs a connection for now; the drawing stays on screen if it fails, so it can be tried again.
 */
export default function Draw() {
  const app = useApp();
  const { photoId, w: ws, h: hs } = useLocalSearchParams<{ photoId: string; w: string; h: string }>();
  const W = Number(ws) || 1000;
  const H = Number(hs) || 750;
  const { marks: saved, loaded, offline } = useMarks(photoId);
  const [draft, setDraft] = useState<MarkupDraft | null>(null);
  // Start the drawing session once the server's marks are here (and only once, so nothing drawn is ever reset).
  if (!draft && loaded) setDraft(new MarkupDraft(saved, () => Crypto.randomUUID()));
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const [tool, setTool] = useState<Tool>("circle");
  const [color, setColor] = useState<MarkupColor>("red");
  const [size, setSize] = useState<MarkupSize>(2);
  const [text, setText] = useState("");
  const [zoom, setZoom] = useState(1);
  const [live, setLive] = useState<MarkupShape | null>(null);
  const [busy, setBusy] = useState(false);
  const { width, height } = useWindowDimensions();
  const box = fitRect(width, height * 0.6, W, H);
  const dispW = box.w * zoom;
  const dispH = box.h * zoom;

  // Latest values for the touch handler (it's made once).
  const ref = useRef({ tool, color, size, text, dispW, dispH, draft, live });
  ref.current = { tool, color, size, text, dispW, dispH, draft, live };
  const removable = useMemo(() => new Set(saved.filter((m) => m.canRemove).map((m) => m.id)), [saved]);

  const at = (x: number, y: number): Point => clampPoint([x / (ref.current.dispW || 1), y / (ref.current.dispH || 1)]);
  const commit = (shape: MarkupShape) => {
    const problem = shapeProblem(shape);
    if (problem) return Alert.alert("Can't add that", problem);
    if (tooSmall(shape, ref.current.dispW, ref.current.dispH)) return;
    ref.current.draft?.add(shape);
    rerender();
  };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => ref.current.tool !== "move",
    onMoveShouldSetPanResponder: () => ref.current.tool !== "move",
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { tool: t, color: c, size: sz, text: tx, draft: d } = ref.current;
      const p = at(e.nativeEvent.locationX, e.nativeEvent.locationY);
      if (t === "erase") {
        if (!d) return;
        const i = hitTest([...d.current], p[0] * ref.current.dispW, p[1] * ref.current.dispH, ref.current.dispW, ref.current.dispH, 24);
        const m = d.current[i];
        if (!m) return;
        if (m.savedId && !removable.has(m.savedId)) return Alert.alert("Not yours", "You can only remove your own marks.");
        d.remove(m.key);
        rerender();
        return;
      }
      if (t === "text" || t === "pin") {
        if (t === "text" && !tx.trim()) return Alert.alert("Type the text first", "Type the words in the box below, then tap the photo where they go.");
        commit({ kind: t, color: c, size: sz, points: [p], label: tx.trim() || null });
        if (t === "text") setText("");
        return;
      }
      if (t === "move") return;
      const shape: MarkupShape = { kind: t, color: c, size: sz, points: [p, p] };
      ref.current.live = shape;
      setLive(shape);
    },
    onPanResponderMove: (e) => {
      const l = ref.current.live;
      if (!l) return;
      const p = at(e.nativeEvent.locationX, e.nativeEvent.locationY);
      const next: MarkupShape = l.kind === "pen" ? { ...l, points: [...l.points, p] } : { ...l, points: [l.points[0]!, p] };
      ref.current.live = next;
      setLive(next);
    },
    onPanResponderRelease: () => {
      const l = ref.current.live;
      ref.current.live = null;
      setLive(null);
      if (l) commit(l.kind === "pen" ? { ...l, points: thinPen(l.points, ref.current.dispW, ref.current.dispH) } : l);
    },
    onPanResponderTerminate: () => {
      ref.current.live = null;
      setLive(null);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [removable]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await app.api.post(`/v1/orgs/${app.session!.orgId}/photos/${photoId}/markups/changes`, draft.changes());
      router.back();
    } catch (e) {
      Alert.alert(
        "Drawing not saved",
        e instanceof NetworkError ? "No connection. Your drawing is still here: try Save again when you have signal."
          : e instanceof ApiError ? e.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (!draft?.dirty) return router.back();
    Alert.alert("Throw away this drawing?", "Your changes haven't been saved.", [
      { text: "Keep drawing", style: "cancel" },
      { text: "Throw away", style: "destructive", onPress: () => router.back() },
    ]);
  };

  return (
    <View style={[s.screen, { backgroundColor: "#000" }]}>
      <Stack.Screen options={{ title: "Draw", headerLeft: () => <Pressable onPress={cancel} hitSlop={10}><Text style={{ color: C.brand, fontSize: 17 }}>Cancel</Text></Pressable> }} />
      {!draft ? (
        <Text style={{ color: "#fff", padding: 16 }}>{offline ? "Drawing needs a connection for now. Try again when you have signal." : "Loading the drawing…"}</Text>
      ) : null}
      <ScrollView
        style={{ maxHeight: height * 0.6 }}
        contentContainerStyle={{ minWidth: width, minHeight: Math.min(height * 0.6, dispH), alignItems: "center", justifyContent: "center" }}
        horizontal={false}
        scrollEnabled={tool === "move"}
      >
        <ScrollView horizontal scrollEnabled={tool === "move"} contentContainerStyle={{ minWidth: width, alignItems: "center" }}>
          <View style={{ width: dispW, height: dispH }} {...pan.panHandlers} accessibilityLabel="Photo drawing area">
            <ServerImage photoId={photoId} style={{ width: dispW, height: dispH }} contain />
            <MarksLayer marks={draft ? draft.current : []} w={W} h={H} width={dispW} height={dispH} preview={live} />
          </View>
        </ScrollView>
      </ScrollView>

      <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
        <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
          {TOOLS.map((t) => (
            <Pressable key={t.value} onPress={() => setTool(t.value)} accessibilityRole="button" accessibilityLabel={t.name} accessibilityState={{ selected: tool === t.value }}
              style={{ width: 46, height: 46, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tool === t.value ? C.ink : C.card, borderWidth: 1, borderColor: C.line }}>
              <Text style={{ fontSize: 20, color: tool === t.value ? "#fff" : C.text }}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          {MARKUP_COLORS.map((c) => (
            <Pressable key={c} onPress={() => setColor(c)} accessibilityRole="button" accessibilityLabel={c} accessibilityState={{ selected: color === c }}
              style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: COLOR_HEX[c], borderWidth: color === c ? 3 : 1, borderColor: color === c ? C.brand : C.line }} />
          ))}
          <View style={{ flex: 1 }} />
          {([1, 2, 3] as MarkupSize[]).map((z) => (
            <Pressable key={z} onPress={() => setSize(z)} accessibilityRole="button" accessibilityLabel={["Thin", "Medium", "Thick"][z - 1]} accessibilityState={{ selected: size === z }}
              style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: size === z ? C.brand : C.line }}>
              <View style={{ width: 18, height: z * 2 + 1, backgroundColor: C.text, borderRadius: 2 }} />
            </Pressable>
          ))}
        </View>
        {tool === "text" || tool === "pin" ? (
          <TextInput style={s.input} maxLength={LABEL_MAX} value={text} onChangeText={setText}
            placeholder={tool === "text" ? "Type the words, then tap the photo" : "Optional pin label, then tap the photo"} placeholderTextColor={C.muted} />
        ) : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="↶ Undo" kind="secondary" style={{ flex: 1 }} disabled={!draft?.canUndo} onPress={() => { draft?.undo(); rerender(); }} />
          <Button title="↷ Redo" kind="secondary" style={{ flex: 1 }} disabled={!draft?.canRedo} onPress={() => { draft?.redo(); rerender(); }} />
          <Button title={`Zoom ${zoom}×`} kind="secondary" style={{ flex: 1 }} onPress={() => { setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]!); if (zoom === 1) setTool("move"); }} />
        </View>
        <Button title="Save drawing" busy={busy} disabled={!draft?.dirty} onPress={() => void save()} />
        <Text style={s.muted}>Drawings are saved separately. The photo itself never changes. Zoomed in? Use ✋ to move around.</Text>
      </ScrollView>
    </View>
  );
}
