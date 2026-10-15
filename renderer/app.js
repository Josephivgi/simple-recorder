// Simple Recorder pages + take engine.
// Three pages: Studio (source, mic, frame rate, delay, and the bottom dock),
// Takes (saved files), and Settings (Developer mode updates). The floating
// bar owns record, pause, stop, and close. Studio owns the capture itself
// (getDisplayMedia + MediaRecorder). Chunks stream to disk through
// take-write IPC so a crash cannot lose a recording.
//
// Screen and window capture only.

const api = window.rec || null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

const TOAST_MS = 3200;
const TOAST_BAD_MS = 6000;
let toastTimer = 0;
function toast(message, bad = false) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = bad ? "bad show toast" : "show toast";
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast";
    el.style.display = "none";
  }, bad ? TOAST_BAD_MS : TOAST_MS);
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size <= 0) return "";
  if (size < 1024 * 1024) return Math.max(1, Math.round(size / 1024)) + " KB";
  if (size < 1024 * 1024 * 1024) return Math.round(size / 104857.6) / 10 + " MB";
  return Math.round(size / 107374182.4) / 10 + " GB";
}

function logRecorderEvent(event, detail) {
  if (api && typeof api.logRecorder === "function") {
    api.logRecorder({ event, detail: String(detail || "") });
  }
}

// ---------------------------------------------------------------------------
// Recorder settings math (bar steppers)
// ---------------------------------------------------------------------------

const DEFAULT_DELAY_MS = 0;
const DELAY_STEP_MS = 1000;
const MIN_DELAY_MS = 0;
const MAX_DELAY_MS = 10 * 1000;

function clampDelayMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(n / DELAY_STEP_MS) * DELAY_STEP_MS));
}

function nudgeDelayMs(ms, dir) {
  const base = clampDelayMs(ms);
  if (dir < 0) return Math.max(MIN_DELAY_MS, base - DELAY_STEP_MS);
  return Math.min(MAX_DELAY_MS, base + DELAY_STEP_MS);
}

function delayLabel(ms) {
  const value = clampDelayMs(ms);
  if (value <= 0) return "Off";
  return Math.round(value / 1000) + " sec";
}

// The bar offers these three; anything odd lands on the nearest step.
const RECORD_FPS_STEPS = [24, 30, 60];

function clampRecordFps(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 30;
  return RECORD_FPS_STEPS.reduce((best, step) => (Math.abs(step - v) < Math.abs(best - v) ? step : best), 30);
}

// The Quality box picks an output height. The take is scaled to it, so a
// 4K screen can ship a 1080p file, and the auto stop steps (off or a minute
// mark) are unchanged. Anything odd lands on the default.
const QUALITY_HEIGHT = { "720p": 720, "1080p": 1080, "1440p": 1440 };
const DEFAULT_QUALITY = "1080p";

// Before 1.1.7 the box stored a bitrate tier; keep the intent of a saved
// preference instead of dropping it back to the default.
const LEGACY_QUALITY = { standard: "720p", high: "1080p", max: "1440p" };

function clampQuality(raw) {
  const key = String(raw == null ? "" : raw).trim().toLowerCase();
  if (QUALITY_HEIGHT[key]) return key;
  return LEGACY_QUALITY[key] || DEFAULT_QUALITY;
}

function qualityHeight() {
  return QUALITY_HEIGHT[clampQuality(session.quality)];
}

// MP4 is the only offered container; WebM is a disabled placeholder in the
// panel, so nothing here has to weigh the two.
const RECORD_FORMAT = "mp4";

const AUTO_STOP_STEPS_MS = [0, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

function clampAutoStopMs(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && AUTO_STOP_STEPS_MS.includes(v) ? v : 0;
}

function nudgeRecordFps(fps, dir) {
  const i = RECORD_FPS_STEPS.indexOf(clampRecordFps(fps));
  return RECORD_FPS_STEPS[(i + (dir < 0 ? -1 : 1) + RECORD_FPS_STEPS.length) % RECORD_FPS_STEPS.length];
}

function recordFrameMs() {
  return Math.max(8, Math.round(1000 / (session.fps || 30)));
}

const CROP_MIN = 0.08;

function clampUnit(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function clampCrop(crop) {
  const w = Math.min(1, Math.max(CROP_MIN, clampUnit(crop && crop.w, 1)));
  const h = Math.min(1, Math.max(CROP_MIN, clampUnit(crop && crop.h, 1)));
  const x = Math.min(1 - w, clampUnit(crop && crop.x, 0));
  const y = Math.min(1 - h, clampUnit(crop && crop.y, 0));
  return { x, y, w, h };
}

function isFullCrop(crop) {
  const c = clampCrop(crop || { x: 0, y: 0, w: 1, h: 1 });
  return c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999;
}

function evenPx(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v - (v % 2);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const session = {
  target: "auto", // auto | area
  areaCrop: null,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  mic: false,
  micLive: false,
  micError: "",
  micNote: "",
  micRetryBusy: false,
  micDeviceId: "",
  fps: 30,
  delayMs: DEFAULT_DELAY_MS,
  quality: DEFAULT_QUALITY,
  autoStopMs: 0,
  phase: "idle", // idle | countdown (bar up) | recording
  stream: null,
  screenStream: null,
  micStream: null,
  recordStream: null,
  micPending: null,
  barCapture: null,
  barOpenedAt: 0,
  recorder: null,
  chunks: [],
  takeWrite: null,
  takeQueue: null,
  takeWriteFailed: false,
  takeChunks: 0,
  takeDataWatch: 0,
  takeDataFailed: false,
  timer: null,
  startedAt: 0,
  elapsedMs: 0,
  paused: false,
  pausedAt: 0,
  pausedTotal: 0,
  justSavedId: "",
  savedName: "",
  error: "",
  endedWhileRecording: false,
  ignoreCaptureEnded: false,
  setup: null,
  setupLoaded: false,
  mixTimer: 0,
  cropTimer: 0,
  mixEls: null,
  takes: [],
  deletingId: "",
  recordingsDir: "",
  // Studio page state. displayId "" means the screen under the pointer.
  displayId: "",
  areaDisplayId: "",
  areaLabel: "",
  targets: { screens: [], windows: [] },
  targetsLoaded: false,
  targetsLoading: false,
  targetsError: "",
  areaPicking: false,
  previewStream: null,
  previewVideo: null,
  previewObserver: null,
  previewSourceId: "",
  previewStarting: false,
  previewGeneration: 0,
  previewRateLocked: false,
  micDevices: [],
  micLabelsHidden: false,
  meter: null,
  update: {
    repo: "Josephivgi/simple-recorder",
    developerMode: false,
    channel: "public",
    bootVersion: "1.0.0",
    currentVersion: "1.0.0",
    currentTag: "v1.0.0",
    latestVersion: "1.0.0",
    latestTag: "v1.0.0",
    selectedTag: "v1.0.0",
    selectedVersion: "1.0.0",
    selectedDiff: 0,
    updateAvailable: false,
    status: "idle",
    error: "",
    message: "",
    needsRestart: false,
    releases: [],
  },
};

let barGen = 0;
let countdownUnlisten = null;
let captureWatchAbort = null;

function isBusy() {
  return session.phase === "recording" || session.phase === "countdown";
}

function statusLine() {
  if (session.error) return session.error;
  if (session.phase === "recording") return (session.paused ? "Paused " : "Recording ") + formatClock(session.elapsedMs || 0);
  if (session.phase === "countdown" && !session.stream) return "Getting your screen ready";
  if (session.phase === "countdown") return "Not recording yet. Press Record on the bar.";
  return "Ready";
}

function nextTakeName(takes) {
  const re = /^Screen take (\d+)$/;
  let max = 0;
  for (const item of takes || []) {
    const match = String((item && item.name) || "").match(re);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return "Screen take " + (max + 1);
}

function micAllowed() {
  return Boolean(session.setup && session.setup.mic && session.setup.mic.ok);
}

// What a take actually records: the person wants sound, the mic is approved,
// and it has not failed.
function micRecording() {
  return Boolean(session.mic) && micAllowed() && !session.micError;
}

function micHint() {
  if (session.micRetryBusy) return "Asking for your microphone.";
  if (session.mic && session.micError) return session.micError + " Takes record without sound.";
  if (micRecording()) return "Your microphone is recorded with the video.";
  if (session.setup && session.setup.mic && session.setup.mic.osDenied) {
    return "Windows is blocking the microphone. Takes record without sound.";
  }
  return "";
}

function osName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return "The OS";
}

// ---------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------

function applyPrefs(status) {
  const prefs = status && status.prefs;
  if (!prefs || typeof prefs !== "object") return;
  if (typeof prefs.micDeviceId === "string") session.micDeviceId = prefs.micDeviceId;
  if (prefs.recordArea && typeof prefs.recordArea === "object") session.areaCrop = clampCrop(prefs.recordArea);
  if (prefs.recordTarget === "area" || prefs.recordTarget === "full") {
    session.target = prefs.recordTarget === "area" && session.areaCrop ? "area" : "auto";
    if (session.phase === "idle") session.crop = session.target === "area" ? session.areaCrop : { x: 0, y: 0, w: 1, h: 1 };
  }
  if (typeof prefs.soundOn === "boolean") session.mic = prefs.soundOn;
  if ("recordFps" in prefs) session.fps = clampRecordFps(prefs.recordFps);
  if ("recordDelayMs" in prefs) session.delayMs = clampDelayMs(prefs.recordDelayMs);
  if ("recordQuality" in prefs) session.quality = clampQuality(prefs.recordQuality);
  if ("recordAutoStopMs" in prefs) session.autoStopMs = clampAutoStopMs(prefs.recordAutoStopMs);
  if (typeof prefs.recordAreaDisplayId === "string") session.areaDisplayId = prefs.recordAreaDisplayId;
}

function rememberPrefs(patch) {
  if (!api || typeof api.saveRecorderPrefs !== "function") return;
  const payload = {};
  if (patch && typeof patch.micDeviceId === "string") payload.micDeviceId = patch.micDeviceId;
  if (patch && typeof patch.soundOn === "boolean") payload.soundOn = patch.soundOn;
  if (patch && (patch.recordTarget === "auto" || patch.recordTarget === "full" || patch.recordTarget === "area")) {
    payload.recordTarget = patch.recordTarget === "full" ? "auto" : patch.recordTarget;
  }
  if (patch && "recordArea" in patch) payload.recordArea = patch.recordArea;
  if (patch && "recordFps" in patch) payload.recordFps = clampRecordFps(patch.recordFps);
  if (patch && "recordDelayMs" in patch) payload.recordDelayMs = clampDelayMs(patch.recordDelayMs);
  if (patch && "recordQuality" in patch) payload.recordQuality = clampQuality(patch.recordQuality);
  if (patch && "recordAutoStopMs" in patch) payload.recordAutoStopMs = clampAutoStopMs(patch.recordAutoStopMs);
  if (patch && typeof patch.recordAreaDisplayId === "string") payload.recordAreaDisplayId = patch.recordAreaDisplayId;
  if (!Object.keys(payload).length) return;
  api.saveRecorderPrefs(payload).then((status) => {
    if (status) session.setup = status;
  }).catch(() => {});
}

function rememberTarget(target, crop, areaDisplayId) {
  session.target = target === "area" && crop && !isFullCrop(crop) ? "area" : "auto";
  if (session.target === "area") {
    session.areaCrop = clampCrop(crop);
    if (typeof areaDisplayId === "string") session.areaDisplayId = areaDisplayId;
  }
  rememberPrefs({
    recordTarget: session.target,
    recordArea: session.areaCrop,
    recordDisplayId: session.displayId,
    recordAreaDisplayId: session.areaDisplayId,
  });
}

function screenForDisplay(displayId) {
  if (!displayId) return null;
  return session.targets.screens.find((item) => item.displayId === displayId) || null;
}

// A named screen records that screen's source; otherwise main picks the
// screen the bar is pinned to (the one under the pointer at open).
function recordSourcePick() {
  const displayId = session.target === "area" ? session.areaDisplayId : session.displayId;
  const named = screenForDisplay(displayId);
  return named ? named.id : "auto";
}

function barDisplayId() {
  if (session.target === "area") return session.areaDisplayId || "";
  if (session.target === "auto") return screenForDisplay(session.displayId) ? session.displayId : "";
  return "";
}

function rememberCaptureSource(id) {
  const next = id || "";
  if (next === session.lastCaptureSourceId) return Promise.resolve();
  session.lastCaptureSourceId = next;
  if (api && typeof api.setCaptureSource === "function") {
    return Promise.resolve(api.setCaptureSource({ id: next })).catch(() => {});
  }
  return Promise.resolve();
}

function rememberCaptureIntent() {
  if (!api || typeof api.setCaptureIntent !== "function") return;
  api.setCaptureIntent({ source: "screen", mic: Boolean(session.mic) });
}

// ---------------------------------------------------------------------------
// Permission plumbing
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function blockedError(code) {
  const err = new Error(code || "blocked");
  err.code = code || "blocked";
  return err;
}

async function promptCapture(kind, force, implied) {
  if (!api || typeof api.promptCaptureAccess !== "function") return true;
  const result = await api.promptCaptureAccess({ kind, force: Boolean(force), implied: Boolean(implied) });
  if (result && result.status) session.setup = result.status;
  if (result && result.ok && result.osDenied) throw blockedError("os-denied");
  if (result && result.ok) return true;
  throw blockedError("blocked");
}

function osDeniedError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return true;
  return /denied by system/i.test(String((err && err.message) || ""));
}

// The OS may show its own consent prompt while getUserMedia is pending
// (Windows per app consent, macOS TCC). Give the person time to answer it.
const OS_PROMPT_MS = 90000;

async function requestMedia(kind, run) {
  if (kind === "screen") await promptCapture(kind);
  else if (api && typeof api.setCaptureIntent === "function") {
    await api.setCaptureIntent({ source: "screen", mic: true }).catch(() => {});
  }
  try {
    if (kind === "screen") return await run();
    return await withTimeout(Promise.resolve(run()), OS_PROMPT_MS, "Permission timed out.");
  } catch (err) {
    if (kind === "screen" || !osDeniedError(err)) throw err;
    if (api && typeof api.reportCaptureDenied === "function") {
      try {
        const reported = await api.reportCaptureDenied({ kind });
        if (reported && reported.screen) session.setup = reported;
      } catch {
        /* status refresh below still runs */
      }
    }
    const status = api && api.ensureCaptureAccess ? await api.ensureCaptureAccess({ kind }).catch(() => null) : null;
    if (status && status.screen) session.setup = status;
    const entry = (status && status[kind]) || (session.setup && session.setup[kind]);
    if (entry && entry.osDenied) throw blockedError("os-denied");
    throw err;
  }
}

async function finishSetupApproval(kind) {
  if (api && typeof api.markCaptureApproved === "function") {
    session.setup = await api.markCaptureApproved({ kind });
    return;
  }
  session.setup = session.setup || {};
  session.setup[kind] = { ok: true };
  session.setup.ready = Boolean(session.setup.screen && session.setup.screen.ok);
}

function deviceMissingError(err) {
  const name = err && err.name;
  return name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError";
}

function micFailureText(error) {
  if (error && error.code === "os-denied") {
    return osName(session.setup && session.setup.platform) + " is blocking the microphone. Open Settings to approve it.";
  }
  if (deviceMissingError(error)) return "No microphone found on this computer.";
  return "Microphone was blocked.";
}

async function openMicStream() {
  try {
    const id = session.micDeviceId;
    const constraints = id ? { audio: { deviceId: { exact: id } }, video: false } : { audio: true, video: false };
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if (session.micDeviceId && (deviceMissingError(error) || (error && error.name === "OverconstrainedError"))) {
      session.micDeviceId = "";
      rememberPrefs({ micDeviceId: "" });
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw error;
  }
}

function stopProbe(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  });
}

// ---------------------------------------------------------------------------
// Overlay (recorder bar) IPC
// ---------------------------------------------------------------------------

function countdownHost() {
  return api || null;
}

function stopCountdownOverlay() {
  if (api && typeof api.stopCountdownOverlay === "function") {
    api.stopCountdownOverlay().catch(() => {});
  }
}

function syncOverlayMic() {
  const host = countdownHost();
  if (host && typeof host.updateCountdownOverlay === "function") {
    host.updateCountdownOverlay({ micOn: micRecording(), micNote: session.micNote || "" });
  }
}

let micNoteTimer = 0;
function setMicNote(note, clearAfterMs) {
  clearTimeout(micNoteTimer);
  session.micNote = note;
  if (clearAfterMs) {
    micNoteTimer = setTimeout(() => {
      session.micNote = "";
      syncOverlayMic();
    }, clearAfterMs);
  }
  syncOverlayMic();
}

function micFailureNote(error) {
  const code = error && error.code;
  if (code === "blocked" || code === "os-denied") return "Blocked";
  return deviceMissingError(error) ? "No mic" : "Failed";
}

function bindCountdownIpc() {
  const host = countdownHost();
  if (!host || countdownUnlisten) return;
  const offs = [];
  const bind = (name, handler) => {
    if (typeof host[name] !== "function") return;
    const off = host[name](handler);
    if (typeof off === "function") offs.push(off);
  };
  bind("onCountdownTick", onOverlayCountdownTick);
  bind("onOverlayNudgeFps", onOverlayNudgeFps);
  bind("onCountdownFinished", onOverlayCountdownFinished);
  bind("onCountdownBounds", onOverlayCountdownBounds);
  bind("onRecordingOverlayStop", onOverlayRecordingStop);
  bind("onRecordingOverlayPause", onOverlayRecordingPause);
  bind("onOverlayClosed", onOverlayClosed);
  bind("onOverlaySetTarget", onOverlaySetTarget);
  bind("onOverlayNudgeDelay", onOverlayNudgeDelay);
  bind("onOverlayToggleSound", onOverlayToggleSound);
  countdownUnlisten = () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* already dropped */
      }
    }
    countdownUnlisten = null;
  };
}

function unbindCountdownIpc() {
  if (countdownUnlisten) countdownUnlisten();
  countdownUnlisten = null;
}

function onOverlayCountdownTick(payload) {
  if (session.phase !== "countdown") return;
  const left = Number(payload && payload.leftMs);
  session.delayLeftMs = Number.isFinite(left) && left >= 0 ? left : 0;
}

async function onOverlayCountdownFinished(payload) {
  if (session.phase !== "countdown") return;
  if (!session.stream && session.barCapture) await session.barCapture.catch(() => {});
  if (session.phase !== "countdown" || !session.stream) return;
  const crop = payload && payload.crop;
  if (crop && Number.isFinite(Number(crop.w)) && Number(crop.w) > 0) {
    session.crop = clampCrop(crop);
  }
  await beginRecording();
  render();
}

function onOverlayCountdownBounds(payload) {
  if (session.phase !== "countdown") return;
  const crop = payload && payload.crop;
  if (!crop || !Number.isFinite(Number(crop.w)) || Number(crop.w) <= 0) return;
  session.crop = clampCrop(crop);
}

function onOverlayRecordingStop() {
  if (session.phase === "recording") onStop();
  else if (session.phase === "countdown") closeRecorderBarFromOverlay();
}

// The bar's Pause button. The MediaRecorder stops producing chunks while
// paused; the clock and the saved duration both exclude the paused span.
function onOverlayRecordingPause() {
  if (session.phase !== "recording") return;
  const recorder = session.recorder;
  if (!recorder) return;
  if (session.paused) {
    if (recorder.state !== "paused") return;
    try {
      recorder.resume();
    } catch {
      return;
    }
    session.pausedTotal += Date.now() - session.pausedAt;
    session.paused = false;
  } else {
    if (recorder.state !== "recording") return;
    try {
      recorder.pause();
    } catch {
      return;
    }
    session.paused = true;
    session.pausedAt = Date.now();
  }
  logRecorderEvent("take " + (session.paused ? "paused" : "resumed"));
  const host = countdownHost();
  if (host && typeof host.updateCountdownOverlay === "function") {
    host.updateCountdownOverlay({ paused: session.paused });
  }
  render();
}

function onOverlayClosed() {
  closeRecorderBarFromOverlay();
}

function onOverlayNudgeDelay(payload) {
  if (session.phase !== "countdown") return;
  session.delayMs = nudgeDelayMs(session.delayMs, payload && payload.dir);
  rememberPrefs({ recordDelayMs: session.delayMs });
  const host = countdownHost();
  if (host && typeof host.updateCountdownOverlay === "function") {
    host.updateCountdownOverlay({
      delayMs: session.delayMs,
      delayLabel: delayLabel(session.delayMs),
    });
  }
  render();
}

// The bar's FPS steppers cycle 24, 30, 60. The pick persists and the armed
// capture picks it up at Record, so pressing is free.
function onOverlayNudgeFps(payload) {
  if (session.phase !== "countdown") return;
  const next = nudgeRecordFps(session.fps, payload && payload.dir);
  if (next === session.fps) return;
  session.fps = next;
  rememberPrefs({ recordFps: next });
  const host = countdownHost();
  if (host && typeof host.updateCountdownOverlay === "function") {
    host.updateCountdownOverlay({ fps: next });
  }
  render();
}

// The bar's Sound button. The take keeps the sound choice that was set
// before Record; the bar hides Sound while a take is rolling.
function onOverlayToggleSound() {
  if (session.phase !== "countdown") return;
  void setSessionMic(!micRecording()).then(() => {
    logRecorderEvent("sound " + (micRecording() ? "on" : "off"));
  });
}

// Every take records a screen, so the open capture stays; a target press
// only changes the crop drawn over it.
function onOverlaySetTarget(payload) {
  if (session.phase !== "countdown") return;
  const wanted = payload && payload.target;
  const target = wanted === "area" ? "area" : "auto";
  const crop = target === "area" && payload && payload.crop ? clampCrop(payload.crop) : { x: 0, y: 0, w: 1, h: 1 };
  session.crop = crop;
  const areaDisplay = payload && typeof payload.displayId === "string" && payload.displayId ? payload.displayId : undefined;
  if (target === "area") session.areaLabel = "";
  rememberTarget(target, crop, areaDisplay);
  render();
}

function countdownStartPayload() {
  const area = session.target === "area" && session.areaCrop ? clampCrop(session.areaCrop) : null;
  return {
    size: true,
    target: area ? "area" : "auto",
    crop: area,
    displayId: barDisplayId(),
    delayMs: session.delayMs,
    delayLabel: delayLabel(session.delayMs),
    micOn: micRecording(),
    fps: clampRecordFps(session.fps),
    captureReady: Boolean(session.stream),
  };
}

// ---------------------------------------------------------------------------
// Bar lifecycle
// ---------------------------------------------------------------------------

function startCountdown() {
  stopMeter();
  stopCropPreview();
  closePickers();
  barGen += 1;
  session.barOpenedAt = Date.now();
  session.delayLeftMs = 0;
  session.phase = "countdown";
  const host = countdownHost();
  if (host) {
    host.startCountdownOverlay(countdownStartPayload());
  }
  if (!countdownUnlisten) bindCountdownIpc();
  render();
}

// Close hides the bar and does not reopen it.
function closeRecorderBarFromOverlay() {
  if (session.phase !== "countdown") return;
  barGen += 1;
  session.barCapture = null;
  stopTracks();
  session.phase = "idle";
  session.error = "";
  unbindCountdownIpc();
  render();
}

async function onStart() {
  if (isBusy()) return;
  session.error = "";
  session.savedName = "";
  session.justSavedId = "";
  startCountdown();
  await openCaptureForBar();
}

// Opens the capture while the bar is already on screen. Record on the bar
// waits for it (onOverlayCountdownFinished), and a failure closes the bar.
function openCaptureForBar() {
  const gen = barGen;
  const isCurrent = () => gen === barGen && session.phase === "countdown";
  const run = enableCapture({ forBar: true, isCurrent }).then((ok) => {
    if (session.barCapture === run) session.barCapture = null;
    if (!isCurrent()) return false;
    if (ok) {
      const host = countdownHost();
      if (host && typeof host.updateCountdownOverlay === "function") host.updateCountdownOverlay({ captureReady: true });
      logRecorderEvent("capture ready", Math.max(0, Date.now() - session.barOpenedAt) + "ms");
    }
    render();
    return ok;
  });
  session.barCapture = run;
  return run;
}

async function enableCapture(opts) {
  const forBar = Boolean(opts && opts.forBar);
  const isCurrent = forBar && opts && typeof opts.isCurrent === "function" ? opts.isCurrent : () => session.phase === "countdown";
  if (!forBar && isBusy()) return false;
  session.error = "";
  stopTracks();
  try {
    const stream = await openStream({ isCurrent });
    if (forBar && !isCurrent()) {
      // The bar was closed while the capture opened. Stop only this
      // capture; a newer bar may already have its own.
      stopStream(stream);
      if (session.screenStream === stream) session.screenStream = null;
      logRecorderEvent("capture dropped", "bar closed while it opened");
      return false;
    }
    session.stream = stream;
    watchCaptureStreams();
  } catch (error) {
    if (forBar && !isCurrent()) return false;
    logRecorderEvent("capture failed", ((error && error.name) || "Error") + ": " + ((error && error.message) || ""));
    stopTracks();
    if (forBar) unbindCountdownIpc();
    session.phase = "idle";
    if (error && error.code === "capture-timeout") {
      session.error = "The screen took too long to open. Press Start Recorder Bar again.";
    } else {
      session.error = "Screen capture was blocked.";
    }
    // Only a real block asks for consent again. A timeout or a busy screen
    // must not reset it.
    const blocked = !error || error.name === "NotAllowedError" || error.name === "SecurityError" || error.code === "os-denied";
    if (blocked && api && typeof api.resetCaptureConsent === "function") {
      api.resetCaptureConsent({ screen: true });
    }
    toast(session.error, true);
  }
  const ok = Boolean(session.stream) && session.phase === "countdown";
  render();
  return ok;
}

async function startMicRequest(opts) {
  const quiet = Boolean(opts && opts.quiet);
  session.micError = "";
  // An unapproved mic is a choice, not a failure: record without sound and
  // say nothing. Turning Sound on is what asks for it.
  const unapproved = session.setupLoaded && !micAllowed();
  if (!session.mic || unapproved || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    session.micLive = false;
    return null;
  }
  try {
    const mic = await requestMedia("mic", () => openMicStream());
    session.micLive = true;
    return mic;
  } catch (error) {
    session.micLive = false;
    session.micError = micFailureText(error);
    if (!quiet) toast(session.micError, true);
    return null;
  }
}

function removeMicTracks() {
  const targets = [session.stream, session.recordStream].filter(Boolean);
  for (const stream of targets) {
    if (!stream || typeof stream.getAudioTracks !== "function") continue;
    stream.getAudioTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
      try {
        stream.removeTrack(track);
      } catch {
        /* track may not be on this stream */
      }
    });
  }
  if (session.micStream && typeof session.micStream.getTracks === "function") {
    session.micStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    });
  }
  session.micStream = null;
  session.micLive = false;
}

function rememberMicDeviceFromStream(mic) {
  if (!mic || typeof mic.getAudioTracks !== "function") return;
  const track = mic.getAudioTracks()[0];
  const settings = track && typeof track.getSettings === "function" ? track.getSettings() : null;
  const id = settings && settings.deviceId ? String(settings.deviceId) : "";
  // "System default" in the Microphone box is a choice too: keep following
  // whatever the OS default is instead of pinning today's device.
  if (!session.micDeviceId) return;
  if (!id || id === session.micDeviceId) return;
  session.micDeviceId = id;
  rememberPrefs({ micDeviceId: id });
}

function addMicTracks(target, mic) {
  if (!mic || !target || typeof target.addTrack !== "function") return false;
  removeMicTracks();
  session.micStream = mic;
  mic.getAudioTracks().forEach((track) => target.addTrack(track));
  rememberMicDeviceFromStream(mic);
  session.micLive = mic.getAudioTracks().some((track) => track.readyState === "live");
  session.micError = "";
  return session.micLive;
}

async function attachMicToStream(opts) {
  if (!session.mic || !session.stream) {
    session.micLive = false;
    return false;
  }
  const mic = await startMicRequest(opts);
  if (!mic) return false;
  if (!addMicTracks(session.stream, mic)) {
    stopProbe(mic);
    session.micLive = false;
    if (!session.micError) session.micError = "Microphone was blocked.";
    return false;
  }
  watchCaptureStreams();
  return true;
}

function handleMicLost(message) {
  if (!session.mic) return;
  removeMicTracks();
  session.micError = message || "Microphone disconnected.";
  syncOverlayMic();
  if (session.phase === "recording") {
    toast("Microphone dropped. This take saves without sound.", true);
    return;
  }
  render();
}

// Turning sound on without an approved mic asks for it right here. Pressing
// Sound is the consent, so only the OS answers. An OS block opens the mic
// privacy page and waits for the flip; anything else lands on a reason the
// bar can show and the take records without sound.
async function approveMicHere() {
  session.micRetryBusy = true;
  setMicNote("Asking");
  let failure = null;
  try {
    await requestSetupPermission("mic", { implied: true });
    await finishSetupApproval("mic");
  } catch (error) {
    failure = error;
    logRecorderEvent("sound blocked", (error && (error.code || error.name || error.message)) || "");
  }
  if (failure && (failure.code === "os-denied" || osDeniedError(failure))) {
    setMicNote("Settings");
    try {
      await openOsSettingsAndWait("mic");
      if (micAllowed()) failure = null;
    } catch {
      /* the wait path reports through session.setup; keep the first failure */
    }
  }
  session.micRetryBusy = false;
  const ok = micAllowed();
  if (ok) setMicNote("");
  else setMicNote(micFailureNote(failure), 5000);
  return ok;
}

async function requestSetupPermission(kind, opts) {
  if (kind === "mic") {
    await promptCapture(kind, !micAllowed(), Boolean(opts && opts.implied));
    const mic = await requestMedia("mic", () => openMicStream());
    stopProbe(mic);
    return;
  }
  const display = await requestMedia("screen", () =>
    navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }),
  );
  stopProbe(display);
}

async function openOsSettingsAndWait(kind) {
  if (kind !== "mic") return;
  if (!api || typeof api.openCaptureSettings !== "function") return;
  try {
    const opened = await api.openCaptureSettings({ kind });
    if (opened && opened.status) session.setup = opened.status;
    if (!opened || !opened.ok) {
      toast("Could not open Settings.", true);
      return;
    }
    if (typeof api.waitCaptureAccess !== "function") return;
    const waited = await api.waitCaptureAccess({ kind, timeoutMs: 180000 });
    if (waited && waited.status) session.setup = waited.status;
    if (!waited || !waited.ok) return;
    if (session.setup && session.setup[kind] && session.setup[kind].ok) return;
    const stream = await requestMedia(kind, () => openMicStream());
    stopProbe(stream);
    await finishSetupApproval(kind);
  } catch (error) {
    if (error && error.code !== "blocked" && error.code !== "os-denied") {
      toast(micFailureText(error), true);
    }
  }
}

// One path for the Sound switch. Sound never blocks a take: every failure
// lands on Off with a plain reason.
async function setSessionMic(next) {
  if (session.phase === "recording" || session.micRetryBusy) {
    logRecorderEvent("ignored sound", session.phase === "recording" ? "take is rolling" : "mic request in flight");
    syncOverlayMic();
    return;
  }
  session.savedName = "";
  session.micError = "";
  if (!next || micAllowed()) setMicNote("");
  if (next && !micAllowed()) {
    const ok = await approveMicHere();
    if (!ok) next = false;
  }
  session.mic = next;
  rememberPrefs({ soundOn: session.mic });
  if (!next) {
    removeMicTracks();
  } else if (session.stream && session.phase === "countdown") {
    session.micRetryBusy = true;
    try {
      await attachMicToStream({ quiet: true });
    } finally {
      session.micRetryBusy = false;
    }
  }
  syncOverlayMic();
  render();
}

async function openStream(opts) {
  rememberCaptureIntent();
  await rememberCaptureSource(recordSourcePick());
  // No width/height constraint: the capture must come in at the display's
  // native size. An ideal-1080 request makes Chromium downscale first, and
  // a crop then cuts into an already softened picture.
  const request = navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: clampRecordFps(session.fps), max: clampRecordFps(session.fps) },
    },
    audio: false,
  });
  // A capture that arrives after the timeout would keep the screen shared
  // with nothing using it, so stop it when it lands.
  let late = false;
  request.then(
    (stream) => {
      if (late) stopStream(stream);
    },
    () => {},
  );
  const display = await withTimeout(request, 60000, "Screen capture timed out.").catch((error) => {
    late = true;
    if (error && error.message === "Screen capture timed out.") error.code = "capture-timeout";
    throw error;
  });
  if (opts && typeof opts.isCurrent === "function" && !opts.isCurrent()) return display;
  display.getVideoTracks().forEach((track) => {
    try {
      track.contentHint = "motion";
    } catch {
      /* older engines */
    }
  });

  session.screenStream = display;
  // Persist the screen approval off the capture path.
  const screenApproved = Boolean(session.setup && session.setup.screen && session.setup.screen.ok);
  if (!screenApproved) void finishSetupApproval("screen").catch(() => {});
  // A serial mic open kept the bar in Loading for the whole device spin
  // up. It attaches in the background; beginRecording waits for it before
  // the recorder builds (tracks added later are not recorded). A late
  // resolution must still honor a Sound-off press and must not clear a
  // newer bar's pending request.
  const pending = Promise.resolve(startMicRequest({ quiet: true }))
    .then((mic) => {
      if (session.micPending === pending) session.micPending = null;
      if (mic && session.mic && session.screenStream === display && session.phase === "countdown") {
        addMicTracks(display, mic);
      } else if (mic) {
        stopProbe(mic);
      }
    })
    .catch(() => {
      if (session.micPending === pending) session.micPending = null;
    });
  session.micPending = pending;
  return display;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function streamSourceSize(stream) {
  const track = stream && typeof stream.getVideoTracks === "function" ? stream.getVideoTracks()[0] : null;
  const settings = track && typeof track.getSettings === "function" ? track.getSettings() : null;
  return {
    w: Number(settings && settings.width) || 1280,
    h: Number(settings && settings.height) || 720,
  };
}

// Timer driven so drawing keeps going while this window is hidden behind
// whatever is being recorded (background throttling is off for this window).
// The canvas is both the cropper and the scaler: the take lands at the
// height the Quality box asked for, so a small crop is not shipped tiny and
// a 4K display is not shipped at 4K.
function scaleFromStream(src, crop, srcW, srcH) {
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.srcObject = src;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  const rawW = Math.max(2, srcW * crop.w);
  const rawH = Math.max(2, srcH * crop.h);
  const scale = qualityHeight() / rawH;
  const outW = evenPx(rawW * scale);
  const outH = evenPx(rawH * scale);
  canvas.width = outW;
  canvas.height = outH;
  const draw = () => {
    if (!ctx || el.videoWidth <= 0) return;
    const sw = el.videoWidth;
    const sh = el.videoHeight;
    ctx.drawImage(el, sw * crop.x, sh * crop.y, sw * crop.w, sh * crop.h, 0, 0, outW, outH);
  };
  Promise.resolve(el.play()).catch(() => {});
  if (session.cropTimer) clearInterval(session.cropTimer);
  // Follow the capture's own frames when the engine offers it, so the
  // canvas repaints in step with what the take actually receives; the
  // timer is the fallback that keeps drawing while the window is hidden.
  if (typeof el.requestVideoFrameCallback === "function") {
    const loop = () => {
      draw();
      el.requestVideoFrameCallback(loop);
    };
    el.requestVideoFrameCallback(loop);
  }
  session.cropTimer = setInterval(draw, recordFrameMs());
  session.mixEls = session.mixEls || {};
  session.mixEls.cropEl = el;
  session.mixEls.cropCanvas = canvas;
  const out = canvas.captureStream(clampRecordFps(session.fps));
  if (src && typeof src.getAudioTracks === "function") {
    src.getAudioTracks().forEach((track) => {
      if (!out.getAudioTracks().some((existing) => existing.id === track.id)) out.addTrack(track);
    });
  }
  session.recordStream = out;
  return out;
}

function recordingInput() {
  const src = session.stream;
  if (!src) return src;
  const size = streamSourceSize(src);
  const crop = session.target === "area" && session.crop ? clampCrop(session.crop) : { x: 0, y: 0, w: 1, h: 1 };
  session.crop = crop;
  // A full frame that already fits the chosen quality is the only take that
  // goes straight out. Cropping, or a display taller than the quality, needs
  // the scaler.
  if (isFullCrop(crop) && size.h <= qualityHeight()) return src;
  return scaleFromStream(src, crop, size.w, size.h);
}

// ---------------------------------------------------------------------------
// Live crop preview: a 30 fps look at exactly what a cropped take records.
// The video element is the preview. It stays in the frame (a detached or
// canvas-polled video only presents the first frame), shifted so the crop
// is what you see. The capture is locked to 30 fps. The static thumbnail
// sits underneath until the first frame, so a denied capture stays a picture.
// ---------------------------------------------------------------------------

const PREVIEW_FPS = 30;

function previewScreenSourceId() {
  const picked = recordSourcePick();
  if (picked && String(picked).startsWith("screen:")) return picked;
  const screens = (session.targets && session.targets.screens) || [];
  const screen = screenForDisplay(session.areaDisplayId) || screens.find((item) => item.primary) || screens[0];
  return screen && String(screen.id || "").startsWith("screen:") ? screen.id : "";
}

function screenCaptureAllowed() {
  return Boolean(session.setup && session.setup.screen && session.setup.screen.ok);
}

// Desktop source constraints are what actually pin the capturer. ideal/max
// on getDisplayMedia is a hint the Windows capturer often ignores, which
// left the preview well under 30 fps.
function openDesktopPreview(sourceId) {
  const base = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: sourceId,
  };
  const open = (extra) =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: Object.assign({}, base, extra || {}) },
    });
  return open({ minFrameRate: PREVIEW_FPS, maxFrameRate: PREVIEW_FPS }).catch(() => open());
}

async function openCropPreviewStream(sourceId) {
  rememberCaptureIntent();
  const requestedSourceId = sourceId || recordSourcePick() || "auto";
  await rememberCaptureSource(requestedSourceId);
  // A direct desktop source preserves the requested preview rate without a
  // picker. If the Windows capturer rejects it, use the standard display
  // capture handler, which has just been given the selected source id.
  if (screenCaptureAllowed() && requestedSourceId.startsWith("screen:")) {
    try {
      return await openDesktopPreview(requestedSourceId);
    } catch (error) {
      logRecorderEvent(
        "crop preview source",
        ((error && error.name) || "Error") + ": " + ((error && error.message) || ""),
      );
    }
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS } },
      audio: false,
    });
  } catch (error) {
    logRecorderEvent(
      "crop preview displayMedia",
      ((error && error.name) || "Error") + ": " + ((error && error.message) || ""),
    );
    throw error;
  }
}

async function lockPreviewFrameRate(track) {
  if (!track || typeof track.applyConstraints !== "function") return;
  try {
    await track.applyConstraints({
      frameRate: { min: PREVIEW_FPS, ideal: PREVIEW_FPS, max: PREVIEW_FPS },
    });
  } catch {
    try {
      await track.applyConstraints({ frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS } });
    } catch {
      /* the capturer keeps the rate it opened with */
    }
  }
}

function setPreviewBox(video, left, top, width, height) {
  const next = {
    left: Math.round(left * 10) / 10 + "px",
    top: Math.round(top * 10) / 10 + "px",
    width: Math.round(width * 10) / 10 + "px",
    height: Math.round(height * 10) / 10 + "px",
  };
  if (video.style.left !== next.left) video.style.left = next.left;
  if (video.style.top !== next.top) video.style.top = next.top;
  if (video.style.width !== next.width) video.style.width = next.width;
  if (video.style.height !== next.height) video.style.height = next.height;
}

// Scale the screen so the crop matches the frame (contain), then shift the
// video. overflow on the clip hides everything outside the crop.
function placeCropPreviewVideo(video) {
  if (!video || !video.isConnected) return;
  const frame = video.closest(".area-frame");
  if (!frame) return;
  const rectW = frame.clientWidth;
  const rectH = frame.clientHeight;
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (rectW < 2 || rectH < 2 || srcW < 2 || srcH < 2) return;
  const crop = clampCrop(session.areaCrop || { x: 0, y: 0, w: 1, h: 1 });
  const scale = Math.min(rectW / (srcW * crop.w), rectH / (srcH * crop.h));
  const videoW = srcW * scale;
  const videoH = srcH * scale;
  video.style.objectFit = "fill";
  setPreviewBox(
    video,
    (rectW - crop.w * videoW) / 2 - crop.x * videoW,
    (rectH - crop.h * videoH) / 2 - crop.y * videoH,
    videoW,
    videoH,
  );
  frame.classList.add("has-live");
  if (!session.previewRateLocked && session.previewStream) {
    session.previewRateLocked = true;
    const track = session.previewStream.getVideoTracks()[0];
    // Wait until the crop is actually on screen, then pin the capturer.
    // A hidden element negotiates a slow rate and keeps it.
    requestAnimationFrame(() => {
      void lockPreviewFrameRate(track);
    });
  }
}

function watchPreviewFrame(video) {
  const frame = video && video.closest(".area-frame");
  if (session.previewObserver) {
    session.previewObserver.disconnect();
    session.previewObserver = null;
  }
  if (!frame || typeof ResizeObserver !== "function") return;
  session.previewObserver = new ResizeObserver(() => placeCropPreviewVideo(video));
  session.previewObserver.observe(frame);
}

function attachPreviewVideo(video, stream) {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.disablePictureInPicture = true;
  if (video.srcObject !== stream) video.srcObject = stream;
  session.previewVideo = video;
  watchPreviewFrame(video);
  const frame = video.closest(".area-frame");
  if (frame && video.videoWidth < 2 && frame.clientWidth >= 2 && frame.clientHeight >= 2) {
    setPreviewBox(video, 0, 0, frame.clientWidth, frame.clientHeight);
  }
  const place = () => placeCropPreviewVideo(video);
  video.onloadedmetadata = place;
  video.onresize = place;
  if (typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(() => placeCropPreviewVideo(video));
  }
  return Promise.resolve(video.play()).then(place);
}

function stopCropPreview() {
  session.previewGeneration += 1;
  if (session.previewObserver) {
    session.previewObserver.disconnect();
    session.previewObserver = null;
  }
  const frame = document.querySelector(".area-frame");
  if (frame) frame.classList.remove("has-live");
  const video = session.previewVideo;
  if (video) {
    video.onloadedmetadata = null;
    video.onresize = null;
    try {
      video.pause();
    } catch {
      /* already gone */
    }
    video.srcObject = null;
  }
  session.previewVideo = null;
  session.previewRateLocked = false;
  session.previewSourceId = "";
  if (session.previewStream) {
    stopStream(session.previewStream);
    session.previewStream = null;
  }
  session.previewStarting = false;
}

async function startCropPreview() {
  const video = document.querySelector("[data-area-live]");
  if (!video || document.hidden || session.phase !== "idle") return;
  if (!(session.target === "area" && session.areaCrop)) return;
  const sourceId = previewScreenSourceId() || recordSourcePick() || "auto";
  if (session.previewStream) {
    if (session.previewSourceId !== sourceId) {
      // A crop can move to another display. Never keep showing the previous
      // display's stream just because the video element was repainted.
      stopCropPreview();
    } else {
      try {
        await attachPreviewVideo(video, session.previewStream);
      } catch {
        stopCropPreview();
      }
      return;
    }
  }
  if (session.previewStarting) return;
  session.previewStarting = true;
  const generation = session.previewGeneration;
  let stream = null;
  try {
    stream = await openCropPreviewStream(sourceId);
    const live = document.querySelector("[data-area-live]");
    if (
      generation !== session.previewGeneration ||
      !live ||
      session.previewStream ||
      session.phase !== "idle" ||
      document.hidden
    ) {
      stopStream(stream);
      return;
    }
    session.previewStream = stream;
    session.previewSourceId = sourceId;
    const track = stream.getVideoTracks()[0];
    if (track) {
      try {
        track.contentHint = "motion";
      } catch {
        /* unsupported by this capture backend */
      }
      track.addEventListener(
        "ended",
        () => {
          if (session.previewStream === stream) stopCropPreview();
        },
        { once: true },
      );
    }
    if (generation !== session.previewGeneration || session.previewStream !== stream) return;
    await attachPreviewVideo(live, stream);
  } catch (error) {
    // Denied or unable to play: keep the (refreshed) thumbnail as a fallback.
    logRecorderEvent(
      "crop preview failed",
      ((error && error.name) || "Error") + ": " + ((error && error.message) || ""),
    );
    if (stream && session.previewStream === stream) stopCropPreview();
    else if (stream) stopStream(stream);
  } finally {
    if (generation === session.previewGeneration) session.previewStarting = false;
  }
}

// MP4/H.264 first: on Windows Chromium hands it to the hardware encoder.
// MP4 also carries a real duration header, so the take plays at once (webm
// from streamed chunks has to be scanned). It is the only offered format;
// WebM stays behind it for an engine that cannot encode H.264 at all.
function pickMime(stream) {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  const hasAudio =
    stream && typeof stream.getAudioTracks === "function" && stream.getAudioTracks().length > 0;
  const mp4Candidates = hasAudio
    ? [
        'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
        'video/mp4;codecs="avc1.42E01E,opus"',
        "video/mp4;codecs=avc1",
        "video/mp4",
      ]
    : ['video/mp4;codecs="avc1.42E01E"', "video/mp4;codecs=avc1", "video/mp4"];
  const webmCandidates = hasAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const mime of mp4Candidates.concat(webmCandidates)) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

// Software encoders quietly starve the machine when the bitrate climbs, so the
// rate follows the pixels the take actually ships rather than the encoder
// default: the Quality box sets the output height, and the width follows it.
function recordVideoBitrate(stream) {
  const size = streamSourceSize(stream);
  const w = Math.max(320, Math.round(size.w || 1280));
  const h = Math.max(180, Math.round(size.h || 720));
  return Math.min(48000000, Math.max(2000000, Math.round(w * h * (session.fps || 30) * 0.00025)));
}

async function beginRecording() {
  const pending = session.micPending;
  if (pending) {
    // A slow mic should not stall the take. Give it a short grace, then
    // record the screen without it; the late attach drops itself.
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (session.micPending === pending) session.micPending = null;
  }
  // The grace await above can outlive a bar close or an ended capture; a
  // stale start must not throw a fake "could not start" or latch onto a
  // newer bar's stream.
  if (session.phase !== "countdown" || !session.stream) return;
  session.chunks = [];
  session.elapsedMs = 0;
  session.startedAt = Date.now();
  session.endedWhileRecording = false;
  session.justSavedId = "";
  session.takeWriteFailed = false;
  session.takeChunks = 0;
  session.takeDataFailed = false;
  session.takeQueue = Promise.resolve();
  let recorder;
  try {
    const input = recordingInput() || session.stream;
    // A capture that died while the bar sat open (screen sleep, lock, a
    // dropped track) produces a take of nothing. Fail it like a capture
    // error instead of "saving" zero bytes.
    const live = input && typeof input.getTracks === "function" ? input.getTracks().filter((track) => track.readyState !== "ended") : [];
    if (!live.length) {
      throw Object.assign(new Error("The screen capture ended before the take could start."), { name: "NotReadableError" });
    }
    logRecorderEvent(
      "record input tracks",
      "audio=" + (input && input.getAudioTracks ? input.getAudioTracks().map((t) => t.readyState).join(",") : "none") +
        " video=" + (input && input.getVideoTracks ? input.getVideoTracks().map((t) => t.readyState).join(",") : "none") +
        " mic=" + (session.mic ? "on" : "off") + " micLive=" + (session.micLive ? "yes" : "no"),
    );
    const mime = pickMime(input);
    const options = {
      // The recorded stream (the scaler canvas when the take is cropped or
      // the display is taller than the chosen quality), not the raw capture,
      // decides the bitrate.
      videoBitsPerSecond: recordVideoBitrate(input),
      audioBitsPerSecond: 128000,
    };
    if (mime) options.mimeType = mime;
    session.takeWrite =
      api && typeof api.takeWriteStart === "function"
        ? api
            .takeWriteStart({ mime: mime || "video/webm" })
            .then((result) => (result && result.id) || null)
            .catch((error) => {
              logRecorderEvent("take write start failed", (error && error.message) || "");
              return null;
            })
        : Promise.resolve(null);
    recorder = new MediaRecorder(input, options);
    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      session.takeChunks += 1;
      const data = event.data;
      // Serialized so chunk order is preserved on disk.
      session.takeQueue = session.takeQueue.then(async () => {
        const id = await session.takeWrite;
        if (!id) {
          session.chunks.push(data);
          return;
        }
        try {
          const buffer = await data.arrayBuffer();
          const wrote = await api.takeWriteChunk({ id, buffer });
          if (wrote && wrote.ok === false) session.takeWriteFailed = true;
        } catch (error) {
          session.takeWriteFailed = true;
          logRecorderEvent("take chunk write failed", (error && error.message) || "");
        }
      });
    };
    recorder.onstop = () => {
      saveTake();
    };
    recorder.onerror = (event) => {
      session.takeDataFailed = true;
      session.takeWriteFailed = true;
      logRecorderEvent("recorder error", ((event && event.error && event.error.name) || "Error") + "");
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* saveTake still runs if stop throws */
      }
    };
    recorder.start(1000);
    // A take with no video should not run silently to zero bytes at Stop.
    // The mp4 muxer can buffer whole GOPs and emit nothing until much
    // later or even stop(), so a quiet chunk count only convicts a take
    // whose input track already gave up. Keep watching while it is silent.
    session.takeDataWatch = setTimeout(function watchTakeData() {
      if (session.takeChunks > 0) {
        session.takeDataWatch = 0;
        return;
      }
      const trackDead =
        !input ||
        typeof input.getVideoTracks !== "function" ||
        !input.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
      if (!trackDead) {
        if (session.recorder !== recorder || recorder.state === "inactive") {
          session.takeDataWatch = 0;
          return;
        }
        session.takeDataWatch = setTimeout(watchTakeData, 4000);
        return;
      }
      session.takeDataWatch = 0;
      if (session.recorder !== recorder || recorder.state === "inactive") return;
      session.takeDataFailed = true;
      logRecorderEvent("take produced no data", "stopping it");
      try {
        recorder.stop();
      } catch {
        /* saveTake still runs if stop throws */
      }
    }, 2500);
  } catch (error) {
    // The bar was already dismissed when the countdown finished. A throw
    // here (dead screen track, unsupported mime, a crop that made an empty
    // stream) used to leave the screen shared with nothing recording and no
    // error. Fail like a capture error instead.
    logRecorderEvent("record start failed", ((error && error.name) || "Error") + ": " + ((error && error.message) || ""));
    session.recorder = null;
    unbindCountdownIpc();
    stopCountdownOverlay();
    stopTracks();
    session.phase = "idle";
    session.error = "Recording could not start. Press Start Recorder Bar to try again.";
    toast(session.error, true);
    render();
    return;
  }
  session.recorder = recorder;
  session.phase = "recording";
  session.paused = false;
  session.pausedAt = 0;
  session.pausedTotal = 0;
  bindCountdownIpc();
  const overlay = countdownHost();
  if (overlay) {
    overlay.startCountdownOverlay({ recording: true });
  }
  session.timer = setInterval(() => {
    session.elapsedMs = recordElapsedMs();
    // Auto stop lands on the normal stop path, so the take saves cleanly.
    if (session.autoStopMs && session.elapsedMs >= session.autoStopMs) {
      onStop();
      return;
    }
    const clock = document.querySelector("[data-rec-clock]");
    if (clock) clock.textContent = formatClock(session.elapsedMs);
    const status = document.querySelector("[data-rec-status]");
    if (status) status.textContent = statusLine();
  }, 250);
}

// Take time the take actually recorded; paused spans do not count.
function recordElapsedMs() {
  const paused = session.pausedTotal + (session.paused ? Date.now() - session.pausedAt : 0);
  return Math.max(0, Date.now() - session.startedAt - paused);
}

function onStop() {
  stopCountdownOverlay();
  if (session.phase === "countdown") {
    closeRecorderBarFromOverlay();
    return;
  }
  if (!session.recorder || session.recorder.state === "inactive") return;
  session.elapsedMs = recordElapsedMs();
  // A stop while paused first resumes so the recorder flushes cleanly.
  if (session.paused && session.recorder.state === "paused") {
    try {
      session.recorder.resume();
    } catch {
      /* stop below still ends it */
    }
    session.paused = false;
  }
  try {
    session.recorder.stop();
  } catch (error) {
    toast(error.message || "Could not stop recording.", true);
  }
}

async function saveTake() {
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
  if (session.takeDataWatch) {
    clearTimeout(session.takeDataWatch);
    session.takeDataWatch = 0;
  }
  unbindCountdownIpc();
  const mime = (session.recorder && session.recorder.mimeType) || "video/webm";
  session.recorder = null;
  // A take cut short by the capture ending (monitor unplug, lock) is partial
  // footage even when every chunk wrote cleanly.
  const endedEarly = session.endedWhileRecording;
  session.endedWhileRecording = false;

  // The take already lives on disk when the write stream was up: finish it
  // and hand the file to main instead of re-reading it into memory.
  let takePath = "";
  if (session.takeWrite) {
    const takeId = await session.takeWrite.catch(() => null);
    await (session.takeQueue || Promise.resolve()).catch(() => {});
    if (takeId && api && typeof api.takeWriteFinish === "function") {
      const fin = await api.takeWriteFinish({ id: takeId }).catch(() => null);
      if (fin && fin.path && fin.size > 0) {
        takePath = fin.path;
        if (fin.failed) session.takeWriteFailed = true;
      } else if (api.takeWriteAbort) {
        await api.takeWriteAbort({ id: takeId }).catch(() => {});
      }
    }
    session.takeWrite = null;
    session.takeQueue = Promise.resolve();
  }
  const blob = takePath ? null : new Blob(session.chunks, { type: mime || "video/webm" });
  session.chunks = [];
  stopTracks();
  if (!takePath && !blob.size) {
    session.phase = "idle";
    session.error = session.takeDataFailed
      ? "No video came through. The screen may have been off or locked; press Record to try again."
      : "Nothing was recorded.";
    logRecorderEvent("take empty", "nothing was recorded");
    render();
    return;
  }
  if (!api || typeof api.takeSave !== "function" || typeof api.takeWriteStart !== "function") {
    session.phase = "idle";
    session.error = "Could not save the take.";
    logRecorderEvent("take save failed", "no save path");
    toast(session.error, true);
    render();
    return;
  }
  const name = nextTakeName(session.takes) + (session.takeWriteFailed || endedEarly ? " (partial)" : "");
  try {
    if (takePath) {
      const result = await api.takeSave({
        path: takePath,
        name,
        mime: mime || "video/webm",
        durationMs: session.elapsedMs || 0,
        partial: session.takeWriteFailed || endedEarly,
      });
      if (result && result.takes) session.takes = result.takes;
      if (result && result.take && result.take.id) {
        session.justSavedId = result.take.id;
        session.savedName = result.take.name || name;
        logRecorderEvent("take saved", (result.take.name || name) + " " + formatClock(session.elapsedMs || 0));
        toast("Recording saved.");
      } else {
        logRecorderEvent("take save failed", (result && result.error) || "no take row");
        session.error = (result && result.error) || "Could not save the take.";
      }
    } else {
      // No disk stream (very old build): buffer the blob through one call.
      const buffer = await blob.arrayBuffer();
      const start = await api.takeWriteStart({ mime: mime || "video/webm" });
      if (start && start.id) {
        await api.takeWriteChunk({ id: start.id, buffer });
        const fin = await api.takeWriteFinish({ id: start.id });
        if (fin && fin.path && fin.size > 0) {
          const result = await api.takeSave({
            path: fin.path,
            name,
            mime: mime || "video/webm",
            durationMs: session.elapsedMs || 0,
            partial: session.takeWriteFailed || endedEarly,
          });
          if (result && result.takes) session.takes = result.takes;
          if (result && result.take && result.take.id) {
            session.justSavedId = result.take.id;
            session.savedName = result.take.name || name;
            toast("Recording saved.");
          }
        }
      }
    }
  } catch (error) {
    session.error = error.message || "Could not save the take.";
    logRecorderEvent("take save failed", (error && error.message) || "");
    toast(session.error, true);
  }
  session.phase = "idle";
  render();
  paintTakes();
}

// ---------------------------------------------------------------------------
// Capture stream lifetime
// ---------------------------------------------------------------------------

function watchCaptureStreams() {
  unwatchCaptureStreams();
  captureWatchAbort = new AbortController();
  const { signal } = captureWatchAbort;
  const seen = new Set();
  for (const stream of [session.stream, session.screenStream, session.micStream]) {
    if (!stream || typeof stream.getTracks !== "function") continue;
    stream.getTracks().forEach((track) => {
      if (seen.has(track)) return;
      seen.add(track);
      track.addEventListener("ended", () => onCaptureEnded(track), { signal });
    });
  }
}

function unwatchCaptureStreams() {
  if (captureWatchAbort) captureWatchAbort.abort();
  captureWatchAbort = null;
}

function videoCaptureLive() {
  for (const stream of [session.stream, session.screenStream]) {
    if (!stream || typeof stream.getVideoTracks !== "function") continue;
    if (stream.getVideoTracks().some((track) => track.readyState === "live")) return true;
  }
  return false;
}

function micOnlyCaptureLoss(endedTrack) {
  if (!endedTrack || endedTrack.kind !== "audio") return false;
  return videoCaptureLive();
}

function onCaptureEnded(endedTrack) {
  if (session.ignoreCaptureEnded) return;
  if (micOnlyCaptureLoss(endedTrack)) {
    handleMicLost("Microphone disconnected.");
    return;
  }
  if (session.phase === "recording" && session.recorder && session.recorder.state !== "inactive") {
    session.endedWhileRecording = true;
    // The recording card must not outlive the take it just ended.
    stopCountdownOverlay();
    try {
      session.recorder.stop();
    } catch {
      /* saveTake still runs if stop throws after data */
    }
    return;
  }
  if (session.phase === "countdown") {
    session.phase = "idle";
    session.error = "Capture ended.";
    stopTracks();
    unbindCountdownIpc();
    render();
    return;
  }
  session.phase = "idle";
  session.error = "Capture ended.";
  stopTracks();
  render();
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  });
}

function stopTracks() {
  unwatchCaptureStreams();
  session.ignoreCaptureEnded = true;
  session.micError = "";
  session.micRetryBusy = false;
  if (session.mixTimer) clearInterval(session.mixTimer);
  session.mixTimer = 0;
  if (session.cropTimer) {
    clearInterval(session.cropTimer);
    session.cropTimer = 0;
  }
  const stopped = new Set();
  const stopOne = (track) => {
    if (!track || stopped.has(track)) return;
    stopped.add(track);
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  };
  const stopStreamTracks = (stream) => {
    if (!stream || typeof stream.getTracks !== "function") return;
    stream.getTracks().forEach(stopOne);
  };
  stopStreamTracks(session.recordStream);
  session.recordStream = null;
  stopStreamTracks(session.stream);
  stopStreamTracks(session.screenStream);
  stopStreamTracks(session.micStream);
  if (session.mixEls) {
    ["cropEl"].forEach((key) => {
      const el = session.mixEls[key];
      if (!el) return;
      try {
        el.srcObject = null;
      } catch {
        /* ignore */
      }
    });
  }
  session.stream = null;
  session.screenStream = null;
  session.micStream = null;
  session.micLive = false;
  session.mixEls = null;
  queueMicrotask(() => {
    session.ignoreCaptureEnded = false;
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ICON_TICK_LG =
  '<svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHEVRON =
  '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Custom listbox: a styled button that opens an option list. Arrow keys,
// Home/End, Enter, and Esc work; a press outside closes it.
const pickers = new Set();

function closePickers(except) {
  pickers.forEach((picker) => {
    if (picker !== except) picker.close(false);
  });
}

let pickerSeq = 0;
function createPicker(root, opts) {
  pickerSeq += 1;
  const id = "picker-" + pickerSeq;
  const labelledBy = opts && opts.labelledBy ? opts.labelledBy + " " : "";
  root.innerHTML =
    '<button type="button" class="picker-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + id + '" aria-labelledby="' + labelledBy + id + '-value">' +
    '<span class="picker-value" id="' + id + '-value"></span>' + ICON_CHEVRON + "</button>" +
    '<ul class="picker-list" role="listbox" id="' + id + '" tabindex="-1" hidden></ul>';
  const btn = root.querySelector(".picker-btn");
  const list = root.querySelector(".picker-list");
  const valueEl = root.querySelector(".picker-value");
  let options = [];
  let value = "";
  let active = -1;
  let disabled = false;

  const paintValue = () => {
    const hit = options.find((item) => item.value === value);
    valueEl.textContent = hit ? hit.label : (opts && opts.placeholder) || "";
  };
  const paintList = () => {
    list.innerHTML = options
      .map(
        (item, i) =>
          '<li role="option" class="picker-option" id="' + id + "-" + i + '" data-index="' + i + '" aria-selected="' + (item.value === value) + '">' +
          '<span class="picker-option-text"><span class="picker-option-label">' + esc(item.label) + "</span>" +
          (item.detail ? '<span class="picker-option-detail">' + esc(item.detail) + "</span>" : "") +
          '</span><span class="picker-tick">' + ICON_TICK_LG + "</span></li>",
      )
      .join("");
  };
  const setActive = (i) => {
    if (!options.length) return;
    active = Math.max(0, Math.min(options.length - 1, i));
    list.querySelectorAll(".picker-option").forEach((el, n) => {
      el.dataset.active = String(n === active);
    });
    list.setAttribute("aria-activedescendant", id + "-" + active);
    const el = list.children[active];
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };
  const self = {
    root,
    set(nextOptions, nextValue) {
      options = Array.isArray(nextOptions) ? nextOptions : [];
      value = String(nextValue ?? "");
      paintValue();
      if (!list.hidden) {
        paintList();
        setActive(active);
      }
    },
    setDisabled(on) {
      disabled = Boolean(on);
      btn.disabled = disabled;
      if (disabled) root.setAttribute("data-disabled", "");
      else root.removeAttribute("data-disabled");
      if (disabled) self.close(false);
    },
    open() {
      if (disabled || !options.length) return;
      closePickers(self);
      paintList();
      list.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      list.focus();
      setActive(Math.max(0, options.findIndex((item) => item.value === value)));
    },
    close(focusBtn) {
      if (list.hidden) return;
      list.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      list.removeAttribute("aria-activedescendant");
      if (focusBtn) btn.focus();
    },
  };
  const choose = (i) => {
    const item = options[i];
    self.close(true);
    if (!item || item.value === value) return;
    value = item.value;
    paintValue();
    if (opts && typeof opts.onChange === "function") opts.onChange(item.value);
  };
  btn.addEventListener("click", () => {
    if (list.hidden) self.open();
    else self.close(true);
  });
  btn.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      self.open();
    }
  });
  list.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault();
      if (key === "ArrowDown") setActive(active + 1);
      else if (key === "ArrowUp") setActive(active - 1);
      else setActive(key === "Home" ? 0 : options.length - 1);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      choose(active);
    } else if (key === "Escape") {
      event.preventDefault();
      self.close(true);
    } else if (key === "Tab") {
      self.close(false);
    }
  });
  list.addEventListener("pointermove", (event) => {
    const li = event.target.closest(".picker-option");
    if (li) setActive(Number(li.dataset.index));
  });
  list.addEventListener("click", (event) => {
    const li = event.target.closest(".picker-option");
    if (li) choose(Number(li.dataset.index));
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) self.close(false);
  });
  pickers.add(self);
  return self;
}

// ---------------------------------------------------------------------------
// Page: the studio boxes and the dock
// ---------------------------------------------------------------------------

const studio = {
  micPicker: null,
  sourceKey: "",
  targetsAt: 0,
  page: "studio",
  devModeBusy: false,
};

const PAGE_BLURB = {
  studio: "Set up the take, then start the recorder bar.",
  takes: "Recordings saved on this computer.",
  settings: "How this copy of Simple Recorder gets its updates.",
};

function showPage(name) {
  const next = Object.prototype.hasOwnProperty.call(PAGE_BLURB, name) ? name : "studio";
  if (next !== "studio") stopMeter();
  closePickers();
  studio.page = next;
  document.querySelectorAll("[data-page-panel]").forEach((el) => {
    el.hidden = el.getAttribute("data-page-panel") !== next;
  });
  document.querySelectorAll("[data-page]").forEach((btn) => {
    const on = btn.getAttribute("data-page") === next;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  const blurb = document.querySelector("[data-page-blurb]");
  if (blurb) blurb.textContent = PAGE_BLURB[next];
  if (next === "takes") {
    const fresh = document.querySelector(".take-card.is-new");
    if (fresh && typeof fresh.scrollIntoView === "function") fresh.scrollIntoView({ block: "nearest" });
  }
}

function screenLabel(screen) {
  if (!screen) return "";
  const size = screen.width && screen.height ? screen.width + " x " + screen.height : "";
  return [screen.label, size, screen.primary ? "Main" : ""].filter(Boolean).join(" · ");
}

function areaSizeText() {
  if (session.areaLabel) return session.areaLabel;
  const crop = session.areaCrop;
  if (!crop) return "";
  const screen = screenForDisplay(session.areaDisplayId);
  if (screen && screen.width && screen.height) {
    return Math.round(crop.w * screen.width) + " x " + Math.round(crop.h * screen.height);
  }
  return Math.round(crop.w * 100) + "% x " + Math.round(crop.h * 100) + "% of the screen";
}

function sourceText() {
  if (session.target === "area") {
    const size = areaSizeText();
    return "Area" + (size ? " " + size : "");
  }
  return "Screen under your pointer";
}

function micOptions() {
  const devices = session.micDevices.filter((item) => item.deviceId);
  const fallback = devices.find((item) => item.deviceId === "default");
  const list = [
    {
      value: "",
      label: "System default",
      detail: fallback && fallback.label ? fallback.label.replace(/^Default\s*-\s*/i, "") : "Follows your sound settings",
    },
  ];
  let n = 0;
  devices.forEach((item) => {
    if (item.deviceId === "default" || item.deviceId === "communications") return;
    n += 1;
    list.push({ value: item.deviceId, label: item.label || "Microphone " + n });
  });
  if (session.micDeviceId && !list.some((item) => item.value === session.micDeviceId)) {
    list.push({ value: session.micDeviceId, label: "Saved microphone", detail: "Not connected right now" });
  }
  return list;
}

function micText() {
  if (!session.mic) return "Off";
  if (!micRecording()) return "Blocked";
  const hit = micOptions().find((item) => item.value === session.micDeviceId);
  return hit ? hit.label : "System default";
}

async function refreshMicDevices() {
  const media = navigator.mediaDevices;
  if (!media || typeof media.enumerateDevices !== "function") return;
  try {
    const all = await media.enumerateDevices();
    session.micDevices = all.filter((item) => item.kind === "audioinput");
  } catch {
    session.micDevices = [];
  }
  session.micLabelsHidden = !session.micDevices.some((item) => item.label);
  paintMic();
  paintDock();
}

async function refreshTargets() {
  if (!api || typeof api.listCaptureTargets !== "function" || session.targetsLoading) return;
  session.targetsLoading = true;
  paintSource();
  try {
    const result = await api.listCaptureTargets();
    session.targets = {
      screens: Array.isArray(result && result.screens) ? result.screens : [],
      windows: Array.isArray(result && result.windows) ? result.windows : [],
    };
    session.targetsError = (result && result.error) || "";
  } catch {
    session.targetsError = "Could not list screens and windows.";
  }
  session.targetsLoading = false;
  session.targetsLoaded = true;
  studio.targetsAt = Date.now();
  render();
}

// Source picks. The bar may change them again once it is open.
function selectScreen() {
  if (isBusy()) return;
  session.crop = { x: 0, y: 0, w: 1, h: 1 };
  rememberTarget("auto", null);
  render();
}

// Back to the whole screen: forget the crop entirely.
function clearCrop() {
  if (isBusy()) return;
  session.areaCrop = null;
  session.areaLabel = "";
  session.areaDisplayId = "";
  session.crop = { x: 0, y: 0, w: 1, h: 1 };
  rememberTarget("auto", null);
  render();
}

async function drawArea(displayId) {
  if (isBusy() || session.areaPicking || !api || typeof api.pickAreaFromPage !== "function") return;
  session.areaPicking = true;
  stopCropPreview();
  render();
  let result = null;
  try {
    result = await api.pickAreaFromPage({ displayId: displayId || session.areaDisplayId || session.displayId || "" });
  } catch {
    result = null;
  }
  session.areaPicking = false;
  if (result && result.ok && result.crop) {
    session.areaLabel = String(result.label || "");
    rememberTarget("area", result.crop, String(result.displayId || ""));
    session.crop = session.target === "area" ? session.areaCrop : { x: 0, y: 0, w: 1, h: 1 };
  } else if (result && result.busy) {
    toast("Close the recorder bar first.");
  }
  render();
}

// Level meter: a short-lived mic stream measured with an analyser. It only
// runs while Test is on and stops the moment the bar opens.
const METER_SEGMENTS = 28;
const METER_HOT = 4;

function paintMeter(level) {
  const meter = document.querySelector("[data-mic-meter]");
  if (!meter) return;
  const lit = Math.round(Math.max(0, Math.min(1, level)) * METER_SEGMENTS);
  const segs = meter.children;
  for (let i = 0; i < segs.length; i += 1) {
    const on = i < lit;
    if (segs[i].classList.contains("on") !== on) segs[i].classList.toggle("on", on);
  }
  meter.setAttribute("aria-valuenow", String(Math.round(level * 100)));
}

async function startMeter() {
  stopMeter();
  if (!session.mic || !micAllowed() || isBusy()) return;
  const token = { stream: null, ctx: null, raf: 0 };
  session.meter = token;
  paintMic();
  let stream = null;
  try {
    stream = await openMicStream();
  } catch (error) {
    if (session.meter === token) session.meter = null;
    toast(micFailureText(error), true);
    paintMic();
    return;
  }
  if (session.meter !== token) {
    stopProbe(stream);
    return;
  }
  token.stream = stream;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  token.ctx = new Ctx();
  const analyser = token.ctx.createAnalyser();
  analyser.fftSize = 1024;
  token.ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let shown = 0;
  const tick = () => {
    if (session.meter !== token) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-5));
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    // Fast attack, slow release, like a hardware meter.
    shown = level > shown ? level : Math.max(level, shown - 0.025);
    paintMeter(shown);
    token.raf = requestAnimationFrame(tick);
  };
  tick();
  refreshMicDevices();
}

function stopMeter() {
  const token = session.meter;
  session.meter = null;
  if (!token) return;
  cancelAnimationFrame(token.raf);
  stopProbe(token.stream);
  if (token.ctx) token.ctx.close().catch(() => {});
  paintMeter(0);
  paintMic();
}

async function onMicSwitch() {
  if (isBusy() || session.micRetryBusy) return;
  const next = !session.mic;
  if (!next) stopMeter();
  await setSessionMic(next);
  if (session.mic) await refreshMicDevices();
}

function onMicDevice(id) {
  if (isBusy()) return;
  session.micDeviceId = String(id || "");
  rememberPrefs({ micDeviceId: session.micDeviceId });
  if (session.meter) void startMeter();
  render();
}

// The crop preview: shown only while a crop is set. The screen thumbnail
// carries the region box; several screens also pick which one to draw on.
function areaMarkup() {
  const screens = session.targets.screens;
  const screen = screenForDisplay(session.areaDisplayId) || screens.find((item) => item.primary) || screens[0] || null;
  const screenPicker = screens.length > 1 ? '<div class="picker" data-area-screen-picker></div>' : "";
  // The live video shows the cropped feed at 30 fps; the thumbnail sits
  // underneath until the first frame lands (or forever if capture fails).
  const live =
    '<div class="area-live-clip" data-area-live-clip><video class="area-live" data-area-live muted playsinline autoplay aria-hidden="true"></video></div>';
  return (
    '<div class="area-view">' +
    '<div class="area-frame">' + (screen && screen.thumbnail ? '<img alt="" src="' + esc(screen.thumbnail) + '" />' : "") + live + "</div>" +
    '<div class="area-actions">' + screenPicker +
    '<button type="button" class="secondary" data-draw-area' + (session.areaPicking ? " disabled" : "") + ">Draw again</button></div>" +
    "</div>"
  );
}

let areaScreenPick = "";

function paintSource() {
  const body = document.querySelector("[data-source-body]");
  if (!body) return;
  // The source row is the state: which button is pressed says what
  // records, and the crop label lives on the Draw button. The preview
  // below only shows while a crop is set.
  const tools = document.querySelector("[data-source-tools]");
  if (tools) {
    const full = tools.querySelector("[data-source-full]");
    if (full) full.setAttribute("aria-pressed", String(session.target === "auto"));
    const draw = tools.querySelector("[data-source-draw]");
    if (draw) {
      draw.setAttribute("aria-pressed", String(Boolean(session.areaPicking)));
      draw.disabled = Boolean(session.areaPicking);
      draw.textContent = session.areaPicking ? "Drawing…" : session.areaCrop ? "Redraw crop" : "Draw crop";
    }
    const clear = tools.querySelector("[data-source-clear]");
    if (clear) clear.hidden = !(session.target === "area" && session.areaCrop);
  }
  const key = JSON.stringify([
    studio.targetsAt,
    session.targetsLoading,
    session.phase,
    session.target,
    session.areaCrop,
    session.areaDisplayId,
    session.areaLabel,
    session.areaPicking,
  ]);
  if (key === studio.sourceKey) {
    // A repaint that did not rebuild the source box still has to bring the
    // preview back after the page was hidden, and drop it once the bar is up.
    if (
      session.target === "area" &&
      session.areaCrop &&
      session.phase === "idle" &&
      !session.areaPicking &&
      !session.targetsLoading &&
      !document.hidden
    ) {
      if (!session.previewStream && !session.previewStarting) void startCropPreview();
    } else if (session.previewStream || session.previewStarting) {
      stopCropPreview();
    }
    return;
  }
  studio.sourceKey = key;
  body.innerHTML = session.target === "area" && session.areaCrop ? areaMarkup() : "";
  pickers.forEach((picker) => {
    if (!picker.root.isConnected) pickers.delete(picker);
  });
  // The page CSP forbids inline style attributes; place the box via CSSOM.
  const preview = body.querySelector("[data-area-preview]");
  if (preview && session.areaCrop) {
    const crop = session.areaCrop;
    preview.style.left = crop.x * 100 + "%";
    preview.style.top = crop.y * 100 + "%";
    preview.style.width = crop.w * 100 + "%";
    preview.style.height = crop.h * 100 + "%";
  }
  studio.areaPicker = null;
  // The live crop preview rides the idle page only: the bar's own capture
  // takes over once it opens.
  if (
    session.target === "area" &&
    session.areaCrop &&
    session.phase === "idle" &&
    !session.areaPicking &&
    !session.targetsLoading
  ) {
    void startCropPreview();
  } else {
    stopCropPreview();
  }
  const holder = body.querySelector("[data-area-screen-picker]");
  if (holder) {
    // Several screens: say which one the area gets drawn on.
    const screens = session.targets.screens;
    if (!screenForDisplay(areaScreenPick)) areaScreenPick = session.areaDisplayId || session.displayId || "";
    if (!screenForDisplay(areaScreenPick)) areaScreenPick = (screens.find((item) => item.primary) || screens[0]).displayId;
    const picker = createPicker(holder, {
      placeholder: "Screen",
      onChange: (value) => {
        areaScreenPick = value;
      },
    });
    picker.set(
      screens.map((item) => ({ value: item.displayId, label: "On " + item.name, detail: screenLabel(item) })),
      areaScreenPick,
    );
    picker.setDisabled(session.areaPicking);
    studio.areaPicker = picker;
  }
}

function paintMic() {
  const sw = document.querySelector("[data-mic-switch]");
  if (sw) {
    sw.setAttribute("aria-checked", String(Boolean(session.mic)));
    sw.disabled = session.micRetryBusy;
  }
  const summary = document.querySelector("[data-mic-summary]");
  if (summary) {
    summary.textContent = session.micRetryBusy
      ? "Asking for your microphone"
      : micRecording()
        ? "Sound is recorded with the video"
        : session.mic
          ? "Microphone blocked"
          : "Sound off";
  }
  if (studio.micPicker) studio.micPicker.set(micOptions(), session.micDeviceId);
  const test = document.querySelector("[data-mic-test]");
  if (test) {
    const running = Boolean(session.meter);
    test.setAttribute("aria-pressed", String(running));
    test.textContent = running ? "Stop" : "Test";
    test.disabled = !running && (!session.mic || !micAllowed() || isBusy());
  }
  const meter = document.querySelector("[data-mic-meter]");
  if (meter) {
    if (session.meter) meter.removeAttribute("data-idle");
    else meter.setAttribute("data-idle", "");
  }
  const note = document.querySelector("[data-mic-note]");
  if (note) {
    const hint = micHint();
    const osDenied = Boolean(session.setup && session.setup.mic && session.setup.mic.osDenied);
    let html = "";
    if (hint && !micRecording()) {
      html = esc(hint) + (osDenied ? ' <button type="button" data-mic-settings>Open Settings</button>' : "");
    } else if (session.micLabelsHidden && session.micDevices.length) {
      html = "Turn sound on to see your microphones by name.";
    } else if (!session.micDevices.length && session.setupLoaded) {
      html = "No microphone found on this computer.";
    }
    if (note.innerHTML !== html) note.innerHTML = html;
  }
}

function paintChoices() {
  document.querySelectorAll("[data-fps]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.getAttribute("data-fps")) === clampRecordFps(session.fps)));
  });
  const delay = clampDelayMs(session.delayMs);
  document.querySelectorAll("[data-delay]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.getAttribute("data-delay")) === delay));
  });
  const delayNote = document.querySelector("[data-delay-summary]");
  if (delayNote) {
    delayNote.textContent = delay ? "Record counts down " + delayLabel(delay) + " first." : "Record starts right away.";
  }
  document.querySelectorAll("[data-format]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.getAttribute("data-format") === RECORD_FORMAT));
  });
  const quality = clampQuality(session.quality);
  document.querySelectorAll("[data-quality]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.getAttribute("data-quality") === quality));
  });
  const qualityNote = document.querySelector("[data-quality-summary]");
  if (qualityNote) {
    qualityNote.textContent =
      quality === DEFAULT_QUALITY
        ? "Records at 1080p."
        : "Records at " + quality + ".";
  }
  const autoStop = clampAutoStopMs(session.autoStopMs);
  document.querySelectorAll("[data-autostop]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.getAttribute("data-autostop")) === autoStop));
  });
  const autoStopNote = document.querySelector("[data-autostop-summary]");
  if (autoStopNote) {
    autoStopNote.textContent = autoStop
      ? "Recording stops by itself after " + Math.round(autoStop / 60000) + " minutes."
      : "Recording runs until you stop it.";
  }
}

function dockItem(name, value) {
  return "<div><dt>" + esc(name) + "</dt><dd>" + esc(value) + "</dd></div>";
}

function dockActionsMarkup() {
  if (session.phase === "recording") {
    return (
      '<span class="dock-clock"><i class="record-dot" aria-hidden="true"></i><span data-rec-clock>' +
      esc(formatClock(session.elapsedMs || 0)) +
      "</span></span>" +
      '<p class="dock-status">' +
      esc(session.paused ? "Paused. Resume or Stop on the bar." : "Stop here, on the bar, or press Ctrl+Shift+Alt+S.") +
      "</p>" +
      '<button type="button" class="danger dock-go" data-rec-stop>Stop</button>'
    );
  }
  if (session.phase === "countdown" && !session.stream) {
    return (
      '<span class="spinner" aria-hidden="true"></span>' +
      '<p class="dock-status" role="status">Getting the recorder bar ready</p>' +
      '<button type="button" data-rec-stop>Close bar</button>'
    );
  }
  if (session.phase === "countdown") {
    return (
      '<p class="dock-status">The bar is at the top of the screen. Change the take there, then press Record.</p>' +
      '<button type="button" data-rec-stop>Close bar</button>' +
      '<button type="button" class="primary dock-go" data-rec-now><i class="record-dot" aria-hidden="true"></i>Record now</button>'
    );
  }
  const status = session.error
    ? '<p class="dock-status is-error" role="alert">' + esc(session.error) + "</p>"
    : '<p class="dock-status">The bar opens with these settings. Record from there.</p>';
  return (
    status +
    '<button type="button" class="primary dock-go" data-rec-start' + (session.areaPicking ? " disabled" : "") +
    '><i class="record-dot" aria-hidden="true"></i>Start Recorder Bar</button>'
  );
}

let dockKey = "";
function paintDock() {
  const summary = document.querySelector("[data-dock-summary]");
  if (summary) {
    const html =
      dockItem("Source", sourceText()) +
      dockItem("Microphone", micText()) +
      dockItem("Frame rate", clampRecordFps(session.fps) + " fps") +
      dockItem("Delay", delayLabel(session.delayMs));
    if (summary.innerHTML !== html) summary.innerHTML = html;
  }
  const actions = document.querySelector("[data-dock-actions]");
  if (!actions) return;
  const key = [session.phase, Boolean(session.stream), session.error, session.areaPicking, session.paused].join("|");
  if (key === dockKey && session.phase !== "recording") return;
  dockKey = key;
  actions.innerHTML = dockActionsMarkup();
}

function render() {
  const busy = isBusy();
  const studioEl = document.querySelector("[data-studio]");
  if (studioEl) {
    if (busy) studioEl.setAttribute("data-locked", "");
    else studioEl.removeAttribute("data-locked");
    studioEl.toggleAttribute("inert", busy);
  }
  const lock = document.querySelector("[data-lock-note]");
  if (lock) lock.hidden = !busy;
  if (studio.micPicker) studio.micPicker.setDisabled(busy);
  paintSource();
  paintMic();
  paintChoices();
  paintDock();
  paintUpdates();
}

function paintUpdates() {
  const u = session.update || {};
  const currentTag = u.currentTag || "v1.0.0";
  const busyUpdate = u.status === "checking" || u.status === "downloading" || u.status === "installing";
  const offered = Boolean(u.updateAvailable && u.latestTag) || busyUpdate || u.status === "installed";

  const summary = document.querySelector("[data-update-summary]");
  if (summary) {
    if (u.status === "downloading") summary.textContent = "New update detected";
    else if (u.status === "installing") summary.textContent = "New update detected";
    else if (u.needsRestart) summary.textContent = "Restarting";
    else if (u.switchAvailable && u.latestTag) summary.textContent = u.channel === "developer" ? "Developer build ready" : "Public release ready";
    else if (u.updateAvailable && u.latestTag) summary.textContent = "New update detected";
    else if (u.status === "checking") summary.textContent = "Checking for updates";
    else if (u.status === "error") summary.textContent = "Could not check · " + currentTag;
    else summary.textContent = "Up to date · " + currentTag;
  }

  const button = document.querySelector("[data-update-download]");
  if (button) {
    button.hidden = !offered;
    button.disabled = busyUpdate || u.needsRestart || isBusy();
    if (u.status === "downloading") button.textContent = "Downloading…";
    else if (u.status === "installing") button.textContent = "Installing…";
    else if (u.needsRestart) button.textContent = "Restarting…";
    else button.textContent = u.latestTag ? "Download " + u.latestTag : "Download";
  }

  const note = document.querySelector("[data-update-note]");
  if (note) {
    note.textContent =
      u.error ||
      (u.needsRestart
        ? "Restarting to finish the update."
        : u.switchAvailable && u.latestTag
          ? "Installing " + u.latestTag + " moves this copy to " + channelLabel(u.channel) + "s. Your data stays, and a copy is saved first."
        : u.updateAvailable && u.latestTag
          ? u.latestTag + " is ready to download."
          : u.developerMode
            ? "Developer mode updates are on: builds come from the private development repo."
            : u.installMode === "development"
              ? "Dev build: GitHub Releases never rewrite this checkout."
              : "Updates come from GitHub Releases.");
  }
  paintDeveloperUpdates();
}

function paintDeveloperUpdates() {
  const u = session.update || {};
  const on = Boolean(u.developerMode);
  const busyUpdate = u.status === "downloading" || u.status === "installing";
  const toggle = document.querySelector("[data-dev-updates-switch]");
  if (toggle) {
    toggle.setAttribute("aria-checked", String(on));
    toggle.disabled = busyUpdate || studio.devModeBusy;
  }
  const summary = document.querySelector("[data-dev-updates-summary]");
  if (summary) {
    summary.textContent = on
      ? "Updates come from the private development repo."
      : "Updates come from public releases.";
  }
  const note = document.querySelector("[data-dev-updates-note]");
  if (note) note.textContent = on && u.error ? u.error : "";
  const installed = document.querySelector("[data-installed-channel]");
  if (installed) {
    installed.textContent =
      u.installMode === "development"
        ? "This copy is a source checkout."
        : u.installedChannel === "developer"
          ? "This copy is a developer build."
          : "This copy is a public release.";
  }
  paintBackups(u);
}

function paintBackups(u) {
  const keep = u.backupKeep || "2";
  document.querySelectorAll("[data-backup-keep]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.getAttribute("data-backup-keep") === keep));
    btn.disabled = u.status === "downloading" || u.status === "installing";
  });
  const note = document.querySelector("[data-backup-summary]");
  if (!note) return;
  const count = Number(u.backupCount) || 0;
  const held = count === 1 ? "1 backup" : count + " backups";
  const size = formatBytes(u.backupBytes) || "0 KB";
  note.textContent =
    keep === "off"
      ? "Backups are off: updates install without a copy of your data. The folder holds " + held + " (" + size + ")."
      : keep === "all"
        ? "Every backup is kept. The folder holds " + held + " (" + size + ")."
        : "The newest " + keep + " are kept and older ones are removed. The folder holds " + held + " (" + size + ").";
}

async function onBackupKeep(event) {
  const btn = event.target.closest("[data-backup-keep]");
  if (!btn || btn.disabled || !api || typeof api.updateSetBackupKeep !== "function") return;
  try {
    const state = await api.updateSetBackupKeep(btn.getAttribute("data-backup-keep"));
    if (state) {
      session.update = state;
      paintUpdates();
    }
  } catch {
    toast("Could not change the backup setting.", true);
  }
}

function channelLabel(channel) {
  return channel === "developer" ? "developer build" : "public release";
}

async function onOpenBackups() {
  if (!api || typeof api.openDataBackups !== "function") return;
  try {
    const res = await api.openDataBackups();
    if (res && !res.ok) toast("Could not open the backups folder.", true);
  } catch {
    toast("Could not open the backups folder.", true);
  }
}

async function onDeveloperUpdatesSwitch() {
  if (!api || typeof api.updateSetDeveloperMode !== "function" || studio.devModeBusy) return;
  const next = !(session.update && session.update.developerMode);
  studio.devModeBusy = true;
  paintDeveloperUpdates();
  try {
    const state = await api.updateSetDeveloperMode(next);
    if (state) session.update = state;
  } catch {
    toast("Could not change Developer mode updates.", true);
  } finally {
    studio.devModeBusy = false;
  }
  paintUpdates();
}

async function onUpdateDownload() {
  if (!api || typeof api.updateInstall !== "function") return;
  const u = session.update || {};
  if (!u.updateAvailable || u.status === "downloading" || u.status === "installing") return;
  if (isBusy()) {
    toast("Stop the current recording before updating.", true);
    return;
  }
  try {
    const state = await api.updateInstall({ tag: u.latestTag });
    if (state) {
      session.update = state;
      if (state.error) toast(state.error, true);
    }
  } catch {
    toast("Could not download that update.", true);
  }
  paintUpdates();
}

function wireStudio() {
  const meter = document.querySelector("[data-mic-meter]");
  if (meter && !meter.children.length) {
    meter.innerHTML = Array.from({ length: METER_SEGMENTS }, (_, i) =>
      i >= METER_SEGMENTS - METER_HOT ? '<i class="hot"></i>' : "<i></i>",
    ).join("");
  }
  const micHolder = document.querySelector("[data-mic-picker]");
  if (micHolder) {
    studio.micPicker = createPicker(micHolder, { labelledBy: "mic-input-label", onChange: onMicDevice });
  }
  document.querySelector("[data-update-download]")?.addEventListener("click", () => void onUpdateDownload());
  document.querySelector("[data-dev-updates-switch]")?.addEventListener("click", () => void onDeveloperUpdatesSwitch());
  document.querySelector("[data-open-backups]")?.addEventListener("click", () => void onOpenBackups());
  document.querySelector("[data-backup-keep-group]")?.addEventListener("click", (event) => void onBackupKeep(event));
  if (api && typeof api.onUpdateState === "function") {
    api.onUpdateState((state) => {
      if (!state) return;
      const prevStatus = session.update && session.update.status;
      session.update = state;
      paintUpdates();
      if (state.status === "installed" && prevStatus !== "installed" && state.message) {
        toast(state.message);
      }
    });
  }
  document.querySelector("[data-source-tools]")?.addEventListener("click", (event) => {
    const el = event.target;
    if (el.closest("[data-source-full]")) return selectScreen();
    if (el.closest("[data-source-draw]")) return void drawArea();
    if (el.closest("[data-source-clear]")) return clearCrop();
  });
  document.querySelector("[data-source-body]")?.addEventListener("click", (event) => {
    const el = event.target;
    if (el.closest(".picker")) return;
    if (el.closest("[data-draw-area]")) void drawArea(studio.areaPicker ? areaScreenPick : "");
  });
  document.querySelector("[data-mic-switch]")?.addEventListener("click", () => void onMicSwitch());
  document.querySelector("[data-mic-test]")?.addEventListener("click", () => {
    if (session.meter) stopMeter();
    else void startMeter();
  });
  document.querySelector("[data-mic-note]")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-mic-settings]")) void openOsSettingsAndWait("mic").then(() => render());
  });
  document.querySelector("[data-fps-group]")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-fps]");
    if (!btn || isBusy()) return;
    session.fps = clampRecordFps(btn.getAttribute("data-fps"));
    rememberPrefs({ recordFps: session.fps });
    render();
  });
  document.querySelector("[data-delay-group]")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-delay]");
    if (!btn || isBusy()) return;
    session.delayMs = clampDelayMs(btn.getAttribute("data-delay"));
    rememberPrefs({ recordDelayMs: session.delayMs });
    render();
  });
  // The File format box has one live option, so there is nothing to wire:
  // the disabled WebM placeholder cannot fire a click.
  document.querySelector("[data-quality-group]")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-quality]");
    if (!btn || btn.disabled || isBusy()) return;
    session.quality = clampQuality(btn.getAttribute("data-quality"));
    rememberPrefs({ recordQuality: session.quality });
    render();
  });
  document.querySelector("[data-autostop-group]")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-autostop]");
    if (!btn || isBusy()) return;
    session.autoStopMs = clampAutoStopMs(btn.getAttribute("data-autostop"));
    rememberPrefs({ recordAutoStopMs: session.autoStopMs });
    render();
  });
  document.querySelector(".sidebar .nav")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-page]");
    if (!tab) return;
    showPage(tab.getAttribute("data-page"));
  });
  document.querySelector("[data-dock-actions]")?.addEventListener("click", (event) => {
    const el = event.target;
    if (el.closest("[data-rec-start]")) {
      void onStart();
    } else if (el.closest("[data-rec-now]")) {
      if (session.phase === "countdown" && api && typeof api.overlayRecordNow === "function") api.overlayRecordNow();
    } else if (el.closest("[data-rec-stop]")) {
      onStop();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".picker")) closePickers();
    // A saved crop opens with no click, and getDisplayMedia can refuse that.
    // The next press on the page is a gesture, so try the preview again.
    // Source and dock buttons change the crop in the same turn, so they
    // are not the retry.
    if (
      session.target === "area" &&
      session.areaCrop &&
      session.phase === "idle" &&
      !session.previewStream &&
      !session.previewStarting &&
      !document.hidden &&
      !event.target.closest("[data-source-tools]") &&
      !event.target.closest("[data-dock-actions]") &&
      !event.target.closest(".sidebar")
    ) {
      void startCropPreview();
    }
  });
  // Coming back from another app is when new windows appear.
  window.addEventListener("focus", () => {
    if (!isBusy()) void refreshTargets();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopMeter();
      stopCropPreview();
    } else if (isBusy()) {
      render();
    } else {
      // Refresh the screen thumbnail before opening the preview again. If
      // capture falls back to the thumbnail, it must show the current screen,
      // not the page that happened to be open when the app last fetched it.
      void refreshTargets();
    }
  });
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", () => void refreshMicDevices());
  }
}

function takeVideoUrl(take) {
  return "take://file/" + encodeURIComponent(take.path);
}

function takeMeta(take) {
  const parts = [];
  const ms = Number(take && take.durationMs);
  if (Number.isFinite(ms) && ms > 0) parts.push(formatClock(ms));
  const size = formatBytes(take && take.size);
  if (size) parts.push(size);
  const when = Date.parse(take && take.createdAt);
  if (Number.isFinite(when) && when > 0) {
    const date = new Date(when);
    parts.push(
      date.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " +
        date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
  }
  if (take && take.partial) parts.push("Partial");
  return parts.join(" · ");
}

// The takes page mirrors the folders in Explorer: one section per day
// folder, headed by the folder name the files actually sit in.
function takeDayLabel(day) {
  const when = Date.parse(day + "T00:00:00");
  if (!Number.isFinite(when)) return "Unsorted";
  return new Date(when).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function takeGroups(takes) {
  const groups = [];
  const seen = new Map();
  for (const take of takes) {
    const day = String((take && take.day) || "");
    let group = seen.get(day);
    if (!group) {
      group = { day, label: takeDayLabel(day), takes: [] };
      seen.set(day, group);
      groups.push(group);
    }
    group.takes.push(take);
  }
  return groups;
}

function takeCards(takes) {
  return takes
    .map((take) => {
      const isNew = take.id && take.id === session.justSavedId;
      const deleting = take.id === session.deletingId;
      return (
        '<div class="take-card' + (isNew ? " is-new" : "") + '" data-take="' + esc(take.id) + '"' + (deleting ? " aria-busy=\"true\"" : "") + ">" +
        '<video class="take-video"' + (deleting ? "" : ' src="' + esc(takeVideoUrl(take)) + '"') + ' preload="metadata" muted playsinline></video>' +
        '<div class="take-body">' +
        '<span class="take-name">' + esc(take.name || "Take") + (isNew ? '<span class="take-new-badge">New</span>' : "") + "</span>" +
        '<span class="take-meta">' + esc(takeMeta(take)) + "</span>" +
        '<div class="take-actions">' +
        '<button type="button" data-take-show="' + esc(take.id) + '">Show in folder</button>' +
        '<button type="button" data-take-open="' + esc(take.id) + '">Open</button>' +
        '<button type="button" class="danger" data-take-delete="' + esc(take.id) + '"' +
        (session.deletingId ? " disabled" : "") + ">" + (deleting ? "Deleting" : "Delete") + "</button>" +
        "</div>" +
        "</div></div>"
      );
    })
    .join("");
}

function paintTakes() {
  const grid = document.querySelector("[data-takes]");
  if (!grid) return;
  const takes = Array.isArray(session.takes) ? session.takes : [];
  if (!takes.length) {
    grid.innerHTML = '<p class="takes-empty">No takes yet. Record one from Studio, and it shows up here.</p>';
    return;
  }
  grid.innerHTML = takeGroups(takes)
    .map((group) => {
      const count = group.takes.length + (group.takes.length === 1 ? " take" : " takes");
      return (
        '<section class="take-group" data-take-day="' + esc(group.day) + '">' +
        '<h3 class="take-group-head">' +
        (group.day ? '<span class="take-group-day">' + esc(group.day) + "</span>" : "") +
        '<span class="take-group-when">' + esc(group.label) + "</span>" +
        '<span class="take-group-count">' + esc(count) + "</span>" +
        "</h3>" +
        takeCards(group.takes) +
        "</section>"
      );
    })
    .join("");
  const fresh = grid.querySelector('.take-card[data-take="' + session.justSavedId + '"]');
  if (fresh && studio.page === "takes" && typeof fresh.scrollIntoView === "function") {
    fresh.scrollIntoView({ block: "nearest" });
  }
}

// The preview video holds the file open, and Windows will not delete an open
// file. Let go of it first; paintTakes puts the preview back if it stays.
function releaseTakePreview(id) {
  const card = document.querySelector('.take-card[data-take="' + CSS.escape(id) + '"]');
  const video = card && card.querySelector("video.take-video");
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    /* already released */
  }
}

async function deleteTake(id) {
  if (!id || session.deletingId || !api || typeof api.takeDelete !== "function") return;
  session.deletingId = id;
  paintTakes();
  releaseTakePreview(id);
  let result = null;
  try {
    result = await api.takeDelete(id);
  } catch {
    result = { ok: false, error: "Could not delete that recording." };
  }
  session.deletingId = "";
  if (result && Array.isArray(result.takes)) session.takes = result.takes;
  if (result && result.ok) {
    if (session.justSavedId === id) session.justSavedId = "";
    toast("Recording deleted.");
  } else if (result && !result.cancelled) {
    toast(result.error || "Could not delete that recording.", true);
  }
  paintTakes();
}

function wireTakes() {
  const grid = document.querySelector("[data-takes]");
  if (!grid) return;
  grid.addEventListener("click", (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (!target) return;
    const show = target.closest("[data-take-show]");
    if (show) {
      api.takeShow(show.getAttribute("data-take-show")).catch(() => {});
      return;
    }
    const open = target.closest("[data-take-open]");
    if (open) {
      api.takeOpen(open.getAttribute("data-take-open")).catch(() => {});
      return;
    }
    const del = target.closest("[data-take-delete]");
    if (del) {
      void deleteTake(del.getAttribute("data-take-delete"));
      return;
    }
    const video = target.closest("video.take-video");
    if (video) {
      if (video.paused) {
        video.muted = false;
        video.controls = true;
        void video.play().catch(() => {});
      } else {
        video.pause();
      }
    }
  });
}

async function refreshTakes() {
  if (!api || typeof api.takesList !== "function") return;
  try {
    const result = await api.takesList();
    if (result && Array.isArray(result.takes)) session.takes = result.takes;
    if (result && result.recordingsDir) session.recordingsDir = result.recordingsDir;
  } catch {
    /* list stays as-is */
  }
  paintTakes();
}

async function boot() {
  if (!api) {
    const actions = document.querySelector("[data-dock-actions]");
    if (actions) actions.innerHTML = '<p class="dock-status is-error">The recorder bridge did not load. Restart the app.</p>';
    return;
  }
  wireStudio();
  render();
  wireTakes();
  document.querySelector("[data-open-folder]")?.addEventListener("click", () => {
    void api.recordingsOpen().catch(() => {});
  });
  try {
    const [status, updateState] = await Promise.all([
      api.captureSetupStatus(),
      typeof api.updateStatus === "function" ? api.updateStatus().catch(() => null) : Promise.resolve(null),
    ]);
    session.setup = status;
    session.setupLoaded = true;
    applyPrefs(status);
    if (updateState) session.update = updateState;
  } catch {
    session.setupLoaded = true;
  }
  render();
  await Promise.all([refreshTargets(), refreshMicDevices(), refreshTakes()]);
  render();
  // Main builds the overlay windows hidden after launch; cover the case
  // where they were torn down since.
  if (api && typeof api.prewarmRecorderBar === "function") api.prewarmRecorderBar();
}

void boot();
