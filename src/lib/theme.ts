// Accessibility theming (RHR-style): colorblind-safe palettes + a larger-control
// option. Applied as data-attributes on <html>; the actual colors live in
// index.css under :root[data-theme="…"]. Persisted in localStorage (no backend).

export type ThemeId = "default" | "deuteranopia" | "protanopia" | "tritanopia" | "highcontrast";
export type ControlSize = "normal" | "large";

export const THEMES: { id: ThemeId; label: string; note: string }[] = [
  { id: "default", label: "Default (teal)", note: "Standard rig palette" },
  { id: "deuteranopia", label: "Deuteranopia", note: "Red-green (most common) — blue/amber" },
  { id: "protanopia", label: "Protanopia", note: "Red-weak — blue/yellow" },
  { id: "tritanopia", label: "Tritanopia", note: "Blue-yellow — red/cyan" },
  { id: "highcontrast", label: "High contrast", note: "Max legibility, bright on black" },
];

const THEME_KEY = "hh_theme";
const SIZE_KEY = "hh_control_size";

export function getTheme(): ThemeId {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(THEME_KEY)) as ThemeId | null;
  return v && THEMES.some((t) => t.id === v) ? v : "default";
}

export function getControlSize(): ControlSize {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(SIZE_KEY) : null;
  return v === "large" ? "large" : "normal";
}

export function applyTheme(theme: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function applyControlSize(size: ControlSize) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-controls", size);
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch {
    /* ignore */
  }
}

/** Apply the persisted theme + control size on boot. */
export function initTheme() {
  applyTheme(getTheme());
  applyControlSize(getControlSize());
}
