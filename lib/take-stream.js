"use strict";

// Byte-range serving for take:// files. The <video> element asks for pieces
// of a file (the header first, then the tail to find the index, then wherever
// a seek lands) and only trusts a resource that answers 206 with a
// Content-Range; a plain 200 reads as "not seekable", which for a long
// recording means a wrong duration and a dead seek bar. These helpers turn a
// Range header into the slice to stream and the headers to send with it.

const MEDIA_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mediaTypeFor(filePath) {
  const dot = String(filePath || "").lastIndexOf(".");
  const ext = dot >= 0 ? String(filePath).slice(dot).toLowerCase() : "";
  return MEDIA_TYPES[ext] || "application/octet-stream";
}

// One satisfiable range, or null for "send the whole file". `ok: false` is
// a range the file cannot satisfy (416). Only the first range of a list is
// served; multipart ranges are not something media playback asks for.
function parseRange(header, size) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  const text = String(header || "").trim();
  if (!text) return null;
  const match = /^bytes=(\d*)-(\d*)(?:,|$)/.exec(text);
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (total === 0) return { ok: false, start: 0, end: -1, size: total };
  let start;
  let end;
  if (startText === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(endText);
    if (!(suffix > 0)) return { ok: false, start: 0, end: -1, size: total };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? total - 1 : Math.min(Number(endText), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
    return { ok: false, start: 0, end: -1, size: total };
  }
  return { ok: true, start, end, size: total };
}

// Status and headers for a slice (or the whole file when range is null).
function rangeResponse(range, size, filePath) {
  const total = Math.max(0, Math.floor(Number(size) || 0));
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": mediaTypeFor(filePath),
    "Cache-Control": "no-store",
    // The page loads the video with crossorigin="anonymous" so Save frame
    // can draw it to a canvas; without this the canvas is tainted and
    // toBlob refuses. take:// only ever serves the recordings folder.
    "Access-Control-Allow-Origin": "*",
  };
  if (range && range.ok === false) {
    headers["Content-Range"] = "bytes */" + total;
    return { status: 416, headers, start: 0, end: -1, length: 0 };
  }
  if (!range) {
    headers["Content-Length"] = String(total);
    return { status: 200, headers, start: 0, end: total - 1, length: total };
  }
  const length = range.end - range.start + 1;
  headers["Content-Length"] = String(length);
  headers["Content-Range"] = "bytes " + range.start + "-" + range.end + "/" + total;
  return { status: 206, headers, start: range.start, end: range.end, length };
}

module.exports = { parseRange, rangeResponse, mediaTypeFor, MEDIA_TYPES };
