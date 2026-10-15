"use strict";

const REVERSE_DNS_WINDOW_NAME = /^(?:com|org)\.[a-z0-9][a-z0-9._-]*$/i;
const BRIDGE_ARTIFACT_NAME = /bridgem(?:ind|emory)/i;
const OVERLAY_NAME = /^(?:simple )?recorder (?:bar|area|take outline|window|countdown)/i;

const INTERNAL_UTILITY_WINDOW_NAMES = new Set([
  "",
  "window",
  "program manager",
  "default ime",
  "msctfime ui",
  "nvidia geforce overlay",
  "amd: adrenalin",
  "cortana",
  "windows input experience",
  "microsoft text input application",
  "settings",
]);

function captureSourceKind(id, item) {
  if (item && item.kind === "window") return "window";
  if (item && item.kind === "screen") return "screen";
  return String(id || "").startsWith("window:") ? "window" : "screen";
}

function normalizeCaptureName(name) {
  return String(name || "").trim();
}

function isReverseDnsWindowName(name) {
  const normalized = normalizeCaptureName(name);
  if (!normalized) return false;
  return REVERSE_DNS_WINDOW_NAME.test(normalized);
}

function isBridgeArtifactName(name) {
  return BRIDGE_ARTIFACT_NAME.test(normalizeCaptureName(name));
}

function isInternalUtilityWindowName(name) {
  const normalized = normalizeCaptureName(name);
  if (!normalized) return true;
  return INTERNAL_UTILITY_WINDOW_NAMES.has(normalized.toLowerCase());
}

function isJunkCaptureWindowName(name) {
  const normalized = normalizeCaptureName(name);
  if (!normalized) return true;
  if (isBridgeArtifactName(normalized)) return true;
  if (isReverseDnsWindowName(normalized)) return true;
  if (isInternalUtilityWindowName(normalized)) return true;
  return false;
}

function keepCaptureSource(item) {
  if (!item || !item.id) return false;
  const name = normalizeCaptureName(item.name);
  if (OVERLAY_NAME.test(name)) return false;

  const kind = captureSourceKind(item.id, item);
  if (kind === "screen") return true;
  if (kind !== "window") return false;
  return !isJunkCaptureWindowName(name);
}

module.exports = {
  captureSourceKind,
  keepCaptureSource,
  isJunkCaptureWindowName,
  isReverseDnsWindowName,
  isBridgeArtifactName,
  isInternalUtilityWindowName,
};
