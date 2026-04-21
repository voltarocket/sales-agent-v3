const { app, BrowserWindow, ipcMain } = require("electron");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

let mainWindow = null;
let adminToken = null;

// ═══════════════════════════════════════════════════════════
// LOCAL DATABASE — shared with desktop app
// ═══════════════════════════════════════════════════════════

const SHARED_DIR = path.join(app.getPath("appData"), "SalesCallAnalyzer");
const DB_PATH    = path.join(SHARED_DIR, "sales.json");

fs.mkdirSync(SHARED_DIR, { recursive: true });

function hashPw(pw) {
  return crypto.createHash("sha256").update(pw, "utf8").digest("hex");
}
function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

const DEFAULT_DB = {
  contacts: [],
  calls:    [],
  admin:    { username: "admin", password_hash: hashPw("admin") },
  managers: [{
    id: 1, name: "Менеджер", username: "manager",
    password_hash: hashPw("12345"),
    avatar: "МН", color: "#6366f1",
    violations: 0, calls_count: 0, avg_score: null,
  }],
};

let db = JSON.parse(JSON.stringify(DEFAULT_DB));
const adminSessions = {};  // token → true (in-memory, reset on restart)

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      db = { ...DEFAULT_DB, ...parsed };
      for (const m of db.managers || []) {
        if (!m.username)      m.username      = `manager${m.id}`;
        if (!m.password_hash) m.password_hash = hashPw("12345");
      }
    }
  } catch (e) {
    console.log("[DB] load error, using defaults:", e.message);
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

loadDB();
console.log("[Admin DB] ready →", DB_PATH);

function nextId(arr) {
  return Math.max(0, ...arr.map(r => r.id || 0)) + 1;
}

function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ═══════════════════════════════════════════════════════════
// LOCAL ROUTE HANDLER
// ═══════════════════════════════════════════════════════════

function isLocalEndpoint(endpoint) {
  return (
    endpoint.startsWith("/api/auth") ||
    endpoint.startsWith("/api/calls") ||
    endpoint.startsWith("/api/contacts") ||
    endpoint.startsWith("/api/managers")
  );
}

function handleLocal(endpoint, method, body, token) {
  const seg = endpoint.split("/").filter(Boolean);

  // ── AUTH ────────────────────────────────────────────────
  if (endpoint === "/api/auth/admin" && method === "POST") {
    const { username, password } = body || {};
    const adm = db.admin || {};
    if ((username || "").trim() !== adm.username)  return { error: "Неверный логин или пароль" };
    if (hashPw(password || "") !== adm.password_hash) return { error: "Неверный логин или пароль" };
    const t = genToken();
    adminSessions[t] = true;
    return { ok: true, token: t };
  }

  if (endpoint === "/api/auth/admin" && method === "PUT") {
    if (!adminSessions[token]) return { error: "Требуется доступ администратора" };
    const { username, password } = body || {};
    if (!(username || "").trim()) return { error: "Логин не может быть пустым" };
    if (password && password.length < 4) return { error: "Пароль минимум 4 символа" };
    // Reload DB first to pick up changes from desktop app
    loadDB();
    db.admin.username = username.trim();
    if (password) db.admin.password_hash = hashPw(password);
    saveDB();
    return { ok: true };
  }

  if (endpoint === "/api/auth/logout") {
    delete adminSessions[token];
    return { ok: true };
  }

  // ── CALLS (read-only for admin) ─────────────────────────
  if (endpoint === "/api/calls" && method === "GET") {
    loadDB(); // always fresh
    return [...db.calls].reverse();
  }

  // ── CONTACTS (read-only for admin) ──────────────────────
  if (endpoint === "/api/contacts" && method === "GET") {
    loadDB();
    return [...db.contacts].reverse();
  }

  // ── MANAGERS ─────────────────────────────────────────────
  if (endpoint === "/api/managers" && method === "GET") {
    loadDB();
    return db.managers.map(({ password_hash, ...m }) => m);
  }

  if (endpoint === "/api/managers" && method === "POST") {
    if (!adminSessions[token]) return { error: "Требуется доступ администратора" };
    loadDB();
    const { name, username, password, color } = body || {};
    if (!(name     || "").trim()) return { error: "Имя обязательно" };
    if (!(username || "").trim()) return { error: "Логин обязателен" };
    if (!password)                return { error: "Пароль обязателен" };
    if (db.managers.find(m => m.username === username.trim())) return { error: "Логин уже занят" };
    const initials = name.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2);
    const mgr = {
      id: nextId(db.managers), name: name.trim(), username: username.trim(),
      password_hash: hashPw(password), avatar: initials,
      color: color || "#6366f1", violations: 0, calls_count: 0, avg_score: null,
    };
    db.managers.push(mgr);
    saveDB();
    return { ok: true, id: mgr.id };
  }

  // PUT /api/managers/:id
  if (seg.length === 3 && seg[1] === "managers" && method === "PUT") {
    if (!adminSessions[token]) return { error: "Требуется доступ администратора" };
    loadDB();
    const id  = parseInt(seg[2]);
    const mgr = db.managers.find(m => m.id === id);
    if (!mgr) return { error: "Not found" };
    if ((body.name || "").trim()) {
      mgr.name   = body.name.trim();
      mgr.avatar = body.name.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2);
    }
    if (body.username) {
      const nu = body.username.trim();
      if (nu !== mgr.username && db.managers.find(m => m.username === nu && m.id !== id))
        return { error: "Логин уже занят" };
      mgr.username = nu;
    }
    if (body.password) mgr.password_hash = hashPw(body.password);
    if (body.color)    mgr.color         = body.color;
    saveDB();
    return { ok: true };
  }

  // DELETE /api/managers/:id
  if (seg.length === 3 && seg[1] === "managers" && method === "DELETE") {
    if (!adminSessions[token]) return { error: "Требуется доступ администратора" };
    loadDB();
    db.managers = db.managers.filter(m => m.id !== parseInt(seg[2]));
    saveDB();
    return { ok: true };
  }

  // DELETE /api/managers/:id/reset
  if (seg.length === 4 && seg[1] === "managers" && seg[3] === "reset" && method === "DELETE") {
    loadDB();
    const mgr = db.managers.find(m => m.id === parseInt(seg[2]));
    if (mgr) { mgr.violations = 0; mgr.calls_count = 0; mgr.avg_score = null; saveDB(); }
    return { ok: true };
  }

  return null;
}

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
// API IPC — local or backend
// ═══════════════════════════════════════════════════════════

async function apiBackend(endpoint, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  const opts    = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(`${BACKEND_URL}${endpoint}`, opts);
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

function apiCall(endpoint, method = "GET", body = null) {
  if (isLocalEndpoint(endpoint)) return handleLocal(endpoint, method, body, adminToken);
  return apiBackend(endpoint, method, body);
}

ipcMain.handle("api-get",       (_, ep)      => apiCall(ep, "GET"));
ipcMain.handle("api-post",      (_, ep, body) => apiCall(ep, "POST", body));
ipcMain.handle("api-put",       (_, ep, body) => apiCall(ep, "PUT", body));
ipcMain.handle("api-delete",    (_, ep)       => apiCall(ep, "DELETE"));
ipcMain.handle("api-set-token", (_, token)    => { adminToken = token; return { ok: true }; });
