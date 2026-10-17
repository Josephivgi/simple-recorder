"use strict";

// Color themes for the main window. The colors themselves live in
// renderer/themes.css; this list is what main and the page agree on: the
// ids, the light or dark scheme each one sits in (Windows draws the title bar
// to match it), and the window background shown before the page paints.
// "system" follows Windows and resolves to light or dark.

const THEMES = [
  { id: "system", label: "Match Windows", scheme: "system" },
  { id: "light", label: "Light", scheme: "light", background: "#f2f5f9" },
  { id: "dark", label: "Dark", scheme: "dark", background: "#0d1014" },
  { id: "midnight", label: "Midnight", scheme: "dark", background: "#0c0c18" },
  { id: "ocean", label: "Ocean", scheme: "light", background: "#eaf6f9" },
  { id: "forest", label: "Forest", scheme: "light", background: "#eff6ee" },
  { id: "violet", label: "Violet", scheme: "light", background: "#f4f2fb" },
  { id: "sunset", label: "Sunset", scheme: "light", background: "#faf4ec" },
];

// Light is the look the app had before themes, so an update changes nothing
// until the user picks another one.
const DEFAULT_THEME = "light";

function findTheme(id) {
  return THEMES.find((theme) => theme.id === id) || null;
}

function normalizeTheme(id) {
  return findTheme(typeof id === "string" ? id : "") ? id : DEFAULT_THEME;
}

// The theme the window actually shows: "system" becomes light or dark.
function resolveTheme(id, systemDark) {
  const theme = normalizeTheme(id);
  if (theme !== "system") return theme;
  return systemDark ? "dark" : "light";
}

// What Electron's nativeTheme.themeSource takes for this theme.
function themeSource(id) {
  return findTheme(normalizeTheme(id)).scheme;
}

function themeBackground(id, systemDark) {
  return findTheme(resolveTheme(id, systemDark)).background;
}

module.exports = {
  THEMES,
  DEFAULT_THEME,
  normalizeTheme,
  resolveTheme,
  themeSource,
  themeBackground,
};
