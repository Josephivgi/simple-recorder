// Simple Recorder pages + take engine.
// Three pages: Studio (source, mic, frame rate, delay, and the bottom dock),
// Takes (saved files), and Settings (Default quality). The floating
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
  previewFrame: null,
  previewSourceId: "",
  previewStarting: false,
  previewGeneration: 0,
  previewRateLocked: false,
  previewLive: false,
  previewFailed: false,
  previewStillOk: false,
  previewStillBusy: false,
  previewStillTimer: 0,
  micDevices: [],
  micLabelsHidden: false,
  meter: null,
  update: {
    repo: "Josephivgi/simple-recorder",
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
// Crop preview: the frame always shows the rectangle a take records.
//
// Two layers can carry it. The live screen capture is the intent: a 30 fps
// look at the crop. When the capturer will not start (a wedged OS capture
// stack, a denied permission) the frame keeps the crop with a still
// screenshot of the same screen, refreshed on a slow timer, plus a note and
// a Retry. Both layers are placed by the same math, so the preview never
// turns into the whole uncropped desktop, a frozen frame, or an empty box
// that reads as the app being broken.
// ---------------------------------------------------------------------------

const PREVIEW_FPS = 30;
const STILL_REFRESH_MS = 1200;

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

// Contain the source in the frame so the crop box exactly fills it, then
// shift it. The frame clips the overflow, so only the crop shows.
function cropPlacement(rectW, rectH, srcW, srcH, crop) {
  const scale = Math.min(rectW / (srcW * crop.w), rectH / (srcH * crop.h));
  const width = srcW * scale;
  const height = srcH * scale;
  return {
    left: (rectW - crop.w * width) / 2 - crop.x * width,
    top: (rectH - crop.h * height) / 2 - crop.y * height,
    width,
    height,
  };
}

// One frame, both layers: whichever of them holds a real picture is placed
// for the current crop, and the CSS decides which one is on screen. The CSS
// classes follow the pixels (a layer is marked only once it has a frame), so
// a slow or refused capture can never leave an empty box behind.
function placeAreaFrame(frame) {
  if (!frame || !frame.isConnected) return;
  const rectW = frame.clientWidth;
  const rectH = frame.clientHeight;
  if (rectW < 2 || rectH < 2) return;
  const crop = clampCrop(session.areaCrop || { x: 0, y: 0, w: 1, h: 1 });
  const place = (el, srcW, srcH) => {
    if (!el || !(srcW >= 2) || !(srcH >= 2)) return;
    const box = cropPlacement(rectW, rectH, srcW, srcH, crop);
    el.style.objectFit = "fill";
    setPreviewBox(el, box.left, box.top, box.width, box.height);
  };
  const live = frame.querySelector("[data-area-live]");
  if (live && live.videoWidth >= 2 && live.videoHeight >= 2) {
    place(live, live.videoWidth, live.videoHeight);
    frame.classList.add("has-live");
    session.previewLive = true;
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
  const still = frame.querySelector("[data-area-still]");
  if (still && still.naturalWidth >= 2) {
    place(still, still.naturalWidth, still.naturalHeight);
    frame.classList.add("has-still");
    session.previewStillOk = true;
  }
  paintPreviewState();
}

function watchPreviewFrame(frame) {
  if (!frame) return;
  if (session.previewObserver && session.previewFrame === frame) return;
  if (session.previewObserver) {
    session.previewObserver.disconnect();
    session.previewObserver = null;
  }
  if (typeof ResizeObserver !== "function") return;
  session.previewFrame = frame;
  session.previewObserver = new ResizeObserver(() => placeAreaFrame(frame));
  session.previewObserver.observe(frame);
}

// The still layer is an <img>, so it has to be placed again every time a new
// screenshot lands (its natural size is only known once it decodes).
function watchStillImage(img) {
  if (!img) return;
  const frame = img.closest(".area-frame");
  if (!frame) return;
  const place = () => placeAreaFrame(frame);
  if (img.complete) place();
  else img.onload = place;
}

// The note over the preview only appears once a live attempt has actually
// failed, so a preview that is still connecting never looks broken.
function paintPreviewState() {
  const note = document.querySelector("[data-area-note]");
  if (!note) return;
  const failed = session.previewFailed && !session.previewLive;
  note.hidden = !failed;
  if (!failed) return;
  const text = note.querySelector("[data-area-note-text]");
  if (text) {
    text.textContent = session.previewStillOk
      ? "Live preview unavailable · showing a still image"
      : "Live preview unavailable";
  }
}

function stopStillRefresh() {
  if (session.previewStillTimer) {
    clearTimeout(session.previewStillTimer);
    session.previewStillTimer = 0;
  }
}

function scheduleStillRefresh() {
  if (session.previewStillTimer) return;
  session.previewStillTimer = setTimeout(() => {
    session.previewStillTimer = 0;
    void refreshPreviewStill();
  }, STILL_REFRESH_MS);
}

// Swap in a screenshot only once it has decoded, so a failed capture leaves
// the previous picture alone instead of a broken image in the frame. A frame
// that started with no thumbnail at all gets its image here.
function applyPreviewStill(url) {
  if (!url) return;
  const probe = new Image();
  probe.onload = () => {
    if (session.previewLive) return;
    const frame = document.querySelector(".area-frame");
    if (!frame) return;
    let img = frame.querySelector("[data-area-still]");
    if (!img) {
      img = document.createElement("img");
      img.className = "area-still";
      img.setAttribute("data-area-still", "");
      img.alt = "";
      frame.insertBefore(img, frame.firstChild);
    }
    img.src = url;
    session.previewStillOk = true;
    placeAreaFrame(frame);
  };
  probe.src = url;
}

// A fresh still of the same screen, so the preview is not the picture the
// crop was drawn over. It keeps the timer alive while the live capturer is
// still refusing to start.
async function refreshPreviewStill() {
  if (session.previewLive || session.previewStarting || session.phase !== "idle") return;
  if (document.hidden || session.previewStillBusy) return;
  if (!api || typeof api.screenStill !== "function") return;
  session.previewStillBusy = true;
  let result = null;
  try {
    result = await api.screenStill({
      sourceId: previewScreenSourceId(),
      displayId: session.areaDisplayId || "",
    });
  } catch {
    result = null;
  }
  session.previewStillBusy = false;
  if (session.previewLive || session.phase !== "idle") return;
  if (result && result.ok && result.thumbnail) applyPreviewStill(result.thumbnail);
  if (session.previewFailed && !session.previewLive) scheduleStillRefresh();
}

// The live capturer refused: show the crop with stills and say so, with a
// way to try the live capture again without redrawing the crop.
function useStillPreview() {
  if (session.previewLive) return;
  session.previewFailed = true;
  const frame = document.querySelector(".area-frame");
  if (frame) frame.classList.remove("has-live");
  paintPreviewState();
  void refreshPreviewStill();
  scheduleStillRefresh();
}

function retryCropPreview() {
  stopStillRefresh();
  session.previewFailed = false;
  paintPreviewState();
  void startCropPreview();
}

function attachPreviewVideo(video, stream) {
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.disablePictureInPicture = true;
  if (video.srcObject !== stream) video.srcObject = stream;
  session.previewVideo = video;
  const frame = video.closest(".area-frame");
  watchPreviewFrame(frame);
  if (frame) placeAreaFrame(frame);
  const place = () => placeAreaFrame(frame);
  video.onloadedmetadata = place;
  video.onresize = place;
  if (typeof video.requestVideoFrameCallback === "function") {
    video.requestVideoFrameCallback(place);
  }
  return Promise.resolve(video.play()).then(place);
}

function stopCropPreview() {
  session.previewGeneration += 1;
  if (session.previewObserver) {
    session.previewObserver.disconnect();
    session.previewObserver = null;
  }
  session.previewFrame = null;
  stopStillRefresh();
  // Only the live layer goes: a still that is already placed stays on
  // screen, so the crop keeps showing while the bar is open or a new
  // capture is being negotiated.
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
  session.previewLive = false;
  session.previewFailed = false;
  session.previewStillOk = false;
  session.previewStillBusy = false;
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
      session.previewFailed = false;
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
          // The capture was taken away: keep the crop on screen as a still
          // rather than dropping the preview to nothing.
          if (session.previewStream === stream) {
            stopCropPreview();
            useStillPreview();
          }
        },
        { once: true },
      );
    }
    if (generation !== session.previewGeneration || session.previewStream !== stream) return;
    session.previewFailed = false;
    await attachPreviewVideo(live, stream);
  } catch (error) {
    // Denied or unable to start: the frame keeps showing the crop from
    // still screenshots, with a note and a Retry.
    logRecorderEvent(
      "crop preview failed",
      ((error && error.name) || "Error") + ": " + ((error && error.message) || ""),
    );
    if (stream && session.previewStream === stream) stopCropPreview();
    else if (stream) stopStream(stream);
    useStillPreview();
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
  shooting: false,
  micPicker: null,
  sourceKey: "",
  targetsAt: 0,
  page: "studio",
};

const PAGE_BLURB = {
  studio: "Set up the take, then start the recorder bar.",
  takes: "Recordings saved on this computer.",
  settings: "Defaults for new takes.",
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

// The crop preview: shown only while a crop is set. Both layers are clipped
// to the crop box, so the frame shows the take's own frame either way.
function areaMarkup() {
  const screens = session.targets.screens;
  const screen = screenForDisplay(session.areaDisplayId) || screens.find((item) => item.primary) || screens[0] || null;
  const screenPicker = screens.length > 1 ? '<div class="picker" data-area-screen-picker></div>' : "";
  const still =
    screen && screen.thumbnail
      ? '<img class="area-still" data-area-still alt="" src="' + esc(screen.thumbnail) + '" />'
      : "";
  const live = '<video class="area-live" data-area-live muted playsinline autoplay aria-hidden="true"></video>';
  const note =
    '<p class="area-note" data-area-note hidden>' +
    '<span data-area-note-text>Live preview unavailable</span>' +
    '<button type="button" class="secondary small" data-area-retry>Retry</button>' +
    "</p>";
  return (
    '<div class="area-view">' +
    '<div class="area-frame">' + still + live + note + "</div>" +
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
    const shot = tools.querySelector("[data-source-shot]");
    if (shot) {
      shot.disabled = Boolean(studio.shooting || session.areaPicking || isBusy());
      shot.textContent = studio.shooting ? "Saving…" : "Screenshot";
    }
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
  // The preview frame: the still is placed the moment it decodes, and the
  // live layer takes the frame over as soon as it presents a picture.
  const frame = body.querySelector(".area-frame");
  if (frame && session.areaCrop) {
    watchPreviewFrame(frame);
    watchStillImage(frame.querySelector("[data-area-still]"));
    placeAreaFrame(frame);
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
  if (qualityNote) qualityNote.textContent = "Records at " + quality + ".";
  const defaultNote = document.querySelector("[data-default-quality-summary]");
  if (defaultNote) defaultNote.textContent = "New takes record at " + quality + ".";
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
        : u.updateAvailable && u.latestTag
          ? u.latestTag + " is ready to download."
          : u.installMode === "development"
            ? "Dev build: GitHub Releases never rewrite this checkout."
            : "Updates come from GitHub Releases.");
  }
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
  if (api && typeof api.onScreenshotSaved === "function") api.onScreenshotSaved(onScreenshotSaved);
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
    if (el.closest("[data-source-shot]")) return void takeStudioScreenshot();
  });
  document.querySelector("[data-source-body]")?.addEventListener("click", (event) => {
    const el = event.target;
    if (el.closest(".picker")) return;
    if (el.closest("[data-area-retry]")) return retryCropPreview();
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
  // The studio's Quality box and Settings > Default quality are one setting.
  document.querySelectorAll("[data-quality-group]").forEach((group) => group.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-quality]");
    if (!btn || btn.disabled || isBusy()) return;
    session.quality = clampQuality(btn.getAttribute("data-quality"));
    rememberPrefs({ recordQuality: session.quality });
    render();
  }));
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

// Studio > Screenshot: a picture of what the Source box says a take records,
// the whole screen or the crop. Main keeps this window out of the picture.
async function takeStudioScreenshot() {
  if (studio.shooting || isBusy() || !api || typeof api.screenshotTake !== "function") return;
  studio.shooting = true;
  paintSource();
  const crop = session.target === "area" && session.areaCrop ? session.areaCrop : null;
  let result = null;
  try {
    result = await api.screenshotTake({ crop, displayId: crop ? String(session.areaDisplayId || "") : "" });
  } catch {
    result = { ok: false, error: "Could not save the screenshot." };
  }
  studio.shooting = false;
  paintSource();
  onScreenshotSaved(result);
}

function onScreenshotSaved(result) {
  if (result && Array.isArray(result.takes)) session.takes = result.takes;
  if (result && result.ok && result.take && result.take.id) {
    session.justSavedId = result.take.id;
    logRecorderEvent("screenshot saved", result.take.name || "");
    toast("Screenshot saved.");
  } else {
    toast((result && result.error) || "Could not save the screenshot.", true);
  }
  paintTakes();
}

function isScreenshotTake(take) {
  return String((take && take.mime) || "").startsWith("image/");
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
        (isScreenshotTake(take)
          ? '<img class="take-video take-image" alt=""' + (deleting ? "" : ' src="' + esc(takeVideoUrl(take)) + '"') + ' data-take-open="' + esc(take.id) + '" title="View" />'
          : '<video class="take-video"' + (deleting ? "" : ' src="' + esc(takeVideoUrl(take)) + '"') + ' preload="metadata" muted playsinline data-take-open="' + esc(take.id) + '" title="Play"></video>') +
        '<div class="take-body">' +
        '<span class="take-name">' + esc(take.name || "Take") + (isNew ? '<span class="take-new-badge">New</span>' : "") + "</span>" +
        '<span class="take-meta">' + esc(takeMeta(take)) + "</span>" +
        '<div class="take-actions">' +
        '<button type="button" data-take-show="' + esc(take.id) + '">Show in folder</button>' +
        '<button type="button" class="primary" data-take-open="' + esc(take.id) + '">' + (isScreenshotTake(take) ? "View" : "Play") + "</button>" +
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
    grid.innerHTML = '<p class="takes-empty">No takes yet. Record one or take a screenshot from Studio, and it shows up here.</p>';
    return;
  }
  grid.innerHTML = takeGroups(takes)
    .map((group) => {
      const shots = group.takes.filter(isScreenshotTake).length;
      const videos = group.takes.length - shots;
      const count = [
        videos ? videos + (videos === 1 ? " take" : " takes") : "",
        shots ? shots + (shots === 1 ? " screenshot" : " screenshots") : "",
      ]
        .filter(Boolean)
        .join(" · ");
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
    // Play, View, and the thumbnail all open the built-in player.
    const open = target.closest("[data-take-open]");
    if (open) {
      openPlayer(open.getAttribute("data-take-open"));
      return;
    }
    const del = target.closest("[data-take-delete]");
    if (del) {
      void deleteTake(del.getAttribute("data-take-delete"));
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

// ---------------------------------------------------------------------------
// Player
//
// Open on a take card opens it here, over the whole window, instead of
// handing the file to whatever Windows has for .mp4. The <video> element does
// the decoding; everything around it is ours: the seek bar, play/pause, skip,
// volume, speed, loop, full screen, keyboard shortcuts, prev/next through the
// list, Save frame, and the file actions from the card. Screenshots open in
// the same place as a picture. Volume, mute, speed, and loop are kept in
// SQLite through main, so they come back after a restart.
//
// MediaRecorder files often carry no duration (the browser reports Infinity
// until it has read to the end). The take row knows how long it recorded, so
// that stands in for the clock, and the player seeks to the end once, which
// makes Chromium work the real duration out so the seek bar can be trusted.
// ---------------------------------------------------------------------------

const PLAYER_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const PLAYER_IDLE_MS = 2600;
const PLAYER_SKIP_S = 10;
const PLAYER_ARROW_S = 5;
const PLAYER_FRAME_S = 1 / 30;
const PLAYER_DURATION_FIX_MS = 4000;

const PLAYER_ICONS = {
  play: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  replay:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/></svg>',
  volumeHigh:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  volumeLow:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  volumeOff:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  fullOn:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fullOff:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 4v5H4M15 9h5V4M20 15h-5v5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const player = {
  open: false,
  take: null,
  kind: "video",
  prefs: { volume: 1, muted: false, rate: 1, loop: false },
  prefsLoaded: false,
  wantPlay: false,
  fixingDuration: false,
  fixTimer: 0,
  idleTimer: 0,
  clickTimer: 0,
  scrubbing: false,
  scrubWasPlaying: false,
  saving: false,
  deleting: false,
  error: "",
  returnFocus: null,
  paintQueued: false,
  zoom: { mode: "fit", scale: 1, x: 0, y: 0 },
  pan: null,
  resumeAt: 0,
};

let playerDom = null;

function playerRefs() {
  if (playerDom) return playerDom;
  const root = document.querySelector("[data-player]");
  if (!root) return null;
  const q = (sel) => root.querySelector(sel);
  playerDom = {
    root,
    head: q(".player-head"),
    stage: q("[data-player-stage]"),
    video: q("[data-player-video]"),
    image: q("[data-player-image]"),
    picture: q("[data-player-picture]"),
    copy: q("[data-player-copy]"),
    zoomLevel: q("[data-player-zoom-fit]"),
    zoomActual: q("[data-player-zoom-actual]"),
    flash: q("[data-player-flash]"),
    error: q("[data-player-error]"),
    errorText: q("[data-player-error-text]"),
    name: q("[data-player-name]"),
    meta: q("[data-player-meta]"),
    frame: q("[data-player-frame]"),
    prev: q("[data-player-prev]"),
    next: q("[data-player-next]"),
    controls: q("[data-player-controls]"),
    seek: q("[data-player-seek]"),
    buffered: q("[data-player-buffered]"),
    played: q("[data-player-played]"),
    thumb: q("[data-player-thumb]"),
    tip: q("[data-player-tip]"),
    toggle: q("[data-player-toggle]"),
    mute: q("[data-player-mute]"),
    volume: q("[data-player-volume]"),
    current: q("[data-player-current]"),
    duration: q("[data-player-duration]"),
    rate: q("[data-player-rate]"),
    rateMenu: q("[data-player-rate-menu]"),
    loop: q("[data-player-loop]"),
    help: q("[data-player-help]"),
    helpSheet: q("[data-player-help-sheet]"),
    full: q("[data-player-full]"),
  };
  return playerDom;
}

// h:mm:ss past the hour, m:ss under it; a file without a duration reads 0:00.
function formatPlayerClock(seconds) {
  const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + s;
  return m + ":" + s;
}

function normalizePlayerPrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const volume = Number(src.volume);
  const rate = Number(src.rate);
  let bestRate = 1;
  if (Number.isFinite(rate)) {
    bestRate = PLAYER_RATES[0];
    for (const r of PLAYER_RATES) if (Math.abs(r - rate) < Math.abs(bestRate - rate)) bestRate = r;
  }
  return {
    volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, Math.round(volume * 100) / 100)) : 1,
    muted: src.muted === true || src.muted === "1",
    rate: bestRate,
    loop: src.loop === true || src.loop === "1",
  };
}

// The duration the clock and seek bar work from: the browser's once it is a
// real number, otherwise what the take row recorded.
function playerDuration() {
  const refs = playerRefs();
  const v = refs && refs.video;
  if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  const hint = Number(player.take && player.take.durationMs) / 1000;
  return Number.isFinite(hint) && hint > 0 ? hint : 0;
}

function playerNeighbors() {
  const list = (Array.isArray(session.takes) ? session.takes : []).filter((take) => take && take.id);
  const index = player.take ? list.findIndex((take) => take.id === player.take.id) : -1;
  return {
    index,
    count: list.length,
    prev: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index + 1 < list.length ? list[index + 1] : null,
  };
}

async function loadPlayerPrefs() {
  if (player.prefsLoaded || !api || typeof api.playerPrefsGet !== "function") return;
  player.prefsLoaded = true;
  try {
    player.prefs = normalizePlayerPrefs(await api.playerPrefsGet());
  } catch {
    player.prefs = normalizePlayerPrefs(null);
  }
  applyPlayerPrefs();
}

function applyPlayerPrefs() {
  const refs = playerRefs();
  if (!refs) return;
  const v = refs.video;
  v.volume = player.prefs.volume;
  v.muted = player.prefs.muted;
  v.loop = player.prefs.loop;
  v.defaultPlaybackRate = player.prefs.rate;
  v.playbackRate = player.prefs.rate;
  paintPlayerControls();
}

function savePlayerPrefs(patch) {
  player.prefs = normalizePlayerPrefs(Object.assign({}, player.prefs, patch));
  applyPlayerPrefs();
  if (api && typeof api.playerPrefsSet === "function") api.playerPrefsSet(patch).catch(() => {});
}

function openPlayer(id, opts) {
  const refs = playerRefs();
  if (!refs) return;
  const takes = Array.isArray(session.takes) ? session.takes : [];
  const take = takes.find((item) => item && item.id === id);
  if (!take) {
    toast("That take is not in the list any more.", true);
    return;
  }
  if (!player.open) {
    player.returnFocus = document.activeElement;
    player.open = true;
    refs.root.hidden = false;
    closePickers();
    stopMeter();
    void loadPlayerPrefs();
  }
  loadPlayerTake(take, opts);
}

function unloadPlayerVideo() {
  const refs = playerRefs();
  if (!refs) return;
  const v = refs.video;
  clearTimeout(player.fixTimer);
  player.fixingDuration = false;
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();
  } catch {
    /* nothing loaded */
  }
}

function loadPlayerTake(take, opts) {
  const refs = playerRefs();
  if (!refs) return;
  const options = opts || {};
  player.take = take;
  player.kind = isScreenshotTake(take) ? "image" : "video";
  player.error = "";
  player.wantPlay = player.kind === "video" && !options.paused;
  refs.root.classList.toggle("is-image", player.kind === "image");
  refs.root.classList.remove("has-error");
  refs.root.classList.toggle("is-waiting", player.kind === "video");
  refs.root.classList.toggle("is-paused", player.kind === "video");
  refs.error.hidden = true;
  refs.name.textContent = take.name || "Take";
  refs.meta.textContent = takeMeta(take);
  refs.frame.hidden = player.kind !== "video";
  refs.copy.hidden = player.kind !== "image";
  closePlayerMenus();
  player.pan = null;
  refs.root.classList.remove("is-panning");
  const url = takeVideoUrl(take);
  if (player.kind === "image") {
    unloadPlayerVideo();
    player.zoom = { mode: "fit", scale: 1, x: 0, y: 0 };
    refs.image.removeAttribute("style");
    refs.image.classList.remove("can-pan");
    refs.picture.hidden = false;
    refs.root.classList.add("is-waiting");
    refs.image.src = url;
  } else {
    refs.picture.hidden = true;
    refs.image.removeAttribute("src");
    unloadPlayerVideo();
    const v = refs.video;
    v.loop = player.prefs.loop;
    v.volume = player.prefs.volume;
    v.muted = player.prefs.muted;
    v.defaultPlaybackRate = player.prefs.rate;
    v.playbackRate = player.prefs.rate;
    player.resumeAt = Number(options.resumeAt) || 0;
    v.src = url;
    v.load();
    refs.flash.innerHTML = PLAYER_ICONS.play;
    refs.flash.classList.remove("show");
  }
  paintPlayerControls();
  wakePlayer();
  const focus = player.kind === "video" ? refs.toggle : refs.root;
  if (focus && typeof focus.focus === "function") focus.focus({ preventScroll: true });
}

function closePlayer() {
  const refs = playerRefs();
  if (!refs || !player.open) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  unloadPlayerVideo();
  refs.image.removeAttribute("src");
  refs.picture.hidden = true;
  closePlayerMenus();
  clearTimeout(player.idleTimer);
  clearTimeout(player.clickTimer);
  refs.root.classList.remove("is-idle", "is-full", "has-error", "is-waiting");
  refs.root.hidden = true;
  player.open = false;
  player.take = null;
  const back = player.returnFocus;
  player.returnFocus = null;
  if (back && typeof back.focus === "function" && document.contains(back)) back.focus({ preventScroll: true });
  else document.querySelector('[data-page="takes"]')?.focus({ preventScroll: true });
}

function closePlayerMenus() {
  const refs = playerRefs();
  if (!refs) return;
  refs.rateMenu.hidden = true;
  refs.rate.setAttribute("aria-expanded", "false");
  refs.helpSheet.hidden = true;
  refs.help.setAttribute("aria-expanded", "false");
}

// The control bar and title fade while a video plays and nothing moves.
function wakePlayer() {
  const refs = playerRefs();
  if (!refs) return;
  refs.root.classList.remove("is-idle");
  clearTimeout(player.idleTimer);
  const v = refs.video;
  const playing = player.kind === "video" && !v.paused && !v.ended && !player.scrubbing;
  if (!playing) return;
  player.idleTimer = setTimeout(() => {
    if (!player.open || v.paused || v.ended || player.scrubbing) return;
    if (!refs.rateMenu.hidden || !refs.helpSheet.hidden) return;
    if (refs.controls.contains(document.activeElement) && document.activeElement !== refs.toggle) return;
    refs.root.classList.add("is-idle");
  }, PLAYER_IDLE_MS);
}

function flashPlayer(icon) {
  const refs = playerRefs();
  if (!refs) return;
  refs.flash.innerHTML = PLAYER_ICONS[icon] || "";
  refs.flash.classList.remove("show");
  void refs.flash.offsetWidth;
  refs.flash.classList.add("show");
}

function playerPlay() {
  const refs = playerRefs();
  if (!refs || player.kind !== "video" || player.error) return;
  const v = refs.video;
  if (v.ended && !v.loop) v.currentTime = 0;
  player.wantPlay = true;
  void v.play().catch((error) => {
    // AbortError is a load that replaced this one; anything else is the file.
    if (error && error.name === "AbortError") return;
    showPlayerError("This file could not be played.");
  });
}

function playerPause() {
  const refs = playerRefs();
  if (!refs) return;
  player.wantPlay = false;
  refs.video.pause();
}

function togglePlayer() {
  const refs = playerRefs();
  if (!refs || player.kind !== "video") return;
  if (refs.video.paused || refs.video.ended) playerPlay();
  else playerPause();
}

function playerSeekTo(seconds) {
  const refs = playerRefs();
  if (!refs || player.kind !== "video" || player.fixingDuration) return;
  const length = playerDuration();
  let to = Number(seconds) || 0;
  if (length) to = Math.min(length, to);
  to = Math.max(0, to);
  try {
    refs.video.currentTime = to;
  } catch {
    /* not seekable yet */
  }
  paintPlayerTime();
}

function playerSkip(seconds) {
  const refs = playerRefs();
  if (!refs) return;
  playerSeekTo(refs.video.currentTime + seconds);
}

function playerStepFrame(direction) {
  const refs = playerRefs();
  if (!refs || player.kind !== "video") return;
  if (!refs.video.paused) playerPause();
  playerSeekTo(refs.video.currentTime + direction * PLAYER_FRAME_S);
}

function setPlayerVolume(volume, opts) {
  const next = Math.min(1, Math.max(0, Math.round(Number(volume) * 100) / 100));
  const patch = { volume: next };
  if (next > 0 && player.prefs.muted && !(opts && opts.keepMute)) patch.muted = false;
  savePlayerPrefs(patch);
}

function togglePlayerMute() {
  const muted = !player.prefs.muted;
  const patch = { muted };
  if (!muted && player.prefs.volume === 0) patch.volume = 0.5;
  savePlayerPrefs(patch);
}

function setPlayerRate(rate) {
  savePlayerPrefs({ rate });
  closePlayerMenus();
  toast("Speed " + formatPlayerRate(player.prefs.rate));
}

function stepPlayerRate(direction) {
  const index = PLAYER_RATES.indexOf(player.prefs.rate);
  const next = PLAYER_RATES[Math.min(PLAYER_RATES.length - 1, Math.max(0, index + direction))];
  if (next !== player.prefs.rate) setPlayerRate(next);
}

function formatPlayerRate(rate) {
  return (Number.isInteger(rate) ? String(rate) : String(rate).replace(/^0/, "")) + "x";
}

function togglePlayerLoop() {
  savePlayerPrefs({ loop: !player.prefs.loop });
  toast(player.prefs.loop ? "Loop on" : "Loop off");
}

function togglePlayerFullscreen() {
  const refs = playerRefs();
  if (!refs) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    refs.root.requestFullscreen().catch(() => toast("Full screen is not available.", true));
  }
}

function showPlayerError(message) {
  const refs = playerRefs();
  if (!refs) return;
  player.error = message || "This file could not be played.";
  player.wantPlay = false;
  refs.errorText.textContent = player.error;
  refs.error.hidden = false;
  refs.root.classList.add("has-error");
  refs.root.classList.remove("is-waiting");
  paintPlayerControls();
}

// A recording that reports Infinity gets one seek to the end; Chromium then
// knows the real length, and we come back to where the take should start.
function startPlayerDurationFix() {
  const refs = playerRefs();
  if (!refs) return;
  const v = refs.video;
  player.fixingDuration = true;
  clearTimeout(player.fixTimer);
  player.fixTimer = setTimeout(finishPlayerDurationFix, PLAYER_DURATION_FIX_MS);
  try {
    v.currentTime = 1e101;
  } catch {
    finishPlayerDurationFix();
  }
}

function finishPlayerDurationFix() {
  const refs = playerRefs();
  if (!refs || !player.fixingDuration) return;
  clearTimeout(player.fixTimer);
  player.fixingDuration = false;
  const v = refs.video;
  try {
    v.currentTime = Math.min(player.resumeAt || 0, playerDuration() || Infinity);
  } catch {
    /* fine where it is */
  }
  if (player.wantPlay) playerPlay();
  else refs.root.classList.remove("is-waiting");
  paintPlayerControls();
}

function queuePlayerTimePaint() {
  if (player.paintQueued) return;
  player.paintQueued = true;
  requestAnimationFrame(() => {
    player.paintQueued = false;
    paintPlayerTime();
  });
}

function paintPlayerTime() {
  const refs = playerRefs();
  if (!refs || !player.open) return;
  const v = refs.video;
  const length = playerDuration();
  const now = player.fixingDuration ? player.resumeAt || 0 : Math.min(v.currentTime || 0, length || Infinity);
  refs.current.textContent = formatPlayerClock(now);
  refs.duration.textContent = formatPlayerClock(length);
  const played = length ? Math.min(100, (now / length) * 100) : 0;
  refs.played.style.width = played + "%";
  refs.thumb.style.left = played + "%";
  let buffered = 0;
  try {
    const ranges = v.buffered;
    if (ranges && ranges.length && length) buffered = Math.min(100, (ranges.end(ranges.length - 1) / length) * 100);
  } catch {
    buffered = 0;
  }
  refs.buffered.style.width = buffered + "%";
  refs.seek.setAttribute("aria-valuemax", String(Math.round(length)));
  refs.seek.setAttribute("aria-valuenow", String(Math.round(now)));
  refs.seek.setAttribute("aria-valuetext", formatPlayerClock(now) + " of " + formatPlayerClock(length));
}

function paintPlayerControls() {
  const refs = playerRefs();
  if (!refs || !player.open) return;
  const v = refs.video;
  const playing = player.kind === "video" && !v.paused && !v.ended;
  refs.toggle.innerHTML = v.ended && !v.loop ? PLAYER_ICONS.replay : playing ? PLAYER_ICONS.pause : PLAYER_ICONS.play;
  refs.toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  refs.toggle.title = (playing ? "Pause" : "Play") + " (Space)";
  refs.root.classList.toggle("is-paused", player.kind === "video" && !playing);
  const muted = player.prefs.muted || player.prefs.volume === 0;
  refs.mute.innerHTML = muted ? PLAYER_ICONS.volumeOff : player.prefs.volume < 0.5 ? PLAYER_ICONS.volumeLow : PLAYER_ICONS.volumeHigh;
  refs.mute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  refs.mute.title = (muted ? "Unmute" : "Mute") + " (M)";
  refs.volume.value = String(muted ? 0 : player.prefs.volume);
  refs.rate.textContent = formatPlayerRate(player.prefs.rate);
  refs.loop.setAttribute("aria-pressed", String(player.prefs.loop));
  const full = document.fullscreenElement === refs.root;
  refs.full.innerHTML = full ? PLAYER_ICONS.fullOff : PLAYER_ICONS.fullOn;
  refs.full.setAttribute("aria-label", full ? "Exit full screen" : "Full screen");
  refs.full.title = (full ? "Exit full screen" : "Full screen") + " (F)";
  refs.root.classList.toggle("is-full", full);
  refs.frame.disabled = player.saving || Boolean(player.error) || !(v.videoWidth > 0);
  refs.frame.textContent = player.saving ? "Saving…" : "Save frame";
  const near = playerNeighbors();
  refs.prev.disabled = !near.prev;
  refs.next.disabled = !near.next;
  refs.rateMenu.querySelectorAll("[data-player-rate-pick]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(Number(btn.getAttribute("data-player-rate-pick")) === player.prefs.rate));
  });
  paintPlayerTime();
}

function playerGo(direction) {
  const near = playerNeighbors();
  const target = direction < 0 ? near.prev : near.next;
  if (!target) return;
  loadPlayerTake(target, {});
}

// Save frame: the paused picture goes through a canvas to a PNG, and main
// files it as the next "Screenshot N" in today's folder.
async function savePlayerFrame() {
  const refs = playerRefs();
  if (!refs || player.saving || player.kind !== "video" || !player.take) return;
  if (!api || typeof api.playerFrameSave !== "function") return;
  const v = refs.video;
  if (!(v.videoWidth > 0 && v.videoHeight > 0)) {
    toast("The frame is not ready yet.", true);
    return;
  }
  const take = player.take;
  player.saving = true;
  paintPlayerControls();
  let result = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("empty frame");
    const png = new Uint8Array(await blob.arrayBuffer());
    result = await api.playerFrameSave({ id: take.id, png, atMs: Math.round((v.currentTime || 0) * 1000) });
  } catch {
    result = { ok: false, error: "Could not save the frame." };
  }
  player.saving = false;
  if (result && Array.isArray(result.takes)) session.takes = result.takes;
  if (result && result.ok && result.take) {
    session.justSavedId = result.take.id;
    logRecorderEvent("frame saved", result.take.name || "");
    toast("Frame saved as " + (result.take.name || "a screenshot") + ".");
    paintTakes();
  } else {
    toast((result && result.error) || "Could not save the frame.", true);
  }
  paintPlayerControls();
}

// Delete from the player: let go of the file first (the open <video> holds
// it), ask through the same dialog as the card, then move to the neighbor
// or back to the grid. A cancel puts the take back where it was.
async function deletePlayerTake() {
  const refs = playerRefs();
  if (!refs || !player.take || player.deleting || session.deletingId) return;
  const take = player.take;
  const near = playerNeighbors();
  const resumeAt = player.kind === "video" ? refs.video.currentTime || 0 : 0;
  player.deleting = true;
  unloadPlayerVideo();
  await deleteTake(take.id);
  player.deleting = false;
  if (!player.open) return;
  const list = Array.isArray(session.takes) ? session.takes : [];
  if (list.some((item) => item && item.id === take.id)) {
    loadPlayerTake(take, { paused: true, resumeAt });
    return;
  }
  const next = [near.next, near.prev].find((item) => item && list.some((other) => other && other.id === item.id));
  if (next) loadPlayerTake(next, { paused: true });
  else closePlayer();
}

function playerSeekFraction(clientX) {
  const refs = playerRefs();
  const rect = refs.seek.getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function onPlayerKey(event) {
  if (!player.open) return;
  const refs = playerRefs();
  if (!refs) return;
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  const key = event.key;
  if (key === "Escape") {
    event.preventDefault();
    if (!refs.rateMenu.hidden || !refs.helpSheet.hidden) {
      closePlayerMenus();
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    closePlayer();
    return;
  }
  // A focused control keeps its own keys: Space and Enter press it, and the
  // volume slider's arrows move it.
  if ((key === " " || key === "Enter") && (tag === "button" || tag === "input")) return;
  if (tag === "input" && (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown")) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const isVideo = player.kind === "video";
  let handled = true;
  switch (key) {
    case " ":
    case "k":
    case "K":
      if (isVideo) togglePlayer();
      break;
    case "j":
    case "J":
      if (isVideo) playerSkip(-PLAYER_SKIP_S);
      break;
    case "l":
    case "L":
      if (isVideo) playerSkip(PLAYER_SKIP_S);
      break;
    case "ArrowLeft":
      if (isVideo) playerSkip(-PLAYER_ARROW_S);
      else playerGo(-1);
      break;
    case "ArrowRight":
      if (isVideo) playerSkip(PLAYER_ARROW_S);
      else playerGo(1);
      break;
    case ",":
      if (isVideo) playerStepFrame(-1);
      break;
    case ".":
      if (isVideo) playerStepFrame(1);
      break;
    case "Home":
      if (isVideo) playerSeekTo(0);
      break;
    case "End":
      if (isVideo) playerSeekTo(playerDuration());
      break;
    case "ArrowUp":
      if (isVideo) setPlayerVolume(player.prefs.volume + 0.05);
      break;
    case "ArrowDown":
      if (isVideo) setPlayerVolume(player.prefs.volume - 0.05, { keepMute: true });
      break;
    case "m":
    case "M":
      if (isVideo) togglePlayerMute();
      break;
    case "<":
      if (isVideo) stepPlayerRate(-1);
      break;
    case ">":
      if (isVideo) stepPlayerRate(1);
      break;
    case "r":
    case "R":
      if (isVideo) togglePlayerLoop();
      break;
    case "f":
    case "F":
      togglePlayerFullscreen();
      break;
    case "s":
    case "S":
      if (isVideo) void savePlayerFrame();
      break;
    case "p":
    case "P":
    case "PageUp":
      playerGo(-1);
      break;
    case "n":
    case "N":
    case "PageDown":
      playerGo(1);
      break;
    case "?":
      togglePlayerHelp();
      break;
    case "+":
    case "=":
      if (!isVideo) zoomPictureStep(1);
      else handled = false;
      break;
    case "-":
    case "_":
      if (!isVideo) zoomPictureStep(-1);
      else handled = false;
      break;
    case "c":
    case "C":
      if (!isVideo) void copyPlayerPicture();
      else handled = false;
      break;
    default:
      if (isVideo && /^[0-9]$/.test(key)) playerSeekTo(playerDuration() * (Number(key) / 10));
      else if (!isVideo && key === "0") fitPicture();
      else if (!isVideo && key === "1") setPictureZoom(1);
      else handled = false;
  }
  if (handled) {
    event.preventDefault();
    wakePlayer();
  }
}

function togglePlayerHelp() {
  const refs = playerRefs();
  if (!refs) return;
  const show = refs.helpSheet.hidden;
  closePlayerMenus();
  refs.helpSheet.hidden = !show;
  refs.help.setAttribute("aria-expanded", String(show));
}

// Pictures: Fit shows the whole screenshot (never blown up past 1:1), the
// wheel and the zoom bar scale it around the pointer, and a picture bigger
// than the stage drags. Copy puts the PNG on the clipboard through main.
const PICTURE_ZOOM_MIN = 0.1;
const PICTURE_ZOOM_MAX = 8;
const PICTURE_ZOOM_STEP = 1.25;
// Room under a fitted picture for the zoom bar, so Fit never hides the
// bottom edge behind it.
const PICTURE_ZOOM_BAR_H = 56;

function pictureFitScale() {
  const refs = playerRefs();
  if (!refs) return 1;
  const w = refs.image.naturalWidth;
  const h = refs.image.naturalHeight;
  const box = refs.picture.getBoundingClientRect();
  if (!(w > 0 && h > 0 && box.width > 0 && box.height > 0)) return 1;
  const pad = 24;
  return Math.min(1, (box.width - pad) / w, (box.height - pad - PICTURE_ZOOM_BAR_H) / h);
}

function pictureScale() {
  return player.zoom.mode === "fit" ? pictureFitScale() : player.zoom.scale;
}

// Keep a panned picture on the stage: it can be dragged only as far as its
// overflow, and a picture that fits sits in the middle.
function clampPicturePan() {
  const refs = playerRefs();
  if (!refs) return;
  const scale = pictureScale();
  const box = refs.picture.getBoundingClientRect();
  const maxX = Math.max(0, (refs.image.naturalWidth * scale - box.width) / 2);
  const maxY = Math.max(0, (refs.image.naturalHeight * scale - box.height) / 2);
  player.zoom.x = Math.min(maxX, Math.max(-maxX, player.zoom.x));
  if (player.zoom.mode !== "fit") player.zoom.y = Math.min(maxY, Math.max(-maxY, player.zoom.y));
  refs.image.classList.toggle("can-pan", maxX > 0 || maxY > 0);
}

function applyPictureZoom() {
  const refs = playerRefs();
  if (!refs || player.kind !== "image") return;
  const scale = pictureScale();
  const w = refs.image.naturalWidth;
  const h = refs.image.naturalHeight;
  if (!(w > 0 && h > 0)) return;
  if (player.zoom.mode === "fit") {
    player.zoom.x = 0;
    player.zoom.y = -PICTURE_ZOOM_BAR_H / 2;
  }
  clampPicturePan();
  refs.image.style.width = w * scale + "px";
  refs.image.style.height = h * scale + "px";
  refs.image.style.transform = "translate(calc(-50% + " + player.zoom.x + "px), calc(-50% + " + player.zoom.y + "px))";
  refs.zoomLevel.textContent = player.zoom.mode === "fit" ? "Fit" : Math.round(scale * 100) + "%";
  refs.zoomLevel.title = player.zoom.mode === "fit" ? "Fit to window (0)" : Math.round(scale * 100) + "% · click for Fit (0)";
  refs.zoomActual.setAttribute("aria-pressed", String(player.zoom.mode !== "fit" && Math.abs(scale - 1) < 0.001));
}

// Zoom to `scale`, keeping the picture point under `anchor` (client coords)
// where it is; without an anchor the middle stays put.
function setPictureZoom(scale, anchor) {
  const refs = playerRefs();
  if (!refs || player.kind !== "image") return;
  const from = pictureScale();
  const to = Math.min(PICTURE_ZOOM_MAX, Math.max(PICTURE_ZOOM_MIN, Number(scale) || 1));
  const box = refs.picture.getBoundingClientRect();
  if (anchor && box.width) {
    // The pointer's offset from the stage middle, in stage pixels.
    const px = anchor.x - (box.left + box.width / 2);
    const py = anchor.y - (box.top + box.height / 2);
    const ratio = to / from;
    player.zoom.x = px - (px - player.zoom.x) * ratio;
    player.zoom.y = py - (py - player.zoom.y) * ratio;
  }
  player.zoom.mode = "manual";
  player.zoom.scale = to;
  applyPictureZoom();
}

function fitPicture() {
  player.zoom = { mode: "fit", scale: 1, x: 0, y: 0 };
  applyPictureZoom();
}

function zoomPictureStep(direction, anchor) {
  const from = pictureScale();
  setPictureZoom(direction > 0 ? from * PICTURE_ZOOM_STEP : from / PICTURE_ZOOM_STEP, anchor);
}

// Double click: a fitted picture goes to 1:1 under the pointer, anything
// else goes back to Fit.
function togglePictureZoom(anchor) {
  if (player.zoom.mode === "fit" && pictureFitScale() < 0.999) setPictureZoom(1, anchor);
  else fitPicture();
}

async function copyPlayerPicture() {
  if (!player.take || player.kind !== "image" || !api || typeof api.takeCopyImage !== "function") return;
  let result = null;
  try {
    result = await api.takeCopyImage(player.take.id);
  } catch {
    result = { ok: false, error: "Could not copy the picture." };
  }
  if (result && result.ok) toast("Picture copied.");
  else toast((result && result.error) || "Could not copy the picture.", true);
}

function wirePicture() {
  const refs = playerRefs();
  if (!refs) return;
  refs.image.addEventListener("load", () => {
    refs.root.classList.remove("is-waiting");
    if (player.take) {
      const px = refs.image.naturalWidth + " × " + refs.image.naturalHeight + " px";
      refs.meta.textContent = [px, takeMeta(player.take)].filter(Boolean).join(" · ");
    }
    fitPicture();
  });
  refs.picture.addEventListener(
    "wheel",
    (event) => {
      if (player.kind !== "image") return;
      event.preventDefault();
      zoomPictureStep(event.deltaY < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
      wakePlayer();
    },
    { passive: false },
  );
  refs.picture.addEventListener("pointerdown", (event) => {
    if (player.kind !== "image" || event.button !== 0) return;
    if (!refs.image.classList.contains("can-pan")) return;
    event.preventDefault();
    player.pan = { id: event.pointerId, x: event.clientX, y: event.clientY, fromX: player.zoom.x, fromY: player.zoom.y, moved: false };
    refs.root.classList.add("is-panning");
    try {
      refs.picture.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety */
    }
  });
  refs.picture.addEventListener("pointermove", (event) => {
    const pan = player.pan;
    if (!pan || pan.id !== event.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
    player.zoom.x = pan.fromX + dx;
    player.zoom.y = pan.fromY + dy;
    applyPictureZoom();
  });
  const endPan = (event) => {
    const pan = player.pan;
    if (!pan || pan.id !== event.pointerId) return;
    player.pan = null;
    refs.root.classList.remove("is-panning");
    try {
      refs.picture.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };
  refs.picture.addEventListener("pointerup", endPan);
  refs.picture.addEventListener("pointercancel", endPan);
  refs.picture.addEventListener("dblclick", (event) => {
    if (player.kind !== "image") return;
    togglePictureZoom({ x: event.clientX, y: event.clientY });
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (player.open && player.kind === "image") applyPictureZoom();
    }).observe(refs.picture);
  }
}

function wirePlayer() {
  const refs = playerRefs();
  if (!refs) return;
  const v = refs.video;
  wirePicture();

  refs.rateMenu.innerHTML = PLAYER_RATES.map(
    (rate) =>
      '<button type="button" role="menuitemradio" data-player-rate-pick="' + rate + '" aria-checked="' + (rate === 1) + '">' +
      formatPlayerRate(rate) +
      "</button>",
  ).join("");
  refs.toggle.innerHTML = PLAYER_ICONS.play;
  refs.mute.innerHTML = PLAYER_ICONS.volumeHigh;
  refs.full.innerHTML = PLAYER_ICONS.fullOn;

  // Media events drive the controls; the controls never guess the state.
  v.addEventListener("loadedmetadata", () => {
    if (!Number.isFinite(v.duration) || v.duration <= 0) {
      startPlayerDurationFix();
    } else {
      if (player.resumeAt) {
        try {
          v.currentTime = Math.min(player.resumeAt, v.duration);
        } catch {
          /* keep the start */
        }
      }
      if (player.wantPlay) playerPlay();
      else refs.root.classList.remove("is-waiting");
    }
    paintPlayerControls();
  });
  v.addEventListener("durationchange", () => {
    if (player.fixingDuration && Number.isFinite(v.duration) && v.duration > 0) finishPlayerDurationFix();
    paintPlayerTime();
  });
  v.addEventListener("loadeddata", paintPlayerControls);
  v.addEventListener("canplay", () => {
    if (!player.fixingDuration) refs.root.classList.remove("is-waiting");
  });
  v.addEventListener("waiting", () => {
    if (!v.paused) refs.root.classList.add("is-waiting");
  });
  v.addEventListener("playing", () => {
    refs.root.classList.remove("is-waiting");
    paintPlayerControls();
    wakePlayer();
  });
  v.addEventListener("play", () => {
    if (player.fixingDuration) return;
    flashPlayer("play");
    paintPlayerControls();
    wakePlayer();
  });
  v.addEventListener("pause", () => {
    if (player.fixingDuration) return;
    refs.flash.classList.remove("show");
    refs.flash.innerHTML = v.ended && !v.loop ? PLAYER_ICONS.replay : PLAYER_ICONS.play;
    paintPlayerControls();
    wakePlayer();
  });
  v.addEventListener("ended", () => {
    if (player.fixingDuration) return;
    player.wantPlay = false;
    refs.flash.classList.remove("show");
    refs.flash.innerHTML = PLAYER_ICONS.replay;
    paintPlayerControls();
    wakePlayer();
  });
  v.addEventListener("timeupdate", queuePlayerTimePaint);
  v.addEventListener("progress", queuePlayerTimePaint);
  v.addEventListener("seeked", queuePlayerTimePaint);
  v.addEventListener("volumechange", paintPlayerControls);
  v.addEventListener("ratechange", paintPlayerControls);
  v.addEventListener("error", () => {
    if (!v.getAttribute("src")) return;
    const code = v.error && v.error.code;
    showPlayerError(
      code === 4
        ? "This file is not a video Simple Recorder can play."
        : code === 3
          ? "This video is damaged or still being written."
          : "This file could not be played.",
    );
    logRecorderEvent("player error", (player.take && player.take.name) + " code=" + code);
  });
  refs.image.addEventListener("error", () => {
    if (refs.image.getAttribute("src")) showPlayerError("This picture could not be opened.");
  });

  // Stage: click plays or pauses, a double click goes full screen.
  refs.video.addEventListener("click", () => {
    clearTimeout(player.clickTimer);
    player.clickTimer = setTimeout(togglePlayer, 220);
  });
  refs.video.addEventListener("dblclick", () => {
    clearTimeout(player.clickTimer);
    togglePlayerFullscreen();
  });

  refs.root.addEventListener("pointermove", wakePlayer);
  refs.root.addEventListener("pointerdown", wakePlayer);
  refs.root.addEventListener("click", (event) => {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (!target) return;
    if (!target.closest("[data-player-rate]") && !target.closest("[data-player-rate-menu]")) {
      refs.rateMenu.hidden = true;
      refs.rate.setAttribute("aria-expanded", "false");
    }
    if (!target.closest("[data-player-help]") && !target.closest("[data-player-help-sheet]")) {
      refs.helpSheet.hidden = true;
      refs.help.setAttribute("aria-expanded", "false");
    }
    if (target.closest("[data-player-close]")) closePlayer();
    else if (target.closest("[data-player-toggle]")) togglePlayer();
    else if (target.closest("[data-player-skip]")) playerSkip(Number(target.closest("[data-player-skip]").getAttribute("data-player-skip")) || 0);
    else if (target.closest("[data-player-mute]")) togglePlayerMute();
    else if (target.closest("[data-player-loop]")) togglePlayerLoop();
    else if (target.closest("[data-player-full]")) togglePlayerFullscreen();
    else if (target.closest("[data-player-prev]")) playerGo(-1);
    else if (target.closest("[data-player-next]")) playerGo(1);
    else if (target.closest("[data-player-frame]")) void savePlayerFrame();
    else if (target.closest("[data-player-delete]")) void deletePlayerTake();
    else if (target.closest("[data-player-help]")) togglePlayerHelp();
    else if (target.closest("[data-player-copy]")) void copyPlayerPicture();
    else if (target.closest("[data-player-zoom-in]")) zoomPictureStep(1);
    else if (target.closest("[data-player-zoom-out]")) zoomPictureStep(-1);
    else if (target.closest("[data-player-zoom-fit]")) fitPicture();
    else if (target.closest("[data-player-zoom-actual]")) setPictureZoom(1);
    else if (target.closest("[data-player-rate-pick]")) setPlayerRate(Number(target.closest("[data-player-rate-pick]").getAttribute("data-player-rate-pick")));
    else if (target.closest("[data-player-rate]")) {
      const show = refs.rateMenu.hidden;
      closePlayerMenus();
      refs.rateMenu.hidden = !show;
      refs.rate.setAttribute("aria-expanded", String(show));
    } else if (target.closest("[data-player-retry]")) {
      if (player.take) loadPlayerTake(player.take, { paused: false });
    } else if (target.closest("[data-player-show]")) {
      if (player.take && api && typeof api.takeShow === "function") api.takeShow(player.take.id).catch(() => {});
    } else if (target.closest("[data-player-external]")) {
      if (player.take && api && typeof api.takeOpen === "function") {
        playerPause();
        api.takeOpen(player.take.id).catch(() => {});
      }
    }
  });

  // Seek bar: drag scrubs, hover shows the time under the pointer.
  refs.seek.addEventListener("pointerdown", (event) => {
    if (player.kind !== "video" || !playerDuration() || player.fixingDuration) return;
    event.preventDefault();
    player.scrubbing = true;
    player.scrubWasPlaying = !v.paused && !v.ended;
    refs.seek.classList.add("is-scrubbing");
    try {
      refs.seek.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety */
    }
    if (player.scrubWasPlaying) v.pause();
    const fraction = playerSeekFraction(event.clientX);
    playerSeekTo(playerDuration() * fraction);
    refs.tip.hidden = false;
    refs.tip.style.left = fraction * 100 + "%";
    refs.tip.textContent = formatPlayerClock(playerDuration() * fraction);
  });
  refs.seek.addEventListener("pointermove", (event) => {
    if (player.kind !== "video" || !playerDuration()) return;
    const fraction = playerSeekFraction(event.clientX);
    refs.tip.hidden = false;
    refs.tip.style.left = fraction * 100 + "%";
    refs.tip.textContent = formatPlayerClock(playerDuration() * fraction);
    if (player.scrubbing) playerSeekTo(playerDuration() * fraction);
  });
  const endScrub = (event) => {
    refs.tip.hidden = true;
    if (!player.scrubbing) return;
    player.scrubbing = false;
    refs.seek.classList.remove("is-scrubbing");
    try {
      refs.seek.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (player.scrubWasPlaying) playerPlay();
    wakePlayer();
  };
  refs.seek.addEventListener("pointerup", endScrub);
  refs.seek.addEventListener("pointercancel", endScrub);
  refs.seek.addEventListener("pointerleave", () => {
    if (!player.scrubbing) refs.tip.hidden = true;
  });

  refs.volume.addEventListener("input", () => setPlayerVolume(refs.volume.value));

  document.addEventListener("fullscreenchange", () => {
    paintPlayerControls();
    wakePlayer();
  });
  document.addEventListener("keydown", onPlayerKey);
}

// ---------------------------------------------------------------------------
// Theme (Settings > Theme)
//
// theme-boot.js already set <html data-theme> from main's ?theme= before the
// first paint. This keeps it current: a pick here, or Windows switching
// between light and dark while Match Windows is on.
// ---------------------------------------------------------------------------

const THEME_LABELS = {
  system: "Match Windows",
  light: "Light",
  dark: "Dark",
  midnight: "Midnight",
  ocean: "Ocean",
  forest: "Forest",
  violet: "Violet",
  sunset: "Sunset",
};
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(choice) {
  const theme = THEME_LABELS[choice] ? choice : "light";
  const root = document.documentElement;
  root.dataset.themeChoice = theme;
  root.dataset.theme = theme === "system" ? (systemDark.matches ? "dark" : "light") : theme;
  document.querySelectorAll("[data-theme-option]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.getAttribute("data-theme-option") === theme));
  });
  const note = document.querySelector("[data-theme-summary]");
  if (note) {
    note.textContent =
      theme === "system"
        ? "Follows Windows: " + (systemDark.matches ? "dark" : "light") + " right now."
        : THEME_LABELS[theme] + ".";
  }
}

function wireTheme() {
  applyTheme(document.documentElement.dataset.themeChoice);
  document.querySelector("[data-theme-group]")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-theme-option]");
    if (!btn) return;
    const previous = document.documentElement.dataset.themeChoice;
    const choice = btn.getAttribute("data-theme-option");
    applyTheme(choice);
    const res = await api.themeSet(choice).catch(() => null);
    if (!res || !res.ok) {
      applyTheme(previous);
      toast("Could not save the theme.", true);
    }
  });
  systemDark.addEventListener("change", () => applyTheme(document.documentElement.dataset.themeChoice));
}

async function boot() {
  if (!api) {
    const actions = document.querySelector("[data-dock-actions]");
    if (actions) actions.innerHTML = '<p class="dock-status is-error">The recorder bridge did not load. Restart the app.</p>';
    return;
  }
  wireStudio();
  wireTheme();
  render();
  wireTakes();
  wirePlayer();
  document.querySelector("[data-open-folder]")?.addEventListener("click", () => {
    void api.recordingsOpen().catch(() => {});
  });
  for (const btn of document.querySelectorAll("[data-report]")) {
    btn.addEventListener("click", async () => {
      const res = await api.reportIssue(btn.dataset.report).catch(() => null);
      if (res && res.ok) toast("Opened GitHub in your browser.");
      else toast("Could not open the browser. Go to github.com/Josephivgi/simple-recorder/issues.", true);
    });
  }
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

// ---------------------------------------------------------------------------
// Smoke probe: the crop preview, driven for real.
//
// main.cjs boots the app hidden and asks for this hook (the page is loaded
// with ?smoke=1), then prints what it returns with the rest of the smoke JSON.
// It sets a crop, takes the failed-live path, pulls one still through the
// app's own IPC, and reports what the frame ended up showing. A crop-true
// frame renders the crop region as large as the frame allows without cutting
// it, and touches at least one pair of frame edges: pillarboxing or
// letterboxing is honest (the frame is a different shape than the crop), but
// the whole desktop squeezed into the frame is not, and that is the bug this
// probe exists to catch.
// ---------------------------------------------------------------------------

async function smokePreviewProbe() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // The probe runs after boot, but never race it: the crop needs a display.
  for (let i = 0; i < 30 && !session.setupLoaded; i += 1) await wait(100);
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const screens = (session.targets && session.targets.screens) || [];
  const screen = screens[0] || null;
  session.target = "area";
  session.areaCrop = crop;
  session.crop = crop;
  session.areaDisplayId = (screen && screen.displayId) || session.displayId || "";
  paintSource();
  await wait(60);
  // The capturer refusing to start is the whole reason the fallback exists.
  useStillPreview();
  let stillError = "";
  try {
    const shot = await api.screenStill({
      sourceId: previewScreenSourceId(),
      displayId: session.areaDisplayId,
    });
    if (shot && shot.ok && shot.thumbnail) applyPreviewStill(shot.thumbnail);
    else stillError = (shot && shot.error) || "no thumbnail";
  } catch (error) {
    stillError = String((error && error.message) || error);
  }
  await wait(1500);
  const frame = document.querySelector(".area-frame");
  if (!frame) return { error: "no preview frame" };
  const rect = frame.getBoundingClientRect();
  const still = frame.querySelector("[data-area-still]");
  const note = document.querySelector("[data-area-note]");
  const box = still ? still.getBoundingClientRect() : null;
  const out = {
    frame: Math.round(rect.width) + "x" + Math.round(rect.height),
    live: frame.classList.contains("has-live"),
    stillShown: frame.classList.contains("has-still"),
    stillNatural: still ? still.naturalWidth + "x" + still.naturalHeight : "",
    stillError,
    note: note && !note.hidden ? note.textContent.trim() : "",
    retry: Boolean(document.querySelector("[data-area-retry]")),
    cropTrue: null,
  };
  if (box && box.width > 1 && box.height > 1) {
    // The crop region as rendered, which is what the take would record. It
    // should be as large as the frame allows and never cut: the bigger of its
    // two fill ratios has to reach the edge, within a pixel of layout slack.
    const cropW = box.width * crop.w;
    const cropH = box.height * crop.h;
    const fill = Math.max(cropW / rect.width, cropH / rect.height);
    out.cropTrue = fill > 0.98 && cropW <= rect.width + 1 && cropH <= rect.height + 1;
    out.box = Math.round(box.width) + "x" + Math.round(box.height);
    out.cropShown =
      Math.round(cropW) + "x" + Math.round(cropH) +
      " at " + Math.round(box.left + (box.width - cropW) / 2 - rect.left) +
      "," + Math.round(box.top + (box.height - cropH) / 2 - rect.top) +
      " fill " + Math.round(fill * 100) + "%";
  }
  return out;
}

// The player probe (smoke only): open the newest video (or the newest take)
// in the real player, wait for the file to decode, seek once, and report
// what the controls show. The player is left open so main can capture it.
async function smokePlayerProbe() {
  const refs = playerRefs();
  const takes = Array.isArray(session.takes) ? session.takes : [];
  const target = takes.find((take) => !isScreenshotTake(take)) || takes[0] || null;
  const out = {
    markup: Boolean(refs),
    takes: takes.length,
    buttons: refs ? refs.root.querySelectorAll(".player-btn").length : 0,
    rates: refs ? refs.rateMenu.querySelectorAll("[data-player-rate-pick]").length : 0,
    shortcuts: refs ? refs.helpSheet.querySelectorAll("dt").length : 0,
    opened: false,
  };
  if (!refs || !target) return out;
  const shot = takes.find((take) => isScreenshotTake(take));
  if (shot) {
    openPlayer(shot.id, { paused: true });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (refs.image.complete && refs.image.naturalWidth) done();
      else {
        refs.image.addEventListener("load", done, { once: true });
        refs.image.addEventListener("error", done, { once: true });
      }
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fit = refs.image.getBoundingClientRect();
    const stage = refs.picture.getBoundingClientRect();
    out.picture = {
      opened: player.kind === "image" && !refs.picture.hidden,
      name: refs.name.textContent,
      natural: refs.image.naturalWidth + "x" + refs.image.naturalHeight,
      shown: Math.round(fit.width) + "x" + Math.round(fit.height),
      fitsStage: fit.width <= stage.width + 1 && fit.height <= stage.height + 1,
      zoom: refs.zoomLevel.textContent,
      meta: refs.meta.textContent,
      copy: !refs.copy.hidden,
      controlsHidden: getComputedStyle(refs.controls).display === "none",
      error: player.error,
    };
    zoomPictureStep(1);
    out.picture.zoomIn = refs.zoomLevel.textContent;
    setPictureZoom(1);
    out.picture.actual = refs.zoomLevel.textContent + " " + Math.round(refs.image.getBoundingClientRect().width) + "px wide";
    fitPicture();
    if (new URLSearchParams(location.search).get("smokePlayer") === "picture") return out;
  }
  openPlayer(target.id, { paused: true });
  out.opened = player.open && !refs.root.hidden;
  out.kind = player.kind;
  out.name = refs.name.textContent;
  if (player.kind !== "video") return out;
  const v = refs.video;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8000);
    const check = () => {
      if (player.fixingDuration) return;
      if (v.readyState < 1 && !player.error) return;
      clearTimeout(timer);
      resolve();
    };
    for (const name of ["loadedmetadata", "loadeddata", "durationchange", "seeked", "error"]) v.addEventListener(name, check);
    check();
  });
  out.readyState = v.readyState;
  out.error = player.error;
  out.duration = Math.round(playerDuration() * 1000) / 1000;
  out.finiteDuration = Number.isFinite(v.duration);
  out.size = v.videoWidth + "x" + v.videoHeight;
  const half = playerDuration() / 2;
  if (half > 0 && !player.error) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      v.addEventListener(
        "seeked",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      playerSeekTo(half);
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  out.currentTime = Math.round(v.currentTime * 1000) / 1000;
  out.clock = refs.current.textContent + " / " + refs.duration.textContent;
  out.played = refs.played.style.width;
  out.saveFrame = !refs.frame.disabled;
  // Real playback: decode for a moment, then pause where it landed.
  if (!player.error) {
    const before = v.currentTime;
    playerPlay();
    await new Promise((resolve) => setTimeout(resolve, 900));
    out.playing = !v.paused && !v.ended;
    out.advanced = Math.round((v.currentTime - before) * 1000) / 1000;
    out.playIcon = refs.toggle.getAttribute("aria-label");
    playerPause();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  out.paused = v.paused;
  // Save frame: the paused picture goes through the real IPC into the
  // library, and the list grows by one screenshot.
  if (!player.error && !refs.frame.disabled) {
    const count = (session.takes || []).length;
    await savePlayerFrame();
    const fresh = (session.takes || []).find((take) => take.id === session.justSavedId);
    out.frame = { listed: (session.takes || []).length === count + 1, name: fresh ? fresh.name : "", mime: fresh ? fresh.mime : "" };
    paintPlayerControls();
  }
  return out;
}

if (new URLSearchParams(location.search).has("smoke")) {
  window.__recPreviewProbe = smokePreviewProbe;
  window.__recPlayerProbe = smokePlayerProbe;
}

void boot();
