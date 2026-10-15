"use strict";

// Build and publish a GitHub Release update bundle for Simple Recorder.
// Usage:
//   node scripts/release.cjs --pack-only [--version 1.0.1]
//   node scripts/release.cjs [1.0.1 | --bump patch|minor|major]

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createUpdateBundle, normalizeVersion, formatTag, DEFAULT_REPO } = require("../lib/updater");
const { buildSetupExe } = require("./pack-setup.cjs");
const { runGate } = require("./security-gate.cjs");

const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist-app");

function bumpSemver(version, kind) {
  const norm = normalizeVersion(version) || "1.0.0";
  const [maj, min, pat] = norm.split("-")[0].split(".").map((n) => Number(n) || 0);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function parseArgs(argv) {
  const out = { packOnly: false, version: "", bump: "", notes: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pack-only") out.packOnly = true;
    else if (arg === "--version" && argv[i + 1]) {
      out.version = normalizeVersion(argv[++i]);
    } else if (arg === "--bump" && argv[i + 1]) {
      out.bump = String(argv[++i]);
    } else if (arg === "--notes" && argv[i + 1]) {
      out.notes = String(argv[++i]);
    } else if (!arg.startsWith("-") && !out.version) {
      out.version = normalizeVersion(arg);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  let version = args.version || normalizeVersion(pkg.version) || "1.0.0";
  if (args.bump) {
    version = bumpSemver(version, args.bump);
  }
  if (!args.packOnly && version !== pkg.version) {
    pkg.version = version;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }

  const tag = formatTag(version);
  const assetName = `simple-recorder-${tag}-app.tar.gz`;
  const assetPath = path.join(DIST_DIR, assetName);
  const manifestPath = path.join(DIST_DIR, "latest.json");

  await fs.mkdir(DIST_DIR, { recursive: true });
  const bundle = await createUpdateBundle(ROOT, assetPath, { version });
  const manifest = {
    name: "Simple Recorder",
    version,
    tag,
    assetName,
    size: bundle.size,
    sha256: bundle.sha256,
    filesCount: bundle.filesCount,
    publishedAt: new Date().toISOString(),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`Packed ${assetName} (${bundle.size} bytes, sha256=${bundle.sha256})\n`);

  // The downloadable setup .exe needs the Windows Electron runtime, so it is
  // only built where npm install produced node_modules/electron/dist.
  let setup = null;
  if (fssync.existsSync(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"))) {
    setup = await buildSetupExe(version);
    if (setup.ok) {
      process.stdout.write(`Packed ${setup.setupName} (${setup.size} bytes)\n`);
    } else {
      process.stdout.write(`Setup skipped: ${setup.error}\n`);
      setup = null;
    }
  } else {
    process.stdout.write("Setup skipped: no Windows Electron runtime here.\n");
  }

  if (args.packOnly) return;

  // A local publish goes to the dev repo only, and only past the gate. Public
  // releases come from the public workflow after `npm run promote`.
  const target = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (target.toLowerCase() === DEFAULT_REPO.toLowerCase()) {
    throw new Error("npm run release never publishes to " + DEFAULT_REPO + ". Use npm run promote.");
  }
  const gate = runGate({ dir: ROOT, bundles: [assetPath] });
  if (!gate.ok) {
    for (const f of gate.findings) process.stdout.write("  FAIL [" + f.kind + "] " + f.rule + ": " + f.file + "\n");
    throw new Error("The security gate blocked this release.");
  }

  const assets = [assetPath, manifestPath];
  if (setup) assets.push(setup.setupPath);
  const title = `Simple Recorder ${tag}`;
  const notes = args.notes || `Simple Recorder ${tag} release.`;
  let exists = false;
  try {
    execFileSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" });
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    execFileSync("gh", ["release", "upload", tag, ...assets, "--clobber"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    process.stdout.write(`Updated GitHub release ${tag}.\n`);
  } else {
    execFileSync(
      "gh",
      ["release", "create", tag, ...assets, "--title", title, "--notes", notes],
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );
    process.stdout.write(`Published GitHub release ${tag}.\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String((error && (error.stack || error.message)) || error) + "\n");
    process.exit(1);
  });
}

module.exports = { bumpSemver, parseArgs };
