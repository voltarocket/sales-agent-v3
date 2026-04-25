import asyncio
import datetime
import json
import os
import re
import secrets
import subprocess
from contextlib import asynccontextmanager
from typing import Any, Optional

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

PORT         = int(os.getenv("PORT", "3002"))
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://sales:sales_pass@localhost:5432/sales_agent")

# ═══════════════════════════════════════════════════════════
# PROVIDERS
# ═══════════════════════════════════════════════════════════

GROQ_API_KEY     = os.getenv("GROQ_API_KEY", "")
YANDEX_API_KEY   = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")

TRANSCRIBE: Optional[str] = "groq" if GROQ_API_KEY else ("yandex" if YANDEX_API_KEY else None)
ANALYZE:    Optional[str] = "groq" if GROQ_API_KEY else ("yandex" if YANDEX_API_KEY else None)

# ═══════════════════════════════════════════════════════════
# PLANS  (hardcoded defaults)
# ═══════════════════════════════════════════════════════════

PLANS: dict[str, dict] = {
    "basic":      {"max_devices": 1,  "requests_per_month": 100},
    "pro":        {"max_devices": 5,  "requests_per_month": 1000},
    "enterprise": {"max_devices": -1, "requests_per_month": -1},
}

# ═══════════════════════════════════════════════════════════
# FFMPEG
# ═══════════════════════════════════════════════════════════

def _find_ffmpeg() -> Optional[str]:
    candidates = [
        "ffmpeg",
        os.getenv("FFMPEG_PATH"),
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ]
    candidates = [c for c in candidates if c]
    try:
        r = subprocess.run(
            "which ffmpeg 2>/dev/null || where ffmpeg 2>nul",
            shell=True, capture_output=True, text=True, timeout=5,
        )
        if r.stdout.strip():
            candidates.insert(0, r.stdout.strip().split("\n")[0].strip())
    except Exception:
        pass
    for cmd in candidates:
        try:
            r = subprocess.run([cmd, "-version"], capture_output=True, timeout=3)
            if r.returncode == 0:
                print(f"[FFMPEG] ✓ {cmd}")
                return cmd
        except Exception:
            pass
    return None

FFMPEG: Optional[str] = _find_ffmpeg()

def to_wav(input_path: str) -> Optional[str]:
    if not FFMPEG:
        return None
    out = input_path + ".wav"
    r = subprocess.run(
        [FFMPEG, "-y", "-i", input_path, "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", out],
        capture_output=True, timeout=60,
    )
    return out if r.returncode == 0 else None

def split_wav(wav_path: str) -> list:
    if not FFMPEG:
        return [wav_path]
    chunk_dir = wav_path + "_chunks"
    os.makedirs(chunk_dir, exist_ok=True)
    r = subprocess.run(
        [
            FFMPEG, "-y", "-i", wav_path,
            "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
            "-f", "segment", "-segment_time", "30",
            os.path.join(chunk_dir, "chunk_%03d.wav"),
        ],
        capture_output=True, timeout=120,
    )
    if r.returncode != 0:
        return [wav_path]
    chunks = sorted(
        os.path.join(chunk_dir, f)
        for f in os.listdir(chunk_dir)
        if f.endswith(".wav")
    )
    return chunks if chunks else [wav_path]

# ═══════════════════════════════════════════════════════════
# DATABASE
# ═══════════════════════════════════════════════════════════

pool: Optional[asyncpg.Pool] = None

async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

async def wait_for_db(retries: int = 5, delay: float = 2.0) -> None:
    for i in range(1, retries + 1):
        try:
            conn = await asyncpg.connect(DATABASE_URL)
            await conn.execute("SELECT 1")
            await conn.close()
            print("[Licenses DB] connected ✓")
            return
        except Exception:
            print(f"[Licenses DB] waiting... ({i}/{retries})")
            await asyncio.sleep(delay)
    raise RuntimeError("[Licenses DB] Could not connect to PostgreSQL")

async def create_pool() -> None:
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, init=_init_conn, min_size=1, max_size=5)

# ═══════════════════════════════════════════════════════════
# DB FUNCTIONS — PLANS
# ═══════════════════════════════════════════════════════════

async def get_plans() -> list:
    rows = await pool.fetch("SELECT * FROM license_plans ORDER BY requests_per_month")
    return [dict(r) for r in rows]

async def create_plan(data: dict) -> dict:
    name              = data.get("name")
    display_name      = data.get("display_name", "")
    max_devices       = data.get("max_devices", 1)
    requests_per_month = data.get("requests_per_month", 100)
    description       = data.get("description", "")
    if not name:
        raise ValueError("name required")
    row = await pool.fetchrow(
        """INSERT INTO license_plans (name, display_name, max_devices, requests_per_month, description)
           VALUES ($1,$2,$3,$4,$5) RETURNING *""",
        name.lower(), display_name, max_devices, requests_per_month, description,
    )
    return dict(row)

async def update_plan(name: str, fields: dict) -> dict:
    allowed = ["display_name", "max_devices", "requests_per_month", "description"]
    parts   = []
    vals    = []
    idx     = 1
    for k, v in fields.items():
        if k not in allowed:
            continue
        parts.append(f"{k}=${idx}")
        vals.append(v)
        idx += 1
    if not parts:
        raise ValueError("No valid fields")
    vals.append(name)
    row = await pool.fetchrow(
        f"UPDATE license_plans SET {', '.join(parts)} WHERE name=${idx} RETURNING *", *vals
    )
    if not row:
        raise ValueError("Plan not found")
    return dict(row)

async def delete_plan(name: str) -> None:
    await pool.execute("DELETE FROM license_plans WHERE name=$1", name)

# ═══════════════════════════════════════════════════════════
# DB FUNCTIONS — LICENSES
# ═══════════════════════════════════════════════════════════

async def list_licenses() -> list:
    month = datetime.datetime.now().strftime("%Y-%m")
    rows = await pool.fetch(
        """SELECT l.*,
                  COALESCE(lu.requests, 0) AS used_this_month,
                  COUNT(DISTINCT ld.device_id)::int AS active_devices
           FROM licenses l
           LEFT JOIN license_usage   lu ON lu.license_key = l.key AND lu.month = $1
           LEFT JOIN license_devices ld ON ld.license_key = l.key
           GROUP BY l.key, lu.requests
           ORDER BY l.created_at DESC""",
        month,
    )
    return [dict(r) for r in rows]

async def issue_license(customer: str = "", plan: str = "basic", expires_at: Any = None) -> dict:
    # Fetch limits from DB, fall back to hardcoded defaults
    db_plan = None
    try:
        db_plan = await pool.fetchrow("SELECT * FROM license_plans WHERE name=$1", plan)
    except Exception:
        pass
    limits = dict(db_plan) if db_plan else PLANS.get(plan, PLANS["basic"])
    key = "SALES-" + secrets.token_hex(16).upper()
    row = await pool.fetchrow(
        """INSERT INTO licenses (key, customer, plan, max_devices, requests_per_month, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
        key, customer, plan, limits["max_devices"], limits["requests_per_month"], expires_at,
    )
    return dict(row)

async def validate_license(key: str, device_id: Optional[str] = None) -> dict:
    license = await pool.fetchrow(
        "SELECT * FROM licenses WHERE key=$1 AND is_active=true", key
    )
    if not license:
        return {"valid": False, "reason": "License not found or inactive"}

    if license["expires_at"]:
        exp = license["expires_at"]
        if not isinstance(exp, datetime.datetime):
            exp = datetime.datetime.fromisoformat(str(exp))
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=datetime.timezone.utc)
        if exp < datetime.datetime.now(datetime.timezone.utc):
            return {"valid": False, "reason": "License expired"}

    if device_id:
        await pool.execute(
            """INSERT INTO license_devices (license_key, device_id)
               VALUES ($1, $2)
               ON CONFLICT (license_key, device_id) DO UPDATE SET last_seen=NOW()""",
            key, device_id,
        )
        if license["max_devices"] > 0:
            count = await pool.fetchval(
                "SELECT COUNT(*) FROM license_devices WHERE license_key=$1", key
            )
            if count > license["max_devices"]:
                await pool.execute(
                    "DELETE FROM license_devices WHERE license_key=$1 AND device_id=$2",
                    key, device_id,
                )
                return {"valid": False, "reason": f"Device limit reached (max {license['max_devices']})"}

    month = datetime.datetime.now().strftime("%Y-%m")
    usage_row = await pool.fetchrow(
        "SELECT requests FROM license_usage WHERE license_key=$1 AND month=$2", key, month
    )
    used = usage_row["requests"] if usage_row else 0

    return {
        "valid":              True,
        "key":                key,
        "customer":           license["customer"],
        "plan":               license["plan"],
        "max_devices":        license["max_devices"],
        "requests_per_month": license["requests_per_month"],
        "expires_at":         license["expires_at"],
        "usage":              {"month": month, "used": used, "limit": license["requests_per_month"]},
    }

async def record_usage(key: str, device_id: str = "unknown") -> None:
    month = datetime.datetime.now().strftime("%Y-%m")
    await pool.execute(
        """INSERT INTO license_usage (license_key, device_id, month, requests)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (license_key, month) DO UPDATE SET requests = license_usage.requests + 1""",
        key, device_id, month,
    )

async def update_license(key: str, fields: dict) -> dict:
    allowed = ["plan", "max_devices", "requests_per_month", "expires_at", "customer", "is_active"]
    # If plan is changing, apply preset limits unless overridden
    if fields.get("plan") and not fields.get("max_devices") and not fields.get("requests_per_month"):
        limits = PLANS.get(fields["plan"])
        if limits:
            fields["max_devices"]        = limits["max_devices"]
            fields["requests_per_month"] = limits["requests_per_month"]

    parts = []
    vals  = []
    idx   = 1
    for k, v in fields.items():
        if k not in allowed:
            continue
        parts.append(f"{k}=${idx}")
        vals.append(v)
        idx += 1
    if not parts:
        raise ValueError("No valid fields to update")
    vals.append(key)
    row = await pool.fetchrow(
        f"UPDATE licenses SET {', '.join(parts)} WHERE key=${idx} RETURNING *", *vals
    )
    if not row:
        raise ValueError("License not found")
    return dict(row)

async def revoke_license(key: str) -> None:
    await pool.execute("UPDATE licenses SET is_active=false WHERE key=$1", key)

async def get_license_status(key: str) -> Optional[dict]:
    license = await pool.fetchrow("SELECT * FROM licenses WHERE key=$1", key)
    if not license:
        return None
    month   = datetime.datetime.now().strftime("%Y-%m")
    devices = await pool.fetch(
        "SELECT device_id, last_seen FROM license_devices WHERE license_key=$1 ORDER BY last_seen DESC", key
    )
    usage_row = await pool.fetchrow(
        "SELECT requests FROM license_usage WHERE license_key=$1 AND month=$2", key, month
    )
    return {
        **dict(license),
        "devices": [dict(d) for d in devices],
        "usage":   {"month": month, "used": usage_row["requests"] if usage_row else 0},
    }

# ═══════════════════════════════════════════════════════════
# TRANSCRIPTION
# ═══════════════════════════════════════════════════════════

async def transcribe_groq(file_path: str) -> dict:
    async with httpx.AsyncClient(timeout=120) as client:
        with open(file_path, "rb") as f:
            r = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                files={"file": ("audio.wav", f, "audio/wav")},
                data={"model": "whisper-large-v3", "language": "ru", "response_format": "verbose_json"},
            )
    if not r.is_success:
        err = r.json()
        raise RuntimeError(err.get("error", {}).get("message") or f"Groq {r.status_code}")
    d = r.json()
    return {"text": d.get("text", ""), "duration": d.get("duration")}

async def _transcribe_yandex_chunk(wav_path: str) -> str:
    from pathlib import Path
    data = Path(wav_path).read_bytes()
    if len(data) > 1024 * 1024:
        raise RuntimeError("Chunk > 1MB")
    url = f"https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId={YANDEX_FOLDER_ID}&lang=ru-RU"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Api-Key {YANDEX_API_KEY}", "Content-Type": "audio/wav"},
            content=data,
        )
    if not r.is_success:
        ct  = r.headers.get("content-type", "")
        err = r.json() if "application/json" in ct else {}
        raise RuntimeError(err.get("error_message") or f"SpeechKit {r.status_code}")
    return r.json().get("result", "")

async def transcribe_yandex(file_path: str) -> dict:
    wav    = to_wav(file_path)
    chunks = split_wav(wav or file_path)
    parts  = [await _transcribe_yandex_chunk(c) for c in chunks]
    if wav and os.path.exists(wav):
        os.unlink(wav)
    return {"text": " ".join(parts).strip(), "duration": None}

# ═══════════════════════════════════════════════════════════
# ANALYSIS
# ═══════════════════════════════════════════════════════════

_SYS = "Ты — тренер по продажам. Отвечай ТОЛЬКО валидным JSON без markdown."

def _build_prompt(name: str, transcript: str) -> str:
    return (
        f'Проанализируй звонок менеджера "{name}".\n'
        f"Транскрипт: {transcript}\n"
        'JSON:\n{"summary":"2-3 предложения","score":0-100,'
        '"errors":[{"title":"","description":"","severity":"high|medium|low","timestamp":""}],'
        '"positives":[""],"recommendation":"","nextStepSuggestion":""}'
    )

async def analyze_groq(name: str, transcript: str) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model":       "llama-3.3-70b-versatile",
                "temperature": 0.2,
                "max_tokens":  2000,
                "messages": [
                    {"role": "system", "content": _SYS},
                    {"role": "user",   "content": _build_prompt(name, transcript)},
                ],
            },
        )
    if not r.is_success:
        err = r.json()
        raise RuntimeError(err.get("error", {}).get("message"))
    return r.json()["choices"][0]["message"]["content"] or ""

async def analyze_yandex(name: str, transcript: str) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
            headers={"Authorization": f"Api-Key {YANDEX_API_KEY}", "Content-Type": "application/json"},
            json={
                "modelUri":         f"gpt://{YANDEX_FOLDER_ID}/yandexgpt-lite/latest",
                "completionOptions": {"stream": False, "temperature": 0.2, "maxTokens": 2000},
                "messages": [
                    {"role": "system", "text": _SYS},
                    {"role": "user",   "text": _build_prompt(name, transcript)},
                ],
            },
        )
    if not r.is_success:
        ct  = r.headers.get("content-type", "")
        err = r.json() if "application/json" in ct else {}
        raise RuntimeError(err.get("message"))
    return r.json().get("result", {}).get("alternatives", [{}])[0].get("message", {}).get("text", "") or ""

def _clean_json(raw: str) -> dict:
    clean = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    clean = re.sub(r"\s*```$", "", clean).strip()
    return json.loads(clean)

# ═══════════════════════════════════════════════════════════
# LIFESPAN
# ═══════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs("uploads", exist_ok=True)
    if os.getenv("DATABASE_URL"):
        try:
            await wait_for_db(5, 2.0)
            await create_pool()
        except Exception as e:
            print(f"[Licenses DB] unavailable: {e}")
    print(f"\n🌐  Global Backend → http://localhost:{PORT}")
    print(f"    STT      : {TRANSCRIBE or '⚠ no key'}")
    print(f"    LLM      : {ANALYZE    or '⚠ no key'}")
    print(f"    ffmpeg   : {'✓' if FFMPEG else '✗'}")
    print(f"    licensing: {'enforced' if os.getenv('REQUIRE_LICENSE') == 'true' else 'optional (set REQUIRE_LICENSE=true)'}\n")
    yield

# ═══════════════════════════════════════════════════════════
# APP
# ═══════════════════════════════════════════════════════════

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════════════════════════
# ADMIN AUTH
# ═══════════════════════════════════════════════════════════

def _require_admin(req: Request) -> None:
    secret = os.getenv("ADMIN_SECRET")
    if not secret:
        raise HTTPException(503, {"error": "ADMIN_SECRET not configured"})
    provided = req.headers.get("x-admin-secret")
    if provided != secret:
        raise HTTPException(401, {"error": "Unauthorized"})

# ═══════════════════════════════════════════════════════════
# LICENSE GUARD MIDDLEWARE  (enforced when REQUIRE_LICENSE=true)
# ═══════════════════════════════════════════════════════════

async def _license_guard(req: Request) -> Optional[tuple[str, str]]:
    """Returns (license_key, device_id) or raises HTTPException."""
    if os.getenv("REQUIRE_LICENSE") != "true":
        return None

    key       = req.headers.get("x-license-key")
    device_id = req.headers.get("x-device-id")

    if not key:
        raise HTTPException(402, {"error": "License key required (X-License-Key header)"})

    if not pool:
        return (key, device_id)   # fail open on DB unavailable

    try:
        result = await validate_license(key, device_id)
        if not result["valid"]:
            raise HTTPException(402, {"error": result["reason"]})
        rpm   = result["requests_per_month"]
        usage = result["usage"]
        if rpm > 0 and usage["used"] >= rpm:
            raise HTTPException(429, {"error": f"Monthly request limit reached ({rpm})"})
        return (key, device_id)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[licenseGuard] {e}")
        return (key, device_id)   # fail open — don't block on DB errors

# ═══════════════════════════════════════════════════════════
# HEALTH
# ═══════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {
        "ok":        True,
        "transcribe": TRANSCRIBE or "⚠ no key",
        "analyze":    ANALYZE    or "⚠ no key",
        "ffmpeg":     bool(FFMPEG),
        "licensing":  "enforced" if os.getenv("REQUIRE_LICENSE") == "true" else "optional",
    }

# ═══════════════════════════════════════════════════════════
# PROCESS — audio → transcript + analysis
# ═══════════════════════════════════════════════════════════

@app.post("/process")
async def process(request: Request, audio: UploadFile = File(...)):
    license_info = await _license_guard(request)

    manager_name = (await request.form()).get("managerName") or "Менеджер"
    tmp_path     = os.path.join("uploads", f"proc_{os.urandom(8).hex()}")
    try:
        with open(tmp_path, "wb") as f:
            f.write(await audio.read())

        transcript = ""
        duration   = None

        if TRANSCRIBE:
            wav_path = None
            own_wav  = False
            ct       = audio.content_type or ""
            fn       = audio.filename or ""

            if ct == "audio/wav" or fn.endswith(".wav"):
                wav_path = tmp_path
            elif FFMPEG:
                wav_path = to_wav(tmp_path)
                own_wav  = True

            if wav_path:
                try:
                    result     = await (transcribe_groq(wav_path) if TRANSCRIBE == "groq" else transcribe_yandex(wav_path))
                    transcript = result["text"]
                    duration   = result["duration"]
                finally:
                    if own_wav and wav_path and os.path.exists(wav_path):
                        os.unlink(wav_path)

        print(f"[PROCESS] STT done | {len(transcript)} chars")

        analysis: dict = {"summary": "", "score": 0, "errors": [], "positives": [], "recommendation": "", "nextStepSuggestion": ""}
        if transcript and ANALYZE:
            try:
                raw      = await (analyze_groq(manager_name, transcript) if ANALYZE == "groq" else analyze_yandex(manager_name, transcript))
                analysis = _clean_json(raw)
            except Exception as e:
                print(f"[PROCESS] analyze error: {e}")

        print(f"[PROCESS] LLM done | score={analysis.get('score')}")

        # Record usage asynchronously
        if license_info and pool:
            key, did = license_info
            asyncio.create_task(
                record_usage(key, did or "unknown")
            )

        return {"transcript": transcript, "duration": duration, "analysis": analysis}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[PROCESS] error: {e}")
        raise HTTPException(500, {"error": str(e)})
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

# ═══════════════════════════════════════════════════════════
# ANALYZE TEXT  (text-only path)
# ═══════════════════════════════════════════════════════════

@app.post("/analyze")
async def analyze_text(request: Request):
    await _license_guard(request)
    body         = await request.json()
    manager_name = body.get("managerName", "Менеджер")
    transcript   = body.get("transcript", "")
    if not transcript:
        raise HTTPException(400, {"error": "transcript required"})
    if not ANALYZE:
        raise HTTPException(503, {"error": "No analysis key configured"})
    try:
        raw   = await (analyze_groq(manager_name, transcript) if ANALYZE == "groq" else analyze_yandex(manager_name, transcript))
        return _clean_json(raw)
    except Exception as e:
        print(f"[ANALYZE] {e}")
        raise HTTPException(500, {"error": str(e)})

# ═══════════════════════════════════════════════════════════
# PLANS (admin)
# ═══════════════════════════════════════════════════════════

@app.get("/plans")
async def plans_list(request: Request):
    _require_admin(request)
    try:
        return await get_plans()
    except Exception as e:
        raise HTTPException(500, {"error": str(e)})

@app.post("/plans")
async def plans_create(request: Request):
    _require_admin(request)
    try:
        plan = await create_plan(await request.json())
        return {"ok": True, "plan": plan}
    except Exception as e:
        raise HTTPException(400, {"error": str(e)})

@app.put("/plans/{name}")
async def plans_update(name: str, request: Request):
    _require_admin(request)
    try:
        plan = await update_plan(name, await request.json())
        return {"ok": True, "plan": plan}
    except Exception as e:
        raise HTTPException(400, {"error": str(e)})

@app.delete("/plans/{name}")
async def plans_delete(name: str, request: Request):
    _require_admin(request)
    try:
        await delete_plan(name)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(400, {"error": str(e)})

# ═══════════════════════════════════════════════════════════
# LICENSES (admin + public)
# ═══════════════════════════════════════════════════════════

@app.get("/licenses")
async def licenses_list(request: Request):
    _require_admin(request)
    try:
        return await list_licenses()
    except Exception as e:
        raise HTTPException(500, {"error": str(e)})

@app.post("/licenses/issue")
async def licenses_issue(request: Request):
    _require_admin(request)
    body = await request.json()
    try:
        license = await issue_license(
            customer   = body.get("customer", ""),
            plan       = body.get("plan", "basic"),
            expires_at = body.get("expires_at"),
        )
        print(f"[LICENSE] issued key={license['key']} plan={license['plan']} customer={license['customer']}")
        return {"ok": True, "license": license}
    except Exception as e:
        print(f"[LICENSE] issue error: {e}")
        raise HTTPException(500, {"error": str(e)})

@app.post("/licenses/validate")
async def licenses_validate(request: Request):
    body = await request.json()
    key  = body.get("key")
    if not key:
        raise HTTPException(400, {"error": "key required"})
    try:
        return await validate_license(key, body.get("deviceId"))
    except Exception as e:
        print(f"[LICENSE] validate error: {e}")
        raise HTTPException(500, {"error": str(e)})

@app.post("/licenses/usage")
async def licenses_usage(request: Request):
    body = await request.json()
    key  = body.get("key")
    if not key:
        raise HTTPException(400, {"error": "key required"})
    try:
        await record_usage(key, body.get("deviceId", "unknown"))
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, {"error": str(e)})

@app.get("/licenses/{key}/status")
async def licenses_status(key: str):
    try:
        status = await get_license_status(key)
        if not status:
            raise HTTPException(404, {"error": "License not found"})
        return status
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, {"error": str(e)})

@app.patch("/licenses/{key}")
async def licenses_patch(key: str, request: Request):
    _require_admin(request)
    try:
        license = await update_license(key, await request.json())
        print(f"[LICENSE] updated key={key} plan={license['plan']}")
        return {"ok": True, "license": license}
    except Exception as e:
        raise HTTPException(400, {"error": str(e)})

@app.delete("/licenses/{key}")
async def licenses_delete(key: str, request: Request):
    _require_admin(request)
    try:
        await revoke_license(key)
        print(f"[LICENSE] revoked key={key}")
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, {"error": str(e)})

# ═══════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
