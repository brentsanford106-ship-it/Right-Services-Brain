/**
 * Company branding for the website in one place. A future company gets its own look by changing
 * only this file (name, colours, logo files in /public). Colours are handed to the stylesheet as
 * CSS variables by applyBrand(), which runs before the page is drawn.
 */
export const BRAND = {
  name: "Right Services",
  tagline: "Commercial Remodel, Repair, and Maintenance",
  colors: {
    /** Main colour (buttons, highlights). White text must be readable on it. */
    primary: "#d40e3b",
    /** Darker shade for gradients and hover. */
    primaryDeep: "#a10a2c",
    /** Lighter shade for links and text in dark mode. */
    primaryOnDark: "#ff6b86",
  },
  /** Full logo (white background) and the square mark, both in /public. */
  logo: "/logo.png",
  mark: "/favicon.png",
};

export function applyBrand(root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--brand", BRAND.colors.primary);
  root.style.setProperty("--brand-deep", BRAND.colors.primaryDeep);
  root.style.setProperty("--brand-ondark", BRAND.colors.primaryOnDark);
}
