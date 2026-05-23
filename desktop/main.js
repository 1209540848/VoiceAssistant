const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage } = require("electron");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");

const APP_URL = process.env.VOICE_ASSISTANT_URL || "http://127.0.0.1:4173/web/index.html";
const GLOBAL_SHORTCUT = process.env.VOICE_ASSISTANT_SHORTCUT || "CommandOrControl+Shift+Space";
const ASR_STREAM_URL = process.env.VOICE_ASSISTANT_ASR_STREAM_URL || "ws://127.0.0.1:4173/api/asr-stream";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let captureProcess = null;
let desktopStreamSocket = null;
let desktopStreamOpen = false;
let desktopStreamPending = [];
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="#1b6956"/>
      <rect x="14" y="18" width="36" height="28" rx="8" fill="#f7f8f4"/>
      <circle cx="24" cy="28" r="3" fill="#1b6956"/>
      <circle cx="32" cy="28" r="3" fill="#1b6956"/>
      <circle cx="40" cy="28" r="3" fill="#1b6956"/>
      <path d="M21 38h22" stroke="#1b6956" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: "VoiceAssistant",
    backgroundColor: "#f6f5f1",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function toggleMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("VoiceAssistant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示 VoiceAssistant",
        click: () => toggleMainWindow()
      },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("click", () => toggleMainWindow());
}

function registerShortcuts() {
  globalShortcut.register(GLOBAL_SHORTCUT, () => {
    toggleMainWindow();
  });
}

function sendToRenderer(channel, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function bytesToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function createDesktopStreamSocket() {
  if (desktopStreamSocket && desktopStreamSocket.readyState === WebSocket.OPEN) {
    return desktopStreamSocket;
  }

  desktopStreamSocket = new WebSocket(ASR_STREAM_URL);
  desktopStreamOpen = false;
  desktopStreamPending = [];

  desktopStreamSocket.on("open", () => {
    desktopStreamOpen = true;
    desktopStreamSocket.send(JSON.stringify({ type: "start" }));
    while (desktopStreamPending.length) {
      desktopStreamSocket.send(desktopStreamPending.shift());
    }
    sendToRenderer("desktop-recorder:event", {
      type: "capture-status",
      phase: "stream-open"
    });
  });

  desktopStreamSocket.on("message", (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    sendToRenderer("desktop-recorder:event", payload);
  });

  desktopStreamSocket.on("close", () => {
    desktopStreamOpen = false;
    desktopStreamSocket = null;
  });

  desktopStreamSocket.on("error", (error) => {
    sendToRenderer("desktop-recorder:event", {
      type: "error",
      message: error.message || "Desktop ASR stream failed"
    });
  });

  return desktopStreamSocket;
}

function sendDesktopAudioFrame(frame) {
  const socket = createDesktopStreamSocket();
  const message = JSON.stringify({
    type: "audio",
    data: bytesToBase64(frame)
  });

  if (socket.readyState === WebSocket.OPEN && desktopStreamOpen) {
    socket.send(message);
    return;
  }

  desktopStreamPending.push(message);
}

function stopDesktopStreamSocket() {
  if (!desktopStreamSocket) return;
  try {
    if (desktopStreamSocket.readyState === WebSocket.OPEN) {
      desktopStreamSocket.send(JSON.stringify({ type: "stop" }));
    }
  } catch {}
}

function stopDesktopCapture() {
  stopDesktopStreamSocket();
  if (captureProcess) {
    try {
      captureProcess.kill();
    } catch {}
    captureProcess = null;
  }
}

function startWindowsCapture() {
  const scriptPath = path.join(__dirname, "windows-mic-capture.ps1");
  captureProcess = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  captureProcess.stdout.on("data", (chunk) => {
    sendDesktopAudioFrame(chunk);
  });

  captureProcess.stderr.on("data", (chunk) => {
    sendToRenderer("desktop-recorder:event", {
      type: "capture-status",
      phase: "capture-stderr",
      message: chunk.toString()
    });
  });

  captureProcess.on("exit", (code) => {
    captureProcess = null;
    sendToRenderer("desktop-recorder:event", {
      type: "capture-status",
      phase: "capture-exit",
      code
    });
  });
}

ipcMain.handle("desktop-recorder:start", async () => {
  if (captureProcess) {
    return {
      ok: true,
      mode: "desktop",
      message: "Desktop recorder already running"
    };
  }

  if (process.platform !== "win32") {
    return {
      ok: false,
      message: "Desktop recorder currently supports Windows only"
    };
  }

  createDesktopStreamSocket();
  startWindowsCapture();

  return {
    ok: true,
    mode: "desktop",
    sampleRate: 16000,
    format: "pcm_s16le",
    channels: 1
  };
});

ipcMain.handle("desktop-recorder:stop", async () => {
  stopDesktopCapture();
  return {
    ok: true
  };
});

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerShortcuts();
});

app.on("second-instance", () => {
  toggleMainWindow();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  stopDesktopCapture();
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  } else {
    toggleMainWindow();
  }
});
