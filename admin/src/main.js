const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

let mainWindow = null;
let adminToken = null;

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

async function api(endpoint, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${BACKEND_URL}${endpoint}`, opts);
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

ipcMain.handle("api-get",       (_, endpoint)       => api(endpoint));
ipcMain.handle("api-post",      (_, endpoint, body)  => api(endpoint, "POST", body));
ipcMain.handle("api-put",       (_, endpoint, body)  => api(endpoint, "PUT", body));
ipcMain.handle("api-delete",    (_, endpoint)        => api(endpoint, "DELETE"));
ipcMain.handle("api-set-token", (_, token)           => { adminToken = token; return { ok: true }; });
