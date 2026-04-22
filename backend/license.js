import os from "os";
import fetch from "node-fetch";
import { redis } from "./redis.js";

const CACHE_KEY = "license:status";
const CACHE_TTL = 3600;
const USAGE_KEY = (key, month) => `usage:${key}:${month}`;
const USAGE_TTL = 60 * 60 * 24 * 35;

export const licenseState = {
  checked:  false,
  valid:    false,
  plan:     null,
  reason:   null,
  key:      null,
  limits:   { requests_per_month: -1, max_devices: -1 },
  usage:    { used: 0, month: null },
  expires_at: null,
  customer: null,
};

// Read persisted key from settings table (fallback when env var not set)
async function getStoredKey(queryFn) {
  try {
    const { rows } = await queryFn(
      "SELECT value FROM settings WHERE key='license_key'", []
    );
    return rows[0]?.value || null;
  } catch (_) { return null; }
}

export async function initLicense(globalUrl, queryFn) {
  const envKey   = process.env.LICENSE_KEY;
  const dbKey    = envKey ? null : await getStoredKey(queryFn);
  const key      = envKey || dbKey;
  const deviceId = process.env.DEVICE_ID || generateDeviceId();

  if (!key) {
    console.log("[LICENSE] No key configured — dev mode (unlicensed)");
    licenseState.checked = true;
    licenseState.valid   = true;
    licenseState.plan    = "dev";
    return;
  }

  licenseState.key = key;

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
      key,
      valid:      data.valid      ?? false,
      plan:       data.plan       ?? null,
      reason:     data.reason     ?? null,
      customer:   data.customer   ?? null,
      expires_at: data.expires_at ?? null,
      limits:     { requests_per_month: data.requests_per_month ?? -1, max_devices: data.max_devices ?? -1 },
      usage:      data.usage      ?? { used: 0, month: null },
    };
    Object.assign(licenseState, { checked: true, ...update });

    try { await redis.set(CACHE_KEY, JSON.stringify(update), "EX", CACHE_TTL); } catch (_) {}

    if (data.valid)
      console.log(`[LICENSE] valid — plan=${data.plan} usage=${data.usage?.used}/${data.requests_per_month}`);
    else
      console.warn(`[LICENSE] invalid — ${data.reason}`);
  } catch (e) {
    console.error("[LICENSE] validation failed:", e.message);
    licenseState.checked = true;
    if (!licenseState.plan) {
      licenseState.valid  = true;
      licenseState.plan   = "unknown";
      licenseState.reason = "validation-error";
    }
  }
}

// Activate a new key: validate → persist to DB → refresh state
export async function activateLicense(globalUrl, key, queryFn) {
  const deviceId = process.env.DEVICE_ID || generateDeviceId();

  // Validate first
  const r = await fetch(`${globalUrl}/licenses/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deviceId }),
    timeout: 10000,
  });
  const data = await r.json();

  if (!data.valid) throw new Error(data.reason || "Invalid license key");

  // Persist to settings table
  await queryFn(
    `INSERT INTO settings (key, value) VALUES ('license_key', $1)
     ON CONFLICT (key) DO UPDATE SET value=$1`,
    [key]
  );

  // Clear Redis cache so next call re-validates
  try { await redis.del(CACHE_KEY); } catch (_) {}

  // Update in-memory state
  const update = {
    key,
    valid:      true,
    plan:       data.plan       ?? null,
    reason:     null,
    customer:   data.customer   ?? null,
    expires_at: data.expires_at ?? null,
    limits:     { requests_per_month: data.requests_per_month ?? -1, max_devices: data.max_devices ?? -1 },
    usage:      data.usage      ?? { used: 0, month: null },
  };
  Object.assign(licenseState, { checked: true, ...update });

  return update;
}

export async function checkRateLimit() {
  // Dev mode — no restrictions
  if (licenseState.plan === "dev") return { allowed: true };

  // License checked and invalid — block
  if (licenseState.checked && !licenseState.valid) {
    return { allowed: false, reason: licenseState.reason || "license invalid" };
  }

  const key   = licenseState.key || process.env.LICENSE_KEY;
  const limit = licenseState.limits.requests_per_month;
  if (!key || limit < 0) return { allowed: true };

  const month   = new Date().toISOString().slice(0, 7);
  const current = parseInt(await redis.get(USAGE_KEY(key, month)).catch(() => "0") || "0");
  return { allowed: current < limit, current, limit };
}

export async function trackUsage(globalUrl) {
  const key      = licenseState.key || process.env.LICENSE_KEY;
  const deviceId = process.env.DEVICE_ID || "unknown";
  if (!key) return;

  const month = new Date().toISOString().slice(0, 7);
  const rKey  = USAGE_KEY(key, month);
  try { await redis.incr(rKey); await redis.expire(rKey, USAGE_TTL); } catch (_) {}

  fetch(`${globalUrl}/licenses/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deviceId }),
  }).catch(e => console.error("[LICENSE] usage report failed:", e.message));
}

function generateDeviceId() {
  return `${os.hostname()}-${process.pid}`;
}
