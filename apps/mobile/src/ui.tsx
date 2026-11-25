import React from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Stage, SyncState } from "@rsb/photo-sync";
import { BRAND } from "./brand";
import { Icon, type IconName } from "./icons";

export { Icon, type IconName } from "./icons";
export { BRAND } from "./brand";

const LIGHT = {
  bg: "#f2f3f6",
  card: "#ffffff",
  text: "#111418",
  muted: "#687280",
  line: "#e3e6eb",
  /** Background of search boxes and segmented controls. */
  fill: "#e7e9ed",
  brand: BRAND.colors.primary,
  brandDeep: BRAND.colors.primaryDeep,
  brandSoft: BRAND.colors.primarySoft,
  ink: "#16181d", // near-black for headings and selected chips
  inkText: "#ffffff", // text on an `ink` background
  brandText: "#ffffff",
  link: BRAND.colors.primary,
  /** Dark band at the top of a job's photos (same in light and dark mode). */
  header: "#121418",
  chevron: "#b4bac3",
  flag: "#d92d20",
  flagSoft: "#fde8e7",
  ok: "#0f7b45",
  okSoft: "#e2f4ea",
  warn: "#9a5b00",
  warnSoft: "#fff1d6",
  info: "#1f5fbf",
  infoSoft: "#e7efff",
  fix: "#b45309",
  fixSoft: "#fdf0e1",
  dev: "#7a2e00",
  devSoft: "#ffe7d6",
};

const DARK: typeof LIGHT = {
  bg: "#0b0c0f",
  card: "#17191e",
  text: "#eef0f3",
  muted: "#98a1ad",
  line: "#272b32",
  fill: "#1f2228",
  brand: BRAND.colors.primary, // same red: white text on it stays readable
  brandDeep: BRAND.colors.primaryDeep,
  brandSoft: BRAND.colors.primarySoftDark,
  ink: "#eef0f3",
  inkText: "#111418",
  brandText: "#ffffff",
  link: BRAND.colors.primaryOnDark, // lighter red so links are readable on dark backgrounds
  header: "#121418",
  chevron: "#59606b",
  flag: "#ff5a4f",
  flagSoft: "#3d1614",
  ok: "#6fdc9b",
  okSoft: "#11301f",
  warn: "#ffd27a",
  warnSoft: "#3a2c0b",
  info: "#8ab8ff",
  infoSoft: "#14243d",
  fix: "#fbbf6a",
  fixSoft: "#3a250b",
  dev: "#ffb98a",
  devSoft: "#3a2410",
};

/** Corner roundness used across the app. */
export const R = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

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
  completed: { bg: C.fill, fg: C.muted },
});

/** Small coloured label with a dot showing a job's status. Shows a ▾ when it can be tapped to change. */
export function StatusPill(props: { status: string; onPress?: () => void }) {
  const all = statusColors();
  const c = all[props.status] ?? all.completed!;
  const body = (
    <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.bg, borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
      <Text style={{ color: c.fg, fontWeight: "700", fontSize: 12.5 }}>{jobStatusLabel(props.status)}</Text>
      {props.onPress ? <Icon name="chevronDown" size={13} color={c.fg} strokeWidth={2.5} /> : null}
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

/** Company logo. "full" = mark + wordmark (white background), "mark" = the square mark only. */
export function Logo(props: { variant?: "full" | "mark"; height?: number; style?: StyleProp<ImageStyle> }) {
  const full = props.variant !== "mark";
  const h = props.height ?? (full ? 64 : 28);
  const w = full ? h * BRAND.logoAspect : h;
  return <Image source={full ? BRAND.logo : BRAND.mark} style={[{ width: w, height: h }, props.style]} resizeMode="contain" accessibilityLabel={BRAND.name} />;
}

/** The full logo on a rounded white plate, so it looks right on dark backgrounds and photos too. */
export function LogoPlate(props: { height?: number; style?: StyleProp<ViewStyle> }) {
  const h = props.height ?? 40;
  return (
    <View style={[{ alignSelf: "flex-start", backgroundColor: "#fff", borderRadius: Math.max(10, h * 0.28), paddingHorizontal: h * 0.28, paddingVertical: h * 0.18 }, props.style]}>
      <Logo height={h} />
    </View>
  );
}

let gradientIds = 0;
/** Brand-colour gradient filling its parent (put it first inside a View with overflow hidden). */
export function BrandGradient(props: { from?: string; to?: string }) {
  const [id] = React.useState(() => `bg${++gradientIds}`);
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={props.from ?? "#e5143f"} />
          <Stop offset="1" stopColor={props.to ?? C.brandDeep} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** Dark fade over a photo so white text on top stays readable. */
export function PhotoShade(props: { strength?: number }) {
  const [id] = React.useState(() => `ps${++gradientIds}`);
  const k = props.strength ?? 0.9;
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#0a0a0e" stopOpacity={0.05} />
          <Stop offset="0.45" stopColor="#0a0a0e" stopOpacity={0.3} />
          <Stop offset="1" stopColor="#0a0a0e" stopOpacity={k} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** Rounded square with an icon in it, used at the start of list rows and tiles. */
export function IconBubble(props: { name: IconName; color: string; bg: string; size?: number }) {
  const size = props.size ?? 34;
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: props.bg, alignItems: "center", justifyContent: "center" }}>
      <Icon name={props.name} color={props.color} size={size * 0.56} />
    </View>
  );
}

/** A white rounded box holding rows, like the iPhone Settings app. */
export function ListGroup({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[s.card, { padding: 0, overflow: "hidden" }, style]}>
      {rows.map((row, i) => (
        <View key={i} style={i < rows.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line } : undefined}>
          {row}
        </View>
      ))}
    </View>
  );
}

/** One tappable row: icon, title (and optional second line), optional badge, and an arrow. */
export function ListRow(props: {
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  title: string;
  subtitle?: string;
  titleColor?: string;
  badge?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 58, backgroundColor: pressed ? C.fill : "transparent" })}
    >
      {props.icon ? <IconBubble name={props.icon} color={props.iconColor ?? C.brand} bg={props.iconBg ?? C.brandSoft} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: props.titleColor ?? C.text }}>{props.title}</Text>
        {props.subtitle ? <Text style={{ fontSize: 13, color: C.muted, marginTop: 1 }}>{props.subtitle}</Text> : null}
      </View>
      {props.badge ? (
        <View style={{ backgroundColor: C.brand, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
          <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>{props.badge}</Text>
        </View>
      ) : null}
      {props.onPress ? <Icon name="chevronRight" size={18} color={C.chevron} /> : null}
    </Pressable>
  );
}

/** Small capital heading above a group, with an optional link on the right. */
export function SectionHeader(props: { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginHorizontal: 4 }, props.style]}>
      <Text style={s.section}>{props.title}</Text>
      {props.action ? (
        <Pressable hitSlop={10} onPress={props.onAction}>
          <Text style={{ color: C.link, fontWeight: "600", fontSize: 15 }}>{props.action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Icon-only button for the top bar (for example the Settings gear). */
export function HeaderIcon(props: { name: IconName; onPress: () => void; label: string; color?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} hitSlop={12}>
      <Icon name={props.name} size={22} color={props.color ?? C.link} />
    </Pressable>
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
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const kind = props.kind ?? "primary";
  const fg = kind === "secondary" ? C.text : C.brandText;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      style={({ pressed }) => [
        s.btn,
        kind === "primary" && { backgroundColor: C.brand, overflow: "hidden", boxShadow: "0 6px 16px rgba(212,14,59,0.28)" },
        kind === "secondary" && { backgroundColor: C.card, borderWidth: 1, borderColor: C.line },
        kind === "danger" && { backgroundColor: C.flag },
        props.disabled && { opacity: 0.5, boxShadow: "none" },
        pressed && { opacity: 0.8, transform: [{ scale: 0.985 }] },
        props.style,
      ]}
    >
      {kind === "primary" ? <BrandGradient /> : null}
      {props.busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {props.icon ? <Icon name={props.icon} size={19} color={fg} /> : null}
          <Text style={[s.btnText, { color: fg }]}>{props.title}</Text>
        </View>
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
      style={({ pressed }) => [s.chip, props.active && { backgroundColor: activeBg, borderColor: activeBg }, pressed && { opacity: 0.7 }]}
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
  if (compact) {
    const name: IconName = state === "synced" || state === "server" ? "check" : state === "needs_attention" ? "alert" : "arrowUp";
    return (
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }}>
        <Icon name={name} size={13} strokeWidth={2.8} color={state === "needs_attention" ? "#d92d20" : state === "synced" || state === "server" ? "#0f7b45" : "#9a5b00"} />
      </View>
    );
  }
  return (
    <View style={[s.pill, { backgroundColor: l.bg }]}>
      <Text style={[s.pillText, { color: l.fg }]}>{l.text}</Text>
    </View>
  );
}

export function FlagBadge() {
  return (
    <View style={s.flagBadge}>
      <Icon name="flag" size={13} color="#fff" strokeWidth={2.4} />
    </View>
  );
}

export function Empty({ title, body, icon }: { title: string; body?: string; icon?: IconName }) {
  return (
    <View style={{ padding: 32, alignItems: "center" }}>
      {icon ? (
        <View style={{ marginBottom: 14 }}>
          <IconBubble name={icon} color={C.muted} bg={C.fill} size={56} />
        </View>
      ) : null}
      <Text style={{ fontSize: 17, fontWeight: "700", color: C.text, textAlign: "center" }}>{title}</Text>
      {body ? <Text style={{ marginTop: 6, color: C.muted, textAlign: "center", lineHeight: 20 }}>{body}</Text> : null}
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  dev: { backgroundColor: C.devSoft, paddingVertical: 5, paddingHorizontal: 12 },
  devText: { color: C.dev, fontSize: 11, fontWeight: "700", textAlign: "center", letterSpacing: 0.2 },
  btn: { minHeight: 52, borderRadius: R.md + 2, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  btnText: { color: C.brandText, fontSize: 16.5, fontWeight: "700" },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: R.pill, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, marginRight: 8 },
  chipText: { color: C.text, fontWeight: "600", fontSize: 14 },
  pill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: R.pill, alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "700" },
  flagBadge: { backgroundColor: C.flag, borderRadius: 8, width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  flagBadgeText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  // Light mode: soft shadow. Dark mode: thin border instead (shadows don't show on black).
  card:
    current === "dark"
      ? { backgroundColor: C.card, borderRadius: R.lg, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line }
      : { backgroundColor: C.card, borderRadius: R.lg, padding: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.05), 0 4px 14px rgba(16,24,40,0.06)" },
  h1: { fontSize: 26, fontWeight: "800", color: C.text, letterSpacing: -0.4 },
  section: { fontSize: 13, fontWeight: "700", color: C.muted, textTransform: "uppercase", letterSpacing: 0.8 },
  label: { fontSize: 13, fontWeight: "600", color: C.muted, marginBottom: 6 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: R.md, paddingHorizontal: 14, minHeight: 48, fontSize: 16, color: C.text },
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

