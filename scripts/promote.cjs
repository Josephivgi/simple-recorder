"use strict";

// Promote a dev commit to the public repo. The only way code reaches users.
//
//   node scripts/promote.cjs                             use the dev release version of HEAD
//   node scripts/promote.cjs --version 1.2.1             gate, commit, tag, push
//   node scripts/promote.cjs --version 1.2.1 --dry-run   stop before pushing
//   node scripts/promote.cjs --version 1.2.0 --replace-history
//        one-time cutover: the public repo's main becomes a single fresh commit
//        (force push). Old public history stays in the private dev repo.
//
// Steps: HEAD must be committed and pushed to the dev repo. Its tracked files
// (minus security/) are exported, the version is stamped into package.json,
// and the security gate runs on the export. The export then replaces the
// public tree in a fresh clone as one commit authored by the GitHub noreply
// address, the gate runs again on the clone with the commit author check, and
// main plus the v<version> tag are pushed. The public workflow gates again,
// builds, and publishes the release.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { normalizeVersion, formatTag, compareVersions, unpackTarGz } = require("../lib/updater");
const { runGate } = require("./security-gate.cjs");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_REPO = "Josephivgi/simple-recorder";
const NOREPLY_NAME = "Josephivgi";
const NOREPLY_EMAIL = "Josephivgi@users.noreply.github.com";
// Never promoted: the private denylist lives here.
const PRIVATE_DIRS = new Set(["security"]);

function parseArgs(argv) {
  const out = { version: "", dryRun: false, replaceHistory: false, publicRepo: PUBLIC_REPO };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" && argv[i + 1]) out.version = normalizeVersion(argv[++i]);
    else if (arg === "--public-repo" && argv[i + 1]) out.publicRepo = argv[++i];
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--replace-history") out.replaceHistory = true;
  }
  return out;
}

function git(cwd, args, opts) {
  return execFileSync("git", args, Object.assign({ cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, opts || {}));
}

function say(line) {
  process.stdout.write(line + "\n");
}

function fail(message) {
  throw new Error(message);
}

function publicLatestVersion(repo) {
  try {
    const tag = execFileSync("gh", ["api", "repos/" + repo + "/releases/latest", "--jq", ".tag_name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeVersion(tag.trim());
  } catch {
    return "";
  }
}

function printFindings(label, result) {
  say(label + ": " + (result.ok ? "PASS" : "BLOCKED") + " (" + result.files + " files)");
  for (const f of result.findings) {
    say("  FAIL [" + f.kind + "] " + f.rule + ": " + f.file + (f.line ? ":" + f.line : "") + (f.match ? "  " + f.match : ""));
  }
}

// Tracked files of HEAD, minus the private folders.
function exportHead(dest) {
  const gz = execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  let count = 0;
  for (const entry of unpackTarGz(gz)) {
    if (PRIVATE_DIRS.has(entry.path.split("/")[0])) continue;
    const abs = path.join(dest, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.data);
    count += 1;
  }
  return count;
}

function copyTree(src, dest) {
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, item.name);
    const to = path.join(dest, item.name);
    if (item.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else if (item.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function emptyWorkTree(dir) {
  for (const item of fs.readdirSync(dir)) {
    if (item === ".git") continue;
    fs.rmSync(path.join(dir, item), { recursive: true, force: true });
  }
}

// The version of the dev release built from this commit: the highest v* tag
// on the dev repo that points at it. Promoting with it keeps dev and public
// on the same number for the same code.
function devVersionFor(head) {
  let best = "";
  for (const line of git(ROOT, ["ls-remote", "--tags", "origin"]).split(/\r?\n/)) {
    const [sha, ref] = line.split("\t");
    if (sha !== head || !ref) continue;
    const version = normalizeVersion(ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""));
    if (version && (!best || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

function promote(args) {
  const denylist = path.join(ROOT, "security", "private-denylist.txt");

  if (git(ROOT, ["status", "--porcelain"]).trim()) fail("The dev checkout has uncommitted changes. Commit them first.");
  const head = git(ROOT, ["rev-parse", "HEAD"]).trim();
  git(ROOT, ["fetch", "--quiet", "origin", "main"]);
  try {
    git(ROOT, ["merge-base", "--is-ancestor", head, "origin/main"], { stdio: "ignore" });
  } catch {
    fail("HEAD " + head.slice(0, 10) + " is not on the dev repo's main yet. Push it to origin/main first.");
  }
  if (!args.version) {
    args.version = devVersionFor(head);
    if (!args.version) {
      fail("No dev release is built from HEAD " + head.slice(0, 10) + " yet. Wait for the dev build, or pass --version <x.y.z>.");
    }
    say("Using the dev release version of HEAD: " + args.version);
  }
  const tag = formatTag(args.version);

  const latest = publicLatestVersion(args.publicRepo);
  if (latest && compareVersions(args.version, latest) <= 0) {
    fail("Version " + args.version + " is not newer than the public release " + latest + ".");
  }
  say("Promoting " + head.slice(0, 10) + " as " + tag + " to " + args.publicRepo + (latest ? " (public latest: " + latest + ")" : ""));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sr-promote-"));
  try {
    return promoteIn(work, args, tag, denylist, head);
  } finally {
    // A dry run keeps the public commit for inspection; everything else is removed.
    if (!args.dryRun) fs.rmSync(work, { recursive: true, force: true });
  }
}

function promoteIn(work, args, tag, denylist, head) {
  const exportDir = path.join(work, "export");
  const cloneDir = path.join(work, "public");
  fs.mkdirSync(exportDir);
  say("Exported " + exportHead(exportDir) + " tracked files.");

  const pkgFile = path.join(exportDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.version = args.version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const exportGate = runGate({ dir: exportDir, denylist });
  printFindings("Gate on export", exportGate);
  if (!exportGate.ok) fail("The security gate blocked the export. Nothing was pushed.");

  git(work, ["clone", "--quiet", "https://github.com/" + args.publicRepo + ".git", cloneDir], { stdio: "inherit" });
  if (git(cloneDir, ["tag", "--list", tag]).trim()) fail("The public repo already has tag " + tag + ".");
  const env = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: NOREPLY_NAME,
    GIT_AUTHOR_EMAIL: NOREPLY_EMAIL,
    GIT_COMMITTER_NAME: NOREPLY_NAME,
    GIT_COMMITTER_EMAIL: NOREPLY_EMAIL,
  });
  if (args.replaceHistory) {
    // Old public tags keep the old history reachable on GitHub and would fail
    // the commit author check on every later release. They (and their
    // releases) must be removed first, once they are copied to the dev repo.
    const remoteTags = git(cloneDir, ["ls-remote", "--tags", "origin"]).trim();
    if (remoteTags && !args.dryRun) {
      fail("The public repo still has tags. Copy its releases to the dev repo, delete the public releases and tags, then rerun.");
    }
    git(cloneDir, ["checkout", "--quiet", "--orphan", "promote-fresh"]);
    git(cloneDir, ["rm", "-rq", "--cached", "--ignore-unmatch", "."]);
    // A fresh history only carries the new commit and tag.
    for (const old of git(cloneDir, ["tag", "--list"]).split(/\r?\n/).filter(Boolean)) git(cloneDir, ["tag", "-d", old]);
  }
  emptyWorkTree(cloneDir);
  copyTree(exportDir, cloneDir);
  git(cloneDir, ["add", "-A"]);
  git(cloneDir, ["commit", "--quiet", "-m", "Simple Recorder " + tag], { env });
  git(cloneDir, ["tag", tag], { env });
  if (args.replaceHistory) {
    git(cloneDir, ["branch", "-D", "main"], { stdio: "ignore" });
    git(cloneDir, ["branch", "-m", "main"]);
    // Drop every ref the old history could still reach before the author check.
    for (const ref of git(cloneDir, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).split(/\r?\n/).filter(Boolean)) {
      git(cloneDir, ["update-ref", "--no-deref", "-d", ref]);
    }
  }

  const cloneGate = runGate({ dir: cloneDir, denylist, authors: true });
  printFindings("Gate on public commit", cloneGate);
  if (!cloneGate.ok) fail("The security gate blocked the public commit. Nothing was pushed.");

  if (args.dryRun) {
    say("Dry run: nothing pushed. Public commit ready in " + cloneDir);
    return { ok: true, pushed: false, cloneDir, tag };
  }
  git(cloneDir, ["push", args.replaceHistory ? "--force" : "--quiet", "origin", "main"], { stdio: "inherit" });
  git(cloneDir, ["push", "origin", tag], { stdio: "inherit" });
  say("Pushed main and " + tag + ". The public workflow gates, builds, and publishes the release.");
  return { ok: true, pushed: true, tag };
}

if (require.main === module) {
  try {
    promote(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write("Promote failed: " + ((error && error.message) || error) + "\n");
    process.exit(1);
  }
}

module.exports = { parseArgs, promote, exportHead };
