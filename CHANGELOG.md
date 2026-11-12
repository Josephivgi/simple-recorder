# Changelog

## v1.6.0 (2026-11-12)

### New

- For X.com switch in the Studio's Quality box. When it is on, recordings are kept inside X's size limit (1920x1200) even at 1440p, and the "Recording saved" card says "Ready to post on X", or tells you if the recording is longer than 2:20 or bigger than 512 MB.

### Improved

- Recordings are now saved as standard MP4 files that upload sites like X accept and that any player can skip around in right away. Before, they were saved in a streaming layout that some sites refused.
- Video is recorded in H.264 High profile, which looks better at the same file size and is what most sites prefer.
- Game sound is now recorded in stereo. Windows gave it to the app as mono before.
- Frame timing is steadier, so recordings play smoothly at the frame rate you picked.

## v1.5.1 (2026-11-12)

### Improved

- When you stop a recording, a "Recording saved" card now appears at the top of your screen, where the recorder bar was. It shows the name, the length, and the folder it went to, with Watch it, Open Takes, and Show in folder buttons. It stays on top without pulling you out of a game and goes away by itself after a few seconds.
- The app also switches to the Takes page and shows a "Saved" banner above your new recording, which is the first card and marked New. Before, the only sign was a short message inside the app window, which was easy to miss when the window was minimized or behind a game.

## v1.5.0 (2026-11-12)

### New

- Recordings now include game sound: everything your speakers play, like the game, music, or videos. Turn it on or off with the Game sound switch in the Studio's Sound box. It is on by default.

### Improved

- The microphone is now off by default, so your voice and room noise stay out of recordings unless you turn on the Microphone switch in the Sound box. If you had it on before, it starts off after this update.
- When Game sound and Microphone are both on, they are mixed into one sound track.
- The sound button on the recorder bar now says "Mic on" or "Mic off", since it only controls the microphone.
- Auto stop now remembers your choice after you close the app.

### Fixed

- The picture no longer freezes about 20 seconds into a recording while the sound keeps going. This happened when the Simple Recorder window was minimized or covered by a game, on recordings with a cropped area or a screen taller than the chosen quality.

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
