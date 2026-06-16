const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const path = require("path");
const fs   = require("fs");
const WS   = require("ws");

// Read BACKEND_URL written by NSIS installer, fallback to env or localhost
function readInstallerUrl() {
  try {
    const cfgPath = path.join(path.dirname(process.execPath), "config", "backend.url");
    if (fs.existsSync(cfgPath)) return fs.readFileSync(cfgPath, "utf8").trim();
  } catch (_) {}
  return null;
}
const BACKEND_URL = process.env.BACKEND_URL || readInstallerUrl() || "http://localhost:3001";
const BACKEND_WS  = process.env.BACKEND_WS  || BACKEND_URL.replace(/^http/, "ws");

let mainWindow = null;
let wsClient   = null;
let authToken  = null;

// ═══════════════════════════════════════════════════════════
// RECORDINGS DIR (for local audio files only)
// ═══════════════════════════════════════════════════════════
const SHARED_DIR     = path.join(app.getPath("appData"), "SalesCallAnalyzer");
const RECORDINGS_DIR = path.join(SHARED_DIR, "recordings");
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// NOTIFICATION HELPER
// ═══════════════════════════════════════════════════════════
async function checkViolationThreshold(managerId, hasErrors) {
  if (!hasErrors || !managerId) return;
  try {
    await apiBackend("/api/notify-check", "POST", { managerId });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 720, minWidth: 800, minHeight: 600,
    title: "Sales Call Analyzer",
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
// BACKEND WEBSOCKET
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
        if (msg.type === "analysis_result") mainWindow?.webContents.send("analysis-result", msg);
        if (msg.type === "session_started")  mainWindow?.webContents.send("session-started", msg.sessionId);
        if (msg.type === "error")            mainWindow?.webContents.send("stream-error", msg.error);
        if (["call_saved", "contact_saved"].includes(msg.type))
          mainWindow?.webContents.send("data-updated", msg.type);
      } catch (_) {}
    });
  } catch (_) { setTimeout(connectBackend, 3000); }
}

// ═══════════════════════════════════════════════════════════
// BACKEND HTTP
// ═══════════════════════════════════════════════════════════
async function apiBackend(endpoint, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["x-auth-token"] = authToken;
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
ipcMain.handle("api-put",    (_, ep, body) => apiBackend(ep, "PUT", body));
ipcMain.handle("api-patch",  (_, ep, body) => apiBackend(ep, "PATCH", body));
ipcMain.handle("api-delete", (_, ep)       => apiBackend(ep, "DELETE"));

ipcMain.handle("api-post", async (_, ep, body) => {
  const result = await apiBackend(ep, "POST", body);
  if (ep === "/api/calls" && result?.ok) {
    await checkViolationThreshold(result.managerId, result.hasErrors);
  }
  return result;
});

ipcMain.handle("api-set-token", (_, token) => { authToken = token; return { ok: true }; });

ipcMain.handle("api-login", async (_, creds) => {
  const result = await apiBackend("/api/auth/login", "POST", creds);
  if (result?.ok && result?.token) {
    authToken = result.token;
  }
  return result;
});

ipcMain.handle("ws-status-query", () => wsClient?.readyState === WS.OPEN ? "connected" : "disconnected");

// ═══════════════════════════════════════════════════════════
// RECORDING IPC
// ═══════════════════════════════════════════════════════════
ipcMain.handle("start-recording", async (_, { phone, managerId }) => {
  if (!wsClient || wsClient.readyState !== WS.OPEN) return { error: "Backend not connected" };
  wsClient.send(JSON.stringify({ type: "call_start", phone, managerId, deviceType: "desktop" }));
  return { ok: true };
});

ipcMain.on("audio-chunk", (_, chunk) => {
  if (wsClient?.readyState === WS.OPEN && chunk) wsClient.send(Buffer.from(chunk));
});

ipcMain.handle("stop-recording", async () => {
  if (!wsClient || wsClient.readyState !== WS.OPEN) return { error: "Backend not connected" };
  wsClient.send(JSON.stringify({ type: "call_end" }));
  return { ok: true };
});

// ═══════════════════════════════════════════════════════════
// AUDIO FILE IPC
// ═══════════════════════════════════════════════════════════
ipcMain.handle("save-audio", (_, { callId, audioBuffer }) => {
  try {
    const filename = `${callId}.webm`;
    fs.writeFileSync(path.join(RECORDINGS_DIR, filename), Buffer.from(audioBuffer));
    return { ok: true, filename };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle("get-audio-data", (_, filename) => {
  try {
    const fp = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  } catch (_) { return null; }
});

ipcMain.handle("download-audio", async (_, audioId) => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/audio/${audioId}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (_) { return null; }
});

ipcMain.handle("transcribe-audio", async (_, filename) => {
  const fp = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(fp)) return { error: "Файл записи не найден" };
  try {
    const fileData = fs.readFileSync(fp);
    const blob     = new Blob([fileData], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob, "audio.webm");
    const r = await fetch(`${BACKEND_URL}/api/transcribe`, { method: "POST", body: formData });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return { error: err.error || `HTTP ${r.status}` };
    }
    return await r.json();
  } catch (e) { return { error: e.message }; }
});
