import os from "os";
import fetch from "node-fetch";
import { redis } from "./redis.js";

const CACHE_KEY      = "license:status";
const CACHE_TTL      = 3600;           // 1 hour
const USAGE_KEY      = (key, month) => `usage:${key}:${month}`;
const USAGE_TTL      = 60 * 60 * 24 * 35; // 35 days

// Resolved license state (set on startup, refreshed from cache)
export const licenseState = {
  checked:   false,
  valid:     false,
  plan:      null,
  reason:    null,
  limits:    { requests_per_month: -1, max_devices: -1 },
  usage:     { used: 0, month: null },
};

export async function initLicense(globalUrl) {
  const key      = process.env.LICENSE_KEY;
  const deviceId = process.env.DEVICE_ID || generateDeviceId();

  if (!key) {
    console.log("[LICENSE] No LICENSE_KEY set — running in dev mode (unlicensed)");
    licenseState.checked = true;
    licenseState.valid   = true; // dev mode: allow all
    licenseState.plan    = "dev";
    return;
  }

  // Try Redis cache first
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const data = JSON.parse(cached);
      Object.assign(licenseState, { checked: true, ...data });
      console.log(`[LICENSE] cache hit — plan=${data.plan} valid=${data.valid}`);
      return;
    }
  } catch (_) {}

  // Validate with global backend
  await refreshLicense(globalUrl, key, deviceId);
}

export async function refreshLicense(globalUrl, key, deviceId) {
  try {
    const r = await fetch(`${globalUrl}/licenses/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, deviceId }),
      timeout: 10000,
    });

    const data = await r.json();

    const update = {
      valid:   data.valid ?? false,
      plan:    data.plan  ?? null,
      reason:  data.reason ?? null,
      limits:  { requests_per_month: data.requests_per_month ?? -1, max_devices: data.max_devices ?? -1 },
      usage:   data.usage ?? { used: 0, month: null },
    };
    Object.assign(licenseState, { checked: true, ...update });

    // Cache in Redis
    try { await redis.set(CACHE_KEY, JSON.stringify(update), "EX", CACHE_TTL); } catch (_) {}

    if (data.valid) {
      console.log(`[LICENSE] valid — plan=${data.plan} usage=${data.usage?.used}/${data.requests_per_month}`);
    } else {
      console.warn(`[LICENSE] invalid — ${data.reason}`);
    }
  } catch (e) {
    console.error("[LICENSE] validation failed:", e.message);
    // Fail open on network errors — use cached state or allow
    licenseState.checked = true;
    if (!licenseState.plan) {
      licenseState.valid  = true;
      licenseState.plan   = "unknown";
      licenseState.reason = "validation-error";
    }
  }
}

// Check if this request is within rate limits (uses Redis counter)
export async function checkRateLimit() {
  const key   = process.env.LICENSE_KEY;
  const limit = licenseState.limits.requests_per_month;

  if (!key || limit < 0) return { allowed: true }; // dev mode or unlimited

  const month    = new Date().toISOString().slice(0, 7);
  const rKey     = USAGE_KEY(key, month);
  const current  = parseInt(await redis.get(rKey).catch(() => "0") || "0");

  return { allowed: current < limit, current, limit };
}

// Increment local Redis counter + async-report to global backend
export async function trackUsage(globalUrl) {
  const key      = process.env.LICENSE_KEY;
  const deviceId = process.env.DEVICE_ID || "unknown";
  if (!key) return;

  const month = new Date().toISOString().slice(0, 7);
  const rKey  = USAGE_KEY(key, month);
  try {
    await redis.incr(rKey);
    await redis.expire(rKey, USAGE_TTL);
  } catch (_) {}

  // Async report — don't await
  fetch(`${globalUrl}/licenses/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deviceId }),
  }).catch(e => console.error("[LICENSE] usage report failed:", e.message));
}

function generateDeviceId() {
  return `${os.hostname()}-${process.pid}`;
}
