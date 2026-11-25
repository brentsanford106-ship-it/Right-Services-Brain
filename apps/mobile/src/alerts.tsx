import React, { useCallback, useEffect, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import { ALERT_KINDS, ApiError, NetworkError, type AlertKind } from "@rsb/photo-sync";
import { useApp } from "./state";
import { C, s } from "./ui";

/** An alert as the server sends it (see the API's Notification). */
export interface ServerAlert {
  id: string;
  kind: AlertKind;
  actor: string;
  actorId: string;
  actorAvatarAt: string | null;
  jobId: string;
  jobNumber: string;
  photoId: string;
  commentId: string | null;
  issueId: string | null;
  issueTitle: string | null;
  snippet: string | null;
  createdAt: string;
  readAt: string | null;
}

/** Which alerts I get, on the Settings screen. Needs a connection to change. */
export function AlertSettings() {
  const app = useApp();
  const orgId = app.session?.orgId ?? "";
  const manager = app.can("photo_issues.manage");
  const [muted, setMuted] = useState<AlertKind[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setMuted((await app.api.get<{ muted: AlertKind[] }>(`/v1/orgs/${orgId}/notification-settings`)).muted);
    } catch {
      setMuted(null);
    }
  }, [app.api, orgId]);
  useEffect(() => { void load(); }, [load]);
  const toggle = async (kind: AlertKind, on: boolean) => {
    if (!muted) return;
    const next = on ? muted.filter((m) => m !== kind) : [...muted, kind];
    setBusy(true);
    setMuted(next);
    try {
      setMuted((await app.api.patch<{ muted: AlertKind[] }>(`/v1/orgs/${orgId}/notification-settings`, { muted: next })).muted);
    } catch (e) {
      setMuted(muted);
      Alert.alert("Not saved", e instanceof NetworkError ? "No connection. Try again when you have signal." : e instanceof ApiError ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={s.card}>
      <Text style={s.label}>Alerts</Text>
      {!muted ? <Text style={s.muted}>Alert settings need a connection.</Text> : (
        <View style={{ gap: 10 }}>
          {ALERT_KINDS.filter((k) => manager || !k.managers).map((k) => (
            <View key={k.kind} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ flex: 1, color: C.text }}>{k.label}</Text>
              <Switch value={!muted.includes(k.kind)} disabled={busy} onValueChange={(v) => void toggle(k.kind, v)} accessibilityLabel={k.label} />
            </View>
          ))}
        </View>
      )}
      <Text style={[s.muted, { marginTop: 6 }]}>Alerts show on Home inside the app. Phone notifications (when the app is closed) come later with the App Store version.</Text>
    </View>
  );
}
