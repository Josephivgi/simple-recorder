"use strict";

// GitHub Releases update system for Simple Recorder.
// Supports listing published GitHub versions, checking for newer releases,
// auto-updating when enabled, and installing any chosen GitHub release
// version via atomic staging and file replacement.

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { createHash, randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { describeInstall, readManifest, makeManifest, manifestPath, setRegistryDisplayVersion } = require("./install-layout");

// The public repo is where releases reach every user. The private
// development repo carries developer builds; only Developer mode updates
// read from it.
const DEFAULT_REPO = "Josephivgi/simple-recorder";
const DEV_REPO = "Josephivgi/simple-recorder-dev";
const GITHUB_API = "https://api.github.com";
const BUNDLE_ASSET_RE = /^simple-recorder-.*-app\.tar\.gz$/i;
const TAR_ASSET_RE = /\.(tar\.gz|tgz)$/i;
const ALLOWED_TOP_FILES = new Set(["package.json", "AGENTS.md"]);
const ALLOWED_TOP_DIRS = new Set(["electron", "lib", "renderer", "scripts"]);

function normalizeVersion(raw) {
  const text = String(raw == null ? "" : raw).trim().replace(/^[vV]+/, "");
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return "";
  return match[1] + "." + match[2] + "." + match[3] + (match[4] ? "-" + match[4] : "");
}

function formatTag(raw) {
  const clean = String(raw == null ? "" : raw).trim();
  if (!clean) return "";
  const ver = normalizeVersion(clean);
  if (ver) return "v" + ver;
  return clean.startsWith("v") ? clean : "v" + clean;
}

function parseVersionParts(raw) {
  const norm = normalizeVersion(raw);
  if (!norm) return null;
  const [core, pre = ""] = norm.split("-", 2);
  const nums = core.split(".").map((n) => Number(n));
  if (nums.length !== 3 || !nums.every(Number.isFinite)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

function compareVersions(a, b) {
  const va = parseVersionParts(a);
  const vb = parseVersionParts(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;
  if (!va.pre && !vb.pre) return 0;
  // A stable release ranks higher than a prerelease of the same version.
  if (!va.pre && vb.pre) return 1;
  if (va.pre && !vb.pre) return -1;
  return va.pre.localeCompare(vb.pre, undefined, { numeric: true });
}

function pickReleaseAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  let bundle = list.find((item) => item && BUNDLE_ASSET_RE.test(String(item.name || "")));
  if (!bundle) {
    bundle = list.find((item) => item && TAR_ASSET_RE.test(String(item.name || "")));
  }
  const manifest = list.find((item) => item && String(item.name || "").toLowerCase() === "latest.json");
  const mapAsset = (item) =>
    item
      ? {
          id: item.id != null ? String(item.id) : "",
          name: String(item.name || ""),
          size: Math.max(0, Number(item.size) || 0),
          apiUrl: String(item.url || ""),
          downloadUrl: String(item.browser_download_url || item.url || ""),
        }
      : null;
  return {
    bundle: mapAsset(bundle),
    manifest: mapAsset(manifest),
  };
}

function normalizeRelease(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.draft) return null;
  const rawTag = String(raw.tag_name || raw.tag || raw.version || "").trim();
  const version = normalizeVersion(rawTag || raw.name || "");
  if (!version) return null;
  const tag = rawTag || formatTag(version);
  const picked = raw.bundle
    ? { bundle: raw.bundle, manifest: raw.manifest || null }
    : pickReleaseAssets(raw.assets);
  return {
    id: String(raw.id || tag),
    tag,
    version,
    name: String(raw.name || tag),
    publishedAt: String(raw.published_at || raw.publishedAt || ""),
    prerelease: Boolean(raw.prerelease),
    htmlUrl: String(raw.html_url || raw.htmlUrl || ""),
    notes: String(raw.body || raw.notes || "").slice(0, 2000),
    tarballUrl: String(raw.tarball_url || raw.tarballUrl || ""),
    bundle: picked.bundle,
    manifest: picked.manifest,
  };
}

function sortReleasesDesc(releases) {
  return [...releases].sort((a, b) => {
    const cmp = compareVersions(b.version, a.version);
    if (cmp !== 0) return cmp;
    const ta = Date.parse(a.publishedAt) || 0;
    const tb = Date.parse(b.publishedAt) || 0;
    return tb - ta;
  });
}

function normalizeReleaseList(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const norm = normalizeRelease(item);
    if (!norm || seen.has(norm.version)) continue;
    seen.add(norm.version);
    out.push(norm);
  }
  return sortReleasesDesc(out);
}

// ---------------------------------------------------------------------------
// Pure-JS POSIX ustar (.tar.gz) pack & unpack
// ---------------------------------------------------------------------------

function writeOctal(buf, offset, length, value) {
  const str = Math.max(0, Math.floor(Number(value) || 0))
    .toString(8)
    .padStart(length - 1, "0");
  buf.write(str.slice(0, length - 1), offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function makeTarHeader(relPath, size, mtimeSec) {
  const header = Buffer.alloc(512, 0);
  const posixPath = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "");
  let name = posixPath;
  let prefix = "";
  if (Buffer.byteLength(posixPath) > 100) {
    const slash = posixPath.lastIndexOf("/");
    if (slash > 0) {
      prefix = posixPath.slice(0, slash);
      name = posixPath.slice(slash + 1);
    }
  }
  header.write(name.slice(0, 100), 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSec || Math.floor(Date.now() / 1000));
  // Checksum field filled with spaces during sum calculation.
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // '0' regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix.slice(0, 155), 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0");
  header.write(chk, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function packTarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ""), "utf8");
    const header = makeTarHeader(entry.path, data.length, entry.mtimeSec);
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function readTarString(buf, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end += 1;
  return buf.subarray(offset, end).toString("utf8");
}

function readTarSize(buf, offset, length) {
  // Base-256 extension check (high bit set).
  if ((buf[offset] & 0x80) !== 0) {
    let val = 0;
    for (let i = offset + 1; i < offset + length; i += 1) {
      val = val * 256 + buf[i];
    }
    return val;
  }
  const raw = readTarString(buf, offset, length).trim();
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parsePaxPath(buf) {
  const text = buf.toString("utf8");
  let idx = 0;
  while (idx < text.length) {
    const space = text.indexOf(" ", idx);
    if (space < 0) break;
    const len = parseInt(text.slice(idx, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, idx + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") {
      return record.slice(eq + 1);
    }
    idx += len;
  }
  return "";
}

function unpackTarGz(gzBuffer) {
  const tar = zlib.gunzipSync(gzBuffer);
  const rawEntries = [];
  let offset = 0;
  let nextPathOverride = "";
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    const size = readTarSize(header, 124, 12);
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const dataEnd = offset + size;
    const body = tar.subarray(offset, Math.min(dataEnd, tar.length));
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === "x" || typeFlag === "120") {
      const paxPath = parsePaxPath(body);
      if (paxPath) nextPathOverride = paxPath;
      continue;
    }
    if (typeFlag === "L") {
      nextPathOverride = readTarString(body, 0, body.length);
      continue;
    }
    if (typeFlag === "g" || typeFlag === "5") {
      nextPathOverride = "";
      continue;
    }
    const fullPath = (nextPathOverride || (prefix ? prefix + "/" + name : name))
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "");
    nextPathOverride = "";
    if ((typeFlag === "0" || typeFlag === "\0") && fullPath) {
      rawEntries.push({ path: fullPath, data: Buffer.from(body) });
    }
  }

  // Strip a single common top-level folder if package.json is nested one level
  // deep (for example, GitHub's auto-generated tarball_url).
  const hasRootPkg = rawEntries.some((item) => item.path === "package.json");
  if (!hasRootPkg) {
    const nestedPkg = rawEntries.find((item) => /^[^/]+\/package\.json$/.test(item.path));
    if (nestedPkg) {
      const prefix = nestedPkg.path.slice(0, nestedPkg.path.indexOf("/") + 1);
      return rawEntries
        .filter((item) => item.path.startsWith(prefix))
        .map((item) => ({ path: item.path.slice(prefix.length), data: item.data }))
        .filter((item) => item.path);
    }
  }
  return rawEntries;
}

function isAllowedAppPath(relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("\0")) return false;
  const parts = clean.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return false;
  if (parts.length === 1) return ALLOWED_TOP_FILES.has(parts[0]);
  return ALLOWED_TOP_DIRS.has(parts[0]);
}

async function collectDirFiles(rootDir, relDir, out) {
  const absDir = path.join(rootDir, relDir);
  const items = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const rel = relDir ? relDir + "/" + item.name : item.name;
    if (item.isDirectory()) {
      await collectDirFiles(rootDir, rel, out);
    } else if (item.isFile()) {
      const data = await fs.readFile(path.join(rootDir, rel));
      out.push({ path: rel.replace(/\\/g, "/"), data });
    }
  }
}

async function createUpdateBundle(appRoot, outFile, opts) {
  const entries = [];
  for (const topFile of ALLOWED_TOP_FILES) {
    const abs = path.join(appRoot, topFile);
    const data = await fs.readFile(abs).catch(() => null);
    if (!data) continue;
    if (topFile === "package.json" && opts && opts.version) {
      const pkg = JSON.parse(data.toString("utf8"));
      pkg.version = normalizeVersion(opts.version) || pkg.version;
      entries.push({ path: "package.json", data: Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8") });
    } else {
      entries.push({ path: topFile, data });
    }
  }
  for (const dir of ALLOWED_TOP_DIRS) {
    await collectDirFiles(appRoot, dir, entries);
  }
  const gz = packTarGz(entries);
  const sha256 = createHash("sha256").update(gz).digest("hex");
  if (outFile) {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const tmp = outFile + ".tmp-" + randomUUID();
    await fs.writeFile(tmp, gz);
    await fs.rename(tmp, outFile);
  }
  const pkgEntry = entries.find((item) => item.path === "package.json");
  const pkg = pkgEntry ? JSON.parse(pkgEntry.data.toString("utf8")) : {};
  return {
    buffer: gz,
    path: outFile || "",
    size: gz.length,
    sha256,
    version: normalizeVersion(pkg.version || "1.0.0") || "1.0.0",
    filesCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// GitHub auth & HTTP helpers
// ---------------------------------------------------------------------------

// The public repo is read anonymously: a public build never looks for a
// GitHub token, in the environment or anywhere else. The one exception is
// Developer mode updates, which the user turns on by hand: the private
// development repo needs the developer's GitHub OAuth sign-in, read from the
// GitHub CLI (`gh auth login`) only while that mode is on, and never stored.
function resolveDeveloperToken() {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout ? String(stdout).trim() : "");
    });
  });
}

function authToken(opts) {
  return opts && typeof opts.token === "string" ? opts.token.trim() : "";
}

function isGitHubApiUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.protocol === "https:" && url.hostname === "api.github.com";
  } catch {
    return false;
  }
}

function requestBuffer(urlStr, opts = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (error) {
      reject(error);
      return;
    }
    const client = parsed.protocol === "http:" ? http : https;
    const headers = {
      "User-Agent": "Simple-Recorder-Updater",
      ...(opts.headers || {}),
    };
    // A developer sign-in only ever travels over HTTPS.
    if (parsed.protocol !== "https:") {
      delete headers.Authorization;
      delete headers.authorization;
    }
    const req = client.get(
      parsed,
      {
        headers,
        timeout: opts.timeoutMs || 20000,
      },
      (res) => {
        const status = Number(res.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects."));
            return;
          }
          const nextUrl = new URL(res.headers.location, parsed).toString();
          const nextHost = new URL(nextUrl).hostname;
          const nextHeaders = { ...(opts.headers || {}) };
          // Do not forward GitHub API Authorization header to S3 signed URLs.
          if (nextHost !== parsed.hostname) {
            delete nextHeaders.Authorization;
            delete nextHeaders.authorization;
          }
          resolve(requestBuffer(nextUrl, { ...opts, headers: nextHeaders }, redirectsLeft - 1));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (status >= 200 && status < 300) {
            resolve({ status, body, headers: res.headers });
          } else {
            const err = new Error("HTTP " + status);
            err.status = status;
            err.body = body.toString("utf8").slice(0, 400);
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out."));
    });
    req.on("error", reject);
  });
}

async function fetchGitHubReleases(repo, opts = {}) {
  if (typeof opts.fetchReleases === "function") {
    const raw = await opts.fetchReleases(repo, opts);
    return normalizeReleaseList(raw);
  }
  const feedFile = opts.feedFile || process.env.REC_UPDATE_FEED_FILE || "";
  if (feedFile) {
    const text = await fs.readFile(feedFile, "utf8");
    const parsed = JSON.parse(text);
    // A list, { releases: [...] }, or one list per repo keyed by its name.
    const list = Array.isArray(parsed) ? parsed : parsed.releases || parsed[repo] || [];
    return normalizeReleaseList(list);
  }
  const token = authToken(opts);
  // A signed-in request only goes to GitHub itself; the API override is for
  // anonymous test servers.
  const apiBase = token
    ? GITHUB_API
    : (opts.apiBase || process.env.REC_UPDATE_API_URL || GITHUB_API).replace(/\/+$/, "");
  const url = apiBase + "/repos/" + repo + "/releases?per_page=25";
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await requestBuffer(url, { headers, timeoutMs: opts.timeoutMs || 15000 });
  const data = JSON.parse(res.body.toString("utf8"));
  return normalizeReleaseList(data);
}

// Local package paths are only honored in feed-file test mode, so a release
// list can never point an install at a file already on disk.
function localPackagesAllowed(opts) {
  return Boolean(opts.feedFile || process.env.REC_UPDATE_FEED_FILE);
}

async function downloadAsset(asset, opts, timeoutMs) {
  const token = authToken(opts);
  if (localPackagesAllowed(opts) && asset.downloadUrl && fssync.existsSync(asset.downloadUrl)) {
    return fs.readFile(asset.downloadUrl);
  }
  const url = token && asset.apiUrl ? asset.apiUrl : asset.downloadUrl || asset.apiUrl;
  const headers = {
    Accept: "application/octet-stream",
  };
  if (token && isGitHubApiUrl(url)) headers.Authorization = "Bearer " + token;
  const res = await requestBuffer(url, { headers, timeoutMs });
  return res.body;
}

// Every release package is checked against its latest.json: same asset name
// and the sha256 of the bytes that were downloaded. A missing or mismatched
// latest.json stops the install.
function verifyArchiveHash(gzBuffer, manifestJson, release) {
  let manifest = null;
  try {
    manifest = JSON.parse(Buffer.isBuffer(manifestJson) ? manifestJson.toString("utf8") : String(manifestJson));
  } catch {
    throw new Error("Update check failed: latest.json on " + release.tag + " is not valid JSON.");
  }
  const expected = String((manifest && manifest.sha256) || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("Update check failed: latest.json on " + release.tag + " has no sha256.");
  }
  const bundleName = release.bundle && release.bundle.name;
  if (manifest.assetName && bundleName && manifest.assetName !== bundleName) {
    throw new Error("Update check failed: latest.json on " + release.tag + " names a different package.");
  }
  const actual = createHash("sha256").update(gzBuffer).digest("hex");
  if (actual !== expected) {
    throw new Error("Update check failed: the downloaded package for " + release.tag + " does not match its sha256.");
  }
  return actual;
}

async function downloadReleaseArchive(release, opts = {}) {
  if (typeof opts.downloadRelease === "function") {
    return opts.downloadRelease(release, opts);
  }
  const token = authToken(opts);
  const bundle = release && release.bundle;
  if (bundle && (bundle.apiUrl || bundle.downloadUrl)) {
    const manifest = release.manifest;
    if (!manifest || !(manifest.apiUrl || manifest.downloadUrl)) {
      throw new Error("Update check failed: release " + release.tag + " has no latest.json to verify its package.");
    }
    const body = await downloadAsset(bundle, opts, opts.timeoutMs || 60000);
    verifyArchiveHash(body, await downloadAsset(manifest, opts, opts.timeoutMs || 15000), release);
    return body;
  }
  // A release with no app bundle has nothing to verify, so its source tarball
  // only installs in feed-file test mode.
  if (release && release.tarballUrl && localPackagesAllowed(opts)) {
    if (fssync.existsSync(release.tarballUrl)) {
      return fs.readFile(release.tarballUrl);
    }
    const headers = {
      Accept: "application/vnd.github+json",
    };
    if (token && isGitHubApiUrl(release.tarballUrl)) headers.Authorization = "Bearer " + token;
    const res = await requestBuffer(release.tarballUrl, { headers, timeoutMs: opts.timeoutMs || 60000 });
    return res.body;
  }
  throw new Error("No update package found on release " + ((release && release.tag) || "") + ".");
}

async function atomicWriteFile(destPath, data) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".tmp-" + randomUUID();
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, destPath);
}

async function applyUpdateArchive(appRoot, dataRoot, gzBuffer, release) {
  if (!gzBuffer || !gzBuffer.length) {
    throw new Error("Downloaded update package is empty.");
  }
  const entries = unpackTarGz(gzBuffer).filter((entry) => isAllowedAppPath(entry.path));
  const pkgEntry = entries.find((entry) => entry.path === "package.json");
  const mainEntry = entries.find((entry) => entry.path === "electron/main.cjs");
  const appEntry = entries.find((entry) => entry.path === "renderer/app.js");
  if (!pkgEntry || !mainEntry || !appEntry) {
    throw new Error("Update package is missing required application files.");
  }
  const targetVersion = normalizeVersion((release && release.version) || "") || "";
  const pkg = JSON.parse(pkgEntry.data.toString("utf8"));
  if (targetVersion) {
    pkg.version = targetVersion;
    pkgEntry.data = Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
  const stageDir = path.join(dataRoot, "updates", "stage-" + randomUUID());
  await fs.mkdir(stageDir, { recursive: true });
  try {
    // Stage every file first so a bad write never touches the live app tree.
    for (const entry of entries) {
      const stagedPath = path.join(stageDir, ...entry.path.split("/"));
      await atomicWriteFile(stagedPath, entry.data);
    }
    for (const entry of entries) {
      const destPath = path.join(appRoot, ...entry.path.split("/"));
      await atomicWriteFile(destPath, entry.data);
    }
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
  return {
    version: normalizeVersion(pkg.version) || targetVersion || "1.0.0",
    filesUpdated: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Stateful Update Manager for main process
// ---------------------------------------------------------------------------

function readPackageVersion(appRoot) {
  try {
    const raw = fssync.readFileSync(path.join(appRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeVersion(parsed.version) || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function createUpdater(options) {
  const appRoot = options.appRoot;
  const dataRoot = options.dataRoot;
  const store = options.store;
  const isBusy = typeof options.isBusy === "function" ? options.isBusy : () => false;
  const onState = typeof options.onState === "function" ? options.onState : () => {};
  const log = typeof options.log === "function" ? options.log : () => {};

  const bootVersion = readPackageVersion(appRoot);
  const persisted = store && typeof store.readUpdatePrefs === "function" ? store.readUpdatePrefs() : {};
  const diskVersion = readPackageVersion(appRoot);

  // An installed app carries install.json next to its Electron runtime; a
  // source checkout does not. Installed builds ping GitHub Releases on their
  // own; a dev checkout does not. Applying a release is always a Download
  // press, so there is nothing to disable and nothing installs silently.
  const install = options.installInfo || describeInstall(appRoot);
  const autoCheckDefault = install.autoCheckDefault !== false;
  const resolveToken =
    typeof options.resolveDeveloperToken === "function" ? options.resolveDeveloperToken : resolveDeveloperToken;
  const developerMode = Boolean(persisted.developerMode);
  // Which channel the running app tree came from. A database from before this
  // was tracked takes the channel it was on, so nothing is offered by surprise.
  const installedChannel =
    persisted.installedChannel === "developer" || persisted.installedChannel === "public"
      ? persisted.installedChannel
      : developerMode
        ? "developer"
        : "public";

  const state = {
    developerMode,
    installedChannel,
    repo: developerMode ? DEV_REPO : DEFAULT_REPO,
    installMode: install.installed ? "installed" : "development",
    ownerMachine: Boolean(install.owner),
    installDir: install.installDir || "",
    bootVersion,
    currentVersion: diskVersion || persisted.installedVersion || bootVersion,
    currentTag: formatTag(diskVersion || persisted.installedVersion || bootVersion),
    selectedTag: persisted.selectedTag || "",
    status: "idle", // idle | checking | available | downloading | installing | installed | up-to-date | error
    error: "",
    message: "",
    needsRestart: false,
    lastCheckedAt: persisted.lastCheckedAt || "",
    lastUpdatedAt: persisted.lastUpdatedAt || "",
    releases: normalizeReleaseList(persisted.releases || []),
  };

  // Ensure selectedTag points to a valid release or the latest one.
  function syncSelectedTag() {
    if (!state.releases.length) {
      if (!state.selectedTag) state.selectedTag = state.currentTag;
      return;
    }
    const latest = state.releases[0];
    if (!state.selectedTag || !state.releases.some((r) => r.tag === state.selectedTag)) {
      state.selectedTag = latest.tag;
    }
  }
  syncSelectedTag();

  function saveToStore() {
    if (!store || typeof store.writeUpdatePrefs !== "function") return;
    try {
      store.writeUpdatePrefs({
        developerMode: state.developerMode,
        installedChannel: state.installedChannel,
        installedVersion: state.currentVersion,
        installedTag: state.currentTag,
        selectedTag: state.selectedTag,
        lastCheckedAt: state.lastCheckedAt,
        lastUpdatedAt: state.lastUpdatedAt,
        releases: state.releases,
      });
    } catch {
      /* store may be closed during shutdown */
    }
  }

  function snapshot() {
    const latest = state.releases[0] || null;
    const selected =
      state.releases.find((r) => r.tag === state.selectedTag) ||
      latest || {
        id: state.currentTag,
        tag: state.currentTag,
        version: state.currentVersion,
        name: state.currentTag,
        publishedAt: "",
        prerelease: false,
      };
    const installed = state.installMode === "installed";
    const hasNewerLatest = Boolean(installed && latest && compareVersions(latest.version, state.currentVersion) > 0);
    // On the other channel, its newest release is offered whatever its
    // version, so a copy can move between public and developer builds.
    const switchAvailable = Boolean(installed && latest && state.installedChannel !== channelName());
    const selectedDiff = selected ? compareVersions(selected.version, state.currentVersion) : 0;
    return {
      repo: state.repo,
      developerMode: state.developerMode,
      channel: channelName(),
      installedChannel: state.installedChannel,
      switchAvailable,
      installMode: state.installMode,
      ownerMachine: state.ownerMachine,
      installDir: state.installDir,
      autoCheck: autoCheckDefault,
      bootVersion: state.bootVersion,
      currentVersion: state.currentVersion,
      currentTag: state.currentTag,
      latestVersion: latest ? latest.version : state.currentVersion,
      latestTag: latest ? latest.tag : state.currentTag,
      selectedTag: selected ? selected.tag : state.currentTag,
      selectedVersion: selected ? selected.version : state.currentVersion,
      selectedDiff, // >0 upgrade, <0 downgrade, 0 same version
      updateAvailable: hasNewerLatest || switchAvailable,
      status: state.status,
      error: state.error,
      message: state.message,
      needsRestart: state.needsRestart,
      lastCheckedAt: state.lastCheckedAt,
      lastUpdatedAt: state.lastUpdatedAt,
      releases: state.releases.map((r) => ({
        tag: r.tag,
        version: r.version,
        name: r.name,
        publishedAt: r.publishedAt,
        prerelease: r.prerelease,
        isCurrent: r.version === state.currentVersion,
        isLatest: Boolean(latest && r.tag === latest.tag),
      })),
    };
  }

  function emit() {
    const snap = snapshot();
    onState(snap);
    return snap;
  }

  function channelName() {
    return state.developerMode ? "developer" : "public";
  }

  // Before any release touches the app, the database is copied to
  // data/backups. The name says which build it came from and which one was
  // installed, so switching back can always start from that copy. If the copy
  // fails, nothing is installed.
  function backupBeforeInstall(target) {
    if (!store || typeof store.snapshotDb !== "function") return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name =
      "recorder-" + stamp + "-" + state.installedChannel + "-" + state.currentTag + "-to-" + channelName() + "-" + target.tag + ".db";
    try {
      return store.snapshotDb(path.join(dataRoot, "backups", name));
    } catch (error) {
      throw new Error(
        "Could not save a copy of your data before updating, so nothing was installed. " +
          String((error && error.message) || error),
      );
    }
  }

  let checkInflight = null;
  let installInflight = null;

  // What a request may carry. The public channel is anonymous no matter what
  // the caller passed; the developer channel adds the developer's sign-in.
  async function channelOpts(extra) {
    const out = { ...options, ...(extra || {}) };
    delete out.token;
    if (!state.developerMode) return out;
    const token = await resolveToken();
    if (!token) {
      const error = new Error(
        "Developer mode updates need a GitHub sign-in (gh auth login) with access to the private development repo. Turn Developer mode updates off to get public releases.",
      );
      error.code = "NO_DEVELOPER_SIGN_IN";
      throw error;
    }
    out.token = token;
    return out;
  }

  async function checkForUpdates(checkOpts = {}) {
    if (checkInflight) return checkInflight;
    if (installInflight) return snapshot();
    // A background check (boot / poll) runs on an installed build so the
    // release list stays live without any button press; a dev checkout never
    // pings GitHub on its own.
    if (checkOpts.auto === true && !autoCheckDefault) return snapshot();
    checkInflight = (async () => {
      const prevSelected = state.selectedTag;
      const wasOnLatest = !state.releases.length || prevSelected === state.releases[0].tag;
      state.status = "checking";
      state.error = "";
      state.message = "Checking GitHub Releases…";
      emit();
      try {
        const repo = state.repo;
        const releases = await fetchGitHubReleases(repo, await channelOpts(checkOpts));
        // The channel changed while this check was out: its list is stale.
        if (repo !== state.repo) return snapshot();
        state.releases = releases;
        state.lastCheckedAt = new Date().toISOString();
        const latest = releases[0] || null;
        if (latest) {
          if (wasOnLatest || !releases.some((r) => r.tag === prevSelected)) {
            state.selectedTag = latest.tag;
          }
          if (snapshot().switchAvailable) {
            state.status = "available";
            state.message =
              (state.developerMode ? "Developer build " : "Public release ") +
              latest.tag +
              " is available. Installing it moves this copy to " +
              (state.developerMode ? "developer builds." : "public releases.");
          } else if (compareVersions(latest.version, state.currentVersion) > 0) {
            state.status = "available";
            state.message = "Release " + latest.tag + " is available on GitHub.";
          } else {
            state.status = state.needsRestart ? "installed" : "up-to-date";
            state.message = state.needsRestart
              ? "Updated to " + state.currentTag + ". Restart to load the new build."
              : "Up to date on " + state.currentTag + ".";
          }
        } else {
          state.status = "up-to-date";
          state.message = "No releases published yet.";
        }
        saveToStore();
        emit();
        log("update check ok", (latest && latest.tag) || "none");
        return snapshot();
      } catch (error) {
        state.status = "error";
        state.error =
          error && error.status === 404
            ? state.developerMode
              ? "This GitHub sign-in cannot see the private development repo."
              : "Could not reach GitHub Releases for " + state.repo + "."
            : String((error && error.message) || "Could not check GitHub Releases.");
        state.message = state.error;
        log("update check failed", state.error);
        return emit();
      } finally {
        checkInflight = null;
      }
    })();
    return checkInflight;
  }

  async function installRelease(installOpts = {}) {
    if (installInflight) return installInflight;
    if (isBusy()) {
      state.error = "Stop the current recording before updating.";
      state.message = state.error;
      return emit();
    }
    if (state.installMode !== "installed") {
      state.error = "This is a source checkout. Releases never rewrite it.";
      state.message = state.error;
      return emit();
    }
    installInflight = (async () => {
      try {
        if (!state.releases.length) {
          await checkForUpdates();
        }
        const wantedTag = String((installOpts && installOpts.tag) || state.selectedTag || "").trim();
        const target =
          state.releases.find((r) => r.tag === wantedTag || r.version === normalizeVersion(wantedTag)) ||
          state.releases[0] ||
          null;
        if (!target) {
          state.status = "error";
          state.error = "No GitHub release found to install.";
          state.message = state.error;
          return emit();
        }
        state.selectedTag = target.tag;
        state.status = "downloading";
        state.error = "";
        state.message = "Downloading " + target.tag + " from GitHub…";
        emit();

        const toChannel = channelName();
        const gzBuffer = await downloadReleaseArchive(target, await channelOpts());
        state.status = "installing";
        state.message = "Installing " + target.tag + "…";
        emit();

        const backup = backupBeforeInstall(target);
        if (backup) log("update data backup", backup.file + " (" + backup.size + " bytes)");
        const applied = await applyUpdateArchive(appRoot, dataRoot, gzBuffer, target);
        // Keep the install manifest's version in step with the app tree, and
        // the Add-or-Remove-Programs entry with both. A portable setup-zip
        // install records no installDir; the manifest lives two levels above
        // the app root, so use its own folder.
        const installDir =
          install.installDir ||
          (install.manifest && install.manifest.manifestFile ? path.dirname(install.manifest.manifestFile) : "");
        if (install.installed && installDir) {
          try {
            const current = readManifest(installDir);
            if (current) {
              const next = makeManifest(Object.assign({}, current, { version: applied.version }));
              await fs.writeFile(manifestPath(installDir), JSON.stringify(next, null, 2) + "\n", "utf8");
            }
          } catch {
            /* a missing manifest must not fail the update */
          }
          try {
            setRegistryDisplayVersion(applied.version);
          } catch {
            /* a locked or absent registry entry must not fail the update */
          }
        }
        state.currentVersion = applied.version;
        state.currentTag = formatTag(applied.version);
        state.installedChannel = toChannel;
        state.selectedTag = target.tag;
        state.lastUpdatedAt = new Date().toISOString();
        // The app tree changed (a channel switch can keep the same version
        // number), so the running build is always stale now.
        state.needsRestart = true;
        state.status = "installed";
        state.error = "";
        state.message = "Installed " + state.currentTag + " from GitHub.";
        saveToStore();
        log("update installed", state.currentTag + " (" + applied.filesUpdated + " files)");
        return emit();
      } catch (error) {
        state.status = "error";
        state.error = String((error && error.message) || "Could not install update.");
        state.message = state.error;
        log("update install failed", state.error);
        return emit();
      } finally {
        installInflight = null;
      }
    })();
    return installInflight;
  }

  // Developer mode updates switch the release source between the public repo
  // and the private development repo. The old channel's list is dropped and
  // the new one is checked right away.
  async function setDeveloperMode(enabled) {
    const next = Boolean(enabled);
    if (installInflight) return snapshot();
    if (next !== state.developerMode) {
      state.developerMode = next;
      state.repo = next ? DEV_REPO : DEFAULT_REPO;
      state.releases = [];
      state.selectedTag = state.currentTag;
      state.status = "idle";
      state.error = "";
      state.message = "";
      saveToStore();
      emit();
      log("update channel", next ? "developer" : "public");
    }
    if (checkInflight) await checkInflight.catch(() => {});
    return checkForUpdates();
  }

  return {
    getStatus: snapshot,
    checkForUpdates,
    installRelease,
    setDeveloperMode,
  };
}

module.exports = {
  DEFAULT_REPO,
  DEV_REPO,
  normalizeVersion,
  formatTag,
  compareVersions,
  normalizeRelease,
  normalizeReleaseList,
  packTarGz,
  unpackTarGz,
  isAllowedAppPath,
  createUpdateBundle,
  applyUpdateArchive,
  fetchGitHubReleases,
  downloadReleaseArchive,
  verifyArchiveHash,
  createUpdater,
};
