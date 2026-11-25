/** Light/dark theme for the website. "system" follows the computer's setting. Remembered in this browser only. */
export type ThemePref = "system" | "light" | "dark";
const KEY = "rsb.theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    // Storage blocked: the choice applies until the page is reloaded.
  }
  applyTheme(p);
}

export function applyTheme(p: ThemePref = getThemePref()): void {
  if (p === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", p);
}
