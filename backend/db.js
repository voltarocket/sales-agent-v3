import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    "postgresql://sales:sales_pass@localhost:5432/sales_agent",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("[DB] idle client error:", err.message));

export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Wait for DB to be ready (used at startup)
export async function waitForDb(retries = 10, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[DB] PostgreSQL connected ✓");
      return;
    } catch (e) {
      console.log(`[DB] waiting for PostgreSQL... (${i}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error("[DB] Could not connect to PostgreSQL");
}
