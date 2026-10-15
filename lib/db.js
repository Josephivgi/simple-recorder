"use strict";

// SQLite store for durable app data: recorder prefs, capture consent, and
// the take index. Media files stay on disk; this is the metadata layer.

const path = require("path");
const fs = require("fs");

// Schema changes are additive only: new tables, new columns with defaults,
// new kv keys. Nothing is dropped, renamed, or rewritten, so a public build
// and a developer build can take turns on the same database and each leaves
// the data it does not know about in place for the other.
const SCHEMA_VERSION = 1;

let db = null;
let dbSchemaVersion = 0;

function openDb(dataRoot) {
  if (db) return db;
  fs.mkdirSync(dataRoot, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(dataRoot, "recorder.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS takes (" +
      "id TEXT PRIMARY KEY," +
      "name TEXT NOT NULL," +
      "path TEXT NOT NULL," +
      "mime TEXT NOT NULL," +
      "size INTEGER NOT NULL DEFAULT 0," +
      "duration_ms INTEGER NOT NULL DEFAULT 0," +
      "partial INTEGER NOT NULL DEFAULT 0," +
      "created_at TEXT NOT NULL" +
      ");",
  );
  // The highest schema any build has written. It is never lowered, so a
  // newer build's data is still marked as newer after an older build ran.
  dbSchemaVersion = Number(kvGet("schemaVersion", "0")) || 0;
  if (dbSchemaVersion < SCHEMA_VERSION) kvSet("schemaVersion", String(SCHEMA_VERSION));
  return db;
}

function schemaInfo() {
  return {
    schemaVersion: SCHEMA_VERSION,
    dbSchemaVersion: Math.max(dbSchemaVersion, SCHEMA_VERSION),
    newerData: dbSchemaVersion > SCHEMA_VERSION,
  };
}

// A consistent copy of the whole database (VACUUM INTO), checked before it
// counts. Never overwrites an existing file.
function snapshotDb(destFile) {
  if (!db) throw new Error("The database is not open.");
  if (fs.existsSync(destFile)) throw new Error("A backup already exists at " + destFile + ".");
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  db.prepare("VACUUM INTO ?").run(destFile);
  const { DatabaseSync } = require("node:sqlite");
  const copy = new DatabaseSync(destFile, { readOnly: true });
  try {
    const row = copy.prepare("PRAGMA quick_check").get();
    const verdict = row ? String(Object.values(row)[0]) : "";
    if (verdict !== "ok") throw new Error("The backup at " + destFile + " failed its check: " + verdict);
  } finally {
    copy.close();
  }
  return { file: destFile, size: fs.statSync(destFile).size };
}

function kvGet(key, fallback) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function kvSet(key, value) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value),
  );
}

// Persisted capture setup, same shape as the older capture-setup.json:
// consent flags plus recorder prefs.
function readSetup() {
  let area = null;
  try {
    area = JSON.parse(kvGet("recordArea", "null"));
  } catch {
    area = null;
  }
  return {
    screen: kvGet("consentScreen", "0") === "1",
    camera: false,
    mic: kvGet("consentMic", "0") === "1",
    soundOn: kvGet("soundOn", "1") === "1",
    micDeviceId: kvGet("micDeviceId", ""),
    recordTarget: kvGet("recordTarget", "full"),
    recordArea: area,
    recordFps: Number(kvGet("recordFps", "30")),
    recordDelayMs: Number(kvGet("recordDelayMs", "0")),
    recordDisplayId: kvGet("recordDisplayId", ""),
    recordAreaDisplayId: kvGet("recordAreaDisplayId", ""),
  };
}

// One transaction so a crash mid-write cannot leave half the prefs updated.
function writeSetup(cur) {
  db.exec("BEGIN");
  try {
    kvSet("consentScreen", cur.screen ? "1" : "0");
    kvSet("consentMic", cur.mic ? "1" : "0");
    kvSet("soundOn", cur.soundOn !== false ? "1" : "0");
    kvSet("micDeviceId", typeof cur.micDeviceId === "string" ? cur.micDeviceId : "");
    kvSet("recordTarget", cur.recordTarget === "area" ? "area" : "full");
    kvSet("recordArea", cur.recordArea ? JSON.stringify(cur.recordArea) : "null");
    const fps = Number(cur.recordFps);
    kvSet("recordFps", Number.isFinite(fps) ? String(Math.round(fps)) : "30");
    const delay = Number(cur.recordDelayMs);
    kvSet("recordDelayMs", Number.isFinite(delay) ? String(Math.round(delay)) : "0");
    kvSet("recordDisplayId", typeof cur.recordDisplayId === "string" ? cur.recordDisplayId : "");
    kvSet("recordAreaDisplayId", typeof cur.recordAreaDisplayId === "string" ? cur.recordAreaDisplayId : "");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw error;
  }
  return cur;
}

function insertTake(row) {
  db.prepare(
    "INSERT INTO takes (id, name, path, mime, size, duration_ms, partial, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    String(row.id),
    String(row.name || "Take"),
    String(row.path || ""),
    String(row.mime || "video/webm"),
    Math.max(0, Math.round(Number(row.size) || 0)),
    Math.max(0, Math.round(Number(row.durationMs) || 0)),
    row.partial ? 1 : 0,
    row.createdAt || new Date().toISOString(),
  );
}

function mapTake(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    size: row.size,
    durationMs: row.duration_ms,
    partial: Boolean(row.partial),
    createdAt: row.created_at,
  };
}

function listTakes(limit) {
  const rows = db
    .prepare("SELECT * FROM takes ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(Math.max(1, Math.min(200, Number(limit) || 60)));
  return rows.map(mapTake);
}

function getTake(id) {
  const row = db.prepare("SELECT * FROM takes WHERE id = ?").get(String(id || ""));
  return row ? mapTake(row) : null;
}

function deleteTakeRow(id) {
  db.prepare("DELETE FROM takes WHERE id = ?").run(String(id || ""));
}

function renameTake(id, name) {
  db.prepare("UPDATE takes SET name = ? WHERE id = ?").run(String(name || "").slice(0, 200), String(id || ""));
}

// A take that moved on disk (the day-folder migration) follows its file.
function updateTakeFile(id, filePath, name) {
  db.prepare("UPDATE takes SET path = ?, name = ? WHERE id = ?").run(
    String(filePath || ""),
    String(name || "").slice(0, 200),
    String(id || ""),
  );
}

// The release source is not stored as a repo name: the updater derives it
// from Developer mode updates, so a stored value can never point a build at
// some other repo.
function readUpdatePrefs() {
  let releases = [];
  try {
    const parsed = JSON.parse(kvGet("updateReleases", "[]"));
    if (Array.isArray(parsed)) releases = parsed;
  } catch {
    releases = [];
  }
  return {
    developerMode: kvGet("updateDeveloperMode", "0") === "1",
    installedChannel: kvGet("updateInstalledChannel", ""),
    installedVersion: kvGet("installedVersion", ""),
    installedTag: kvGet("installedTag", ""),
    selectedTag: kvGet("selectedReleaseTag", ""),
    lastCheckedAt: kvGet("updateLastCheckedAt", ""),
    lastUpdatedAt: kvGet("updateLastUpdatedAt", ""),
    releases,
  };
}

function writeUpdatePrefs(patch) {
  const cur = readUpdatePrefs();
  const next = {
    developerMode: patch && typeof patch.developerMode === "boolean" ? patch.developerMode : cur.developerMode,
    installedChannel:
      patch && (patch.installedChannel === "public" || patch.installedChannel === "developer")
        ? patch.installedChannel
        : cur.installedChannel,
    installedVersion:
      patch && typeof patch.installedVersion === "string" ? patch.installedVersion : cur.installedVersion,
    installedTag: patch && typeof patch.installedTag === "string" ? patch.installedTag : cur.installedTag,
    selectedTag: patch && typeof patch.selectedTag === "string" ? patch.selectedTag : cur.selectedTag,
    lastCheckedAt: patch && typeof patch.lastCheckedAt === "string" ? patch.lastCheckedAt : cur.lastCheckedAt,
    lastUpdatedAt: patch && typeof patch.lastUpdatedAt === "string" ? patch.lastUpdatedAt : cur.lastUpdatedAt,
    releases: patch && Array.isArray(patch.releases) ? patch.releases : cur.releases,
  };
  db.exec("BEGIN");
  try {
    kvSet("updateDeveloperMode", next.developerMode ? "1" : "0");
    if (next.installedChannel) kvSet("updateInstalledChannel", next.installedChannel);
    kvSet("installedVersion", next.installedVersion);
    kvSet("installedTag", next.installedTag);
    kvSet("selectedReleaseTag", next.selectedTag);
    kvSet("updateLastCheckedAt", next.lastCheckedAt);
    kvSet("updateLastUpdatedAt", next.lastUpdatedAt);
    kvSet("updateReleases", JSON.stringify(next.releases.slice(0, 30)));
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw error;
  }
  return next;
}

function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
  dbSchemaVersion = 0;
}

module.exports = {
  SCHEMA_VERSION,
  openDb,
  schemaInfo,
  snapshotDb,
  readSetup,
  writeSetup,
  readUpdatePrefs,
  writeUpdatePrefs,
  kvGet,
  kvSet,
  insertTake,
  listTakes,
  getTake,
  deleteTakeRow,
  renameTake,
  updateTakeFile,
  closeDb,
};
