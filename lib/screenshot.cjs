"use strict";

// Screenshots: one PNG of the screen a take would record, cropped the same
// way when a crop is set. Only the naming and the crop math live here; the
// capture itself is desktopCapturer in main.

const SCREENSHOT_NAME_RE = /^Screenshot (\d+)(?: \d+)?$/;

// "Screenshot 1", "Screenshot 2", ... the same numbering takes use.
function nextScreenshotName(takes) {
  let max = 0;
  for (const item of takes || []) {
    const match = String((item && item.name) || "").match(SCREENSHOT_NAME_RE);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return "Screenshot " + (max + 1);
}

// A normalized crop ({x, y, w, h} in 0..1 of the display) as a pixel rect
// inside an image of `size`. No crop, or one that misses the image, is the
// whole image.
function cropPixelRect(size, crop) {
  const width = Math.max(0, Math.round(Number(size && size.width) || 0));
  const height = Math.max(0, Math.round(Number(size && size.height) || 0));
  const whole = { x: 0, y: 0, width, height };
  if (!crop || !width || !height) return whole;
  const w = Number(crop.w);
  const h = Number(crop.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return whole;
  const x = Number.isFinite(Number(crop.x)) ? Number(crop.x) : 0;
  const y = Number.isFinite(Number(crop.y)) ? Number(crop.y) : 0;
  const left = Math.max(0, Math.min(width, Math.round(x * width)));
  const top = Math.max(0, Math.min(height, Math.round(y * height)));
  const right = Math.max(0, Math.min(width, Math.round((x + w) * width)));
  const bottom = Math.max(0, Math.min(height, Math.round((y + h) * height)));
  if (right - left < 2 || bottom - top < 2) return whole;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function isScreenshot(take) {
  return String((take && take.mime) || "").startsWith("image/");
}

module.exports = { nextScreenshotName, cropPixelRect, isScreenshot };
