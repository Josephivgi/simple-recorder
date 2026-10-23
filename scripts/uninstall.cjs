"use strict";

// Uninstall Simple Recorder.
//
//   node scripts/uninstall.cjs            ask, then remove the app (keeps your recordings)
//   node scripts/uninstall.cjs --yes      no prompt
//   node scripts/uninstall.cjs --quiet    no prompt, no output (what Add or Remove Programs uses)
//   node scripts/uninstall.cjs --purge-data   also delete %APPDATA%\Simple Recorder
//
// The recordings library under Videos\Simple recorder is never touched unless
// --purge-data is passed (and even then only the app data folder is removed).
//
// The uninstaller runs inside the installed Electron executable (as plain
// Node via ELECTRON_RUN_AS_NODE), so Windows keeps a lock on that .exe until
// this process exits. The folder is therefore deleted afterwards by a
// detached cmd.exe that waits for the lock to clear.

// Under Electron's fs, default_app.asar would read as a folder.
process.noAsar = true;

const fs = require("fs/promises");
const fssync = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");
const { APP_NAME, UNINSTALL_KEY, MANIFEST_NAME } = require("../lib/install-layout");

const PS1_REMOVE_SHORTCUTS = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$name = $env:SR_NAME",
  "$targets = @()",
  "$programs = [Environment]::GetFolderPath('Programs')",
  "if ($programs) { $targets += (Join-Path $programs ($name + '.lnk')) }",
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "if ($desktop) { $targets += (Join-Path $desktop ($name + '.lnk')) }",
  "foreach ($t in $targets) { if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force; Write-Output $t } }",
  "",
].join("\r\n");

function parseArgs(argv) {
  const out = {
    yes: false,
    quiet: false,
    purgeData: false,
    json: false,
    keepFiles: false,
    shortcuts: true,
    registry: true,
    dir: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--quiet") out.quiet = true;
    else if (arg === "--purge-data") out.purgeData = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--keep-files") out.keepFiles = true;
    else if (arg === "--no-shortcuts") out.shortcuts = false;
    else if (arg === "--no-registry") out.registry = false;
    else if (arg === "--dir" && argv[i + 1]) out.dir = path.resolve(argv[++i]);
  }
  if (out.quiet) out.yes = true;
  return out;
}

// The uninstaller lives at <installDir>\resources\app\scripts\uninstall.cjs.
function installDirFor(dirOverride) {
  if (dirOverride) return dirOverride;
  return path.resolve(__dirname, "..", "..", "..");
}

// Never rmdir a folder that is not ours: it must carry the install manifest
// or the packaged app tree.
function looksLikeInstall(dir) {
  if (fssync.existsSync(path.join(dir, MANIFEST_NAME))) return true;
  return fssync.existsSync(path.join(dir, "resources", "app", "package.json"));
}

function removeShortcuts() {
  const scriptFile = path.join(os.tmpdir(), "sr-uninstall-shortcuts-" + process.pid + ".ps1");
  fssync.writeFileSync(scriptFile, PS1_REMOVE_SHORTCUTS, "utf8");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
      {
        timeout: 30000,
        encoding: "utf8",
        windowsHide: true,
        env: Object.assign({}, process.env, { SR_NAME: APP_NAME }),
      },
    );
    return String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    fssync.rmSync(scriptFile, { force: true });
  }
}

function removeRegistry() {
  try {
    execFileSync("reg.exe", ["delete", "HKCU\\" + UNINSTALL_KEY, "/f"], {
      timeout: 15000,
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// The running exe is locked, so the folder is deleted by a process that
// outlives this one. Windows (often the virus scanner) can hold the exe for
// minutes after this process ends, so it tries every 2 seconds for up to 10
// minutes until the folder is gone.
//
// It is a hidden PowerShell started through WMI (Win32_Process.Create):
// - a normal child is in Node's kill-on-exit job and dies with this process;
// - a detached child has no console, and Windows PowerShell then exits
//   without running, while a detached cmd.exe opens a window for every
//   console program it starts (the old ping delay flashed one each time).
// WMI starts it outside the job, with its own console, window hidden. The
// loop goes in -EncodedCommand so no folder name can break its quoting. It
// runs from the temp folder, never from inside the folder it deletes.
function scheduleFolderRemoval(dir) {
  const quoted = "'" + dir.split("'").join("''") + "'";
  const loop =
    "for ($i = 0; $i -lt 300 -and (Test-Path -LiteralPath " + quoted + "); $i++) { Start-Sleep -Seconds 2; " +
    "Remove-Item -LiteralPath " + quoted + " -Recurse -Force -ErrorAction SilentlyContinue }";
  const encoded = Buffer.from(loop, "utf16le").toString("base64");
  const launch =
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; " +
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = " +
    "'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded + "'; " +
    "CurrentDirectory = $env:TEMP; ProcessStartupInformation = $si }; exit $r.ReturnValue";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launch], {
      cwd: os.tmpdir(),
      timeout: 30000,
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function appDataDir() {
  if (process.env.REC_USER_DATA) return path.resolve(process.env.REC_USER_DATA);
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, APP_NAME);
}

function ask(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || "").trim()));
    });
  });
}

async function uninstall(args) {
  const installDir = installDirFor(args.dir);
  const result = {
    ok: false,
    installDir,
    confirm: args.yes,
    removed: false,
    removedShortcuts: [],
    removedRegistry: false,
    removedAppData: "",
    error: "",
  };

  if (!looksLikeInstall(installDir)) {
    result.error = "No Simple Recorder install found at " + installDir + ".";
    return result;
  }

  if (!args.yes) {
    const answer = await ask(
      "Remove " + APP_NAME + " from " + installDir + "?\n" +
        "Your recordings in Videos\\Simple recorder are not touched. [y/N] ",
    );
    if (!answer) {
      result.error = "Cancelled.";
      return result;
    }
    result.confirm = true;
  }

  if (args.shortcuts) result.removedShortcuts = removeShortcuts();
  if (args.registry) result.removedRegistry = removeRegistry();
  if (args.purgeData) {
    const data = await appDataDir();
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
    result.removedAppData = data;
  }
  if (!args.keepFiles) {
    // Straight removal works when the uninstaller runs from somewhere else
    // (a source checkout, a test). The installed launcher holds a lock on its
    // own .exe, so fall back to a cmd.exe that deletes the folder afterwards.
    try {
      await fs.rm(installDir, { recursive: true, force: true });
      result.removed = true;
    } catch {
      scheduleFolderRemoval(installDir);
      result.removed = false;
    }
  }
  result.ok = true;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await uninstall(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (!args.quiet) {
    if (!result.ok) process.stdout.write(result.error + "\n");
    else {
      process.stdout.write("Removed " + APP_NAME + " from " + result.installDir + ".\n");
      for (const shortcut of result.removedShortcuts) process.stdout.write("  removed shortcut: " + shortcut + "\n");
      if (result.removedRegistry) process.stdout.write("  removed uninstall entry\n");
      if (result.removedAppData) process.stdout.write("  removed app data: " + result.removedAppData + "\n");
      process.stdout.write("Your recordings under Videos\\Simple recorder were left alone.\n");
    }
  }
  if (!result.ok && !args.quiet) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String((error && (error.stack || error.message)) || error) + "\n");
    process.exit(1);
  });
}

module.exports = { parseArgs, uninstall, installDirFor, looksLikeInstall };
