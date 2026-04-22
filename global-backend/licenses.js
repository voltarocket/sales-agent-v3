import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://sales:sales_pass@localhost:5432/sales_agent",
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on("error", (e) => console.error("[Licenses DB] idle error:", e.message));

const PLANS = {
  basic:      { max_devices: 1,  requests_per_month: 100  },
  pro:        { max_devices: 5,  requests_per_month: 1000 },
  enterprise: { max_devices: -1, requests_per_month: -1   }, // unlimited
};

// ─── Plan management ───────────────────────────────────────
export async function getPlans() {
  const { rows } = await pool.query("SELECT * FROM license_plans ORDER BY requests_per_month");
  return rows;
}

export async function createPlan({ name, display_name = "", max_devices = 1, requests_per_month = 100, description = "" }) {
  if (!name) throw new Error("name required");
  const { rows: [plan] } = await pool.query(
    `INSERT INTO license_plans (name, display_name, max_devices, requests_per_month, description)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name.toLowerCase(), display_name, max_devices, requests_per_month, description]
  );
  return plan;
}

export async function updatePlan(name, fields) {
  const allowed = ["display_name", "max_devices", "requests_per_month", "description"];
  const parts = []; const vals = []; let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    parts.push(`${k}=$${idx++}`); vals.push(v);
  }
  if (!parts.length) throw new Error("No valid fields");
  vals.push(name);
  const { rows: [plan] } = await pool.query(
    `UPDATE license_plans SET ${parts.join(", ")} WHERE name=$${idx} RETURNING *`, vals
  );
  if (!plan) throw new Error("Plan not found");
  return plan;
}

export async function deletePlan(name) {
  await pool.query("DELETE FROM license_plans WHERE name=$1", [name]);
}

// ─── License listing (admin) ───────────────────────────────
export async function listLicenses() {
  const month = new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(`
    SELECT l.*,
           COALESCE(lu.requests, 0) AS used_this_month,
           COUNT(DISTINCT ld.device_id)::int AS active_devices
    FROM licenses l
    LEFT JOIN license_usage  lu ON lu.license_key = l.key AND lu.month = $1
    LEFT JOIN license_devices ld ON ld.license_key = l.key
    GROUP BY l.key, lu.requests
    ORDER BY l.created_at DESC`, [month]);
  return rows;
}

// ─── Issue ─────────────────────────────────────────────────
export async function issueLicense({ customer = "", plan = "basic", expires_at = null } = {}) {
  // Fetch limits from DB, fall back to hardcoded defaults
  const { rows: [dbPlan] } = await pool.query(
    "SELECT * FROM license_plans WHERE name=$1", [plan]
  ).catch(() => ({ rows: [] }));
  const limits = dbPlan || PLANS[plan] || PLANS.basic;
  const key = "SALES-" + crypto.randomBytes(16).toString("hex").toUpperCase();

  const { rows: [license] } = await pool.query(
    `INSERT INTO licenses (key, customer, plan, max_devices, requests_per_month, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [key, customer, plan, limits.max_devices, limits.requests_per_month, expires_at]
  );
  return license;
}

export async function validateLicense({ key, deviceId }) {
  const { rows: [license] } = await pool.query(
    "SELECT * FROM licenses WHERE key=$1 AND is_active=true",
    [key]
  );

  if (!license) return { valid: false, reason: "License not found or inactive" };

  if (license.expires_at && new Date(license.expires_at) < new Date())
    return { valid: false, reason: "License expired" };

  // Register / refresh device
  if (deviceId) {
    await pool.query(
      `INSERT INTO license_devices (license_key, device_id)
       VALUES ($1, $2)
       ON CONFLICT (license_key, device_id) DO UPDATE SET last_seen=NOW()`,
      [key, deviceId]
    );

    // Enforce device limit
    if (license.max_devices > 0) {
      const { rows: [{ count }] } = await pool.query(
        "SELECT COUNT(*) FROM license_devices WHERE license_key=$1",
        [key]
      );
      if (parseInt(count) > license.max_devices) {
        // Remove the just-registered device if it pushed us over
        await pool.query(
          "DELETE FROM license_devices WHERE license_key=$1 AND device_id=$2",
          [key, deviceId]
        );
        return { valid: false, reason: `Device limit reached (max ${license.max_devices})` };
      }
    }
  }

  // Current month usage
  const month = new Date().toISOString().slice(0, 7);
  const { rows: [usage] } = await pool.query(
    "SELECT requests FROM license_usage WHERE license_key=$1 AND month=$2",
    [key, month]
  );
  const used = usage?.requests || 0;

  return {
    valid: true,
    key,
    customer: license.customer,
    plan: license.plan,
    max_devices: license.max_devices,
    requests_per_month: license.requests_per_month,
    expires_at: license.expires_at,
    usage: { month, used, limit: license.requests_per_month },
  };
}

export async function recordUsage({ key, deviceId = "unknown" }) {
  const month = new Date().toISOString().slice(0, 7);
  await pool.query(
    `INSERT INTO license_usage (license_key, device_id, month, requests)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (license_key, month) DO UPDATE SET requests = license_usage.requests + 1`,
    [key, deviceId, month]
  );
}

export async function updateLicense(key, fields) {
  const allowed = ["plan", "max_devices", "requests_per_month", "expires_at", "customer", "is_active"];
  const updates = [];
  const vals    = [];
  let idx = 1;

  // If plan is changing, apply preset limits unless overridden
  if (fields.plan && !fields.max_devices && !fields.requests_per_month) {
    const limits = PLANS[fields.plan];
    if (limits) {
      fields.max_devices        = limits.max_devices;
      fields.requests_per_month = limits.requests_per_month;
    }
  }

  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    updates.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  if (!updates.length) throw new Error("No valid fields to update");
  vals.push(key);
  const { rows: [license] } = await pool.query(
    `UPDATE licenses SET ${updates.join(", ")} WHERE key=$${idx} RETURNING *`,
    vals
  );
  if (!license) throw new Error("License not found");
  return license;
}

export async function revokeLicense(key) {
  await pool.query("UPDATE licenses SET is_active=false WHERE key=$1", [key]);
}

export async function getLicenseStatus(key) {
  const { rows: [license] } = await pool.query(
    "SELECT * FROM licenses WHERE key=$1",
    [key]
  );
  if (!license) return null;

  const month = new Date().toISOString().slice(0, 7);
  const { rows: devices } = await pool.query(
    "SELECT device_id, last_seen FROM license_devices WHERE license_key=$1 ORDER BY last_seen DESC",
    [key]
  );
  const { rows: [usage] } = await pool.query(
    "SELECT requests FROM license_usage WHERE license_key=$1 AND month=$2",
    [key, month]
  );

  return {
    ...license,
    devices,
    usage: { month, used: usage?.requests || 0 },
  };
}

export async function waitForDb(retries = 10, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try { await pool.query("SELECT 1"); console.log("[Licenses DB] connected ✓"); return; }
    catch (e) { console.log(`[Licenses DB] waiting... (${i}/${retries})`); await new Promise(r => setTimeout(r, delayMs)); }
  }
  throw new Error("[Licenses DB] Could not connect to PostgreSQL");
}
