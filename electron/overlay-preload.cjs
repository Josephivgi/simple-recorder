const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  recordNow: () => ipcRenderer.send("countdown-overlay-start"),
  stopNow: () => ipcRenderer.send("countdown-overlay-stop"),
  pauseNow: () => ipcRenderer.send("countdown-overlay-pause"),
  closeNow: () => ipcRenderer.send("countdown-overlay-close"),
  setTarget: (target) => ipcRenderer.send("overlay-set-target", { target }),
  pickArea: (rect) => ipcRenderer.send("overlay-area-picked", { rect: rect || null }),
  pickWindow: (payload) => ipcRenderer.send("overlay-window-picked", payload || {}),
  pickState: (payload) => ipcRenderer.send("area-pick-state", payload || {}),
  nudgeDelay: (dir) => ipcRenderer.send("overlay-nudge-delay", { dir }),
  nudgeFps: (dir) => ipcRenderer.send("overlay-nudge-fps", { dir }),
  toggleSound: () => ipcRenderer.send("overlay-toggle-sound"),
  dragBy: (payload) => ipcRenderer.send("overlay-drag-by", payload || {}),
  onState: (handler) => {
    const listen = (_event, state) => handler(state);
    ipcRenderer.on("overlay-state", listen);
    return () => ipcRenderer.removeListener("overlay-state", listen);
  },
  onPickReset: (handler) => {
    const listen = (_event, payload) => handler(payload || {});
    ipcRenderer.on("area-pick-reset", listen);
    return () => ipcRenderer.removeListener("area-pick-reset", listen);
  },
  onPickWindows: (handler) => {
    const listen = (_event, payload) => handler(payload);
    ipcRenderer.on("pick-windows", listen);
    return () => ipcRenderer.removeListener("pick-windows", listen);
  },
});
