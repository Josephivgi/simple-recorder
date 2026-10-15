"use strict";

// Verify an installed Simple Recorder: the folder layout, the install
// manifest, and a real hidden boot of the installed launcher.
//
//   node scripts/verify-install.cjs            check %LOCALAPPDATA%\Programs\Simple Recorder
//   node scripts/verify-install.cjs --dir "D:\Apps\Simple Recorder"
//   node scripts/verify-install.cjs --json
//
// The boot uses REC_USER_DATA so the check never touches the real app data.

const fs = require("fs");
const fssync = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { APP_NAME, MANIFEST_NAME, defaultInstallDir, readManifest, packagedAppRoot } = require("../lib/install-layout");

function parseArgs(argv) {
  const out = { dir: "", json: false, timeoutMs: 90000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir" && argv[i + 1]) out.dir = path.resolve(argv[++i]);
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--timeout" && argv[i + 1]) out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
  }
  return out;
}

function check(checks, name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail == null ? "" : String(detail) });
}

function verify(args) {
  const installDir = path.resolve(args.dir || defaultInstallDir(process.env));
  const appRoot = packagedAppRoot(installDir);
  const exe = path.join(installDir, "Simple Recorder.exe");
  const checks = [];
  const result = { ok: false, installDir, appRoot, exe, version: "", manifest: null, smoke: null, checks, error: "" };

  check(checks, "install folder", fssync.existsSync(installDir), installDir);
  check(checks, "launcher exe", fssync.existsSync(exe), exe);
  check(checks, "app tree", fssync.existsSync(path.join(appRoot, "electron", "main.cjs")), appRoot);
  // Read the panel out of the shipped page rather than a smoke field: the
  // probe names are an internal detail and must not decide this check.
  const indexFile = path.join(appRoot, "renderer", "index.html");
  let indexHtml = "";
  try {
    indexHtml = fssync.readFileSync(indexFile, "utf8");
  } catch {
    indexHtml = "";
  }
  check(
    checks,
    "updates panel ships as a status line plus a Download button",
    /data-update-summary/.test(indexHtml) &&
      /data-update-download/.test(indexHtml) &&
      !/data-update-(auto|picker|btn|check|relaunch)/.test(indexHtml),
    indexFile,
  );

  const manifest = readManifest(installDir);
  result.manifest = manifest;
  check(checks, "install manifest", Boolean(manifest), path.join(installDir, MANIFEST_NAME));
  if (manifest) {
    result.version = manifest.version;
    check(checks, "manifest install dir", path.resolve(manifest.installDir) === installDir, manifest.installDir);
  }

  if (checks.some((item) => !item.ok)) {
    result.error = "Install folder is incomplete.";
    return result;
  }

  const scratch = fssync.mkdtempSync(path.join(os.tmpdir(), "sr-verify-"));
  const videos = fs.mkdtempSync(path.join(os.tmpdir(), "sr-verify-videos-"));
  try {
    const childEnv = Object.assign({}, process.env, {
      REC_USER_DATA: scratch,
      REC_VIDEOS: videos,
      REC_DISABLE_AUTO_CHECK: "1",
    });
    // Electron must start as Electron, not as plain Node, or `protocol` is
    // undefined at boot.
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(exe, ["--smoke"], {
      cwd: installDir,
      timeout: args.timeoutMs,
      encoding: "utf8",
      windowsHide: true,
      env: childEnv,
    });
    const stdout = String(run.stdout || "");
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith("SMOKE "));
    if (!line) {
      result.error = "The installed launcher did not report a smoke result.";
      check(checks, "hidden boot", false, (String(run.stderr || "") || stdout).slice(0, 600));
      return result;
    }
    const smoke = JSON.parse(line.slice("SMOKE ".length));
    result.smoke = smoke;
    check(checks, "hidden boot", smoke.ok === true, smoke.error || "");
    check(checks, "preload bridge", smoke.info && smoke.info.hasApi === true, "");
    check(checks, "install mode", smoke.update && smoke.update.installMode === "installed", smoke.update && smoke.update.installMode);
    check(checks, "install dir reported", smoke.update && path.resolve(smoke.update.installDir || ".") === installDir, smoke.update && smoke.update.installDir);
    if (manifest) {
      check(checks, "version matches manifest", smoke.update && smoke.update.currentTag === "v" + manifest.version, smoke.update && smoke.update.currentTag);
      // Every installed copy pings GitHub Releases on its own; the Download
      // press is the only step a person takes.
      check(
        checks,
        "release channel",
        smoke.update && smoke.update.autoCheck === true,
        "autoCheck=" + (smoke.update && smoke.update.autoCheck),
      );
    }
  } catch (error) {
    result.error = String((error && error.message) || error);
    check(checks, "hidden boot", false, result.error);
  } finally {
    fssync.rmSync(scratch, { recursive: true, force: true });
    fssync.rmSync(videos, { recursive: true, force: true });
  }

  result.ok = checks.every((item) => item.ok);
  if (!result.ok && !result.error) result.error = "One or more checks failed.";
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verify(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write("Verifying " + APP_NAME + " at " + result.installDir + "\n");
    for (const item of result.checks) {
      process.stdout.write("  " + (item.ok ? "OK  " : "FAIL") + " " + item.name + (item.detail ? " - " + item.detail : "") + "\n");
    }
    process.stdout.write(result.ok ? "Installed app verified.\n" : "Verification failed: " + result.error + "\n");
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { parseArgs, verify };
