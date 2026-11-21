import React, { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useApp, useQueueVersion } from "../src/state";
import { Button, C, Chip, DevBanner, s } from "../src/ui";
import { useTheme, type ThemePref } from "../src/theme";

interface TeamMember {
  membershipId: string;
  displayName: string;
  status: string;
  isYou: boolean;
  roles: { id: string; name: string }[];
}

export default function Settings() {
  const app = useApp();
  const theme = useTheme();
  useQueueVersion();
  const counts = app.queue.counts();
  const unsent = counts.waiting + counts.needsAttention;
  const base = app.session ? `/v1/orgs/${app.session.orgId}` : "";
  const seesTeam = app.can("roles.manage") || app.can("members.read");
  const [keep, setKeep] = useState<{ deletedPhotoRetentionDays: number; signInEveryDays: number; canEdit: boolean } | null>(null);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [saving, setSaving] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!base) return;
      app.api.get<{ deletedPhotoRetentionDays: number; signInEveryDays: number; canEdit: boolean }>(`${base}/settings`).then(setKeep, () => setKeep(null));
      if (seesTeam) app.api.get<{ items: TeamMember[] }>(`${base}/team/members`).then((r) => setTeam(r.items), () => setTeam(null));
    }, [app.api, base, seesTeam]),
  );

  const changeKeep = async (change: { deletedPhotoRetentionDays: number } | { signInEveryDays: number }) => {
    setSaving(true);
    try {
      setKeep(await app.api.patch<{ deletedPhotoRetentionDays: number; signInEveryDays: number; canEdit: boolean }>(`${base}/settings`, change));
      void app.refreshPermissions();
    } catch {
      Alert.alert("Not saved", "Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const signOut = () => {
    const go = async () => {
      await app.signOut();
      router.replace("/login");
    };
    if (unsent === 0) {
      Alert.alert("Sign out?", "Photos already uploaded stay safe on the server. This phone's copies and saved lists are deleted.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void go() },
      ]);
    } else {
      Alert.alert(
        `${unsent} photo${unsent > 1 ? "s have" : " has"} NOT uploaded`,
        "Signing out deletes them from this phone and they cannot be recovered. Connect to the internet and wait for uploads to finish first.",
        [
          { text: "Keep them", style: "cancel" },
          { text: "Delete and sign out", style: "destructive", onPress: () => void go() },
        ],
      );
    }
  };

  return (
    <View style={s.screen}>
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={s.card}>
          <Text style={s.label}>Signed in as</Text>
          <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>{app.session?.displayName}</Text>
          <Text style={s.muted}>{app.session?.orgName}</Text>
        </View>
        <View style={s.card}>
          <Text style={s.label}>Appearance</Text>
          <View style={{ flexDirection: "row" }}>
            {(
              [
                { value: "system", label: "Match iPhone" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ] as { value: ThemePref; label: string }[]
            ).map((o) => (
              <Chip key={o.value} label={o.label} active={theme.pref === o.value} onPress={() => theme.setPref(o.value)} />
            ))}
          </View>
        </View>
        {keep ? (
          <View style={s.card}>
            <Text style={s.label}>Recently Deleted</Text>
            <Text style={{ color: C.text }}>
              Deleted photos are kept for {keep.deletedPhotoRetentionDays} days so they can be restored, then removed for good automatically.
            </Text>
            {keep.canEdit ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8, opacity: saving ? 0.5 : 1 }}>
                {[7, 14, 30, 60, 90].map((d) => (
                  <Chip key={d} label={`${d} days`} active={keep.deletedPhotoRetentionDays === d} onPress={() => (saving ? undefined : void changeKeep({ deletedPhotoRetentionDays: d }))} />
                ))}
              </View>
            ) : (
              <Text style={[s.muted, { marginTop: 6 }]}>Only an owner can change this.</Text>
            )}
          </View>
        ) : null}
        {keep ? (
          <View style={s.card}>
            <Text style={s.label}>Sign In Again</Text>
            <Text style={{ color: C.text }}>
              Everyone signs in again every {keep.signInEveryDays === 1 ? "day" : `${keep.signInEveryDays} days`}. This is only checked when the phone has signal, so
              taking photos without service is never interrupted, and photos not yet sent are always kept.
            </Text>
            {keep.canEdit ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8, opacity: saving ? 0.5 : 1 }}>
                {[1, 7, 14, 30, 60, 90].map((d) => (
                  <Chip key={d} label={d === 1 ? "Every day" : `${d} days`} active={keep.signInEveryDays === d} onPress={() => (saving ? undefined : void changeKeep({ signInEveryDays: d }))} />
                ))}
              </View>
            ) : (
              <Text style={[s.muted, { marginTop: 6 }]}>Only an owner can change this.</Text>
            )}
          </View>
        ) : null}
        {team ? (
          <Pressable onPress={() => router.push("/team")} style={({ pressed }) => [s.card, { opacity: pressed ? 0.7 : 1 }]}>
            <Text style={s.label}>Team & Roles</Text>
            <Text style={{ color: C.text, fontSize: 16, fontWeight: "600" }}>
              {app.can("roles.manage") ? "Manage people's roles ›" : "See who has which role ›"}
            </Text>
            <Text style={[s.muted, { marginTop: 4 }]}>
              {team.filter((m) => m.status === "active").length} people · {app.can("roles.manage") ? "create roles, choose what each can do" : "only owners can change roles"}
            </Text>
          </Pressable>
        ) : null}
        <View style={s.card}>
          <Text style={s.label}>Server</Text>
          <Text style={{ color: C.text }}>{app.server}</Text>
        </View>
        <View style={s.card}>
          <Text style={s.label}>Photos on this phone</Text>
          <Text style={{ color: C.text }}>
            {counts.waiting} waiting · {counts.needsAttention} need attention · {counts.synced} uploaded (kept 7 days as thumbnails)
          </Text>
          <Text style={[s.muted, { marginTop: 6 }]}>
            Stored encrypted. The key is kept in this iPhone's Keychain and is deleted when you sign out.
          </Text>
        </View>
        <Button title="Sign out" kind="danger" onPress={signOut} />
      </ScrollView>
    </View>
  );
}
