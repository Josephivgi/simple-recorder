"use strict";

// Release security gate. A release only reaches users when this passes.
//
//   node scripts/security-gate.cjs                     scan the tracked files here
//   node scripts/security-gate.cjs --dir <folder>      scan another tree (a promote export)
//   node scripts/security-gate.cjs --authors           also require noreply commit authors
//   node scripts/security-gate.cjs --bundle <tar.gz>   scan a built update bundle
//   node scripts/security-gate.cjs --denylist <file>   extra private words (default:
//                                                      security/private-denylist.txt)
//   node scripts/security-gate.cjs --json              machine-readable result
//
// Checks: secret patterns, personal info (profile paths, home folders, personal
// emails, private IPv4 addresses, private denylist words), shipped app code
// reading a GitHub token outside Developer mode updates, the installer calling
// the GitHub CLI, commit authors, and bundle paths. gitleaks, npm audit, and
// the unit tests run next to it in the release workflow.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// Folders that never ship and never get promoted. `security/` holds the
// private denylist itself, which would otherwise match its own words.
const SKIP_DIRS = new Set([".git", "node_modules", "dist-app", "security"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".dll", ".zip", ".gz", ".tgz", ".pak", ".dat", ".bin", ".node", ".mp4", ".webm"]);

const SECRET_RULES = [
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["private key", new RegExp("-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE" + " KEY-----")],
  ["database URL with password", /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@'"]+:[^\s@/'"]+@/i],
  ["webhook URL", /https:\/\/(?:(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[A-Za-z0-9/_-]+/],
];

// Placeholder names that are fine in docs and tests.
const OK_PROFILE_NAMES = new Set(["example", "public", "default", "runneradmin", "runner", "user", "username", "<user>", "%username%", "all users", "default user"]);
const OK_EMAIL_DOMAINS = [/(^|\.)users\.noreply\.github\.com$/i, /^noreply\.github\.com$/i, /^github\.com$/i, /(^|\.)example\.(com|org|net)$/i];

function personalRules() {
  return [
    {
      name: "Windows profile path",
      re: /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)([^\\/"'`\s<>|:*?]+)/gi,
      ok: (m) => OK_PROFILE_NAMES.has(m[1].toLowerCase()),
    },
    {
      name: "home folder",
      re: /(?:^|[\s"'`(=])\/(?:home|Users)\/([A-Za-z0-9._-]+)(?=\/|["'`\s)]|$)/gim,
      ok: (m) => OK_PROFILE_NAMES.has(m[1].toLowerCase()) || m[1].toLowerCase() === "shared",
    },
    {
      name: "email address",
      re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
      ok: (m) => m[0].toLowerCase() === "git@github.com" || OK_EMAIL_DOMAINS.some((re) => re.test(m[1])),
    },
    {
      name: "private IPv4 address",
      re: /(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.])/g,
      ok: () => false,
    },
  ];
}

function parseArgs(argv) {
  const out = { dir: ROOT, authors: false, bundles: [], denylist: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir" && argv[i + 1]) out.dir = path.resolve(argv[++i]);
    else if (arg === "--bundle" && argv[i + 1]) out.bundles.push(path.resolve(argv[++i]));
    else if (arg === "--denylist" && argv[i + 1]) out.denylist = path.resolve(argv[++i]);
    else if (arg === "--authors") out.authors = true;
    else if (arg === "--json") out.json = true;
  }
  return out;
}

function readDenylist(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.toLowerCase());
}

function isGitRepo(dir) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "ignore" });
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

// Tracked files in a git checkout; every file in a plain folder (an export).
function listFiles(dir) {
  if (isGitRepo(dir)) {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean).filter((rel) => !SKIP_DIRS.has(rel.split("/")[0]));
  }
  const files = [];
  const walk = (rel) => {
    for (const item of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? rel + "/" + item.name : item.name;
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(child);
      } else if (item.isFile()) {
        files.push(child);
      }
    }
  };
  walk("");
  return files;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function redact(value) {
  const s = String(value);
  return s.length <= 8 ? s : s.slice(0, 4) + "…" + s.slice(-2);
}

function scanText(rel, text, denylist, findings) {
  for (const [name, re] of SECRET_RULES) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    for (const m of text.matchAll(new RegExp(re.source, flags))) {
      findings.push({ kind: "secret", rule: name, file: rel, line: lineOf(text, m.index), match: redact(m[0]) });
    }
  }
  for (const rule of personalRules()) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.ok(m)) continue;
      findings.push({ kind: "personal", rule: rule.name, file: rel, line: lineOf(text, m.index), match: m[0].trim() });
    }
  }
  if (denylist.length) {
    const lower = text.toLowerCase();
    for (const word of denylist) {
      let at = lower.indexOf(word);
      while (at >= 0) {
        findings.push({ kind: "personal", rule: "private denylist", file: rel, line: lineOf(text, at), match: redact(word) });
        at = lower.indexOf(word, at + word.length);
      }
    }
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// The public build reads the public repo anonymously. A token is only ever
// read for Developer mode updates, in lib/updater.js.
function scanShippedCode(dir, files, findings) {
  for (const rel of files) {
    const top = rel.split("/")[0];
    if (!["electron", "lib", "renderer"].includes(top)) continue;
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    // Any mention of a GitHub token variable in shipped code: process.env.X,
    // process.env["X"], or a destructured { X } = process.env.
    text.split(/\r?\n/).forEach((lineText, i) => {
      const m = /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|REC_GITHUB_TOKEN)\b/.exec(lineText);
      if (m) {
        findings.push({ kind: "token-use", rule: "app code reads a GitHub token from the environment", file: rel, line: i + 1, match: m[0] });
      }
    });
    if (rel !== "lib/updater.js" && /["']auth["'],\s*["']token["']/.test(text)) {
      findings.push({ kind: "token-use", rule: "app code asks the GitHub CLI for a token", file: rel, line: 0, match: "" });
    }
  }
  const installer = path.join(dir, "scripts", "install.cjs");
  if (fs.existsSync(installer) && /exec(?:File)?(?:Sync)?\(\s*["']gh["']/.test(fs.readFileSync(installer, "utf8"))) {
    findings.push({ kind: "token-use", rule: "installer calls the GitHub CLI", file: "scripts/install.cjs", line: 0, match: "" });
  }
}

function scanAuthors(dir, findings) {
  const out = execFileSync("git", ["log", "--all", "--format=%H%x09%ae%x09%ce"], { cwd: dir, encoding: "utf8" });
  const ok = (email) => /@users\.noreply\.github\.com$/i.test(email) || /^noreply@github\.com$/i.test(email);
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [sha, author, committer] = line.split("\t");
    for (const email of [author, committer]) {
      if (!ok(email)) findings.push({ kind: "author", rule: "commit email is not a GitHub noreply address", file: sha.slice(0, 10), line: 0, match: email });
    }
  }
}

function scanBundle(file, denylist, findings) {
  const { unpackTarGz, isAllowedAppPath } = require("../lib/updater");
  const entries = unpackTarGz(fs.readFileSync(file));
  if (!entries.length) findings.push({ kind: "bundle", rule: "bundle is empty", file: path.basename(file), line: 0, match: "" });
  for (const entry of entries) {
    const label = path.basename(file) + ":" + entry.path;
    if (!isAllowedAppPath(entry.path)) {
      findings.push({ kind: "bundle", rule: "bundle path outside the app tree", file: label, line: 0, match: entry.path });
      continue;
    }
    if (entry.path.split("/").some((part) => SKIP_DIRS.has(part) || part === "test")) {
      findings.push({ kind: "bundle", rule: "bundle carries a folder that never ships", file: label, line: 0, match: entry.path });
    }
    if (!looksBinary(entry.data)) scanText(label, entry.data.toString("utf8"), denylist, findings);
  }
  return entries.length;
}

function runGate(opts) {
  const options = Object.assign(parseArgs([]), opts || {});
  const denylist = readDenylist(options.denylist || path.join(options.dir, "security", "private-denylist.txt"));
  const findings = [];
  const files = listFiles(options.dir);
  for (const rel of files) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const buf = fs.readFileSync(path.join(options.dir, rel));
    if (looksBinary(buf)) continue;
    scanText(rel, buf.toString("utf8"), denylist, findings);
  }
  scanShippedCode(options.dir, files, findings);
  if (options.authors) scanAuthors(options.dir, findings);
  let bundleEntries = 0;
  for (const bundle of options.bundles) bundleEntries += scanBundle(bundle, denylist, findings);
  return { ok: findings.length === 0, files: files.length, bundleEntries, denylistWords: denylist.length, findings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runGate(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(
      "Security gate: " + result.files + " files" +
        (args.bundles.length ? ", " + result.bundleEntries + " bundle entries" : "") +
        (result.denylistWords ? ", " + result.denylistWords + " private denylist words" : "") +
        (args.authors ? ", commit authors" : "") + "\n",
    );
    for (const f of result.findings) {
      process.stdout.write("  FAIL [" + f.kind + "] " + f.rule + ": " + f.file + (f.line ? ":" + f.line : "") + (f.match ? "  " + f.match : "") + "\n");
    }
    process.stdout.write(result.ok ? "PASS\n" : "BLOCKED: " + result.findings.length + " finding(s)\n");
  }
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { runGate, parseArgs, SECRET_RULES, personalRules };
