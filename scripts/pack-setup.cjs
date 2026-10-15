"use strict";

// Build the Windows setup for a GitHub Release: one SimpleRecorder-Setup.exe
// a person downloads and double-clicks. The name never changes, so
// releases/latest/download/SimpleRecorder-Setup.exe always serves the newest
// build. The setup (scripts/installer.nsi) carries the installed layout and
// runs install.cjs --portable on it: %LOCALAPPDATA%\Programs, shortcuts, the
// uninstall entry, then it opens the app. No admin, and the copy joins the
// GitHub Releases update channel like any install.
//
//   node scripts/pack-setup.cjs --version 1.1.9
//
// Needs the Windows Electron runtime (npm install on Windows) and NSIS
// (makensis on PATH, in Program Files, MAKENSIS=<path>, or a portable
// %LOCALAPPDATA%\nsis-* folder). Without them the script reports an error
// instead of shipping a broken setup.

const fs = require("fs/promises");
const fssync = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { install } = require("./install.cjs");
const { normalizeVersion } = require("../lib/updater");
const { APP_NAME } = require("../lib/install-layout");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist-app");
const SETUP_NAME = "SimpleRecorder-Setup.exe";
const NSIS_SCRIPT = path.join(__dirname, "installer.nsi");

function parseArgs(argv) {
  const out = { version: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" && argv[i + 1]) out.version = normalizeVersion(argv[++i]);
    else if (!arg.startsWith("-") && !out.version) out.version = normalizeVersion(arg);
  }
  return out;
}

function appVersion() {
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return normalizeVersion(pkg.version) || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Windows file versions are four numbers: 1.2.3-beta.1 -> 1.2.3.0.
function fileVersion(version) {
  const nums = String(version).split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 4) nums.push(0);
  return nums.slice(0, 4).join(".");
}

function findMakensis(env) {
  const candidates = [];
  if (env.MAKENSIS) candidates.push(env.MAKENSIS);
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "makensis.exe"));
  }
  for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
    if (base) candidates.push(path.join(base, "NSIS", "makensis.exe"));
  }
  if (env.LOCALAPPDATA) {
    try {
      for (const name of fssync.readdirSync(env.LOCALAPPDATA).filter((n) => /^nsis-/i.test(n)).sort().reverse()) {
        candidates.push(path.join(env.LOCALAPPDATA, name, "makensis.exe"));
      }
    } catch {}
  }
  return candidates.find((file) => fssync.existsSync(file)) || "";
}

async function buildSetupExe(version) {
  const makensis = findMakensis(process.env);
  if (!makensis) return { ok: false, error: "makensis (NSIS) not found" };
  const icon = path.join(ROOT, "assets", "icon.ico");
  if (!fssync.existsSync(icon)) {
    return { ok: false, error: "assets/icon.ico is missing (run `npm run icon`)" };
  }
  const setupPath = path.join(DIST_DIR, SETUP_NAME);
  const stageParent = await fs.mkdtemp(path.join(os.tmpdir(), "sr-setup-"));
  const stageDir = path.join(stageParent, APP_NAME);
  try {
    const result = await install({
      source: ROOT,
      dir: stageDir,
      version,
      owner: false,
      shortcuts: false,
      registry: false,
      quiet: true,
      json: true,
    });
    if (!result.ok) {
      return { ok: false, error: result.error || "install staging failed" };
    }
    // The real install dir is decided on the user's machine by install.cjs.
    const manifestFile = path.join(stageDir, "install.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.installDir = "";
    manifest.source = "setup-exe";
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    await fs.mkdir(DIST_DIR, { recursive: true });
    await fs.rm(setupPath, { force: true });
    execFileSync(
      makensis,
      [
        "/V2",
        `/DVERSION=${version}`,
        `/DVIVERSION=${fileVersion(version)}`,
        `/DSTAGE=${stageDir}`,
        `/DOUTFILE=${setupPath}`,
        `/DICON=${icon}`,
        NSIS_SCRIPT,
      ],
      { stdio: "inherit", timeout: 900000, windowsHide: true },
    );
    const stat = fssync.statSync(setupPath);
    return { ok: true, setupPath, setupName: SETUP_NAME, size: stat.size, files: result.files };
  } finally {
    await fs.rm(stageParent, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version || appVersion();
  const result = await buildSetupExe(version);
  if (!result.ok) {
    process.stderr.write("Setup not built: " + result.error + "\n");
    process.exit(1);
  }
  process.stdout.write(`Packed ${result.setupName} (${result.size} bytes)\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String((error && (error.stack || error.message)) || error) + "\n");
    process.exit(1);
  });
}

module.exports = { buildSetupExe, parseArgs, fileVersion, findMakensis, SETUP_NAME };
