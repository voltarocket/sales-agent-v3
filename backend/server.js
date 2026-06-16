import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { spawnSync, execSync } from "child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

import PQueue from "p-queue";

import { pool, query, waitForDb } from "./db.js";
import { redis, setJob, getJob } from "./redis.js";
import { licenseState, initLicense, activateLicense, checkRateLimit, trackUsage } from "./license.js";

dotenv.config();

// ── AI processing queue ────────────────────────────────────────────────────────
// Limits concurrent Groq API calls + ffmpeg processes.
// Default 3 — safe for Groq free tier (~10 req/min). Raise to 5-8 on paid plan.
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY || "3");
const aiQueue = new PQueue({ concurrency: AI_CONCURRENCY });
console.log(`[Queue] AI concurrency: ${AI_CONCURRENCY}  (env AI_CONCURRENCY to change)`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: "/" });
const upload = multer({ dest: "uploads/", limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// FFMPEG  (local — only for PCM → WAV pre-processing)
// ═══════════════════════════════════════════════════════════
function findFfmpeg() {
  const candidates = [
    "ffmpeg",
    process.env.FFMPEG_PATH,
    "C:\\Users\\volta\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe",
    "/c/ffmpeg/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ].filter(Boolean);
  try {
    const r = execSync("where ffmpeg 2>nul || which ffmpeg 2>/dev/null", { encoding: "utf8" }).trim();
    if (r) candidates.unshift(r.split("\n")[0].trim());
  } catch (_) {}
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["-version"], { encoding: "utf8", timeout: 3000 });
      if (r.status === 0) { console.log(`[FFMPEG] ✓ ${cmd}`); return cmd; }
    } catch (_) {}
  }
  return null;
}
const FFMPEG = findFfmpeg();

// ═══════════════════════════════════════════════════════════
// GLOBAL BACKEND — AI gateway
// ═══════════════════════════════════════════════════════════
const GLOBAL_URL   = process.env.GLOBAL_BACKEND_URL || "http://localhost:3002";
const WEBSITE_URL  = process.env.WEBSITE_URL        || "http://localhost:3003";

async function sendToGlobalBackend(wavPath, managerName, phone) {
  const form = new FormData();
  form.append("audio", fs.createReadStream(wavPath), {
    filename: "audio.wav",
    contentType: "audio/wav",
  });
  form.append("managerName", managerName || "Менеджер");
  form.append("phone", phone || "unknown");

  const licenseHeaders = {};
  if (process.env.LICENSE_KEY) {
    licenseHeaders["x-license-key"] = process.env.LICENSE_KEY;
    licenseHeaders["x-device-id"]   = process.env.DEVICE_ID || "unknown";
  }

  const r = await fetch(`${GLOBAL_URL}/process`, {
    method: "POST",
    headers: { ...form.getHeaders(), ...licenseHeaders },
    body: form,
    timeout: 120000,
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `Global backend error ${r.status}`);
  }
  return r.json();
}

// ═══════════════════════════════════════════════════════════
// WEBSOCKET — audio streaming sessions
// ═══════════════════════════════════════════════════════════
const sessions = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on("connection", ws => {
  console.log("[WS] client connected");
  let sessionId = null;

  ws.on("message", async (data) => {
    if (Buffer.isBuffer(data) && sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId).chunks.push(data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.type === "call_start") {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      sessions.set(sessionId, {
        ws,
        phone: msg.phone || "unknown",
        managerId: msg.managerId || null,
        managerName: msg.managerName || "Менеджер",
        chunks: [],
        startTime: Date.now(),
      });
      ws.send(JSON.stringify({ type: "session_started", sessionId }));
      console.log(`[WS] call_start → ${sessionId} phone=${msg.phone}`);
    }

    if (msg.type === "call_end" && sessionId && sessions.has(sessionId)) {
      console.log(`[WS] call_end → ${sessionId}`);
      const session  = sessions.get(sessionId);
      sessions.delete(sessionId);

      const jobId   = sessionId;
      const duration = Math.round((Date.now() - session.startTime) / 1000);

      const queuePos = aiQueue.size; // jobs waiting (not counting running)
      await setJob(jobId, "queued", { position: queuePos });

      // Tell the client: queued or processing immediately
      if (queuePos > 0) {
        ws.send(JSON.stringify({ type: "queued", position: queuePos, jobId }));
        console.log(`[Queue] ${jobId} queued (position ${queuePos}, running ${aiQueue.pending})`);
      } else {
        ws.send(JSON.stringify({ type: "processing", jobId }));
      }

      // Add to queue — does not block the WS message handler
      aiQueue.add(async () => {
        await setJob(jobId, "processing");
        ws.send(JSON.stringify({ type: "processing", jobId }));
        console.log(`[Queue] ${jobId} started  (queue size now: ${aiQueue.size})`);
        try {
          const result = await processSession(session, duration);
          await setJob(jobId, "done", { callId: result.callId });
          ws.send(JSON.stringify({ type: "call_analyzed", ...result }));
          console.log(`[Queue] ${jobId} done → callId=${result.callId} score=${result.analysis?.score}`);
        } catch (e) {
          console.error(`[Queue] ${jobId} error:`, e.message);
          await setJob(jobId, "error", { error: e.message });
          ws.send(JSON.stringify({ type: "error", error: e.message, jobId }));
        }
      });

      sessionId = null;
    }
  });

  ws.on("close", () => {
    console.log("[WS] client disconnected");
    if (sessionId) sessions.delete(sessionId);
  });

  ws.on("error", (e) => console.error("[WS] error:", e.message));
  ws.send(JSON.stringify({ type: "connected", ts: Date.now() }));
});

async function processSession(session, duration) {
  const audioBuffer = Buffer.concat(session.chunks);
  console.log(`[WS] audio buffer: ${audioBuffer.length} bytes, duration: ${duration}s`);

  let transcript = "";
  let analysis   = { summary: "", score: 0, errors: [], positives: [], recommendation: "" };

  if (audioBuffer.length > 1000 && FFMPEG) {
    // Check license rate limit before calling AI
    const rateCheck = await checkRateLimit();
    if (!rateCheck.allowed) {
      if (rateCheck.reason) {
        console.warn(`[WS] license blocked: ${rateCheck.reason}`);
        throw new Error(`License error: ${rateCheck.reason}`);
      }
      console.warn(`[WS] rate limit reached (${rateCheck.current}/${rateCheck.limit})`);
      throw new Error(`Monthly AI request limit reached (${rateCheck.current}/${rateCheck.limit})`);
    }

    const tmpPcm = path.join("uploads", `ws_${Date.now()}.pcm`);
    const tmpWav = tmpPcm + ".wav";
    fs.writeFileSync(tmpPcm, audioBuffer);

    try {
      const r = spawnSync(FFMPEG, [
        "-y", "-f", "s16le", "-ar", "16000", "-ac", "1",
        "-i", tmpPcm, tmpWav,
      ], { encoding: "utf8", timeout: 30000 });

      if (r.status === 0) {
        const result = await sendToGlobalBackend(tmpWav, session.managerName, session.phone);
        transcript = result.transcript || "";
        analysis   = result.analysis   || analysis;
        trackUsage(GLOBAL_URL); // async, non-blocking
      } else {
        console.warn("[WS] ffmpeg convert failed:", r.stderr);
      }

      if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
    } finally {
      if (fs.existsSync(tmpPcm)) fs.unlinkSync(tmpPcm);
    }
  }

  const { rows: [call] } = await query(
    `INSERT INTO calls
       (phone, direction, duration, transcript, summary, score, errors, positives, recommendation, manager_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      session.phone, "outbound", duration,
      transcript,
      analysis.summary        || "",
      analysis.score          || 0,
      JSON.stringify(analysis.errors    || []),
      JSON.stringify(analysis.positives || []),
      analysis.recommendation || "",
      session.managerId       || null,
    ]
  );

  return {
    callId: call.id,
    phone:  session.phone,
    duration,
    transcript,
    analysis,
  };
}

// ═══════════════════════════════════════════════════════════
// ADMIN PROXY — license & plan management → global backend
// ═══════════════════════════════════════════════════════════
async function adminProxy(path, method = "GET", body = null) {
  const headers = {
    "Content-Type": "application/json",
    "x-admin-secret": process.env.GLOBAL_ADMIN_SECRET || "",
  };
  const opts = { method, headers, timeout: 10000 };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${GLOBAL_URL}${path}`, opts);
  return r.json();
}

// Plans
app.get("/api/plans",          async (_, res) => res.json(await adminProxy("/plans")));
app.post("/api/plans",         async (req, res) => res.json(await adminProxy("/plans", "POST", req.body)));
app.put("/api/plans/:name",    async (req, res) => res.json(await adminProxy(`/plans/${req.params.name}`, "PUT", req.body)));
app.delete("/api/plans/:name", async (req, res) => res.json(await adminProxy(`/plans/${req.params.name}`, "DELETE")));

// Licenses
app.get("/api/licenses",            async (_, res) => res.json(await adminProxy("/licenses")));
app.post("/api/licenses/issue",     async (req, res) => res.json(await adminProxy("/licenses/issue", "POST", req.body)));
app.put("/api/licenses/:key",       async (req, res) => res.json(await adminProxy(`/licenses/${req.params.key}`, "PATCH", req.body)));
app.delete("/api/licenses/:key",    async (req, res) => res.json(await adminProxy(`/licenses/${req.params.key}`, "DELETE")));
app.get("/api/licenses/:key/status", async (req, res) => res.json(await adminProxy(`/licenses/${req.params.key}/status`)));

// ═══════════════════════════════════════════════════════════
// JOB STATUS
// ═══════════════════════════════════════════════════════════
app.get("/api/jobs/:jobId", async (req, res) => {
  const job = await getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ═══════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════
app.get("/api/health", async (_, res) => {
  let globalOk = false;
  try {
    const r = await fetch(`${GLOBAL_URL}/health`, { timeout: 3000 });
    globalOk = r.ok;
  } catch (_) {}

  let dbOk = false;
  try { await pool.query("SELECT 1"); dbOk = true; } catch (_) {}

  let redisOk = false;
  try { await redis.ping(); redisOk = true; } catch (_) {}

  res.json({
    ok: true,
    db: dbOk,
    redis: redisOk,
    globalBackend: globalOk,
    ffmpeg: !!FFMPEG,
    license: {
      valid:   licenseState.valid,
      plan:    licenseState.plan,
      checked: licenseState.checked,
    },
    sip: {
      host:      process.env.FREEPBX_HOST    || "localhost",
      wsPort:    process.env.FREEPBX_WS_PORT || "8088",
      extension: process.env.FREEPBX_EXTENSION || "not set",
    },
    queue: {
      waiting:     aiQueue.size,
      running:     aiQueue.pending,
      concurrency: AI_CONCURRENCY,
    },
  });
});

app.get("/api/queue/status", (_, res) => {
  res.json({
    waiting:     aiQueue.size,
    running:     aiQueue.pending,
    concurrency: AI_CONCURRENCY,
    idle:        aiQueue.size === 0 && aiQueue.pending === 0,
  });
});

// ═══════════════════════════════════════════════════════════
// AUTH API
// ═══════════════════════════════════════════════════════════
const managerSessions = new Map(); // token → managerId
const adminSessions   = new Set(); // token

function hashPw(pw) {
  return crypto.createHash("sha256").update(pw, "utf8").digest("hex");
}
function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Manager login
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ error: "Логин и пароль обязательны" });
  const { rows: [mgr] } = await query(
    "SELECT * FROM managers WHERE username=$1 AND password_hash=$2",
    [username.trim(), hashPw(password)]
  );
  if (!mgr) return res.json({ error: "Неверный логин или пароль" });
  const token = genToken();
  managerSessions.set(token, mgr.id);
  const { password_hash, ...safe } = mgr;
  res.json({ ok: true, token, id: mgr.id, name: mgr.name, ...safe });
});

// Manager whoami
app.get("/api/auth/me", async (req, res) => {
  const token = req.headers["x-auth-token"];
  const mid   = managerSessions.get(token);
  if (!mid) return res.status(401).json({ error: "Unauthorized" });
  const { rows: [mgr] } = await query("SELECT * FROM managers WHERE id=$1", [mid]);
  if (!mgr) return res.status(401).json({ error: "Unauthorized" });
  const { password_hash, ...safe } = mgr;
  res.json(safe);
});

// Admin login — via website credentials (email + password)
app.post("/api/auth/admin", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.json({ error: "Email и пароль обязательны" });

  let websiteUser = null;
  try {
    const r = await fetch(`${WEBSITE_URL}/api/auth/verify`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email: email.trim().toLowerCase(), password }),
      signal:  AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (!data.ok) return res.json({ error: data.error || "Неверный email или пароль" });
    websiteUser = data.user;
  } catch (e) {
    return res.json({ error: "Сайт недоступен. Проверьте подключение." });
  }

  // Auto-activate license if the account has one and it's not yet set
  const licenseKey = websiteUser.license_key;
  if (licenseKey && !licenseState.valid) {
    try {
      await activateLicense(GLOBAL_URL, licenseKey, query);
      console.log(`[LICENSE] auto-activated from website account: ${licenseKey}`);
    } catch (e) {
      console.warn("[LICENSE] auto-activation failed:", e.message);
    }
  }

  const token = genToken();
  adminSessions.add(token);
  res.json({ ok: true, token, email: websiteUser.email, name: websiteUser.name, license_key: licenseKey });
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  const token = req.headers["x-auth-token"];
  managerSessions.delete(token);
  adminSessions.delete(token);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// LICENSE STATUS + ACTIVATION
// ═══════════════════════════════════════════════════════════
app.get("/api/license/status", (_, res) => {
  const k = licenseState.key;
  res.json({
    ...licenseState,
    keyMasked: k ? k.slice(0, 14) + "…" : null,
    deviceId:  process.env.DEVICE_ID || null,
  });
});

// License is activated automatically on admin login via website credentials.

// ═══════════════════════════════════════════════════════════
// SIP CONFIG
// ═══════════════════════════════════════════════════════════
app.get("/api/sip/config", (req, res) => {
  const host   = process.env.FREEPBX_HOST    || "localhost";
  const wsPort = process.env.FREEPBX_WS_PORT || "8088";
  const domain = process.env.FREEPBX_DOMAIN  || host;
  const wsUri  = `ws://${host}:${wsPort}/ws`;

  const extensions = [];
  if (process.env.FREEPBX_EXTENSION && process.env.FREEPBX_PASSWORD)
    extensions.push({ extension: process.env.FREEPBX_EXTENSION, password: process.env.FREEPBX_PASSWORD, label: "Менеджер" });
  if (process.env.FREEPBX_EXT_2 && process.env.FREEPBX_PASS_2)
    extensions.push({ extension: process.env.FREEPBX_EXT_2, password: process.env.FREEPBX_PASS_2, label: "Клиент" });

  if (extensions.length === 0)
    return res.status(503).json({ error: "FreePBX not configured", hint: "Set FREEPBX_EXTENSION and FREEPBX_PASSWORD in .env" });

  const requested = req.query.ext;
  if (requested) {
    const found = extensions.find(e => e.extension === requested);
    if (!found) return res.status(404).json({ error: "Extension not found" });
    return res.json({ ...found, domain, wsUri });
  }

  res.json({ ...extensions[0], domain, wsUri, extensions });
});

// ═══════════════════════════════════════════════════════════
// TRANSCRIPTION  (proxy to global backend)
// ═══════════════════════════════════════════════════════════
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  try {
    const form = new FormData();
    form.append("audio", fs.createReadStream(req.file.path), {
      filename: req.file.originalname || "audio",
      contentType: req.file.mimetype,
    });
    form.append("managerName", req.body.managerName || "Менеджер");

    const r = await fetch(`${GLOBAL_URL}/process`, {
      method: "POST",
      headers: form.getHeaders(),
      body: form,
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Global ${r.status}`); }
    const d = await r.json();
    res.json({ transcript: d.transcript, duration: d.duration });
  } catch (e) {
    console.error("[STT proxy]", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// ═══════════════════════════════════════════════════════════
// ANALYSIS  (proxy to global backend — text only path)
// ═══════════════════════════════════════════════════════════
app.post("/api/analyze", async (req, res) => {
  const { managerName = "Менеджер", transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: "transcript required" });

  try {
    const r = await fetch(`${GLOBAL_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ managerName, transcript }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Global ${r.status}`); }
    res.json(await r.json());
  } catch (e) {
    console.error("[LLM proxy]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CALLS API
// ═══════════════════════════════════════════════════════════
app.get("/api/calls", async (_, res) => {
  const { rows } = await query("SELECT * FROM calls ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/calls", async (req, res) => {
  const { phone = "", direction = "outbound", duration = 0, transcript = "",
          summary = "", score = null, errors = [], positives = [],
          recommendation = "", saved = false, contact_id = null, manager_id = null } = req.body;

  const { rows: [call] } = await query(
    `INSERT INTO calls
       (phone, direction, duration, transcript, summary, score, errors, positives, recommendation, saved, contact_id, manager_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [phone, direction, duration, transcript, summary, score,
     JSON.stringify(errors), JSON.stringify(positives), recommendation,
     saved, contact_id, manager_id]
  );

  broadcast({ type: "call_saved", id: call.id, phone: call.phone });
  res.json({ ok: true, id: call.id });
});

app.put("/api/calls/:id", async (req, res) => {
  const { admin_comment, saved, contact_id } = req.body;
  const parts = [];
  const vals  = [];
  let idx = 1;
  if (admin_comment !== undefined) { parts.push(`admin_comment=$${idx++}`); vals.push(admin_comment); }
  if (saved         !== undefined) { parts.push(`saved=$${idx++}`);         vals.push(saved); }
  if (contact_id    !== undefined) { parts.push(`contact_id=$${idx++}`);    vals.push(contact_id); }
  if (!parts.length) return res.json({ ok: true });
  vals.push(+req.params.id);
  await query(`UPDATE calls SET ${parts.join(", ")} WHERE id=$${idx}`, vals);
  res.json({ ok: true });
});

app.delete("/api/calls/:id", async (req, res) => {
  await query("DELETE FROM calls WHERE id=$1", [+req.params.id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// CONTACTS API
// ═══════════════════════════════════════════════════════════
app.get("/api/contacts", async (_, res) => {
  const { rows } = await query("SELECT * FROM contacts ORDER BY created_at DESC");
  res.json(rows);
});

app.get("/api/contacts/:id", async (req, res) => {
  const { rows: [contact] } = await query("SELECT * FROM contacts WHERE id=$1", [+req.params.id]);
  if (!contact) return res.status(404).json({ error: "Not found" });
  const { rows: calls } = await query("SELECT * FROM calls WHERE contact_id=$1 ORDER BY created_at DESC", [contact.id]);
  res.json({ ...contact, calls });
});

app.post("/api/contacts", async (req, res) => {
  const { phone, company, name, summary, transcript, score, errors, recommendation, call_id } = req.body;

  const { rows: [existing] } = await query("SELECT * FROM contacts WHERE phone=$1", [phone]);
  let contactId;

  if (existing) {
    await query(
      `UPDATE contacts SET
         company=$1, name=$2, summary=$3, transcript=$4, score=$5,
         errors=$6, recommendation=$7,
         calls_count=calls_count+1, updated_at=NOW()
       WHERE id=$8`,
      [
        company        || existing.company,
        name           || existing.name,
        summary        || existing.summary,
        transcript     || existing.transcript,
        score          || existing.score,
        JSON.stringify(errors || existing.errors || []),
        recommendation || existing.recommendation,
        existing.id,
      ]
    );
    contactId = existing.id;
  } else {
    const { rows: [c] } = await query(
      `INSERT INTO contacts (phone, company, name, summary, transcript, score, errors, recommendation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [phone, company || "", name || "", summary || "", transcript || "",
       score || null, JSON.stringify(errors || []), recommendation || ""]
    );
    contactId = c.id;
  }

  if (call_id) {
    await query("UPDATE calls SET saved=true, contact_id=$1 WHERE id=$2", [contactId, call_id]);
  }

  broadcast({ type: "contact_saved", id: contactId, phone, company });
  res.json({ ok: true, id: contactId });
});

app.put("/api/contacts/:id", async (req, res) => {
  const { rows: [existing] } = await query("SELECT * FROM contacts WHERE id=$1", [+req.params.id]);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const b = req.body;
  await query(
    `UPDATE contacts SET
       phone=$1, company=$2, name=$3, summary=$4, transcript=$5,
       score=$6, errors=$7, recommendation=$8, updated_at=NOW()
     WHERE id=$9`,
    [
      b.phone          ?? existing.phone,
      b.company        ?? existing.company,
      b.name           ?? existing.name,
      b.summary        ?? existing.summary,
      b.transcript     ?? existing.transcript,
      b.score          ?? existing.score,
      JSON.stringify(b.errors ?? existing.errors ?? []),
      b.recommendation ?? existing.recommendation,
      existing.id,
    ]
  );
  res.json({ ok: true });
});

app.delete("/api/contacts/:id", async (req, res) => {
  await query("DELETE FROM contacts WHERE id=$1", [+req.params.id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// MANAGERS API
// ═══════════════════════════════════════════════════════════
app.get("/api/managers", async (_, res) => {
  const { rows } = await query(
    "SELECT id, name, username, avatar, color, violations, calls_count, avg_score FROM managers ORDER BY id"
  );
  res.json(rows);
});

// GET /api/managers/:id/calls
app.get("/api/managers/:id/calls", async (req, res) => {
  const { rows } = await query(
    "SELECT * FROM calls WHERE manager_id=$1 ORDER BY created_at DESC",
    [+req.params.id]
  );
  res.json(rows);
});

app.post("/api/managers", async (req, res) => {
  const { name, username, password, color } = req.body;
  if (!(name     || "").trim()) return res.json({ error: "Имя обязательно" });
  if (!(username || "").trim()) return res.json({ error: "Логин обязателен" });
  if (!password)                return res.json({ error: "Пароль обязателен" });
  const { rows: [dup] } = await query("SELECT id FROM managers WHERE username=$1", [username.trim()]);
  if (dup) return res.json({ error: "Логин уже занят" });
  const avatar = name.trim().split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
  const { rows: [mgr] } = await query(
    "INSERT INTO managers (name, username, password_hash, avatar, color) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [name.trim(), username.trim(), hashPw(password), avatar, color || "#6366f1"]
  );
  res.json({ ok: true, id: mgr.id });
});

app.put("/api/managers/:id", async (req, res) => {
  const { name, username, password, color } = req.body;
  const { rows: [existing] } = await query("SELECT * FROM managers WHERE id=$1", [+req.params.id]);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (username) {
    const { rows: [dup] } = await query(
      "SELECT id FROM managers WHERE username=$1 AND id<>$2", [username.trim(), existing.id]
    );
    if (dup) return res.json({ error: "Логин уже занят" });
  }
  const newName   = (name   || "").trim() || existing.name;
  const newAvatar = newName.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
  await query(
    `UPDATE managers SET name=$1, avatar=$2, color=$3, username=$4
      ${password ? ", password_hash=$6" : ""}
     WHERE id=$5`,
    password
      ? [newName, newAvatar, color ?? existing.color, username?.trim() ?? existing.username, existing.id, hashPw(password)]
      : [newName, newAvatar, color ?? existing.color, username?.trim() ?? existing.username, existing.id]
  );
  res.json({ ok: true });
});

app.delete("/api/managers/:id", async (req, res) => {
  await query("DELETE FROM managers WHERE id=$1", [+req.params.id]);
  res.json({ ok: true });
});

app.post("/api/managers/:id/stats", async (req, res) => {
  const { score = 0, violations = 0 } = req.body;
  const { rows: [mgr] } = await query("SELECT * FROM managers WHERE id=$1", [+req.params.id]);
  if (!mgr) return res.status(404).json({ error: "Not found" });

  const newCount = mgr.calls_count + 1;
  const newAvg   = mgr.avg_score === null
    ? score
    : Math.round((Number(mgr.avg_score) * mgr.calls_count + score) / newCount);

  await query(
    "UPDATE managers SET calls_count=$1, avg_score=$2, violations=violations+$3 WHERE id=$4",
    [newCount, newAvg, violations, mgr.id]
  );
  res.json({ ok: true });
});

app.delete("/api/managers/:id/reset", async (req, res) => {
  await query(
    "UPDATE managers SET violations=0, calls_count=0, avg_score=NULL WHERE id=$1",
    [+req.params.id]
  );
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// SETTINGS API
// ═══════════════════════════════════════════════════════════
app.get("/api/settings", async (_, res) => {
  const { rows } = await query("SELECT key, value FROM settings");
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.put("/api/settings/:key", async (req, res) => {
  const { value } = req.body;
  await query(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
    [req.params.key, String(value)]
  );
  res.json({ ok: true });
});

// Bulk update (for Electron apps compatibility)
app.put("/api/settings", async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    await query(
      "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
      [key, String(value)]
    );
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
app.post("/api/notify", async (req, res) => {
  const { managerName, violations, threshold } = req.body;
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `⚠️ *Sales Alert*\nМенеджер *${managerName}*: *${violations}/${threshold}* нарушений\n🕐 ${new Date().toLocaleString("ru")}`,
          parse_mode: "Markdown",
        }),
      });
      if (!r.ok) throw new Error((await r.json()).description);
      return res.json({ ok: true, mode: "telegram" });
    } catch (e) { console.error("[NOTIFY]", e.message); }
  }
  console.log(`[NOTIFY] ${managerName}: ${violations}/${threshold}`);
  res.json({ ok: true, mode: "console" });
});

// Check violations threshold and notify if needed
app.post("/api/notify-check", async (req, res) => {
  const { managerId } = req.body || {};
  if (!managerId) return res.json({ ok: true });
  try {
    const { rows: [mgr] } = await query("SELECT * FROM managers WHERE id=$1", [+managerId]);
    if (!mgr) return res.json({ ok: true });
    const { rows: [setting] } = await query("SELECT value FROM settings WHERE key='violations_threshold'");
    const threshold = Number(setting?.value) || 5;
    if (mgr.violations > 0 && mgr.violations % threshold === 0) {
      // Send notification
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `⚠️ *Sales Alert*\nМенеджер *${mgr.name}*: *${mgr.violations}/${threshold}* нарушений\n🕐 ${new Date().toLocaleString("ru")}`,
            parse_mode: "Markdown",
          }),
        }).catch(() => {});
      }
    }
  } catch (_) {}
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
fs.mkdirSync("uploads", { recursive: true });

await waitForDb();
await redis.connect(); // in-memory cache, always ready
await initLicense(GLOBAL_URL, query);

const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀  Local Backend → http://localhost:${PORT}`);
  console.log(`    DB           : PostgreSQL`);
  console.log(`    Cache        : in-memory`);
  console.log(`    Global AI    : ${GLOBAL_URL}`);
  console.log(`    License      : ${process.env.LICENSE_KEY ? `${licenseState.plan} (${licenseState.valid ? "valid" : "invalid"})` : "dev mode"}`);
  console.log(`    ffmpeg       : ${FFMPEG ? "✓" : "✗"}`);
  console.log(`    SIP          : ws://localhost:${process.env.FREEPBX_WS_PORT || 8088}/ws`);
  console.log(`    exts         : ${process.env.FREEPBX_EXTENSION || "?"}${process.env.FREEPBX_EXT_2 ? " + " + process.env.FREEPBX_EXT_2 : ""}\n`);
});
