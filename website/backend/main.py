"""
Sales Call Analyzer — Website Backend
User registration, auth, downloads, admin panel API
"""
import datetime, hashlib, json, os, secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import asyncpg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

DATABASE_URL  = os.getenv("DATABASE_URL", "postgresql://sales:sales_pass@localhost:5432/sales_agent")
ADMIN_USER    = os.getenv("SITE_ADMIN_USER", "admin")
ADMIN_PASS    = os.getenv("SITE_ADMIN_PASS", "admin")
GLOBAL_URL    = os.getenv("GLOBAL_BACKEND_URL", "http://localhost:3002")
GLOBAL_SECRET = os.getenv("GLOBAL_ADMIN_SECRET", "")
PORT          = int(os.getenv("PORT", "3003"))

# Downloads config — set real URLs in env
DOWNLOADS = [
    {"id": "desktop",  "title": "Desktop App",    "desc": "Приложение менеджера (Windows)",  "url": os.getenv("DOWNLOAD_DESKTOP", "#"),  "icon": "🖥"},
    {"id": "admin",    "title": "Admin App",       "desc": "Панель администратора (Windows)", "url": os.getenv("DOWNLOAD_ADMIN",   "#"),  "icon": "⚙️"},
    {"id": "backend",  "title": "Local Backend",   "desc": "Локальный сервер (Docker)",       "url": os.getenv("DOWNLOAD_BACKEND", "#"),  "icon": "🐳"},
]

pool: asyncpg.Pool = None  # type: ignore
sessions: dict = {}  # token → user_id

def _hash(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

def _token() -> str:
    return secrets.token_hex(32)

async def _init_conn(conn):
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

async def _wait_for_db(retries=10, delay=2.0):
    import asyncio
    for i in range(1, retries + 1):
        try:
            c = await asyncpg.connect(DATABASE_URL)
            await c.close()
            print("[WebsiteDB] connected ✓")
            return
        except Exception:
            print(f"[WebsiteDB] waiting... ({i}/{retries})")
            await asyncio.sleep(delay)
    raise RuntimeError("Could not connect to DB")

@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    await _wait_for_db()
    pool = await asyncpg.create_pool(DATABASE_URL, init=_init_conn, min_size=1, max_size=5)
    print(f"\n🌍  Website → http://localhost:{PORT}\n")
    yield
    await pool.close()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_session(req: Request) -> int:
    token = req.headers.get("x-session-token") or req.cookies.get("session")
    if not token or token not in sessions:
        raise HTTPException(401, {"error": "Не авторизован"})
    return sessions[token]

def _require_admin(req: Request) -> None:
    token = req.headers.get("x-admin-token")
    if not token or token not in sessions or sessions[token] != "admin":
        raise HTTPException(401, {"error": "Требуется доступ администратора"})

async def _issue_license_key(user_id: int) -> str:
    """Generate unlimited license key in the licenses table and link to user."""
    key = "SALES-" + secrets.token_hex(16).upper()
    await pool.execute(
        "INSERT INTO licenses (key, customer, plan, max_devices, requests_per_month) VALUES ($1,$2,$3,$4,$5)",
        key, f"user:{user_id}", "unlimited", -1, -1,
    )
    await pool.execute("UPDATE website_users SET license_key=$1 WHERE id=$2", key, user_id)
    return key

# ── Auth API ──────────────────────────────────────────────────────────────────

@app.post("/api/auth/register")
async def register(req: Request):
    b     = await req.json()
    email = (b.get("email") or "").strip().lower()
    name  = (b.get("name")  or "").strip()
    pw    = (b.get("password") or "")
    if not email or "@" not in email:
        raise HTTPException(400, {"error": "Неверный email"})
    if len(pw) < 6:
        raise HTTPException(400, {"error": "Пароль минимум 6 символов"})
    if not name:
        raise HTTPException(400, {"error": "Имя обязательно"})
    existing = await pool.fetchrow("SELECT id FROM website_users WHERE email=$1", email)
    if existing:
        raise HTTPException(400, {"error": "Email уже зарегистрирован"})
    row = await pool.fetchrow(
        "INSERT INTO website_users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id",
        email, name, _hash(pw),
    )
    uid = row["id"]
    key = await _issue_license_key(uid)
    token = _token()
    sessions[token] = uid
    await pool.execute("UPDATE website_users SET last_login=NOW() WHERE id=$1", uid)
    return {"ok": True, "token": token, "user": {"id": uid, "email": email, "name": name, "license_key": key}}

@app.post("/api/auth/login")
async def login(req: Request):
    b     = await req.json()
    email = (b.get("email") or "").strip().lower()
    pw    = (b.get("password") or "")
    row = await pool.fetchrow("SELECT * FROM website_users WHERE email=$1 AND is_active=true", email)
    if not row or row["password_hash"] != _hash(pw):
        raise HTTPException(401, {"error": "Неверный email или пароль"})
    await pool.execute("UPDATE website_users SET last_login=NOW() WHERE id=$1", row["id"])
    token = _token()
    sessions[token] = row["id"]
    return {"ok": True, "token": token, "user": {"id": row["id"], "email": row["email"], "name": row["name"], "license_key": row["license_key"]}}

@app.post("/api/auth/verify")
async def verify(req: Request):
    """Called by Electron admin app to verify credentials."""
    b     = await req.json()
    email = (b.get("email") or "").strip().lower()
    pw    = (b.get("password") or "")
    row = await pool.fetchrow("SELECT * FROM website_users WHERE email=$1 AND is_active=true", email)
    if not row or row["password_hash"] != _hash(pw):
        return {"ok": False, "error": "Неверный email или пароль"}
    return {"ok": True, "user": {"id": row["id"], "email": row["email"], "name": row["name"], "license_key": row["license_key"]}}

@app.post("/api/auth/logout")
async def logout(req: Request):
    token = req.headers.get("x-session-token")
    if token:
        sessions.pop(token, None)
    return {"ok": True}

# ── User API ──────────────────────────────────────────────────────────────────

@app.get("/api/user/me")
async def me(req: Request):
    uid = _require_session(req)
    row = await pool.fetchrow("SELECT id, email, name, license_key, calls_analyzed, created_at FROM website_users WHERE id=$1", uid)
    if not row:
        raise HTTPException(404, {"error": "User not found"})
    return dict(row)

@app.get("/api/user/downloads")
async def downloads(req: Request):
    _require_session(req)
    return DOWNLOADS

# ── Admin API ─────────────────────────────────────────────────────────────────

@app.post("/api/admin/login")
async def admin_login(req: Request):
    b = await req.json()
    if b.get("username") != ADMIN_USER or b.get("password") != ADMIN_PASS:
        raise HTTPException(401, {"error": "Неверные данные"})
    token = _token()
    sessions[token] = "admin"
    return {"ok": True, "token": token}

@app.get("/api/admin/users")
async def admin_users(req: Request):
    _require_admin(req)
    rows = await pool.fetch(
        "SELECT id, email, name, license_key, calls_analyzed, last_login, created_at, is_active FROM website_users ORDER BY created_at DESC"
    )
    return [dict(r) for r in rows]

@app.get("/api/admin/stats")
async def admin_stats(req: Request):
    _require_admin(req)
    total  = await pool.fetchval("SELECT COUNT(*) FROM website_users")
    active = await pool.fetchval("SELECT COUNT(*) FROM website_users WHERE is_active=true")
    calls  = await pool.fetchval("SELECT COALESCE(SUM(calls_analyzed),0) FROM website_users")
    return {"total_users": total, "active_users": active, "total_calls": calls}

@app.patch("/api/admin/users/{uid}/toggle")
async def admin_toggle_user(uid: int, req: Request):
    _require_admin(req)
    row = await pool.fetchrow("SELECT is_active FROM website_users WHERE id=$1", uid)
    if not row:
        raise HTTPException(404, {"error": "User not found"})
    new_val = not row["is_active"]
    await pool.execute("UPDATE website_users SET is_active=$1 WHERE id=$2", new_val, uid)
    return {"ok": True, "is_active": new_val}

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"ok": True, "service": "website"}

# ── SPA fallback ──────────────────────────────────────────────────────────────

static_dir = Path("static")
if static_dir.exists():
    try:
        app.mount("/assets", StaticFiles(directory="static/assets"), name="static-assets")
    except Exception:
        pass

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    index = Path("static/index.html")
    if index.exists():
        return FileResponse(str(index))
    return {"error": "Frontend not built. Run: cd frontend && npm run build && cp -r dist ../backend/static"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
