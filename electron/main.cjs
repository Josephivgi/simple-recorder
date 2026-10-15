const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  screen,
  shell,
  globalShortcut,
} = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const { randomUUID, createHash } = require("crypto");
const { pathToFileURL, fileURLToPath } = require("url");
const { usableWorkArea } = require("../lib/window-bounds");
const { removeRecordingFile } = require("../lib/take-files");
const {
  libraryRoot,
  dayFolderFor,
  dayKeyForTake,
  uniqueTakePath,
  moveFileVerifying,
  adoptLibraryRootName,
  migrateLibrary,
} = require("../lib/library-folders");
const { trackWindow, registerOn, shutdownRegistry } = require("../lib/main-ipc-registry.cjs");
const { frameLooksBlank } = require("../lib/paint-check");

const disposers = [];

function track(target, event, handler) {
  if (!target || typeof target.on !== "function") return;
  target.on(event, handler);
  disposers.push(() => {
    try {
      if (typeof target.removeListener === "function") target.removeListener(event, handler);
    } catch {
      /* target may already be gone */
    }
  });
}

let mainShutdownDone = false;

function shutdownMainProcess() {
  if (mainShutdownDone) return;
  mainShutdownDone = true;
  destroyCountdownOverlay();
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      /* best effort */
    }
  }
  disposers.length = 0;
  shutdownRegistry();
}

// Take playback in the page goes through this scheme; a file:// page cannot
// always pull file:// media.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "take",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
]);

app.setName("Simple Recorder");

if (process.env.REC_USER_DATA) {
  app.setPath("userData", process.env.REC_USER_DATA);
}

// Verification runs point the recordings library at a scratch folder the
// same way REC_USER_DATA points the app data aside.
if (process.env.REC_VIDEOS) {
  app.setPath("videos", process.env.REC_VIDEOS);
}

const SMOKE = process.argv.includes("--smoke");

// Set only by the blank-window recovery below: the relaunch that follows a
// window that never painted runs without GPU acceleration.
const GPU_SAFE_ARG = "--rec-gpu-safe";
const GPU_SAFE = process.argv.includes(GPU_SAFE_ARG);
if (GPU_SAFE) app.disableHardwareAcceleration();

// Exits and crashes are logged to a file that outlives the process.
const CRASH_LOG_MAX = 512 * 1024;
function crashLogPath() {
  try {
    return path.join(app.getPath("userData"), "data", "logs", "main-crash.log");
  } catch {
    return path.join(require("os").tmpdir(), "recorder-main-crash.log");
  }
}
function logCrash(kind, detail) {
  try {
    const file = crashLogPath();
    fssync.mkdirSync(path.dirname(file), { recursive: true });
    const text = String(detail == null ? "" : detail).replace(/\s+/g, " ").slice(0, 4000);
    if (fssync.existsSync(file) && fssync.statSync(file).size > CRASH_LOG_MAX) fssync.truncateSync(file, 0);
    fssync.appendFileSync(file, new Date().toISOString() + " " + kind + " " + text + "\n");
  } catch {
    /* logging must never take the app down */
  }
}
// Recorder bar presses and capture failures. Written async, off the click
// path, so a press that did nothing still leaves a line to read.
const RECORDER_LOG_MAX = 256 * 1024;
let recorderLogChain = Promise.resolve();
function logRecorder(event, detail) {
  const text = detail == null || detail === "" ? "" : " " + String(detail).replace(/\s+/g, " ").slice(0, 500);
  const line = new Date().toISOString() + " " + event + text + "\n";
  recorderLogChain = recorderLogChain.then(async () => {
    try {
      const file = path.join(path.dirname(crashLogPath()), "recorder.log");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const st = await fs.stat(file).catch(() => null);
      if (st && st.size > RECORDER_LOG_MAX) await fs.rename(file, file + ".1");
      await fs.appendFile(file, line);
    } catch {
      /* logging must never take the app down */
    }
  });
}

process.on("uncaughtException", (error) => {
  logCrash("uncaughtException", (error && (error.stack || error.message)) || error);
});
process.on("unhandledRejection", (reason) => {
  logCrash("unhandledRejection", (reason && (reason.stack || reason.message)) || reason);
});

let mediaCapture = null;
let db = null;
let updater = null;
let updatePollTimer = null;

function broadcastUpdateState(state) {
  const win = mainAppWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("update-state", state);
  } catch {
    /* window may be closing */
  }
}

function bootDeferredMain() {
  if (mediaCapture) return;
  db = require("../lib/db");
  db.openDb(dataRoot());
  const { attachMediaCapture } = require("./media-capture.cjs");
  mediaCapture = attachMediaCapture({
    store: db,
    isOverlayWindow: isCountdownOverlay,
    smoke: SMOKE,
  });
  const { createUpdater } = require("../lib/updater");
  const { describeInstall } = require("../lib/install-layout");
  const appRoot = path.join(__dirname, "..");
  // A source checkout never joins the release channel. Every installed copy
  // pings GitHub Releases on its own so the panel can say "New update
  // detected"; applying one is always the Download press.
  const installInfo = describeInstall(appRoot);
  updater = createUpdater({
    appRoot,
    dataRoot: dataRoot(),
    store: db,
    installInfo,
    isBusy: () => Boolean(countdownRecording || countdownArming || inflightTakes.size > 0),
    log: logRecorder,
    onState: onUpdaterState,
  });
  if (
    installInfo.autoCheckDefault &&
    !SMOKE &&
    process.env.REC_DISABLE_AUTO_CHECK !== "1"
  ) {
    armUpdatePoll();
  }
}

// Once a download has landed and the files are swapped, relaunch so the new
// build is the one running: there is nothing else for the user to press.
let updateRestartTimer = null;
function onUpdaterState(state) {
  broadcastUpdateState(state);
  if (!state || state.status !== "installed" || !state.needsRestart || SMOKE) return;
  if (updateRestartTimer) return;
  updateRestartTimer = setTimeout(() => {
    updateRestartTimer = null;
    if (mainShutdownDone) return;
    logRecorder("update relaunch", "auto after install " + (state.currentTag || ""));
    relaunchApp("update " + (state.currentTag || ""), []);
  }, 4000);
}

// Restart through a normal quit, not app.exit: before-quit tears the windows
// down and the GPU and renderer processes exit before the new instance
// starts, so the new window never comes up next to a dying GPU process that
// still holds its caches. A new GPU attempt each time: the safe-mode flag
// only rides the relaunch that asks for it.
function relaunchApp(reason, extraArgs) {
  logCrash("relaunch", reason);
  const args = process.argv.slice(1).filter((arg) => arg !== GPU_SAFE_ARG).concat(extraArgs || []);
  try {
    app.relaunch({ args });
    app.quit();
    // A window that refuses to close must not strand the update half done.
    setTimeout(() => app.exit(0), 8000).unref();
  } catch (error) {
    logCrash("relaunch failed", (error && (error.stack || error.message)) || error);
  }
}

// Background GitHub release checks. Armed at boot for an install so the panel
// can say "New update detected" without anyone asking. A source checkout
// never pings GitHub on its own.
function armUpdatePoll() {
  if (mainShutdownDone || updatePollTimer) return;
  const bootTimer = setTimeout(() => {
    if (!mainShutdownDone && updater) void updater.checkForUpdates({ auto: true });
  }, 3500);
  updatePollTimer = setInterval(() => {
    if (!mainShutdownDone && updater) void updater.checkForUpdates({ auto: true });
  }, 15 * 60 * 1000);
  disposers.push(() => {
    clearTimeout(bootTimer);
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  });
}

function dataRoot() {
  return path.join(app.getPath("userData"), "data");
}

// A take streams to this dir as it records. A renderer crash can never take
// the footage with it: anything left here is adopted as a Recovered take.
function inflightTakesDir() {
  return path.join(dataRoot(), "inflight-takes");
}
const inflightTakes = new Map();

// Finished takes land in the user's Videos folder, matching the consent
// copy ("Takes are saved to the Videos folder"). Everything sits under the
// one "Simple recorder" folder, grouped into a folder per day inside it, so
// the library reads like a camera roll in Explorer.
function recordingsDir() {
  let videos = "";
  try {
    videos = app.getPath("videos");
  } catch {
    videos = "";
  }
  return libraryRoot(videos, app.getPath("userData"));
}

// The day folder a take written at `when` belongs in, created if missing.
async function takeDayDir(when) {
  const dir = dayFolderFor(recordingsDir(), when);
  await ensureDir(dir);
  return dir;
}

// One layout sweep at a time: boot and the first takes-list can reach this
// together. The sweep itself is idempotent, so a second caller only has to
// wait for the first instead of moving the same file twice.
let libraryLayoutInflight = null;
function ensureLibraryLayout() {
  if (libraryLayoutInflight) return libraryLayoutInflight;
  libraryLayoutInflight = migrateLibraryLayout()
    .catch((error) => {
      logRecorder("library layout failed", (error && error.message) || error);
    })
    .finally(() => {
      libraryLayoutInflight = null;
    });
  return libraryLayoutInflight;
}

async function migrateLibraryLayout() {
  if (!db) return;
  const root = recordingsDir();
  const renamed = await adoptLibraryRootName(path.dirname(root), path.basename(root)).catch(() => null);
  if (renamed && renamed.renamed) logRecorder("library folder renamed", root);
  // The widest take window the index will hand out, so a loose take older
  // than the recent list still moves into its day folder.
  const result = await migrateLibrary(root, db.listTakes(200), { log: logRecorder });
  // A row can hold a spelling of its own file that no longer matches disk,
  // because the library folder was renamed for casing. Fix that before the
  // moves, so a take that both drifted and moved ends on its new path.
  for (const row of result.repointed) {
    db.updateTakeFile(row.id, row.to, path.basename(row.to, path.extname(row.to)));
  }
  for (const move of result.moves) {
    db.updateTakeFile(move.id, move.to, move.name);
    logRecorder("take moved", move.name);
  }
  for (const adopted of result.adopted) logRecorder("take adopted", adopted.to);
  for (const miss of result.failed) logRecorder("take left in place", miss.from + ": " + miss.error);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function bufferFromPayload(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (Array.isArray(input)) return Buffer.from(input);
  return null;
}

function displayWorkArea(bounds) {
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  return usableWorkArea(display.workArea, display.bounds);
}

const COUNTDOWN_OVERLAY_WIDTH = 208;
const COUNTDOWN_OVERLAY_HEIGHT = 92;
const COUNTDOWN_WAIT_WIDTH = 240;
const COUNTDOWN_RECORD_WIDTH = 288;
const COUNTDOWN_WAIT_HEIGHT = 108;
const COUNTDOWN_BAR_HEIGHT = 52;
const BAR_MIN_WIDTH = 640;
const BAR_MAX_WIDTH = 860;
const AREA_MIN_PX = 32;
const RECORDER_PREWARM_DELAY_MS = 2500;
const RECORDER_PREWARM_STEP_MS = 700;
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
const OVERLAY_FILE = path.join(__dirname, "..", "renderer", "overlay.html");

let countdownOverlay = null;
// The take outline is four thin opaque windows, not one transparent window
// spanning the take: per-pixel alpha on a screen-sized always-on-top window
// was the biggest steady DWM cost of an area take.
let countdownFrameStrips = [];
let countdownTakeRect = null;
let areaPickerWin = null;
let areaPickerReady = false;
let areaPickerBounds = null;
// The bar only shows once its page has painted; until then the window is
// invisible so it cannot eat clicks.
let countdownOverlayLoaded = false;
// A dead bar rebuilds itself mid-session, but a renderer that keeps dying
// must not loop create/destroy forever.
let barRebuildTries = 0;
// The bar and the take stay on the display the bar opened on, even if the
// pointer moves to another screen mid-session.
let countdownDisplayId = 0;
// finishCountdown tears the setup state down before the page turns the take
// on; the recording card keeps the display the take is on.
let recordingPinStash = 0;
let recordingPinStashAt = 0;
// The picker reports whether a drag or a pinned corner is in flight so a
// stray focus loss does not destroy the pick.
let areaPickerGesture = false;
let pickerBlurTimer = null;
let countdownCaptureReady = true;
let placingOverlay = false;
let countdownTimer = null;
let countdownGen = 0;
let countdownSender = null;
let countdownThrottled = null;
let countdownSenderWatch = null;
let countdownLeftMs = 0;
let countdownEndsAt = 0;
let countdownWait = false;
let countdownSize = false;
// What the take covers: the screen under the pointer (Auto), a dragged area
// of it, or the one window picked on the bar.
let countdownTarget = "auto";
let countdownSizeCrop = null;
let areaPicker = null;
let countdownAreaDisplayId = 0;
let countdownDelayMs = 0;
let countdownDelayLabel = "Off";
let countdownFps = 30;
let countdownMicOn = false;
let countdownMicNote = "";
let countdownArming = false;
let countdownArmingAt = 0;
let overlayClickThrough = true;
let countdownRecording = false;
let countdownStartedAt = 0;
// Pause freezes the card clock at the same point the take freezes.
let countdownPaused = false;
let countdownPausedAt = 0;
let countdownPausedTotal = 0;
// A window pick frames a crop on the screen; the name labels the bar.
let countdownWindowName = "";
// The picker window doubles as the window list; this says which it shows.
let pickerMode = "area";

// A Stop that still lands while another app has focus. Only registered
// while a take is rolling so it never steals the chord from other apps.
const RECORD_STOP_ACCELERATOR = "CommandOrControl+Shift+Alt+S";

function registerRecordStopHotkey() {
  try {
    globalShortcut.unregister(RECORD_STOP_ACCELERATOR);
    globalShortcut.register(RECORD_STOP_ACCELERATOR, () => {
      if (!countdownRecording) return;
      logRecorder("stop hotkey", barStateText());
      stopOverlayKeepDesktop("recording-overlay-stop", { reason: "hotkey" });
    });
  } catch (error) {
    logRecorder("stop hotkey register failed", (error && error.message) || error);
  }
}

function unregisterRecordStopHotkey() {
  try {
    globalShortcut.unregister(RECORD_STOP_ACCELERATOR);
  } catch (_) {}
}

function pausedMsExtra() {
  return countdownPausedTotal + (countdownPaused ? Date.now() - countdownPausedAt : 0);
}

function setRecordingPaused(paused) {
  const next = Boolean(paused);
  if (next === countdownPaused) return;
  countdownPaused = next;
  if (next) countdownPausedAt = Date.now();
  else countdownPausedTotal += Date.now() - countdownPausedAt;
  paintCountdownOverlay();
}

function formatOverlayClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}

function isCountdownOverlay(win) {
  return Boolean(
    win &&
      ((countdownOverlay && win === countdownOverlay) ||
        countdownFrameStrips.includes(win) ||
        (areaPicker && win === areaPicker) ||
        (areaPickerWin && win === areaPickerWin)),
  );
}

// On X11 blur() deactivates by lowering the window, which dropped the bar
// under the app window. The bar is not focusable there, so skip it.
function blurOverlay(win) {
  if (!win || win.isDestroyed() || process.platform === "linux") return;
  try {
    win.blur();
  } catch (_) {}
}

function displayForCountdown() {
  const displays = screen.getAllDisplays();
  // While an overlay session is up the display is pinned; the bar must not
  // teleport to the cursor's screen between presses.
  if (countdownDisplayId) {
    const pinned = displays.find((item) => item.id === countdownDisplayId);
    if (pinned) return pinned;
  }
  // Area stays on the display where it was picked.
  if (countdownTarget === "area" && countdownAreaDisplayId) {
    const hit = displays.find((item) => item.id === countdownAreaDisplayId);
    if (hit) return hit;
  }
  // Auto follows the user: the screen under the pointer is the screen in use.
  if (countdownTarget === "auto") {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (_) {}
  }
  const src = mediaCapture ? mediaCapture.captureSourcePick(mediaCapture.getCachedCaptureSources()) : null;
  const displayId = src && src.display_id;
  if (displayId != null && displayId !== "") {
    const hit = displays.find((item) => String(item.id) === String(displayId));
    if (hit) return hit;
  }
  const main = BrowserWindow.getAllWindows().find((win) => !isCountdownOverlay(win) && !win.isDestroyed());
  if (main) return screen.getDisplayMatching(main.getBounds());
  return screen.getPrimaryDisplay();
}

function overlayCropFromBounds(bounds) {
  const display = displayForCountdown();
  const area = display && display.bounds;
  if (!bounds || !area || !area.width || !area.height) return null;
  const left = Math.max(bounds.x, area.x);
  const top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width);
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  return {
    x: (left - area.x) / area.width,
    y: (top - area.y) / area.height,
    w: w / area.width,
    h: h / area.height,
  };
}

function intersectRect(a, b) {
  if (!a || !b) return null;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

function applyCropToRect(rect, crop) {
  if (!rect || !crop) return rect;
  const w = Number(crop.w);
  const h = Number(crop.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return rect;
  const x = Number(crop.x);
  const y = Number(crop.y);
  return {
    x: Math.round(rect.x + (Number.isFinite(x) ? x : 0) * rect.width),
    y: Math.round(rect.y + (Number.isFinite(y) ? y : 0) * rect.height),
    width: Math.round(w * rect.width),
    height: Math.round(h * rect.height),
  };
}

function countdownOverlayBounds() {
  const display = displayForCountdown();
  const work = usableWorkArea(display.workArea, display.bounds);
  if (!countdownSize) {
    const width = countdownRecording ? COUNTDOWN_RECORD_WIDTH : countdownWait ? COUNTDOWN_WAIT_WIDTH : COUNTDOWN_OVERLAY_WIDTH;
    const height = countdownWait || countdownRecording ? COUNTDOWN_WAIT_HEIGHT : COUNTDOWN_OVERLAY_HEIGHT;
    return {
      x: Math.round(work.x + (work.width - width) / 2),
      y: Math.round(work.y + 16),
      width,
      height,
    };
  }
  if (countdownTarget === "area" && countdownSizeCrop) {
    const rect = intersectRect(applyCropToRect(display.bounds, countdownSizeCrop), display.bounds);
    if (rect) return rect;
  }
  return { ...display.bounds };
}

function setSenderThrottling(enabled) {
  if (!countdownThrottled || countdownThrottled.isDestroyed()) return;
  try {
    countdownThrottled.setBackgroundThrottling(enabled);
  } catch (_) {}
}

function overlayStatePayload() {
  const wait = countdownWait;
  const size = countdownSize;
  const recording = countdownRecording;
  const mode = recording ? "recording" : size ? "size" : wait ? "wait" : "timer";
  const label = recording ? "Recording" : size ? "This line is the take" : wait ? "Record when ready" : "Starts in";
  const clock =
    countdownArming || recording || (!wait && !size) ? formatOverlayClock(countdownLeftMs) : "";
  return {
    mode,
    target: countdownTarget,
    framed: Boolean(countdownWindowName),
    areaLabel: countdownWindowName || areaSizeLabel(),
    arming: countdownArming,
    loading: size && !recording && !countdownCaptureReady,
    clock,
    label: recording && countdownPaused ? "Paused" : label,
    paused: countdownPaused,
    delayLabel: countdownDelayLabel,
    fps: countdownFps,
    micOn: countdownMicOn,
    micLabel: countdownMicNote || (countdownMicOn ? "On" : "Off"),
  };
}

let lastOverlayPaintKey = "";

function paintCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  const state = overlayStatePayload();
  const key = JSON.stringify(state);
  if (key === lastOverlayPaintKey) return;
  lastOverlayPaintKey = key;
  try {
    countdownOverlay.webContents.send("overlay-state", state);
  } catch (_) {}
}

function emitCountdownTick() {
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("countdown-tick", { leftMs: countdownLeftMs });
  }
}

function emitOverlayBounds() {
  if (!countdownSize || !countdownSender || countdownSender.isDestroyed()) return;
  const take = countdownTarget === "area" ? countdownTakeRect : null;
  const crop = take ? overlayCropFromBounds(take) : FULL_CROP;
  if (crop) countdownSender.send("countdown-bounds", { crop });
}

function passClicksThrough(win, pass) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(Boolean(pass));
  } catch (_) {}
}

function applyOverlayClickThrough() {
  for (const strip of countdownFrameStrips) passClicksThrough(strip, true);
  passClicksThrough(countdownOverlay, false);
}

function startOverlayDelayThenRecord() {
  const ms = Math.max(0, Math.round(Number(countdownDelayMs) || 0));
  if (ms <= 0) {
    finishCountdown(countdownGen);
    return;
  }
  countdownArming = true;
  countdownArmingAt = Date.now();
  overlayClickThrough = true;
  countdownLeftMs = ms;
  countdownEndsAt = Date.now() + ms;
  const gen = countdownGen;
  clearInterval(countdownTimer);
  paintCountdownOverlay();
  applyOverlayClickThrough();
  countdownTimer = setInterval(() => {
    try {
      if (gen !== countdownGen) return;
      countdownLeftMs = Math.max(0, countdownEndsAt - Date.now());
      paintCountdownOverlay();
      if (countdownLeftMs > 0) return;
      finishCountdown(gen);
    } catch (error) {
      logCrash("countdown tick", (error && (error.stack || error.message)) || error);
    }
  }, 250);
}

function hideCountdownOverlay() {
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  hideFrameStrips();
}

function mainAppWindow() {
  return (
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !isCountdownOverlay(win)) || null
  );
}

function hideOverlayWithoutRaisingMain() {
  const main = mainAppWindow();
  const lock = process.platform === "win32" && main && !main.isDestroyed() && !main.isFocused();
  if (lock) {
    try {
      main.setFocusable(false);
    } catch (_) {}
  }
  hideCountdownOverlay();
  if (lock) {
    setImmediate(() => {
      if (!main || main.isDestroyed()) return;
      try {
        main.setFocusable(true);
      } catch (_) {}
    });
  }
}

function overlaySender() {
  return countdownSender && !countdownSender.isDestroyed() ? countdownSender : null;
}

function stopOverlayKeepDesktop(message, payload) {
  const sender = overlaySender();
  stopCountdownOverlay();
  if (sender) sender.send(message, payload || {});
}

function closeRecorderBar(reason) {
  if (countdownRecording) {
    stopOverlayKeepDesktop("recording-overlay-stop", { reason: reason || "close" });
    return;
  }
  stopOverlayKeepDesktop("countdown-overlay-closed", { reason: reason || "close" });
}

// Auto or a dragged area. Both record the screen the bar sits on.
function applyOverlayTarget(target, crop) {
  countdownWindowName = "";
  countdownTarget = target === "area" && crop ? "area" : "auto";
  countdownSizeCrop = countdownTarget === "area" ? crop : null;
  if (countdownTarget !== "area") countdownAreaDisplayId = 0;
  countdownTakeRect = null;
  placeCountdownOverlay();
  raiseCountdownOverlay();
  paintCountdownOverlay();
  const sender = overlaySender();
  if (sender) {
    sender.send("overlay-set-target", {
      target: countdownTarget,
      crop: countdownSizeCrop || FULL_CROP,
      displayId: countdownTarget === "area" ? String(countdownAreaDisplayId || countdownDisplayId || "") : "",
    });
  }
}

function displayById(id) {
  const want = String(id == null ? "" : id);
  if (!want) return null;
  return screen.getAllDisplays().find((item) => String(item.id) === want) || null;
}

// An area pick started from the studio page, before any bar is open. The
// picker answers the page directly instead of the bar session.
let pageAreaPick = null;

function takePageAreaPick() {
  const pick = pageAreaPick;
  pageAreaPick = null;
  return pick;
}

function settlePageAreaPick(pick, result) {
  if (!pick) return;
  if (pick.minimized && pick.main && !pick.main.isDestroyed()) {
    try {
      pick.main.restore();
      pick.main.focus();
    } catch (_) {}
  }
  pick.resolve(result ? { ok: true, ...result } : { ok: false });
}

// The picker reports a rect in its own window space; this maps it onto the
// display and drops anything too small or off screen.
function pickedScreenRect(origin, r, bounds) {
  const ok =
    r &&
    [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(Number(n))) &&
    Number(r.width) >= AREA_MIN_PX &&
    Number(r.height) >= AREA_MIN_PX;
  if (!ok) return null;
  return intersectRect(
    {
      x: Math.round(origin.x + Number(r.x)),
      y: Math.round(origin.y + Number(r.y)),
      width: Math.round(Number(r.width)),
      height: Math.round(Number(r.height)),
    },
    bounds,
  );
}

function cropOfRect(rect, b) {
  return {
    x: (rect.x - b.x) / b.width,
    y: (rect.y - b.y) / b.height,
    w: rect.width / b.width,
    h: rect.height / b.height,
  };
}

function closeAreaPicker() {
  settlePageAreaPick(takePageAreaPick(), null);
  const win = areaPicker;
  areaPicker = null;
  areaPickerGesture = false;
  clearTimeout(pickerBlurTimer);
  pickerBlurTimer = null;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("area-pick-reset", { mode: pickerMode });
  } catch (_) {}
  win.hide();
}

function showAreaPicker(win) {
  if (!win || win.isDestroyed() || areaPicker !== win) return;
  areaPickerGesture = false;
  try {
    win.webContents.send("area-pick-reset", { mode: pickerMode });
  } catch (_) {}
  try {
    win.setAlwaysOnTop(true, "screen-saver");
  } catch (_) {}
  if (areaPickerBounds) win.setBounds(areaPickerBounds);
  try {
    win.setContentProtection(true);
  } catch (_) {}
  win.show();
  try {
    win.moveTop();
  } catch (_) {}
  win.focus();
  if (pickerMode === "windows") sendWindowPickList(win);
}

// The picker window is built once, kept hidden, and reused. Building it on
// every Area press blocked the main process for over a second.
function ensureAreaPickerWindow() {
  if (areaPickerWin && !areaPickerWin.isDestroyed()) return areaPickerWin;
  const b = areaPickerBounds || displayForCountdown().bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: "Recorder area",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  areaPickerWin = win;
  areaPickerReady = false;
  trackWindow(win, "area-pick");
  try {
    win.setContentProtection(true);
  } catch (_) {}
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    logCrash("area picker renderer gone", details && details.reason);
    const active = areaPicker === win;
    if (active) {
      areaPicker = null;
      areaPickerGesture = false;
    }
    if (!win.isDestroyed()) win.destroy();
    if (active && countdownSize) raiseCountdownOverlay();
  });
  const markReady = () => {
    if (win.isDestroyed()) return;
    areaPickerReady = true;
    showAreaPicker(win);
  };
  win.once("ready-to-show", markReady);
  // ready-to-show can be flaky for hidden transparent windows; the bar has
  // the same belt-and-suspenders.
  win.webContents.on("did-finish-load", markReady);
  // Switching away (Alt+Tab, Start menu) cancels the pick and brings the bar
  // back instead of leaving a dim layer over the screen. The cancel waits a
  // beat: a click on another monitor also blurs, and it must not destroy a
  // drag or a pinned corner that is in progress.
  win.on("blur", () => {
    if (areaPicker !== win) return;
    schedulePickerBlurCancel(win, 0);
  });
  win.on("closed", () => {
    if (areaPickerWin === win) {
      areaPickerWin = null;
      areaPickerReady = false;
    }
    if (areaPicker !== win) return;
    areaPicker = null;
    areaPickerGesture = false;
    if (countdownSize) raiseCountdownOverlay();
  });
  win.loadFile(OVERLAY_FILE, { query: { role: "pick" } }).catch((error) => {
    logCrash("area picker load", (error && error.message) || error);
    const active = areaPicker === win;
    if (active) {
      areaPicker = null;
      areaPickerGesture = false;
    }
    if (!win.isDestroyed()) win.destroy();
    if (active) raiseCountdownOverlay();
  });
  return win;
}

function schedulePickerBlurCancel(win, tries) {
  clearTimeout(pickerBlurTimer);
  pickerBlurTimer = setTimeout(() => {
    pickerBlurTimer = null;
    if (areaPicker !== win || win.isDestroyed() || win.isFocused()) return;
    // A drag or a pinned corner in progress survives the focus loss; check
    // again shortly. Bounded so a stuck flag still ends the pick.
    if (areaPickerGesture && tries < 30) {
      schedulePickerBlurCancel(win, tries + 1);
      return;
    }
    closeAreaPicker();
    if (countdownSize) raiseCountdownOverlay();
  }, 500);
}

// A dimmed full screen layer on the bar's display. Drag a box to pick the
// take area; Cancel, Esc, or switching away keeps the old one.
function openAreaPicker() {
  // Every press resets and shows the picker again, so a leftover pick
  // (hidden or behind another window) never eats a later Area press.
  closeAreaPicker();
  pickerMode = "area";
  areaPickerBounds = displayForCountdown().bounds;
  hideFrameStrips();
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  const win = ensureAreaPickerWindow();
  areaPicker = win;
  if (areaPickerReady) showAreaPicker(win);
}

// The same fullscreen picker doubles as the window list for a Window take.
// The list itself is fetched here so the page never talks to desktopCapturer.
function openWindowPicker() {
  closeAreaPicker();
  pickerMode = "windows";
  areaPickerBounds = displayForCountdown().bounds;
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.hide();
  const win = ensureAreaPickerWindow();
  areaPicker = win;
  if (areaPickerReady) showAreaPicker(win);
  sendWindowPickList(win);
}

function sendWindowPickList(win) {
  if (!win || win.isDestroyed() || !mediaCapture || typeof mediaCapture.windowThumbnails !== "function") return;
  mediaCapture
    .windowThumbnails()
    .then((windows) => {
      if (areaPicker !== win || win.isDestroyed()) return;
      win.webContents.send("pick-windows", { windows: Array.isArray(windows) ? windows : [] });
    })
    .catch(() => {
      if (areaPicker !== win || win.isDestroyed()) return;
      win.webContents.send("pick-windows", { windows: [] });
    });
}

function onWindowPicked(event, payload) {
  const win = areaPicker;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  closeAreaPicker();
  if (!countdownSize || countdownRecording || countdownArming) {
    raiseCountdownOverlay();
    return;
  }
  const id = payload && payload.id ? String(payload.id) : "";
  if (!id.startsWith("window:")) {
    logRecorder("window pick cancelled", "");
    raiseCountdownOverlay();
    return;
  }
  logRecorder("window picked", String(payload.name || "").slice(0, 60));
  void applyWindowTarget(payload && payload.name ? String(payload.name) : "");
}

// A Window pick frames a crop on the screen: the take keeps recording the
// display, and the picked window's rect becomes what is cropped out. The
// rect comes from a Windows probe (about a second), then the pick walks the
// same path as a dragged area.
async function applyWindowTarget(name) {
  const label = String(name || "").slice(0, 120);
  let frame = null;
  try {
    if (mediaCapture && typeof mediaCapture.windowScreenCrop === "function") {
      frame = await mediaCapture.windowScreenCrop(label);
    }
  } catch (_) {}
  if (!frame || !frame.crop) {
    logRecorder("window frame failed", label.slice(0, 60));
    placeCountdownOverlay();
    raiseCountdownOverlay();
    paintCountdownOverlay();
    return;
  }
  logRecorder("window framed", label.slice(0, 60));
  countdownAreaDisplayId = Number(frame.displayId) || 0;
  applyOverlayTarget("area", frame.crop);
  // The bar names a framed window; applyOverlayTarget cleared it as part
  // of the generic area switch.
  countdownWindowName = label;
  paintCountdownOverlay();
}

// Building an overlay window blocks the main process for about a second,
// and the bar needs three (bar, area outline, area picker). Built on the
// first Start, that was the 5 second wait. They are built hidden, one at a
// time, soon after launch, so Start Recorder Bar and Area only show them.
let recorderPrewarmTimer = null;
function prewarmRecorderWindows() {
  if (recorderPrewarmTimer || mainShutdownDone || SMOKE) return;
  const steps = [
    () => {
      if (mediaCapture && typeof mediaCapture.warmCaptureSources === "function") mediaCapture.warmCaptureSources();
    },
    ensureCountdownOverlay,
    ensureCountdownFrame,
    ensureAreaPickerWindow,
  ];
  const next = () => {
    recorderPrewarmTimer = null;
    if (mainShutdownDone || !mainAppWindow()) return;
    const step = steps.shift();
    if (!step) return;
    try {
      step();
    } catch (error) {
      logCrash("recorder prewarm", (error && (error.stack || error.message)) || error);
    }
    if (steps.length) recorderPrewarmTimer = setTimeout(next, RECORDER_PREWARM_STEP_MS);
  };
  recorderPrewarmTimer = setTimeout(next, 0);
}

function onAreaPicked(event, payload) {
  const win = areaPicker;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const origin = win.getBounds();
  const pagePick = takePageAreaPick();
  closeAreaPicker();
  const r = payload && payload.rect;
  if (pagePick) {
    const b = pagePick.display.bounds;
    const rect = pickedScreenRect(origin, r, b);
    logRecorder(rect ? "page area picked" : "page area cancelled", rect ? rect.width + "x" + rect.height : "");
    const scale = Number(pagePick.display.scaleFactor) || 1;
    settlePageAreaPick(
      pagePick,
      rect
        ? {
            crop: cropOfRect(rect, b),
            displayId: String(pagePick.display.id),
            label: Math.round(rect.width * scale) + " x " + Math.round(rect.height * scale),
          }
        : null,
    );
    return;
  }
  if (!countdownSize || countdownRecording || countdownArming) return;
  const display = displayForCountdown();
  const b = display.bounds;
  const rect = pickedScreenRect(origin, r, b);
  if (!rect) {
    logRecorder("area cancelled", r ? "outside the screen" : "");
    raiseCountdownOverlay();
    return;
  }
  logRecorder("area picked", rect.width + "x" + rect.height);
  countdownAreaDisplayId = display.id;
  applyOverlayTarget("area", cropOfRect(rect, b));
}

// Draw area from the studio page. The studio window steps aside (minimized)
// on the screen being framed, the picker covers that screen, and the pick
// resolves this call. A bar session owns the picker, so it says busy.
function startPageAreaPick(event, payload) {
  return new Promise((resolve) => {
    if (countdownSize || countdownWait || countdownRecording || countdownArming || countdownTimer) {
      resolve({ ok: false, busy: true });
      return;
    }
    closeAreaPicker();
    const main = BrowserWindow.fromWebContents(event.sender);
    const display =
      displayById(payload && payload.displayId) ||
      (main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay());
    const pick = { resolve, display, main, minimized: false };
    pageAreaPick = pick;
    pickerMode = "area";
    areaPickerBounds = display.bounds;
    hideFrameStrips();
    if (main && !main.isDestroyed() && screen.getDisplayMatching(main.getBounds()).id === display.id) {
      try {
        main.minimize();
        pick.minimized = true;
      } catch (_) {}
    }
    const win = ensureAreaPickerWindow();
    areaPicker = win;
    // Let the minimize settle first so it cannot pull focus off the picker
    // (a focus loss cancels the pick).
    setTimeout(() => {
      if (pageAreaPick !== pick || areaPicker !== win) return;
      if (areaPickerReady) showAreaPicker(win);
    }, pick.minimized ? 250 : 0);
  });
}

let areaLabelCache = { key: "", value: "" };
function areaSizeLabel() {
  if (countdownTarget !== "area" || !countdownTakeRect) return "";
  const r = countdownTakeRect;
  const key = r.x + "," + r.y + "," + r.width + "," + r.height;
  if (areaLabelCache.key === key) return areaLabelCache.value;
  // Display enumeration is a sync OS call; the label only changes on a new
  // pick, so keep the answer instead of re-reading it every paint.
  const scale = Number(displayForCountdown().scaleFactor) || 1;
  const value = Math.round(r.width * scale) + " x " + Math.round(r.height * scale);
  areaLabelCache = { key, value };
  return value;
}

// Anything that maps a hidden overlay outside the show paths (a window
// manager remap, a stray focus event) leaves an invisible full-screen click
// eater. Re-hide any overlay the session state says should not be up.
function hideStrayOverlays() {
  if (areaPickerWin && !areaPickerWin.isDestroyed() && areaPickerWin.isVisible() && areaPicker !== areaPickerWin) {
    areaPickerWin.hide();
  }
  const sessionUp =
    countdownSize ||
    countdownWait ||
    countdownRecording ||
    countdownArming ||
    countdownTimer ||
    countdownEndsAt;
  if (countdownOverlay && !countdownOverlay.isDestroyed() && countdownOverlay.isVisible() && !sessionUp) {
    countdownOverlay.hide();
  }
  if (countdownFrameStrips.some((win) => win && !win.isDestroyed() && win.isVisible())) {
    const needFrame = countdownSize && countdownTarget === "area" && !areaPicker;
    if (!needFrame) hideFrameStrips();
  }
}

function stopCountdownOverlay() {
  const hadOverlay =
    countdownTimer ||
    countdownWait ||
    countdownSize ||
    countdownRecording ||
    countdownArming ||
    countdownSender ||
    countdownThrottled ||
    countdownDisplayId ||
    (countdownOverlay && !countdownOverlay.isDestroyed() && countdownOverlay.isVisible());
  if (!hadOverlay) return;
  countdownGen += 1;
  clearInterval(countdownTimer);
  countdownTimer = null;
  setSenderThrottling(true);
  countdownThrottled = null;
  countdownSender = null;
  countdownEndsAt = 0;
  countdownLeftMs = 0;
  countdownWait = false;
  countdownSize = false;
  countdownTarget = "auto";
  countdownSizeCrop = null;
  countdownAreaDisplayId = 0;
  countdownDisplayId = 0;
  recordingPinStash = 0;
  recordingPinStashAt = 0;
  if (mediaCapture && typeof mediaCapture.setPinnedDisplayId === "function") {
    mediaCapture.setPinnedDisplayId(null);
  }
  closeAreaPicker();
  countdownDelayMs = 0;
  countdownDelayLabel = "Off";
  countdownFps = 30;
  countdownMicOn = false;
  countdownMicNote = "";
  countdownArming = false;
  countdownArmingAt = 0;
  overlayClickThrough = true;
  countdownRecording = false;
  countdownPaused = false;
  countdownPausedAt = 0;
  countdownPausedTotal = 0;
  countdownWindowName = "";
  unregisterRecordStopHotkey();
  countdownCaptureReady = true;
  countdownStartedAt = 0;
  countdownTakeRect = null;
  areaLabelCache = { key: "", value: "" };
  overlayDragPending = null;
  hideOverlayWithoutRaisingMain();
  hideStrayOverlays();
}

// A crashed or reloaded page never fires webContents 'destroyed'. Without
// this the bar keeps counting a take that no longer exists and the inflight
// file is only adopted on the next launch.
function onRecorderPageGone(sender) {
  if (!sender) return;
  if (countdownSender === sender) {
    logRecorder("page gone", "tearing down the recorder bar");
    stopCountdownOverlay();
  }
  for (const entry of inflightTakes.values()) {
    if (entry && entry.sender === sender && entry.onDead) entry.onDead();
  }
}

function destroyCountdownOverlay() {
  stopCountdownOverlay();
  if (countdownOverlay && !countdownOverlay.isDestroyed()) countdownOverlay.destroy();
  countdownOverlay = null;
  lastOverlayPaintKey = "";
  destroyFrameStrips();
  if (areaPickerWin && !areaPickerWin.isDestroyed()) areaPickerWin.destroy();
  areaPickerWin = null;
  areaPickerReady = false;
}

function finishCountdown(gen) {
  if (gen !== countdownGen) return;
  const sender = countdownSender;
  // A full-screen take records the whole source; only a crop sends a crop.
  let crop = null;
  if (countdownSize) {
    const take = countdownTarget === "area" ? countdownTakeRect || countdownOverlayBounds() : null;
    crop = (take && overlayCropFromBounds(take)) || FULL_CROP;
  }
  const keepPin = countdownDisplayId;
  stopCountdownOverlay();
  recordingPinStash = keepPin;
  // The recording card start lands right after this; a stale stash must not
  // survive to an unrelated take.
  recordingPinStashAt = Date.now();
  if (sender && !sender.isDestroyed()) sender.send("countdown-finished", crop ? { crop } : {});
}

function barBoundsFor(_take) {
  const display = displayForCountdown();
  const work = usableWorkArea(display.workArea, display.bounds);
  const height = COUNTDOWN_BAR_HEIGHT;
  const width = Math.max(
    Math.min(BAR_MAX_WIDTH, work.width),
    Math.min(BAR_MIN_WIDTH, work.width),
  );
  let x = Math.round(work.x + (work.width - width) / 2);
  x = Math.max(work.x, Math.min(work.x + work.width - width, x));
  return { x, y: work.y, width, height };
}

function placeCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  if (placingOverlay) return;
  placingOverlay = true;
  try {
    if (countdownSize) {
      const take = countdownTakeRect || countdownOverlayBounds();
      countdownTakeRect = take;
      if (countdownTarget === "area") {
        layoutFrameStrips(take);
      } else {
        hideFrameStrips();
      }
      countdownOverlay.setBounds(barBoundsFor(take));
    } else {
      countdownTakeRect = null;
      hideFrameStrips();
      countdownOverlay.setBounds(countdownOverlayBounds());
    }
  } finally {
    placingOverlay = false;
  }
}

function raiseOverlayWindow(win, clickThrough) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, "screen-saver");
  } catch (_) {}
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  try {
    win.setContentProtection(true);
  } catch (_) {}
  try {
    win.setResizable(false);
  } catch (_) {}
  try {
    win.setFocusable(false);
  } catch (_) {}
  passClicksThrough(win, clickThrough);
  win.showInactive();
  try {
    win.moveTop();
  } catch (_) {}
  // Showing can reset the mouse style on Windows; set it again.
  passClicksThrough(win, clickThrough);
  blurOverlay(win);
}

function raiseCountdownOverlay() {
  if (!countdownOverlay || countdownOverlay.isDestroyed()) return;
  // The picker owns the screen while open, and a bar whose page has not
  // painted yet is an invisible click eater. Both shows happen later:
  // onAreaPicked re-raises after the picker closes, and did-finish-load /
  // ready-to-show raise once the page is up.
  if (areaPicker || !countdownOverlayLoaded) return;
  try {
    if (countdownSize) countdownOverlay.setMinimumSize(320, COUNTDOWN_BAR_HEIGHT);
    else countdownOverlay.setMinimumSize(COUNTDOWN_OVERLAY_WIDTH, COUNTDOWN_OVERLAY_HEIGHT);
  } catch (_) {}
  // The area outline goes up first so the bar always sits above it. An area
  // that starts at the top of the screen puts the outline under the bar, and
  // on Windows an outline above the bar swallowed Record, Area, and X.
  if (countdownSize && countdownTarget === "area" && !areaPicker) {
    ensureCountdownFrame();
    for (const strip of countdownFrameStrips) raiseOverlayWindow(strip, true);
  } else {
    hideFrameStrips();
  }
  raiseOverlayWindow(countdownOverlay, false);
}

function wireOverlayShell(win, role) {
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  win.on("focus", () => blurOverlay(win));
  // A dead renderer leaves a visible window whose buttons dispatch nothing.
  // Destroy it so the ensure functions rebuild a live one.
  win.webContents.on("render-process-gone", (_event, details) => {
    logCrash("overlay " + role + " renderer gone", details && details.reason);
    if (!win.isDestroyed()) win.destroy();
  });
  win.webContents.on("unresponsive", () => {
    logCrash("overlay " + role + " unresponsive", "");
  });
  if (role === "bar") {
    win.webContents.on("did-finish-load", () => {
      countdownOverlayLoaded = true;
      barRebuildTries = 0;
      lastOverlayPaintKey = "";
      paintCountdownOverlay();
      if (countdownTimer || countdownWait || countdownRecording || countdownSize) raiseCountdownOverlay();
    });
    win.on("ready-to-show", () => {
      countdownOverlayLoaded = true;
      if (countdownEndsAt || countdownWait || countdownRecording || countdownSize) raiseCountdownOverlay();
    });
    win.on("closed", () => {
      if (countdownOverlay !== win) return;
      countdownOverlay = null;
      countdownOverlayLoaded = false;
      // A dead bar mid-session rebuilds itself; a take must never lose its
      // Stop button for good.
      if (
        barRebuildTries < 2 &&
        (countdownRecording || countdownSize || countdownWait || countdownArming || countdownTimer)
      ) {
        barRebuildTries += 1;
        ensureCountdownOverlay();
      }
    });
  } else {
    win.on("closed", () => {
      countdownFrameStrips = countdownFrameStrips.filter((strip) => strip !== win);
    });
  }
}

function newOverlayWindow(bounds, query) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    title: "Recorder bar",
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  try {
    win.setFocusable(false);
  } catch (_) {}
  wireOverlayShell(win, query && query.role === "frame" ? "frame" : "bar");
  trackWindow(win, query && query.role === "frame" ? "bar-frame" : "bar");
  const overlayLoad = query ? win.loadFile(OVERLAY_FILE, { query }) : win.loadFile(OVERLAY_FILE);
  overlayLoad.catch((error) => {
    logCrash("overlay loadFile", (error && (error.stack || error.message)) || error);
    // A failed load leaves a live transparent window that swallows clicks.
    if (!win.isDestroyed()) win.destroy();
  });
  return win;
}

function ensureCountdownOverlay() {
  if (countdownOverlay && !countdownOverlay.isDestroyed()) return;
  const bounds = countdownSize ? barBoundsFor(countdownOverlayBounds()) : countdownOverlayBounds();
  countdownOverlay = newOverlayWindow(bounds, null);
}

// The outline never covers the bar. Click-through is not reliable on
// every platform, and an outline over the bar ate Record, Area, and X. When
// the area reaches under the bar, the outline starts at the bar's bottom
// edge. Only the outline moves; the take still records the whole area.
function frameBoundsFor(take) {
  const bar = barBoundsFor(take);
  const overlapsX = take.x < bar.x + bar.width && take.x + take.width > bar.x;
  const barBottom = bar.y + bar.height;
  if (!overlapsX || take.y >= barBottom) return take;
  const bottom = take.y + take.height;
  return { x: take.x, y: barBottom, width: take.width, height: Math.max(1, bottom - barBottom) };
}

const FRAME_STRIP_THICK = 3;
const FRAME_STRIP_COLOR = "#b8b8b8";

function frameStripRects(take) {
  const t = frameBoundsFor(take);
  if (!t || t.width < 12 || t.height < 12) return [];
  const n = FRAME_STRIP_THICK;
  return [
    { x: t.x, y: t.y, width: t.width, height: n },
    { x: t.x, y: t.y + t.height - n, width: t.width, height: n },
    { x: t.x, y: t.y + n, width: n, height: t.height - n * 2 },
    { x: t.x + t.width - n, y: t.y + n, width: n, height: t.height - n * 2 },
  ];
}

// A 3px opaque window per edge: same look as the old 2px transparent border,
// a fraction of the compositing cost.
function newFrameStrip(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: FRAME_STRIP_COLOR,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    show: false,
    title: "Recorder take outline",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  try {
    win.setFocusable(false);
  } catch (_) {}
  wireOverlayShell(win, "frame");
  trackWindow(win, "bar-frame");
  win
    .loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent('<!doctype html><body style="margin:0;background:#b8b8b8">'),
    )
    .catch(() => {});
  return win;
}

function ensureCountdownFrame() {
  countdownFrameStrips = countdownFrameStrips.filter((win) => win && !win.isDestroyed());
  while (countdownFrameStrips.length < 4) {
    countdownFrameStrips.push(newFrameStrip({ x: 0, y: 0, width: 8, height: 8 }));
  }
}

function layoutFrameStrips(take) {
  const rects = frameStripRects(take);
  if (!rects.length) {
    hideFrameStrips();
    return;
  }
  ensureCountdownFrame();
  countdownFrameStrips.forEach((win, i) => {
    if (!win.isDestroyed() && rects[i]) win.setBounds(rects[i]);
  });
}

function hideFrameStrips() {
  countdownFrameStrips.forEach((win) => {
    if (win && !win.isDestroyed()) win.hide();
  });
}

function destroyFrameStrips() {
  countdownFrameStrips.forEach((win) => {
    if (win && !win.isDestroyed()) win.destroy();
  });
  countdownFrameStrips = [];
}

function startCountdownOverlay(event, payload) {
  const wait = Boolean(payload && payload.wait);
  const recording = Boolean(payload && payload.recording);
  const size = Boolean(payload && payload.size) || (recording && countdownSize);
  const ms = wait || size || recording ? 0 : Math.max(0, Math.round(Number(payload && payload.ms) || 0));
  const gen = ++countdownGen;
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownWait = wait || size;
  countdownSize = size;
  if (payload && payload.size) countdownTakeRect = null;
  countdownSizeCrop = size && payload && payload.crop ? payload.crop : null;
  // The studio page can name the screen (or the area's screen) the bar and
  // the take belong on. An unplugged screen falls back to the pointer.
  const wantedDisplay = size && !recording ? displayById(payload && payload.displayId) : null;
  if (!recording) {
    countdownAreaDisplayId = 0;
    countdownWindowName = "";
    countdownTarget = payload && payload.target === "area" && countdownSizeCrop ? "area" : "auto";
  }
  // The bar stays on the display it opened on until the session ends, and
  // an Auto take records that same screen. A recording start inherits the
  // pin its take used instead of re-reading the cursor's screen.
  if (!countdownDisplayId || (size && !recording)) {
    const stash = recordingPinStash && Date.now() - recordingPinStashAt < 20000 ? recordingPinStash : 0;
    if (recording && stash) countdownDisplayId = stash;
    else if (wantedDisplay) countdownDisplayId = Number(wantedDisplay.id) || 0;
    else countdownDisplayId = Number(displayForCountdown().id) || 0;
  }
  if (wantedDisplay && countdownTarget === "area") countdownAreaDisplayId = wantedDisplay.id;
  recordingPinStash = 0;
  recordingPinStashAt = 0;
  if (mediaCapture && typeof mediaCapture.setPinnedDisplayId === "function") {
    mediaCapture.setPinnedDisplayId(countdownDisplayId || null);
  }
  countdownDelayMs = size && payload && Number.isFinite(Number(payload.delayMs)) ? Math.max(0, Math.round(Number(payload.delayMs))) : 0;
  countdownDelayLabel = payload && payload.delayLabel ? String(payload.delayLabel) : "Off";
  countdownFps = size && payload && Number.isFinite(Number(payload.fps))
    ? Math.min(60, Math.max(24, Math.round(Number(payload.fps))))
    : 30;
  // The page always reports what the take records; absent means off.
  countdownMicOn = Boolean(payload && payload.micOn);
  countdownMicNote = "";
  countdownArming = false;
  overlayClickThrough = true;
  countdownRecording = recording;
  countdownPaused = false;
  countdownPausedAt = 0;
  countdownPausedTotal = 0;
  if (recording) registerRecordStopHotkey();
  else unregisterRecordStopHotkey();
  // The bar shows at once and says Loading until the page has the screen.
  countdownCaptureReady = recording || !size || !payload || payload.captureReady !== false;
  const sender = event && event.sender;
  countdownSender = sender;
  countdownThrottled = sender;
  if (sender && !sender.isDestroyed() && countdownSenderWatch !== sender) {
    countdownSenderWatch = sender;
    sender.once("destroyed", () => {
      if (countdownSenderWatch === sender) countdownSenderWatch = null;
      if (countdownSender === sender) {
        countdownSender = null;
        // The page that owned the bar is gone; a bar it cannot hear is a
        // dead overlay that still swallows clicks.
        if (countdownRecording || countdownArming || countdownSize) {
          logRecorder("page died with the bar up", barStateText());
        }
        stopCountdownOverlay();
      }
    });
  }
  setSenderThrottling(false);
  countdownLeftMs = 0;
  countdownEndsAt = 0;
  countdownStartedAt = recording ? Date.now() : 0;
  if (!wait && !size && !recording) {
    countdownLeftMs = ms;
    countdownEndsAt = Date.now() + ms;
  }
  if (size && !recording) logRecorder("bar open", barStateText());
  ensureCountdownOverlay();
  placeCountdownOverlay();
  raiseCountdownOverlay();
  paintCountdownOverlay();
  hideStrayOverlays();
  if (!wait && !size && !recording) emitCountdownTick();
  if (size) emitOverlayBounds();
  if (wait || size) return;
  if (recording) {
    countdownTimer = setInterval(() => {
      try {
        if (gen !== countdownGen) return;
        countdownLeftMs = Date.now() - countdownStartedAt - pausedMsExtra();
        paintCountdownOverlay();
      } catch (error) {
        logCrash("countdown tick", (error && (error.stack || error.message)) || error);
      }
    }, 250);
    return;
  }
  if (ms <= 0) {
    finishCountdown(gen);
    return;
  }
  countdownTimer = setInterval(() => {
    try {
      if (gen !== countdownGen) return;
      countdownLeftMs = Math.max(0, countdownEndsAt - Date.now());
      paintCountdownOverlay();
      emitCountdownTick();
      if (countdownLeftMs > 0) return;
      finishCountdown(gen);
    } catch (error) {
      logCrash("countdown tick", (error && (error.stack || error.message)) || error);
    }
  }, 250);
}

const MAIN_PAINT_CHECK_MS = 3000;

// The frame the window is showing, judged blank or painted. A capture that
// fails or never returns is "unknown", never "blank": the guard only acts on
// a real frame that came back one flat color.
async function inspectWindowPaint(win) {
  try {
    const image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!image || image.isEmpty()) return { known: false, blank: false, colors: 0 };
    return frameLooksBlank(image.toBitmap());
  } catch {
    return { known: false, blank: false, colors: 0 };
  }
}

function gpuSummary() {
  try {
    const status = app.getGPUFeatureStatus() || {};
    return "gpu=" + (status.gpu_compositing || "?") + (GPU_SAFE ? " safe" : "");
  } catch {
    return "gpu=?";
  }
}

function createWindow() {
  const work = displayWorkArea();
  const width = Math.min(1180, work.width);
  const height = Math.min(820, work.height);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(600, width),
    minHeight: Math.min(520, height),
    maxWidth: work.width,
    maxHeight: work.height,
    backgroundColor: "#f4f6f8",
    title: "Simple Recorder",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      // A recording can run for a long while the user watches something else.
      // Chromium throttles a hidden or occluded window, which would stall the
      // take machinery, so the window is never background-throttled.
      backgroundThrottling: false,
    },
  });
  mediaCapture.wireMediaCapture(win);
  trackWindow(win, "main");
  // The crop preview is a screen capture of whatever else is open. Leave
  // this window out of that capture so the preview shows those windows
  // instead of a picture of the recorder.
  try {
    win.setContentProtection(true);
  } catch (_) {}
  win.removeMenu();
  const indexFile = path.join(__dirname, "..", "renderer", "index.html");
  let rendererReloadInFlight = false;
  let rendererReloadTries = 0;
  const loadApp = () => {
    if (win.isDestroyed()) return;
    win.loadFile(indexFile).catch((error) => logCrash("loadApp loadFile", (error && (error.stack || error.message)) || error));
  };
  win.webContents.on("render-process-gone", (_event, details) => {
    if (!details || details.reason === "clean-exit") return;
    logCrash("render-process-gone", JSON.stringify(details || {}));
    onRecorderPageGone(win.webContents);
    if (win.isDestroyed()) return;
    if (rendererReloadInFlight) return;
    if (rendererReloadTries >= 3) return;
    rendererReloadInFlight = true;
    rendererReloadTries += 1;
    setTimeout(() => {
      rendererReloadInFlight = false;
      loadApp();
    }, 300);
  });
  // White-screen guard. A few seconds after the page is up, look at the
  // frame the window is actually showing. A flat single-color frame means the
  // page never painted: reload once, and if it is still blank, relaunch
  // without GPU acceleration.
  let paintAttempt = 0;
  let paintTimer = null;
  const schedulePaintCheck = () => {
    if (SMOKE || paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      void checkMainPaint();
    }, MAIN_PAINT_CHECK_MS);
  };
  const checkMainPaint = async () => {
    if (mainShutdownDone || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    const verdict = await inspectWindowPaint(win);
    const gpu = gpuSummary();
    if (!verdict.known) {
      logRecorder("main paint unknown", gpu);
      return;
    }
    if (!verdict.blank) {
      logRecorder("main paint ok", "colors=" + verdict.colors + " try=" + paintAttempt + " " + gpu);
      return;
    }
    logCrash("main paint blank", "try=" + paintAttempt + " " + gpu);
    logRecorder("main paint blank", "try=" + paintAttempt + " " + gpu);
    paintAttempt += 1;
    if (paintAttempt === 1) {
      win.webContents.reloadIgnoringCache();
      return;
    }
    if (!GPU_SAFE) relaunchApp("blank window", [GPU_SAFE_ARG]);
  };
  win.webContents.on("did-finish-load", () => {
    rendererReloadInFlight = false;
    rendererReloadTries = 0;
    if (SMOKE) runSmoke(win);
    else setTimeout(prewarmRecorderWindows, RECORDER_PREWARM_DELAY_MS);
    if (paintAttempt > 0 && win.isVisible()) schedulePaintCheck();
  });
  win.once("ready-to-show", () => {
    try {
      win.setContentProtection(true);
    } catch (_) {}
    if (!SMOKE) {
      win.show();
      schedulePaintCheck();
    }
  });
  win.on("closed", () => clearTimeout(paintTimer));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) {
      event.preventDefault();
      return;
    }
    let dest = "";
    try {
      dest = path.normalize(fileURLToPath(url));
    } catch (_) {
      event.preventDefault();
      return;
    }
    if (dest === path.normalize(indexFile)) return;
    event.preventDefault();
  });
  win.on("closed", () => {
    logCrash("main-window-closed", "main window destroyed");
    destroyCountdownOverlay();
  });
  loadApp();
}

// Hidden window, JSON snapshot on stdout, quit. Boots far enough to prove
// the shell, preload, and db all came up.
async function runSmoke(win) {
  try {
    const takes = db ? db.listTakes(10) : [];
    const info = await Promise.race([
      win.webContents
        .executeJavaScript(
          "new Promise((r) => setTimeout(r, 400)).then(() => ({" +
            " hasApi: typeof window.rec === 'object', title: document.title," +
            " panels: document.querySelectorAll('[data-studio] .panel').length," +
            " micPicker: Boolean(document.querySelector('[data-mic-picker] .picker-btn'))," +
            " sourceCards: document.querySelectorAll('[data-source-body] .source-card').length," +
            " startBar: Boolean(document.querySelector('[data-dock-actions] [data-rec-start]'))," +
            " pages: document.querySelectorAll('[data-page]').length," +
            " takesHidden: Boolean(document.querySelector('[data-page-panel=\"takes\"]') && document.querySelector('[data-page-panel=\"takes\"]').hidden)," +
            " takeDays: Array.from(document.querySelectorAll('[data-take-day]')).map((el) => el.getAttribute('data-take-day'))," +
            " takeCards: document.querySelectorAll('.take-card').length," +
            " updateDownload: Boolean(document.querySelector('[data-update-download]'))," +
            " updateSummary: Boolean(document.querySelector('[data-update-summary]'))," +
            " backupsButton: Boolean(document.querySelector('[data-open-backups]'))," +
            " devModeSwitch: (document.querySelector('[data-dev-updates-switch]') || {}).getAttribute ? document.querySelector('[data-dev-updates-switch]').getAttribute('aria-checked') : null," +
            " dock: (document.querySelector('[data-dock-summary]') || {}).textContent || '' }))",
        )
        .catch((error) => ({ error: String((error && error.message) || error) })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    const update = updater ? updater.getStatus() : null;
    const paint = await inspectWindowPaint(win);
    process.stdout.write(
      "SMOKE " +
        JSON.stringify({
          ok: true,
          takes: takes.length,
          update: update
            ? {
                installMode: update.installMode,
                ownerMachine: update.ownerMachine,
                autoCheck: update.autoCheck,
                channel: update.channel,
                installedChannel: update.installedChannel,
                updateAvailable: update.updateAvailable,
                currentTag: update.currentTag,
                installDir: update.installDir,
              }
            : null,
          paint: Object.assign({}, paint, { gpu: gpuSummary() }),
          info,
        }) +
        "\n",
    );
  } catch (error) {
    process.stdout.write("SMOKE " + JSON.stringify({ ok: false, error: String((error && error.message) || error) }) + "\n");
  }
  setTimeout(() => app.exit(0), 100);
}

app.whenReady().then(async () => {
  try {
    bootDeferredMain();
    // Take files play in the page through take://file/<encoded abs path>.
    protocol.handle("take", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== "file") return new Response("Bad request", { status: 400 });
        const decoded = decodeURIComponent(url.pathname.replace(/^\//, ""));
        const resolved = path.resolve(decoded);
        const root = path.resolve(recordingsDir());
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          return new Response("Bad request", { status: 400 });
        }
        return await net.fetch(pathToFileURL(resolved).toString());
      } catch {
        return new Response("Bad request", { status: 400 });
      }
    });

    // A GPU process that dies takes the window's paint with it; keep a line.
    app.on("child-process-gone", (_event, details) => {
      if (details && details.reason !== "clean-exit") logCrash("child-process-gone", JSON.stringify(details));
    });
    createWindow();
    void Promise.resolve(mediaCapture.restoreOnReady()).catch((error) =>
      logCrash("startup restore", (error && error.stack || error.message) || error),
    );
    void recoverInflightTakes();
    // Older takes sit loose in the library root; group them into day folders
    // off the boot path so the window is never waiting on file moves.
    void ensureLibraryLayout();
    // Dock/undock or a scaling change can leave the bar off its display or
    // split it from its take. Re-place the overlays on the new topology, and
    // drop the cached source list so a new screen can be picked.
    const onOverlayDisplayChange = () => {
      if (mediaCapture && typeof mediaCapture.invalidateCaptureSources === "function") {
        mediaCapture.invalidateCaptureSources();
      }
      if (!(countdownSize || countdownWait || countdownRecording || countdownArming || countdownTimer || areaPicker)) return;
      countdownTakeRect = null;
      areaPickerBounds = null;
      if (areaPicker) closeAreaPicker();
      placeCountdownOverlay();
      raiseCountdownOverlay();
      paintCountdownOverlay();
      hideStrayOverlays();
    };
    screen.on("display-added", onOverlayDisplayChange);
    screen.on("display-removed", onOverlayDisplayChange);
    screen.on("display-metrics-changed", onOverlayDisplayChange);
    app.on("activate", () => {
      const open = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !isCountdownOverlay(win));
      if (open.length === 0) createWindow();
    });
  } catch (error) {
    logCrash("whenReady", (error && (error.stack || error.message)) || error);
  }
});

app.on("window-all-closed", () => {
  logCrash("window-all-closed", "last window closed; quitting");
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  logCrash("before-quit", "quit requested");
  try {
    globalShortcut.unregisterAll();
  } catch (_) {}
  shutdownMainProcess();
});

app.on("quit", (_event, exitCode) => {
  logCrash("quit", "exitCode=" + exitCode);
});

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

ipcMain.handle("take-write-start", async (_event, payload) => {
  const id = randomUUID();
  const ext = String((payload && payload.mime) || "").startsWith("video/mp4") ? ".mp4" : ".webm";
  const file = path.join(inflightTakesDir(), id + ext);
  await ensureDir(inflightTakesDir());
  const stream = fssync.createWriteStream(file);
  const entry = { file, stream, sender: _event.sender, hash: createHash("sha256"), failed: false };
  // A write or open failure otherwise surfaces as uncaughtException spam for
  // every later chunk. Mark the take so finish can flag it partial instead.
  stream.on("error", (error) => {
    entry.failed = true;
    logRecorder("take stream error", (error && error.message) || error);
  });
  inflightTakes.set(id, entry);
  // If the page dies mid-take, close the file so the recovery sweep can
  // adopt whatever footage reached disk.
  entry.onDead = () => {
    if (!inflightTakes.delete(id)) return;
    void closeTakeStream(entry).then(() => recoverInflightTakes());
  };
  if (entry.sender && typeof entry.sender.once === "function") {
    entry.sender.once("destroyed", entry.onDead);
  }
  // Older orphans get adopted while a new take runs, but not during the
  // encoder spin-up.
  setTimeout(() => void recoverInflightTakes(), 15000);
  return { id };
});

ipcMain.handle("take-write-chunk", async (_event, payload) => {
  const entry = inflightTakes.get(payload && payload.id);
  if (!entry || entry.failed) return { ok: false };
  const buf = bufferFromPayload(payload && payload.buffer);
  if (!buf || !buf.length) return { ok: true };
  try {
    // Wait for the drain so backpressure reaches the renderer, and only hash
    // the bytes the kernel actually accepted.
    if (entry.stream.write(buf) === false) {
      await new Promise((resolve, reject) => {
        entry.stream.once("drain", resolve);
        entry.stream.once("error", reject);
      });
    }
    entry.hash.update(buf);
    return { ok: true };
  } catch (error) {
    entry.failed = true;
    logRecorder("take chunk failed", (error && error.message) || error);
    return { ok: false, error: String((error && error.message) || error) };
  }
});

function closeTakeStream(entry) {
  return new Promise((resolve) => {
    try {
      entry.stream.end(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

function releaseTakeStream(payload) {
  const entry = inflightTakes.get(payload && payload.id);
  if (!entry) return null;
  inflightTakes.delete(payload && payload.id);
  if (entry.sender && entry.onDead && typeof entry.sender.removeListener === "function") {
    entry.sender.removeListener("destroyed", entry.onDead);
  }
  return entry;
}

ipcMain.handle("take-write-finish", async (_event, payload) => {
  const entry = releaseTakeStream(payload);
  if (!entry) return { ok: false };
  await closeTakeStream(entry);
  const st = await fs.stat(entry.file).catch(() => null);
  const size = st ? st.size : 0;
  // An empty take file is junk: nothing was recorded, nothing to adopt later.
  if (!size) await fs.unlink(entry.file).catch(() => {});
  return {
    ok: true,
    path: entry.file,
    size,
    failed: entry.failed === true,
    contentHash: entry.failed ? "" : entry.hash.digest("hex"),
  };
});

ipcMain.handle("take-write-abort", async (_event, payload) => {
  const entry = releaseTakeStream(payload);
  if (!entry) return { ok: false };
  await closeTakeStream(entry);
  await fs.unlink(entry.file).catch(() => {});
  return { ok: true };
});

// The name a take keeps without its extension: one sanitized base for the
// save path and for the day-folder name check to share.
function safeTakeBase(name) {
  return (
    String(name || "Take")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Take"
  );
}

// Move a finished inflight file into today's folder in the recordings
// library and index it.
ipcMain.handle("take-save", async (_event, payload) => {
  const body = payload || {};
  const src = typeof body.path === "string" ? body.path : "";
  if (!src || !path.resolve(src).startsWith(path.resolve(inflightTakesDir()) + path.sep)) {
    return { ok: false, error: "Bad take path." };
  }
  const ext = path.extname(src).toLowerCase() === ".mp4" ? ".mp4" : ".webm";
  const dir = await takeDayDir(new Date());
  const name = String(body.name || "Take").slice(0, 120);
  const dest = await uniqueTakePath(dir, safeTakeBase(name), ext);
  if (!dest) return { ok: false, error: "Could not name the take." };
  try {
    await fs.rename(src, dest);
  } catch (error) {
    // Different drives (userData vs Videos) need a copy.
    if (error && error.code === "EXDEV") {
      await fs.copyFile(src, dest);
      await fs.unlink(src).catch(() => {});
    } else {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }
  const st = await fs.stat(dest).catch(() => null);
  const take = {
    id: randomUUID(),
    name: path.basename(dest, ext),
    path: dest,
    mime: ext === ".mp4" ? "video/mp4" : "video/webm",
    size: st ? st.size : 0,
    durationMs: Math.max(0, Math.round(Number(body.durationMs) || 0)),
    partial: Boolean(body.partial),
    createdAt: new Date().toISOString(),
  };
  db.insertTake(take);
  logRecorder("take saved", take.name + " " + take.size + "B");
  return { ok: true, take: withDayFolders([take])[0], takes: takesForPage() };
});

// The page wants every take with the day folder it sits in, so the list in
// the app reads the same as the folders in Explorer.
function withDayFolders(takes) {
  const root = recordingsDir();
  return takes.map((take) => Object.assign(take, { day: dayKeyForTake(root, take) }));
}

function takesForPage(limit) {
  return withDayFolders(db.listTakes(limit));
}

ipcMain.handle("takes-list", async () => {
  // Adopt an older layout first, so a take recorded before day folders moves
  // into its folder and the row is re-pointed before the list is built.
  await ensureLibraryLayout();
  // Drop rows whose file is gone, so a delete in Explorer does not leave a
  // ghost take in the list.
  const takes = db.listTakes();
  const alive = [];
  let pruned = false;
  for (const take of takes) {
    const st = await fs.stat(take.path).catch(() => null);
    if (st && st.size > 0) {
      if (st.size !== take.size) take.size = st.size;
      alive.push(take);
    } else {
      db.deleteTakeRow(take.id);
      pruned = true;
    }
  }
  const root = recordingsDir();
  const page = withDayFolders(alive);
  return { takes: page, recordingsDir: root, pruned };
});

ipcMain.handle("take-delete", async (event, payload) => {
  const id = payload && payload.id ? String(payload.id) : "";
  const take = db.getTake(id);
  if (!take) return { ok: false, takes: takesForPage() };
  const win = BrowserWindow.fromWebContents(event.sender);
  const box = {
    type: "question",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Delete take",
    message: 'Delete "' + take.name + '"?',
    detail: "The video file is removed from the recordings folder.",
  };
  const result =
    win && !win.isDestroyed() && win.isVisible()
      ? await dialog.showMessageBox(win, box)
      : await dialog.showMessageBox(box);
  if (result.response !== 0) return { ok: false, cancelled: true, takes: takesForPage() };
  // The row goes only once the file is really gone, so a locked file never
  // turns into a hidden recording that still fills the disk.
  const removed = await removeRecordingFile(recordingsDir(), take.path);
  if (!removed.ok) {
    logRecorder("take delete failed", take.name + ": " + removed.error);
    return { ok: false, error: removed.error, takes: takesForPage() };
  }
  db.deleteTakeRow(take.id);
  logRecorder("take deleted", take.name);
  return { ok: true, takes: takesForPage() };
});

ipcMain.handle("take-show", async (_event, payload) => {
  const take = db.getTake(payload && payload.id);
  if (take && fssync.existsSync(take.path)) {
    shell.showItemInFolder(take.path);
    return { ok: true };
  }
  shell.openPath(recordingsDir()).catch(() => {});
  return { ok: false };
});

ipcMain.handle("take-open", async (_event, payload) => {
  const take = db.getTake(payload && payload.id);
  if (take && fssync.existsSync(take.path)) {
    const err = await shell.openPath(take.path);
    return { ok: !err, error: err || "" };
  }
  return { ok: false };
});

ipcMain.handle("recordings-open", async () => {
  await ensureDir(recordingsDir());
  const err = await shell.openPath(recordingsDir());
  return { ok: !err, error: err || "" };
});

// ---------------------------------------------------------------------------
// Updates (GitHub Releases)
// ---------------------------------------------------------------------------

ipcMain.handle("update-status", async () => {
  return updater ? updater.getStatus() : null;
});

// The only update action: the Download button on the Updates panel. It
// downloads and installs the latest release; the relaunch that follows is
// automatic, so there is nothing else to press.
ipcMain.handle("update-install", async (_event, payload) => {
  if (!updater) return null;
  const tag = payload && typeof payload.tag === "string" ? payload.tag : "";
  return updater.installRelease({ tag });
});

// Settings > Developer mode updates: switch the release source to the
// private development repo (developer sign-in) or back to public releases.
ipcMain.handle("update-set-developer-mode", async (event, payload) => {
  if (!updater) return null;
  const enabled = Boolean(payload && payload.enabled === true);
  if (enabled && !updater.getStatus().developerMode) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const box = {
      type: "warning",
      buttons: ["Turn on", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Developer mode updates",
      message: "Turn on Developer mode updates?",
      detail:
        "Do not turn this on unless you develop Simple Recorder. It is not a public release: it installs builds from the private development repo and requires a GitHub OAuth sign-in (gh auth login) with access to that repo.",
    };
    const result =
      win && !win.isDestroyed() && win.isVisible()
        ? await dialog.showMessageBox(win, box)
        : await dialog.showMessageBox(box);
    if (result.response !== 0) return updater.getStatus();
  }
  return updater.setDeveloperMode(enabled);
});

// Settings > Your data when switching: the folder of database copies saved
// before each update install.
ipcMain.handle("update-open-backups", async () => {
  const dir = path.join(dataRoot(), "backups");
  await ensureDir(dir);
  const err = await shell.openPath(dir);
  return { ok: !err, error: err || "" };
});

// Any webm still in the inflight dir at boot or at the next take start is a
// take the renderer lost (crash). Register it instead of losing it.
let recoverInflightBusy = false;
async function recoverInflightTakes() {
  if (recoverInflightBusy || !db) return;
  recoverInflightBusy = true;
  try {
    const dir = inflightTakesDir();
    const names = await fs.readdir(dir).catch(() => []);
    const orphans = names.filter(
      (name) =>
        /\.(webm|mp4)$/i.test(name) && !inflightTakes.has(name.slice(0, name.lastIndexOf("."))),
    );
    if (!orphans.length) return;
    const takes = db.listTakes();
    let n = 1;
    for (const name of orphans) {
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st) continue;
      // A take shorter than the sweep delay finishes and hands its file to
      // take-save a moment before this runs; a fresh mtime means that
      // handoff is still in flight, not that the take is orphaned.
      if (Date.now() - st.mtimeMs < 60000) continue;
      if (st.size < 16384) {
        await fs.unlink(file).catch(() => {});
        continue;
      }
      while (takes.some((item) => item && item.name === "Recovered take " + n)) n += 1;
      const ext = path.extname(name).toLowerCase() === ".mp4" ? ".mp4" : ".webm";
      const takeName = "Recovered take " + n;
      // Recovered footage lands in the folder for the day it was recorded.
      const dayDir = await takeDayDir(new Date(st.mtimeMs));
      const dest = await uniqueTakePath(dayDir, takeName, ext);
      if (!dest || !(await moveFileVerifying(file, dest)).ok) {
        logRecorder("take recover left in place", name);
        continue;
      }
      db.insertTake({
        id: randomUUID(),
        name: path.basename(dest, ext),
        path: dest,
        mime: ext === ".mp4" ? "video/mp4" : "video/webm",
        size: st.size,
        durationMs: 0,
        partial: true,
        createdAt: new Date().toISOString(),
      });
      logRecorder("take recovered", takeName + " " + st.size + "B");
      n += 1;
    }
  } catch (error) {
    logRecorder("take recover sweep failed", (error && error.message) || error);
  } finally {
    recoverInflightBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Overlay IPC
// ---------------------------------------------------------------------------

// The floating card (bar or recording timer) drags by its non-button areas
// so it never has to sit on top of game HUD. Pointermove can fire far faster
// than the window moves, so pending deltas coalesce into one apply per tick.
let overlayDragPending = null;
let overlayDragFlush = null;
registerOn(ipcMain, "overlay-drag-by", (event, payload) => {
  const win = countdownOverlay;
  if (!win || win.isDestroyed()) return;
  if (event.sender !== win.webContents) return;
  const dx = Number(payload && payload.dx) || 0;
  const dy = Number(payload && payload.dy) || 0;
  if (!dx && !dy) return;
  overlayDragPending = overlayDragPending
    ? { dx: overlayDragPending.dx + dx, dy: overlayDragPending.dy + dy }
    : { dx, dy };
  if (overlayDragFlush) return;
  overlayDragFlush = setTimeout(() => {
    overlayDragFlush = null;
    const delta = overlayDragPending;
    overlayDragPending = null;
    if (!delta || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const area = displayWorkArea(bounds);
    if (!area) return;
    const nx = Math.min(Math.max(bounds.x + delta.dx, area.x), area.x + Math.max(0, area.width - bounds.width));
    const ny = Math.min(Math.max(bounds.y + delta.dy, area.y), area.y + Math.max(0, area.height - bounds.height));
    win.setPosition(Math.round(nx), Math.round(ny));
  }, 33);
});

ipcMain.handle("start-countdown-overlay", (event, payload) => {
  startCountdownOverlay(event, payload);
});

ipcMain.handle("page-pick-area", (event, payload) => startPageAreaPick(event, payload));

registerOn(ipcMain, "prewarm-recorder-bar", () => {
  prewarmRecorderWindows();
});

ipcMain.handle("stop-countdown-overlay", () => {
  stopCountdownOverlay();
});

function barStateText() {
  return (
    "size=" + Boolean(countdownSize) +
    " recording=" + Boolean(countdownRecording) +
    " ready=" + Boolean(countdownCaptureReady) +
    " arming=" + Boolean(countdownArming) +
    " picker=" + Boolean(areaPicker) +
    " target=" + countdownTarget +
    " page=" + Boolean(overlaySender())
  );
}

// The bar and the area picker share overlay-preload.cjs, so any overlay
// window can send these channels. Only the live overlay windows may press;
// the page that owns the countdown may too, since its Record/Stop buttons
// mirror the bar's presses over the same channels.
function isOverlaySender(sender) {
  if (sender === countdownSender) return true;
  return [countdownOverlay, areaPickerWin].some(
    (win) => win && !win.isDestroyed() && win.webContents === sender,
  );
}

registerOn(ipcMain, "countdown-overlay-start", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press record", barStateText());
  // A press while the delay counts down means "record now": skip the wait.
  // A press inside ~400ms of arming is the tail of a double-click, not an
  // intentional skip.
  if (countdownArming) {
    if (Date.now() - countdownArmingAt < 400) {
      logRecorder("ignored record", "arming just started");
      return;
    }
    finishCountdown(countdownGen);
    return;
  }
  if (countdownRecording) return;
  if (countdownSize && !countdownRecording && !countdownCaptureReady) {
    logRecorder("ignored record", "screen capture still opening");
    return;
  }
  if (areaPicker) {
    closeAreaPicker();
    raiseCountdownOverlay();
  }
  if (countdownSize && !countdownRecording && countdownDelayMs > 0) {
    startOverlayDelayThenRecord();
    return;
  }
  finishCountdown(countdownGen);
});

registerOn(ipcMain, "countdown-overlay-stop", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press stop", barStateText());
  if (countdownRecording) {
    stopOverlayKeepDesktop("recording-overlay-stop", { reason: "stop" });
    return;
  }
  closeRecorderBar("stop");
});

registerOn(ipcMain, "countdown-overlay-close", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press close", barStateText());
  closeRecorderBar("close");
});

registerOn(ipcMain, "overlay-set-target", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  const wanted = payload && payload.target;
  const target = wanted === "area" || wanted === "window" ? wanted : "auto";
  logRecorder("press " + target, barStateText());
  if (!countdownSize || countdownRecording || countdownArming) {
    logRecorder("ignored " + target, "bar is not in setup");
    return;
  }
  if (payload && payload.target === "area") openAreaPicker();
  else if (payload && payload.target === "window") openWindowPicker();
  else applyOverlayTarget("auto", null);
});

registerOn(ipcMain, "overlay-window-picked", onWindowPicked);

// The bar's Pause button acts like Stop: forwarded to the page that owns
// the take, which pauses the MediaRecorder and reports the new state back
// through update-countdown-overlay.
registerOn(ipcMain, "countdown-overlay-pause", (event) => {
  if (!isOverlaySender(event.sender)) return;
  if (!countdownRecording) return;
  const sender = overlaySender();
  if (sender) sender.send("recording-overlay-pause");
});

registerOn(ipcMain, "overlay-area-picked", onAreaPicked);

// The picker reports whether a gesture (drag or pinned corner) is in flight
// so a blur does not cancel mid-pick.
registerOn(ipcMain, "area-pick-state", (_event, payload) => {
  if (areaPicker && !areaPicker.isDestroyed() && _event.sender === areaPicker.webContents) {
    areaPickerGesture = Boolean(payload && payload.active);
  }
});

// The page reports capture failures and dropped captures for recorder.log.
registerOn(ipcMain, "recorder-log", (_event, payload) => {
  const event = payload && typeof payload.event === "string" ? payload.event.slice(0, 60) : "";
  if (!event) return;
  logRecorder("page " + event, payload && typeof payload.detail === "string" ? payload.detail : "");
});

ipcMain.on("overlay-nudge-delay", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-nudge-delay", payload || {});
  }
});

ipcMain.on("overlay-nudge-fps", (event, payload) => {
  if (!isOverlaySender(event.sender)) return;
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-nudge-fps", payload || {});
  }
});

ipcMain.on("overlay-toggle-sound", (event) => {
  if (!isOverlaySender(event.sender)) return;
  logRecorder("press sound", barStateText());
  if (countdownSender && !countdownSender.isDestroyed()) {
    countdownSender.send("overlay-toggle-sound");
  }
});

ipcMain.handle("update-countdown-overlay", (event, payload) => {
  // Only the page that owns the session may write overlay state; this payload
  // flips captureReady, which gates the Record press.
  if (!countdownSender || event.sender !== countdownSender) return { ok: false };
  if (payload && payload.delayLabel) countdownDelayLabel = String(payload.delayLabel);
  if (payload && Number.isFinite(Number(payload.delayMs))) {
    countdownDelayMs = Math.max(0, Math.round(Number(payload.delayMs)));
    // A nudge during arming moves the still-running countdown too.
    if (countdownArming) countdownEndsAt = Date.now() + countdownDelayMs;
  }
  if (payload && Number.isFinite(Number(payload.fps))) {
    countdownFps = Math.min(60, Math.max(24, Math.round(Number(payload.fps))));
  }
  if (payload && typeof payload.micOn === "boolean") countdownMicOn = payload.micOn;
  if (payload && typeof payload.micNote === "string") countdownMicNote = payload.micNote.slice(0, 12);
  if (payload && typeof payload.paused === "boolean") setRecordingPaused(payload.paused);
  if (payload && payload.captureReady === true) countdownCaptureReady = true;
  paintCountdownOverlay();
  return { ok: true };
});
