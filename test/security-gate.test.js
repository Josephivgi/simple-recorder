"use strict";

// The release security gate must block what it claims to block and pass a
// clean tree. Samples are assembled at runtime so this file never trips the
// gate (or gitleaks) itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const gate = require("../scripts/security-gate.cjs");
const updater = require("../lib/updater");

function tempTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-gate-test-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function rules(result) {
  return Array.from(new Set(result.findings.map((f) => f.rule))).sort();
}

test("the gate passes a clean tree with placeholder paths and noreply emails", () => {
  const dir = tempTree({
    "README.md": "Recordings live in C:\\Users\\Example\\Videos. Mail 1+bot@users.noreply.github.com.\n",
    "lib/a.js": "const url = 'https://api.github.com/repos/x/y'; // 127.0.0.1 is fine\n",
  });
  const result = gate.runGate({ dir });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the gate blocks secrets, personal info, and denylist words", () => {
  const pathSep = "\\";
  const dir = tempTree({
    "a.txt": "token " + "gh" + "p_" + "A".repeat(36) + "\n",
    "b.txt": "key " + "AK" + "IA" + "ABCDEFGHIJKLMNOP" + "\n",
    "c.txt": "-----BEGIN " + "RSA PRIVATE" + " KEY-----\n",
    "d.txt": "db " + "postgres" + "://admin:hunter2" + "@" + "db.internal/app\n",
    "e.txt": "C:" + pathSep + "Users" + pathSep + "Jane" + pathSep + "Videos\n",
    "e2.txt": "c:" + pathSep + "users" + pathSep + "jane" + pathSep + "videos\n",
    "e3.txt": "cd /" + "home/" + "jane\n",
    "f.txt": "author " + "jane" + "@" + "laptop.local\n",
    "g.txt": "host " + "192." + "168.1.20\n",
    "h.txt": "built on the " + "Mega" + "corp fleet\n",
    "security/private-denylist.txt": "megacorp\n",
  });
  const result = gate.runGate({ dir });
  assert.equal(result.ok, false);
  assert.deepEqual(rules(result), [
    "AWS access key",
    "GitHub token",
    "Windows profile path",
    "database URL with password",
    "home folder",
    "email address",
    "private IPv4 address",
    "private denylist",
    "private key",
  ].sort());
  // The denylist file itself is never scanned (or promoted).
  assert.equal(result.findings.some((f) => f.file.startsWith("security/")), false);
  // Case does not hide a profile path.
  assert.ok(result.findings.some((f) => f.file === "e2.txt" && f.rule === "Windows profile path"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the gate blocks app code that reads a GitHub token or calls the GitHub CLI", () => {
  const dir = tempTree({
    "lib/other.js": "const t = process.env." + "GITHUB_TOKEN;\n",
    "lib/bracket.js": "const t = process.env[\"" + "GH_" + "TOKEN\"];\n",
    "electron/x.cjs": "execFile('gh', ['auth', " + "'token'])\n",
    "lib/updater.js": "execFile(" + "'gh', ['api', 'user'])\n",
    "scripts/install.cjs": "execFileSync(" + "\"gh\", ['api', 'user'])\n",
  });
  const result = gate.runGate({ dir });
  assert.ok(result.findings.some((f) => f.file === "lib/bracket.js"));
  assert.ok(result.findings.some((f) => f.file === "lib/updater.js"), "the updater has no exception any more");
  assert.deepEqual(rules(result), [
    "app code calls the GitHub CLI",
    "app code reads a GitHub token from the environment",
    "installer calls the GitHub CLI",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the gate scans a built update bundle and refuses paths outside the app tree", async () => {
  const good = tempTree({
    "package.json": JSON.stringify({ name: "simple-recorder", version: "1.0.0" }),
    "lib/a.js": "// fine\n",
  });
  const out = path.join(good, "..", path.basename(good) + ".tar.gz");
  await updater.createUpdateBundle(good, out, { version: "1.0.0" });
  const clean = gate.runGate({ dir: tempTree({ "x.md": "ok\n" }), bundles: [out] });
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  assert.ok(clean.bundleEntries >= 2);

  const bad = path.join(good, "..", path.basename(good) + "-bad.tar.gz");
  fs.writeFileSync(
    bad,
    updater.packTarGz([
      { path: "package.json", data: Buffer.from("{}") },
      { path: "lib/leak.js", data: Buffer.from("// " + "gh" + "p_" + "B".repeat(36)) },
      { path: "notes/secret.txt", data: Buffer.from("x") },
    ]),
  );
  const blocked = gate.runGate({ dir: tempTree({ "x.md": "ok\n" }), bundles: [bad] });
  assert.equal(blocked.ok, false);
  assert.deepEqual(rules(blocked), ["GitHub token", "bundle path outside the app tree"]);
  fs.rmSync(good, { recursive: true, force: true });
  fs.rmSync(out, { force: true });
  fs.rmSync(bad, { force: true });
});
