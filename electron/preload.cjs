const { contextBridge, ipcRenderer } = require("electron");

let captureSetupStatusInflight = null;

contextBridge.exposeInMainWorld("rec", {
  // Take streaming: chunks go to disk as they record so a renderer crash
  // can never take the footage with it.
  takeWriteStart: (payload) => ipcRenderer.invoke("take-write-start", payload),
  takeWriteChunk: (payload) => ipcRenderer.invoke("take-write-chunk", payload),
  takeWriteFinish: (payload) => ipcRenderer.invoke("take-write-finish", payload),
  takeWriteAbort: (payload) => ipcRenderer.invoke("take-write-abort", payload),
  takeSave: (payload) => ipcRenderer.invoke("take-save", payload),
  takesList: () => ipcRenderer.invoke("takes-list"),
  takeDelete: (id) => ipcRenderer.invoke("take-delete", { id }),
  takeShow: (id) => ipcRenderer.invoke("take-show", { id }),
  takeOpen: (id) => ipcRenderer.invoke("take-open", { id }),
  recordingsOpen: () => ipcRenderer.invoke("recordings-open"),

  // Capture consent and prefs (persisted in SQLite by main).
  captureSetupStatus: () => {
    if (captureSetupStatusInflight) return captureSetupStatusInflight;
    captureSetupStatusInflight = ipcRenderer.invoke("capture-setup-status").finally(() => {
      captureSetupStatusInflight = null;
    });
    return captureSetupStatusInflight;
  },
  ensureCaptureAccess: (payload) => ipcRenderer.invoke("ensure-capture-access", payload),
  openCaptureSettings: (payload) => ipcRenderer.invoke("open-capture-settings", payload),
  waitCaptureAccess: (payload) => ipcRenderer.invoke("wait-capture-access", payload),
  cancelCaptureWait: (payload) => ipcRenderer.invoke("cancel-capture-wait", payload),
  promptCaptureAccess: (payload) => ipcRenderer.invoke("prompt-capture-access", payload),
  reportCaptureDenied: (payload) => ipcRenderer.invoke("report-capture-denied", payload),
  markCaptureApproved: (payload) => ipcRenderer.invoke("mark-capture-approved", payload),
  resetCaptureConsent: (payload) => ipcRenderer.invoke("reset-capture-consent", payload),
  setCaptureSource: (payload) => ipcRenderer.invoke("set-capture-source", payload),
  setCaptureIntent: (payload) => ipcRenderer.invoke("set-capture-intent", payload),
  saveRecorderPrefs: (payload) => ipcRenderer.invoke("save-recorder-prefs", payload),
  listCaptureTargets: () => ipcRenderer.invoke("list-capture-targets"),
  frameWindow: (payload) => ipcRenderer.invoke("capture-window-frame", payload || {}),
  pickAreaFromPage: (payload) => ipcRenderer.invoke("page-pick-area", payload || {}),

  // Recorder bar session.
  startCountdownOverlay: (payload) => ipcRenderer.invoke("start-countdown-overlay", payload),
  stopCountdownOverlay: () => ipcRenderer.invoke("stop-countdown-overlay"),
  updateCountdownOverlay: (payload) => ipcRenderer.invoke("update-countdown-overlay", payload),
  overlayRecordNow: () => ipcRenderer.send("countdown-overlay-start"),
  prewarmRecorderBar: () => ipcRenderer.send("prewarm-recorder-bar"),
  logRecorder: (payload) => ipcRenderer.send("recorder-log", payload),

  onCountdownTick: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-tick", listen);
    return () => ipcRenderer.removeListener("countdown-tick", listen);
  },
  onCountdownFinished: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-finished", listen);
    return () => ipcRenderer.removeListener("countdown-finished", listen);
  },
  onCountdownBounds: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-bounds", listen);
    return () => ipcRenderer.removeListener("countdown-bounds", listen);
  },
  onRecordingOverlayStop: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("recording-overlay-stop", listen);
    return () => ipcRenderer.removeListener("recording-overlay-stop", listen);
  },
  onRecordingOverlayPause: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("recording-overlay-pause", listen);
    return () => ipcRenderer.removeListener("recording-overlay-pause", listen);
  },
  onOverlayClosed: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("countdown-overlay-closed", listen);
    return () => ipcRenderer.removeListener("countdown-overlay-closed", listen);
  },
  onOverlaySetTarget: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-set-target", listen);
    return () => ipcRenderer.removeListener("overlay-set-target", listen);
  },
  onOverlayNudgeDelay: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-nudge-delay", listen);
    return () => ipcRenderer.removeListener("overlay-nudge-delay", listen);
  },
  onOverlayNudgeFps: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("overlay-nudge-fps", listen);
    return () => ipcRenderer.removeListener("overlay-nudge-fps", listen);
  },
  onOverlayToggleSound: (handler) => {
    const listen = () => handler();
    ipcRenderer.on("overlay-toggle-sound", listen);
    return () => ipcRenderer.removeListener("overlay-toggle-sound", listen);
  },

  // GitHub Releases update system. Detection is automatic; the panel's
  // Download button is the one action, and the restart that follows is not.
  updateStatus: () => ipcRenderer.invoke("update-status"),
  updateInstall: (payload) => ipcRenderer.invoke("update-install", payload || {}),
  updateSetDeveloperMode: (enabled) => ipcRenderer.invoke("update-set-developer-mode", { enabled: enabled === true }),
  openDataBackups: () => ipcRenderer.invoke("update-open-backups"),
  onUpdateState: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("update-state", listen);
    return () => ipcRenderer.removeListener("update-state", listen);
  },
});
