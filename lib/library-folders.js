"use strict";

// Camera-roll layout for finished takes. Everything the recorder writes
// lands in one top-level folder ("Simple recorder") and is grouped into a
// folder per day ("2026-10-12"), so the Takes page and File Explorer show
// the same thing. Only paths and folder moves live here; the capture path
// never touches this module, and nothing in it deletes a recording.

const path = require("path");
const fs = require("fs/promises");

const LIBRARY_FOLDER_NAME = "Simple recorder";
const DAY_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_RE = /\.(webm|mp4)$/i;
// The names this recorder gives its files: "Screen take 3", plus the
// " (partial)" suffix a bad take gets and the " 2" a name clash adds.
const TAKE_NAME_RE = /^(?:Screen|Recovered) take \d+(?: \(partial\))?(?: \d+)?\.(?:webm|mp4)$/i;
const NAME_TRIES = 500;

// The camera-roll root. Videos is the discoverable home, matching the
// consent copy ("Takes are saved to the Videos folder"); a machine with no
// Videos known folder falls back to the app's own userData, still under one
// folder of the same name.
function libraryRoot(videosDir, userDataDir) {
  const parent = videosDir || userDataDir;
  return parent ? path.join(String(parent), LIBRARY_FOLDER_NAME) : LIBRARY_FOLDER_NAME;
}

// Local date, so the folder matches the day the user recorded on, not UTC.
function dayFolderName(when) {
  const date = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

// Where a take made at `when` belongs. A date that will not parse leaves the
// take in the root: never invent a folder name from garbage.
function dayFolderFor(root, when) {
  const day = dayFolderName(when);
  return day ? path.join(String(root), day) : String(root);
}

function isInLibrary(root, filePath) {
  const base = path.resolve(String(root || ""));
  const resolved = path.resolve(String(filePath || ""));
  if (!base || !resolved || resolved === base) return false;
  const rel = path.relative(base, resolved);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isDayFolderName(name) {
  return DAY_FOLDER_RE.test(String(name || ""));
}

// "Simple Recorder" and "Simple recorder" are one folder on Windows and
// macOS, and a row can still carry the spelling it was written with, so a
// path comparison between a row and a folder listing has to fold case.
// Linux keeps the two apart, where the exact spelling is the answer.
const CASELESS_PATHS = process.platform === "win32" || process.platform === "darwin";

function samePath(a, b) {
  const left = path.resolve(String(a || ""));
  const right = path.resolve(String(b || ""));
  if (!left || !right) return false;
  return CASELESS_PATHS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// The day folder a take lives in, read off disk so the app groups exactly
// the way Explorer does. A take that is not in a day folder (one the
// migration could not move yet) falls back to the day it was recorded.
function dayKeyForTake(root, take) {
  const base = path.resolve(String(root || ""));
  const file = path.resolve(String((take && take.path) || ""));
  const folder = file ? path.basename(path.dirname(file)) : "";
  if (isDayFolderName(folder) && samePath(path.dirname(path.dirname(file)), base)) return folder;
  const when = Date.parse(String((take && take.createdAt) || ""));
  return Number.isFinite(when) ? dayFolderName(new Date(when)) : "";
}

function looksLikeTakeFile(name) {
  return TAKE_NAME_RE.test(String(name || ""));
}

// First free file name in a folder: "Screen take 1.webm", then
// "Screen take 1 2.webm", the same bump the take save always used.
async function uniqueTakePath(dir, name, ext, opts) {
  const io = opts || {};
  const readdir = io.readdir || fs.readdir;
  const names = await readdir(dir).catch(() => []);
  // Folded where the filesystem folds, so a name that differs only in case
  // cannot land on top of a take already in the folder.
  const taken = new Set(names.map((entry) => (CASELESS_PATHS ? String(entry).toLowerCase() : String(entry))));
  const free = (file) => !taken.has(CASELESS_PATHS ? file.toLowerCase() : file);
  const base = String(name || "Take");
  let candidate = base + ext;
  let n = 2;
  while (!free(candidate)) {
    if (n > NAME_TRIES) return "";
    candidate = base + " " + n + ext;
    n += 1;
  }
  return path.join(String(dir), candidate);
}

// rename() keeps a file on its own volume and is atomic; a library on
// another drive than the inflight folder needs a copy instead, and that copy
// is trusted only once the size on both sides matches. The source is never
// removed before the destination verifies, so a failure anywhere leaves the
// footage where it was.
async function moveFileVerifying(src, dest, opts) {
  const io = opts || {};
  const stat = io.stat || fs.stat;
  const rename = io.rename || fs.rename;
  const copyFile = io.copyFile || fs.copyFile;
  const unlink = io.unlink || fs.unlink;
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat || !srcStat.isFile()) return { ok: false };
  try {
    await rename(src, dest);
    const destStat = await stat(dest).catch(() => null);
    if (destStat && destStat.isFile() && destStat.size === srcStat.size) return { ok: true };
    return { ok: false };
  } catch (error) {
    if (!error || error.code !== "EXDEV") return { ok: false };
  }
  try {
    await copyFile(src, dest);
    const destStat = await stat(dest).catch(() => null);
    if (!destStat || destStat.size !== srcStat.size) return { ok: false };
    await unlink(src).catch(() => {});
    return { ok: true, copied: true };
  } catch {
    return { ok: false };
  }
}

async function renameFolderCase(fromDir, toDir, io) {
  const listing = () => io.readdir(path.dirname(toDir)).catch(() => []);
  const lands = async (from, to) => {
    try {
      await io.rename(from, to);
    } catch {
      return false;
    }
    const base = path.basename(to);
    const entries = await listing();
    // The exact name has to be there and no second folder of that name left
    // beside it, so a rename that did nothing is never reported as a fix.
    return entries.includes(base) && !entries.some((entry) => entry !== base && String(entry).toLowerCase() === base.toLowerCase());
  };
  if (await lands(fromDir, toDir)) return true;
  const names = await listing();
  // The exact name already belongs to a folder of its own (Linux keeps both
  // spellings apart): leave the pair alone rather than stepping aside.
  if (names.includes(path.basename(toDir))) return false;
  // Some filesystems refuse a case-only rename; step through a temporary
  // name, which is only safe while the real name is free, and put it
  // straight back if that second step does not land.
  const temp = toDir + ".renaming";
  if (!(await lands(fromDir, temp))) return false;
  if (await lands(temp, toDir)) return true;
  await lands(temp, fromDir);
  return false;
}

// Windows treats "Simple Recorder" and "Simple recorder" as one folder, so a
// library made before the name was fixed keeps showing the old casing in
// Explorer. Rename it to the exact name and confirm, instead of leaving it.
// Nothing here creates, moves into, or empties a folder.
async function adoptLibraryRootName(parentDir, name, opts) {
  const io = opts || {};
  const readdir = io.readdir || fs.readdir;
  const rename = io.rename || fs.rename;
  const parent = path.resolve(String(parentDir || ""));
  if (!parent) return { ok: true, renamed: false };
  const entries = await readdir(parent).catch(() => null);
  if (!entries) return { ok: true, renamed: false };
  const want = String(name);
  const match = entries.find((entry) => String(entry).toLowerCase() === want.toLowerCase());
  if (!match || match === want) return { ok: true, renamed: false };
  const from = path.join(parent, match);
  const to = path.join(parent, want);
  const done = await renameFolderCase(from, to, { rename, readdir });
  return { ok: done, renamed: done, from: done ? from : "" };
}

// One pass over the library root: a loose take the app indexed goes into its
// day folder and the caller re-points the row; a loose file that carries a
// recorder name (an index lost or never written) is adopted the same way;
// anything else stays exactly where the user put it. Files already inside a
// day folder are left alone, so a second run moves nothing. A row whose
// spelling of its own file drifted from the disk (the root folder was
// renamed for casing) is handed back as `repointed` instead.
async function migrateLibrary(root, takes, opts) {
  const options = opts || {};
  const io = {
    stat: options.stat || fs.stat,
    readdir: options.readdir || fs.readdir,
    realpath: options.realpath || fs.realpath,
    rename: options.rename || fs.rename,
    copyFile: options.copyFile || fs.copyFile,
    unlink: options.unlink || fs.unlink,
    mkdir: options.mkdir || fs.mkdir,
  };
  const log = typeof options.log === "function" ? options.log : () => {};
  const result = { moves: [], repointed: [], adopted: [], failed: [] };
  const base = path.resolve(String(root || ""));
  if (!base) return result;
  const entries = await io.readdir(base).catch(() => null);
  if (!entries) return result;
  // Exact spelling first: only a row that no longer matches one of these
  // falls back to matching the same path by its folded key.
  const indexed = new Map();
  const folded = new Map();
  for (const take of takes || []) {
    const file = path.resolve(String((take && take.path) || ""));
    if (!file) continue;
    indexed.set(file, take);
    const key = file.toLowerCase();
    if (!folded.has(key)) folded.set(key, take);
  }
  const findTake = (file) => {
    const resolved = path.resolve(file);
    if (indexed.has(resolved)) return indexed.get(resolved);
    return CASELESS_PATHS ? folded.get(resolved.toLowerCase()) || null : null;
  };
  for (const take of takes || []) {
    const file = path.resolve(String((take && take.path) || ""));
    if (!file || !isInLibrary(base, file)) continue;
    // The row keeps its file, but the file's real spelling is the one the
    // folder listing uses; store that so a later move or delete matches. A
    // real path outside the root (Videos redirected to OneDrive, a link)
    // is left alone: the library has to stay one folder tree.
    const real = await io.realpath(file).catch(() => null);
    if (real && real !== file && isInLibrary(base, real)) {
      result.repointed.push({ id: take.id, from: file, to: real });
    }
  }
  for (const entry of entries) {
    const full = path.join(base, entry);
    const take = findTake(full);
    if (!MEDIA_RE.test(entry) || (!take && !looksLikeTakeFile(entry))) continue;
    const info = await io.stat(full).catch(() => null);
    if (!info || !info.isFile()) continue;
    const recorded = Date.parse(String((take && take.createdAt) || ""));
    const when = Number.isFinite(recorded) ? new Date(recorded) : new Date(Number(info.mtimeMs));
    const day = dayFolderName(when);
    if (!day) continue;
    const dir = path.join(base, day);
    await io.mkdir(dir, { recursive: true });
    const ext = path.extname(entry);
    const dest = await uniqueTakePath(dir, path.basename(entry, ext), ext, { readdir: io.readdir });
    if (!dest) {
      result.failed.push({ from: full, error: "no free name" });
      continue;
    }
    const moved = await moveFileVerifying(full, dest, io);
    if (!moved.ok) {
      result.failed.push({ from: full, error: "could not move" });
      continue;
    }
    if (take) {
      result.moves.push({ id: take.id, from: full, to: dest, name: path.basename(dest, ext) });
    } else {
      result.adopted.push({ from: full, to: dest });
    }
    log("take moved into day folder", path.basename(dest) + " -> " + day);
  }
  return result;
}

module.exports = {
  LIBRARY_FOLDER_NAME,
  libraryRoot,
  dayFolderName,
  dayFolderFor,
  dayKeyForTake,
  isDayFolderName,
  isInLibrary,
  samePath,
  looksLikeTakeFile,
  uniqueTakePath,
  moveFileVerifying,
  adoptLibraryRootName,
  migrateLibrary,
};
