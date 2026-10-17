# Simple Recorder

Standalone screen recorder for Windows: a launcher page plus a floating
always-on-top bar that owns target (Auto / Area / Window), delay, FPS, sound,
record, pause, stop, and close.

Every take records a screen, always the automatic one (the display the bar
opens on). A pick only frames a crop over it: Window resolves the picked
window's on-screen rect (`lib/window-rect.cjs`, a PowerShell probe matched
by title) and Area is a drag; both become a normalized crop, and nothing
locks into the app's own capture source. The crop is set once, like Area:
a window that moves mid-take leaves the crop where it was.

## Repos

- `Josephivgi/simple-recorder` (public): the source users see and the only
  place public releases come from. Installed apps and the website download
  read its latest release. Its history is release snapshots only, one commit
  per promoted version, all authored with the GitHub noreply address.
- `Josephivgi/simple-recorder-dev` (private): day-to-day development, the
  full history, developer builds, and every release published before the
  public repo was cleaned. Local checkouts push here (`origin`).

Code reaches users only through `npm run promote` (see Releases). Nothing
pushes from the dev repo to the public repo on its own.

## Layout

- `assets/icon.png`, `assets/icon.ico`: the app icon (a slate plate, a bold
  white R monogram, a red record dot). Both files are generated, never hand-edited:
  `npm run icon` redraws them from `scripts/make-icon.cjs`, which computes
  the pixels, supersamples them for smooth edges, and encodes PNG and ICO
  itself (the .ico carries 16/24/32/48/64/128/256, bitmaps up to 48 and
  PNG for the rest). They ship inside the app tree so an update carries them
  too, and `assets` is in the updater's allowed paths for that reason.
- `electron/main.cjs`: windows, overlay bar + area/window pickers + take
  outline strips, take-write IPC, take index, inflight recovery, hotkey. The
  main window takes `assets/icon.ico` (the PNG off Windows) as its icon.
- `electron/media-capture.cjs`: Chromium session permission handlers,
  `desktopCapturer` source picks, window-to-crop resolution, OS consent
  status, prefs IPC, and `capture-screen-still`: one fresh 1280x720 JPEG of
  one screen, which is what the studio's crop preview falls back to.
- `electron/preload.cjs`: `window.rec` for the launcher page.
- `electron/overlay-preload.cjs`: `window.overlay` for bar/picker windows.
- `lib/db.js`: SQLite (node:sqlite) at `userData/data/recorder.db`:
  `kv` prefs/consent/update state, `takes` index.
- `lib/capture-setup.js`: persisted consent shape and OS status helpers.
- `lib/library-folders.js`: the recordings library: the `Simple recorder`
  root, the `yyyy-mm-dd` day folders, take-name bumps, and the idempotent
  migration that moves a loose take into its day folder (move, verify, then
  let the caller re-point the row; never deletes).
- `lib/screenshot.cjs`: screenshot naming (`Screenshot N`) and the crop to
  pixel-rect math. The capture lives in main (`saveScreenshot`): Studio's
  Screenshot button (`screenshot-take`) and the bar's camera button
  (`overlay-screenshot`, shown in setup and while recording) both grab one
  full-resolution frame of the take's screen through desktopCapturer, crop it
  the way the take is cropped, and write a PNG into today's day folder. The
  row goes in `takes` with `mime` `image/png`, so the Takes page lists it
  with the videos (an image card; Open shows it in the default viewer). The
  main window is excluded from capture (`setContentProtection`) for the grab
  instead of hidden, so nothing flickers; the bar and strips already are.
- `lib/window-rect.cjs`: Win32 window rect by title (async PowerShell,
  EnumWindows + GetWindowRect), the bridge from a desktopCapturer name to
  a screen-space crop.
- `lib/icon-resource.cjs`: writes `assets/icon.ico` into a Windows
  executable's resources, so the installed `Simple Recorder.exe` stops
  showing Electron's atom in Explorer and on the taskbar. There is no
  resource compiler on the install path, so it goes through the Win32
  resource API (BeginUpdateResource / UpdateResource / EndUpdateResource)
  from a short PowerShell script: no dependency, no build step. A failure
  discards the whole update, so a bad icon can never cost the app its
  launcher, and `applyIcon` reports instead of throwing. It never deletes an
  image id it does not use (a failed delete inside an open update session
  makes the group write fail with an internal error); a leftover image from
  a bigger icon stays unreferenced.
- `lib/updater.js`: GitHub Releases update system. Lists published versions,
  checks for updates, and installs a release via atomic staging. A
  downloaded package must match the sha256 and asset name in its release's
  `latest.json`, or the install stops; a release without `latest.json` is
  refused. Local package paths and the source-tarball fallback only work in
  feed-file test mode (`REC_UPDATE_FEED_FILE`). It reads only public
  releases (`Josephivgi/simple-recorder`), always anonymously.
  Installed builds ping it on their own (boot plus a 15-minute
  poll), so finding a release is automatic and there is no check button. The
  sidebar Updates box is a status line ("New update detected") plus one wide
  Download button; once the download has landed the app relaunches itself,
  which is what finishes the update. An install also follows through on the
  bookkeeping: `install.json` and the Add-or-Remove-Programs `DisplayVersion`
  are bumped to the version that landed.
- `lib/install-layout.js`: the install layout. An installed app is a
  self-contained folder with the Electron runtime renamed to
  `Simple Recorder.exe`, the app tree in `resources\app`, and an
  `install.json` manifest two levels above the app root. A source checkout
  has no manifest, so it stays off the release channel entirely and never
  pings GitHub on its own. The manifest's `owner` flag is an informational
  developer label, set only by `install.cjs --owner`.
- `scripts/install.cjs`: installs the app on Windows (`npm run app:install`).
  Copies the bundled Electron runtime, renames the launcher, paints the app
  icon into that launcher (`lib/icon-resource.cjs`; `--no-icon` skips it,
  and a failure is reported, never fatal), lays the app tree
  into `resources\app`, writes `install.json` and
  `Uninstall Simple Recorder.cmd`, and adds Start Menu + Desktop shortcuts and
  an HKCU Add-or-Remove-Programs entry. Per user, no admin. It assumes the
  public repo and never calls the GitHub CLI or reads a GitHub token. The
  shortcuts and the uninstall entry take their icon from
  `resources\app\assets\icon.ico`, falling back to the launcher itself.
- `scripts/uninstall.cjs`: the uninstaller, run by the installed launcher as
  plain Node (`ELECTRON_RUN_AS_NODE=1`). Removes shortcuts, the registry key,
  and then the folder; the folder is deleted straight away when the
  uninstaller runs from outside the install, otherwise a detached `cmd.exe`
  deletes it once the running .exe unlocks. Recordings under
  `Videos\Simple recorder` are never touched; `--purge-data` also removes
  `%APPDATA%\Simple Recorder`, and `--no-shortcuts` / `--no-registry` keep a
  test run from touching the real ones.
- `scripts/verify-install.cjs`: checks an install folder and boots the
  installed launcher hidden (`--smoke`) to prove it runs and reports
  `installed` mode.
- `scripts/security-gate.cjs`: the release security gate (see Releases).
- `scripts/promote.cjs`: promotes a dev commit to the public repo.
- `renderer/index.html` + `app.js` + `app.css`: three pages. Studio is
  Source across the full top (action buttons plus the crop preview) over
  two rows of setting boxes: Microphone, Frame rate, Start delay, File
  format (MP4 only, with a disabled WebM placeholder), Quality (the output
  height: 720p/1080p/1440p), and Auto stop (off or 5/15/30 minutes; the tick
  stops the take through the normal save path). A take is scaled to the
  chosen height: a crop is rendered through a canvas, and a display taller
  than the choice is scaled down before it reaches the recorder. Everything
  fits the window; nothing scrolls at the default size. The boxes use custom
  pickers, plus a bottom dock with Start Recorder Bar. Takes is the saved
  files grouped under the day folder each one sits in (recent takes, open
  folder). Settings holds Default quality (720p/1080p/1440p), the same
  `recordQuality` pref the studio Quality box sets, saved in SQLite so it
  survives a restart, and Report a problem (Report a bug / Suggest a
  feature). Those buttons call `issue-report-open`; main builds the URL with
  `lib/issue-report.js` (always the public repo's `issues/new` with one of
  the `.github/ISSUE_TEMPLATE` forms, prefilled with only the app version and
  Windows version) and opens it in the browser. The studio page fits the
  window; the source list and the takes grid scroll inside their own boxes.
  The boxes set up the take; once the bar is open they lock and follow the
  bar's changes. The take engine (getDisplayMedia, MediaRecorder, chunk
  streaming) lives in `app.js`. The Source box has no header text: one spaced
  row of normal buttons (Full screen, Draw crop, and Clear crop once one is
  set), with the crop preview below it while a crop is set. That preview
  always shows the rectangle a take records: a live screen capture at 30 fps
  is the intent, and a still screenshot stands in when the capturer will not
  start (`NotReadableError` on a wedged Windows capture stack), refreshed on
  a 1.2s timer, with a note in the frame and a Retry that reopens the live
  capture without redrawing the crop. Both layers are placed by the same
  contain-and-shift math and clipped by the frame, so a refused capture can
  never leave a full uncropped desktop or an empty box behind. The studio has no
  window list; the bar's Window picker still frames a window's rect as a crop
  through `lib/window-rect.cjs`.
- `renderer/themes.css` + `theme-boot.js`, `lib/themes.js`: color themes for
  the main window (Match Windows, Light, Dark, Midnight, Ocean, Forest,
  Violet, Sunset). Every theme is a block of the same tokens app.css puts on
  `:root`, keyed by `<html data-theme>`; components never name a theme. The
  pick is the `appTheme` kv key (default Light, the pre-theme look). Main
  reads it before the window opens: it sets the window background,
  `nativeTheme.themeSource` (the Windows title bar), and passes `?theme=` so
  `theme-boot.js` applies it before the first paint. Settings > Theme saves
  through `theme-set`. Match Windows resolves to light or dark in the page
  and follows Windows live. The recorder bar keeps its own dark look.
- `renderer/overlay.{html,css,js}`: the floating bar and pickers.

## Data

- Prefs/consent/take metadata/update state: SQLite under
  `%APPDATA%\Simple Recorder\data`.
- Take files: `%APPDATA%\Simple Recorder\data\inflight-takes` while
  recording, then moved to `Videos\Simple recorder\<yyyy-mm-dd>\`, one
  folder per recording day, so the library reads like a camera roll. A take
  left loose in the root by an older build is moved into its day folder on
  the next launch or Takes refresh, and the index row follows the file.
- Delete on the Takes page asks first, then `lib/take-files.js` removes the
  file (only inside the recordings folder, day folders included, retrying a
  Windows lock). The take row is dropped only once the file is gone. The
  page releases the card's preview video before deleting, since it holds the
  file open.
- Logs: `%APPDATA%\Simple Recorder\data\logs\`.
- Install marker: `<installDir>\install.json` (version, install dir,
  developer label, Electron version). It sits outside `resources\app`, so app
  updates never clobber it; the updater refreshes its `version` after an
  install.
- `REC_USER_DATA` / `REC_VIDEOS` point the app data and the recordings
  library at scratch folders, so a smoke run can be checked without touching
  the real ones.

## Commands

- `npm start`: run the app.
- `npm test`: unit tests (node:test, main-process modules only).
- `npm run smoke`: hidden boot, prints `SMOKE {...}` JSON (bridge, studio
  panels, Start Recorder Bar, take day groups present, the update mode, the
  Default quality, and `cropPreview`), exits. The crop preview probe sets a
  crop, takes the failed-live path, pulls one still through the app's own
  IPC, and reports the frame's real geometry: `cropTrue` means the crop
  region is rendered as large as the frame allows and never cut, which is the
  check that the preview is not showing the whole desktop. The page installs
  that probe only when it is loaded with `?smoke=1`, so a normal launch
  carries no debug hook. If Electron fails
  with `protocol` undefined, `ELECTRON_RUN_AS_NODE` is set in the shell;
  clear it.
- `npm run gate`: the security gate over the working tree and its history.
- `npm run icon`: redraw `assets/icon.png` and `assets/icon.ico`.
- `npm run promote -- --notes <file>`: promote HEAD to the public repo as its
  dev release version, with that file as the release's changelog.
- `npm run app:install`: install the app for the current user (see above).
- `npm run app:verify`: verify an installed app and boot it hidden.
- `npm run app:uninstall`: remove the installed app.

## Running on Linux (GUI checks)

`npm install`, then `node node_modules/electron/install.js` if
`dist/electron` is missing. Launch with `--no-sandbox --disable-gpu`. The app
is single-instance, so stop the old process before relaunching. On X11,
screen sources have no usable `display_id`; media-capture maps them to
displays by order.

## Updates

`install.json` decides whether a build updates at all:

- **End-user install** (`SimpleRecorder-Setup.exe` or `npm run app:install`):
  an `installed` folder under `%LOCALAPPDATA%\Programs\Simple Recorder` with
  shortcuts and an uninstall entry. It pings GitHub Releases on launch and every
  15 minutes; when a newer release is published the panel says "New update
  detected" and offers Download. Pressing it downloads, installs, and the app
  relaunches into the new build on its own.
- **Source checkout** (no `install.json`): the boot and poll checks do not
  run there, so a release can never rewrite the checkout a developer works in.

Every update request is anonymous: the app never reads a token from the
environment or the GitHub CLI, and a token a caller passes is ignored. Only a
release newer than the running version is offered. A source checkout lists
releases but is never offered or given an install.

Data safety:

- Schema changes are additive only (new tables, new columns with defaults,
  new kv keys; nothing dropped, renamed, or rewritten), so an older build
  leaves data it does not know about in place. `schemaVersion` in kv is the
  highest schema any build wrote and is never lowered
  (`db.schemaInfo().newerData` is true on an older build).
- Builds up to v1.2.2 had Developer mode updates and pre-update backups. Their
  kv keys (`updateDeveloperMode`, `updateInstalledChannel`, `updateBackupKeep`)
  and any files in `data/backups` are left in place and never read or deleted.
- Takes, recordings, and logs live outside the app tree and are never touched
  by an install. Every install ends in a relaunch.

The update flow has three deliberate properties: finding a release is
automatic (no check button), there is no switch to stop it, and applying one
is a single Download press that ends in an automatic restart.

The restart goes through `relaunchApp()` in `electron/main.cjs`:
`app.relaunch()` and then a normal `app.quit()` (not `app.exit`), so
before-quit runs and the old GPU and renderer processes are gone before the
new instance opens its window. Every launch also runs a white-screen guard: 3
seconds after the main window shows, it captures the window's frame
(`lib/paint-check.js`). A flat single-color frame is logged as
`main paint blank`, the page is reloaded once, and if it is still blank the
app relaunches with `--rec-gpu-safe` (hardware acceleration off). A normal
boot logs `main paint ok ... gpu=<status>` to `recorder.log`; a capture that
fails is `unknown` and never triggers a reload. GPU process deaths are logged
as `child-process-gone` in `main-crash.log`.

## Releases

`.github/workflows/release.yml` runs in both repos and does different things
in each:

- **Dev repo** (`simple-recorder-dev`): every push to `main` runs the gate,
  bumps the patch past the highest dev release, builds, and publishes a
  developer build there. Installed copies never read it; it sets the version
  `npm run promote` ships.
- **Public repo** (`simple-recorder`): only a `v*` tag (pushed by
  `npm run promote`) or a manual run on `main` releases. A push to `main`
  without a tag runs the gate and stops. A release job runs only after every
  gate passes.

`npm run release` (local) publishes to the dev repo only: it refuses the
public repo and runs the gate on the tree and the built bundle first.

The gate (`scripts/security-gate.cjs`, plus the workflow's `gate` job) blocks
a release when any of these fail:

1. gitleaks over the full git history and the working tree.
2. Secret patterns (GitHub, AWS, OpenAI, Slack, Google keys, private keys,
   database URLs with passwords, webhook URLs) in tracked files.
3. Personal info: Windows profile paths with a real user name, home folders,
   personal or `.local` email addresses, and private IPv4 addresses. A
   private denylist (`security/private-denylist.txt`, dev repo only, never
   promoted) adds names and hosts that must never appear publicly.
4. Commit authors: on the public repo every author and committer must be a
   GitHub noreply address.
5. Shipped app code (`electron/`, `lib/`, `renderer/`) reading a GitHub token
   or calling the GitHub CLI anywhere.
6. `npm audit` (high or critical) and the unit tests.
7. The built update bundle: only allowed app paths, scanned with the same
   patterns as the source.

`npm run promote` (dev checkout, clean, HEAD on `origin/main`) uses the
version of the dev release built from HEAD, so the same code carries the same
number in both repos; `--version <x.y.z>` overrides it. It
exports the tracked files of HEAD (minus `security/`), runs the gate on that
export, copies it into a fresh clone of the public repo as one commit
`Simple Recorder v<x.y.z>` authored by the noreply address, runs the gate
again on the clone (including the author check), and pushes `main` plus the
tag. The public workflow then gates, builds, and publishes. The version must
be newer than the public repo's latest release. `--replace-history` (used once,
for the v1.2.0 cutover) force-pushes a single fresh commit and refuses to run
while the public repo still has tags, because old tags keep old history
reachable and fail the author check on every later release.

Release notes are a real changelog, never "passed the gate". `npm run promote
-- --notes <file>` is required: a Markdown file that says what changed for
users (### New / ### Improved / ### Fixed). Promote adds it as the
`## v<x.y.z> (date)` section at the top of `CHANGELOG.md`, which exists only
in the public repo and keeps every earlier section. The public workflow
publishes that section as the release notes (`scripts/changelog.cjs`) and
fails the release when the section is missing or only says the checks
passed. Dev builds keep a fixed "Developer build" note.

Assets are `simple-recorder-<tag>-app.tar.gz` (the update payload the in-app
updater swaps into `resources\app`), `latest.json`, and
`SimpleRecorder-Setup.exe`. The setup name never changes, so
`releases/latest/download/SimpleRecorder-Setup.exe` (the README's Download
for Windows button and the website download) always serves the newest public
build. `scripts/pack-setup.cjs` stages the same layout `install.cjs` produces
(empty `installDir`, no developer label) and compiles `scripts/installer.nsi`
with NSIS (`makensis`; found on PATH, in Program Files, via `MAKENSIS`, or a
portable `%LOCALAPPDATA%\nsis-*` folder; the workflow installs it with choco
because windows-2025 runners dropped it). The setup is per user
(`RequestExecutionLevel user`): it unpacks the layout to a temp folder, runs
the bundled `Simple Recorder.exe` as Node on `install.cjs --portable <folder>`
(installs to `%LOCALAPPDATA%\Programs` with shortcuts and the uninstall entry,
clears downloaded-file marks with `Unblock-File`), then opens the app. If the
app is open the install fails and the setup shows a message and exits 1.
`/S /TESTDIR=<folder>` installs silently into a scratch folder with no
shortcuts, registry, or launch, for checks. The install scripts set
`process.noAsar` because under Electron's fs `resources\default_app.asar`
reads as a folder. The build job runs on `windows-latest` because the setup
ships the Windows Electron runtime. The README install steps use
`docs/images/` (real app captures plus SVG drawings of the Windows steps).

## Conventions

- Renderer buttons dispatch on pointerdown in overlay windows (they are
  non-focusable); the launcher page uses click.
- The bar window, four frame strips, and the picker window are prewarmed
  after the page loads and reused.
- No localStorage/IndexedDB. No production deploy without asking.
- Never commit personal paths, personal emails, or internal host names. Use
  `C:\Users\Example` in tests. Commit with the GitHub noreply address.
