/**
 * Company branding in one place. A future company gets its own look by changing only this file
 * (name, colours, logo pictures); every screen reads from here through `ui.tsx`.
 */
export interface Brand {
  name: string;
  tagline: string;
  colors: { primary: string; primaryDeep: string; primaryOnDark: string; primarySoft: string; primarySoftDark: string };
  logo: number;
  logoAspect: number;
  mark: number;
  hero: number;
}

export const BRAND: Brand = {
  name: "Right Services",
  tagline: "Commercial Remodel, Repair, and Maintenance",
  colors: {
    /** Main colour (buttons, highlights). White text must be readable on it. */
    primary: "#d40e3b",
    /** Darker shade used for the bottom of gradients and pressed states. */
    primaryDeep: "#a10a2c",
    /** Lighter shade for text and icons on dark backgrounds. */
    primaryOnDark: "#ff5c7c",
    /** Soft tint behind icons (light mode / dark mode). */
    primarySoft: "#fde7ec",
    primarySoftDark: "#3a1520",
  },
  /** Full logo (mark + name) on a white background, and the width/height ratio of that picture. */
  logo: require("../assets/brand/logo.png") as number,
  logoAspect: 678 / 247,
  /** Square mark only. */
  mark: require("../assets/brand/mark.png") as number,
  /** Banner photo on the Home screen. */
  hero: require("../assets/brand/hero.jpg") as number,
};
