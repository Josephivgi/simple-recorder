(function () {
  const role = new URLSearchParams(window.location.search).get("role") || "bar";
  document.documentElement.setAttribute("data-overlay-role", role);
  if (role === "frame") return;

  function overlayApi() {
    return window.overlay || null;
  }

  function call(name, arg) {
    const api = overlayApi();
    if (api && typeof api[name] === "function") api[name](arg);
    else console.warn("overlay api missing:", name);
  }

  if (role === "pick") {
    pickArea();
    pickWindows();
    return;
  }

  // Window pick: the same fullscreen picker window lists recordable
  // windows as cards. A click sends the pick; Cancel or Esc cancels.
  function pickWindows() {
    const layer = document.querySelector("[data-win-pick]");
    const grid = document.querySelector("[data-win-grid]");
    const cancel = document.querySelector("[data-win-cancel]");
    const areaLayer = document.querySelector("[data-area-pick]");
    if (!layer || !grid) return;
    if (cancel) cancel.addEventListener("click", () => call("pickWindow", {}));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !layer.hidden) call("pickWindow", {});
    });
    const api = overlayApi();
    if (!api || typeof api.onPickWindows !== "function") return;
    api.onPickWindows((payload) => {
      const windows = payload && Array.isArray(payload.windows) ? payload.windows : [];
      if (areaLayer) areaLayer.hidden = true;
      grid.textContent = "";
      if (!windows.length) {
        const empty = document.createElement("p");
        empty.className = "win-pick-empty";
        empty.textContent = "No recordable windows found.";
        grid.appendChild(empty);
      }
      windows.forEach((win) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "win-pick-item";
        const thumb = win.thumbnail || win.thumb;
        if (thumb) {
          const img = document.createElement("img");
          img.className = "win-pick-thumb";
          img.alt = "";
          img.src = thumb;
          btn.appendChild(img);
        }
        const name = document.createElement("span");
        name.className = "win-pick-name";
        name.textContent = win.name || "Window";
        btn.appendChild(name);
        btn.addEventListener("click", () => call("pickWindow", { id: win.id, name: win.name }));
        grid.appendChild(btn);
      });
      layer.hidden = false;
    });
  }

  // Area picker: a full screen layer. Drag draws the box and release sends
  // it. A touchpad cannot hold a drag easily, so a click also works: the
  // first click pins one corner, the box follows the pointer, and a second
  // click sets the opposite corner. Cancel, Esc, or a right click keeps the
  // old area.
  function pickArea() {
    const layer = document.querySelector("[data-area-pick]");
    const box = document.querySelector("[data-area-box]");
    const hint = document.querySelector("[data-area-hint]");
    const cancel = document.querySelector("[data-area-cancel]");
    if (!layer || !box) return;
    layer.hidden = false;
    let start = null;
    let anchor = null;
    let done = false;
    // One pointer owns a gesture; a palm or a second finger cannot hijack it.
    let pressId = null;
    const finish = (rect) => {
      if (done) return;
      done = true;
      call("pickArea", rect);
    };
    const rectFrom = (a, b) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    });
    const size = document.querySelector("[data-area-size]");
    const scale = window.devicePixelRatio || 1;
    const draw = (r) => {
      box.hidden = false;
      box.style.left = r.x + "px";
      box.style.top = r.y + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      if (size) size.textContent = Math.round(r.width * scale) + " x " + Math.round(r.height * scale);
      if (hint) hint.hidden = true;
    };
    const big = (r) => r.width >= 32 && r.height >= 32;
    // A drag or a pinned corner counts as a gesture in flight; main waits
    // for it instead of cancelling the pick on a stray focus loss.
    const report = () => call("pickState", { active: Boolean(start || anchor) });
    const reset = () => {
      anchor = null;
      box.hidden = true;
      if (size) size.textContent = "";
      if (hint) hint.hidden = false;
    };
    layer.addEventListener("pointerdown", (event) => {
      if (event.isPrimary === false) return;
      if (event.button !== 0) {
        // A secondary press cancels when idle, never mid-drag.
        if (!start) finish(null);
        return;
      }
      const at = { x: event.clientX, y: event.clientY };
      if (anchor) {
        // Second corner of a click-click pick: start a drag from the pinned
        // corner so the release commits, adjustable until then.
        start = anchor;
        anchor = null;
      } else {
        start = at;
      }
      pressId = event.pointerId;
      report();
      try {
        layer.setPointerCapture(event.pointerId);
      } catch (_) {}
      draw(rectFrom(start, at));
    });
    layer.addEventListener("pointermove", (event) => {
      if (event.isPrimary === false) return;
      if (pressId !== null && event.pointerId !== pressId) return;
      const from = start || anchor;
      if (!from) return;
      draw(rectFrom(from, { x: event.clientX, y: event.clientY }));
    });
    layer.addEventListener("pointerup", (event) => {
      // Only a left release ends a gesture: a right release shares the mouse
      // pointerId and must not commit whatever box happens to be drawn.
      if (event.button !== 0) return;
      if (pressId !== null && event.pointerId !== pressId) return;
      if (!start) return;
      pressId = null;
      const r = rectFrom(start, { x: event.clientX, y: event.clientY });
      const from = start;
      start = null;
      if (big(r)) finish(r);
      else anchor = from;
      report();
    });
    layer.addEventListener("pointercancel", (event) => {
      if (pressId !== null && event.pointerId !== pressId) return;
      pressId = null;
      // A stolen pointer drops the drag but keeps a pinned corner.
      start = null;
      if (!anchor) reset();
      report();
    });
    if (cancel) {
      cancel.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        event.preventDefault();
        if (event.button === 0) finish(null);
      });
      cancel.addEventListener("click", (event) => {
        if (event.detail === 0) finish(null);
      });
    }
    layer.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(null);
    });
    // The picker window is reused: main resets it each time it opens.
    const api = overlayApi();
    if (api && typeof api.onPickReset === "function") {
      api.onPickReset((payload) => {
        done = false;
        start = null;
        reset();
        report();
        // One window serves both pickers; show the layer this open is for.
        // The window list says Loading until its thumbnails arrive.
        const winLayer = document.querySelector("[data-win-pick]");
        const winGrid = document.querySelector("[data-win-grid]");
        const windows = payload && payload.mode === "windows";
        layer.hidden = windows;
        if (winLayer) winLayer.hidden = !windows;
        if (windows && winGrid) {
          winGrid.textContent = "";
          const wait = document.createElement("p");
          wait.className = "win-pick-empty";
          wait.textContent = "Loading windows";
          winGrid.appendChild(wait);
        }
      });
    }
  }

  // The bar is a non-focusable window. On Windows the first click on such a
  // window can arrive as a press with no click, so buttons act on press.
  // Keyboard clicks (detail 0) still go through click.
  function bind(sel, fn) {
    document.querySelectorAll(sel).forEach((el) => {
      let lastDown = 0;
      el.addEventListener("pointerdown", (event) => {
        // A second touch contact is not a press on the button.
        if (event.button !== 0 || event.isPrimary === false) return;
        // Windows can promote one touch or pen tap into a second primary
        // pointerdown (per pointer type) in the same millisecond.
        const now = Date.now();
        if (now - lastDown < 350) return;
        lastDown = now;
        event.preventDefault();
        fn(event);
      });
      el.addEventListener("click", (event) => {
        // Keyboard clicks have detail 0; a synthetic click right after a
        // pointerdown would fire the action twice.
        if (event.detail === 0 && Date.now() - lastDown > 500) fn(event);
      });
    });
  }

  function setText(sel, text) {
    const el = document.querySelector(sel);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function paint(state) {
    const st = state || {};
    const card = document.querySelector(".countdown-card");
    if (!card) return;
    card.setAttribute("data-mode", String(st.mode || "timer"));
    // A framed window rides an area take; the Window button is the one
    // that lights up for it.
    const framed = Boolean(st.framed);
    const target = st.target === "area" ? (framed ? "window" : "area") : "auto";
    card.setAttribute("data-target", target);
    if (st.arming) card.setAttribute("data-arming", "true");
    else card.removeAttribute("data-arming");
    const loading = Boolean(st.loading);
    if (loading) card.setAttribute("data-loading", "true");
    else card.removeAttribute("data-loading");
    const go = document.querySelector("[data-overlay-start]");
    if (go) {
      go.disabled = loading;
      go.setAttribute("aria-label", loading ? "Getting your screen ready" : "Record");
    }
    setText("[data-overlay-go-label]", loading ? "Loading" : "Record");

    const clock = String(st.clock || "");
    setText("[data-overlay-label]", String(st.label || ""));
    setText("[data-record-countdown]", clock);
    setText("[data-clock-text]", clock);
    setText("[data-overlay-delay]", String(st.delayLabel || ""));
    setText("[data-overlay-fps]", String(Number(st.fps) || 30));
    setText("[data-overlay-size]", target === "area" && st.areaLabel ? String(st.areaLabel) : "");
    setText("[data-overlay-window-label]", target === "window" && st.areaLabel ? " " + String(st.areaLabel) : "");
    document.querySelectorAll("[data-overlay-target]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-overlay-target") === target));
    });
    const sound = document.querySelector("[data-overlay-sound]");
    if (sound) {
      const micOn = Boolean(st.micOn);
      sound.setAttribute("aria-pressed", String(micOn));
      sound.setAttribute("aria-label", micOn ? "Sound on" : "Sound off");
      setText("[data-overlay-sound-label]", String(st.micLabel || (micOn ? "On" : "Off")));
    }
    const clockWrap = document.querySelector("[data-overlay-clock]");
    if (clockWrap) clockWrap.dataset.empty = clock ? "false" : "true";
    const liveDot = document.querySelector(".live-dot");
    if (liveDot) liveDot.hidden = st.mode !== "recording";
    const pauseBtn = document.querySelector("[data-overlay-pause]");
    if (pauseBtn) {
      const paused = Boolean(st.paused);
      pauseBtn.setAttribute("aria-pressed", String(paused));
      pauseBtn.setAttribute("aria-label", paused ? "Resume the take" : "Pause the take");
      setText("[data-overlay-pause-label]", paused ? "Resume" : "Pause");
      if (clockWrap) clockWrap.dataset.paused = paused ? "true" : "false";
    }
  }

  bind("[data-overlay-start]", () => call("recordNow"));
  bind("[data-overlay-stop]", () => call("stopNow"));
  bind("[data-overlay-pause]", () => call("pauseNow"));
  bind("[data-overlay-close]", () => call("closeNow"));
  bind("[data-overlay-target]", (event) => call("setTarget", event.currentTarget.getAttribute("data-overlay-target")));
  bind("[data-overlay-delay-down]", () => call("nudgeDelay", -1));
  bind("[data-overlay-delay-up]", () => call("nudgeDelay", 1));
  bind("[data-overlay-fps-down]", () => call("nudgeFps", -1));
  bind("[data-overlay-fps-up]", () => call("nudgeFps", 1));
  bind("[data-overlay-sound]", () => call("toggleSound"));

  // The card can sit over game HUD or other screen content during a take.
  // Dragging any non-button area moves the window; buttons stay buttons.
  const card = document.querySelector(".countdown-card");
  if (card) {
    let drag = null;
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      if (event.target && event.target.closest && event.target.closest("button")) return;
      drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
      card.classList.add("dragging");
      try {
        card.setPointerCapture(event.pointerId);
      } catch (error) {
        /* capture optional */
      }
    });
    card.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = Math.round(event.screenX - drag.x);
      const dy = Math.round(event.screenY - drag.y);
      if (!dx && !dy) return;
      drag.x = event.screenX;
      drag.y = event.screenY;
      call("dragBy", { dx, dy });
    });
    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      card.classList.remove("dragging");
    };
    card.addEventListener("pointerup", endDrag);
    card.addEventListener("pointercancel", endDrag);
  }

  const api = overlayApi();
  if (api && typeof api.onState === "function") api.onState(paint);
})();
