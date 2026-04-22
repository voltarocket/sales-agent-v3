import Redis from "ioredis";

export const redis = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  { lazyConnect: true, maxRetriesPerRequest: 3 }
);

redis.on("connect",  () => console.log("[Redis] connected ✓"));
redis.on("error",    (e) => console.error("[Redis] error:", e.message));

export async function setJob(jobId, status, data = null) {
  await redis.set(
    `job:${jobId}`,
    JSON.stringify({ status, data, updatedAt: Date.now() }),
    "EX", 3600
  );
}

export async function getJob(jobId) {
  const val = await redis.get(`job:${jobId}`);
  return val ? JSON.parse(val) : null;
}

export async function deleteJob(jobId) {
  await redis.del(`job:${jobId}`);
}
