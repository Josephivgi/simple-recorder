"use strict";

// Install system tests: the install layout, scripts/install.cjs, and the
// rule that a dev checkout never joins the release channel while every real
// install auto-checks and auto-updates by default.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const updater = require("../lib/updater");
const installLayout = require("../lib/install-layout");
const install = require("../scripts/install.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rec-install-test-"));
}

test("install layout tells a source checkout apart from an install folder", () => {
  const root = tempDir();
  const appRoot = path.join(root, "resources", "app");
  fs.mkdirSync(appRoot, { recursive: true });

  // A source checkout has no install.json: it is the owner's dev tree.
  const dev = installLayout.describeInstall(appRoot);
  assert.equal(dev.installed, false);
  assert.equal(dev.owner, true);
  assert.equal(dev.autoCheckDefault, false);
  assert.equal(dev.autoCheckDefault, false);

  // An owner install is still a real install: it auto-checks and
  // auto-updates; the owner flag only labels who installed it.
  fs.writeFileSync(
    installLayout.manifestPath(root),
    JSON.stringify(installLayout.makeManifest({ version: "1.1.0", installDir: root, owner: true })),
  );
  const owner = installLayout.describeInstall(appRoot);
  assert.equal(owner.installed, true);
  assert.equal(owner.owner, true);
  assert.equal(owner.version, "1.1.0");
  assert.equal(owner.autoCheckDefault, true);
  assert.equal(owner.autoCheckDefault, true);
  assert.equal("ownerLogin" in installLayout.readManifest(root), false);

  // Anybody else's install defaults to automatic updates.
  fs.writeFileSync(
    installLayout.manifestPath(root),
    JSON.stringify(installLayout.makeManifest({ version: "1.1.0", installDir: root, owner: false })),
  );
  const user = installLayout.describeInstall(appRoot);
  assert.equal(user.installed, true);
  assert.equal(user.owner, false);
  assert.equal(user.autoCheckDefault, true);
  assert.equal(user.autoCheckDefault, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("install.cjs lays down a launcher, a manifest, and an uninstaller", async () => {
  const root = tempDir();
  const runtime = path.join(root, "runtime");
  const source = path.join(root, "source");
  const installDir = path.join(root, "installed");

  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "electron.exe"), "fake runtime");
  fs.writeFileSync(path.join(runtime, "icudtl.dat"), "fake data");
  // A nested runtime folder (the real runtime has locales/) must land one
  // level deep, not nested inside its own copy.
  fs.mkdirSync(path.join(runtime, "locales"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "locales", "en-US.pak"), "locale data");
  fs.mkdirSync(path.join(source, "node_modules", "electron"), { recursive: true });
  fs.writeFileSync(path.join(source, "node_modules", "electron", "package.json"), JSON.stringify({ version: "44.4.3" }));
  fs.mkdirSync(path.join(source, "electron"), { recursive: true });
  fs.mkdirSync(path.join(source, "lib"), { recursive: true });
  fs.mkdirSync(path.join(source, "renderer"), { recursive: true });
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.1.0" }));
  fs.writeFileSync(path.join(source, "electron", "main.cjs"), "// main");
  fs.writeFileSync(path.join(source, "lib", "install-layout.js"), "// layout");
  fs.writeFileSync(path.join(source, "renderer", "app.js"), "// app");
  fs.writeFileSync(path.join(source, "scripts", "install.cjs"), "// install");

  const args = install.parseArgs([
    "--dir",
    installDir,
    "--runtime",
    runtime,
    "--source",
    source,
    "--no-shortcuts",
    "--no-registry",
    "--owner",
  ]);
  const result = await install.install(args);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.owner, true);
  assert.equal(result.version, "1.1.0");

  // The runtime was renamed, and the app tree sits where the updater writes.
  assert.equal(fs.existsSync(path.join(installDir, "Simple Recorder.exe")), true);
  assert.equal(fs.existsSync(path.join(installDir, "electron.exe")), false);
  assert.equal(fs.existsSync(path.join(installDir, "resources", "app", "electron", "main.cjs")), true);
  assert.equal(fs.readFileSync(path.join(installDir, "icudtl.dat"), "utf8"), "fake data");
  assert.equal(fs.readFileSync(path.join(installDir, "locales", "en-US.pak"), "utf8"), "locale data");
  assert.equal(fs.existsSync(path.join(installDir, "locales", "locales")), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(installDir, "resources", "app", "package.json"), "utf8")).version,
    "1.1.0",
  );
  // The uninstaller is written and wired to the installed Electron as Node.
  assert.equal(fs.existsSync(path.join(installDir, installLayout.UNINSTALL_CMD_NAME)), true);
  assert.match(
    fs.readFileSync(path.join(installDir, installLayout.UNINSTALL_CMD_NAME), "utf8"),
    /ELECTRON_RUN_AS_NODE=1/,
  );

  const manifest = installLayout.readManifest(installDir);
  assert.equal(manifest.app, "simple-recorder");
  assert.equal(manifest.owner, true);
  assert.equal(manifest.electronVersion, "44.4.3");
  assert.equal(manifest.installDir, path.resolve(installDir));

  // The app itself reads that manifest as an owner install.
  const described = installLayout.describeInstall(installLayout.packagedAppRoot(installDir));
  assert.equal(described.installed, true);
  assert.equal(described.owner, true);
  assert.equal(described.autoCheckDefault, true);

  // Re-running over an existing install replaces it cleanly.
  fs.writeFileSync(path.join(installDir, "resources", "app", "stale.txt"), "old");
  const again = await install.install(args);
  assert.equal(again.ok, true, again.error);
  assert.equal(fs.existsSync(path.join(installDir, "resources", "app", "stale.txt")), false);

  // A missing runtime is reported instead of a half-written folder.
  const missing = await install.install(install.parseArgs(["--dir", path.join(root, "nope"), "--source", source]));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Electron runtime/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("install.cjs marks a plain user install so it pings GitHub Releases", async () => {
  const root = tempDir();
  const runtime = path.join(root, "runtime");
  const source = path.join(root, "source");
  const installDir = path.join(root, "installed");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "electron.exe"), "fake runtime");
  fs.mkdirSync(path.join(source, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.1.0" }));

  const result = await install.install(
    install.parseArgs([
      "--dir",
      installDir,
      "--runtime",
      runtime,
      "--source",
      source,
      "--no-owner",
      "--no-shortcuts",
      "--no-registry",
    ]),
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.owner, false);
  assert.equal(installLayout.describeInstall(installLayout.packagedAppRoot(installDir)).autoCheckDefault, true);

  // With no flag at all the install is a plain user install: the installer
  // assumes the public repo and never asks the GitHub CLI who is installing.
  const plain = install.parseArgs(["--dir", installDir, "--runtime", runtime, "--source", source]);
  assert.equal(plain.owner, false);
  const plainResult = await install.install(Object.assign(plain, { shortcuts: false, registry: false }));
  assert.equal(plainResult.ok, true, plainResult.error);
  assert.equal(plainResult.owner, false);
  assert.equal(installLayout.readManifest(installDir).owner, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("install.cjs --portable installs the layout the setup .exe unpacks", async () => {
  const root = tempDir();
  const portable = path.join(root, "unpacked", "Simple Recorder");
  const installDir = path.join(root, "installed");
  const app = path.join(portable, "resources", "app");
  fs.mkdirSync(path.join(app, "electron"), { recursive: true });
  fs.mkdirSync(path.join(app, "renderer"), { recursive: true });
  fs.writeFileSync(path.join(portable, "Simple Recorder.exe"), "fake runtime");
  fs.writeFileSync(path.join(portable, "resources", "default_app.asar"), "fake asar");
  fs.writeFileSync(path.join(portable, installLayout.UNINSTALL_CMD_NAME), "old uninstaller");
  fs.writeFileSync(
    path.join(portable, "install.json"),
    JSON.stringify(installLayout.makeManifest({ version: "1.2.0", installDir: "", electronVersion: "44.4.3" })),
  );
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.2.0" }));
  fs.writeFileSync(path.join(app, "electron", "main.cjs"), "// main");
  fs.writeFileSync(path.join(app, "renderer", "app.js"), "// app");

  const args = install.parseArgs(["--portable", portable, "--dir", installDir, "--no-owner", "--no-shortcuts", "--no-registry"]);
  const result = await install.install(args);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.version, "1.2.0");
  assert.equal(fs.existsSync(path.join(installDir, "Simple Recorder.exe")), true);
  assert.equal(fs.readFileSync(path.join(installDir, "resources", "default_app.asar"), "utf8"), "fake asar");
  assert.equal(fs.existsSync(path.join(installDir, "resources", "app", "electron", "main.cjs")), true);
  assert.equal(fs.existsSync(path.join(installDir, "resources", "app", "resources")), false);
  assert.match(fs.readFileSync(path.join(installDir, installLayout.UNINSTALL_CMD_NAME), "utf8"), /uninstall\.cjs/);
  const manifest = installLayout.readManifest(installDir);
  assert.equal(manifest.installDir, path.resolve(installDir));
  assert.equal(manifest.electronVersion, "44.4.3");
  assert.equal(manifest.source, "setup-exe");

  // Installing over the unpacked folder itself is refused.
  const self = await install.install(install.parseArgs(["--portable", portable, "--dir", portable]));
  assert.equal(self.ok, false);
  // A layout with no runtime is reported, not half-installed.
  const bare = await install.install(install.parseArgs(["--portable", path.join(root, "nope"), "--dir", installDir]));
  assert.match(bare.error, /Download the setup again/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("the Windows setup is one .exe with a fixed name and a four-part file version", () => {
  const pack = require("../scripts/pack-setup.cjs");
  assert.equal(pack.SETUP_NAME, "SimpleRecorder-Setup.exe");
  assert.equal(pack.fileVersion("1.1.12"), "1.1.12.0");
  assert.equal(pack.fileVersion("2.0.0-beta.3"), "2.0.0.0");
  const nsi = fs.readFileSync(path.join(__dirname, "..", "scripts", "installer.nsi"), "utf8");
  assert.match(nsi, /RequestExecutionLevel user/);
  assert.match(nsi, /install\.cjs" --portable "\$1"/);
  // The setup wears the app's icon, and a stage without it is a clear error
  // rather than a build that fails inside makensis.
  assert.match(nsi, /Icon "\$\{ICON\}"/);
  assert.ok(
    fs.existsSync(path.join(__dirname, "..", "assets", "icon.ico")),
    "the setup has no icon to compile in",
  );
});

test("the installer paints the app icon into the launcher it just copied", () => {
  const installer = require("../scripts/install.cjs");
  const { applyIcon, readIcon } = require("../lib/icon-resource.cjs");
  const root = path.join(__dirname, "..");

  // --no-icon leaves the launcher alone for a check that does not want to
  // touch resources.
  assert.equal(installer.parseArgs(["--no-icon"]).icon, false);
  assert.equal(installer.parseArgs([]).icon, true);

  // The shortcut and the uninstall entry both point at the icon file, and
  // fall back to the launcher when a build ships no icon at all.
  assert.match(installer.PS1_TEMPLATE, /SR_ICON/);
  assert.match(installer.PS1_TEMPLATE, /\$sc\.IconLocation = \(\$icon \+ ',0'\)/);
  assert.match(installer.PS1_TEMPLATE, /\$sc\.IconLocation = \(\$target \+ ',0'\)/);

  // The .ico the installer patches with is the one in the app tree, and the
  // app tree carries assets/.
  assert.ok(installLayout.APP_DIRS.includes("assets"));
  assert.equal(installLayout.appIconFile(path.join(root, "nope")), "");
  assert.equal(readIcon(path.join(root, "assets", "icon.ico")).count, 7);

  // Patching something that is not an executable, or an icon that is not
  // there, is reported and never throws: a run that cannot paint the icon
  // still installs the app.
  const icon = path.join(root, "assets", "icon.ico");
  const missing = applyIcon(path.join(root, "does-not-exist.exe"), icon);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no executable/);
});

test("updater keeps a dev checkout silent while installs auto-check", async () => {
  const root = tempDir();
  const appRoot = path.join(root, "app");
  fs.mkdirSync(path.join(appRoot, "electron"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.1.0" }));
  fs.writeFileSync(path.join(appRoot, "electron", "main.cjs"), "// main");

  let fetches = 0;
  const releases = [
    { tag_name: "v1.2.0", name: "Simple Recorder v1.2.0", published_at: "2026-10-14T12:00:00Z", assets: [] },
  ];

  // No install.json: this is the owner's source checkout, so no background
  // checks and no auto install even with a newer release published.
  const dev = updater.createUpdater({
    appRoot,
    dataRoot: path.join(root, "data"),
    fetchReleases: async () => {
      fetches += 1;
      return releases;
    },
  });
  assert.equal(dev.getStatus().installMode, "development");
  assert.equal(dev.getStatus().ownerMachine, true);
  assert.equal(dev.getStatus().autoCheck, false);

  const skipped = await dev.checkForUpdates({ auto: true });
  assert.equal(fetches, 0, "a background check must not reach GitHub on a dev checkout");
  assert.equal(skipped.currentVersion, "1.1.0");

  // A manual check still lists the GitHub versions; it never offers or
  // performs an install.
  const manual = await dev.checkForUpdates();
  assert.equal(fetches, 1);
  assert.equal(manual.latestTag, "v1.2.0");
  assert.equal(manual.updateAvailable, false);
  assert.match((await dev.installRelease({ tag: "v1.2.0" })).error, /source checkout/);
  assert.equal(manual.currentVersion, "1.1.0");
  assert.equal(fs.readFileSync(path.join(appRoot, "electron", "main.cjs"), "utf8"), "// main");

  // An install with install.json is on the release channel even when it is
  // the owner's: it pings GitHub Releases on its own.
  const installDir = path.join(root, "installed");
  const installedAppRoot = installLayout.packagedAppRoot(installDir);
  fs.mkdirSync(path.join(installedAppRoot, "electron"), { recursive: true });
  fs.writeFileSync(
    path.join(installedAppRoot, "package.json"),
    JSON.stringify({ name: "simple-recorder", version: "1.1.0" }),
  );
  fs.writeFileSync(path.join(installedAppRoot, "electron", "main.cjs"), "// main");
  fs.writeFileSync(
    installLayout.manifestPath(installDir),
    JSON.stringify(installLayout.makeManifest({ version: "1.1.0", installDir, owner: true })),
  );
  const owner = updater.createUpdater({
    appRoot: installedAppRoot,
    dataRoot: path.join(root, "data2"),
    fetchReleases: async () => releases,
  });
  assert.equal(owner.getStatus().installMode, "installed");
  assert.equal(owner.getStatus().ownerMachine, true);
  assert.equal(owner.getStatus().autoCheck, true);
  assert.equal(owner.getStatus().installDir, path.resolve(installDir));

  // A background check reaches GitHub and offers the release, without
  // touching the files on disk: applying one is always a Download press.
  const pinged = await owner.checkForUpdates({ auto: true });
  assert.equal(pinged.updateAvailable, true);
  assert.equal(pinged.latestTag, "v1.2.0");
  assert.equal(pinged.status, "available");
  assert.equal(
    fs.readFileSync(path.join(installedAppRoot, "electron", "main.cjs"), "utf8"),
    "// main",
    "a background check must not touch the files on disk",
  );

  // A normal user install behaves the same.
  fs.writeFileSync(
    installLayout.manifestPath(installDir),
    JSON.stringify(installLayout.makeManifest({ version: "1.1.0", installDir, owner: false })),
  );
  const user = updater.createUpdater({
    appRoot: installedAppRoot,
    dataRoot: path.join(root, "data3"),
    fetchReleases: async () => releases,
  });
  assert.equal(user.getStatus().installMode, "installed");
  assert.equal(user.getStatus().ownerMachine, false);
  assert.equal(user.getStatus().autoCheck, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("update prefs store the release list and the version that landed", () => {
  const db = require("../lib/db");
  const root = tempDir();
  db.openDb(path.join(root, "data"));

  // Nothing chosen and nothing stored: there is no switch to persist.
  assert.equal(db.readUpdatePrefs().installedVersion, "");
  assert.equal(db.readUpdatePrefs().releases.length, 0);

  db.writeUpdatePrefs({
    installedVersion: "1.1.5",
    installedTag: "v1.1.5",
    lastUpdatedAt: "2026-10-14T04:27:00.000Z",
    releases: [{ tag: "v1.1.5", version: "1.1.5" }],
  });
  assert.equal(db.readUpdatePrefs().installedVersion, "1.1.5");
  assert.equal(db.readUpdatePrefs().installedTag, "v1.1.5");
  assert.equal(db.readUpdatePrefs().releases.length, 1);
  // A later write must not drop what an earlier one stored.
  db.writeUpdatePrefs({ lastCheckedAt: "2026-10-14T05:00:00.000Z" });
  assert.equal(db.readUpdatePrefs().installedVersion, "1.1.5");
  assert.equal(db.readUpdatePrefs().releases.length, 1);

  db.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the updates panel is a status line plus a Download button, and the smoke probe matches it", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  assert.match(html, /data-update-summary/);
  assert.match(html, /data-update-download/);
  assert.match(html, /data-update-note/);
  // Finding an update is automatic: there is no switch to disable it and no
  // separate check button. Download is the only action.
  assert.doesNotMatch(html, /data-update-auto/);
  assert.doesNotMatch(html, /data-update-picker/);
  assert.doesNotMatch(html, /data-update-check/);

  // Every data-update-* marker the hidden boot probes must exist, or the smoke
  // run reports a panel that is no longer on the page.
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const probed = new Set(main.match(/data-update[a-z-]*/g) || []);
  assert.ok(probed.size > 0, "the smoke probe should look at the updates panel");
  for (const marker of probed) {
    assert.ok(html.includes(marker), marker + " is probed by the smoke run but is missing from index.html");
  }
});
