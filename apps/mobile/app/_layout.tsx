import React from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../src/state";
import { C } from "../src/ui";
import { ThemeProvider } from "../src/theme";
import { Intro } from "../src/Intro";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <ThemeProvider>
          {(scheme) => (
            <>
        {/*
          The navigation theme decides the light/dark look of native header parts (Back button,
          header buttons on iOS 26). Without it they stay light in dark mode and become unreadable.
        */}
        <NavThemeProvider
          value={{
            ...(scheme === "dark" ? DarkTheme : DefaultTheme),
            dark: scheme === "dark",
            colors: {
              ...(scheme === "dark" ? DarkTheme : DefaultTheme).colors,
              primary: C.link,
              background: C.bg,
              card: C.card,
              text: C.text,
              border: C.line,
              notification: C.flag,
            },
          }}
        >
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {/*
          iOS 26 draws see-through ("glass") headers by default, and screen content then slides
          underneath them. A solid header makes the system push every screen's content below it.
        */}
        {/* Re-created when the theme changes so every screen picks up the new colours. */}
        <Stack
          key={scheme}
          screenOptions={{
            headerBackTitle: "Back",
            headerTransparent: false,
            headerStyle: { backgroundColor: C.card },
            headerTintColor: C.link,
            headerTitleStyle: { color: C.ink },
            contentStyle: { backgroundColor: C.bg },
            headerUserInterfaceStyle: scheme,
            // iOS 26 blurs/dims scroll content near the header; with a solid header it only hid
            // the filter buttons (dark smudge in dark mode), so it is switched off.
            scrollEdgeEffects: { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: "Sign in" }} />
          <Stack.Screen name="home" options={{ title: "Home" }} />
          <Stack.Screen name="jobs/index" options={{ title: "Jobs" }} />
          <Stack.Screen name="jobs/edit" options={{ title: "Job", presentation: "modal" }} />
          <Stack.Screen name="jobs/[jobId]/index" options={{ title: "Photos" }} />
          <Stack.Screen name="jobs/[jobId]/camera" options={{ headerShown: false, animation: "fade" }} />
          <Stack.Screen name="jobs/[jobId]/deleted" options={{ title: "Recently Deleted" }} />
          <Stack.Screen name="photo/[key]" options={{ title: "Photo" }} />
          <Stack.Screen name="photo/draw" options={{ title: "Draw", gestureEnabled: false }} />
          <Stack.Screen name="issues" options={{ title: "To fix" }} />
          <Stack.Screen name="sync" options={{ title: "Uploads" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="team/index" options={{ title: "Team & Roles" }} />
          <Stack.Screen name="team/member/[id]" options={{ title: "Roles" }} />
          <Stack.Screen name="team/role/[id]" options={{ title: "Role" }} />
          <Stack.Screen name="team/add" options={{ title: "Add Person", presentation: "modal" }} />
        </Stack>
        </NavThemeProvider>
            </>
          )}
        </ThemeProvider>
        <Intro />
      </AppProvider>
    </SafeAreaProvider>
  );
}
