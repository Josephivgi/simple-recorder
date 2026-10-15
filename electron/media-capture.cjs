// Microphone and screen capture consent, Chromium session wiring, and IPC.
// No AppX identity split and no camera support: this app records screens and
// windows only.
//
// Notes:
// - Product JS never writes OS privacy state. The only grant path for the
//   mic is the OS privacy page (open-capture-settings) or the OS prompt a
//   real getUserMedia raises.
// - Pressing Sound on the recorder bar is the consent (implied), so no
//   Allow/Block box sits hidden behind the bar.
// - Windows getMediaAccessStatus flickers denied to unknown. Unknown is not
//   a grant; keep the last denial until granted or a probe succeeds.
// - Gate Chromium on nothing but this session: it must allow "media" and
//   "display-capture" or getUserMedia never reaches the OS.
const fssync = require("fs");
const {
  readCaptureSetup,
  markCaptureApproved,
  saveRecorderPrefs,
  captureSetupStatus,
  osMediaOk: osMediaOkWith,
  fakeMediaPrefs,
  osSettingsUrl,
  permissionKind,
  rememberOsDenied,
  noteCaptureDenied,
  clearCaptureDenied,
  isOsDeniedNow,
  waitAccessDecision,
  WAIT_ACCESS_STEP_MS,
  WAIT_ACCESS_STABLE_MS,
} = require("../lib/capture-setup");
const { keepCaptureSource } = require("../lib/capture-source-filter.cjs");
const { windowRectByTitle } = require("../lib/window-rect.cjs");

const CAPTURE_SOURCES_MS = 8000;
const CAPTURE_SOURCE_TYPES = ["screen", "window"];
const THUMBNAIL_SIZE = { width: 960, height: 540 };
const THUMBNAIL_JPEG_QUALITY = 80;
const TARGET_THUMB_SIZE = { width: 480, height: 270 };
const WAIT_ACCESS_MAX_MS = 5 * 60 * 1000;
const CAPTURE_STATUS_CACHE_MS = 2500;

function loadElectron(host) {
  if (host && host.electron) return host.electron;
  return require("electron");
}

function attachMediaCapture(host) {
  const electron = loadElectron(host);
  const { app, BrowserWindow, dialog, shell, desktopCapturer, systemPreferences, screen } = electron;
  const ipcMain = (host && host.ipcMain) || electron.ipcMain;
  const store = host.store;
  const isOverlayWindow = host.isOverlayWindow || (() => false);
  const SMOKE = Boolean(host.smoke);
  const waitStepMs = Number(host && host.waitStepMs) > 0 ? Number(host.waitStepMs) : WAIT_ACCESS_STEP_MS;
  const waitStableMs = Number(host && host.waitStableMs) > 0 ? Number(host.waitStableMs) : WAIT_ACCESS_STABLE_MS;

  let preferredCaptureSourceId = "auto";
  // The recorder bar pins its take to the display it opened on so a take
  // cannot land on the screen the pointer drifted to mid-load.
  let pinnedDisplayId = "";
  let cachedCaptureSources = [];
  let captureSourcesLock = null;
  // Bumped on invalidate so an enumeration in flight cannot repopulate the
  // cache with the pre-change list.
  let captureSourcesGen = 0;
  let captureThumbnailsLock = null;
  let captureSessionWired = false;
  let captureSessionRef = null;
  let captureConsent = emptyCaptureConsent();
  const capturePrompts = { screen: null, mic: null };
  let captureIntent = { source: "screen", mic: true };
  let captureStatusCache = null;
  const waitGeneration = { mic: 0 };
  const lastDenied = { mic: false };
  let lastPermissionKind = "";

  function emptyCaptureConsent() {
    return { screen: false, mic: false };
  }

  function denyDisplayMedia(callback) {
    callback({});
  }

  function allowCapturePermission(permission) {
    if (permission === "fullscreen" || permission === "media" || permission === "display-capture") return true;
    return false;
  }

  function rememberPermission(permission, details) {
    lastPermissionKind = permissionKind(permission, details || {}, captureIntent, captureConsent);
    return lastPermissionKind;
  }

  // REC_OS_MEDIA_FILE points at a JSON file that fakes the OS answer (see
  // fakeMediaPrefs). Only guest test runs set it.
  function osMediaOverride() {
    if (host && host.osMedia && typeof host.osMedia === "object") return host.osMedia;
    const file = process.env.REC_OS_MEDIA_FILE;
    if (!file) return null;
    try {
      const parsed = JSON.parse(fssync.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function osPrefs() {
    const override = osMediaOverride();
    return override ? fakeMediaPrefs(override, systemPreferences) : systemPreferences;
  }

  function osPlatform() {
    const override = osMediaOverride();
    return override && typeof override.platform === "string" ? override.platform : process.platform;
  }

  function osMediaOk(kind) {
    return osMediaOkWith(kind, osPrefs());
  }

  function captureStatus(persisted) {
    const prefs = osPrefs();
    rememberOsDenied(lastDenied, "mic", prefs);
    return captureSetupStatus(persisted, prefs, osPlatform(), {
      packaged: app.isPackaged,
      lastDenied,
    });
  }

  // Identical polls inside a short window reuse the last computed answer;
  // reading OS consent touches the Windows capability stack each call.
  function captureStatusCached(persisted) {
    if (osMediaOverride()) return captureStatus(persisted);
    const key = [
      persisted && persisted.screen,
      persisted && persisted.mic,
      lastDenied.mic,
    ].join(",");
    if (captureStatusCache && captureStatusCache.key === key && Date.now() - captureStatusCache.at < CAPTURE_STATUS_CACHE_MS) {
      return captureStatusCache.value;
    }
    const value = captureStatus(persisted);
    captureStatusCache = { key, at: Date.now(), value };
    return value;
  }

  let cachedPersistedConsent = null;

  function invalidateSetupStatusCache() {
    cachedPersistedConsent = null;
    captureStatusCache = null;
  }

  function publishSetupStatus(persisted) {
    cachedPersistedConsent = persisted;
    return captureStatus(persisted);
  }

  async function readPersistedConsent() {
    if (cachedPersistedConsent) return cachedPersistedConsent;
    cachedPersistedConsent = await restoreApprovedConsent();
    return cachedPersistedConsent;
  }

  async function resolveSetupStatus() {
    let persisted = await readPersistedConsent();
    let status = captureStatusCached(persisted);
    if (status.ready && !persisted.screen) {
      persisted = await markCaptureApproved(store, "screen");
      cachedPersistedConsent = persisted;
      captureStatusCache = null;
      status = captureStatusCached(persisted);
    }
    return status;
  }

  // The app never writes OS privacy state. Consent is read here and changed
  // by the user in the OS privacy page (see open-capture-settings).
  async function restoreApprovedConsent() {
    const persisted = readCaptureSetup(store);
    if (persisted.screen) captureConsent.screen = true;
    const prefs = osPrefs();
    rememberOsDenied(lastDenied, "mic", prefs);
    if (persisted.mic && !isOsDeniedNow("mic", prefs, lastDenied)) captureConsent.mic = true;
    return persisted;
  }

  // Poll the OS consent until it stops being denied. The user is flipping the
  // switch in OS settings while this runs. cancel-capture-wait ends it early.
  async function waitForOsAccess(kind, timeoutMs) {
    const limit = Math.min(WAIT_ACCESS_MAX_MS, Math.max(waitStepMs, Number(timeoutMs) || 120000));
    const until = Date.now() + limit;
    const gen = ++waitGeneration.mic;
    let stableMs = 0;
    while (true) {
      if (waitGeneration.mic !== gen) return false;
      const decision = waitAccessDecision(kind, osPrefs(), lastDenied, stableMs, {
        stepMs: waitStepMs,
        stableMs: waitStableMs,
      });
      stableMs = decision.stableMs;
      if (decision.done) return decision.ok;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, waitStepMs));
    }
  }

  function cancelOsAccessWait(kind) {
    if (kind !== "mic") return false;
    waitGeneration.mic += 1;
    return true;
  }

  function consentKey(kind) {
    return kind === "mic" ? "mic" : "screen";
  }

  // On macOS this raises the system prompt. On Windows there is nothing to
  // ask; the status comes back as it is.
  async function askOsMediaAccess(kind) {
    if (kind !== "mic") return true;
    if (typeof systemPreferences.askForMediaAccess !== "function") return true;
    try {
      return Boolean(await systemPreferences.askForMediaAccess("microphone"));
    } catch {
      return osMediaOk(kind) !== false;
    }
  }

  function promptCopyForKind(kind) {
    if (kind === "mic") {
      return {
        message: "Simple Recorder wants to use the microphone.",
        detail: "Turn Sound off on the recorder bar if you do not want sound.",
      };
    }
    return {
      message: "Simple Recorder wants to record this screen.",
      detail: "Takes are saved to the Videos folder on this computer.",
    };
  }

  function resetCaptureConsent(kinds) {
    if (!kinds || kinds.all) {
      captureConsent = emptyCaptureConsent();
      invalidateSetupStatusCache();
      return;
    }
    if (kinds.screen) captureConsent.screen = false;
    if (kinds.mic) captureConsent.mic = false;
    invalidateSetupStatusCache();
  }

  function parentWindow(win) {
    if (win && !win.isDestroyed() && !isOverlayWindow(win)) return win;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && !isOverlayWindow(focused)) return focused;
    const all = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed() && !isOverlayWindow(w));
    return all[0];
  }

  async function promptKind(win, kind, opts) {
    const key = consentKey(kind);
    if (SMOKE) {
      captureConsent[key] = true;
      return true;
    }
    // A held consent answers first so the bar does not wait on a sync OS
    // capability read every time a capture opens.
    if (captureConsent[key]) return true;
    if (osMediaOk(key) === true) {
      captureConsent[key] = true;
      return true;
    }
    // Pressing Sound on the recorder bar is the consent. A second Allow or
    // Block box can sit hidden behind the bar, so the OS check is the only ask.
    if (opts && opts.implied && key === "mic") {
      captureConsent[key] = true;
      await askOsMediaAccess(key);
      return true;
    }
    // A prompt already in flight answers for every caller; a second force
    // would stack a hidden Allow/Block behind the first.
    if (capturePrompts[key]) return capturePrompts[key];
    capturePrompts[key] = (async () => {
      const copy = promptCopyForKind(key);
      // A modal child of a hidden or occluded main window is invisible, so
      // the bar sits loading until it times out. Parent only when the window
      // can actually be seen.
      const parent = parentWindow(win);
      const box = {
        type: "question",
        buttons: ["Allow", "Block"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Recorder",
        message: copy.message,
        detail: copy.detail,
      };
      const result =
        parent && !parent.isDestroyed() && parent.isVisible()
          ? await dialog.showMessageBox(parent, box)
          : await dialog.showMessageBox(box);
      const ok = result.response === 0;
      if (ok) {
        captureConsent[key] = true;
        if (key === "mic") await askOsMediaAccess(key);
      }
      return ok;
    })().finally(() => {
      capturePrompts[key] = null;
    });
    return capturePrompts[key];
  }

  function captureSourceKind(id) {
    return String(id).startsWith("window:") ? "window" : "screen";
  }

  function mapCaptureSource(item) {
    const id = String(item.id);
    const kind = captureSourceKind(id);
    return { id, name: item.name || (kind === "window" ? "Window" : "Screen"), kind };
  }

  function mapCaptureSourceWithThumb(item, quality) {
    const mapped = mapCaptureSource(item);
    mapped.thumbnail = sourceThumbData(item.thumbnail, quality);
    return mapped;
  }

  function sourceThumbData(image, quality) {
    if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) return "";
    const q = Number(quality) > 0 ? Number(quality) : THUMBNAIL_JPEG_QUALITY;
    try {
      const jpeg = image.toJPEG(q);
      if (!jpeg || !jpeg.length) return "";
      return "data:image/jpeg;base64," + jpeg.toString("base64");
    } catch {
      try {
        return image.toDataURL() || "";
      } catch {
        return "";
      }
    }
  }

  // On Linux/X11 a screen source's display_id is empty or an id that no
  // Electron display uses. When the screen sources and displays line up one
  // to one, match them by order instead.
  function sourceDisplayId(item, screens, displays) {
    const own = String((item && item.display_id) || "");
    if (own && displays.some((d) => String(d.id) === own)) return own;
    if (!displays.length || screens.length !== displays.length) return own;
    const i = screens.indexOf(item);
    return i >= 0 ? String(displays[i].id) : "";
  }

  // "auto" is the screen under the pointer, the one the user is on. While
  // the recorder bar is up it is the pinned display instead.
  function autoScreenPick(list) {
    const screens = list.filter((item) => String(item && item.id).startsWith("screen:"));
    let displays = [];
    try {
      displays = screen.getAllDisplays();
    } catch {
      displays = [];
    }
    const idOf = (item) => sourceDisplayId(item, screens, displays);
    if (pinnedDisplayId) {
      const pinned = screens.find((item) => idOf(item) === pinnedDisplayId);
      if (pinned) return pinned;
    }
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const id = String(display && display.id);
      return (
        screens.find((item) => idOf(item) === id) ||
        screens.find((item) => item.id === "screen:" + id) ||
        screens[0] ||
        null
      );
    } catch {
      return null;
    }
  }

  // A Window pick frames a crop on the automatic screen: the take keeps
  // recording the display, and the picked window's on-screen rect becomes
  // what is cropped out. Nothing locks into the app's own capture source.
  async function windowScreenCrop(name) {
    const rect = await windowRectByTitle(name);
    if (!rect) return null;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // Window rects are physical pixels; display bounds are DIP.
    const physical = (screen.getAllDisplays() || []).map((display) => {
      const scale = Number(display.scaleFactor) || 1;
      return {
        display,
        scale,
        x: display.bounds.x * scale,
        y: display.bounds.y * scale,
        width: display.bounds.width * scale,
        height: display.bounds.height * scale,
      };
    });
    if (!physical.length) return null;
    const host =
      physical.find(
        (b) => cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height,
      ) ||
      physical
        .map((b) => ({
          b,
          overlap:
            Math.max(0, Math.min(rect.x + rect.width, b.x + b.width) - Math.max(rect.x, b.x)) *
            Math.max(0, Math.min(rect.y + rect.height, b.y + b.height) - Math.max(rect.y, b.y)),
        }))
        .sort((a, z) => z.overlap - a.overlap)[0].b;
    const w = Math.min(1, rect.width / host.width);
    const h = Math.min(1, rect.height / host.height);
    const x = Math.min(1 - w, Math.max(0, (rect.x - host.x) / host.width));
    const y = Math.min(1 - h, Math.max(0, (rect.y - host.y) / host.height));
    return {
      crop: { x, y, w, h },
      displayId: String(host.display.id),
      label: Math.round(rect.width) + " x " + Math.round(rect.height),
    };
  }

  // Auto and area takes record a screen. A stale id (the screen went away)
  // falls back to Auto's screen rather than failing the take.
  function captureSourcePick(sources) {
    const list = Array.isArray(sources) ? sources : [];
    const screens = list.filter((item) => String(item && item.id).startsWith("screen:"));
    const named = preferredCaptureSourceId.startsWith("screen:")
      ? screens.find((item) => item.id === preferredCaptureSourceId)
      : null;
    return named || autoScreenPick(screens) || screens[0] || null;
  }

  function captureSourcesTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timed out")), CAPTURE_SOURCES_MS);
      }),
    ]);
  }

  function getCaptureSources() {
    if (!captureSourcesLock) {
      const gen = captureSourcesGen;
      captureSourcesLock = captureSourcesTimeout(
        desktopCapturer
          .getSources({
            types: CAPTURE_SOURCE_TYPES,
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          })
          .then((sources) => {
            const list = (Array.isArray(sources) ? sources : []).filter(keepCaptureSource);
            if (gen === captureSourcesGen) cachedCaptureSources = list;
            return list;
          }),
      ).finally(() => {
        captureSourcesLock = null;
      });
    }
    return captureSourcesLock;
  }

  function getWindowThumbnails() {
    if (captureThumbnailsLock) return captureThumbnailsLock;
    captureThumbnailsLock = captureSourcesTimeout(
      desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: THUMBNAIL_SIZE,
        fetchWindowIcons: false,
      }),
    )
      .then((sources) =>
        (Array.isArray(sources) ? sources : [])
          .filter(keepCaptureSource)
          .map((item) => mapCaptureSourceWithThumb(item, THUMBNAIL_JPEG_QUALITY)),
      )
      .finally(() => {
        captureThumbnailsLock = null;
      });
    return captureThumbnailsLock;
  }

  async function sourcesForDisplayMedia() {
    // Refresh immediately before a new stream. A cached DesktopCapturerSource
    // can keep pointing at an old/stale screen source after the user changes
    // displays or switches the content shown on the screen.
    try {
      const current = await getCaptureSources();
      if (current.length) return current;
    } catch {
      /* try the last known list below */
    }
    return cachedCaptureSources;
  }

  function registerHandle(channel, handler) {
    if (typeof ipcMain.removeHandler === "function") {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* channel was not registered yet */
      }
    }
    ipcMain.handle(channel, handler);
  }

  function wireMediaCapture(win) {
    if (!win || !win.webContents || !win.webContents.session) return;
    const sess = win.webContents.session;
    if (captureSessionWired && captureSessionRef === sess) return;
    captureSessionWired = true;
    captureSessionRef = sess;
    sess.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      rememberPermission(permission, details);
      return allowCapturePermission(permission);
    });
    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
      rememberPermission(permission, details);
      callback(allowCapturePermission(permission));
    });
    if (typeof sess.setDevicePermissionHandler === "function") {
      sess.setDevicePermissionHandler((details) => {
        const type = String((details && (details.deviceType || details.mediaType)) || "").toLowerCase();
        if (type.includes("hid") || type.includes("serial") || type.includes("usb") || type.includes("bluetooth")) {
          return false;
        }
        return true;
      });
    }
    sess.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const allowed = await promptKind(win, "screen");
        if (!allowed) {
          denyDisplayMedia(callback);
          return;
        }
        let sources = await sourcesForDisplayMedia();
        let picked = captureSourcePick(sources);
        if (!picked) {
          // A transient getSources failure or timeout must not read as a
          // user denial: once more, fresh, before giving up.
          try {
            sources = await getCaptureSources();
            picked = captureSourcePick(sources);
          } catch {
            /* still nothing */
          }
        }
        if (!picked) {
          denyDisplayMedia(callback);
          return;
        }
        callback({ video: picked });
      } catch {
        denyDisplayMedia(callback);
      }
    });
  }

  registerHandle("list-capture-sources", async () => {
    try {
      const sources = await getCaptureSources();
      return sources.map(mapCaptureSource);
    } catch {
      return cachedCaptureSources.map(mapCaptureSource);
    }
  });

  // The studio page's Source box: every screen and recordable window with a
  // small preview. The app's own windows are left out; recording the
  // studio itself is never what the person meant.
  let captureTargetsLock = null;
  function listCaptureTargets() {
    if (captureTargetsLock) return captureTargetsLock;
    const own = new Set();
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) own.add(win.getMediaSourceId());
      } catch {
        /* window going away */
      }
    }
    captureTargetsLock = captureSourcesTimeout(
      desktopCapturer.getSources({
        types: CAPTURE_SOURCE_TYPES,
        thumbnailSize: TARGET_THUMB_SIZE,
        fetchWindowIcons: false,
      }),
    )
      .then((sources) => {
        const list = (Array.isArray(sources) ? sources : []).filter(keepCaptureSource);
        const displays = screen.getAllDisplays();
        const primaryId = String(screen.getPrimaryDisplay().id);
        const screens = [];
        const windows = [];
        const screenSources = list.filter((item) => String(item.id).startsWith("screen:"));
        list.forEach((item) => {
          const id = String(item.id);
          if (own.has(id)) return;
          if (id.startsWith("window:")) {
            windows.push({ id, name: item.name || "Window", thumbnail: sourceThumbData(item.thumbnail, 70) });
            return;
          }
          const displayId = sourceDisplayId(item, screenSources, displays);
          const display = displays.find((d) => String(d.id) === displayId);
          const scale = (display && Number(display.scaleFactor)) || 1;
          screens.push({
            id,
            displayId,
            name: "Screen " + (screens.length + 1),
            label: (display && typeof display.label === "string" && display.label.trim()) || "",
            width: display ? Math.round(display.bounds.width * scale) : 0,
            height: display ? Math.round(display.bounds.height * scale) : 0,
            primary: displayId === primaryId,
            thumbnail: sourceThumbData(item.thumbnail, 70),
          });
        });
        return { screens, windows };
      })
      .finally(() => {
        captureTargetsLock = null;
      });
    return captureTargetsLock;
  }

  registerHandle("list-capture-targets", async () => {
    if (SMOKE) return { screens: [], windows: [] };
    try {
      return await listCaptureTargets();
    } catch {
      return { screens: [], windows: [], error: "Could not list screens and windows." };
    }
  });

  registerHandle("set-capture-source", (_event, payload) => {
    preferredCaptureSourceId = payload && payload.id ? String(payload.id) : "auto";
    return { ok: true };
  });

  // Resolve a picked window's on-screen rect into a normalized crop on the
  // display it sits on. The take stays a screen recording; the window only
  // says what part shows.
  registerHandle("capture-window-frame", async (_event, payload) => {
    if (SMOKE) return { ok: false, error: "smoke" };
    const name = payload && payload.name ? String(payload.name) : "";
    if (!name) return { ok: false, error: "No window named." };
    try {
      const frame = await windowScreenCrop(name);
      return frame ? { ok: true, ...frame } : { ok: false, error: "Window not found on screen." };
    } catch {
      return { ok: false, error: "Could not read the window's position." };
    }
  });

  registerHandle("set-capture-intent", (_event, payload) => {
    const mic = payload && Object.prototype.hasOwnProperty.call(payload, "mic") ? Boolean(payload.mic) : true;
    captureIntent = { source: "screen", mic };
    return { ok: true, intent: captureIntent };
  });

  registerHandle("reset-capture-consent", (_event, payload) => {
    resetCaptureConsent(payload || { all: true });
    return { ok: true };
  });

  registerHandle("capture-setup-status", async () => {
    if (SMOKE) {
      return {
        ready: true,
        screen: { ok: true },
        mic: { ok: true },
        prefs: {
          soundOn: true,
          micDeviceId: "",
          recordTarget: "full",
          recordArea: null,
          recordFps: 30,
          recordDelayMs: 0,
          recordFormat: "mp4",
          recordQuality: "1080p",
          recordAutoStopMs: 0,
          recordDisplayId: "",
          recordAreaDisplayId: "",
        },
      };
    }
    return resolveSetupStatus();
  });

  // Re-read OS consent. On Windows there is nothing to ask; the status comes
  // back as it is.
  registerHandle("ensure-capture-access", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind === "mic") await askOsMediaAccess(kind);
    const persisted = readCaptureSetup(store);
    return publishSetupStatus(persisted);
  });

  registerHandle("open-capture-settings", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    const url = osSettingsUrl(kind, osPlatform());
    if (!url) return { ok: false, status: publishSetupStatus(readCaptureSetup(store)) };
    try {
      await shell.openExternal(url);
    } catch {
      return { ok: false, status: publishSetupStatus(readCaptureSetup(store)) };
    }
    return { ok: true, status: publishSetupStatus(readCaptureSetup(store)) };
  });

  registerHandle("wait-capture-access", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "mic") {
      return { ok: false, status: publishSetupStatus(readCaptureSetup(store)) };
    }
    const ok = await waitForOsAccess(kind, payload && payload.timeoutMs);
    return { ok, status: publishSetupStatus(readCaptureSetup(store)) };
  });

  registerHandle("cancel-capture-wait", async (_event, payload) => {
    const kind = payload && payload.kind ? String(payload.kind) : "";
    return { ok: cancelOsAccessWait(kind) };
  });

  // Renderer saw getUserMedia fail with an OS denial. Windows may still report
  // unknown. Stick the denial so capture-setup-status cannot flip back to ok.
  registerHandle("report-capture-denied", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind === "mic") {
      noteCaptureDenied(lastDenied, kind);
      captureConsent.mic = false;
    }
    const persisted = readCaptureSetup(store);
    return publishSetupStatus(persisted);
  });

  registerHandle("prompt-capture-access", async (event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "screen" && kind !== "mic") {
      return { ok: false, status: publishSetupStatus(readCaptureSetup(store)) };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const ok = await promptKind(parentWindow(win), kind, {
      implied: Boolean(payload && payload.implied),
    });
    if (ok && kind === "mic") {
      await askOsMediaAccess(kind);
    }
    // Screen consent is ours. Mic persists only after the renderer probe
    // succeeds (mark-capture-approved), so an OS block never reads Approved.
    const persisted =
      ok && kind === "screen" ? markCaptureApproved(store, kind) : readCaptureSetup(store);
    const status = publishSetupStatus(persisted);
    const osDenied = ok && kind !== "screen" && Boolean(status[kind] && status[kind].osDenied);
    return { ok, osDenied, status };
  });

  registerHandle("mark-capture-approved", async (_event, payload) => {
    invalidateSetupStatusCache();
    const kind = payload && payload.kind ? String(payload.kind) : "";
    if (kind !== "screen" && kind !== "mic") {
      return publishSetupStatus(readCaptureSetup(store));
    }
    if (kind === "screen") captureConsent.screen = true;
    if (kind === "mic") {
      captureConsent.mic = true;
      clearCaptureDenied(lastDenied, "mic");
    }
    const persisted = markCaptureApproved(store, kind);
    return publishSetupStatus(persisted);
  });

  registerHandle("save-recorder-prefs", async (_event, payload) => {
    invalidateSetupStatusCache();
    const prefs = payload && typeof payload === "object" ? payload : {};
    const next = {};
    if (typeof prefs.soundOn === "boolean") next.soundOn = prefs.soundOn;
    if (typeof prefs.micDeviceId === "string") next.micDeviceId = prefs.micDeviceId;
    if (prefs.recordTarget === "full" || prefs.recordTarget === "area") next.recordTarget = prefs.recordTarget;
    if ("recordArea" in prefs) next.recordArea = prefs.recordArea;
    if (Number.isFinite(Number(prefs.recordFps))) {
      next.recordFps = Math.min(60, Math.max(24, Math.round(Number(prefs.recordFps))));
    }
    if ("recordDelayMs" in prefs) next.recordDelayMs = prefs.recordDelayMs;
    if ("recordFormat" in prefs) next.recordFormat = prefs.recordFormat;
    if ("recordQuality" in prefs) next.recordQuality = prefs.recordQuality;
    if ("recordAutoStopMs" in prefs) next.recordAutoStopMs = prefs.recordAutoStopMs;
    if ("recordDisplayId" in prefs) next.recordDisplayId = prefs.recordDisplayId;
    if ("recordAreaDisplayId" in prefs) next.recordAreaDisplayId = prefs.recordAreaDisplayId;
    const persisted = saveRecorderPrefs(store, next);
    return publishSetupStatus(persisted);
  });

  async function restoreOnReady() {
    if (SMOKE) {
      captureConsent = { screen: true, mic: true };
      return;
    }
    await readPersistedConsent();
  }

  return {
    wireMediaCapture,
    captureSourcePick,
    setPinnedDisplayId(id) {
      pinnedDisplayId = id ? String(id) : "";
    },
    invalidateCaptureSources() {
      cachedCaptureSources = [];
      captureSourcesGen += 1;
    },
    restoreOnReady,
    warmCaptureSources() {
      void getCaptureSources().catch(() => {});
    },
    getCachedCaptureSources() {
      return cachedCaptureSources;
    },
    windowThumbnails() {
      return getWindowThumbnails();
    },
    windowScreenCrop(name) {
      return windowScreenCrop(name);
    },
    getLastDenied() {
      return { mic: lastDenied.mic };
    },
    getLastPermissionKind() {
      return lastPermissionKind;
    },
    getCaptureIntent() {
      return { source: captureIntent.source, mic: captureIntent.mic };
    },
  };
}

module.exports = { attachMediaCapture };
