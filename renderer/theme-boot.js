// Runs in <head> before the first paint, so the window opens in its theme
// instead of flashing the light one. Main passes the saved theme as ?theme=;
// app.js takes over from here (Settings changes, Windows switching modes).
(() => {
  const theme = new URLSearchParams(location.search).get("theme") || "light";
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  root.dataset.themeChoice = theme;
  root.dataset.theme = theme === "system" ? (dark ? "dark" : "light") : theme;
})();
