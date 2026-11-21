import React from "react";
import { Pressable, Text, View } from "react-native";
import { ApiError, NetworkError } from "@rsb/photo-sync";
import { C } from "./ui";

/** Shapes returned by the server's /team endpoints. The SERVER enforces every rule; the phone only shows and hides controls. */
export interface TeamRole {
  id: string;
  key: string;
  name: string;
  builtIn: boolean;
  locked: boolean;
  permissions: string[];
  memberCount: number;
}
export interface TeamMember {
  membershipId: string;
  displayName: string;
  jobTitle: string | null;
  status: "active" | "suspended" | "removed";
  isYou: boolean;
  roles: { id: string; key: string; name: string }[];
}
export interface PermissionInfo {
  key: string;
  group: string;
  label: string;
  inUse: boolean;
}

/** Mirrors the server: a broader permission covers its narrower twin. */
const COVERED_BY: Record<string, string> = {
  "jobs.read_assigned": "jobs.read_all",
  "vehicles.read_assigned": "vehicles.read_all",
  "receipts.read_own": "receipts.read_all",
};
export const holds = (mine: (p: string) => boolean, p: string) => mine(p) || (COVERED_BY[p] !== undefined && mine(COVERED_BY[p]!));

export function errorText(e: unknown): string {
  if (e instanceof NetworkError) return "This needs a connection. Nothing was changed.";
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Nothing was changed.";
}

/** A full-width tappable row with a checkbox, sized for thumbs. */
export function CheckRow(props: { label: string; sub?: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: C.line,
        opacity: props.disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: props.checked ? C.link : C.muted,
          backgroundColor: props.checked ? C.link : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {props.checked ? <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>✓</Text> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontSize: 16 }}>{props.label}</Text>
        {props.sub ? <Text style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{props.sub}</Text> : null}
      </View>
    </Pressable>
  );
}

export interface TeamInvite {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  roles: { id: string; name: string }[];
  invitedBy: string;
  createdAt: string;
}
