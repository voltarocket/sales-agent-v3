const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const path = require("path");
const fs   = require("fs");
const WS   = require("ws");

const BACKEND_WS  = process.env.BACKEND_WS  || "ws://localhost:3001";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

let mainWindow = null;
let wsClient   = null;

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
  if (process.argv.includes("--dev")) mainWindow.webContents.openDevTools({ mode:"detach" });
}

app.whenReady().then(() => { createWindow(); connectBackend(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

function connectBackend() {
  try {
    wsClient = new WS(BACKEND_WS);
    wsClient.on("open",    () => { mainWindow?.webContents.send("ws-status","connected"); });
    wsClient.on("close",   () => { mainWindow?.webContents.send("ws-status","disconnected"); setTimeout(connectBackend,3000); });
    wsClient.on("error",   () => {});
    wsClient.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session_started") mainWindow?.webContents.send("session-started", msg.sessionId);
        if (msg.type === "processing")      mainWindow?.webContents.send("processing");
        if (msg.type === "call_analyzed") {
          mainWindow?.webContents.send("call-analyzed", msg);
          new Notification({ title:"Звонок проанализирован", body:`Оценка: ${msg.analysis?.score||"—"}/100` }).show();
        }
        if (msg.type === "error") mainWindow?.webContents.send("stream-error", msg.error);
        // Realtime updates for lists
        if (["call_saved","contact_saved","call_started"].includes(msg.type))
          mainWindow?.webContents.send("data-updated", msg.type);
      } catch(_) {}
    });
  } catch(_) { setTimeout(connectBackend,3000); }
}

// ── Recording ──────────────────────────────────────────────
ipcMain.handle("start-recording", async (_, { phone, managerId }) => {
  if (!wsClient || wsClient.readyState !== WS.OPEN) return { error:"Backend not connected" };
  wsClient.send(JSON.stringify({ type:"call_start", phone, managerId, deviceType:"desktop" }));
  return { ok:true };
});
ipcMain.on("audio-chunk", (_, chunk) => {
  if (wsClient?.readyState === WS.OPEN && chunk) wsClient.send(Buffer.from(chunk));
});
ipcMain.handle("stop-recording", async () => {
  if (!wsClient || wsClient.readyState !== WS.OPEN) return { error:"Backend not connected" };
  wsClient.send(JSON.stringify({ type:"call_end" }));
  return { ok:true };
});

// ── API proxy ──────────────────────────────────────────────
async function api(endpoint, method="GET", body=null) {
  const opts = { method, headers:{"Content-Type":"application/json"} };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${BACKEND_URL}${endpoint}`, opts);
    return await r.json();
  } catch(e) { return { error: e.message }; }
}

ipcMain.handle("api-get",    (_, endpoint)        => api(endpoint));
ipcMain.handle("api-post",   (_, endpoint, body)   => api(endpoint,"POST",body));
ipcMain.handle("api-put",    (_, endpoint, body)   => api(endpoint,"PUT",body));
ipcMain.handle("api-delete", (_, endpoint)         => api(endpoint,"DELETE"));
