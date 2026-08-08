const rateLimitCleanupDays = new WeakMap<object, string>();
const rateLimitCleanupTasks = new WeakMap<object, Promise<void>>();
const RATE_LIMIT_CLEANUP_SCOPE = "__maintenance__:rate-limit-retention";

async function pruneExpiredRateLimitBuckets(db: D1Database, nowSeconds: number): Promise<void> {
  const databaseKey = db as object;
  const currentDay = new Date(nowSeconds * 1_000).toISOString().slice(0, 10);
  if (rateLimitCleanupDays.get(databaseKey) === currentDay) {
    await rateLimitCleanupTasks.get(databaseKey);
    return;
  }

  rateLimitCleanupDays.set(databaseKey, currentDay);
  const retentionThreshold = nowSeconds - 86_400;
  const dayStartedAt = Math.floor(nowSeconds / 86_400) * 86_400;
  const updatedAt = new Date(nowSeconds * 1_000).toISOString();
  const task = db.prepare(
    `INSERT INTO classroom_rate_limits (scope_key, window_started_at, request_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       request_count = 1,
       updated_at = excluded.updated_at
     WHERE classroom_rate_limits.window_started_at < excluded.window_started_at
     RETURNING window_started_at`,
  ).bind(RATE_LIMIT_CLEANUP_SCOPE, dayStartedAt, updatedAt)
    .first<{ window_started_at: number }>()
    .then(async (claimed) => {
      if (!claimed) return;
      await db.prepare(
        "DELETE FROM classroom_rate_limits WHERE scope_key != ? AND window_started_at < ?",
      ).bind(RATE_LIMIT_CLEANUP_SCOPE, retentionThreshold).run();
    }).catch((error: unknown) => {
      console.warn("[classroom-rate-limit] Expired bucket cleanup failed.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }).finally(() => {
      rateLimitCleanupTasks.delete(databaseKey);
    });
  rateLimitCleanupTasks.set(databaseKey, task);
  await task;
}

export async function enforceClassroomRateLimitScope(
  db: D1Database,
  scopeKey: string,
  limit = 120,
  windowSeconds = 60,
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const threshold = nowSeconds - windowSeconds;
  await pruneExpiredRateLimitBuckets(db, nowSeconds);
  const row = await db.prepare(
    `INSERT INTO classroom_rate_limits (scope_key, window_started_at, request_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       window_started_at = CASE WHEN classroom_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE classroom_rate_limits.window_started_at END,
       request_count = CASE WHEN classroom_rate_limits.window_started_at <= ? THEN 1 ELSE classroom_rate_limits.request_count + 1 END,
       updated_at = excluded.updated_at
     RETURNING request_count`,
  ).bind(scopeKey, nowSeconds, new Date().toISOString(), threshold, threshold).first<{ request_count: number }>();
  return Boolean(row && row.request_count <= limit);
}

export async function enforceClassroomMutationRateLimit(
  db: D1Database,
  actor: { id: string },
  normalizedScope: string,
  limit = 120,
  windowSeconds = 60,
): Promise<boolean> {
  return enforceClassroomRateLimitScope(db, `${actor.id}:${normalizedScope.slice(0, 120)}`, limit, windowSeconds);
}
