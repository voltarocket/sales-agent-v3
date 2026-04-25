import asyncio
import datetime
import json
import os
import random
import socket
import string
import subprocess
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

PORT        = int(os.getenv("PORT", "3001"))
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://sales:sales_pass@localhost:5432/sales_agent")
GLOBAL_URL   = os.getenv("GLOBAL_BACKEND_URL", "http://localhost:3002")

# ═══════════════════════════════════════════════════════════
# FFMPEG  (local — only for PCM → WAV pre-processing)
# ═══════════════════════════════════════════════════════════

def _find_ffmpeg() -> Optional[str]:
    candidates = [
        "ffmpeg",
        os.getenv("FFMPEG_PATH"),
        r"C:\Users\volta\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe",
        "/c/ffmpeg/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    candidates = [c for c in candidates if c]
    try:
        r = subprocess.run(
            "where ffmpeg 2>nul || which ffmpeg 2>/dev/null",
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

# ═══════════════════════════════════════════════════════════
# IN-MEMORY CACHE  (replaces Redis / ioredis)
# ═══════════════════════════════════════════════════════════

_cache: dict[str, dict] = {}  # key → {value, expires_at}

def _cache_get(key: str) -> Optional[str]:
    entry = _cache.get(key)
    if not entry:
        return None
    if entry["expires_at"] and time.time() > entry["expires_at"]:
        _cache.pop(key, None)
        return None
    return entry["value"]

def _cache_set(key: str, value: str, ttl_sec: Optional[int] = None) -> None:
    expires_at = (time.time() + ttl_sec) if ttl_sec else None
    _cache[key] = {"value": value, "expires_at": expires_at}

def _cache_del(key: str) -> None:
    _cache.pop(key, None)

def _cache_incr(key: str, ttl_sec: Optional[int] = None) -> int:
    entry = _cache.get(key)
    cur = int(entry["value"]) if entry else 0
    nxt = cur + 1
    if entry:
        _cache_set(key, str(nxt), ttl_sec)
    else:
        _cache_set(key, str(nxt), ttl_sec)
    return nxt

def _cache_expire(key: str, ttl_sec: int) -> None:
    entry = _cache.get(key)
    if entry:
        entry["expires_at"] = time.time() + ttl_sec

# ═══════════════════════════════════════════════════════════
# JOBS  (in-memory, TTL 1 h)
# ═══════════════════════════════════════════════════════════

_JOBS_TTL = 3600

def set_job(job_id: str, status: str, data: Any = None) -> None:
    _cache_set(f"job:{job_id}", json.dumps({"status": status, "data": data, "updatedAt": int(time.time() * 1000)}), _JOBS_TTL)

def get_job(job_id: str) -> Optional[dict]:
    val = _cache_get(f"job:{job_id}")
    return json.loads(val) if val else None

# ═══════════════════════════════════════════════════════════
# DATABASE
# ═══════════════════════════════════════════════════════════

pool: Optional[asyncpg.Pool] = None

async def _init_conn(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

async def wait_for_db(retries: int = 10, delay: float = 2.0) -> None:
    for i in range(1, retries + 1):
        try:
            conn = await asyncpg.connect(DATABASE_URL)
            await conn.execute("SELECT 1")
            await conn.close()
            print("[DB] PostgreSQL connected ✓")
            return
        except Exception:
            print(f"[DB] waiting for PostgreSQL... ({i}/{retries})")
            await asyncio.sleep(delay)
    raise RuntimeError("[DB] Could not connect to PostgreSQL")

async def create_pool() -> None:
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, init=_init_conn, min_size=2, max_size=10)

# ═══════════════════════════════════════════════════════════
# LICENSE STATE
# ═══════════════════════════════════════════════════════════

_CACHE_KEY  = "license:status"
_CACHE_TTL  = 3600
_USAGE_KEY  = lambda key, month: f"usage:{key}:{month}"
_USAGE_TTL  = 60 * 60 * 24 * 35

license_state: dict = {
    "checked":    False,
    "valid":      False,
    "plan":       None,
    "reason":     None,
    "key":        None,
    "limits":     {"requests_per_month": -1, "max_devices": -1},
    "usage":      {"used": 0, "month": None},
    "expires_at": None,
    "customer":   None,
}

def _device_id() -> str:
    return os.getenv("DEVICE_ID") or f"{socket.gethostname()}-{os.getpid()}"

async def _get_stored_key() -> Optional[str]:
    if not pool:
        return None
    try:
        row = await pool.fetchrow("SELECT value FROM settings WHERE key='license_key'")
        return row["value"] if row else None
    except Exception:
        return None

async def _refresh_license(key: str, device_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{GLOBAL_URL}/licenses/validate",
                json={"key": key, "deviceId": device_id},
            )
        data = r.json()
        update = {
            "key":        key,
            "valid":      data.get("valid", False),
            "plan":       data.get("plan"),
            "reason":     data.get("reason"),
            "customer":   data.get("customer"),
            "expires_at": data.get("expires_at"),
            "limits": {
                "requests_per_month": data.get("requests_per_month", -1),
                "max_devices":        data.get("max_devices", -1),
            },
            "usage": data.get("usage", {"used": 0, "month": None}),
        }
        license_state.update({"checked": True, **update})
        _cache_set(_CACHE_KEY, json.dumps(update), _CACHE_TTL)
        if data.get("valid"):
            used = data.get("usage", {}).get("used", 0)
            rpm  = data.get("requests_per_month", -1)
            print(f"[LICENSE] valid — plan={data.get('plan')} usage={used}/{rpm}")
        else:
            print(f"[LICENSE] invalid — {data.get('reason')}")
    except Exception as e:
        print(f"[LICENSE] validation failed: {e}")
        license_state["checked"] = True
        if not license_state["plan"]:
            license_state["valid"]  = True
            license_state["plan"]   = "unknown"
            license_state["reason"] = "validation-error"

async def init_license() -> None:
    env_key = os.getenv("LICENSE_KEY")
    db_key  = None if env_key else await _get_stored_key()
    key     = env_key or db_key
    device_id = _device_id()

    if not key:
        print("[LICENSE] No key configured — dev mode (unlicensed)")
        license_state.update({"checked": True, "valid": True, "plan": "dev"})
        return

    license_state["key"] = key

    cached = _cache_get(_CACHE_KEY)
    if cached:
        data = json.loads(cached)
        license_state.update({"checked": True, **data})
        print(f"[LICENSE] cache hit — plan={data.get('plan')} valid={data.get('valid')}")
        return

    await _refresh_license(key, device_id)

async def activate_license(key: str) -> dict:
    device_id = _device_id()
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{GLOBAL_URL}/licenses/validate",
            json={"key": key, "deviceId": device_id},
        )
    data = r.json()
    if not data.get("valid"):
        raise ValueError(data.get("reason") or "Invalid license key")

    if pool:
        await pool.execute(
            "INSERT INTO settings (key, value) VALUES ('license_key', $1) ON CONFLICT (key) DO UPDATE SET value=$1",
            key,
        )

    _cache_del(_CACHE_KEY)

    update = {
        "key":        key,
        "valid":      True,
        "plan":       data.get("plan"),
        "reason":     None,
        "customer":   data.get("customer"),
        "expires_at": data.get("expires_at"),
        "limits": {
            "requests_per_month": data.get("requests_per_month", -1),
            "max_devices":        data.get("max_devices", -1),
        },
        "usage": data.get("usage", {"used": 0, "month": None}),
    }
    license_state.update({"checked": True, **update})
    return update

async def check_rate_limit() -> dict:
    # Dev mode — no restrictions
    if license_state["plan"] == "dev":
        return {"allowed": True}

    # Checked and invalid — block
    if license_state["checked"] and not license_state["valid"]:
        return {"allowed": False, "reason": license_state["reason"] or "license invalid"}

    key   = license_state["key"] or os.getenv("LICENSE_KEY")
    limit = license_state["limits"]["requests_per_month"]
    if not key or limit < 0:
        return {"allowed": True}

    month   = datetime.datetime.now().strftime("%Y-%m")
    rkey    = _USAGE_KEY(key, month)
    current = int(_cache_get(rkey) or "0")
    return {"allowed": current < limit, "current": current, "limit": limit}

async def track_usage() -> None:
    key       = license_state["key"] or os.getenv("LICENSE_KEY")
    device_id = _device_id()
    if not key:
        return

    month = datetime.datetime.now().strftime("%Y-%m")
    rkey  = _USAGE_KEY(key, month)
    _cache_incr(rkey, _USAGE_TTL)
    _cache_expire(rkey, _USAGE_TTL)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{GLOBAL_URL}/licenses/usage",
                json={"key": key, "deviceId": device_id},
            )
    except Exception as e:
        print(f"[LICENSE] usage report failed: {e}")

# ═══════════════════════════════════════════════════════════
# GLOBAL BACKEND PROXY HELPERS
# ═══════════════════════════════════════════════════════════

async def send_to_global_backend(wav_path: str, manager_name: str, phone: str) -> dict:
    license_headers = {}
    if os.getenv("LICENSE_KEY"):
        license_headers["x-license-key"] = os.getenv("LICENSE_KEY")
        license_headers["x-device-id"]   = os.getenv("DEVICE_ID", "unknown")

    async with httpx.AsyncClient(timeout=120) as client:
        with open(wav_path, "rb") as f:
            r = await client.post(
                f"{GLOBAL_URL}/process",
                headers=license_headers,
                files={"audio": ("audio.wav", f, "audio/wav")},
                data={"managerName": manager_name or "Менеджер", "phone": phone or "unknown"},
            )

    if not r.is_success:
        try:
            e = r.json()
        except Exception:
            e = {}
        raise RuntimeError(e.get("error") or f"Global backend error {r.status_code}")
    return r.json()

async def admin_proxy(path: str, method: str = "GET", body: Any = None) -> Any:
    headers = {
        "Content-Type": "application/json",
        "x-admin-secret": os.getenv("GLOBAL_ADMIN_SECRET", ""),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.request(
            method,
            f"{GLOBAL_URL}{path}",
            headers=headers,
            content=json.dumps(body) if body is not None else None,
        )
    return r.json()

# ═══════════════════════════════════════════════════════════
# WEBSOCKET SESSIONS
# ═══════════════════════════════════════════════════════════

ws_clients: set[WebSocket] = set()
sessions:   dict[str, dict] = {}

async def broadcast(data: dict) -> None:
    msg  = json.dumps(data, default=str, ensure_ascii=False)
    dead: set[WebSocket] = set()
    for ws in ws_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)

async def process_session(session: dict, duration: int) -> dict:
    audio_buffer = b"".join(session["chunks"])
    print(f"[WS] audio buffer: {len(audio_buffer)} bytes, duration: {duration}s")

    transcript = ""
    analysis   = {"summary": "", "score": 0, "errors": [], "positives": [], "recommendation": ""}

    if len(audio_buffer) > 1000 and FFMPEG:
        # Check license rate limit before calling AI
        rate_check = await check_rate_limit()
        if not rate_check["allowed"]:
            if rate_check.get("reason"):
                print(f"[WS] license blocked: {rate_check['reason']}")
                raise RuntimeError(f"License error: {rate_check['reason']}")
            print(f"[WS] rate limit reached ({rate_check.get('current')}/{rate_check.get('limit')})")
            raise RuntimeError(f"Monthly AI request limit reached ({rate_check.get('current')}/{rate_check.get('limit')})")

        ts      = int(time.time() * 1000)
        tmp_pcm = os.path.join("uploads", f"ws_{ts}.pcm")
        tmp_wav = tmp_pcm + ".wav"
        with open(tmp_pcm, "wb") as f:
            f.write(audio_buffer)

        try:
            r = subprocess.run(
                [FFMPEG, "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", tmp_pcm, tmp_wav],
                capture_output=True, timeout=30,
            )
            if r.returncode == 0:
                result     = await send_to_global_backend(tmp_wav, session["managerName"], session["phone"])
                transcript = result.get("transcript", "")
                analysis   = result.get("analysis", analysis)
                asyncio.create_task(track_usage())
            else:
                print(f"[WS] ffmpeg convert failed: {r.stderr.decode()}")

            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)
        finally:
            if os.path.exists(tmp_pcm):
                os.unlink(tmp_pcm)

    call = await pool.fetchrow(
        """INSERT INTO calls
             (phone, direction, duration, transcript, summary, score, errors, positives, recommendation, manager_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *""",
        session["phone"], "outbound", duration,
        transcript,
        analysis.get("summary", ""),
        analysis.get("score", 0),
        analysis.get("errors", []),
        analysis.get("positives", []),
        analysis.get("recommendation", ""),
        session.get("managerId"),
    )

    return {
        "callId":     call["id"],
        "phone":      session["phone"],
        "duration":   duration,
        "transcript": transcript,
        "analysis":   analysis,
    }

# ═══════════════════════════════════════════════════════════
# LIFESPAN
# ═══════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs("uploads", exist_ok=True)
    await wait_for_db()
    await create_pool()
    await init_license()

    ext2 = os.getenv("FREEPBX_EXT_2", "")
    print(f"\n🚀  Local Backend → http://localhost:{PORT}")
    print(f"    DB           : PostgreSQL")
    print(f"    Cache        : in-memory")
    print(f"    Global AI    : {GLOBAL_URL}")
    lk = os.getenv("LICENSE_KEY")
    print(f"    License      : {license_state['plan']} ({'valid' if license_state['valid'] else 'invalid'})" if lk else "    License      : dev mode")
    print(f"    ffmpeg       : {'✓' if FFMPEG else '✗'}")
    print(f"    SIP          : ws://localhost:{os.getenv('FREEPBX_WS_PORT', '8088')}/ws")
    print(f"    exts         : {os.getenv('FREEPBX_EXTENSION', '?')}{' + ' + ext2 if ext2 else ''}\n")
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
# WEBSOCKET — audio streaming sessions
# ═══════════════════════════════════════════════════════════

@app.websocket("/")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.add(websocket)
    print("[WS] client connected")
    session_id: Optional[str] = None

    try:
        await websocket.send_text(json.dumps({"type": "connected", "ts": int(time.time() * 1000)}))

        while True:
            message = await websocket.receive()

            if message.get("bytes"):
                if session_id and session_id in sessions:
                    sessions[session_id]["chunks"].append(message["bytes"])
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                msg = json.loads(text)
            except Exception:
                continue

            if msg.get("type") == "call_start":
                rand       = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
                session_id = f"session_{int(time.time() * 1000)}_{rand}"
                sessions[session_id] = {
                    "ws":          websocket,
                    "phone":       msg.get("phone", "unknown"),
                    "managerId":   msg.get("managerId"),
                    "managerName": msg.get("managerName", "Менеджер"),
                    "chunks":      [],
                    "startTime":   time.time(),
                }
                await websocket.send_text(json.dumps({"type": "session_started", "sessionId": session_id}))
                print(f"[WS] call_start → {session_id} phone={msg.get('phone')}")

            elif msg.get("type") == "call_end" and session_id and session_id in sessions:
                print(f"[WS] call_end → {session_id}")
                session = sessions.pop(session_id)
                await websocket.send_text(json.dumps({"type": "processing"}))

                job_id = session_id
                set_job(job_id, "processing")

                try:
                    duration = round(time.time() - session["startTime"])
                    result   = await process_session(session, duration)
                    set_job(job_id, "done", {"callId": result["callId"]})
                    await websocket.send_text(json.dumps({"type": "call_analyzed", **result}, default=str, ensure_ascii=False))
                    print(f"[WS] done → callId={result['callId']} score={result.get('analysis', {}).get('score')}")
                except Exception as e:
                    print(f"[WS] processing error: {e}")
                    set_job(job_id, "error", {"error": str(e)})
                    await websocket.send_text(json.dumps({"type": "error", "error": str(e)}))

                session_id = None

    except WebSocketDisconnect:
        print("[WS] client disconnected")
    except Exception as e:
        print(f"[WS] error: {e}")
    finally:
        ws_clients.discard(websocket)
        if session_id:
            sessions.pop(session_id, None)

# ═══════════════════════════════════════════════════════════
# HEALTH
# ═══════════════════════════════════════════════════════════

@app.get("/api/health")
async def health():
    global_ok = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{GLOBAL_URL}/health")
            global_ok = r.is_success
    except Exception:
        pass

    db_ok = False
    try:
        await pool.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        pass

    return {
        "ok":            True,
        "db":            db_ok,
        "redis":         True,   # in-memory cache — always ready
        "globalBackend": global_ok,
        "ffmpeg":        bool(FFMPEG),
        "license": {
            "valid":   license_state["valid"],
            "plan":    license_state["plan"],
            "checked": license_state["checked"],
        },
        "sip": {
            "host":      os.getenv("FREEPBX_HOST", "localhost"),
            "wsPort":    os.getenv("FREEPBX_WS_PORT", "8088"),
            "extension": os.getenv("FREEPBX_EXTENSION", "not set"),
        },
    }

# ═══════════════════════════════════════════════════════════
# LICENSE STATUS + ACTIVATION
# ═══════════════════════════════════════════════════════════

@app.get("/api/license/status")
def license_status():
    k = license_state["key"]
    return {
        **license_state,
        "keyMasked": (k[:14] + "…") if k else None,
        "deviceId":  os.getenv("DEVICE_ID"),
    }

@app.post("/api/license/activate")
async def license_activate(req: Request):
    body = await req.json()
    key  = (body.get("key") or "").strip()
    if not key:
        raise HTTPException(400, {"error": "key required"})
    try:
        result = await activate_license(key)
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(400, {"error": str(e)})

# ═══════════════════════════════════════════════════════════
# ADMIN PROXY — plans
# ═══════════════════════════════════════════════════════════

@app.get("/api/plans")
async def plans_list():
    return await admin_proxy("/plans")

@app.post("/api/plans")
async def plans_create(req: Request):
    return await admin_proxy("/plans", "POST", await req.json())

@app.put("/api/plans/{name}")
async def plans_update(name: str, req: Request):
    return await admin_proxy(f"/plans/{name}", "PUT", await req.json())

@app.delete("/api/plans/{name}")
async def plans_delete(name: str):
    return await admin_proxy(f"/plans/{name}", "DELETE")

# ═══════════════════════════════════════════════════════════
# ADMIN PROXY — licenses
# ═══════════════════════════════════════════════════════════

@app.get("/api/licenses")
async def licenses_list():
    return await admin_proxy("/licenses")

@app.post("/api/licenses/issue")
async def licenses_issue(req: Request):
    return await admin_proxy("/licenses/issue", "POST", await req.json())

@app.put("/api/licenses/{key}")
async def licenses_update(key: str, req: Request):
    return await admin_proxy(f"/licenses/{key}", "PATCH", await req.json())

@app.delete("/api/licenses/{key}")
async def licenses_delete(key: str):
    return await admin_proxy(f"/licenses/{key}", "DELETE")

@app.get("/api/licenses/{key}/status")
async def licenses_key_status(key: str):
    return await admin_proxy(f"/licenses/{key}/status")

# ═══════════════════════════════════════════════════════════
# JOBS
# ═══════════════════════════════════════════════════════════

@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, {"error": "Job not found"})
    return job

# ═══════════════════════════════════════════════════════════
# SIP CONFIG
# ═══════════════════════════════════════════════════════════

@app.get("/api/sip/config")
def sip_config(ext: Optional[str] = None):
    host    = os.getenv("FREEPBX_HOST", "localhost")
    ws_port = os.getenv("FREEPBX_WS_PORT", "8088")
    domain  = os.getenv("FREEPBX_DOMAIN") or host
    ws_uri  = f"ws://{host}:{ws_port}/ws"

    extensions = []
    if os.getenv("FREEPBX_EXTENSION") and os.getenv("FREEPBX_PASSWORD"):
        extensions.append({
            "extension": os.getenv("FREEPBX_EXTENSION"),
            "password":  os.getenv("FREEPBX_PASSWORD"),
            "label":     "Менеджер",
        })
    if os.getenv("FREEPBX_EXT_2") and os.getenv("FREEPBX_PASS_2"):
        extensions.append({
            "extension": os.getenv("FREEPBX_EXT_2"),
            "password":  os.getenv("FREEPBX_PASS_2"),
            "label":     "Клиент",
        })

    if not extensions:
        raise HTTPException(503, {"error": "FreePBX not configured", "hint": "Set FREEPBX_EXTENSION and FREEPBX_PASSWORD in .env"})

    if ext:
        found = next((e for e in extensions if e["extension"] == ext), None)
        if not found:
            raise HTTPException(404, {"error": "Extension not found"})
        return {**found, "domain": domain, "wsUri": ws_uri}

    return {**extensions[0], "domain": domain, "wsUri": ws_uri, "extensions": extensions}

# ═══════════════════════════════════════════════════════════
# TRANSCRIPTION  (proxy to global backend)
# ═══════════════════════════════════════════════════════════

@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    from pathlib import Path
    suffix = Path(audio.filename or "audio").suffix or ".audio"
    tmp    = os.path.join("uploads", f"upload_{os.urandom(8).hex()}{suffix}")
    try:
        with open(tmp, "wb") as f:
            f.write(await audio.read())

        async with httpx.AsyncClient(timeout=120) as client:
            with open(tmp, "rb") as f:
                r = await client.post(
                    f"{GLOBAL_URL}/process",
                    files={"audio": (audio.filename or "audio", f, audio.content_type or "audio/octet-stream")},
                    data={"managerName": "Менеджер"},
                )
        if not r.is_success:
            try:
                e = r.json()
            except Exception:
                e = {}
            raise RuntimeError(e.get("error") or f"Global {r.status_code}")
        d = r.json()
        return {"transcript": d.get("transcript"), "duration": d.get("duration")}
    except Exception as e:
        print(f"[STT proxy] {e}")
        raise HTTPException(500, {"error": str(e)})
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

# ═══════════════════════════════════════════════════════════
# ANALYSIS  (proxy to global backend — text only)
# ═══════════════════════════════════════════════════════════

@app.post("/api/analyze")
async def analyze(req: Request):
    body         = await req.json()
    manager_name = body.get("managerName", "Менеджер")
    transcript   = body.get("transcript", "")
    if not transcript:
        raise HTTPException(400, {"error": "transcript required"})
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{GLOBAL_URL}/analyze",
                json={"managerName": manager_name, "transcript": transcript},
            )
        if not r.is_success:
            try:
                e = r.json()
            except Exception:
                e = {}
            raise RuntimeError(e.get("error") or f"Global {r.status_code}")
        return r.json()
    except Exception as e:
        print(f"[LLM proxy] {e}")
        raise HTTPException(500, {"error": str(e)})

# ═══════════════════════════════════════════════════════════
# CALLS API
# ═══════════════════════════════════════════════════════════

@app.get("/api/calls")
async def calls_list():
    rows = await pool.fetch("SELECT * FROM calls ORDER BY created_at DESC")
    return [dict(r) for r in rows]

@app.post("/api/calls")
async def calls_create(req: Request):
    b = await req.json()
    phone          = b.get("phone", "")
    direction      = b.get("direction", "outbound")
    duration       = b.get("duration", 0)
    transcript     = b.get("transcript", "")
    summary        = b.get("summary", "")
    score          = b.get("score")
    errors         = b.get("errors", [])
    positives      = b.get("positives", [])
    recommendation = b.get("recommendation", "")
    saved          = b.get("saved", False)
    contact_id     = b.get("contact_id")
    manager_id     = b.get("manager_id")

    call = await pool.fetchrow(
        """INSERT INTO calls
             (phone, direction, duration, transcript, summary, score, errors, positives, recommendation, saved, contact_id, manager_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *""",
        phone, direction, duration, transcript, summary, score,
        errors, positives, recommendation,
        saved, contact_id, manager_id,
    )
    await broadcast({"type": "call_saved", "id": call["id"], "phone": call["phone"]})
    return {"ok": True, "id": call["id"]}

@app.put("/api/calls/{call_id}")
async def calls_update(call_id: int, req: Request):
    b = await req.json()
    parts = []
    vals  = []
    idx   = 1
    if "admin_comment" in b: parts.append(f"admin_comment=${idx}"); vals.append(b["admin_comment"]); idx += 1
    if "saved"         in b: parts.append(f"saved=${idx}");         vals.append(b["saved"]);         idx += 1
    if "contact_id"    in b: parts.append(f"contact_id=${idx}");    vals.append(b["contact_id"]);    idx += 1
    if not parts:
        return {"ok": True}
    vals.append(call_id)
    await pool.execute(f"UPDATE calls SET {', '.join(parts)} WHERE id=${idx}", *vals)
    return {"ok": True}

@app.delete("/api/calls/{call_id}")
async def calls_delete(call_id: int):
    await pool.execute("DELETE FROM calls WHERE id=$1", call_id)
    return {"ok": True}

# ═══════════════════════════════════════════════════════════
# CONTACTS API
# ═══════════════════════════════════════════════════════════

@app.get("/api/contacts")
async def contacts_list():
    rows = await pool.fetch("SELECT * FROM contacts ORDER BY created_at DESC")
    return [dict(r) for r in rows]

@app.get("/api/contacts/{contact_id}")
async def contacts_get(contact_id: int):
    contact = await pool.fetchrow("SELECT * FROM contacts WHERE id=$1", contact_id)
    if not contact:
        raise HTTPException(404, {"error": "Not found"})
    calls = await pool.fetch("SELECT * FROM calls WHERE contact_id=$1 ORDER BY created_at DESC", contact_id)
    return {**dict(contact), "calls": [dict(c) for c in calls]}

@app.post("/api/contacts")
async def contacts_create(req: Request):
    b = await req.json()
    phone          = b.get("phone")
    company        = b.get("company")
    name           = b.get("name")
    summary        = b.get("summary")
    transcript     = b.get("transcript")
    score          = b.get("score")
    errors         = b.get("errors")
    recommendation = b.get("recommendation")
    call_id        = b.get("call_id")

    existing = await pool.fetchrow("SELECT * FROM contacts WHERE phone=$1", phone)
    if existing:
        await pool.execute(
            """UPDATE contacts SET
                 company=$1, name=$2, summary=$3, transcript=$4, score=$5,
                 errors=$6, recommendation=$7,
                 calls_count=calls_count+1, updated_at=NOW()
               WHERE id=$8""",
            company        or existing["company"],
            name           or existing["name"],
            summary        or existing["summary"],
            transcript     or existing["transcript"],
            score          or existing["score"],
            errors         if errors is not None else (existing["errors"] or []),
            recommendation or existing["recommendation"],
            existing["id"],
        )
        contact_id = existing["id"]
    else:
        row = await pool.fetchrow(
            """INSERT INTO contacts (phone, company, name, summary, transcript, score, errors, recommendation)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id""",
            phone,
            company        or "",
            name           or "",
            summary        or "",
            transcript     or "",
            score,
            errors         if errors is not None else [],
            recommendation or "",
        )
        contact_id = row["id"]

    if call_id:
        await pool.execute("UPDATE calls SET saved=true, contact_id=$1 WHERE id=$2", contact_id, call_id)

    await broadcast({"type": "contact_saved", "id": contact_id, "phone": phone, "company": company})
    return {"ok": True, "id": contact_id}

@app.put("/api/contacts/{contact_id}")
async def contacts_update(contact_id: int, req: Request):
    existing = await pool.fetchrow("SELECT * FROM contacts WHERE id=$1", contact_id)
    if not existing:
        raise HTTPException(404, {"error": "Not found"})
    b = await req.json()
    await pool.execute(
        """UPDATE contacts SET
             phone=$1, company=$2, name=$3, summary=$4, transcript=$5,
             score=$6, errors=$7, recommendation=$8, updated_at=NOW()
           WHERE id=$9""",
        b.get("phone")          if b.get("phone")          is not None else existing["phone"],
        b.get("company")        if b.get("company")        is not None else existing["company"],
        b.get("name")           if b.get("name")           is not None else existing["name"],
        b.get("summary")        if b.get("summary")        is not None else existing["summary"],
        b.get("transcript")     if b.get("transcript")     is not None else existing["transcript"],
        b.get("score")          if b.get("score")          is not None else existing["score"],
        b.get("errors")         if b.get("errors")         is not None else (existing["errors"] or []),
        b.get("recommendation") if b.get("recommendation") is not None else existing["recommendation"],
        existing["id"],
    )
    return {"ok": True}

@app.delete("/api/contacts/{contact_id}")
async def contacts_delete(contact_id: int):
    await pool.execute("DELETE FROM contacts WHERE id=$1", contact_id)
    return {"ok": True}

# ═══════════════════════════════════════════════════════════
# MANAGERS API
# ═══════════════════════════════════════════════════════════

@app.get("/api/managers")
async def managers_list():
    rows = await pool.fetch("SELECT * FROM managers ORDER BY id")
    return [dict(r) for r in rows]

@app.post("/api/managers")
async def managers_create(req: Request):
    b      = await req.json()
    name   = b.get("name", "").strip()
    color  = b.get("color", "#6366f1")
    avatar = "".join(w[0].upper() for w in name.split() if w)[:2]
    row = await pool.fetchrow(
        "INSERT INTO managers (name, avatar, color) VALUES ($1,$2,$3) RETURNING *",
        name, avatar, color,
    )
    return {"ok": True, "id": row["id"]}

@app.put("/api/managers/{mgr_id}")
async def managers_update(mgr_id: int, req: Request):
    existing = await pool.fetchrow("SELECT * FROM managers WHERE id=$1", mgr_id)
    if not existing:
        raise HTTPException(404, {"error": "Not found"})
    b = await req.json()
    await pool.execute(
        "UPDATE managers SET name=$1, color=$2, avatar=$3 WHERE id=$4",
        b.get("name")   if b.get("name")   is not None else existing["name"],
        b.get("color")  if b.get("color")  is not None else existing["color"],
        b.get("avatar") if b.get("avatar") is not None else existing["avatar"],
        existing["id"],
    )
    return {"ok": True}

@app.delete("/api/managers/{mgr_id}")
async def managers_delete(mgr_id: int):
    await pool.execute("DELETE FROM managers WHERE id=$1", mgr_id)
    return {"ok": True}

@app.post("/api/managers/{mgr_id}/stats")
async def managers_stats(mgr_id: int, req: Request):
    b          = await req.json()
    score      = b.get("score", 0)
    violations = b.get("violations", 0)
    mgr = await pool.fetchrow("SELECT * FROM managers WHERE id=$1", mgr_id)
    if not mgr:
        raise HTTPException(404, {"error": "Not found"})

    new_count = mgr["calls_count"] + 1
    avg       = mgr["avg_score"]
    new_avg   = score if avg is None else round((float(avg) * mgr["calls_count"] + score) / new_count)

    await pool.execute(
        "UPDATE managers SET calls_count=$1, avg_score=$2, violations=violations+$3 WHERE id=$4",
        new_count, new_avg, violations, mgr["id"],
    )
    return {"ok": True}

@app.delete("/api/managers/{mgr_id}/reset")
async def managers_reset(mgr_id: int):
    await pool.execute(
        "UPDATE managers SET violations=0, calls_count=0, avg_score=NULL WHERE id=$1",
        mgr_id,
    )
    return {"ok": True}

# ═══════════════════════════════════════════════════════════
# SETTINGS API
# ═══════════════════════════════════════════════════════════

@app.get("/api/settings")
async def settings_list():
    rows = await pool.fetch("SELECT key, value FROM settings")
    return {r["key"]: r["value"] for r in rows}

@app.put("/api/settings/{key}")
async def settings_update(key: str, req: Request):
    b = await req.json()
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        key, str(b.get("value", "")),
    )
    return {"ok": True}

# ═══════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

@app.post("/api/notify")
async def notify(req: Request):
    b            = await req.json()
    manager_name = b.get("managerName", "")
    violations   = b.get("violations", 0)
    threshold    = b.get("threshold", 0)

    if os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID"):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"https://api.telegram.org/bot{os.getenv('TELEGRAM_BOT_TOKEN')}/sendMessage",
                    json={
                        "chat_id":    os.getenv("TELEGRAM_CHAT_ID"),
                        "text":       (
                            f"⚠️ *Sales Alert*\n"
                            f"Менеджер *{manager_name}*: *{violations}/{threshold}* нарушений\n"
                            f"🕐 {datetime.datetime.now().strftime('%d.%m.%Y %H:%M:%S')}"
                        ),
                        "parse_mode": "Markdown",
                    },
                )
            if not r.is_success:
                raise RuntimeError(r.json().get("description"))
            return {"ok": True, "mode": "telegram"}
        except Exception as e:
            print(f"[NOTIFY] {e}")

    print(f"[NOTIFY] {manager_name}: {violations}/{threshold}")
    return {"ok": True, "mode": "console"}

# ═══════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
