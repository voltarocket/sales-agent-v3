// In-memory cache — drop-in replacement for ioredis
// Supports: get, set (EX), del, incr, expire, ping, connect

const store   = new Map(); // key → { value, expiresAt }
const timers  = new Map(); // key → timeout handle

function _ttlMs(seconds) { return seconds * 1000; }

function _set(key, value, ttlSec) {
  if (timers.has(key)) clearTimeout(timers.get(key));
  const expiresAt = ttlSec ? Date.now() + _ttlMs(ttlSec) : null;
  store.set(key, { value, expiresAt });
  if (ttlSec) {
    timers.set(key, setTimeout(() => { store.delete(key); timers.delete(key); }, _ttlMs(ttlSec)));
  }
}

function _get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    store.delete(key);
    timers.delete(key);
    return null;
  }
  return entry.value;
}

// Minimal ioredis-compatible interface
export const redis = {
  connect:  () => Promise.resolve(),
  ping:     () => Promise.resolve("PONG"),

  get(key) {
    return Promise.resolve(_get(key));
  },

  // set(key, value) or set(key, value, "EX", seconds)
  set(key, value, exFlag, ttlSec) {
    const ttl = (exFlag === "EX" && ttlSec) ? ttlSec : null;
    _set(key, value, ttl);
    return Promise.resolve("OK");
  },

  del(key) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    store.delete(key);
    timers.delete(key);
    return Promise.resolve(1);
  },

  incr(key) {
    const cur = parseInt(_get(key) || "0");
    const next = cur + 1;
    const entry = store.get(key);
    _set(key, String(next), entry?.expiresAt ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : null);
    return Promise.resolve(next);
  },

  expire(key, seconds) {
    const entry = store.get(key);
    if (!entry) return Promise.resolve(0);
    if (timers.has(key)) clearTimeout(timers.get(key));
    entry.expiresAt = Date.now() + _ttlMs(seconds);
    timers.set(key, setTimeout(() => { store.delete(key); timers.delete(key); }, _ttlMs(seconds)));
    return Promise.resolve(1);
  },

  on() { return this; }, // no-op event listener (ioredis compat)
};

console.log("[Cache] in-memory cache active (no Redis required)");

// ── Job helpers (used by server.js) ───────────────────────────────────────────

export async function setJob(jobId, status, data = null) {
  _set(`job:${jobId}`, JSON.stringify({ status, data, updatedAt: Date.now() }), 3600);
}

export async function getJob(jobId) {
  const val = _get(`job:${jobId}`);
  return val ? JSON.parse(val) : null;
}

export async function deleteJob(jobId) {
  redis.del(`job:${jobId}`);
}
