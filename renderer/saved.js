// The "Recording saved" card. It opens where the recorder bar was when a
// take finishes, so the take never seems to vanish when the main window is
// minimized or behind a game. The window cannot take focus, so buttons
// dispatch on pointerdown (like the bar).
(function () {
  const api = window.overlay || null;
  const send = (action) => {
    if (api && typeof api.savedAction === "function") api.savedAction(action);
  };
  document.querySelectorAll("[data-saved-action]").forEach((btn) => {
    btn.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      send(btn.getAttribute("data-saved-action"));
    });
  });
  const card = document.querySelector(".saved-card");
  if (card && api && typeof api.savedHover === "function") {
    card.addEventListener("pointerenter", () => api.savedHover(true));
    card.addEventListener("pointerleave", () => api.savedHover(false));
  }
  const setText = (sel, text) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = text;
  };
  if (api && typeof api.onSaved === "function") {
    api.onSaved((info) => {
      const st = info || {};
      setText("[data-saved-name]", String(st.name || "Screen take"));
      setText("[data-saved-length]", st.length ? "(" + String(st.length) + ")" : "");
      setText("[data-saved-folder]", String(st.folder || "your Videos folder"));
      const title = document.querySelector(".saved-title");
      if (title) title.textContent = st.partial ? "Recording saved (partial)" : "Recording saved";
    });
  }
})();
