const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs   = require("fs");

function readInstallerUrl() {
  try {
    const cfgPath = path.join(path.dirname(process.execPath), "config", "backend.url");
    if (fs.existsSync(cfgPath)) return fs.readFileSync(cfgPath, "utf8").trim();
  } catch (_) {}
  return null;
}
const BACKEND_URL = process.env.BACKEND_URL || readInstallerUrl() || "http://localhost:3001";

let mainWindow  = null;
let adminToken  = null;

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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

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
