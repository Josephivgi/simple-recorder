"use strict";

// Full screen and Area screenshots: a copy of the screen's pixels straight
// from Windows (GDI CopyFromScreen), with no mouse pointer in it, the way
// Print Screen does. desktopCapturer can take seconds per call on a busy
// machine, and a stream always draws the pointer in.
//
// PowerShell takes a second or more to start, so one hidden helper stays
// running while it is in use and quits after a quiet spell. Requests go in
// on its stdin as JSON lines, answers come back on stdout the same way. The
// helper writes the PNG to a temp file; the caller reads it.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const IDLE_CLOSE_MS = 600000;
// A screenshot waits this long for a helper that is still starting, then
// takes the slow path once; the helper keeps starting for the next one. On a
// busy PC PowerShell plus its C# compile can take well over that. A helper
// that never says it is ready is killed after HUNG_START_MS so the next
// screenshot starts a fresh one.
const START_WAIT_MS = 8000;
const HUNG_START_MS = 90000;
const COPY_TIMEOUT_MS = 8000;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class RecDpi {",
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  "}",
  "'@",
  // Per-monitor aware, so every screen is in real pixels.
  "try { [void][RecDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][RecDpi]::SetProcessDPIAware() }",
  // The first copy and PNG save are slow while .NET loads them; do a small
  // one now so the first real screenshot does not pay for it.
  "try { $wb = New-Object System.Drawing.Bitmap 64, 64; $wg = [System.Drawing.Graphics]::FromImage($wb); $wg.CopyFromScreen(0, 0, 0, 0, $wb.Size); $wg.Dispose(); $wm = New-Object System.IO.MemoryStream; $wb.Save($wm, [System.Drawing.Imaging.ImageFormat]::Png); $wb.Dispose(); $wm.Dispose() } catch { }",
  "$null = '{\"id\":0}' | ConvertFrom-Json; $null = @{ id = 0 } | ConvertTo-Json -Compress",
  "[Console]::Out.WriteLine('{\"ready\":true}')",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  $q = $null",
  "  try {",
  "    $q = $line | ConvertFrom-Json",
  "    $sw = [Diagnostics.Stopwatch]::StartNew()",
  "    $bmp = New-Object System.Drawing.Bitmap ([int]$q.w), ([int]$q.h)",
  "    $g = [System.Drawing.Graphics]::FromImage($bmp)",
  "    $g.CopyFromScreen([int]$q.x, [int]$q.y, 0, 0, $bmp.Size)",
  "    $g.Dispose()",
  "    $c = $sw.ElapsedMilliseconds",
  "    $bmp.Save([string]$q.out, [System.Drawing.Imaging.ImageFormat]::Png)",
  "    $bmp.Dispose()",
  "    [Console]::Out.WriteLine((@{ id = $q.id; ok = $true; copy = $c; png = $sw.ElapsedMilliseconds - $c } | ConvertTo-Json -Compress))",
  "  } catch {",
  "    $id = 0; if ($q) { $id = $q.id }",
  "    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))",
  "  }",
  "}",
].join("\r\n");

function encodedCommand() {
  return Buffer.from(SCRIPT, "utf16le").toString("base64");
}

// A pixel rect is whole numbers, at least 1x1, and no bigger than 16K.
function cleanRect(rect) {
  const x = Math.round(Number(rect && rect.x));
  const y = Math.round(Number(rect && rect.y));
  const w = Math.round(Number(rect && rect.width));
  const h = Math.round(Number(rect && rect.height));
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1 || w > 16384 || h > 16384) return null;
  return { x, y, width: w, height: h };
}

function createScreenCopy({ log, spawnImpl, startWaitMs = START_WAIT_MS, hungStartMs = HUNG_START_MS } = {}) {
  const run = spawnImpl || spawn;
  let child = null;
  let ready = null;
  let buffer = "";
  let seq = 0;
  const pending = new Map();
  let idleTimer = null;
  let disposed = false;

  function note(event, detail) {
    try {
      if (typeof log === "function") log(event, detail);
    } catch {
      /* best effort */
    }
  }

  function failAll(message) {
    for (const [, wait] of pending) {
      clearTimeout(wait.timer);
      wait.reject(new Error(message));
    }
    pending.clear();
  }

  function onLine(line) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && msg.ready && ready && ready.resolveReady) {
      ready.resolveReady();
      return;
    }
    const wait = msg && pending.get(Number(msg.id));
    if (!wait) return;
    pending.delete(Number(msg.id));
    clearTimeout(wait.timer);
    if (msg.ok) wait.resolve(msg);
    else wait.reject(new Error(String(msg.error || "The screen copy failed.")));
  }

  function start() {
    if (disposed) return Promise.reject(new Error("closed"));
    if (child && ready) return ready.promise;
    buffer = "";
    const proc = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand()], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    const entry = {};
    entry.promise = new Promise((resolve, reject) => {
      entry.resolveReady = resolve;
      entry.rejectReady = reject;
    });
    entry.promise.catch(() => {});
    const hungTimer = setTimeout(() => {
      if (child !== proc) return;
      note("screen helper hung", "no ready line in " + hungStartMs + "ms");
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, hungStartMs);
    entry.promise.then(
      () => clearTimeout(hungTimer),
      () => clearTimeout(hungTimer),
    );
    ready = entry;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", () => {});
    const gone = (why) => {
      if (child !== proc) return;
      child = null;
      ready = null;
      entry.rejectReady(new Error(why));
      failAll(why);
    };
    proc.on("error", (error) => {
      note("screen helper error", (error && error.message) || error);
      gone("The screen helper could not start.");
    });
    proc.on("exit", (code) => gone("The screen helper stopped (" + code + ")."));
    return entry.promise;
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_CLOSE_MS);
  }

  // Start the helper ahead of a screenshot.
  function warm() {
    armIdle();
    return start().then(
      () => true,
      () => false,
    );
  }

  // rect: screen pixels (Windows virtual-screen coordinates).
  async function copy(rect) {
    const clean = cleanRect(rect);
    if (!clean) throw new Error("Bad screen rect.");
    armIdle();
    let waitTimer = null;
    try {
      await Promise.race([
        start(),
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => reject(new Error("The screen helper is still starting.")), startWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(waitTimer);
    }
    const proc = child;
    if (!proc) throw new Error("The screen helper stopped.");
    seq += 1;
    const id = seq;
    const out = path.join(os.tmpdir(), "simple-recorder-shot-" + randomUUID() + ".png");
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The screen copy took too long."));
      }, COPY_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
    proc.stdin.write(JSON.stringify({ id, x: clean.x, y: clean.y, w: clean.width, h: clean.height, out }) + "\n");
    try {
      const msg = await answer;
      const png = await fs.promises.readFile(out);
      return { png, width: clean.width, height: clean.height, timing: "copy=" + msg.copy + "ms png=" + msg.png + "ms" };
    } finally {
      fs.promises.unlink(out).catch(() => {});
    }
  }

  function close() {
    clearTimeout(idleTimer);
    const proc = child;
    child = null;
    if (ready) ready.rejectReady(new Error("closed"));
    ready = null;
    failAll("closed");
    if (proc) {
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }

  function dispose() {
    disposed = true;
    close();
  }

  return { warm, copy, close, dispose };
}

module.exports = { createScreenCopy, cleanRect, SCRIPT };
