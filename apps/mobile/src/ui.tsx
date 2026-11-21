import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Stage, SyncState } from "@rsb/photo-sync";

export const C = {
  bg: "#f5f6f8",
  card: "#ffffff",
  text: "#14171c",
  muted: "#5f6b7a",
  line: "#dde1e7",
  brand: "#1f5fbf",
  brandText: "#ffffff",
  flag: "#d92d20",
  flagSoft: "#fde8e7",
  ok: "#127a43",
  okSoft: "#e3f5ea",
  warn: "#9a5b00",
  warnSoft: "#fff3dc",
  dev: "#7a2e00",
  devSoft: "#ffe7d6",
};

export const STAGES: { value: Stage; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
];

export function DevBanner() {
  return (
    <View style={s.dev} accessibilityRole="alert">
      <Text style={s.devText}>DEVELOPMENT BUILD · synthetic data only · sign-in is NOT secure yet</Text>
    </View>
  );
}

export function Button(props: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const kind = props.kind ?? "primary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      style={({ pressed }) => [
        s.btn,
        kind === "primary" && { backgroundColor: C.brand },
        kind === "secondary" && { backgroundColor: C.card, borderWidth: 1, borderColor: C.line },
        kind === "danger" && { backgroundColor: C.flag },
        (props.disabled || pressed) && { opacity: 0.6 },
        props.style,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={kind === "secondary" ? C.text : C.brandText} />
      ) : (
        <Text style={[s.btnText, kind === "secondary" && { color: C.text }]}>{props.title}</Text>
      )}
    </Pressable>
  );
}

export function Chip(props: { label: string; active: boolean; onPress: () => void; tone?: "flag" }) {
  const activeBg = props.tone === "flag" ? C.flag : C.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={[s.chip, props.active && { backgroundColor: activeBg, borderColor: activeBg }]}
    >
      <Text style={[s.chipText, props.active && { color: "#fff" }]}>{props.label}</Text>
    </Pressable>
  );
}

const SYNC_LABEL: Record<SyncState | "server", { text: string; fg: string; bg: string }> = {
  waiting: { text: "Waiting to upload", fg: C.warn, bg: C.warnSoft },
  uploading: { text: "Uploading…", fg: C.brand, bg: "#e6efff" },
  synced: { text: "Uploaded", fg: C.ok, bg: C.okSoft },
  needs_attention: { text: "Needs attention", fg: C.flag, bg: C.flagSoft },
  server: { text: "Uploaded", fg: C.ok, bg: C.okSoft },
};

export function SyncPill({ state, compact }: { state: SyncState | "server"; compact?: boolean }) {
  const l = SYNC_LABEL[state];
  return (
    <View style={[s.pill, { backgroundColor: l.bg }]}>
      <Text style={[s.pillText, { color: l.fg }]}>{compact ? (state === "synced" || state === "server" ? "✓" : state === "needs_attention" ? "!" : "↑") : l.text}</Text>
    </View>
  );
}

export function FlagBadge() {
  return (
    <View style={s.flagBadge}>
      <Text style={s.flagBadgeText}>⚑</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <View style={{ padding: 32, alignItems: "center" }}>
      <Text style={{ fontSize: 17, fontWeight: "600", color: C.text, textAlign: "center" }}>{title}</Text>
      {body ? <Text style={{ marginTop: 8, color: C.muted, textAlign: "center" }}>{body}</Text> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  dev: { backgroundColor: C.devSoft, paddingVertical: 6, paddingHorizontal: 12 },
  devText: { color: C.dev, fontSize: 12, fontWeight: "600", textAlign: "center" },
  btn: { minHeight: 48, borderRadius: 10, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  btnText: { color: C.brandText, fontSize: 16, fontWeight: "600" },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, marginRight: 8 },
  chipText: { color: C.text, fontWeight: "600" },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "700" },
  flagBadge: { backgroundColor: C.flag, borderRadius: 12, width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  flagBadgeText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.line },
  h1: { fontSize: 22, fontWeight: "700", color: C.text },
  label: { fontSize: 13, fontWeight: "600", color: C.muted, marginBottom: 6 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 46, fontSize: 16, color: C.text },
  muted: { color: C.muted },
  error: { color: C.flag, fontWeight: "600" },
});
