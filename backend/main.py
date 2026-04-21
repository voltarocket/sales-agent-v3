import asyncio
import hashlib
import json
import os
import random
import re
import secrets
import string
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

# ═══════════════════════════════════════════════════════════
# AUTH UTILITIES
# ═══════════════════════════════════════════════════════════

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()

def verify_password(password: str, hashed: str) -> bool:
    return hashlib.sha256(password.encode("utf-8")).hexdigest() == hashed

def generate_token() -> str:
    return secrets.token_hex(32)

ADMIN_TOKEN: str = os.getenv("ADMIN_TOKEN", "")
if not ADMIN_TOKEN:
    ADMIN_TOKEN = secrets.token_hex(16)
    print(f"[AUTH] ⚠ ADMIN_TOKEN not set — generated: {ADMIN_TOKEN}")
    print(f"[AUTH]   Add ADMIN_TOKEN={ADMIN_TOKEN} to backend/.env to make it permanent")

active_sessions: dict = {}  # token → manager_id


def _get_token(req) -> str:
    auth = req.headers.get("Authorization", "")
    return auth.removeprefix("Bearer ").strip()

def _is_admin(req) -> bool:
    return _get_token(req) == ADMIN_TOKEN

def _get_manager(req) -> Optional[dict]:
    mid = active_sessions.get(_get_token(req))
    if mid is None:
        return None
    return next((m for m in db_data["managers"] if m["id"] == mid), None)

def _safe_manager(m: dict) -> dict:
    return {k: v for k, v in m.items() if k != "password_hash"}


# ═══════════════════════════════════════════════════════════
# DATABASE — JSON file with threading lock
# ═══════════════════════════════════════════════════════════

DB_PATH = Path("sales.json")
_db_lock = threading.Lock()

_DEFAULT_DB = {
    "contacts": [],
    "calls": [],
    "managers": [
        {
            "id": 1,
            "name": "Менеджер",
            "username": "manager",
            "password_hash": hash_password("12345"),
            "avatar": "МН",
            "color": "#6366f1",
            "violations": 0,
            "calls_count": 0,
            "avg_score": None,
        }
    ],
}


def _load_db() -> dict:
    if not DB_PATH.exists():
        DB_PATH.write_text(json.dumps(_DEFAULT_DB, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        return json.loads(DB_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {k: list(v) if isinstance(v, list) else v for k, v in _DEFAULT_DB.items()}


def _save_db(data: dict) -> None:
    DB_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


db_data: dict = _load_db()
for _k, _v in _DEFAULT_DB.items():
    if _k not in db_data:
        db_data[_k] = _v
# migrate existing managers: add username/password if missing
for _mgr in db_data.get("managers", []):
    if "username" not in _mgr:
        _mgr["username"] = f"manager{_mgr['id']}"
    if "password_hash" not in _mgr:
        _mgr["password_hash"] = hash_password("12345")
_save_db(db_data)
print("[DB] ready → sales.json")


def db_write() -> None:
    with _db_lock:
        _save_db(db_data)


def next_id(arr: list) -> int:
    return max((r["id"] for r in arr), default=0) + 1


def now_str() -> str:
    return datetime.now().strftime("%d.%m.%Y %H:%M:%S")


# ═══════════════════════════════════════════════════════════
# PROVIDERS
# ═══════════════════════════════════════════════════════════

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")

TRANSCRIBE: Optional[str] = "groq" if GROQ_API_KEY else ("yandex" if YANDEX_API_KEY else None)
ANALYZE: Optional[str] = "yandex" if YANDEX_API_KEY else ("groq" if GROQ_API_KEY else None)

# ═══════════════════════════════════════════════════════════
# FFMPEG
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
# FASTAPI APP
# ═══════════════════════════════════════════════════════════

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Path("uploads").mkdir(exist_ok=True)

# ═══════════════════════════════════════════════════════════
# WEBSOCKET — connection manager
# ═══════════════════════════════════════════════════════════

ws_clients: set = set()
sessions: dict = {}


async def _broadcast(data: dict) -> None:
    msg = json.dumps(data, ensure_ascii=False)
    dead = set()
    for ws in ws_clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


# ═══════════════════════════════════════════════════════════
# TRANSCRIPTION
# ═══════════════════════════════════════════════════════════

async def transcribe_groq(file_path: str, original_name: str = "audio.wav", mimetype: str = "audio/wav") -> dict:
    async with httpx.AsyncClient(timeout=120) as client:
        with open(file_path, "rb") as f:
            r = await client.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                files={"file": (original_name, f, mimetype)},
                data={"model": "whisper-large-v3", "language": "ru", "response_format": "verbose_json"},
            )
    if not r.is_success:
        err = r.json()
        raise Exception(err.get("error", {}).get("message") or f"Groq {r.status_code}")
    d = r.json()
    return {"text": d["text"], "duration": d.get("duration")}


async def _transcribe_yandex_chunk(wav_path: str) -> str:
    data = Path(wav_path).read_bytes()
    if len(data) > 1024 * 1024:
        raise Exception("Chunk > 1MB")
    url = f"https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId={YANDEX_FOLDER_ID}&lang=ru-RU"
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Api-Key {YANDEX_API_KEY}", "Content-Type": "audio/wav"},
            content=data,
        )
    if not r.is_success:
        ct = r.headers.get("content-type", "")
        err = r.json() if "application/json" in ct else {}
        raise Exception(err.get("error_message") or f"SpeechKit {r.status_code}")
    return r.json().get("result", "")


async def transcribe_yandex(file_path: str) -> dict:
    wav = to_wav(file_path)
    chunks = split_wav(wav or file_path)
    parts = [await _transcribe_yandex_chunk(c) for c in chunks]
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
                "model": "llama-3.3-70b-versatile",
                "temperature": 0.2,
                "max_tokens": 2000,
                "messages": [
                    {"role": "system", "content": _SYS},
                    {"role": "user", "content": _build_prompt(name, transcript)},
                ],
            },
        )
    if not r.is_success:
        err = r.json()
        raise Exception(err.get("error", {}).get("message"))
    return r.json()["choices"][0]["message"]["content"] or ""


async def analyze_yandex(name: str, transcript: str) -> str:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
            headers={"Authorization": f"Api-Key {YANDEX_API_KEY}", "Content-Type": "application/json"},
            json={
                "modelUri": f"gpt://{YANDEX_FOLDER_ID}/yandexgpt-lite/latest",
                "completionOptions": {"stream": False, "temperature": 0.2, "maxTokens": 2000},
                "messages": [
                    {"role": "system", "text": _SYS},
                    {"role": "user", "text": _build_prompt(name, transcript)},
                ],
            },
        )
    if not r.is_success:
        ct = r.headers.get("content-type", "")
        err = r.json() if "application/json" in ct else {}
        raise Exception(err.get("message"))
    return r.json().get("result", {}).get("alternatives", [{}])[0].get("message", {}).get("text", "") or ""


def _clean_json(raw: str) -> dict:
    clean = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    clean = re.sub(r"\s*```$", "", clean).strip()
    return json.loads(clean)


# ═══════════════════════════════════════════════════════════
# ROUTES — HEALTH
# ═══════════════════════════════════════════════════════════

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "transcribe": TRANSCRIBE,
        "analyze": ANALYZE,
        "ffmpeg": bool(FFMPEG),
        "sip": {
            "host": os.getenv("FREEPBX_HOST", "localhost"),
            "wsPort": os.getenv("FREEPBX_WS_PORT", "8088"),
            "extension": os.getenv("FREEPBX_EXTENSION", "not set"),
        },
    }


# ═══════════════════════════════════════════════════════════
# ROUTES — AUTH
# ═══════════════════════════════════════════════════════════

@app.post("/api/auth/login")
async def auth_login(req: Request):
    body = await req.json()
    username = body.get("username", "").strip()
    password = body.get("password", "")
    mgr = next((m for m in db_data["managers"] if m.get("username") == username), None)
    if not mgr or not verify_password(password, mgr.get("password_hash", "")):
        raise HTTPException(401, {"error": "Неверный логин или пароль"})
    token = generate_token()
    active_sessions[token] = mgr["id"]
    return {"ok": True, "token": token, "id": mgr["id"], "name": mgr["name"]}


@app.get("/api/auth/me")
async def auth_me(req: Request):
    mgr = _get_manager(req)
    if not mgr:
        raise HTTPException(401, {"error": "Unauthorized"})
    return _safe_manager(mgr)


@app.post("/api/auth/admin")
async def auth_admin(req: Request):
    body = await req.json()
    if body.get("token", "") != ADMIN_TOKEN:
        raise HTTPException(401, {"error": "Неверный токен администратора"})
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(req: Request):
    token = _get_token(req)
    active_sessions.pop(token, None)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# ROUTES — SIP CONFIG
# ═══════════════════════════════════════════════════════════

@app.get("/api/sip/config")
def sip_config(ext: Optional[str] = None):
    host = os.getenv("FREEPBX_HOST", "localhost")
    ws_port = os.getenv("FREEPBX_WS_PORT", "8088")
    domain = os.getenv("FREEPBX_DOMAIN") or host
    ws_uri = f"ws://{host}:{ws_port}/ws"

    extensions = []
    if os.getenv("FREEPBX_EXTENSION") and os.getenv("FREEPBX_PASSWORD"):
        extensions.append({
            "extension": os.getenv("FREEPBX_EXTENSION"),
            "password": os.getenv("FREEPBX_PASSWORD"),
            "label": "Менеджер",
        })
    if os.getenv("FREEPBX_EXT_2") and os.getenv("FREEPBX_PASS_2"):
        extensions.append({
            "extension": os.getenv("FREEPBX_EXT_2"),
            "password": os.getenv("FREEPBX_PASS_2"),
            "label": "Клиент",
        })

    if not extensions:
        raise HTTPException(503, {
            "error": "FreePBX not configured",
            "hint": "Set FREEPBX_EXTENSION and FREEPBX_PASSWORD in .env",
        })

    if ext:
        found = next((e for e in extensions if e["extension"] == ext), None)
        if not found:
            raise HTTPException(404, {"error": "Extension not found"})
        return {**found, "domain": domain, "wsUri": ws_uri}

    return {**extensions[0], "domain": domain, "wsUri": ws_uri, "extensions": extensions}


# ═══════════════════════════════════════════════════════════
# ROUTES — TRANSCRIBE
# ═══════════════════════════════════════════════════════════

@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    if not TRANSCRIBE:
        raise HTTPException(500, {"error": "No transcription key in .env"})

    suffix = Path(audio.filename or "audio").suffix or ".audio"
    tmp = Path("uploads") / f"upload_{os.urandom(8).hex()}{suffix}"
    try:
        tmp.write_bytes(await audio.read())
        if TRANSCRIBE == "groq":
            result = await transcribe_groq(str(tmp), audio.filename or "audio.wav", audio.content_type or "audio/wav")
        else:
            result = await transcribe_yandex(str(tmp))
        print(f"[STT] {TRANSCRIBE} OK | {len(result['text'])} chars")
        return {"transcript": result["text"], "duration": result["duration"]}
    except Exception as e:
        print(f"[STT] {e}")
        raise HTTPException(500, {"error": str(e)})
    finally:
        if tmp.exists():
            tmp.unlink()


# ═══════════════════════════════════════════════════════════
# ROUTES — ANALYZE
# ═══════════════════════════════════════════════════════════

@app.post("/api/analyze")
async def analyze(req: Request):
    body = await req.json()
    manager_name = body.get("managerName", "Менеджер")
    transcript = body.get("transcript", "")
    if not transcript:
        raise HTTPException(400, {"error": "transcript required"})
    if not ANALYZE:
        raise HTTPException(500, {"error": "No analysis key in .env"})
    try:
        raw = await analyze_yandex(manager_name, transcript) if ANALYZE == "yandex" else await analyze_groq(manager_name, transcript)
        return _clean_json(raw)
    except Exception as e:
        print(f"[LLM] {e}")
        raise HTTPException(500, {"error": str(e)})


# ═══════════════════════════════════════════════════════════
# ROUTES — CALLS
# ═══════════════════════════════════════════════════════════

@app.get("/api/calls")
def get_calls():
    return list(reversed(db_data["calls"]))


@app.post("/api/calls")
async def create_call(req: Request):
    body = await req.json()
    call = {
        "id": next_id(db_data["calls"]),
        "phone": body.get("phone", ""),
        "direction": body.get("direction", "outbound"),
        "duration": body.get("duration", 0),
        "transcript": body.get("transcript", ""),
        "summary": body.get("summary", ""),
        "score": body.get("score"),
        "errors": body.get("errors", []),
        "positives": body.get("positives", []),
        "recommendation": body.get("recommendation", ""),
        "saved": bool(body.get("saved", False)),
        "contact_id": body.get("contact_id"),
        "created_at": now_str(),
    }
    db_data["calls"].append(call)
    db_write()
    asyncio.create_task(_broadcast({"type": "call_saved", "id": call["id"], "phone": call["phone"]}))
    return {"ok": True, "id": call["id"]}


@app.delete("/api/calls/{call_id}")
async def delete_call(call_id: int):
    db_data["calls"] = [c for c in db_data["calls"] if c["id"] != call_id]
    db_write()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# ROUTES — CONTACTS
# ═══════════════════════════════════════════════════════════

@app.get("/api/contacts")
def get_contacts():
    return list(reversed(db_data["contacts"]))


@app.get("/api/contacts/{contact_id}")
def get_contact(contact_id: int):
    c = next((c for c in db_data["contacts"] if c["id"] == contact_id), None)
    if not c:
        raise HTTPException(404, {"error": "Not found"})
    calls = list(reversed([call for call in db_data["calls"] if call.get("contact_id") == c["id"]]))
    return {**c, "calls": calls}


@app.post("/api/contacts")
async def create_or_update_contact(req: Request):
    body = await req.json()
    phone = body.get("phone")
    company = body.get("company")
    name = body.get("name")
    summary = body.get("summary")
    transcript = body.get("transcript")
    score = body.get("score")
    errors = body.get("errors")
    recommendation = body.get("recommendation")
    call_id = body.get("call_id")

    existing = next((c for c in db_data["contacts"] if c["phone"] == phone), None)
    if existing:
        if company is not None:
            existing["company"] = company or existing["company"]
        if name is not None:
            existing["name"] = name or existing["name"]
        if summary is not None:
            existing["summary"] = summary or existing["summary"]
        if transcript is not None:
            existing["transcript"] = transcript or existing["transcript"]
        if score is not None:
            existing["score"] = score or existing["score"]
        if errors is not None:
            existing["errors"] = errors or existing["errors"]
        if recommendation is not None:
            existing["recommendation"] = recommendation or existing["recommendation"]
        existing["calls_count"] = (existing.get("calls_count") or 1) + 1
        existing["updated_at"] = now_str()
        contact_id = existing["id"]
    else:
        contact = {
            "id": next_id(db_data["contacts"]),
            "phone": phone,
            "company": company or "",
            "name": name or "",
            "summary": summary or "",
            "transcript": transcript or "",
            "score": score,
            "errors": errors or [],
            "recommendation": recommendation or "",
            "calls_count": 1,
            "created_at": now_str(),
            "updated_at": now_str(),
        }
        db_data["contacts"].append(contact)
        contact_id = contact["id"]

    if call_id:
        call = next((c for c in db_data["calls"] if c["id"] == call_id), None)
        if call:
            call["saved"] = True
            call["contact_id"] = contact_id

    db_write()
    asyncio.create_task(_broadcast({"type": "contact_saved", "id": contact_id, "phone": phone, "company": company}))
    return {"ok": True, "id": contact_id}


@app.put("/api/contacts/{contact_id}")
async def update_contact(contact_id: int, req: Request):
    c = next((c for c in db_data["contacts"] if c["id"] == contact_id), None)
    if not c:
        raise HTTPException(404, {"error": "Not found"})
    body = await req.json()
    c.update({**body, "updated_at": now_str()})
    db_write()
    return {"ok": True}


@app.delete("/api/contacts/{contact_id}")
async def delete_contact(contact_id: int):
    db_data["contacts"] = [c for c in db_data["contacts"] if c["id"] != contact_id]
    db_write()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# ROUTES — MANAGERS
# ═══════════════════════════════════════════════════════════

@app.get("/api/managers")
def get_managers():
    return [_safe_manager(m) for m in db_data["managers"]]


@app.post("/api/managers")
async def create_manager(req: Request):
    if not _is_admin(req):
        raise HTTPException(401, {"error": "Требуется доступ администратора"})
    body = await req.json()
    name = body.get("name", "").strip()
    username = body.get("username", "").strip()
    password = body.get("password", "")
    color = body.get("color", "#6366f1")
    if not name:
        raise HTTPException(400, {"error": "Имя обязательно"})
    if not username:
        raise HTTPException(400, {"error": "Логин обязателен"})
    if not password:
        raise HTTPException(400, {"error": "Пароль обязателен"})
    if next((m for m in db_data["managers"] if m.get("username") == username), None):
        raise HTTPException(400, {"error": "Логин уже занят"})
    initials = "".join(w[0] for w in name.split() if w).upper()[:2]
    mgr = {
        "id": next_id(db_data["managers"]),
        "name": name,
        "username": username,
        "password_hash": hash_password(password),
        "avatar": initials,
        "color": color,
        "violations": 0,
        "calls_count": 0,
        "avg_score": None,
    }
    db_data["managers"].append(mgr)
    db_write()
    return {"ok": True, "id": mgr["id"]}


@app.put("/api/managers/{manager_id}")
async def update_manager(manager_id: int, req: Request):
    if not _is_admin(req):
        raise HTTPException(401, {"error": "Требуется доступ администратора"})
    mgr = next((m for m in db_data["managers"] if m["id"] == manager_id), None)
    if not mgr:
        raise HTTPException(404, {"error": "Not found"})
    body = await req.json()
    if "name" in body and body["name"].strip():
        mgr["name"] = body["name"].strip()
        mgr["avatar"] = "".join(w[0] for w in mgr["name"].split() if w).upper()[:2]
    if "username" in body:
        new_uname = body["username"].strip()
        if new_uname != mgr["username"]:
            if next((m for m in db_data["managers"] if m.get("username") == new_uname and m["id"] != manager_id), None):
                raise HTTPException(400, {"error": "Логин уже занят"})
            mgr["username"] = new_uname
    if "password" in body and body["password"]:
        mgr["password_hash"] = hash_password(body["password"])
    if "color" in body:
        mgr["color"] = body["color"]
    db_write()
    return {"ok": True}


@app.delete("/api/managers/{manager_id}")
async def delete_manager(manager_id: int, req: Request):
    if not _is_admin(req):
        raise HTTPException(401, {"error": "Требуется доступ администратора"})
    db_data["managers"] = [m for m in db_data["managers"] if m["id"] != manager_id]
    db_write()
    return {"ok": True}


@app.post("/api/managers/{manager_id}/stats")
async def manager_stats(manager_id: int, req: Request):
    mgr = next((m for m in db_data["managers"] if m["id"] == manager_id), None)
    if not mgr:
        raise HTTPException(404, {"error": "Not found"})
    body = await req.json()
    score = body.get("score", 0)
    violations = body.get("violations", 0)
    mgr["calls_count"] += 1
    if mgr["avg_score"] is None:
        mgr["avg_score"] = score
    else:
        mgr["avg_score"] = round(
            (mgr["avg_score"] * (mgr["calls_count"] - 1) + score) / mgr["calls_count"]
        )
    mgr["violations"] += violations
    db_write()
    return {"ok": True}


@app.delete("/api/managers/{manager_id}/reset")
async def reset_manager(manager_id: int):
    mgr = next((m for m in db_data["managers"] if m["id"] == manager_id), None)
    if mgr:
        mgr["violations"] = 0
        mgr["calls_count"] = 0
        mgr["avg_score"] = None
        db_write()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# ROUTES — NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

@app.post("/api/notify")
async def notify(req: Request):
    body = await req.json()
    to = body.get("to")
    manager_name = body.get("managerName", "")
    violations = body.get("violations", 0)
    threshold = body.get("threshold", 0)

    if os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID"):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"https://api.telegram.org/bot{os.getenv('TELEGRAM_BOT_TOKEN')}/sendMessage",
                    json={
                        "chat_id": os.getenv("TELEGRAM_CHAT_ID"),
                        "text": (
                            f"⚠️ *Sales Alert*\n"
                            f"Менеджер *{manager_name}*: *{violations}/{threshold}* нарушений\n"
                            f"🕐 {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}"
                        ),
                        "parse_mode": "Markdown",
                    },
                )
            if not r.is_success:
                raise Exception(r.json().get("description"))
            return {"ok": True, "mode": "telegram"}
        except Exception as e:
            print(f"[NOTIFY] {e}")

    print(f"[NOTIFY] {manager_name}: {violations}/{threshold} → {to}")
    return {"ok": True, "mode": "console"}


# ═══════════════════════════════════════════════════════════
# WEBSOCKET — audio streaming
# ═══════════════════════════════════════════════════════════

async def _process_session(session: dict, duration: int) -> dict:
    audio_buffer = b"".join(session["chunks"])
    print(f"[WS] audio buffer: {len(audio_buffer)} bytes, duration: {duration}s")

    transcript = ""
    if len(audio_buffer) > 1000 and TRANSCRIBE:
        tmp_pcm = Path("uploads") / f"ws_{int(time.time() * 1000)}.pcm"
        wav_path = str(tmp_pcm) + ".wav"
        tmp_pcm.write_bytes(audio_buffer)
        try:
            if FFMPEG:
                r = subprocess.run(
                    [FFMPEG, "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", str(tmp_pcm), wav_path],
                    capture_output=True, timeout=30,
                )
                if r.returncode == 0:
                    result = await transcribe_groq(wav_path, "audio.wav", "audio/wav")
                    transcript = result["text"]
                if os.path.exists(wav_path):
                    os.unlink(wav_path)
        finally:
            if tmp_pcm.exists():
                tmp_pcm.unlink()

    analysis: dict = {"summary": "", "score": 0, "errors": [], "positives": [], "recommendation": ""}
    if transcript and ANALYZE:
        try:
            raw = await analyze_groq("Менеджер", transcript)
            analysis = _clean_json(raw)
        except Exception as e:
            print(f"[WS] analyze error: {e}")

    call = {
        "id": next_id(db_data["calls"]),
        "phone": session["phone"],
        "direction": "outbound",
        "duration": duration,
        "transcript": transcript,
        "summary": analysis.get("summary", ""),
        "score": analysis.get("score", 0),
        "errors": analysis.get("errors", []),
        "positives": analysis.get("positives", []),
        "recommendation": analysis.get("recommendation", ""),
        "saved": False,
        "contact_id": None,
        "created_at": now_str(),
    }
    db_data["calls"].append(call)
    db_write()

    return {
        "sessionId": f"done_{call['id']}",
        "phone": session["phone"],
        "duration": duration,
        "transcript": transcript,
        "analysis": analysis,
    }


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
                rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
                session_id = f"session_{int(time.time() * 1000)}_{rand}"
                sessions[session_id] = {
                    "ws": websocket,
                    "phone": msg.get("phone", "unknown"),
                    "managerId": msg.get("managerId", 1),
                    "chunks": [],
                    "startTime": time.time(),
                }
                await websocket.send_text(json.dumps({"type": "session_started", "sessionId": session_id}))
                print(f"[WS] call_start → {session_id} phone={msg.get('phone')}")

            elif msg.get("type") == "call_end" and session_id and session_id in sessions:
                print(f"[WS] call_end → {session_id}")
                session = sessions.pop(session_id)
                await websocket.send_text(json.dumps({"type": "processing"}))
                try:
                    duration = round(time.time() - session["startTime"])
                    result = await _process_session(session, duration)
                    await websocket.send_text(json.dumps({"type": "call_analyzed", **result}, ensure_ascii=False))
                    print(f"[WS] analysis done → score={result.get('analysis', {}).get('score')}")
                except Exception as e:
                    print(f"[WS] processing error: {e}")
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
# STARTUP BANNER
# ═══════════════════════════════════════════════════════════

@app.on_event("startup")
async def startup_banner():
    port = int(os.getenv("PORT", "3001"))
    ext2 = os.getenv("FREEPBX_EXT_2", "")
    print(f"\n🚀  http://localhost:{port}")
    print(f"    STT    : {TRANSCRIBE or '⚠ no key'}")
    print(f"    LLM    : {ANALYZE or '⚠ no key'}")
    print(f"    ffmpeg : {'✓' if FFMPEG else '✗'}")
    print(f"    SIP    : ws://localhost:{os.getenv('FREEPBX_WS_PORT', '8088')}/ws")
    print(f"    exts   : {os.getenv('FREEPBX_EXTENSION', '?')}{' + ' + ext2 if ext2 else ''}")
    print(f"    DB     : sales.json\n")


# ═══════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "3001")))
