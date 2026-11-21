import React from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import type { Stage, SyncState } from "@rsb/photo-sync";

const LIGHT = {
  bg: "#f5f6f8",
  card: "#ffffff",
  text: "#14171c",
  muted: "#5f6b7a",
  line: "#dde1e7",
  brand: "#d40e3b", // Right Services red (from the logo)
  ink: "#1c1d21", // logo black
  inkText: "#ffffff", // text on an `ink` background
  brandText: "#ffffff",
  link: "#d40e3b",
  flag: "#d92d20",
  flagSoft: "#fde8e7",
  ok: "#127a43",
  okSoft: "#e3f5ea",
  warn: "#9a5b00",
  warnSoft: "#fff3dc",
  info: "#1f5fbf",
  infoSoft: "#e6efff",
  dev: "#7a2e00",
  devSoft: "#ffe7d6",
};

const DARK: typeof LIGHT = {
  bg: "#0f1114",
  card: "#1a1d22",
  text: "#eceef1",
  muted: "#9aa3ad",
  line: "#2d323a",
  brand: "#d40e3b", // same red: white text on it stays readable
  ink: "#eceef1",
  inkText: "#14171c",
  brandText: "#ffffff",
  link: "#ff5c7c", // lighter red so links are readable on dark backgrounds
  flag: "#ff5a4f",
  flagSoft: "#3d1614",
  ok: "#6fdc9b",
  okSoft: "#12301f",
  warn: "#ffd27a",
  warnSoft: "#3a2c0b",
  info: "#8ab8ff",
  infoSoft: "#14243d",
  dev: "#ffb98a",
  devSoft: "#3a2410",
};

export type Scheme = "light" | "dark";

/** Current colours. Updated in place by applyScheme() so every screen reads the active theme. */
export const C = { ...LIGHT };
let current: Scheme = "light";
export const currentScheme = () => current;

export const STAGES: { value: Stage; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
];

export const JOB_STATUSES = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On hold" },
  { value: "completed", label: "Completed" },
] as const;

export const jobStatusLabel = (v: string) => JOB_STATUSES.find((x) => x.value === v)?.label ?? v;

const statusColors = (): Record<string, { bg: string; fg: string }> => ({
  planned: { bg: C.infoSoft, fg: C.info },
  active: { bg: C.okSoft, fg: C.ok },
  on_hold: { bg: C.warnSoft, fg: C.warn },
  completed: { bg: C.line, fg: C.muted },
});

/** Small coloured label showing a job's status. Shows "▾" when it can be tapped to change. */
export function StatusPill(props: { status: string; onPress?: () => void }) {
  const all = statusColors();
  const c = all[props.status] ?? all.completed!;
  const body = (
    <View style={{ alignSelf: "flex-start", backgroundColor: c.bg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: c.fg, fontWeight: "600", fontSize: 13 }}>
        {jobStatusLabel(props.status)}
        {props.onPress ? "  ▾" : ""}
      </Text>
    </View>
  );
  return props.onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`Job status: ${jobStatusLabel(props.status)}. Tap to change.`} hitSlop={8} onPress={props.onPress}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** Right Services logo. "full" = mark + wordmark (white background), "mark" = the RS hexagon only. */
export function Logo(props: { variant?: "full" | "mark"; height?: number; style?: StyleProp<ImageStyle> }) {
  const full = props.variant !== "mark";
  const h = props.height ?? (full ? 64 : 28);
  // Aspect ratios of the image files in assets/brand.
  const w = full ? h * (678 / 247) : h;
  return (
    <Image
      source={full ? require("../assets/brand/logo.png") : require("../assets/brand/mark.png")}
      style={[{ width: w, height: h }, props.style]}
      resizeMode="contain"
      accessibilityLabel="Right Services"
    />
  );
}

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
  const activeBg = props.tone === "flag" ? C.flag : C.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={[s.chip, props.active && { backgroundColor: activeBg, borderColor: activeBg }]}
    >
      <Text style={[s.chipText, props.active && { color: props.tone === "flag" ? "#fff" : C.inkText }]}>{props.label}</Text>
    </Pressable>
  );
}

const syncLabels = (): Record<SyncState | "server", { text: string; fg: string; bg: string }> => ({
  waiting: { text: "Waiting to upload", fg: C.warn, bg: C.warnSoft },
  uploading: { text: "Uploading…", fg: C.info, bg: C.infoSoft },
  synced: { text: "Uploaded", fg: C.ok, bg: C.okSoft },
  needs_attention: { text: "Needs attention", fg: C.flag, bg: C.flagSoft },
  server: { text: "Uploaded", fg: C.ok, bg: C.okSoft },
});

export function SyncPill({ state, compact }: { state: SyncState | "server"; compact?: boolean }) {
  const l = syncLabels()[state];
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

const buildStyles = () =>
  StyleSheet.create({
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

/** Shared styles; rebuilt in place when the theme changes. */
export const s = buildStyles();

/** Switches every colour and shared style to the light or dark theme. */
export function applyScheme(scheme: Scheme): void {
  if (scheme === current) return;
  current = scheme;
  Object.assign(C, scheme === "dark" ? DARK : LIGHT);
  Object.assign(s, buildStyles());
}

