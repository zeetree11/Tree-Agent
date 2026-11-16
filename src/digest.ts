import { DatabaseSync } from "node:sqlite";

/**
 * The daily digest: what broke, what is waiting on a human, what it cost.
 *
 * Written as a plain function over a database handle rather than a command, because it has two
 * callers with different needs: `node src/cli.ts digest` for a look right now, and the serve loop
 * that pushes one line a day. Logs are not the problem — nobody reads logs proactively; the digest
 * is the smallest thing that can be *read* rather than *searched*.
 */
export type DigestOptions = { days?: number };

export type Digest = {
  windowDays: number;
  tasks: { total: number; done: number; failed: number; p50ms: number; p95ms: number };
  problems: {
    orchestrate_error: number;
    preference_violation: number;
    context_conflict: number;
    loop_abort: number;
    memory_blocked: number;
  };
  cost: { calls: number; usd: number; tokensIn: number; tokensOut: number; cacheHitPct: number };
  waiting: {
    feedbackDrafts: number;
    pendingProposals: number;
    pendingApprovals: number;
    unsentReminders: number;
  };
  samples: {
    latestFeedback?: string;
    latestFailure?: string;
    slowestTaskId?: string;
  };
};

/** Safe read helper: an old database may be missing a table a newer feature added. */
function tryAll(db: DatabaseSync, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function tryOne(db: DatabaseSync, sql: string, params: unknown[] = []): Record<string, unknown> {
  try {
    return (db.prepare(sql).get(...(params as never[])) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function buildDigest(db: DatabaseSync, options: DigestOptions = {}): Digest {
  const days = Math.max(1, options.days ?? 1);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const nowIso = new Date().toISOString();

  const tasks = tryAll(db, "SELECT id, status, created_at, updated_at FROM tasks WHERE created_at >= ?", [since]);
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed");
  const durations = tasks
    .map((task) => new Date(String(task.updated_at)).getTime() - new Date(String(task.created_at)).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const at = (p: number) => (durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * p))]) : 0);

  const count = (type: string) =>
    Number(tryOne(db, "SELECT COUNT(*) n FROM events WHERE type = ? AND created_at >= ?", [type, since]).n ?? 0);

  const usage = tryOne(
    db,
    "SELECT COUNT(*) n, COALESCE(SUM(cost),0) cost, COALESCE(SUM(input),0) inp, COALESCE(SUM(cache_read),0) cache, COALESCE(SUM(output),0) out FROM usage WHERE created_at >= ?",
    [since],
  );
  const cached = Number(usage.cache ?? 0);
  const input = Number(usage.inp ?? 0);
  const cacheHitPct = input + cached > 0 ? Number(((cached / (input + cached)) * 100).toFixed(1)) : 0;

  const latestFeedback = tryOne(db, "SELECT correction FROM feedback_cases WHERE status = 'draft' ORDER BY id DESC LIMIT 1");
  const latestFailure = tryOne(
    db,
    "SELECT id, error FROM tasks WHERE status = 'failed' AND created_at >= ? ORDER BY id DESC LIMIT 1",
    [since],
  );

  return {
    windowDays: days,
    tasks: { total: tasks.length, done, failed: failed.length, p50ms: at(0.5), p95ms: at(0.95) },
    problems: {
      orchestrate_error: count("orchestrate_error"),
      preference_violation: count("preference_violation"),
      context_conflict: count("context_conflict"),
      loop_abort: count("loop_abort"),
      memory_blocked: count("memory_blocked"),
    },
    cost: {
      calls: Number(usage.n ?? 0),
      usd: Number(Number(usage.cost ?? 0).toFixed(4)),
      tokensIn: input,
      tokensOut: Number(usage.out ?? 0),
      cacheHitPct,
    },
    waiting: {
      feedbackDrafts: Number(tryOne(db, "SELECT COUNT(*) n FROM feedback_cases WHERE status = 'draft'").n ?? 0),
      pendingProposals: Number(tryOne(db, "SELECT COUNT(*) n FROM proposals WHERE status = 'pending' AND expires_at > ?", [nowIso]).n ?? 0),
      pendingApprovals: Number(tryOne(db, "SELECT COUNT(*) n FROM approvals WHERE status = 'pending' AND expires_at > ?", [nowIso]).n ?? 0),
      unsentReminders: Number(tryOne(db, "SELECT COUNT(*) n FROM reminders WHERE fired_at IS NULL").n ?? 0),
    },
    samples: {
      latestFeedback: latestFeedback.correction ? String(latestFeedback.correction).slice(0, 40) : undefined,
      latestFailure: latestFailure.error ? `${String(latestFailure.id)}：${String(latestFailure.error).slice(0, 60)}` : undefined,
      slowestTaskId: durations.length ? String(tasks[tasks.length - 1]?.id ?? "") : undefined,
    },
  };
}

/** One-screen rendering. Deliberately short: a digest that needs scrolling is a log. */
export function formatDigest(digest: Digest): string {
  const lines = [
    `## 最近 ${digest.windowDays} 天`,
    `任务 ${digest.tasks.total}（完成 ${digest.tasks.done}，失败 ${digest.tasks.failed}）p50 ${digest.tasks.p50ms}ms / p95 ${digest.tasks.p95ms}ms`,
    `成本 ${digest.cost.calls} 次，$${digest.cost.usd}，cache ${digest.cost.cacheHitPct}%`,
  ];

  const problems: string[] = [];
  if (digest.problems.orchestrate_error) problems.push(`编排报错 ${digest.problems.orchestrate_error}`);
  if (digest.problems.preference_violation) problems.push(`偏好违规 ${digest.problems.preference_violation}`);
  if (digest.problems.context_conflict) problems.push(`记忆冲突 ${digest.problems.context_conflict}`);
  if (digest.problems.loop_abort) problems.push(`死循环 ${digest.problems.loop_abort}`);
  if (digest.problems.memory_blocked) problems.push(`凭据拦截 ${digest.problems.memory_blocked}`);
  lines.push(problems.length > 0 ? `问题 ${problems.join("｜")}` : "问题 无");

  const waiting: string[] = [];
  if (digest.waiting.feedbackDrafts) {
    waiting.push(`badcase ${digest.waiting.feedbackDrafts} 条${digest.samples.latestFeedback ? `（最新「${digest.samples.latestFeedback}」）` : ""}`);
  }
  if (digest.waiting.pendingProposals) waiting.push(`待批自改 ${digest.waiting.pendingProposals}`);
  if (digest.waiting.pendingApprovals) waiting.push(`待批调用 ${digest.waiting.pendingApprovals}`);
  if (digest.waiting.unsentReminders) waiting.push(`未触发提醒 ${digest.waiting.unsentReminders}`);
  if (waiting.length > 0) lines.push(`等你 ${waiting.join("｜")}`);

  if (digest.samples.latestFailure) lines.push(`最近失败 ${digest.samples.latestFailure}`);
  return lines.join("\n");
}

/**
 * Should the daily digest go out now?
 *
 * Kept pure so the "did it fire today" question can be tested without waiting for 22:00. The
 * caller stores `lastSentDay`; a missing value means "never", which counts as due.
 */
export function digestDue(input: {
  now: Date;
  hour: number;
  lastSentDay?: string | null;
  /** Local offset in minutes; +480 for Asia/Shanghai. */
  utcOffsetMinutes?: number;
}): boolean {
  const local = new Date(input.now.getTime() + (input.utcOffsetMinutes ?? 480) * 60_000);
  const day = local.toISOString().slice(0, 10);
  if (input.lastSentDay === day) return false;
  return local.getUTCHours() >= input.hour;
}
