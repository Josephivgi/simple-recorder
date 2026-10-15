"use strict";

// Is a captured window frame blank? A loaded studio page has a sidebar, white
// panels, dark text, and a blue button, so it always shows several colors.
// A window whose compositor never painted the page is one flat color (the
// window background), which is what a "white screen" looks like.
//
// The bitmap is raw 4-byte pixels (BGRA from nativeImage.toBitmap). Only the
// pixel count matters, so HiDPI scale factors do not have to be known.
function frameLooksBlank(bitmap, opts = {}) {
  const samples = Math.max(16, Number(opts.samples) || 900);
  const maxColors = Math.max(1, Number(opts.maxColors) || 2);
  const pixels = bitmap && bitmap.length ? Math.floor(bitmap.length / 4) : 0;
  if (!pixels) return { known: false, blank: false, colors: 0 };
  const seen = new Set();
  const step = Math.max(1, Math.floor(pixels / samples));
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4;
    // Quantize so anti-aliasing noise on a flat fill is not a "color".
    seen.add(((bitmap[o] >> 4) << 8) | ((bitmap[o + 1] >> 4) << 4) | (bitmap[o + 2] >> 4));
    if (seen.size > maxColors) return { known: true, blank: false, colors: seen.size };
  }
  return { known: true, blank: true, colors: seen.size };
}

module.exports = { frameLooksBlank };
