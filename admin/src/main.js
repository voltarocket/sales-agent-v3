const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs   = require("fs");
const WS   = require("ws");

function readInstallerUrl() {
  try {
    const cfgPath = path.join(path.dirname(process.execPath), "config", "backend.url");
    if (fs.existsSync(cfgPath)) return fs.readFileSync(cfgPath, "utf8").trim();
  } catch (_) {}
  return null;
}
const BACKEND_URL = process.env.BACKEND_URL || readInstallerUrl() || "http://localhost:3001";
const BACKEND_WS  = process.env.BACKEND_WS  || BACKEND_URL.replace(/^http/, "ws");

let mainWindow  = null;
let adminToken  = null;
let wsClient    = null;

// recordings dir — for local audio playback
const SHARED_DIR     = path.join(app.getPath("appData"), "SalesCallAnalyzer");
const RECORDINGS_DIR = path.join(SHARED_DIR, "recordings");
fs.mkdirSync(SHARED_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600,
    title: "Sales Admin",
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
  if (process.argv.includes("--dev")) mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => { createWindow(); connectBackend(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// ═══════════════════════════════════════════════════════════
// BACKEND WEBSOCKET — live refresh on new/updated calls & contacts
// ═══════════════════════════════════════════════════════════
function connectBackend() {
  try {
    wsClient = new WS(BACKEND_WS);
    wsClient.on("open",  () => { mainWindow?.webContents.send("ws-status", "connected"); });
    wsClient.on("close", () => {
      mainWindow?.webContents.send("ws-status", "disconnected");
      setTimeout(connectBackend, 3000);
    });
    wsClient.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (["call_saved", "contact_saved"].includes(msg.type))
          mainWindow?.webContents.send("data-updated", msg.type);
      } catch (_) {}
    });
    wsClient.on("error", () => {});
  } catch (_) { setTimeout(connectBackend, 3000); }
}

// ═══════════════════════════════════════════════════════════
// BACKEND HTTP
// ═══════════════════════════════════════════════════════════
async function apiBackend(endpoint, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers["x-auth-token"] = adminToken;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${BACKEND_URL}${endpoint}`, opts);
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

// ═══════════════════════════════════════════════════════════
// API IPC
// ═══════════════════════════════════════════════════════════
ipcMain.handle("api-get",    (_, ep)       => apiBackend(ep, "GET"));
ipcMain.handle("api-post",   (_, ep, body) => apiBackend(ep, "POST", body));
ipcMain.handle("api-put",    (_, ep, body) => apiBackend(ep, "PUT", body));
ipcMain.handle("api-patch",  (_, ep, body) => apiBackend(ep, "PATCH", body));
ipcMain.handle("api-delete", (_, ep)       => apiBackend(ep, "DELETE"));

ipcMain.handle("api-set-token", (_, token) => { adminToken = token; return { ok: true }; });

ipcMain.handle("get-audio-data", (_, filename) => {
  try {
    const p = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p).buffer;
  } catch (_) { return null; }
});
