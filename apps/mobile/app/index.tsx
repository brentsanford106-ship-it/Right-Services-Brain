import React from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { useApp } from "../src/state";
import { C, s } from "../src/ui";

export default function Index() {
  const { ready, fatal, session } = useApp();
  if (!ready) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (fatal) {
    return (
      <View style={[s.screen, { padding: 24, justifyContent: "center" }]}>
        <Text style={[s.h1, { color: C.flag }]}>Secure storage problem</Text>
        <Text style={{ marginTop: 12, color: C.text }}>{fatal}</Text>
        <Text style={{ marginTop: 12, color: C.muted }}>
          Nothing has been deleted. Close the app completely and open it again. If this keeps happening, contact your administrator before
          reinstalling, because reinstalling removes photos that have not uploaded yet.
        </Text>
      </View>
    );
  }
  return <Redirect href={session ? "/jobs" : "/login"} />;
}
