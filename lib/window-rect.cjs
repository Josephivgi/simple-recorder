// On-screen rectangle for a top-level window, found by title.
//
// Chromium names desktopCapturer sources but never says where the window
// sits. A Window pick frames a crop on the screen, so the rect comes from
// Windows directly: a PowerShell probe enumerates visible top-level
// windows (EnumWindows + GetWindowRect, DWM cloak check) and this module
// matches the capture list's name against real window titles.
//
// The probe runs async (never sync PowerShell on a UI path) and costs
// roughly a second per call, which is fine for a click that reframes.

const { execFile } = require("child_process");

const PROBE_TIMEOUT_MS = 10000;

const SCRIPT = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public class WinEnum {",
  "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }",
  '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int c);',
  "}",
  "'@",
  "$list = New-Object 'System.Collections.Generic.List[object]'",
  "$cb = {",
  "  param($h, $l)",
  "  if (-not [WinEnum]::IsWindowVisible($h)) { return $true }",
  "  if ([WinEnum]::IsIconic($h)) { return $true }",
  "  $cloak = 0",
  "  [void][WinEnum]::DwmGetWindowAttribute($h, 14, [ref]$cloak, 4)",
  "  if ($cloak -ne 0) { return $true }",
  "  $len = [WinEnum]::GetWindowTextLength($h)",
  "  if ($len -le 0) { return $true }",
  "  $sb = New-Object System.Text.StringBuilder ($len + 1)",
  "  [void][WinEnum]::GetWindowText($h, $sb, $sb.Capacity)",
  "  $r = New-Object WinEnum+RECT",
  "  [void][WinEnum]::GetWindowRect($h, [ref]$r)",
  "  if (($r.R - $r.L) -le 0 -or ($r.B - $r.T) -le 0) { return $true }",
  "  $list.Add([pscustomobject]@{ title = $sb.ToString(); x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T })",
  "  return $true",
  "}",
  "[void][WinEnum]::EnumWindows($cb, [IntPtr]::Zero)",
  "$list | ConvertTo-Json -Compress",
].join("\r\n");

function parseRects(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item) => ({
      title: String(item && item.title || ""),
      x: Number(item && item.x),
      y: Number(item && item.y),
      width: Number(item && item.w),
      height: Number(item && item.h),
    }))
    .filter((rect) =>
      rect.title &&
      Number.isFinite(rect.x) && Number.isFinite(rect.y) &&
      rect.width > 0 && rect.height > 0
    );
}

// Exact title match first (desktopCapturer names are window titles), then
// a contains match; ties go to the larger window.
function bestRect(rects, needle) {
  const lower = needle.toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const rect of rects) {
    const title = rect.title.toLowerCase();
    let score = -1;
    if (title === lower) score = 3;
    else if (title.includes(lower) || lower.includes(title)) score = 2;
    if (score < 0) continue;
    const area = rect.width * rect.height;
    if (score > bestScore || (score === bestScore && best && area > best.width * best.height)) {
      best = rect;
      bestScore = score;
    }
  }
  return best;
}

function windowRectByTitle(title) {
  const needle = String(title || "").trim();
  if (!needle) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, SIMPLE_RECORDER_WIN_TITLE: needle },
      },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve(bestRect(parseRects(stdout), needle));
      },
    );
  });
}

module.exports = { windowRectByTitle };
