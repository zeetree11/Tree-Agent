#!/usr/bin/env node
/**
 * Daily digest: what happened, what broke, what is waiting on a human.
 *
 * The point is not more logging — we already write events and spans. The point is that nobody
 * reads a log proactively. A digest answers the three questions a person actually asks:
 *
 *   1. 有什么坏了？（失败任务、编排报错、偏好违规、冲突）
 *   2. 有什么等我？（待审 badcase、待批自改、即将到期的提醒）
 *   3. 花了多少？（token、成本、缓存命中、延迟分位）
 *
 * Usage: node scripts/digest.mjs [--db /data/runtime.db] [--days 1] [--json]
 */
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DB = flag("db", process.env.PI_RT_DB ?? "/data/runtime.db");
const DAYS = Number(flag("days", "1")) || 1;
const AS_JSON = args.includes("--json");

const db = new DatabaseSync(DB, { readOnly: true });
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

const one = (sql, params = []) => {
  try {
    return db.prepare(sql).get(...params) ?? {};
  } catch {
    return {};
  }
};
const all = (sql, params = []) => {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
};

// ── 任务与延迟 ────────────────────────────────────────────────────────────────
const tasks = all("SELECT status, created_at, updated_at, error FROM tasks WHERE created_at >= ?", [since]);
const done = tasks.filter((task) => task.status === "done").length;
const failed = tasks.filter((task) => task.status === "failed");
const durations = tasks
  .filter((task) => task.updated_at && task.created_at)
  .map((task) => new Date(task.updated_at) - new Date(task.created_at))
  .filter((ms) => ms >= 0)
  .sort((a, b) => a - b);
const percentile = (p) => (durations.length ? Math.round(durations[Math.floor(durations.length * p)]) : 0);

// ── 出问题的地方 ──────────────────────────────────────────────────────────────
const countOf = (type) => Number(one("SELECT COUNT(*) n FROM events WHERE type = ? AND created_at >= ?", [type, since]).n ?? 0);
const failures = {
  task_failed: failed.length,
  orchestrate_error: countOf("orchestrate_error"),
  preference_violation: countOf("preference_violation"),
  context_conflict: countOf("context_conflict"),
  loop_abort: countOf("loop_abort"),
  memory_blocked: countOf("memory_blocked"),
};
const recentFailures = all(
  "SELECT id, thread, error FROM tasks WHERE status = 'failed' AND created_at >= ? ORDER BY id DESC LIMIT 5",
  [since],
);

// ── 等人处理的事 ──────────────────────────────────────────────────────────────
const feedbackDrafts = all("SELECT id, correction FROM feedback_cases WHERE status = 'draft' ORDER BY id DESC LIMIT 5");
const pendingProposals = all("SELECT id, path, rationale FROM proposals WHERE status = 'pending' AND expires_at > ?", [new Date().toISOString()]);
const dueReminders = all("SELECT id, chat_id, text, due_at FROM reminders WHERE fired_at IS NULL ORDER BY due_at LIMIT 5");
const approvals = all("SELECT id, action FROM approvals WHERE status = 'pending' AND expires_at > ?", [new Date().toISOString()]);

// ── 成本 ──────────────────────────────────────────────────────────────────────
const usage = one(
  "SELECT COUNT(*) n, ROUND(SUM(cost), 4) cost, SUM(input) inp, SUM(cache_read) cache, SUM(output) out FROM usage WHERE created_at >= ?",
  [since],
);
const cacheHit = usage.inp + usage.cache > 0 ? (usage.cache / (usage.inp + usage.cache)) * 100 : 0;

const digest = {
  window: `${DAYS} 天`,
  tasks: { total: tasks.length, done, failed: failed.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95) },
  problems: failures,
  cost: {
    calls: Number(usage.n ?? 0),
    usd: Number(usage.cost ?? 0),
    tokens_in: Number(usage.inp ?? 0),
    tokens_out: Number(usage.out ?? 0),
    cache_hit_pct: Number(cacheHit.toFixed(1)),
  },
  waiting_on_you: {
    feedback_drafts: feedbackDrafts.length,
    pending_proposals: pendingProposals.length,
    pending_approvals: approvals.length,
    unsent_reminders: dueReminders.length,
  },
  samples: { recentFailures, feedbackDrafts, pendingProposals, dueReminders, approvals },
};

if (AS_JSON) {
  console.log(JSON.stringify(digest, null, 2));
  process.exit(0);
}

const pct = (value) => `${value}%`;
const lines = [
  `## 最近 ${digest.window} 的情况`,
  "",
  `任务   ${digest.tasks.total} 条：完成 ${done}，失败 ${failed.length}｜p50 ${digest.tasks.p50_ms}ms，p95 ${digest.tasks.p95_ms}ms`,
  `成本   ${digest.cost.calls} 次调用，$${digest.cost.usd}｜cache 命中 ${pct(digest.cost.cache_hit_pct)}`,
  `问题   编排报错 ${failures.orchestrate_error}｜偏好违规 ${failures.preference_violation}｜冲突 ${failures.context_conflict}｜死循环 ${failures.loop_abort}｜凭据拦截 ${failures.memory_blocked}`,
  "",
  `### 等你处理`,
  `- badcase 草稿 ${digest.waiting_on_you.feedback_drafts} 条${feedbackDrafts[0] ? `（最新：#${feedbackDrafts[0].id}「${String(feedbackDrafts[0].correction).slice(0, 30)}」）` : ""}`,
  `- 待批自改 ${digest.waiting_on_you.pending_proposals} 条${pendingProposals[0] ? `（#${pendingProposals[0].id} ${pendingProposals[0].path}）` : ""}`,
  `- 待批工具调用 ${digest.waiting_on_you.pending_approvals} 条`,
  `- 待触发提醒 ${digest.waiting_on_you.unsent_reminders} 条${dueReminders[0] ? `（${dueReminders[0].due_at} ${String(dueReminders[0].text).slice(0, 20)}）` : ""}`,
];

if (recentFailures.length > 0) {
  lines.push("", "### 最近的失败");
  for (const item of recentFailures) {
    lines.push(`- ${item.id} @ ${item.thread}：${String(item.error ?? "未知").slice(0, 80)}`);
  }
}
console.log(lines.join("\n"));
