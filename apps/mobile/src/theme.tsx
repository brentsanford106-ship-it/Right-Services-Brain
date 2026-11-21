import React, { createContext, useContext, useEffect, useState } from "react";
import { Appearance, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { applyScheme, type Scheme } from "./ui";

export type ThemePref = "system" | "light" | "dark";
const KEY = "rsb.theme.v1";

const Ctx = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void; scheme: Scheme }>({
  pref: "system",
  setPref: () => undefined,
  scheme: "light",
});

/** Follows the iPhone's Light/Dark setting unless the person picks one in Settings. */
export function ThemeProvider({ children }: { children: (scheme: Scheme) => React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");
  const system = useColorScheme();

  useEffect(() => {
    void SecureStore.getItemAsync(KEY)
      .then((v) => {
        if (v === "light" || v === "dark" || v === "system") setPrefState(v);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Makes system parts (keyboard, alerts, status bar) match the chosen theme.
    Appearance.setColorScheme(pref === "system" ? "unspecified" : pref);
  }, [pref]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    void SecureStore.setItemAsync(KEY, p).catch(() => undefined);
  };

  const scheme: Scheme = pref === "system" ? (system === "dark" ? "dark" : "light") : pref;
  applyScheme(scheme); // before children render, so they read the right colours
  return <Ctx.Provider value={{ pref, setPref, scheme }}>{children(scheme)}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
