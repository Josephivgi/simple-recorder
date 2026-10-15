"use strict";

const path = require("path");
const fs = require("fs/promises");

// A take delete may only remove a file that lives in the recordings folder.
function isRecordingFile(root, filePath) {
  const base = path.resolve(String(root || ""));
  const resolved = path.resolve(String(filePath || ""));
  if (!base || resolved === base) return false;
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Removes the video file. A missing file counts as already deleted. A file
// outside the recordings folder is left alone. Windows can keep a preview's
// handle for a moment, so a lock is retried before giving up.
async function removeRecordingFile(root, filePath, opts) {
  const options = opts || {};
  const realpath = options.realpath || fs.realpath;
  const unlink = options.unlink || fs.unlink;
  const stat = options.stat || fs.stat;
  const wait = options.wait || sleep;
  const tries = Math.max(1, Number(options.tries) || 6);
  let realRoot = root;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root;
  }
  let realFile = String(filePath || "");
  try {
    realFile = await realpath(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, missing: true };
    return { ok: false, error: "Could not delete that recording." };
  }
  if (!isRecordingFile(realRoot, realFile)) {
    return { ok: false, error: "That file is not in the recordings folder." };
  }
  let info = null;
  try {
    info = await stat(realFile);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, missing: true };
    return { ok: false, error: "Could not delete that recording." };
  }
  if (!info.isFile()) return { ok: false, error: "That file is not in the recordings folder." };
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      await unlink(realFile);
      last = null;
      break;
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, missing: true };
      last = error;
      const locked = error && (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES");
      if (!locked || i === tries - 1) break;
      await wait(120);
    }
  }
  if (last) {
    return { ok: false, error: "Could not delete that recording. Close it if another app has it open." };
  }
  try {
    if (await stat(realFile)) {
      return { ok: false, error: "Could not delete that recording. Close it if another app has it open." };
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true };
    return { ok: false, error: "Could not delete that recording." };
  }
  return { ok: true };
}

module.exports = {
  isRecordingFile,
  removeRecordingFile,
};
