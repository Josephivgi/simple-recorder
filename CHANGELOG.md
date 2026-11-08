# Changelog

## v1.4.0 (2026-11-08)

### New

- Screenshots has its own page in the sidebar. Capture the full screen, an area you draw, or one window, then press Take screenshot.
- Turn on Copy to clipboard to paste a screenshot straight into a chat or document, or Open after saving to see it right away.
- Your screenshots are listed by day on the Screenshots page, with Copy, View, and Delete. The Takes page now lists only videos.
- Install every JSystems app with one PowerShell command. The README shows how.

### Improved

- Screenshots are much faster, usually under a second. Full screen and Area shots no longer include the mouse pointer.
- The title at the top of the window now names the page you are on.
- New installs run on Electron 44.10.1, the browser engine the app runs on, which has security fixes. An in-app update keeps the engine you have. To get the new engine, run SimpleRecorder-Setup.exe again; your recordings and settings stay.

## v1.3.0 (2026-10-23)

### Fixed

- Uninstalling Simple Recorder from Settings > Apps works again. Before, it stopped without removing the app.
- Uninstalling no longer flashes command windows, and the app folder is removed even when Windows holds on to it for a while after the app closes.

## v1.2.9 (2026-10-18)

### New
- Built-in video player. Play on a take (or click its thumbnail) opens it inside Simple Recorder instead of another app. It has a seek bar you can drag, play/pause, 10-second skips, volume, speed (0.5x to 2x), loop, full screen, and arrows to step through your takes.
- Save frame in the player saves the picture you are paused on as a screenshot, next to your other screenshots.
- Built-in screenshot viewer. View on a screenshot opens it in the same place: zoom with the mouse wheel or the + and - buttons, drag to move around, 1:1 for actual size, and Copy to put it on the clipboard.
- Keyboard shortcuts in the player: Space to play or pause, J and L to skip, arrows to step, M to mute, F for full screen, S to save a frame, P and N for the previous or next take. Press ? in the player for the full list.

### Improved
- The player remembers your volume, mute, speed, and loop between takes and after a restart.
- Show in folder, Open with (your default Windows app), and Delete are in the player too.

## v1.2.8 (2026-10-17)

### New

- Take screenshots. Studio has a new Screenshot button next to Full screen and Draw crop. It saves a picture of what a recording would capture: the whole screen, or just your crop.
- The recorder bar has a camera button. Press it before or during a recording to save a screenshot without stopping the video.
- Screenshots are saved as PNG files at full screen resolution, in the same day folder as your videos.
- The Takes page shows screenshots next to your videos. Click a screenshot or press Open to view it.
- Simple Recorder never shows up in its own screenshots.
