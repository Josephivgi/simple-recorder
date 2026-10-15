"use strict";

// Install layout for Simple Recorder on Windows.
//
// A "portable install" is a self-contained folder that needs no admin rights:
//
//   <installDir>\Simple Recorder.exe        the Electron runtime, renamed
//   <installDir>\install.json               the install manifest
//   <installDir>\Uninstall Simple Recorder.cmd
//   <installDir>\resources\app\...          the application tree the updater rewrites
//
// Start Menu / Desktop shortcuts and the HKCU Add-or-Remove-Programs entry all
// point back at that folder, and the updater keeps writing into
// `<installDir>\resources\app` because `electron/main.cjs` resolves its app
// root from `__dirname/..`.
//
// `install.json` also carries an informational developer label, set only by
// `install.cjs --owner`; the installer never asks GitHub who is installing. A
// plain source checkout (no manifest) never joins the release channel, while
// every real install auto-checks and auto-updates by default.

const fssync = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_ID = "SimpleRecorder";
const APP_NAME = "Simple Recorder";
const EXE_NAME = "Simple Recorder.exe";
const UNINSTALL_CMD_NAME = "Uninstall Simple Recorder.cmd";
const MANIFEST_NAME = "install.json";
const REPO = "Josephivgi/simple-recorder";

// resources/app relative to the install folder.
const APP_DIR_REL = path.join("resources", "app");
// The registry key under HKCU that Add or Remove Programs reads.
const UNINSTALL_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + APP_ID;
// The app files the updater is allowed to rewrite, mirroring lib/updater.js.
const APP_FILES = ["package.json", "AGENTS.md"];
const APP_DIRS = ["electron", "lib", "renderer", "scripts", "assets"];

function defaultInstallDir(env) {
  const base = (env && (env.LOCALAPPDATA || env.APPDATA)) || os.homedir();
  return path.join(base, "Programs", APP_NAME);
}

function manifestPath(installDir) {
  return path.join(installDir, MANIFEST_NAME);
}

function packagedAppRoot(installDir) {
  return path.join(installDir, APP_DIR_REL);
}

function exePath(installDir) {
  return path.join(installDir, EXE_NAME);
}

// The installed .ico: shortcuts, the Add-or-Remove-Programs entry, and the
// launcher's own resources all want a file, not a picture in memory.
function appIconFile(installDir) {
  const file = path.join(packagedAppRoot(installDir), "assets", "icon.ico");
  return fssync.existsSync(file) ? file : "";
}

function uninstallCmdPath(installDir) {
  return path.join(installDir, UNINSTALL_CMD_NAME);
}

function makeManifest(input) {
  const opts = input || {};
  return {
    app: "simple-recorder",
    name: APP_NAME,
    version: String(opts.version || "0.0.0"),
    installDir: path.resolve(String(opts.installDir || "")),
    owner: Boolean(opts.owner),
    repo: String(opts.repo || REPO),
    electronVersion: String(opts.electronVersion || ""),
    source: String(opts.source || ""),
    installedAt: String(opts.installedAt || new Date().toISOString()),
  };
}

function readManifest(installDir) {
  try {
    const parsed = JSON.parse(fssync.readFileSync(manifestPath(installDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.app !== "simple-recorder") return null;
    return parsed;
  } catch {
    return null;
  }
}

// The updater writes into `<installDir>\resources\app`, so a live install
// carries its manifest two levels up. A source checkout has none.
function findInstallManifest(appRoot) {
  const candidates = [
    path.join(appRoot, "..", "..", MANIFEST_NAME),
    path.join(appRoot, MANIFEST_NAME),
  ];
  for (const file of candidates) {
    let parsed = null;
    try {
      parsed = JSON.parse(fssync.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && parsed.app === "simple-recorder") {
      return Object.assign({}, parsed, { manifestFile: path.resolve(file) });
    }
  }
  return null;
}

// A source checkout (no install.json) is the dev tree: it never runs
// background checks and never gets rewritten by the release channel. Every
// real install pings GitHub Releases on its own; applying a release is always
// a Download press. The owner flag only labels who installed it.
function describeInstall(appRoot, opts) {
  const options = opts || {};
  const manifest = options.manifest !== undefined ? options.manifest : findInstallManifest(appRoot);
  if (!manifest) {
    return {
      installed: false,
      owner: true,
      installDir: "",
      version: "",
      manifest: null,
      autoCheckDefault: false,
    };
  }
  const owner = Boolean(manifest.owner);
  return {
    installed: true,
    owner,
    installDir: String(manifest.installDir || ""),
    version: String(manifest.version || ""),
    manifest,
    autoCheckDefault: true,
  };
}

// ---- copying helpers used by scripts/install.cjs -------------------------

function shouldSkipRel(relPath, skipNames) {
  const parts = String(relPath).split(/[\\/]/).filter(Boolean);
  return parts.some((part) => skipNames.has(part));
}

async function copyTree(srcDir, destDir, opts) {
  const options = opts || {};
  const fs = require("fs/promises");
  const skip = new Set(options.skip || []);
  let files = 0;
  let bytes = 0;
  const walk = async (rel) => {
    const absSrc = rel ? path.join(srcDir, rel) : srcDir;
    const absDest = rel ? path.join(destDir, rel) : destDir;
    const items = await fs.readdir(absSrc, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    await fs.mkdir(absDest, { recursive: true });
    for (const item of items) {
      const childRel = rel ? path.join(rel, item.name) : item.name;
      if (shouldSkipRel(childRel, skip)) continue;
      if (item.isDirectory()) {
        await walk(childRel);
      } else if (item.isFile()) {
        const data = await fs.readFile(path.join(absSrc, item.name));
        await fs.writeFile(path.join(absDest, item.name), data);
        files += 1;
        bytes += data.length;
      }
    }
  };
  await walk("");
  return { files, bytes };
}

// ---- Windows uninstall entry -------------------------------------------
// Add or Remove Programs reads DisplayVersion from the registry, so an
// in-app update has to keep that value in step with the files it replaced.
// Only touched when the entry already exists: the installer is the thing that
// creates it (and a `--no-registry` install never gets one).

function hasUninstallEntry() {
  try {
    execFileSync("reg.exe", ["query", "HKCU\\" + UNINSTALL_KEY], {
      timeout: 10000,
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function setRegistryDisplayVersion(version) {
  if (!hasUninstallEntry()) return false;
  try {
    execFileSync(
      "reg.exe",
      [
        "add",
        "HKCU\\" + UNINSTALL_KEY,
        "/v",
        "DisplayVersion",
        "/t",
        "REG_SZ",
        "/d",
        String(version || ""),
        "/f",
      ],
      { timeout: 15000, windowsHide: true, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  APP_ID,
  APP_NAME,
  EXE_NAME,
  UNINSTALL_CMD_NAME,
  MANIFEST_NAME,
  REPO,
  APP_DIR_REL,
  UNINSTALL_KEY,
  APP_FILES,
  APP_DIRS,
  defaultInstallDir,
  manifestPath,
  packagedAppRoot,
  exePath,
  appIconFile,
  uninstallCmdPath,
  makeManifest,
  readManifest,
  findInstallManifest,
  describeInstall,
  hasUninstallEntry,
  setRegistryDisplayVersion,
  copyTree,
};
