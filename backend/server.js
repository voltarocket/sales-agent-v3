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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: "/" });

const upload = multer({ dest: "uploads/", limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// DATABASE — lowdb (pure JS, no compilation needed)
// ═══════════════════════════════════════════════════════════
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

const adapter = new JSONFile("sales.json");
const db = new Low(adapter, {
  contacts: [],
  calls: [],
  managers: [{ id: 1, name: "Менеджер", avatar: "МН", color: "#6366f1", violations: 0, calls_count: 0, avg_score: null }],
});
await db.read();
console.log("[DB] lowdb ready → sales.json");

function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(r => r.id)) + 1;
}
function now() {
  return new Date().toLocaleString("ru").replace(",", "");
}

// ═══════════════════════════════════════════════════════════
// PROVIDERS
// ═══════════════════════════════════════════════════════════
const TRANSCRIBE = process.env.GROQ_API_KEY  ? "groq"
  : process.env.YANDEX_API_KEY              ? "yandex"
  : null;

const ANALYZE = process.env.YANDEX_API_KEY  ? "yandex"
  : process.env.GROQ_API_KEY               ? "groq"
  : null;

// ═══════════════════════════════════════════════════════════
// FFMPEG
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

function toWav(inputPath) {
  if (!FFMPEG) return null;
  const out = inputPath + ".wav";
  const r = spawnSync(FFMPEG,
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", out],
    { encoding: "utf8", timeout: 60000 });
  return r.status === 0 ? out : null;
}

function splitWav(wavPath) {
  if (!FFMPEG) return [wavPath];
  const dir = wavPath + "_chunks";
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(FFMPEG,
    ["-y", "-i", wavPath, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
     "-f", "segment", "-segment_time", "30", path.join(dir, "chunk_%03d.wav")],
    { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) return [wavPath];
  const chunks = fs.readdirSync(dir).filter(f => f.endsWith(".wav")).sort().map(f => path.join(dir, f));
  return chunks.length ? chunks : [wavPath];
}

// ═══════════════════════════════════════════════════════════
// WEBSOCKET — Android streaming session
// ═══════════════════════════════════════════════════════════
const sessions = new Map(); // sessionId → { ws, phone, managerId, chunks, startTime }

function broadcastHttp(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on("connection", ws => {
  console.log("[WS] client connected");
  let sessionId = null;

  ws.on("message", async (data) => {
    // Binary = audio chunk
    if (Buffer.isBuffer(data) && sessionId && sessions.has(sessionId)) {
      sessions.get(sessionId).chunks.push(data);
      return;
    }

    // Text = control message
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (_) { return; }

    if (msg.type === "call_start") {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      sessions.set(sessionId, {
        ws,
        phone: msg.phone || "unknown",
        managerId: msg.managerId || 1,
        chunks: [],
        startTime: Date.now(),
      });
      ws.send(JSON.stringify({ type: "session_started", sessionId }));
      console.log(`[WS] call_start → ${sessionId} phone=${msg.phone}`);
    }

    if (msg.type === "call_end" && sessionId && sessions.has(sessionId)) {
      console.log(`[WS] call_end → ${sessionId}`);
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);

      ws.send(JSON.stringify({ type: "processing" }));

      try {
        const duration = Math.round((Date.now() - session.startTime) / 1000);
        const result = await processSession(session, duration);
        ws.send(JSON.stringify({ type: "call_analyzed", ...result }));
        console.log(`[WS] analysis done → score=${result.analysis?.score}`);
      } catch (e) {
        console.error("[WS] processing error:", e.message);
        ws.send(JSON.stringify({ type: "error", error: e.message }));
      }

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
  // Склеиваем чанки в один буфер
  const audioBuffer = Buffer.concat(session.chunks);
  console.log(`[WS] audio buffer: ${audioBuffer.length} bytes, duration: ${duration}s`);

  let transcript = "";

  if (audioBuffer.length > 1000 && TRANSCRIBE) {
    // Сохраняем во временный файл
    const tmpPath = path.join("uploads", `ws_${Date.now()}.pcm`);
    const wavPath = tmpPath + ".wav";
    fs.writeFileSync(tmpPath, audioBuffer);

    try {
      // Конвертируем PCM 16bit mono 16000Hz → wav
      if (FFMPEG) {
        const r = spawnSync(FFMPEG, [
          "-y",
          "-f", "s16le",
          "-ar", "16000",
          "-ac", "1",
          "-i", tmpPath,
          wavPath,
        ], { encoding: "utf8", timeout: 30000 });

        if (r.status === 0) {
          const res = await transcribeGroq(wavPath, "audio.wav", "audio/wav");
          transcript = res.text;
        }
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      }
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  // Анализируем
  let analysis = { summary: "", score: 0, errors: [], positives: [], recommendation: "" };
  if (transcript && ANALYZE) {
    try {
      const raw   = await analyzeGroq("Менеджер", transcript);
      const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      analysis = JSON.parse(clean);
    } catch (e) {
      console.error("[WS] analyze error:", e.message);
    }
  }

  // Сохраняем звонок
  const call = {
    id: nextId(db.data.calls),
    phone: session.phone,
    direction: "outbound",
    duration,
    transcript,
    summary: analysis.summary || "",
    score: analysis.score || 0,
    errors: analysis.errors || [],
    positives: analysis.positives || [],
    recommendation: analysis.recommendation || "",
    saved: false,
    contact_id: null,
    created_at: now(),
  };
  db.data.calls.push(call);
  await db.write();

  return {
    sessionId: `done_${call.id}`,
    phone: session.phone,
    duration,
    transcript,
    analysis,
  };
}

// ═══════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════
app.get("/api/health", (_, res) => res.json({
  ok: true, transcribe: TRANSCRIBE, analyze: ANALYZE, ffmpeg: !!FFMPEG,
  sip: {
    host: process.env.FREEPBX_HOST || "localhost",
    wsPort: process.env.FREEPBX_WS_PORT || "8088",
    extension: process.env.FREEPBX_EXTENSION || "not set",
  },
}));

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
// TRANSCRIPTION
// ═══════════════════════════════════════════════════════════
async function transcribeGroq(filePath, originalName, mimetype) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), {
    filename: originalName || "audio.wav",
    contentType: mimetype || "audio/wav",
  });
  form.append("model", "whisper-large-v3");
  form.append("language", "ru");
  form.append("response_format", "verbose_json");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...form.getHeaders() },
    body: form,
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || `Groq ${r.status}`); }
  const d = await r.json();
  return { text: d.text, duration: d.duration };
}

async function transcribeYandexChunk(wavPath) {
  const data = fs.readFileSync(wavPath);
  if (data.length > 1024 * 1024) throw new Error("Chunk > 1MB");
  const url = new URL("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize");
  url.searchParams.set("folderId", process.env.YANDEX_FOLDER_ID);
  url.searchParams.set("lang", "ru-RU");
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, "Content-Type": "audio/wav" },
    body: data,
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error_message || `SpeechKit ${r.status}`); }
  return (await r.json()).result || "";
}

async function transcribeYandex(filePath) {
  const wav = toWav(filePath);
  const chunks = splitWav(wav || filePath);
  const parts = [];
  for (const c of chunks) parts.push(await transcribeYandexChunk(c));
  if (wav && fs.existsSync(wav)) fs.unlinkSync(wav);
  return { text: parts.join(" ").trim(), duration: null };
}

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  if (!TRANSCRIBE) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "No transcription key in .env" });
  }
  try {
    let result;
    if (TRANSCRIBE === "groq")   result = await transcribeGroq(req.file.path, req.file.originalname, req.file.mimetype);
    else                         result = await transcribeYandex(req.file.path);
    fs.unlinkSync(req.file.path);
    console.log(`[STT] ${TRANSCRIBE} OK | ${result.text.length} chars`);
    res.json({ transcript: result.text, duration: result.duration });
  } catch (e) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("[STT]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════
const SYS = "Ты — тренер по продажам. Отвечай ТОЛЬКО валидным JSON без markdown.";
const buildPrompt = (name, transcript) =>
  `Проанализируй звонок менеджера "${name}".\nТранскрипт: ${transcript}\nJSON:\n{"summary":"2-3 предложения","score":0-100,"errors":[{"title":"","description":"","severity":"high|medium|low","timestamp":""}],"positives":[""],"recommendation":"","nextStepSuggestion":""}`;

async function analyzeGroq(name, transcript) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile", temperature: 0.2, max_tokens: 2000,
      messages: [{ role: "system", content: SYS }, { role: "user", content: buildPrompt(name, transcript) }],
    }),
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message); }
  return (await r.json()).choices[0]?.message?.content || "";
}

async function analyzeYandex(name, transcript) {
  const r = await fetch("https://llm.api.cloud.yandex.net/foundationModels/v1/completion", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Api-Key ${process.env.YANDEX_API_KEY}` },
    body: JSON.stringify({
      modelUri: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite/latest`,
      completionOptions: { stream: false, temperature: 0.2, maxTokens: 2000 },
      messages: [{ role: "system", text: SYS }, { role: "user", text: buildPrompt(name, transcript) }],
    }),
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.message); }
  return (await r.json()).result?.alternatives?.[0]?.message?.text || "";
}

app.post("/api/analyze", async (req, res) => {
  const { managerName = "Менеджер", transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: "transcript required" });
  if (!ANALYZE)    return res.status(500).json({ error: "No analysis key in .env" });
  try {
    const raw   = ANALYZE === "yandex" ? await analyzeYandex(managerName, transcript) : await analyzeGroq(managerName, transcript);
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    console.error("[LLM]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// CALLS API
// ═══════════════════════════════════════════════════════════
app.get("/api/calls", (_, res) => res.json([...db.data.calls].reverse()));

app.post("/api/calls", async (req, res) => {
  const call = {
    id: nextId(db.data.calls),
    phone: req.body.phone || "",
    direction: req.body.direction || "outbound",
    duration: req.body.duration || 0,
    transcript: req.body.transcript || "",
    summary: req.body.summary || "",
    score: req.body.score || null,
    errors: req.body.errors || [],
    positives: req.body.positives || [],
    recommendation: req.body.recommendation || "",
    saved: req.body.saved ? true : false,
    contact_id: req.body.contact_id || null,
    created_at: now(),
  };
  db.data.calls.push(call);
  await db.write();
  broadcastHttp({ type: "call_saved", id: call.id, phone: call.phone });
  res.json({ ok: true, id: call.id });
});

app.delete("/api/calls/:id", async (req, res) => {
  db.data.calls = db.data.calls.filter(c => c.id !== +req.params.id);
  await db.write();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// CONTACTS API
// ═══════════════════════════════════════════════════════════
app.get("/api/contacts", (_, res) => res.json([...db.data.contacts].reverse()));

app.get("/api/contacts/:id", (req, res) => {
  const c = db.data.contacts.find(c => c.id === +req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  const calls = db.data.calls.filter(call => call.contact_id === c.id).reverse();
  res.json({ ...c, calls });
});

app.post("/api/contacts", async (req, res) => {
  const { phone, company, name, summary, transcript, score, errors, recommendation, call_id } = req.body;
  const existing = db.data.contacts.find(c => c.phone === phone);
  let contactId;
  if (existing) {
    existing.company        = company        || existing.company;
    existing.name           = name           || existing.name;
    existing.summary        = summary        || existing.summary;
    existing.transcript     = transcript     || existing.transcript;
    existing.score          = score          || existing.score;
    existing.errors         = errors         || existing.errors;
    existing.recommendation = recommendation || existing.recommendation;
    existing.calls_count    = (existing.calls_count || 1) + 1;
    existing.updated_at     = now();
    contactId = existing.id;
  } else {
    const contact = {
      id: nextId(db.data.contacts),
      phone, company: company || "", name: name || "",
      summary: summary || "", transcript: transcript || "",
      score: score || null, errors: errors || [],
      recommendation: recommendation || "",
      calls_count: 1,
      created_at: now(), updated_at: now(),
    };
    db.data.contacts.push(contact);
    contactId = contact.id;
  }
  if (call_id) {
    const call = db.data.calls.find(c => c.id === call_id);
    if (call) { call.saved = true; call.contact_id = contactId; }
  }
  await db.write();
  broadcastHttp({ type: "contact_saved", id: contactId, phone, company });
  res.json({ ok: true, id: contactId });
});

app.put("/api/contacts/:id", async (req, res) => {
  const c = db.data.contacts.find(c => c.id === +req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  Object.assign(c, { ...req.body, updated_at: now() });
  await db.write();
  res.json({ ok: true });
});

app.delete("/api/contacts/:id", async (req, res) => {
  db.data.contacts = db.data.contacts.filter(c => c.id !== +req.params.id);
  await db.write();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// MANAGERS API
// ═══════════════════════════════════════════════════════════
app.get("/api/managers", (_, res) => res.json(db.data.managers));

app.post("/api/managers", async (req, res) => {
  const { name, color } = req.body;
  const initials = name.trim().split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
  const mgr = { id: nextId(db.data.managers), name: name.trim(), avatar: initials, color: color||"#6366f1", violations: 0, calls_count: 0, avg_score: null };
  db.data.managers.push(mgr);
  await db.write();
  res.json({ ok: true, id: mgr.id });
});

app.post("/api/managers/:id/stats", async (req, res) => {
  const mgr = db.data.managers.find(m => m.id === +req.params.id);
  if (!mgr) return res.status(404).json({ error: "Not found" });
  const { score = 0, violations = 0 } = req.body;
  mgr.calls_count += 1;
  mgr.avg_score = mgr.avg_score === null ? score : Math.round((mgr.avg_score * (mgr.calls_count-1) + score) / mgr.calls_count);
  mgr.violations += violations;
  await db.write();
  res.json({ ok: true });
});

app.delete("/api/managers/:id/reset", async (req, res) => {
  const mgr = db.data.managers.find(m => m.id === +req.params.id);
  if (mgr) { mgr.violations = 0; mgr.calls_count = 0; mgr.avg_score = null; await db.write(); }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
app.post("/api/notify", async (req, res) => {
  const { to, managerName, violations, threshold } = req.body;
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
  console.log(`[NOTIFY] ${managerName}: ${violations}/${threshold} → ${to}`);
  res.json({ ok: true, mode: "console" });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log(`    STT    : ${TRANSCRIBE || "⚠ no key"}`);
  console.log(`    LLM    : ${ANALYZE    || "⚠ no key"}`);
  console.log(`    ffmpeg : ${FFMPEG ? "✓" : "✗"}`);
  console.log(`    SIP    : ws://localhost:${process.env.FREEPBX_WS_PORT||8088}/ws`);
  console.log(`    exts   : ${process.env.FREEPBX_EXTENSION||"?"}${process.env.FREEPBX_EXT_2 ? " + "+process.env.FREEPBX_EXT_2 : ""}`);
  console.log(`    DB     : sales.json\n`);
});