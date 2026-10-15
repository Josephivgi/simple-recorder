"use strict";

// Install Simple Recorder as a real Windows app.
//
//   node scripts/install.cjs                 install to %LOCALAPPDATA%\Programs\Simple Recorder
//   node scripts/install.cjs --dir "D:\Apps\Simple Recorder"
//   node scripts/install.cjs --owner         label this install as a developer's (informational)
//   node scripts/install.cjs --no-shortcuts --no-registry
//   node scripts/install.cjs --json          machine-readable result (used by tests)
//   node scripts/install.cjs --portable "<unpacked Simple Recorder>"
//                                            install from an unpacked layout (what
//                                            SimpleRecorder-Setup.exe runs)
//
// What it does:
//   1. copies the bundled Electron runtime into the install folder and renames
//      electron.exe to "Simple Recorder.exe";
//   2. copies the application tree into resources\app, which is exactly where
//      electron/main.cjs and the GitHub Releases updater expect to live;
//   3. writes install.json (version, install dir, owner marker);
//   4. writes "Uninstall Simple Recorder.cmd";
//   5. adds Start Menu and Desktop shortcuts and an HKCU Add-or-Remove-Programs
//      entry. No admin rights are required - everything is per user.

// Run by the bundled Electron (ELECTRON_RUN_AS_NODE), fs would open
// resources\default_app.asar as a folder and the copy would fail.
process.noAsar = true;

const fs = require("fs/promises");
const fssync = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  APP_NAME,
  EXE_NAME,
  UNINSTALL_CMD_NAME,
  MANIFEST_NAME,
  APP_FILES,
  APP_DIRS,
  UNINSTALL_KEY,
  REPO,
  defaultInstallDir,
  manifestPath,
  packagedAppRoot,
  exePath,
  uninstallCmdPath,
  makeManifest,
  readManifest,
  copyTree,
  appIconFile,
} = require("../lib/install-layout");
const { applyIcon } = require("../lib/icon-resource.cjs");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {
    dir: "",
    runtime: "",
    version: "",
    owner: false,
    shortcuts: true,
    registry: true,
    icon: true,
    dryRun: false,
    json: false,
    quiet: false,
    portable: "",
    source: ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir" && argv[i + 1]) out.dir = argv[++i];
    else if (arg === "--portable" && argv[i + 1]) out.portable = path.resolve(argv[++i]);
    else if (arg === "--runtime" && argv[i + 1]) out.runtime = argv[++i];
    else if (arg === "--source" && argv[i + 1]) out.source = path.resolve(argv[++i]);
    else if (arg === "--version" && argv[i + 1]) out.version = argv[++i];
    else if (arg === "--owner") out.owner = true;
    else if (arg === "--no-owner") out.owner = false;
    else if (arg === "--no-shortcuts") out.shortcuts = false;
    else if (arg === "--no-registry") out.registry = false;
    else if (arg === "--no-icon") out.icon = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--quiet") out.quiet = true;
  }
  return out;
}

function repoOwner() {
  const slug = REPO.split("/")[0] || "";
  return slug;
}

function runtimeDir(args) {
  if (args.portable) return args.portable;
  if (args.runtime) return path.resolve(args.runtime);
  return path.join(args.source, "node_modules", "electron", "dist");
}

function hasRuntime(dir) {
  return fssync.existsSync(path.join(dir, "electron.exe")) || fssync.existsSync(path.join(dir, EXE_NAME));
}

function electronVersion(source, portable) {
  if (portable) {
    const manifest = readManifest(portable);
    return String((manifest && manifest.electronVersion) || "");
  }
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(source, "node_modules", "electron", "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function appVersion(source) {
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(source, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function log(args, line) {
  if (!args.quiet && !args.json) process.stdout.write(line + "\n");
}

const UNINSTALL_TEMPLATE = [
  "@echo off",
  "setlocal",
  "rem Simple Recorder uninstaller. Runs the installed Electron as plain Node.",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0' + EXE_NAME + '" "%~dp0resources\\app\\scripts\\uninstall.cjs" %*',
  "endlocal",
  "",
].join("\r\n");

const PS1_TEMPLATE = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:SR_TARGET",
  "$work = $env:SR_WORK",
  "$name = $env:SR_NAME",
  "$icon = $env:SR_ICON",
  "$ws = New-Object -ComObject WScript.Shell",
  "$destinations = @()",
  "$programs = [Environment]::GetFolderPath('Programs')",
  "if ($programs) { $destinations += (Join-Path $programs ($name + '.lnk')) }",
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "if ($desktop) { $destinations += (Join-Path $desktop ($name + '.lnk')) }",
  "foreach ($dest in $destinations) {",
  "  $sc = $ws.CreateShortcut($dest)",
  "  $sc.TargetPath = $target",
  "  $sc.WorkingDirectory = $work",
  "  if ($icon -and (Test-Path -LiteralPath $icon)) { $sc.IconLocation = ($icon + ',0') }",
  "  else { $sc.IconLocation = ($target + ',0') }",
  "  $sc.Description = $name",
  "  $sc.Save()",
  "  Write-Output $dest",
  "}",
  "",
].join("\r\n");

function createShortcuts(installDir) {
  const scriptFile = path.join(os.tmpdir(), "sr-shortcuts-" + process.pid + ".ps1");
  fssync.writeFileSync(scriptFile, PS1_TEMPLATE, "utf8");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
      {
        timeout: 30000,
        encoding: "utf8",
        windowsHide: true,
        env: Object.assign({}, process.env, {
          SR_TARGET: exePath(installDir),
          SR_WORK: installDir,
          SR_NAME: APP_NAME,
          SR_ICON: appIconFile(installDir),
        }),
      },
    );
    return String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } finally {
    fssync.rmSync(scriptFile, { force: true });
  }
}

function writeRegistry(installDir, version) {
  const key = "HKCU\\" + UNINSTALL_KEY;
  // The icon file when the app carries one, otherwise whatever icon the
  // launcher itself has.
  const icon = appIconFile(installDir) || exePath(installDir);
  const values = [
    ["DisplayName", "REG_SZ", APP_NAME],
    ["DisplayVersion", "REG_SZ", version],
    ["Publisher", "REG_SZ", repoOwner()],
    ["InstallLocation", "REG_SZ", installDir],
    ["DisplayIcon", "REG_SZ", icon + ",0"],
    ["UninstallString", "REG_SZ", 'cmd.exe /c ""' + uninstallCmdPath(installDir) + '""'],
    ["QuietUninstallString", "REG_SZ", 'cmd.exe /c ""' + uninstallCmdPath(installDir) + '" --quiet"'],
    ["NoModify", "REG_DWORD", "1"],
    ["NoRepair", "REG_DWORD", "1"],
  ];
  for (const [name, type, data] of values) {
    execFileSync("reg.exe", ["add", key, "/v", name, "/t", type, "/d", data, "/f"], {
      timeout: 15000,
      windowsHide: true,
      stdio: "ignore",
    });
  }
  return key;
}

// Files that carry a downloaded-from-the-internet mark get stopped by
// SmartScreen on every launch. Clear it on the installed copy.
function unblockTree(dir) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-ChildItem -LiteralPath $env:SR_DIR -Recurse -File | Unblock-File",
    ],
    { timeout: 120000, windowsHide: true, stdio: "ignore", env: Object.assign({}, process.env, { SR_DIR: dir }) },
  );
}

function busyError(error) {
  return new Error(
    "Could not copy files (" + ((error && error.message) || error) + "). " +
      "Close Simple Recorder if it is running and try again.",
  );
}

function removePath(target) {
  if (!target || !fssync.existsSync(target)) return;
  try {
    fssync.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      "Could not remove " + target + " (" + ((error && error.message) || error) + "). " +
        "Close Simple Recorder if it is running and try again.",
    );
  }
}

async function install(args) {
  const portable = args.portable ? path.resolve(args.portable) : "";
  const source = portable ? packagedAppRoot(portable) : path.resolve(args.source);
  const installDir = path.resolve(args.dir || defaultInstallDir(process.env));
  const runtime = runtimeDir(args);
  const appRoot = packagedAppRoot(installDir);

  const result = {
    ok: false,
    installDir,
    appRoot,
    exe: exePath(installDir),
    version: args.version || appVersion(source),
    owner: false,
    shortcuts: [],
    registryKey: "",
    icon: null,
    files: 0,
    bytes: 0,
    dryRun: Boolean(args.dryRun),
    error: "",
  };

  if (!hasRuntime(runtime)) {
    result.error = portable
      ? "No " + EXE_NAME + " in " + portable + ". Download the setup again and rerun it."
      : "No Electron runtime at " + runtime + ". Run `npm install` in " + source + " first, or pass --runtime.";
    return result;
  }
  if (portable && path.resolve(portable).toLowerCase() === installDir.toLowerCase()) {
    result.error = "This folder is already the install folder. Run Simple Recorder from the Start Menu.";
    return result;
  }

  // The repo is public, so the installer never asks GitHub who is installing:
  // the developer label comes only from an explicit --owner.
  const isOwner = args.owner === true;
  result.owner = isOwner;

  if (args.dryRun) {
    result.ok = true;
    return result;
  }

  // A fresh folder, so an upgrade never leaves files from an older build.
  removePath(appRoot);
  await fs.mkdir(appRoot, { recursive: true });

  // An unpacked layout also holds the app tree and its own manifest; the app
  // tree is copied below and the manifest is rewritten.
  const runtimeSkip = portable ? { skip: ["app", MANIFEST_NAME, UNINSTALL_CMD_NAME] } : undefined;
  let runtimeCopy;
  try {
    runtimeCopy = await copyTree(runtime, installDir, runtimeSkip);
  } catch (error) {
    throw busyError(error);
  }
  result.files += runtimeCopy.files;
  result.bytes += runtimeCopy.bytes;

  // Rename the runtime so the app shows up as "Simple Recorder", everywhere.
  const rawExe = path.join(installDir, "electron.exe");
  const finalExe = exePath(installDir);
  if (fssync.existsSync(rawExe) && path.resolve(rawExe) !== path.resolve(finalExe)) {
    fssync.rmSync(finalExe, { force: true });
    fssync.renameSync(rawExe, finalExe);
  }

  for (const topFile of APP_FILES) {
    const abs = path.join(source, topFile);
    if (!fssync.existsSync(abs)) continue;
    const data = await fs.readFile(abs);
    await fs.writeFile(path.join(appRoot, topFile), data);
    result.files += 1;
    result.bytes += data.length;
  }
  for (const dir of APP_DIRS) {
    const abs = path.join(source, dir);
    if (!fssync.existsSync(abs)) continue;
    const copied = await copyTree(abs, path.join(appRoot, dir), { skip: ["node_modules"] });
    result.files += copied.files;
    result.bytes += copied.bytes;
  }

  // The version in the installed package.json is what the updater reports.
  const installedPkgFile = path.join(appRoot, "package.json");
  const installedPkg = JSON.parse(await fs.readFile(installedPkgFile, "utf8"));
  installedPkg.version = result.version;
  await fs.writeFile(installedPkgFile, JSON.stringify(installedPkg, null, 2) + "\n", "utf8");

  // Renaming electron.exe does not rename its icon: Explorer, the taskbar,
  // and any shortcut pointed at the exe all read the picture out of the
  // file. Paint ours in now that assets/ is in place. A failure is reported
  // and never fails the install: the app runs fine with the wrong picture.
  if (args.icon !== false) {
    const iconFile = appIconFile(installDir);
    if (iconFile) {
      result.icon = applyIcon(exePath(installDir), iconFile);
      if (!result.icon.ok) log(args, "The app icon could not be written: " + result.icon.error);
    }
  }

  const manifest = makeManifest({
    version: result.version,
    installDir,
    owner: isOwner,
    electronVersion: electronVersion(source, portable),
    source: portable ? "setup-exe" : source,
  });
  await fs.writeFile(manifestPath(installDir), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.writeFile(uninstallCmdPath(installDir), UNINSTALL_TEMPLATE, "utf8");

  if (args.shortcuts) {
    try {
      result.shortcuts = createShortcuts(installDir);
    } catch (error) {
      log(args, "Shortcuts could not be created: " + ((error && error.message) || error));
    }
  }
  if (args.registry) {
    try {
      result.registryKey = writeRegistry(installDir, result.version);
    } catch (error) {
      log(args, "Uninstall entry could not be written: " + ((error && error.message) || error));
    }
  }

  if (portable) {
    try {
      unblockTree(installDir);
    } catch (error) {
      log(args, "Downloaded-file marks could not be cleared: " + ((error && error.message) || error));
    }
  }

  result.ok = true;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await install(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    if (!result.ok) {
      process.stderr.write("Install failed: " + result.error + "\n");
      process.exit(1);
    }
    process.stdout.write("Installed " + APP_NAME + " " + result.version + " to " + result.installDir + "\n");
    process.stdout.write("  app root:  " + result.appRoot + "\n");
    process.stdout.write("  launcher:  " + result.exe + "\n");
    process.stdout.write(
      "  developer: " + (result.owner ? "yes" : "no") + "\n",
    );
    process.stdout.write("  files:     " + result.files + " (" + result.bytes + " bytes)\n");
    if (args.icon === false) {
      process.stdout.write("  icon:      left alone\n");
    } else if (result.icon) {
      process.stdout.write(
        "  icon:      " +
          (result.icon.ok ? "written (" + result.icon.images + " sizes)" : "not written (" + result.icon.error + ")") +
          "\n",
      );
    }
    for (const shortcut of result.shortcuts) process.stdout.write("  shortcut:  " + shortcut + "\n");
    if (result.registryKey) process.stdout.write("  uninstall: " + result.registryKey + "\n");
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String((error && (error.stack || error.message)) || error) + "\n");
    process.exit(1);
  });
}

module.exports = { parseArgs, install, UNINSTALL_TEMPLATE, PS1_TEMPLATE };
