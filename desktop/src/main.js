const { app, BrowserWindow, ipcMain, Notification } = require("electron");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const WS     = require("ws");

const BACKEND_WS  = process.env.BACKEND_WS  || "ws://localhost:3001";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

let mainWindow = null;
let wsClient   = null;
let authToken  = null;  // current manager session token

// ═══════════════════════════════════════════════════════════
// LOCAL DATABASE — shared between desktop and admin apps
// ═══════════════════════════════════════════════════════════

const SHARED_DIR    = path.join(app.getPath("appData"), "SalesCallAnalyzer");
const DB_PATH       = path.join(SHARED_DIR, "sales.json");
const RECORDINGS_DIR = path.join(SHARED_DIR, "recordings");

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

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

// In-memory session maps (reset on restart — by design)
const sessions      = {};  // token → manager_id
const adminSessions = {};  // token → true

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      db = { ...DEFAULT_DB, ...parsed };
      // Migrate managers: ensure username + password_hash exist
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
console.log("[DB] ready →", DB_PATH);
console.log("[REC] recordings →", RECORDINGS_DIR);

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
  const seg = endpoint.split("/").filter(Boolean);  // ["api","calls","5"]

  // ── AUTH ────────────────────────────────────────────────
  if (endpoint === "/api/auth/login" && method === "POST") {
    const { username, password } = body || {};
    const mgr = db.managers.find(m => m.username === (username || "").trim());
    if (!mgr || hashPw(password || "") !== mgr.password_hash)
      return { error: "Неверный логин или пароль" };
    const t = genToken();
    sessions[t] = mgr.id;
    return { ok: true, token: t, id: mgr.id, name: mgr.name };
  }

  if (endpoint === "/api/auth/me" && method === "GET") {
    const mid = sessions[token];
    const mgr = mid != null ? db.managers.find(m => m.id === mid) : null;
    if (!mgr) return { error: "Unauthorized" };
    const { password_hash, ...safe } = mgr;
    return safe;
  }

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
    db.admin.username = username.trim();
    if (password) db.admin.password_hash = hashPw(password);
    saveDB();
    return { ok: true };
  }

  if (endpoint === "/api/auth/logout") {
    delete sessions[token];
    delete adminSessions[token];
    return { ok: true };
  }

  // ── CALLS ───────────────────────────────────────────────
  if (endpoint === "/api/calls" && method === "GET") {
    return [...db.calls].reverse();
  }

  if (endpoint === "/api/calls" && method === "POST") {
    const call = {
      id:             nextId(db.calls),
      phone:          body.phone          || "",
      direction:      body.direction      || "outbound",
      duration:       body.duration       || 0,
      transcript:     body.transcript     || "",
      summary:        body.summary        || "",
      score:          body.score          ?? null,
      errors:         body.errors         || [],
      positives:      body.positives      || [],
      recommendation: body.recommendation || "",
      saved:          !!body.saved,
      contact_id:     body.contact_id     || null,
      audioFile:      body.audioFile      || null,
      created_at:     nowStr(),
    };
    db.calls.push(call);
    saveDB();
    return { ok: true, id: call.id };
  }

  // PUT /api/calls/:id
  if (seg.length === 3 && seg[1] === "calls" && method === "PUT") {
    const id   = parseInt(seg[2]);
    const call = db.calls.find(c => c.id === id);
    if (!call) return { error: "Not found" };
    Object.assign(call, body);
    saveDB();
    return { ok: true };
  }

  // DELETE /api/calls/:id
  if (seg.length === 3 && seg[1] === "calls" && method === "DELETE") {
    const id   = parseInt(seg[2]);
    const call = db.calls.find(c => c.id === id);
    if (call?.audioFile) {
      const fp = path.join(RECORDINGS_DIR, call.audioFile);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    db.calls = db.calls.filter(c => c.id !== id);
    saveDB();
    return { ok: true };
  }

  // ── CONTACTS ─────────────────────────────────────────────
  if (endpoint === "/api/contacts" && method === "GET") {
    return [...db.contacts].reverse();
  }

  // GET /api/contacts/:id
  if (seg.length === 3 && seg[1] === "contacts" && method === "GET") {
    const id = parseInt(seg[2]);
    const c  = db.contacts.find(c => c.id === id);
    if (!c) return { error: "Not found" };
    return { ...c, calls: [...db.calls.filter(ca => ca.contact_id === id)].reverse() };
  }

  if (endpoint === "/api/contacts" && method === "POST") {
    const { phone, company, name, summary, transcript, score, errors, recommendation, call_id } = body || {};
    let existing  = db.contacts.find(c => c.phone === phone);
    let contact_id;
    if (existing) {
      if (company       != null) existing.company       = company       || existing.company;
      if (name          != null) existing.name          = name          || existing.name;
      if (summary       != null) existing.summary       = summary       || existing.summary;
      if (transcript    != null) existing.transcript    = transcript    || existing.transcript;
      if (score         != null) existing.score         = score;
      if (errors        != null) existing.errors        = errors;
      if (recommendation!= null) existing.recommendation= recommendation;
      existing.calls_count = (existing.calls_count || 1) + 1;
      existing.updated_at  = nowStr();
      contact_id = existing.id;
    } else {
      const contact = {
        id: nextId(db.contacts), phone,
        company: company || "", name: name || "",
        summary: summary || "", transcript: transcript || "",
        score: score ?? null, errors: errors || [],
        recommendation: recommendation || "", calls_count: 1,
        created_at: nowStr(), updated_at: nowStr(),
      };
      db.contacts.push(contact);
      contact_id = contact.id;
    }
    if (call_id) {
      const call = db.calls.find(c => c.id === call_id);
      if (call) { call.saved = true; call.contact_id = contact_id; }
    }
    saveDB();
    return { ok: true, id: contact_id };
  }

  // PUT /api/contacts/:id
  if (seg.length === 3 && seg[1] === "contacts" && method === "PUT") {
    const id = parseInt(seg[2]);
    const c  = db.contacts.find(c => c.id === id);
    if (!c) return { error: "Not found" };
    Object.assign(c, body, { updated_at: nowStr() });
    saveDB();
    return { ok: true };
  }

  // DELETE /api/contacts/:id
  if (seg.length === 3 && seg[1] === "contacts" && method === "DELETE") {
    db.contacts = db.contacts.filter(c => c.id !== parseInt(seg[2]));
    saveDB();
    return { ok: true };
  }

  // ── MANAGERS ─────────────────────────────────────────────
  if (endpoint === "/api/managers" && method === "GET") {
    return db.managers.map(({ password_hash, ...m }) => m);
  }

  if (endpoint === "/api/managers" && method === "POST") {
    if (!adminSessions[token]) return { error: "Требуется доступ администратора" };
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
    db.managers = db.managers.filter(m => m.id !== parseInt(seg[2]));
    saveDB();
    return { ok: true };
  }

  // POST /api/managers/:id/stats
  if (seg.length === 4 && seg[1] === "managers" && seg[3] === "stats" && method === "POST") {
    const id  = parseInt(seg[2]);
    const mgr = db.managers.find(m => m.id === id);
    if (!mgr) return { error: "Not found" };
    const { score = 0, violations = 0 } = body || {};
    mgr.calls_count = (mgr.calls_count || 0) + 1;
    mgr.avg_score   = mgr.avg_score == null
      ? score
      : Math.round((mgr.avg_score * (mgr.calls_count - 1) + score) / mgr.calls_count);
    mgr.violations  = (mgr.violations || 0) + violations;
    saveDB();
    return { ok: true };
  }

  // DELETE /api/managers/:id/reset
  if (seg.length === 4 && seg[1] === "managers" && seg[3] === "reset" && method === "DELETE") {
    const mgr = db.managers.find(m => m.id === parseInt(seg[2]));
    if (mgr) { mgr.violations = 0; mgr.calls_count = 0; mgr.avg_score = null; saveDB(); }
    return { ok: true };
  }

  return null; // not handled locally — forward to backend
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
    wsClient.on("error", () => {});
    wsClient.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session_started") mainWindow?.webContents.send("session-started", msg.sessionId);
        if (msg.type === "processing")      mainWindow?.webContents.send("processing");
        if (msg.type === "call_analyzed") {
          mainWindow?.webContents.send("call-analyzed", msg);
          new Notification({ title: "Звонок проанализирован", body: `Оценка: ${msg.analysis?.score || "—"}/100` }).show();
        }
        if (msg.type === "error") mainWindow?.webContents.send("stream-error", msg.error);
        if (["call_saved", "contact_saved", "call_started"].includes(msg.type))
          mainWindow?.webContents.send("data-updated", msg.type);
      } catch (_) {}
    });
  } catch (_) { setTimeout(connectBackend, 3000); }
}

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

// Save audio buffer to local recordings dir; returns { ok, filename }
ipcMain.handle("save-audio", (_, { callId, audioBuffer }) => {
  try {
    const filename = `${callId}.webm`;
    fs.writeFileSync(path.join(RECORDINGS_DIR, filename), Buffer.from(audioBuffer));
    return { ok: true, filename };
  } catch (e) {
    return { error: e.message };
  }
});

// Read audio file; returns Buffer (sent as ArrayBuffer over IPC)
ipcMain.handle("get-audio-data", (_, filename) => {
  try {
    const fp = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  } catch (_) { return null; }
});

// Delete audio file only (not the call record)
ipcMain.handle("delete-audio-file", (_, filename) => {
  try {
    const fp = path.join(RECORDINGS_DIR, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// Download backend temp audio (for Android source recordings)
ipcMain.handle("download-audio", async (_, audioId) => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/audio/${audioId}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (_) { return null; }
});

// Send a local recording file to backend /api/transcribe; returns { transcript, duration }
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
  } catch (e) {
    return { error: e.message };
  }
});

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
  if (isLocalEndpoint(endpoint)) return handleLocal(endpoint, method, body, authToken);
  return apiBackend(endpoint, method, body);
}

ipcMain.handle("api-get",       (_, ep)      => apiCall(ep, "GET"));
ipcMain.handle("api-post",      (_, ep, body) => apiCall(ep, "POST", body));
ipcMain.handle("api-put",       (_, ep, body) => apiCall(ep, "PUT", body));
ipcMain.handle("api-delete",    (_, ep)       => apiCall(ep, "DELETE"));
ipcMain.handle("api-set-token", (_, token)    => { authToken = token; return { ok: true }; });
ipcMain.handle("api-login",     (_, creds)    => handleLocal("/api/auth/login", "POST", creds, null));
ipcMain.handle("ws-status-query", ()          => wsClient?.readyState === WS.OPEN ? "connected" : "disconnected");
