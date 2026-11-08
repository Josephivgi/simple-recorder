"use strict";

// Fast screenshots. desktopCapturer thumbnails list every source and can take
// seconds on a busy machine; a stream of one known source gives a frame in a
// fraction of that. A hidden page (renderer/grab.html) holds the stream,
// crops, and encodes the PNG, so the main process never blocks on it.
//
// The stream stays open for a short while after a grab (or a warm call from
// the Screenshots page), so the next screenshot skips opening it.

const path = require("path");

const WARM_MS = 20000;
const IDLE_CLOSE_MS = 120000;

function createScreenGrab({ BrowserWindow, session, log }) {
  let win = null;
  let ready = null;
  let warmTimer = null;
  let idleTimer = null;
  let disposed = false;

  function note(event, detail) {
    try {
      if (typeof log === "function") log(event, detail);
    } catch {
      /* logging is best effort */
    }
  }

  function grabSession() {
    const sess = session.fromPartition("rec-grab");
    // Only this page lives here, and it only asks for the screen.
    sess.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
    sess.setPermissionCheckHandler((_wc, permission) => permission === "media");
    return sess;
  }

  function ensureWindow() {
    if (disposed) return Promise.reject(new Error("closed"));
    if (win && !win.isDestroyed() && ready) return ready;
    win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      focusable: false,
      title: "Simple Recorder capture",
      webPreferences: {
        session: grabSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const own = win;
    own.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    own.webContents.on("will-navigate", (event) => event.preventDefault());
    own.webContents.on("render-process-gone", (_event, details) => {
      note("grab page gone", details && details.reason);
      if (win === own) {
        win = null;
        ready = null;
      }
      try {
        own.destroy();
      } catch {
        /* already gone */
      }
    });
    own.on("closed", () => {
      if (win === own) {
        win = null;
        ready = null;
      }
    });
    ready = own.loadFile(path.join(__dirname, "..", "renderer", "grab.html")).then(() => own);
    ready.catch(() => {
      if (win === own) {
        win = null;
        ready = null;
      }
    });
    return ready;
  }

  function call(fn, args) {
    return ensureWindow().then((page) =>
      page.webContents.executeJavaScript("window." + fn + "(" + args.map((a) => JSON.stringify(a)).join(",") + ")", true),
    );
  }

  function armTimers() {
    clearTimeout(warmTimer);
    clearTimeout(idleTimer);
    warmTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) void call("__grabStop", []).catch(() => {});
    }, WARM_MS);
    idleTimer = setTimeout(close, IDLE_CLOSE_MS);
  }

  // id: a desktopCapturer id ("screen:..." or "window:..."). size: the
  // screen's pixel size, or null for a window (its own size).
  async function grab(id, size, crop) {
    const result = await call("__grab", [String(id), size || null, crop || null, true]);
    armTimers();
    if (!result || !result.bytes || !result.width) throw new Error("The capture came back empty.");
    return { png: Buffer.from(result.bytes.buffer || result.bytes), width: result.width, height: result.height, timing: String(result.timing || "") };
  }

  async function warm(id, size) {
    await call("__grabWarm", [String(id), size || null]);
    armTimers();
  }

  function close() {
    clearTimeout(warmTimer);
    clearTimeout(idleTimer);
    const page = win;
    win = null;
    ready = null;
    if (page && !page.isDestroyed()) {
      try {
        page.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  function dispose() {
    disposed = true;
    close();
  }

  function owns(other) {
    return Boolean(win && other === win);
  }

  return { grab, warm, close, dispose, owns };
}

module.exports = { createScreenGrab };
