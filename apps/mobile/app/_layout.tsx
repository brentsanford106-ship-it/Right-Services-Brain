import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../src/state";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerBackTitle: "Back" }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: "Sign in" }} />
          <Stack.Screen name="jobs/index" options={{ title: "Jobs" }} />
          <Stack.Screen name="jobs/edit" options={{ title: "Job", presentation: "modal" }} />
          <Stack.Screen name="jobs/[jobId]/index" options={{ title: "Photos" }} />
          <Stack.Screen name="jobs/[jobId]/camera" options={{ headerShown: false, animation: "fade" }} />
          <Stack.Screen name="photo/[key]" options={{ title: "Photo" }} />
          <Stack.Screen name="sync" options={{ title: "Uploads" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
