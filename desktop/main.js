const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage } = require("electron");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");

const APP_URL = process.env.VOICE_ASSISTANT_URL || "http://127.0.0.1:4173/web/index.html";
const FLOATING_URL = process.env.VOICE_ASSISTANT_FLOATING_URL || "http://127.0.0.1:4173/web/floating.html";
const GLOBAL_SHORTCUT = process.env.VOICE_ASSISTANT_SHORTCUT || "CommandOrControl+Space";
const ASR_STREAM_URL = process.env.VOICE_ASSISTANT_ASR_STREAM_URL || "ws://127.0.0.1:4173/api/asr-stream";
const SERVER_HEALTH_URL = process.env.VOICE_ASSISTANT_HEALTH_URL || "http://127.0.0.1:4173/api/health";
const PREBUFFER_LIMIT_BYTES = 32000 * 2;
const TAIL_BUFFER_MS = 500;
const MAIN_WINDOW_WIDTH = 1180;
const MAIN_WINDOW_DEFAULT_HEIGHT = 640;
const MAIN_WINDOW_MIN_HEIGHT = 640;

let mainWindow = null;
let floatingWindow = null;
let tray = null;
let isQuitting = false;
let captureProcess = null;
let desktopStreamSocket = null;
let desktopStreamOpen = false;
let desktopStreamPending = [];
let preBufferBytes = 0;
let stopTimer = null;
let isDesktopRecording = false;
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
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    minWidth: MAIN_WINDOW_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    useContentSize: true,
    resizable: false,
    show: false,
    title: "VoiceAssistant",
    autoHideMenuBar: true,
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

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    return floatingWindow;
  }

  floatingWindow = new BrowserWindow({
    width: 108,
    height: 24,
    minWidth: 108,
    minHeight: 24,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "VoiceAssistant Floating",
    backgroundColor: "#00000000",
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatingWindow.loadURL(FLOATING_URL);

  floatingWindow.on("closed", () => {
    floatingWindow = null;
  });

  return floatingWindow;
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

function toggleFloatingWindow() {
  const target = createFloatingWindow();
  if (target.isVisible()) {
    target.hide();
    return;
  }

  target.show();
  target.focus();
}

function showFloatingWindow() {
  const target = createFloatingWindow();
  if (!target.isVisible()) {
    target.show();
  }
  target.focus();
  return target;
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
        label: "显示悬浮输入条",
        click: () => toggleFloatingWindow()
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
  const shortcuts = [GLOBAL_SHORTCUT, "CommandOrControl+Shift+Space"].filter(
    (shortcut, index, list) => shortcut && list.indexOf(shortcut) === index
  );
  const handler = () => {
    if (isDesktopRecording) {
      stopDesktopCapture();
      return;
    }
    showFloatingWindow();
    startDesktopRecording();
  };

  for (const shortcut of shortcuts) {
    const registered = globalShortcut.register(shortcut, handler);
    if (registered) {
      console.log(`Global shortcut registered: ${shortcut}`);
      return;
    }
    console.warn(`Global shortcut registration failed: ${shortcut}`);
  }
}

function sendToRenderer(channel, payload = {}) {
  for (const target of [mainWindow, floatingWindow]) {
    if (!target || target.isDestroyed()) continue;
    target.webContents.send(channel, payload);
  }
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
    preBufferBytes = 0;
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
    desktopStreamPending = [];
    preBufferBytes = 0;
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
  preBufferBytes += frame.length;
  while (preBufferBytes > PREBUFFER_LIMIT_BYTES && desktopStreamPending.length) {
    const dropped = desktopStreamPending.shift();
    try {
      const parsed = JSON.parse(dropped);
      preBufferBytes -= Buffer.from(parsed.data || "", "base64").length;
    } catch {
      preBufferBytes = Math.max(0, preBufferBytes - frame.length);
    }
  }
}

function stopDesktopStreamSocket() {
  if (!desktopStreamSocket) return;
  try {
    if (desktopStreamSocket.readyState === WebSocket.OPEN) {
      desktopStreamSocket.send(JSON.stringify({ type: "stop" }));
    }
  } catch {}
}

function stopDesktopCapture(options = {}) {
  const tailMs = Number(options.tailMs ?? TAIL_BUFFER_MS);
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }

  const finish = () => {
    stopDesktopStreamSocket();
    if (captureProcess) {
      try {
        captureProcess.kill();
      } catch {}
      captureProcess = null;
    }
    sendToRenderer("desktop-recorder:event", {
      type: "capture-status",
      phase: "capture-stop"
    });
    isDesktopRecording = false;
  };

  if (tailMs > 0 && captureProcess) {
    sendToRenderer("desktop-recorder:event", {
      type: "capture-status",
      phase: "tail-buffer",
      tailMs
    });
    stopTimer = setTimeout(finish, tailMs);
    isDesktopRecording = false;
    return;
  }

  finish();
}

function forceStopDesktopCapture() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  stopDesktopStreamSocket();
  if (captureProcess) {
    try {
      captureProcess.kill();
    } catch {}
    captureProcess = null;
  }
  isDesktopRecording = false;
}

async function warmLocalService() {
  try {
    const response = await fetch(SERVER_HEALTH_URL);
    return {
      ok: response.ok
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message
    };
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

async function startDesktopRecording() {
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

  const health = await warmLocalService();
  if (!health.ok) {
    return {
      ok: false,
      message: health.message || "Local service is not ready"
    };
  }

  preBufferBytes = 0;
  createDesktopStreamSocket();
  startWindowsCapture();
  isDesktopRecording = true;
  sendToRenderer("desktop-recorder:event", {
    type: "capture-status",
    phase: "capture-start"
  });

  return {
    ok: true,
    mode: "desktop",
    sampleRate: 16000,
    format: "pcm_s16le",
    channels: 1
  };
}

ipcMain.handle("desktop-recorder:start", async () => {
  return startDesktopRecording();
});

ipcMain.handle("desktop-recorder:stop", async () => {
  stopDesktopCapture();
  return {
    ok: true
  };
});

ipcMain.handle("desktop-clipboard:write-text", async (_event, text) => {
  clipboard.writeText(String(text || ""));
  return {
    ok: true
  };
});

ipcMain.handle("desktop-floating:toggle", async () => {
  toggleFloatingWindow();
  return {
    ok: true
  };
});

app.whenReady().then(() => {
  createMainWindow();
  createFloatingWindow();
  createTray();
  registerShortcuts();
  warmLocalService();
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
  forceStopDesktopCapture();
  globalShortcut.unregisterAll();
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  } else {
    toggleMainWindow();
  }
});
