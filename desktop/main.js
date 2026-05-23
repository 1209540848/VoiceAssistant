const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage } = require("electron");
const path = require("path");

const APP_URL = process.env.VOICE_ASSISTANT_URL || "http://127.0.0.1:4173/web/index.html";
const GLOBAL_SHORTCUT = process.env.VOICE_ASSISTANT_SHORTCUT || "CommandOrControl+Shift+Space";

let mainWindow = null;
let tray = null;
let isQuitting = false;

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
  const icon = nativeImage.createEmpty();
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

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  registerShortcuts();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
