import React, { useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, PanResponder, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import {
  COLOR_HEX, LABEL_MAX, MARKUP_COLORS, NetworkError, ApiError, clampPoint, describeMark, hitTest, markNames, shapeProblem, thinPen, tooSmall,
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

/** One mark on the drawing screen: saved on the server (savedId), or waiting on this phone for signal (queuedId). */
type Item = MarkupShape & { key: string; savedId: string | null; queuedId: string | null; canRemove: boolean };
type ChangesAnswer = { items: { id: string }[]; added?: { clientRef: string; id: string }[] };

/**
 * Drawing on one photo (owners and managers). Each mark is saved as soon as it's drawn, then a note box opens:
 * the note becomes a comment about that mark (shows in Comments; whoever took the photo gets an alert).
 * With no signal, marks and notes wait on the phone (encrypted) and are sent automatically later.
 * The photo itself never changes.
 */
export default function Draw() {
  const app = useApp();
  const { photoId, jobId, w: ws, h: hs } = useLocalSearchParams<{ photoId: string; jobId?: string; w: string; h: string }>();
  const W = Number(ws) || 1000;
  const H = Number(hs) || 750;
  const orgId = app.session!.orgId;
  const { marks: saved, loaded, cached, offline } = useMarks(photoId);
  const [items, setItems] = useState<Item[] | null>(null);
  // Start once the marks are here: the server's, or with no signal the copy saved on this phone (only once).
  if (!items && (loaded || cached)) {
    setItems(saved.map((m) => ({ kind: m.kind, color: m.color, size: m.size, points: m.points, label: m.label ?? null, key: m.id, savedId: m.id, queuedId: null, canRemove: m.canRemove })));
  }
  const [tool, setTool] = useState<Tool>("circle");
  const [color, setColor] = useState<MarkupColor>("red");
  const [size, setSize] = useState<MarkupSize>(2);
  const [text, setText] = useState("");
  const [zoom, setZoom] = useState(1);
  const [live, setLive] = useState<MarkupShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<string[]>([]); // keys drawn this time, for Undo
  const [noteFor, setNoteFor] = useState<{ key: string; name: string } | null>(null);
  const [note, setNote] = useState("");
  const { width, height } = useWindowDimensions();
  const box = fitRect(width, height * 0.55, W, H);
  const dispW = box.w * zoom;
  const dispH = box.h * zoom;

  const changesPath = `/v1/orgs/${orgId}/photos/${photoId}/markups/changes`;
  const patch = (key: string, ch: Partial<Item>) => setItems((v) => (v ?? []).map((m) => (m.key === key ? { ...m, ...ch } : m)));
  const drop = (key: string) => {
    setItems((v) => (v ?? []).filter((m) => m.key !== key));
    setMine((v) => v.filter((k) => k !== key));
    setNoteFor((n) => (n?.key === key ? null : n));
  };
  const queue = (body: { add: unknown[]; remove: string[] }, label: string) =>
    app.actions.add({ orgId, jobId: jobId!, photoId, kind: "markup_changes", body, label });

  const saveMark = async (shape: MarkupShape) => {
    const key = Crypto.randomUUID();
    const item: Item = { ...shape, label: shape.label ?? null, key, savedId: null, queuedId: null, canRemove: true };
    const all = [...(ref.current.items ?? []), item];
    setItems(all);
    setMine((v) => [...v, key]);
    const name = markNames(all)[all.length - 1] ?? describeMark(shape);
    const body = { add: [{ kind: shape.kind, color: shape.color, size: shape.size, points: shape.points, label: shape.label ?? null, clientRef: key }], remove: [] as string[] };
    setBusy(true);
    try {
      const r = await app.api.post<ChangesAnswer>(changesPath, body);
      patch(key, { savedId: r.added?.find((a) => a.clientRef === key)?.id ?? key });
      setNote("");
      setNoteFor({ key, name });
    } catch (e) {
      if (e instanceof NetworkError && jobId) {
        try {
          const a = await queue(body, "Drawing (1 new)");
          patch(key, { queuedId: a.localId });
          setNote("");
          setNoteFor({ key, name });
        } catch (err) {
          drop(key);
          Alert.alert("Drawing not saved", err instanceof Error ? err.message : "Please try again.");
        }
        return;
      }
      drop(key);
      Alert.alert("Drawing not saved", e instanceof NetworkError ? "No connection. Try again when you have signal." : e instanceof ApiError ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const removeMark = async (m: Item) => {
    setBusy(true);
    try {
      if (m.queuedId) await app.actions.discard(m.queuedId);
      else if (m.savedId) {
        try {
          await app.api.post<ChangesAnswer>(changesPath, { add: [], remove: [m.savedId] });
        } catch (e) {
          if (!(e instanceof NetworkError) || !jobId) throw e;
          await queue({ add: [], remove: [m.savedId] }, "Drawing (1 removed)");
        }
      }
      drop(m.key);
    } catch (e) {
      Alert.alert("Not removed", e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    const t = note.trim();
    const m = items?.find((x) => x.key === noteFor?.key);
    if (!t || !m || !noteFor) return;
    setBusy(true);
    try {
      // A mark still waiting for signal has no id yet, so its note says which mark it's about in words.
      const body = m.savedId ? t : `About the ${noteFor.name}: ${t}`;
      if (jobId) {
        await app.comments.add({ orgId, jobId, photoServerId: photoId, photoLocalId: null, body, mentionIds: [], markupId: m.savedId });
        app.syncNow();
      } else {
        await app.api.post(`/v1/orgs/${orgId}/photos/${photoId}/comments`, { clientRef: Crypto.randomUUID(), body, mentionIds: [], parentId: null, markupId: m.savedId });
      }
      setNoteFor(null);
      setNote("");
    } catch (e) {
      Alert.alert("Note not saved", e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // Latest values for the touch handler (it's made once).
  const ref = useRef({ tool, color, size, text, dispW, dispH, items, live, busy, noteFor, saveMark, removeMark });
  ref.current = { tool, color, size, text, dispW, dispH, items, live, busy, noteFor, saveMark, removeMark };

  const at = (x: number, y: number): Point => clampPoint([x / (ref.current.dispW || 1), y / (ref.current.dispH || 1)]);
  const commit = (shape: MarkupShape) => {
    const problem = shapeProblem(shape);
    if (problem) return Alert.alert("Can't add that", problem);
    if (tooSmall(shape, ref.current.dispW, ref.current.dispH)) return;
    void ref.current.saveMark(shape);
  };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => ref.current.tool !== "move" && !ref.current.busy && !!ref.current.items,
    onMoveShouldSetPanResponder: () => ref.current.tool !== "move" && !ref.current.busy && !!ref.current.items,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { tool: t, color: c, size: sz, text: tx, items: list } = ref.current;
      if (ref.current.noteFor) setNoteFor(null); // drawing again means "no note" for the last one
      const p = at(e.nativeEvent.locationX, e.nativeEvent.locationY);
      if (t === "erase") {
        if (!list) return;
        const i = hitTest(list, p[0] * ref.current.dispW, p[1] * ref.current.dispH, ref.current.dispW, ref.current.dispH, 24);
        const m = list[i];
        if (!m) return;
        if (!m.canRemove) return Alert.alert("Not yours", "You can only remove your own marks.");
        void ref.current.removeMark(m);
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
  }), []);

  const lastMine = items?.find((m) => m.key === mine[mine.length - 1]);
  const waiting = (items ?? []).filter((m) => m.queuedId).length;

  return (
    <KeyboardAvoidingView style={[s.screen, { backgroundColor: "#000" }]} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: "Draw", headerLeft: () => <Pressable onPress={() => router.back()} hitSlop={10} disabled={busy}><Text style={{ color: C.brand, fontSize: 17 }}>Done</Text></Pressable> }} />
      {!items ? (
        <Text style={{ color: "#fff", padding: 16 }}>{offline ? "No signal, and this photo's drawings haven't been saved on this phone yet. Open the photo once with signal, then try again." : "Loading the drawing…"}</Text>
      ) : null}
      <ScrollView
        style={{ maxHeight: height * 0.55 }}
        contentContainerStyle={{ minWidth: width, minHeight: Math.min(height * 0.55, dispH), alignItems: "center", justifyContent: "center" }}
        horizontal={false}
        scrollEnabled={tool === "move"}
      >
        <ScrollView horizontal scrollEnabled={tool === "move"} contentContainerStyle={{ minWidth: width, alignItems: "center" }}>
          <View style={{ width: dispW, height: dispH }} {...pan.panHandlers} accessibilityLabel="Photo drawing area">
            <ServerImage photoId={photoId} style={{ width: dispW, height: dispH }} contain />
            <MarksLayer marks={items ?? []} w={W} h={H} width={dispW} height={dispH} preview={live} highlight={noteFor ? (items ?? []).findIndex((m) => m.key === noteFor.key) : undefined} />
          </View>
        </ScrollView>
      </ScrollView>

      <ScrollView style={{ backgroundColor: C.bg }} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
        {noteFor ? (
          <View style={{ gap: 8 }} accessibilityLabel={`Note for the ${noteFor.name}`}>
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>Note for the {noteFor.name}</Text>
            <Text style={s.muted}>{items?.find((m) => m.key === noteFor.key)?.queuedId ? "Drawing saved on this phone. It will be sent when you have signal." : "Drawing saved."} Type what should be done here. It goes in Comments, and whoever took the photo gets an alert.</Text>
            <TextInput style={[s.input, { minHeight: 80, textAlignVertical: "top" }]} multiline autoFocus maxLength={4000} value={note} onChangeText={setNote}
              placeholder="What should be done here?" placeholderTextColor={C.muted} accessibilityLabel={`Note for the ${noteFor.name}`} />
            <Button title="Add note" busy={busy} disabled={!note.trim()} onPress={() => void saveNote()} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="No note" kind="secondary" style={{ flex: 1 }} disabled={busy} onPress={() => { setNoteFor(null); setNote(""); }} />
              <Button title="Remove drawing" kind="secondary" style={{ flex: 1 }} disabled={busy} onPress={() => { const m = items?.find((x) => x.key === noteFor.key); if (m) void removeMark(m); }} />
            </View>
          </View>
        ) : null}
        {noteFor ? null : <>
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
          <Button title="↶ Undo" kind="secondary" style={{ flex: 1 }} disabled={!lastMine || busy} onPress={() => { if (lastMine) void removeMark(lastMine); }} />
          <Button title={`Zoom ${zoom}×`} kind="secondary" style={{ flex: 1 }} onPress={() => { setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]!); if (zoom === 1) setTool("move"); }} />
        </View>
        <Button title="Done" busy={busy} onPress={() => router.back()} />
        {waiting ? <Text style={s.muted}>{waiting} drawing{waiting === 1 ? "" : "s"} saved on this phone, sent when you have signal.</Text> : null}
        <Text style={s.muted}>Drag on the photo to draw. Each drawing is saved straight away, then you can add a note. The photo itself never changes. Zoomed in? Use ✋ to move around.</Text>
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
