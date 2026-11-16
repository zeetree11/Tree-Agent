import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildDigest, digestDue, formatDigest } from "../src/digest.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "pi-digest-"));
const db = new DatabaseSync(path.join(dir, "runtime.db"));
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// 最小 schema：只建 digest 实际会读的表
db.exec(`
  CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT, error TEXT, thread TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, created_at TEXT);
  CREATE TABLE usage (id INTEGER PRIMARY KEY, created_at TEXT, cost REAL, input INTEGER, output INTEGER, cache_read INTEGER);
  CREATE TABLE feedback_cases (id INTEGER PRIMARY KEY, correction TEXT, status TEXT);
  CREATE TABLE reminders (id INTEGER PRIMARY KEY, fired_at TEXT, text TEXT, due_at TEXT);
`);

// 3 个任务：2 完成 1 失败；延迟 1s / 3s / 5s
const insertTask = db.prepare("INSERT INTO tasks (id, status, created_at, updated_at, error, thread) VALUES (?,?,?,?,?,?)");
insertTask.run("t1", "done", iso(60), iso(59), null, "qq:group:1");
insertTask.run("t2", "done", iso(30), iso(27), null, "qq:group:1");
insertTask.run("t3", "failed", iso(20), iso(19), "模型超时", "qq:group:1");

const insertEvent = db.prepare("INSERT INTO events (type, created_at) VALUES (?,?)");
for (let i = 0; i < 4; i += 1) insertEvent.run("context_conflict", iso(10));
insertEvent.run("preference_violation", iso(5));

db.prepare("INSERT INTO usage (created_at, cost, input, output, cache_read) VALUES (?,?,?,?,?)").run(iso(10), 0.002, 100, 50, 900);
db.prepare("INSERT INTO feedback_cases (correction, status) VALUES (?,?)").run("不对，是 C++", "draft");
db.prepare("INSERT INTO reminders (fired_at, text, due_at) VALUES (?,?,?)").run(null, "跑一千米", iso(-60));

const digest = buildDigest(db, { days: 1 });
check("counts tasks", digest.tasks.total === 3 && digest.tasks.done === 2 && digest.tasks.failed === 1, JSON.stringify(digest.tasks));
check("p50 is a real duration", digest.tasks.p50ms >= 1_000, String(digest.tasks.p50ms));
check("p95 is larger than p50", digest.tasks.p95ms >= digest.tasks.p50ms);
check("counts conflicts", digest.problems.context_conflict === 4, String(digest.problems.context_conflict));
check("counts violations", digest.problems.preference_violation === 1);
check("cost summed", digest.cost.usd === 0.002, String(digest.cost.usd));
check("cache hit computed", digest.cost.cacheHitPct === 90, String(digest.cost.cacheHitPct));
check("waiting: feedback drafts", digest.waiting.feedbackDrafts === 1);
check("waiting: unsent reminders", digest.waiting.unsentReminders === 1);
check("carries latest feedback sample", digest.samples.latestFeedback?.includes("C++"), digest.samples.latestFeedback);
check("carries latest failure sample", digest.samples.latestFailure?.includes("模型超时"), digest.samples.latestFailure);

// 缺表时不能抛（旧库要能跑）
{
  const bare = new DatabaseSync(path.join(dir, "bare.db"));
  bare.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT)");
  const empty = buildDigest(bare, { days: 1 });
  check("missing tables do not throw", empty.tasks.total === 0 && empty.waiting.feedbackDrafts === 0, JSON.stringify(empty.waiting));
  bare.close();
}

// 渲染：短，且该出现的都出现
{
  const text = formatDigest(digest);
  check("renders task line", text.includes("任务 3"), text);
  check("renders problem line", text.includes("记忆冲突 4"), text);
  check("renders waiting line", text.includes("badcase 1"), text);
  check("is short", text.split("\n").length <= 8, String(text.split("\n").length));
}

// 发送时机：一天一次，且要在设定小时之后
{
  const at = (isoLocal) => new Date(isoLocal);
  check("due after hour", digestDue({ now: at("2026-11-16T14:30:00Z"), hour: 22, lastSentDay: null }) === true);
  check("not due before hour", digestDue({ now: at("2026-11-16T13:00:00Z"), hour: 22, lastSentDay: null }) === false);
  check("not due twice a day", digestDue({ now: at("2026-11-16T15:00:00Z"), hour: 22, lastSentDay: "2026-11-16" }) === false);
  check("due again next day", digestDue({ now: at("2026-11-17T15:00:00Z"), hour: 22, lastSentDay: "2026-11-16" }) === true);
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
