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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// FFMPEG
// ═══════════════════════════════════════════════════════════
function findFfmpeg() {
  const candidates = [
    "ffmpeg",
    process.env.FFMPEG_PATH,
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].filter(Boolean);
  try {
    const r = execSync("which ffmpeg 2>/dev/null || where ffmpeg 2>nul", { encoding: "utf8" }).trim();
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
// PROVIDERS
// ═══════════════════════════════════════════════════════════
const TRANSCRIBE = process.env.GROQ_API_KEY  ? "groq"
  : process.env.YANDEX_API_KEY              ? "yandex"
  : null;

const ANALYZE = process.env.GROQ_API_KEY    ? "groq"
  : process.env.YANDEX_API_KEY             ? "yandex"
  : null;

// ═══════════════════════════════════════════════════════════
// TRANSCRIPTION
// ═══════════════════════════════════════════════════════════
async function transcribeGroq(filePath) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), {
    filename: "audio.wav",
    contentType: "audio/wav",
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
  return { text: d.text || "", duration: d.duration || null };
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
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error_message || `SpeechKit ${r.status}`); }
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
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message); }
  return (await r.json()).result?.alternatives?.[0]?.message?.text || "";
}

// ═══════════════════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════════════════
app.get("/health", (_, res) => res.json({
  ok: true,
  transcribe: TRANSCRIBE || "⚠ no key",
  analyze: ANALYZE || "⚠ no key",
  ffmpeg: !!FFMPEG,
}));

// ═══════════════════════════════════════════════════════════
// PROCESS — main endpoint: audio → transcript + analysis
// ═══════════════════════════════════════════════════════════
app.post("/process", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file" });

  const managerName = req.body.managerName || "Менеджер";
  const tmpPath = req.file.path;

  try {
    // Transcription
    let transcript = "";
    let duration = null;

    if (TRANSCRIBE) {
      let wavPath = null;
      let ownWav = false;

      if (req.file.mimetype === "audio/wav" || req.file.originalname?.endsWith(".wav")) {
        wavPath = tmpPath;
      } else if (FFMPEG) {
        wavPath = toWav(tmpPath);
        ownWav = true;
      }

      if (wavPath) {
        try {
          const result = TRANSCRIBE === "groq"
            ? await transcribeGroq(wavPath)
            : await transcribeYandex(wavPath);
          transcript = result.text;
          duration = result.duration;
        } finally {
          if (ownWav && wavPath && fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        }
      }
    }

    console.log(`[PROCESS] STT done | ${transcript.length} chars`);

    // Analysis
    let analysis = { summary: "", score: 0, errors: [], positives: [], recommendation: "", nextStepSuggestion: "" };

    if (transcript && ANALYZE) {
      try {
        const raw = ANALYZE === "groq"
          ? await analyzeGroq(managerName, transcript)
          : await analyzeYandex(managerName, transcript);
        const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        analysis = JSON.parse(clean);
      } catch (e) {
        console.error("[PROCESS] analyze error:", e.message);
      }
    }

    console.log(`[PROCESS] LLM done | score=${analysis.score}`);

    res.json({ transcript, duration, analysis });

  } catch (e) {
    console.error("[PROCESS] error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

// ═══════════════════════════════════════════════════════════
// ANALYZE TEXT  — text-only path (no audio)
// ═══════════════════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  const { managerName = "Менеджер", transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: "transcript required" });
  if (!ANALYZE)    return res.status(503).json({ error: "No analysis key configured" });

  try {
    const raw   = ANALYZE === "groq"
      ? await analyzeGroq(managerName, transcript)
      : await analyzeYandex(managerName, transcript);
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    console.error("[ANALYZE]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
fs.mkdirSync("uploads", { recursive: true });

const PORT = process.env.PORT || 3002;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐  Global Backend → http://localhost:${PORT}`);
  console.log(`    STT    : ${TRANSCRIBE || "⚠ no key"}`);
  console.log(`    LLM    : ${ANALYZE    || "⚠ no key"}`);
  console.log(`    ffmpeg : ${FFMPEG ? "✓" : "✗"}\n`);
});
