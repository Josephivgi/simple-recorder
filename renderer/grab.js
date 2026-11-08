// Hidden capture page for screenshots (electron/screen-grab.cjs). Main asks
// it, through executeJavaScript, for one frame of a screen or window stream;
// the PNG is cropped and encoded here, off the main process.
"use strict";

let warm = null; // { id, stream, track }
let opening = null; // { id, promise } while a warm call opens its stream

function stopWarm() {
  if (!warm) return;
  for (const track of warm.stream.getTracks()) track.stop();
  warm = null;
}

async function openStream(id, size) {
  const video = { chromeMediaSource: "desktop", chromeMediaSourceId: id, maxFrameRate: 30 };
  if (size && size.width > 0 && size.height > 0) {
    // A screen comes at its full pixel size, never scaled.
    video.minWidth = video.maxWidth = size.width;
    video.minHeight = video.maxHeight = size.height;
  } else {
    // A window comes at its own size, up to 8K.
    video.maxWidth = 7680;
    video.maxHeight = 4320;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: video } });
  return { id, stream, track: stream.getVideoTracks()[0] };
}

// The same math as cropPixelRect in lib/screenshot.cjs.
function cropRect(width, height, crop) {
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

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function warmPipeline(source) {
  const frame = await withTimeout(new ImageCapture(source.track).grabFrame(), 3000, "no frame");
  const canvas = new OffscreenCanvas(256, 256);
  canvas.getContext("2d").drawImage(frame, 0, 0, 256, 256, 0, 0, 256, 256);
  frame.close();
  await canvas.convertToBlob({ type: "image/png" });
}

// Open (or reuse) the stream for id, so the next grab skips the open.
window.__grabWarm = async (id, size) => {
  if (warm && warm.id === id && warm.track.readyState === "live") return true;
  if (opening && opening.id === id) {
    await opening.promise;
    return true;
  }
  stopWarm();
  const entry = { id, promise: withTimeout(openStream(id, size), 5000, "The screen did not open.") };
  opening = entry;
  try {
    const source = await entry.promise;
    if (opening === entry) {
      warm = source;
      // The first frame read and PNG encode are slow while their pipeline
      // starts; run a tiny one now so the real screenshot does not pay it.
      await warmPipeline(source).catch(() => {});
    } else for (const track of source.stream.getTracks()) track.stop();
  } finally {
    if (opening === entry) opening = null;
  }
  return true;
};

window.__grabStop = () => {
  stopWarm();
  return true;
};

// One frame of id as PNG bytes. keep leaves the stream open for the next one.
window.__grab = async (id, size, crop, keep) => {
  // A press right after a warm call waits for that stream instead of
  // opening a second one.
  const t0 = performance.now();
  if (opening && opening.id === id) await opening.promise.catch(() => {});
  let source = warm && warm.id === id && warm.track.readyState === "live" ? warm : null;
  const reused = Boolean(source);
  if (!source) {
    stopWarm();
    source = await withTimeout(openStream(id, size), 5000, "The screen did not open.");
  }
  try {
    const t1 = performance.now();
    const frame = await withTimeout(new ImageCapture(source.track).grabFrame(), 3000, "No picture came from it. It may be minimized.");
    const t2 = performance.now();
    const rect = cropRect(frame.width, frame.height, crop);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    canvas.getContext("2d").drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    frame.close();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ms = (a, b) => Math.round(b - a);
    const timing = (reused ? "warm" : "cold") + " open=" + ms(t0, t1) + "ms frame=" + ms(t1, t2) + "ms png=" + ms(t2, performance.now()) + "ms";
    return { width: rect.width, height: rect.height, bytes, timing };
  } finally {
    if (keep) warm = source;
    else if (source === warm) stopWarm();
    else for (const track of source.stream.getTracks()) track.stop();
  }
};
