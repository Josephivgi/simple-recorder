"use strict";

const trackedWindows = [];
const ipcDisposers = [];

function trackWindow(win, role) {
  if (!win) return;
  trackedWindows.push({ ref: new WeakRef(win), role: String(role || "window") });
}

function registerOn(ipcMain, channel, handler) {
  if (!ipcMain || !channel) return;
  ipcMain.removeAllListeners(channel);
  ipcMain.on(channel, handler);
  ipcDisposers.push(() => {
    try {
      ipcMain.removeAllListeners(channel);
    } catch {
      /* channel may already be gone */
    }
  });
}

function shutdownRegistry() {
  for (const dispose of ipcDisposers) {
    try {
      dispose();
    } catch {
      /* best effort */
    }
  }
  ipcDisposers.length = 0;
  trackedWindows.length = 0;
}

module.exports = { trackWindow, registerOn, shutdownRegistry };
