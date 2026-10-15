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

- `electron/main.cjs`: windows, overlay bar + area/window pickers + take
  outline strips, take-write IPC, take index, inflight recovery, hotkey.
- `electron/media-capture.cjs`: Chromium session permission handlers,
  `desktopCapturer` source picks, window-to-crop resolution, OS consent
  status, prefs IPC.
- `electron/preload.cjs`: `window.rec` for the launcher page.
- `electron/overlay-preload.cjs`: `window.overlay` for bar/picker windows.
- `lib/db.js`: SQLite (node:sqlite) at `userData/data/recorder.db`:
  `kv` prefs/consent/update channel, `takes` index.
- `lib/capture-setup.js`: persisted consent shape and OS status helpers.
- `lib/library-folders.js`: the recordings library: the `Simple recorder`
  root, the `yyyy-mm-dd` day folders, take-name bumps, and the idempotent
  migration that moves a loose take into its day folder (move, verify, then
  let the caller re-point the row; never deletes).
- `lib/window-rect.cjs`: Win32 window rect by title (async PowerShell,
  EnumWindows + GetWindowRect), the bridge from a desktopCapturer name to
  a screen-space crop.
- `lib/updater.js`: GitHub Releases update system. Lists published versions,
  checks for updates, and installs a release via atomic staging. A
  downloaded package must match the sha256 and asset name in its release's
  `latest.json`, or the install stops; a release without `latest.json` is
  refused. Local package paths and the source-tarball fallback only work in
  feed-file test mode (`REC_UPDATE_FEED_FILE`). Two
  channels: public releases (`Josephivgi/simple-recorder`, always anonymous)
  and Developer mode updates (`Josephivgi/simple-recorder-dev`, see below).
  Installed builds ping their channel on their own (boot plus a 15-minute
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
  Copies the bundled Electron runtime, renames the launcher, lays the app tree
  into `resources\app`, writes `install.json` and
  `Uninstall Simple Recorder.cmd`, and adds Start Menu + Desktop shortcuts and
  an HKCU Add-or-Remove-Programs entry. Per user, no admin. It assumes the
  public repo and never calls the GitHub CLI or reads a GitHub token.
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
  folder). Settings holds Developer mode updates and Your data when
  switching (which channel this copy is, Backups to keep, and the backups
  folder). The studio page fits the
  window; the source list and the takes grid scroll inside their own boxes.
  The boxes set up the take; once the bar is open they lock and follow the
  bar's changes. The take engine (getDisplayMedia, MediaRecorder, chunk
  streaming) lives in `app.js`. The Source box has no header text: one spaced
  row of normal buttons (Full screen, Draw crop, and Clear crop once one is
  set), with the crop preview below it while a crop is set. The studio has no
  window list; the bar's Window picker still frames a window's rect as a crop
  through `lib/window-rect.cjs`.
- `renderer/overlay.{html,css,js}`: the floating bar and pickers.

## Data

- Prefs/consent/take metadata/update channel: SQLite under
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
  panels, Start Recorder Bar, take day groups present, the update mode and
  channel, and the Developer mode updates switch), exits. If Electron fails
  with `protocol` undefined, `ELECTRON_RUN_AS_NODE` is set in the shell;
  clear it.
- `npm run gate`: the security gate over the working tree and its history.
- `npm run promote`: promote HEAD to the public repo as its dev release version.
- `npm run app:install`: install the app for the current user (see above).
- `npm run app:verify`: verify an installed app and boot it hidden.
- `npm run app:uninstall`: remove the installed app.

## Running on Linux (GUI checks)

`npm install`, then `node node_modules/electron/install.js` if
`dist/electron` is missing. Launch with `--no-sandbox --disable-gpu`. The app
is single-instance, so stop the old process before relaunching. On X11,
screen sources have no usable `display_id`; media-capture maps them to
displays by order.

## Update channels

`install.json` decides whether a build is on a release channel at all:

- **End-user install** (`SimpleRecorder-Setup.exe` or `npm run app:install`):
  an `installed` folder under `%LOCALAPPDATA%\Programs\Simple Recorder` with
  shortcuts and an uninstall entry. It pings its channel on launch and every
  15 minutes; when a newer release is published the panel says "New update
  detected" and offers Download. Pressing it downloads, installs, and the app
  relaunches into the new build on its own.
- **Source checkout** (no `install.json`): the boot and poll checks do not
  run there, so a release can never rewrite the checkout a developer works in.

Which repo an install reads is the Settings page's **Developer mode updates**
switch, stored in SQLite (`updateDeveloperMode`):

- **Off (default):** public releases from `Josephivgi/simple-recorder`. Every
  request is anonymous. The public channel drops any token a caller passes and
  never reads one from the environment or the GitHub CLI.
- **On:** developer builds from the private `Josephivgi/simple-recorder-dev`.
  The page says not to turn it on: it is not a public release, it is only for
  developers of the app, and it needs a GitHub OAuth sign-in. Turning it on
  also asks for confirmation in a native dialog. The sign-in is the GitHub
  CLI's OAuth token (`gh auth login`), read with `gh auth token` only while the
  switch is on, kept in memory only, sent only over HTTPS to `api.github.com`,
  and never forwarded on a redirect to another host. With no sign-in the panel
  shows an error that says to turn the switch off for public releases.

Switching channels moves the install, not just the source. SQLite records
which channel the running app tree came from (`updateInstalledChannel`; a
database from before this was tracked takes its current channel). When the
switch points at the other channel, that channel's newest release is offered
whatever its version ("Switch to public release v1.2.1"), so a developer
build can go back to an older public release and pick up the newer developer
build again later. A source checkout lists releases but is never offered or
given an install.

Data safety across channels:

- Schema changes are additive only (new tables, new columns with defaults,
  new kv keys; nothing dropped, renamed, or rewritten). Builds from either
  channel share one database and leave data they do not know about in place.
  `schemaVersion` in kv is the highest schema any build wrote and is never
  lowered (`db.schemaInfo().newerData` is true on an older build).
- Before every install the database is copied with `VACUUM INTO` to
  `data/backups/recorder-<time>-<fromChannel>-<fromTag>-to-<toChannel>-<toTag>.db`,
  checked with `PRAGMA quick_check`, never overwriting a file. If the copy
  fails, nothing installs. Settings > Your data when switching opens the
  folder and sets Backups to keep (`updateBackupKeep`: off / 2 / 5 / 10 /
  all, default 2). After a good backup, and when the limit is lowered, the
  oldest files matching the backup name beyond the limit are removed; other
  files in the folder are never touched. Off makes no copy before an install
  and keeps the ones already there.
- Takes, recordings, and logs live outside the app tree and are never touched
  by an install. Every install ends in a relaunch, even when a channel switch
  keeps the same version number.

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
  developer build there. Only Developer mode updates can see it.
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
   anywhere but the Developer mode updates path.
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
