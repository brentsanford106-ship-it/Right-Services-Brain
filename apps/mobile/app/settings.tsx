import React from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useApp, useQueueVersion } from "../src/state";
import { Button, C, DevBanner, s } from "../src/ui";

export default function Settings() {
  const app = useApp();
  useQueueVersion();
  const counts = app.queue.counts();
  const unsent = counts.waiting + counts.needsAttention;

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
