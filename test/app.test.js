"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const db = require("../lib/db");
const setup = require("../lib/capture-setup");
const takeFiles = require("../lib/take-files");
const library = require("../lib/library-folders");
const updater = require("../lib/updater");
const installLayout = require("../lib/install-layout");
const { usableWorkArea } = require("../lib/window-bounds");
const { keepCaptureSource } = require("../lib/capture-source-filter.cjs");
const { frameLooksBlank } = require("../lib/paint-check");

test("paint check: a flat window background is blank, a painted page is not", () => {
  const flat = Buffer.alloc(200 * 120 * 4);
  for (let i = 0; i < flat.length; i += 4) flat.set([0xf8, 0xf6, 0xf4, 0xff], i);
  assert.deepEqual(frameLooksBlank(flat), { known: true, blank: true, colors: 1 });

  const page = Buffer.from(flat);
  // Sidebar, a white panel, dark text, and a blue button.
  const paint = (from, to, bgra) => {
    for (let p = from; p < to; p++) page.set(bgra, p * 4);
  };
  paint(0, 4000, [0xff, 0xff, 0xff, 0xff]);
  paint(9000, 9400, [0x2a, 0x1f, 0x1a, 0xff]);
  paint(15000, 16500, [0xd7, 0x6b, 0x0a, 0xff]);
  const verdict = frameLooksBlank(page);
  assert.equal(verdict.known, true);
  assert.equal(verdict.blank, false);

  assert.equal(frameLooksBlank(Buffer.alloc(0)).known, false);
  assert.equal(frameLooksBlank(null).known, false);
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rec-test-"));
}

// Windows and macOS treat a differently cased path as the same file; Linux
// does not, so path-spelling cases only exist on the first two.
const CASELESS = process.platform === "win32" || process.platform === "darwin";

test("db persists setup prefs and consent", () => {
  const dir = tempDir();
  db.openDb(dir);
  const cur = setup.normalizeSetup({});
  cur.screen = true;
  cur.soundOn = false;
  cur.recordFps = 60;
  cur.recordArea = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
  cur.recordTarget = "area";
  db.writeSetup(cur);
  const read = setup.readCaptureSetup(db);
  assert.equal(read.screen, true);
  assert.equal(read.soundOn, false);
  assert.equal(read.recordFps, 60);
  assert.equal(read.recordTarget, "area");
  assert.deepEqual(read.recordArea, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("studio prefs persist: delay, chosen screen, area screen", () => {
  const dir = tempDir();
  db.openDb(dir);
  setup.saveRecorderPrefs(db, {
    recordDelayMs: 5000,
    recordDisplayId: "2528732444",
    recordAreaDisplayId: "1",
    recordArea: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    recordTarget: "area",
  });
  const read = setup.readCaptureSetup(db);
  assert.equal(read.recordDelayMs, 5000);
  assert.equal(read.recordDisplayId, "2528732444");
  assert.equal(read.recordAreaDisplayId, "1");
  assert.equal(read.recordTarget, "area");
  const status = setup.captureSetupStatus(read, null, "win32");
  assert.equal(status.prefs.recordDelayMs, 5000);
  assert.equal(status.prefs.recordDisplayId, "2528732444");
  // Back to the screen under the pointer.
  setup.saveRecorderPrefs(db, { recordDisplayId: "" });
  assert.equal(setup.readCaptureSetup(db).recordDisplayId, "");
  assert.equal(setup.readCaptureSetup(db).recordDelayMs, 5000);
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("delay and display ids normalize to safe values", () => {
  assert.equal(setup.normalizeRecordDelayMs(-5), 0);
  assert.equal(setup.normalizeRecordDelayMs("nope"), 0);
  assert.equal(setup.normalizeRecordDelayMs(2600), 3000);
  assert.equal(setup.normalizeRecordDelayMs(99999), 10000);
  assert.equal(setup.normalizeDisplayId(42), "42");
  assert.equal(setup.normalizeDisplayId("screen:1:0"), "");
  assert.equal(setup.normalizeDisplayId(null), "");
  assert.equal(setup.normalizeSetup({}).recordDelayMs, 0);
});

test("removeRecordingFile deletes a recording and refuses files outside the folder", async () => {
  const root = tempDir();
  const take = path.join(root, "Screen take 1.webm");
  fs.writeFileSync(take, "video");
  const outside = path.join(tempDir(), "keep.webm");
  fs.writeFileSync(outside, "keep");

  assert.deepEqual(await takeFiles.removeRecordingFile(root, take), { ok: true });
  assert.equal(fs.existsSync(take), false);
  // Already gone counts as deleted, so the row can be cleaned up.
  assert.equal((await takeFiles.removeRecordingFile(root, take)).ok, true);

  // A take inside a day folder is still a recording file, and still deletes.
  const dayFile = path.join(root, "2026-10-12", "Screen take 2.webm");
  fs.mkdirSync(path.dirname(dayFile), { recursive: true });
  fs.writeFileSync(dayFile, "video");
  assert.deepEqual(await takeFiles.removeRecordingFile(root, dayFile), { ok: true });
  assert.equal(fs.existsSync(dayFile), false);

  const refused = await takeFiles.removeRecordingFile(root, outside);
  assert.equal(refused.ok, false);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(takeFiles.isRecordingFile(root, root), false);
  assert.equal(takeFiles.isRecordingFile(root, path.join(root, "a", "b.webm")), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(outside), { recursive: true, force: true });
});

test("removeRecordingFile retries a locked file, then reports it still exists", async () => {
  const root = path.resolve("C:/rec");
  const file = path.join(root, "a.webm");
  const realpath = async (p) => p;
  const stat = async () => ({ isFile: () => true });
  let calls = 0;
  const locked = Object.assign(new Error("busy"), { code: "EBUSY" });
  const stuck = await takeFiles.removeRecordingFile(root, file, {
    realpath,
    stat,
    wait: async () => {},
    tries: 3,
    unlink: async () => {
      calls += 1;
      throw locked;
    },
  });
  assert.equal(stuck.ok, false);
  assert.equal(calls, 3);

  let freed = 0;
  let gone = false;
  const ok = await takeFiles.removeRecordingFile(root, file, {
    realpath,
    wait: async () => {},
    stat: async () => {
      if (gone) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return { isFile: () => true };
    },
    unlink: async () => {
      freed += 1;
      if (freed < 2) throw locked;
      gone = true;
    },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(freed, 2);
});

test("db stores and lists takes newest first", () => {
  const dir = tempDir();
  db.openDb(dir);
  db.insertTake({ id: "a", name: "Screen take 1", path: "C:\\v\\a.webm", mime: "video/webm", size: 10, durationMs: 1000, createdAt: "2025-01-01T00:00:00Z" });
  db.insertTake({ id: "b", name: "Screen take 2", path: "C:\\v\\b.webm", mime: "video/webm", size: 20, durationMs: 2000, createdAt: "2025-01-02T00:00:00Z" });
  const takes = db.listTakes();
  assert.equal(takes.length, 2);
  assert.equal(takes[0].id, "b");
  db.deleteTakeRow("a");
  assert.equal(db.listTakes().length, 1);
  assert.equal(db.getTake("b").name, "Screen take 2");
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("normalizeRecordFps lands on a supported step", () => {
  assert.equal(setup.normalizeRecordFps(61), 60);
  assert.equal(setup.normalizeRecordFps(12), 24);
  assert.equal(setup.normalizeRecordFps("nope"), 30);
  assert.equal(setup.normalizeRecordFps(27), 30);
});

test("quality is an output height, and only MP4 can be chosen", () => {
  assert.equal(setup.normalizeRecordQuality("720p"), "720p");
  assert.equal(setup.normalizeRecordQuality("1440p"), "1440p");
  assert.equal(setup.normalizeRecordQuality("1080P"), "1080p");
  assert.equal(setup.normalizeRecordQuality("nope"), "1080p");
  // A pre-1.1.7 install stored a bitrate tier. It keeps the height it stood
  // for instead of snapping back to the default.
  assert.equal(setup.normalizeRecordQuality("standard"), "720p");
  assert.equal(setup.normalizeRecordQuality("high"), "1080p");
  assert.equal(setup.normalizeRecordQuality("max"), "1440p");
  assert.equal(setup.normalizeSetup({}).recordQuality, "1080p");
  // WebM is not a stored choice any more; the saved value falls to MP4.
  assert.equal(setup.normalizeRecordFormat("webm"), "mp4");
  assert.equal(setup.normalizeSetup({ recordFormat: "webm" }).recordFormat, "mp4");
});

test("the panel offers one live format and three output heights", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  // WebM is a disabled placeholder, so it can never become the choice.
  assert.match(html, /data-format="webm"[^>]*disabled/);
  assert.ok(!html.includes('data-quality="standard"'));
  for (const height of ["720p", "1080p", "1440p"]) {
    assert.ok(html.includes('data-quality="' + height + '"'), height + " button is missing");
    const px = height.replace("p", "");
    assert.ok(app.includes('"' + height + '": ' + px), height + " height is missing in the renderer");
  }
  // Every take is sized from that height, so a 4K display is not shipped at 4K.
  assert.ok(app.includes("qualityHeight() / rawH"));
  assert.ok(app.includes("size.h <= qualityHeight()"));
});

test("normalizeRecordArea rejects bad geometry", () => {  assert.equal(setup.normalizeRecordArea(null), null);
  assert.equal(setup.normalizeRecordArea({ x: 0, y: 0, w: 0, h: 0 }), null);
  assert.equal(setup.normalizeRecordArea({ x: -1, y: 0, w: 0.5, h: 0.5 }), null);
  assert.equal(setup.normalizeRecordArea({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), null);
  assert.deepEqual(setup.normalizeRecordArea({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
});

test("area target needs a saved area", () => {
  const raw = { recordTarget: "area", recordArea: null };
  const n = setup.normalizeSetup(raw);
  assert.equal(n.recordTarget, "full");
});

test("captureSetupStatus reports prefs and consent", () => {
  const prefs = { getMediaAccessStatus: () => "granted" };
  const persisted = setup.normalizeSetup({ screen: true, mic: true });
  const status = setup.captureSetupStatus(persisted, prefs, "win32", { packaged: true });
  assert.equal(status.ready, true);
  assert.equal(status.screen.ok, true);
  assert.equal(status.mic.ok, true);
  assert.equal(status.mic.settingsUrl, "ms-settings:privacy-microphone");
  assert.equal(status.prefs.recordFps, 30);
});

test("OS denial sticks until granted or probed", () => {
  const deniedPrefs = { getMediaAccessStatus: () => "denied" };
  const lastDenied = setup.emptyLastDenied();
  setup.rememberOsDenied(lastDenied, "mic", deniedPrefs);
  assert.equal(lastDenied.mic, true);
  const unknownPrefs = { getMediaAccessStatus: () => "not-determined" };
  // Flicker to unknown does not clear the denial right away.
  const decision = setup.waitAccessDecision("mic", unknownPrefs, lastDenied, 0, { stepMs: 500, stableMs: 1500 });
  assert.equal(decision.done, false);
  const grantedPrefs = { getMediaAccessStatus: () => "granted" };
  const ok = setup.waitAccessDecision("mic", grantedPrefs, lastDenied, 0, { stepMs: 500, stableMs: 1500 });
  assert.equal(ok.done, true);
  assert.equal(ok.ok, true);
});

test("usableWorkArea trims a dock when workArea equals the display", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const work = usableWorkArea({ x: 0, y: 0, width: 1920, height: 1080 }, display);
  assert.equal(work.height, 1080 - 40);
  const real = usableWorkArea({ x: 0, y: 0, width: 1920, height: 1040 }, display);
  assert.equal(real.height, 1040);
});

test("capture filter keeps screens, drops junk windows and our overlays", () => {
  assert.equal(keepCaptureSource({ id: "screen:1:0", name: "Screen 1" }), true);
  assert.equal(keepCaptureSource({ id: "window:1:0", name: "Recorder bar" }), false);
  assert.equal(keepCaptureSource({ id: "window:2:0", name: "Recorder area" }), false);
  assert.equal(keepCaptureSource({ id: "window:3:0", name: "Program Manager" }), false);
  assert.equal(keepCaptureSource({ id: "window:4:0", name: "com.acme.app" }), false);
  assert.equal(keepCaptureSource({ id: "window:5:0", name: "Notepad" }), true);
});

test("the recordings library is one Simple recorder folder under Videos", () => {
  const videos = "C:\\Users\\Example\\Videos";
  const userData = "C:\\Users\\Example\\AppData\\Roaming\\Simple Recorder";
  assert.equal(library.LIBRARY_FOLDER_NAME, "Simple recorder");
  assert.equal(library.libraryRoot(videos, userData), path.join(videos, "Simple recorder"));
  // No Videos known folder: the app's own userData, still one folder of the
  // same name, so the layout never splits.
  assert.equal(library.libraryRoot("", userData), path.join(userData, "Simple recorder"));
});

test("day folders name the local recording day", () => {
  assert.equal(library.dayFolderName(new Date(2026, 9, 12, 23, 30)), "2026-10-12");
  assert.equal(library.dayFolderName(new Date(2026, 0, 3, 0, 1)), "2026-01-03");
  assert.equal(library.dayFolderName("nope"), "");
  assert.equal(library.isDayFolderName("2026-10-12"), true);
  assert.equal(library.isDayFolderName("October"), false);
  const root = path.join("C:\\Users\\Example\\Videos", "Simple recorder");
  assert.equal(library.dayFolderFor(root, new Date(2026, 0, 3, 4, 5)), path.join(root, "2026-01-03"));
  // A date that will not parse stays in the root instead of inventing a folder.
  assert.equal(library.dayFolderFor(root, "nope"), root);
  assert.equal(library.isInLibrary(root, path.join(root, "2026-10-12", "a.webm")), true);
  assert.equal(library.isInLibrary(root, path.join(path.dirname(root), "loose.webm")), false);
});

test("a finished take is written inside the folder for its day", async () => {
  const videos = tempDir();
  const root = library.libraryRoot(videos, "");
  const dir = library.dayFolderFor(root, new Date(2026, 9, 12, 9, 30));
  fs.mkdirSync(dir, { recursive: true });
  const first = await library.uniqueTakePath(dir, "Screen take 1", ".webm");
  assert.equal(first, path.join(root, "2026-10-12", "Screen take 1.webm"));
  fs.writeFileSync(first, "video");
  // The same name again bumps instead of overwriting the take already there.
  const second = await library.uniqueTakePath(dir, "Screen take 1", ".webm");
  assert.equal(second, path.join(root, "2026-10-12", "Screen take 1 2.webm"));
  assert.equal(fs.readFileSync(first, "utf8"), "video");
  assert.equal(fs.existsSync(path.join(root, "Screen take 1.webm")), false);
  fs.rmSync(videos, { recursive: true, force: true });
});

test("the take list is grouped by the day folder each file sits in", async () => {
  const videos = tempDir();
  const root = library.libraryRoot(videos, "");
  const grouped = path.join(root, "2026-10-12", "Screen take 1.webm");
  const older = path.join(root, "2026-10-11", "Screen take 2.webm");
  const loose = path.join(root, "Screen take 3.webm");
  for (const file of [grouped, older, loose]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, path.basename(file));
  }
  const takes = [
    { id: "a", path: grouped, createdAt: "2026-10-12T10:00:00Z" },
    { id: "b", path: older, createdAt: "2026-10-11T10:00:00Z" },
    { id: "c", path: loose, createdAt: new Date(2026, 9, 12, 11, 0).toISOString() },
  ];
  // What the page shows for a take already in a day folder is the folder name
  // on disk, so the list and Explorer cannot drift apart.
  assert.equal(library.dayKeyForTake(root, takes[0]), "2026-10-12");
  assert.equal(library.dayKeyForTake(root, takes[1]), "2026-10-11");
  // A loose one falls back to the day it was recorded, until the sweep moves it.
  assert.equal(library.dayKeyForTake(root, takes[2]), "2026-10-12");

  const moved = await library.migrateLibrary(root, takes);
  assert.equal(moved.moves.length, 1);
  assert.equal(moved.moves[0].id, "c");
  assert.equal(moved.moves[0].to, path.join(root, "2026-10-12", "Screen take 3.webm"));
  for (const take of takes) {
    const row = take.id === "c" ? { ...take, path: moved.moves[0].to } : take;
    assert.equal(path.basename(path.dirname(row.path)), library.dayKeyForTake(root, row));
  }
  fs.rmSync(videos, { recursive: true, force: true });
});

test("a loose take moves into its day folder once, and the second sweep is a no-op", async () => {
  const videos = tempDir();
  const root = library.libraryRoot(videos, "");
  fs.mkdirSync(root, { recursive: true });
  const loose = path.join(root, "Screen take 4.webm");
  fs.writeFileSync(loose, "footage");
  const take = { id: "t1", name: "Screen take 4", path: loose, createdAt: new Date(2026, 9, 12, 8, 5).toISOString() };

  const first = await library.migrateLibrary(root, [take]);
  assert.equal(first.moves.length, 1);
  const movedTo = first.moves[0].to;
  assert.equal(movedTo, path.join(root, "2026-10-12", "Screen take 4.webm"));
  assert.equal(fs.readFileSync(movedTo, "utf8"), "footage");
  assert.equal(fs.existsSync(loose), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-10-12")), ["Screen take 4.webm"]);

  // The row follows the file, and the second sweep finds nothing loose.
  const row = { ...take, path: movedTo, name: first.moves[0].name };
  assert.deepEqual(await library.migrateLibrary(root, [row]), { moves: [], repointed: [], adopted: [], failed: [] });
  assert.equal(fs.readFileSync(movedTo, "utf8"), "footage");
  assert.deepEqual(fs.readdirSync(path.join(root, "2026-10-12")), ["Screen take 4.webm"]);
  fs.rmSync(videos, { recursive: true, force: true });
});

test("a row spelling that drifted from disk still finds its own take", { skip: !CASELESS }, async () => {
  const videos = tempDir();
  const root = library.libraryRoot(videos, "");
  const dir = path.join(root, "2026-10-12");
  fs.mkdirSync(dir, { recursive: true });
  const grouped = path.join(dir, "Screen take 5.webm");
  const loose = path.join(root, "Screen take 6.webm");
  fs.writeFileSync(grouped, "grouped");
  fs.writeFileSync(loose, "loose");
  // Both rows were written while the library folder was spelled with a
  // capital R, which is the same folder here but a different string.
  const oldRoot = path.join(videos, "Simple Recorder");
  const groupedRow = {
    id: "g",
    path: path.join(oldRoot, "2026-10-12", "Screen take 5.webm"),
    createdAt: "2026-10-12T10:00:00.000Z",
  };
  const looseRow = {
    id: "l",
    path: path.join(oldRoot, "Screen take 6.webm"),
    createdAt: new Date(2026, 9, 12, 9, 0).toISOString(),
  };

  // The day shown for a take already in a day folder comes off its path, not
  // off the recording date, whatever the row says the root is spelled.
  assert.equal(library.dayKeyForTake(root, groupedRow), "2026-10-12");
  assert.equal(library.dayKeyForTake(root, { ...groupedRow, createdAt: "2025-01-05T10:00:00.000Z" }), "2026-10-12");
  assert.equal(library.samePath(root, oldRoot), true);

  // fs.realpath only folds a row's casing back to the disk spelling on some
  // Windows hosts (CI runners return the queried casing), so pin the disk
  // spelling with an injected realpath; the behavior under test is the
  // repoint, not the OS call.
  const diskSpelling = async (p) =>
    p.toLowerCase().startsWith(oldRoot.toLowerCase() + path.sep.toLowerCase())
      ? root + p.slice(oldRoot.length)
      : p;
  const result = await library.migrateLibrary(root, [groupedRow, looseRow], { realpath: diskSpelling });
  // The loose one is a move, not an unclaimed file: its row follows the file
  // instead of being pruned by the next list.
  assert.deepEqual(
    result.moves.map((move) => move.id),
    ["l"],
  );
  assert.equal(result.moves[0].to, path.join(dir, "Screen take 6.webm"));
  assert.deepEqual(result.adopted, []);
  // Both rows carry the old spelling, so both are re-pointed; the caller
  // applies these before the moves, which is what leaves each row on the
  // path its file really has.
  assert.deepEqual(
    result.repointed.map((row) => row.id).sort(),
    ["g", "l"],
  );
  const rows = new Map([
    [groupedRow.id, groupedRow.path],
    [looseRow.id, looseRow.path],
  ]);
  for (const row of result.repointed) rows.set(row.id, row.to);
  for (const move of result.moves) rows.set(move.id, move.to);
  assert.equal(rows.get("g"), grouped);
  assert.equal(rows.get("l"), path.join(dir, "Screen take 6.webm"));
  assert.equal(fs.readFileSync(grouped, "utf8"), "grouped");
  assert.equal(fs.existsSync(path.join(root, "Screen take 6.webm")), false);
  fs.rmSync(videos, { recursive: true, force: true });
});

test("the sweep adopts recorder-named files and leaves anything else alone", async () => {
  const videos = tempDir();
  const root = library.libraryRoot(videos, "");
  fs.mkdirSync(root, { recursive: true });
  const recovered = path.join(root, "Recovered take 3.webm");
  const partial = path.join(root, "Screen take 7 (partial).webm");
  const mine = path.join(root, "holiday.mp4");
  const notes = path.join(root, "notes.txt");
  for (const file of [recovered, partial, mine, notes]) fs.writeFileSync(file, path.basename(file));

  const result = await library.migrateLibrary(root, []);
  assert.equal(result.moves.length, 0);
  assert.deepEqual(
    result.adopted.map((item) => path.basename(item.to)).sort(),
    ["Recovered take 3.webm", "Screen take 7 (partial).webm"],
  );
  assert.equal(fs.existsSync(recovered), false);
  assert.equal(fs.existsSync(partial), false);
  // A file this app never wrote stays exactly where the user put it.
  assert.equal(fs.readFileSync(mine, "utf8"), "holiday.mp4");
  assert.equal(fs.existsSync(notes), true);
  const days = fs.readdirSync(root).filter((name) => library.isDayFolderName(name));
  assert.equal(days.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, days[0])).sort(), [
    "Recovered take 3.webm",
    "Screen take 7 (partial).webm",
  ]);
  fs.rmSync(videos, { recursive: true, force: true });
});

test("a take stays in place when the move cannot be verified", async () => {
  const root = path.resolve("C:/lib");
  const file = path.join(root, "Screen take 1.webm");
  const take = { id: "a", name: "Screen take 1", path: file, createdAt: new Date(2026, 9, 12).toISOString() };
  const base = {
    readdir: async (dir) => (path.resolve(dir) === root ? ["Screen take 1.webm"] : []),
    mkdir: async () => {},
    stat: async () => ({ isFile: () => true, size: 7 }),
  };
  let unlinked = 0;
  const unlink = async () => {
    unlinked += 1;
  };
  // A locked file: the rename is refused and there is no copy to fall back on.
  const locked = await library.migrateLibrary(root, [take], {
    ...base,
    unlink,
    rename: async () => {
      throw Object.assign(new Error("busy"), { code: "EPERM" });
    },
    copyFile: async () => {
      throw new Error("no copy");
    },
  });
  assert.deepEqual(locked.moves, []);
  assert.equal(locked.failed.length, 1);
  // A rename that lands a different number of bytes is not trusted either.
  const short = await library.migrateLibrary(root, [take], {
    ...base,
    unlink,
    rename: async () => {},
    copyFile: async () => {},
    stat: async (target) => ({ isFile: () => true, size: path.resolve(target) === file ? 7 : 3 }),
  });
  assert.deepEqual(short.moves, []);
  assert.equal(short.failed.length, 1);
  // The source is never removed before the destination verifies.
  assert.equal(unlinked, 0);
});

test("the library folder is renamed to the exact name, once", async () => {
  const parent = tempDir();
  const old = path.join(parent, "Simple Recorder");
  fs.mkdirSync(path.join(old, "2026-10-12"), { recursive: true });
  fs.writeFileSync(path.join(old, "2026-10-12", "Screen take 1.webm"), "video");

  const done = await library.adoptLibraryRootName(parent, library.LIBRARY_FOLDER_NAME);
  assert.equal(done.renamed, true);
  assert.deepEqual(fs.readdirSync(parent), ["Simple recorder"]);
  // The footage survives the rename, and a second pass has nothing to do.
  assert.equal(fs.readFileSync(path.join(parent, "Simple recorder", "2026-10-12", "Screen take 1.webm"), "utf8"), "video");
  assert.deepEqual(await library.adoptLibraryRootName(parent, library.LIBRARY_FOLDER_NAME), { ok: true, renamed: false });
  // No library on disk yet is not an error either.
  const empty = tempDir();
  assert.equal((await library.adoptLibraryRootName(empty, library.LIBRARY_FOLDER_NAME)).ok, true);
  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test("a folder that already carries the exact name is left alone", async () => {
  const parent = path.resolve("C:/videos");
  const targets = [];
  const rename = async (_from, to) => {
    targets.push(path.basename(to));
  };
  // Both spellings exist as folders of their own (Linux keeps them apart),
  // so there is nothing to fix and nothing to step aside for.
  const both = await library.adoptLibraryRootName(parent, library.LIBRARY_FOLDER_NAME, {
    readdir: async () => ["Simple Recorder", library.LIBRARY_FOLDER_NAME],
    rename,
  });
  assert.deepEqual(both, { ok: false, renamed: false, from: "" });
  assert.deepEqual(targets, ["Simple recorder"]);
  // A rename that leaves the old spelling in place is not a fix either.
  const stuck = await library.adoptLibraryRootName(parent, library.LIBRARY_FOLDER_NAME, {
    readdir: async () => ["Simple Recorder"],
    rename,
  });
  assert.deepEqual(stuck, { ok: false, renamed: false, from: "" });
  assert.deepEqual(targets, ["Simple recorder", "Simple recorder", "Simple recorder.renaming"]);
});

test("db re-points a take row after its file moved", () => {
  const dir = tempDir();
  db.openDb(dir);
  db.insertTake({
    id: "m",
    name: "Screen take 1",
    path: "C:\\v\\Screen take 1.webm",
    mime: "video/webm",
    size: 5,
    durationMs: 0,
    createdAt: "2026-10-12T08:00:00Z",
  });
  db.updateTakeFile("m", "C:\\v\\2026-10-12\\Screen take 1 2.webm", "Screen take 1 2");
  const row = db.getTake("m");
  assert.equal(row.path, "C:\\v\\2026-10-12\\Screen take 1 2.webm");
  assert.equal(row.name, "Screen take 1 2");
  assert.equal(row.size, 5);
  db.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("updater normalizes versions, tags, and sorts GitHub releases newest first", () => {
  assert.equal(updater.normalizeVersion("v1.2.3"), "1.2.3");
  assert.equal(updater.normalizeVersion("1.0.0-beta.1"), "1.0.0-beta.1");
  assert.equal(updater.normalizeVersion("not-a-version"), "");
  assert.equal(updater.formatTag("1.4.0"), "v1.4.0");
  assert.equal(updater.compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(updater.compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(updater.compareVersions("1.0.0", "1.0.0-beta.1"), 1);

  const list = updater.normalizeReleaseList([
    { tag_name: "v1.0.0", name: "v1.0.0", published_at: "2026-10-10T00:00:00Z", assets: [] },
    { tag_name: "v1.2.0", name: "v1.2.0", draft: true, assets: [] },
    {
      tag_name: "v1.1.0",
      name: "v1.1.0",
      published_at: "2026-10-12T00:00:00Z",
      assets: [
        { id: 10, name: "simple-recorder-v1.1.0-app.tar.gz", size: 4096, url: "https://api.example/assets/10" },
        { id: 11, name: "latest.json", size: 128, url: "https://api.example/assets/11" },
      ],
    },
  ]);
  assert.deepEqual(
    list.map((r) => r.tag),
    ["v1.1.0", "v1.0.0"],
  );
  assert.equal(list[0].bundle.name, "simple-recorder-v1.1.0-app.tar.gz");
  assert.equal(list[0].manifest.name, "latest.json");
});

test("updater packs and extracts tar.gz bundles and strips nested tarball roots", () => {
  const gz = updater.packTarGz([
    { path: "Josephivgi-simple-recorder-abc1234/package.json", data: '{"name":"simple-recorder","version":"1.0.5"}' },
    { path: "Josephivgi-simple-recorder-abc1234/electron/main.cjs", data: "// main" },
    { path: "Josephivgi-simple-recorder-abc1234/renderer/app.js", data: "// app" },
  ]);
  const entries = updater.unpackTarGz(gz);
  assert.deepEqual(
    entries.map((e) => e.path).sort(),
    ["electron/main.cjs", "package.json", "renderer/app.js"],
  );
  assert.equal(updater.isAllowedAppPath("package.json"), true);
  assert.equal(updater.isAllowedAppPath("renderer/app.js"), true);
  assert.equal(updater.isAllowedAppPath("../outside.js"), false);
  assert.equal(updater.isAllowedAppPath(".git/config"), false);
  assert.equal(updater.isAllowedAppPath("node_modules/x/index.js"), false);
});

test("updater offers the latest release and installs the one that was asked for", async () => {
  const root = tempDir();
  const appRoot = path.join(root, "app");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(path.join(appRoot, "electron"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "lib"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "renderer"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.0.0" }));
  fs.writeFileSync(path.join(appRoot, "electron", "main.cjs"), "// v1.0.0 main");
  fs.writeFileSync(path.join(appRoot, "lib", "updater.js"), "// v1.0.0 lib");
  fs.writeFileSync(path.join(appRoot, "renderer", "app.js"), "// v1.0.0 app");
  fs.writeFileSync(path.join(appRoot, "renderer", "index.html"), "<!doctype html><title>v1.0.0</title>");

  // Build two release bundles (v1.0.0 and v1.0.1).
  const bundle100 = await updater.createUpdateBundle(appRoot, path.join(root, "v1.0.0.tar.gz"), { version: "1.0.0" });
  fs.writeFileSync(path.join(appRoot, "renderer", "app.js"), "// v1.0.1 app updated");
  const bundle101 = await updater.createUpdateBundle(appRoot, path.join(root, "v1.0.1.tar.gz"), { version: "1.0.1" });
  const writeManifest = (bundle, tag) => {
    const file = path.join(root, "latest-" + tag + ".json");
    fs.writeFileSync(file, JSON.stringify({ assetName: "simple-recorder-" + tag + "-app.tar.gz", sha256: bundle.sha256 }));
    return file;
  };
  const manifest100 = writeManifest(bundle100, "v1.0.0");
  const manifest101 = writeManifest(bundle101, "v1.0.1");
  // Restore appRoot back to 1.0.0 before starting updater.
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.0.0" }));
  fs.writeFileSync(path.join(appRoot, "renderer", "app.js"), "// v1.0.0 app");

  db.openDb(dataRoot);
  const fakeReleases = [
    {
      tag_name: "v1.0.1",
      name: "Simple Recorder v1.0.1",
      published_at: "2026-10-13T12:00:00Z",
      assets: [
        { id: 2, name: "simple-recorder-v1.0.1-app.tar.gz", size: bundle101.size, browser_download_url: bundle101.path },
        { id: 3, name: "latest.json", size: 1, browser_download_url: manifest101 },
      ],
    },
    {
      tag_name: "v1.0.0",
      name: "Simple Recorder v1.0.0",
      published_at: "2026-10-12T12:00:00Z",
      assets: [
        { id: 1, name: "simple-recorder-v1.0.0-app.tar.gz", size: bundle100.size, browser_download_url: bundle100.path },
        { id: 4, name: "latest.json", size: 1, browser_download_url: manifest100 },
      ],
    },
  ];

  const mgr = updater.createUpdater({
    appRoot,
    dataRoot,
    store: db,
    fetchReleases: async () => fakeReleases,
    // Feed-file test mode: the only mode that installs from local bundle paths.
    feedFile: path.join(root, "feed.json"),
    // This tree is not an install folder, so say explicitly that it is a
    // normal end-user install: those ping GitHub Releases on their own.
    installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
  });

  assert.equal(mgr.getStatus().currentVersion, "1.0.0");
  assert.equal(mgr.getStatus().installMode, "installed");
  assert.equal(mgr.getStatus().autoCheck, true);

  // A check offers the newer release but never installs it on its own.
  const afterCheck = await mgr.checkForUpdates();
  assert.equal(afterCheck.updateAvailable, true);
  assert.equal(afterCheck.latestTag, "v1.0.1");
  assert.equal(afterCheck.currentVersion, "1.0.0");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version,
    "1.0.0",
  );
  // Downloading it installs v1.0.1 and asks for a restart.
  const afterInstall = await mgr.installRelease({ tag: afterCheck.latestTag });
  assert.equal(afterInstall.currentVersion, "1.0.1");
  assert.equal(afterInstall.currentTag, "v1.0.1");
  assert.equal(afterInstall.status, "installed");
  assert.equal(afterInstall.needsRestart, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version, "1.0.1");
  assert.equal(fs.readFileSync(path.join(appRoot, "renderer", "app.js"), "utf8"), "// v1.0.1 app updated");

  // Asking for a specific older release switches back to v1.0.0.
  const afterDowngrade = await mgr.installRelease({ tag: "v1.0.0" });
  assert.equal(afterDowngrade.currentVersion, "1.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(fs.readFileSync(path.join(appRoot, "renderer", "app.js"), "utf8"), "// v1.0.0 app");

  // Persisted update prefs in SQLite remember the releases and installed version.
  const savedPrefs = db.readUpdatePrefs();
  assert.equal(savedPrefs.installedVersion, "1.0.0");
  assert.equal(savedPrefs.releases.length, 2);

  db.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// A local stand-in for the GitHub API that records the headers it was sent.
async function withHeaderServer(body, run) {
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    const out = typeof body === "function" ? body(req) : body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(typeof out === "string" ? out : JSON.stringify(out));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run("http://127.0.0.1:" + server.address().port, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("public update checks never send a GitHub token, even when one is lying around", async () => {
  const root = tempDir();
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = "env-token-that-must-not-leave";
  process.env.GITHUB_TOKEN = "env-token-that-must-not-leave";
  let askedForSignIn = 0;
  try {
    await withHeaderServer([{ tag_name: "v9.0.0", name: "v9.0.0", assets: [] }], async (apiBase, seen) => {
      const mgr = updater.createUpdater({
        appRoot: path.join(root, "app"),
        dataRoot: path.join(root, "data"),
        apiBase,
        // A token passed by a caller is dropped on the public channel too.
        token: "caller-token-that-must-not-leave",
        resolveDeveloperToken: async () => {
          askedForSignIn += 1;
          return "developer-token";
        },
        installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
      });
      const state = await mgr.checkForUpdates();
      assert.equal(state.channel, "public");
      assert.equal(state.repo, updater.DEFAULT_REPO);
      assert.equal(state.latestTag, "v9.0.0");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/repos/" + updater.DEFAULT_REPO + "/releases?per_page=25");
      assert.equal(seen[0].authorization, "", "the public channel must be anonymous");
      assert.equal(askedForSignIn, 0, "the public channel must never look for a developer sign-in");
    });

    // A token never travels over plain HTTP or to a host other than the GitHub API.
    const sha256 = require("crypto").createHash("sha256").update("bundle-bytes").digest("hex");
    const serve = (req) => (req.url === "/latest.json" ? { assetName: "pkg.tar.gz", sha256 } : "bundle-bytes");
    await withHeaderServer(serve, async (base, seen) => {
      const body = await updater.downloadReleaseArchive(
        {
          tag: "v9.0.0",
          bundle: { name: "pkg.tar.gz", apiUrl: base + "/asset", downloadUrl: base + "/asset" },
          manifest: { name: "latest.json", apiUrl: base + "/latest.json", downloadUrl: base + "/latest.json" },
        },
        { token: "developer-token" },
      );
      assert.equal(String(body), "bundle-bytes");
      assert.deepEqual(seen.map((s) => s.url), ["/asset", "/latest.json"]);
      assert.deepEqual(seen.map((s) => s.authorization), ["", ""]);
    });

    // A package without a latest.json to check it against is refused.
    await assert.rejects(
      updater.downloadReleaseArchive({ tag: "v9.0.0", bundle: { name: "pkg.tar.gz", downloadUrl: "http://127.0.0.1:9/asset" } }, {}),
      /has no latest\.json/,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an update package must match the sha256 in its release's latest.json", () => {
  const crypto = require("crypto");
  const gz = Buffer.from("package-bytes");
  const sha256 = crypto.createHash("sha256").update(gz).digest("hex");
  const release = { tag: "v9.0.0", bundle: { name: "simple-recorder-v9.0.0-app.tar.gz" } };
  const manifest = (extra) => JSON.stringify(Object.assign({ assetName: release.bundle.name, sha256 }, extra));

  assert.equal(updater.verifyArchiveHash(gz, manifest(), release), sha256);
  assert.throws(() => updater.verifyArchiveHash(Buffer.from("tampered"), manifest(), release), /does not match its sha256/);
  assert.throws(() => updater.verifyArchiveHash(gz, manifest({ sha256: "" }), release), /has no sha256/);
  assert.throws(() => updater.verifyArchiveHash(gz, manifest({ assetName: "other.tar.gz" }), release), /different package/);
  assert.throws(() => updater.verifyArchiveHash(gz, "not json", release), /not valid JSON/);
});

test("a release list cannot point an install at a file already on disk", async () => {
  const root = tempDir();
  const local = path.join(root, "local.tar.gz");
  const localManifest = path.join(root, "latest.json");
  fs.writeFileSync(local, "local-bytes");
  const sha256 = require("crypto").createHash("sha256").update("local-bytes").digest("hex");
  fs.writeFileSync(localManifest, JSON.stringify({ sha256 }));
  const release = { tag: "v9.0.0", bundle: { downloadUrl: local }, manifest: { downloadUrl: localManifest } };
  const saved = process.env.REC_UPDATE_FEED_FILE;
  delete process.env.REC_UPDATE_FEED_FILE;
  try {
    await assert.rejects(updater.downloadReleaseArchive(release, {}));
    await assert.rejects(updater.downloadReleaseArchive({ tag: "v9.0.0", tarballUrl: local }, {}), /No update package/);
    const body = await updater.downloadReleaseArchive(release, { feedFile: path.join(root, "feed.json") });
    assert.equal(String(body), "local-bytes");
  } finally {
    if (saved === undefined) delete process.env.REC_UPDATE_FEED_FILE;
    else process.env.REC_UPDATE_FEED_FILE = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Developer mode updates read the private development repo with the developer sign-in", async () => {
  const root = tempDir();
  const dataRoot = path.join(root, "data");
  db.openDb(dataRoot);
  const calls = [];
  let signIn = "";
  const mgr = updater.createUpdater({
    appRoot: path.join(root, "app"),
    dataRoot,
    store: db,
    resolveDeveloperToken: async () => signIn,
    fetchReleases: async (repo, opts) => {
      calls.push({ repo, token: opts.token || "" });
      return repo === updater.DEV_REPO
        ? [{ tag_name: "v2.0.1", name: "dev build", assets: [] }]
        : [{ tag_name: "v2.0.0", name: "public build", assets: [] }];
    },
    installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
  });

  // Off by default: public releases, anonymous.
  assert.equal(mgr.getStatus().developerMode, false);
  assert.equal((await mgr.checkForUpdates()).latestTag, "v2.0.0");
  assert.deepEqual(calls.pop(), { repo: updater.DEFAULT_REPO, token: "" });

  // On without a sign-in: an error that says how to get back to public releases.
  const noSignIn = await mgr.setDeveloperMode(true);
  assert.equal(noSignIn.developerMode, true);
  assert.equal(noSignIn.channel, "developer");
  assert.equal(noSignIn.status, "error");
  assert.match(noSignIn.error, /gh auth login/);
  assert.match(noSignIn.error, /Turn Developer mode updates off/);
  assert.equal(calls.length, 0, "no request goes out without the developer sign-in");
  assert.equal(db.readUpdatePrefs().developerMode, true, "the switch is stored in SQLite");

  // Signed in: the development repo, with the sign-in attached.
  signIn = "developer-token";
  const dev = await mgr.checkForUpdates();
  assert.equal(dev.latestTag, "v2.0.1");
  assert.deepEqual(calls.pop(), { repo: updater.DEV_REPO, token: "developer-token" });

  // A fresh updater (next launch) comes back on the stored channel.
  const relaunched = updater.createUpdater({
    appRoot: path.join(root, "app"),
    dataRoot,
    store: db,
    resolveDeveloperToken: async () => signIn,
    fetchReleases: async () => [],
    installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
  });
  assert.equal(relaunched.getStatus().developerMode, true);
  assert.equal(relaunched.getStatus().repo, updater.DEV_REPO);

  // Off again: back to public releases, anonymous, and stored.
  const back = await mgr.setDeveloperMode(false);
  assert.equal(back.channel, "public");
  assert.equal(back.latestTag, "v2.0.0");
  assert.deepEqual(calls.pop(), { repo: updater.DEFAULT_REPO, token: "" });
  assert.equal(db.readUpdatePrefs().developerMode, false);

  db.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the Settings page carries the Developer mode updates switch and its warning", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.match(html, /data-page="settings"/);
  assert.match(html, /data-dev-updates-switch/);
  assert.match(html, /Do not turn this on/);
  assert.match(html, /not a public release/);
  assert.match(html, /GitHub\s+OAuth/);
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  assert.match(preload, /update-set-developer-mode/);
});

test("shipped app code only reads a GitHub token for Developer mode updates", () => {
  const root = path.join(__dirname, "..");
  const files = [];
  for (const dir of ["electron", "lib", "renderer"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) files.push(path.join(dir, name));
  }
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(text, /process\.env\.(GH_TOKEN|GITHUB_TOKEN|REC_GITHUB_TOKEN)/, rel + " reads a token from the environment");
    if (rel !== path.join("lib", "updater.js")) {
      assert.doesNotMatch(text, /["']auth["'],\s*["']token["']/, rel + " asks the GitHub CLI for a token");
    }
  }
  const installer = fs.readFileSync(path.join(root, "scripts", "install.cjs"), "utf8");
  assert.doesNotMatch(installer, /execFileSync\("gh"/, "the installer must not call the GitHub CLI");
});

test("a newer build's data survives an older build, and every snapshot is a checked copy", () => {
  const root = tempDir();
  const dataRoot = path.join(root, "data");
  db.openDb(dataRoot);
  db.closeDb();
  // What a newer build might have written: a table, a column with a default,
  // a kv key, and a higher schema mark.
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dataRoot, "recorder.db"));
  raw.exec("CREATE TABLE future_things (id TEXT PRIMARY KEY, note TEXT)");
  raw.exec("INSERT INTO future_things VALUES ('a', 'kept')");
  raw.exec("ALTER TABLE takes ADD COLUMN future_flag INTEGER NOT NULL DEFAULT 7");
  raw.exec(
    "INSERT INTO kv VALUES ('futurePref', 'on'), ('schemaVersion', '99') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  raw.close();

  db.openDb(dataRoot);
  assert.deepEqual(db.schemaInfo(), { schemaVersion: db.SCHEMA_VERSION, dbSchemaVersion: 99, newerData: true });
  // An older build does its normal writes.
  db.writeSetup({ screen: true, mic: false, recordFps: 60 });
  db.writeUpdatePrefs({ developerMode: false, installedChannel: "public", installedVersion: "1.2.0" });
  db.insertTake({ id: "t1", name: "Take", path: "x.mp4", mime: "video/mp4" });

  const backup = path.join(dataRoot, "backups", "copy.db");
  const snap = db.snapshotDb(backup);
  assert.equal(snap.file, backup);
  assert.ok(snap.size > 0);
  assert.throws(() => db.snapshotDb(backup), /already exists/);
  db.closeDb();

  for (const file of [path.join(dataRoot, "recorder.db"), backup]) {
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare("SELECT note FROM future_things WHERE id = 'a'").get().note, "kept");
    assert.equal(check.prepare("SELECT value FROM kv WHERE key = 'futurePref'").get().value, "on");
    assert.equal(check.prepare("SELECT value FROM kv WHERE key = 'schemaVersion'").get().value, "99");
    assert.equal(check.prepare("SELECT future_flag FROM takes WHERE id = 't1'").get().future_flag, 7);
    assert.equal(check.prepare("SELECT value FROM kv WHERE key = 'updateInstalledChannel'").get().value, "public");
    check.close();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// A release on disk with its latest.json, for the feed-file test mode.
async function localRelease(root, appRoot, tag, marker) {
  fs.writeFileSync(path.join(appRoot, "renderer", "app.js"), "// " + marker);
  const bundle = await updater.createUpdateBundle(appRoot, path.join(root, marker + ".tar.gz"), { version: tag.slice(1) });
  const assetName = "simple-recorder-" + tag + "-app.tar.gz";
  const manifest = path.join(root, marker + "-latest.json");
  fs.writeFileSync(manifest, JSON.stringify({ assetName, sha256: bundle.sha256 }));
  return {
    tag_name: tag,
    name: "Simple Recorder " + tag,
    published_at: "2026-10-15T00:00:00Z",
    assets: [
      { id: marker + "-a", name: assetName, size: bundle.size, browser_download_url: bundle.path },
      { id: marker + "-m", name: "latest.json", size: 1, browser_download_url: manifest },
    ],
  };
}

function updaterAppRoot(root) {
  const appRoot = path.join(root, "app");
  for (const dir of ["electron", "lib", "renderer"]) fs.mkdirSync(path.join(appRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "electron", "main.cjs"), "// main");
  fs.writeFileSync(path.join(appRoot, "lib", "updater.js"), "// lib");
  fs.writeFileSync(path.join(appRoot, "renderer", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "simple-recorder", version: "1.0.0" }));
  return appRoot;
}

function setAppVersion(appRoot, version, marker) {
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "simple-recorder", version }));
  fs.writeFileSync(path.join(appRoot, "renderer", "app.js"), "// " + marker);
}

test("a copy moves between public and developer builds and back, saving its data each time", async () => {
  const root = tempDir();
  const appRoot = updaterAppRoot(root);
  const dataRoot = path.join(root, "data");
  const feeds = {
    [updater.DEFAULT_REPO]: [await localRelease(root, appRoot, "v1.2.1", "public-121")],
    [updater.DEV_REPO]: [
      await localRelease(root, appRoot, "v1.2.2", "dev-122"),
      await localRelease(root, appRoot, "v1.2.1", "dev-121"),
    ],
  };
  setAppVersion(appRoot, "1.2.1", "public-121");

  db.openDb(dataRoot);
  db.kvSet("futurePref", "from-a-newer-build");
  const mgr = updater.createUpdater({
    appRoot,
    dataRoot,
    store: db,
    feedFile: path.join(root, "feed.json"),
    resolveDeveloperToken: async () => "developer-token",
    fetchReleases: async (repo) => feeds[repo],
    installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
  });
  const appJs = () => fs.readFileSync(path.join(appRoot, "renderer", "app.js"), "utf8");
  const backupDir = path.join(dataRoot, "backups");
  const backups = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []);

  // A public install on the newest public release: nothing to do.
  let s = await mgr.checkForUpdates();
  assert.equal(s.installedChannel, "public");
  assert.equal(s.updateAvailable, false);

  // Developer mode on: the newest developer build is offered as a switch.
  s = await mgr.setDeveloperMode(true);
  assert.equal(s.switchAvailable, true);
  assert.equal(s.latestTag, "v1.2.2");
  s = await mgr.installRelease({ tag: s.latestTag });
  assert.equal(s.error, "");
  assert.equal(s.installedChannel, "developer");
  assert.equal(s.currentTag, "v1.2.2");
  assert.equal(s.needsRestart, true);
  assert.equal(appJs(), "// dev-122");
  assert.equal(backups().length, 1);
  assert.match(backups()[0], /-public-v1\.2\.1-to-developer-v1\.2\.2\.db$/);

  // Developer mode off: the public release is offered even though it is older.
  s = await mgr.setDeveloperMode(false);
  assert.equal(s.switchAvailable, true);
  assert.equal(s.latestTag, "v1.2.1");
  s = await mgr.installRelease({ tag: s.latestTag });
  assert.equal(s.installedChannel, "public");
  assert.equal(s.currentTag, "v1.2.1");
  assert.equal(appJs(), "// public-121");
  assert.equal(backups().length, 2);
  assert.ok(backups().some((name) => /-developer-v1\.2\.2-to-public-v1\.2\.1\.db$/.test(name)));

  // Back on public nothing more is offered; with Developer mode on again, the
  // developer build this copy no longer has is offered again.
  s = await mgr.checkForUpdates();
  assert.equal(s.updateAvailable, false);
  s = await mgr.setDeveloperMode(true);
  assert.equal(s.switchAvailable, true);
  assert.equal(s.latestTag, "v1.2.2");
  assert.equal(db.readUpdatePrefs().installedChannel, "public");

  // Data from the newer build stayed through both switches, and each backup holds it.
  assert.equal(db.kvGet("futurePref", ""), "from-a-newer-build");
  const { DatabaseSync } = require("node:sqlite");
  for (const name of backups()) {
    const copy = new DatabaseSync(path.join(backupDir, name), { readOnly: true });
    assert.equal(copy.prepare("SELECT value FROM kv WHERE key = 'futurePref'").get().value, "from-a-newer-build");
    copy.close();
  }
  db.closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("nothing installs when the data copy fails, and a source checkout is never rewritten", async () => {
  const root = tempDir();
  const appRoot = updaterAppRoot(root);
  const feed = [await localRelease(root, appRoot, "v2.0.0", "new")];
  setAppVersion(appRoot, "1.0.0", "old");
  const appJs = () => fs.readFileSync(path.join(appRoot, "renderer", "app.js"), "utf8");
  const base = {
    appRoot,
    dataRoot: path.join(root, "data"),
    feedFile: path.join(root, "feed.json"),
    fetchReleases: async () => feed,
  };

  const failing = updater.createUpdater({
    ...base,
    store: {
      snapshotDb: () => {
        throw new Error("disk full");
      },
    },
    installInfo: { installed: true, owner: false, installDir: "", autoCheckDefault: true },
  });
  assert.equal((await failing.checkForUpdates()).updateAvailable, true);
  let s = await failing.installRelease({ tag: "v2.0.0" });
  assert.equal(s.status, "error");
  assert.match(s.error, /nothing was installed.*disk full/);
  assert.equal(appJs(), "// old");

  const checkout = updater.createUpdater({ ...base, installInfo: { installed: false, autoCheckDefault: false } });
  s = await checkout.checkForUpdates();
  assert.equal(s.updateAvailable, false);
  s = await checkout.installRelease({ tag: "v2.0.0" });
  assert.match(s.error, /source checkout/);
  assert.equal(appJs(), "// old");
  fs.rmSync(root, { recursive: true, force: true });
});


