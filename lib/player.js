"use strict";

// The built-in player: the pure parts the Takes page and main share. The
// page opens a take in a full-window player instead of handing the file to
// whatever Windows has for .mp4; these helpers keep its prefs sane and its
// prev/next order the same as the Takes grid.

const PLAYER_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const DEFAULT_PLAYER_PREFS = { volume: 1, muted: false, rate: 1, loop: false };

function clampVolume(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

function clampRate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let best = PLAYER_RATES[0];
  for (const rate of PLAYER_RATES) {
    if (Math.abs(rate - n) < Math.abs(best - n)) best = rate;
  }
  return best;
}

// Prefs as the player keeps them: volume 0..1 in hundredths, a mute flag, a
// speed from the menu, and loop. Anything odd lands on the default.
function normalizePlayerPrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    volume: clampVolume(src.volume, DEFAULT_PLAYER_PREFS.volume),
    muted: src.muted === true || src.muted === "1",
    rate: clampRate(src.rate, DEFAULT_PLAYER_PREFS.rate),
    loop: src.loop === true || src.loop === "1",
  };
}

// The kv rows behind the prefs. Additive keys only; an older build leaves
// them alone.
function readPlayerPrefs(db) {
  return normalizePlayerPrefs({
    volume: db.kvGet("playerVolume", "1"),
    muted: db.kvGet("playerMuted", "0"),
    rate: db.kvGet("playerRate", "1"),
    loop: db.kvGet("playerLoop", "0"),
  });
}

function writePlayerPrefs(db, patch) {
  const next = normalizePlayerPrefs(Object.assign({}, readPlayerPrefs(db), patch && typeof patch === "object" ? patch : {}));
  db.kvSet("playerVolume", String(next.volume));
  db.kvSet("playerMuted", next.muted ? "1" : "0");
  db.kvSet("playerRate", String(next.rate));
  db.kvSet("playerLoop", next.loop ? "1" : "0");
  return next;
}

// h:mm:ss past the hour, m:ss under it. Negative, NaN, and Infinity read as
// 0:00 so a file without a duration never shows "NaN:NaN".
function formatPlayerClock(seconds) {
  const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + s;
  return m + ":" + s;
}

// Prev and next follow the Takes grid: newest first, videos and screenshots
// in one row. Ends do not wrap, so Next on the last take is disabled.
function playerNeighbors(takes, id) {
  const list = Array.isArray(takes) ? takes.filter((take) => take && take.id) : [];
  const index = list.findIndex((take) => take.id === id);
  if (index < 0) return { index: -1, count: list.length, prev: null, next: null };
  return {
    index,
    count: list.length,
    prev: index > 0 ? list[index - 1] : null,
    next: index + 1 < list.length ? list[index + 1] : null,
  };
}

// Where a seek key lands: digits jump to tenths of the take, arrows step by
// a fixed number of seconds, and both stay inside the file.
function seekTarget(current, duration, step) {
  const length = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 0;
  const from = Number.isFinite(Number(current)) ? Number(current) : 0;
  let to = from + (Number(step) || 0);
  if (length) to = Math.min(length, to);
  return Math.max(0, to);
}

function seekFraction(duration, fraction) {
  const length = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return length * f;
}

module.exports = {
  PLAYER_RATES,
  DEFAULT_PLAYER_PREFS,
  normalizePlayerPrefs,
  readPlayerPrefs,
  writePlayerPrefs,
  formatPlayerClock,
  playerNeighbors,
  seekTarget,
  seekFraction,
  clampRate,
  clampVolume,
};
