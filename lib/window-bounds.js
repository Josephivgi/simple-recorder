"use strict";

/** Typical XFCE (and similar) bottom panel when Electron workArea equals the full display. */
const DOCK_INSET = 40;

function usableWorkArea(workArea, displayBounds) {
  if (!workArea) return workArea;
  const fullH = displayBounds && displayBounds.height;
  const height =
    fullH != null && workArea.height >= fullH
      ? Math.max(0, workArea.height - DOCK_INSET)
      : workArea.height;
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height,
  };
}

function nextMaximumSize(currentMax, workArea) {
  const width = workArea.width;
  const height = workArea.height;
  if (currentMax && currentMax.width === width && currentMax.height === height) return null;
  return { width, height };
}

function clampedNormalBounds(bounds, workArea, isMaximized) {
  if (isMaximized) return null;
  if (!bounds || !workArea) return null;
  if (bounds.width <= workArea.width && bounds.height <= workArea.height) return null;
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.min(bounds.width, workArea.width),
    height: Math.min(bounds.height, workArea.height),
  };
}

module.exports = { DOCK_INSET, usableWorkArea, nextMaximumSize, clampedNormalBounds };
