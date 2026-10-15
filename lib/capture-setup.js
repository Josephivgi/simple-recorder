"use strict";

// Persisted recorder setup and OS media status.
// Live Chromium / Windows prompt wiring is electron/media-capture.cjs.
// This file stays read-only toward the OS. Setup persists in SQLite
// (lib/db.js), passed in as the `store` argument (readSetup/writeSetup).

const RECORD_FPS_STEPS = [24, 30, 60];

// The bar offers 24, 30, and 60. A stored value lands on the nearest step so
// a hand-edited row cannot produce an unsupported rate.
function normalizeRecordFps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 30;
  return RECORD_FPS_STEPS.reduce((best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best), 30);
}

// The bar's last area, as fractions of the screen. Anything odd falls back
// to no area so a bad row never breaks the bar.
function normalizeRecordArea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => Number(v);
  const x = n(raw.x);
  const y = n(raw.y);
  const w = n(raw.w);
  const h = n(raw.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0.01 || h <= 0.01 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

// Start delay: whole seconds, 0 to 10, same steps as the bar.
const MAX_RECORD_DELAY_MS = 10 * 1000;

function normalizeRecordDelayMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_RECORD_DELAY_MS, Math.round(n / 1000) * 1000);
}

// Take container. MP4 is the only one offered; WebM is a disabled
// placeholder in the panel, and the renderer keeps it as an encoder
// fallback only when H.264 is unavailable.
const RECORD_FORMATS = ["mp4"];

function normalizeRecordFormat(raw) {
  return RECORD_FORMATS.includes(raw) ? raw : "mp4";
}

// Output height for a take. Before 1.1.7 this was a bitrate tier, so the old
// values are mapped onto the height they stood for instead of defaulting.
const RECORD_QUALITIES = ["720p", "1080p", "1440p"];
const LEGACY_RECORD_QUALITIES = { standard: "720p", high: "1080p", max: "1440p" };

function normalizeRecordQuality(raw) {
  const key = String(raw == null ? "" : raw).trim().toLowerCase();
  if (RECORD_QUALITIES.includes(key)) return key;
  return LEGACY_RECORD_QUALITIES[key] || "1080p";
}

// Auto stop: off or one of the offered minute marks.
const AUTO_STOP_STEPS_MS = [0, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

function normalizeRecordAutoStopMs(raw) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && AUTO_STOP_STEPS_MS.includes(n) ? n : 0;
}

// Electron display ids are integers. Empty means "the screen under the
// pointer", which is also the fallback when a saved screen is unplugged.
function normalizeDisplayId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  return /^\d{1,20}$/.test(s) ? s : "";
}

function emptySetup() {
  return {
    screen: false,
    camera: false,
    mic: false,
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
  };
}

function normalizeSetup(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    screen: Boolean(src.screen),
    camera: Boolean(src.camera),
    mic: Boolean(src.mic),
    ...recordCenterPrefs(src),
  };
}

function recordCenterPrefs(persisted) {
  const src = persisted && typeof persisted === "object" ? persisted : {};
  const recordArea = normalizeRecordArea(src.recordArea);
  return {
    soundOn: src.soundOn !== false,
    micDeviceId: typeof src.micDeviceId === "string" ? src.micDeviceId : "",
    recordTarget: src.recordTarget === "area" && recordArea ? "area" : "full",
    recordArea,
    recordFps: normalizeRecordFps(src.recordFps),
    recordDelayMs: normalizeRecordDelayMs(src.recordDelayMs),
    recordFormat: normalizeRecordFormat(src.recordFormat),
    recordQuality: normalizeRecordQuality(src.recordQuality),
    recordAutoStopMs: normalizeRecordAutoStopMs(src.recordAutoStopMs),
    recordDisplayId: normalizeDisplayId(src.recordDisplayId),
    recordAreaDisplayId: normalizeDisplayId(src.recordAreaDisplayId),
  };
}

function readCaptureSetup(store) {
  return normalizeSetup(store.readSetup());
}

function markCaptureApproved(store, kind) {
  const cur = readCaptureSetup(store);
  if (kind === "screen" || kind === "camera" || kind === "mic") cur[kind] = true;
  return store.writeSetup(cur);
}

function saveRecorderPrefs(store, prefs) {
  const cur = readCaptureSetup(store);
  if (prefs && typeof prefs.soundOn === "boolean") cur.soundOn = prefs.soundOn;
  if (prefs && typeof prefs.micDeviceId === "string") cur.micDeviceId = prefs.micDeviceId;
  if (prefs && (prefs.recordTarget === "full" || prefs.recordTarget === "area")) cur.recordTarget = prefs.recordTarget;
  if (prefs && "recordArea" in prefs) cur.recordArea = normalizeRecordArea(prefs.recordArea);
  if (prefs && "recordFps" in prefs) cur.recordFps = normalizeRecordFps(prefs.recordFps);
  if (prefs && "recordDelayMs" in prefs) cur.recordDelayMs = normalizeRecordDelayMs(prefs.recordDelayMs);
  if (prefs && "recordFormat" in prefs) cur.recordFormat = normalizeRecordFormat(prefs.recordFormat);
  if (prefs && "recordQuality" in prefs) cur.recordQuality = normalizeRecordQuality(prefs.recordQuality);
  if (prefs && "recordAutoStopMs" in prefs) cur.recordAutoStopMs = normalizeRecordAutoStopMs(prefs.recordAutoStopMs);
  if (prefs && "recordDisplayId" in prefs) cur.recordDisplayId = normalizeDisplayId(prefs.recordDisplayId);
  if (prefs && "recordAreaDisplayId" in prefs) cur.recordAreaDisplayId = normalizeDisplayId(prefs.recordAreaDisplayId);
  return store.writeSetup(cur);
}

function osMediaStatus(kind, prefs) {
  if (!prefs || typeof prefs.getMediaAccessStatus !== "function") return "";
  const map = { screen: "screen", camera: "camera", mic: "microphone" };
  const media = map[kind];
  if (!media) return "";
  try {
    return String(prefs.getMediaAccessStatus(media) || "");
  } catch {
    return "";
  }
}

// Test hook. A JSON file like {"platform":"win32","microphone":"denied"}
// stands in for the OS answer so the blocked flow can be driven on a guest
// that has no Windows privacy store. Unset in normal runs.
function fakeMediaPrefs(override, real) {
  const src = override && typeof override === "object" ? override : {};
  return {
    getMediaAccessStatus(media) {
      if (typeof src[media] === "string") return src[media];
      if (real && typeof real.getMediaAccessStatus === "function") return real.getMediaAccessStatus(media);
      return "";
    },
    askForMediaAccess: real && typeof real.askForMediaAccess === "function" ? real.askForMediaAccess.bind(real) : undefined,
  };
}

function osMediaOk(kind, prefs) {
  const status = osMediaStatus(kind, prefs);
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  return null;
}

// The OS owns microphone and camera consent for desktop apps. The app cannot
// grant it, so the fix path is a deep link to the OS privacy page and a wait
// for the status to flip.
function osSettingsUrl(kind, platform, opts) {
  const os = platform || process.platform;
  if (kind === "screen") return "";
  if (kind !== "mic" && kind !== "camera") return "";
  if (os === "win32") return kind === "mic" ? "ms-settings:privacy-microphone" : "ms-settings:privacy-webcam";
  if (os === "darwin") {
    return (
      "x-apple.systempreferences:com.apple.preference.security?" +
      (kind === "mic" ? "Privacy_Microphone" : "Privacy_Camera")
    );
  }
  return "";
}

function osSettingsLabel(platform) {
  const os = platform || process.platform;
  if (os === "win32") return "Windows Settings";
  if (os === "darwin") return "System Settings";
  return "system settings";
}

// Chromium reports an OS level block as NotAllowedError with a message that
// names the system. Our own permission handler always grants "media", so a
// NotAllowedError on mic or camera can only come from the OS.
function isOsDeniedError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return true;
  return /denied by system/i.test(String((err && err.message) || ""));
}

// Windows getMediaAccessStatus often flickers denied to unknown or
// not-determined. Unknown is not a grant. Keep the last denial until the OS
// reports granted or a successful probe clears it.
const WAIT_ACCESS_STEP_MS = 500;
const WAIT_ACCESS_STABLE_MS = 1500;

function emptyLastDenied() {
  return { mic: false, camera: false };
}

function lastDeniedMap(lastDenied) {
  if (lastDenied && typeof lastDenied === "object") return lastDenied;
  return emptyLastDenied();
}

function rememberOsDenied(lastDenied, kind, prefs) {
  const next = lastDeniedMap(lastDenied);
  if (kind !== "mic" && kind !== "camera") return next;
  const os = osMediaOk(kind, prefs);
  if (os === false) next[kind] = true;
  if (os === true) next[kind] = false;
  return next;
}

function noteCaptureDenied(lastDenied, kind) {
  const next = lastDeniedMap(lastDenied);
  if (kind === "mic" || kind === "camera") next[kind] = true;
  return next;
}

function clearCaptureDenied(lastDenied, kind) {
  const next = lastDeniedMap(lastDenied);
  if (kind !== "mic" || kind === "camera") next[kind] = false;
  return next;
}

function isOsDeniedNow(kind, prefs, lastDenied) {
  const os = osMediaOk(kind, prefs);
  if (os === false) return true;
  if (os === true) return false;
  return Boolean(lastDenied && lastDenied[kind]);
}

// Wait until granted, or until unknown stays off denied long enough that a
// single flicker cannot end the wait. A denial that is still sticky does not
// count as success on the first unknown poll.
function waitAccessDecision(kind, prefs, lastDenied, stableMs, opts) {
  rememberOsDenied(lastDenied, kind, prefs);
  const step = opts && opts.stepMs != null ? Number(opts.stepMs) : WAIT_ACCESS_STEP_MS;
  const need = opts && opts.stableMs != null ? Number(opts.stableMs) : WAIT_ACCESS_STABLE_MS;
  const os = osMediaOk(kind, prefs);
  if (os === true) return { done: true, ok: true, stableMs: 0 };
  if (os === false) return { done: false, ok: false, stableMs: 0 };
  if (!lastDenied || !lastDenied[kind]) return { done: true, ok: true, stableMs: 0 };
  const next = (Number(stableMs) || 0) + Math.max(1, step);
  if (next >= need) return { done: true, ok: true, stableMs: next };
  return { done: false, ok: false, stableMs: next };
}

function mediaTypesFrom(details) {
  if (details && Array.isArray(details.mediaTypes) && details.mediaTypes.length) {
    return details.mediaTypes;
  }
  const one = details && details.mediaType;
  if (one === "audio" || one === "video") return [one];
  return [];
}

function permissionKind(permission, details, intent, consent) {
  if (permission === "display-capture") return "screen";
  const types = mediaTypesFrom(details);
  const source = intent && intent.source;
  const wantsMic = Boolean(intent && (intent.mic || source === "mic"));
  const screenOk = Boolean(consent && consent.screen);
  if (types.includes("video")) {
    if (!screenOk) return "screen";
    return "camera";
  }
  if (types.includes("audio")) return "mic";
  if (wantsMic) return "mic";
  if (!screenOk) return "screen";
  return "mic";
}

function kindOk(persisted, kind, prefs, lastDenied) {
  const os = osMediaOk(kind, prefs);
  if (os === false) return false;
  if (os === true) return true;
  if ((kind === "mic" || kind === "camera") && lastDenied && lastDenied[kind]) return false;
  return Boolean(persisted && persisted[kind]);
}

// Name Windows shows for this process in the privacy page app list.
function osAppLabel(packaged) {
  return packaged ? "Simple Recorder" : "Electron";
}

function captureSetupStatus(persisted, prefs, platform, opts) {
  const os = platform || process.platform;
  const lastDenied = opts && opts.lastDenied;
  if (lastDenied) {
    rememberOsDenied(lastDenied, "mic", prefs);
    rememberOsDenied(lastDenied, "camera", prefs);
  }
  const screen = kindOk(persisted, "screen", prefs, lastDenied);
  const camera = kindOk(persisted, "camera", prefs, lastDenied);
  const mic = kindOk(persisted, "mic", prefs, lastDenied);
  const packaged = Boolean(opts && opts.packaged);
  return {
    ready: screen,
    platform: os,
    settingsLabel: osSettingsLabel(os),
    appLabel: osAppLabel(packaged),
    screen: { ok: screen },
    camera: {
      ok: camera,
      os: osMediaStatus("camera", prefs),
      osDenied: isOsDeniedNow("camera", prefs, lastDenied),
      settingsUrl: osSettingsUrl("camera", os),
    },
    mic: {
      ok: mic,
      os: osMediaStatus("mic", prefs),
      osDenied: isOsDeniedNow("mic", prefs, lastDenied),
      settingsUrl: osSettingsUrl("mic", os),
    },
    prefs: recordCenterPrefs(persisted),
  };
}

module.exports = {
  emptySetup,
  normalizeSetup,
  normalizeRecordArea,
  normalizeRecordFps,
  normalizeRecordDelayMs,
  normalizeRecordFormat,
  normalizeRecordQuality,
  normalizeRecordAutoStopMs,
  normalizeDisplayId,
  readCaptureSetup,
  markCaptureApproved,
  saveRecorderPrefs,
  recordCenterPrefs,
  captureSetupStatus,
  osMediaOk,
  osMediaStatus,
  fakeMediaPrefs,
  osSettingsUrl,
  osSettingsLabel,
  osAppLabel,
  isOsDeniedError,
  mediaTypesFrom,
  permissionKind,
  kindOk,
  emptyLastDenied,
  rememberOsDenied,
  noteCaptureDenied,
  clearCaptureDenied,
  isOsDeniedNow,
  waitAccessDecision,
  WAIT_ACCESS_STEP_MS,
  WAIT_ACCESS_STABLE_MS,
};
