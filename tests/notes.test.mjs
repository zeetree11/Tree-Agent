import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoteStore, arbitrate, retryPrompt, shouldRetry } from "../src/fanout.ts";

/**
 * Shared-note semantics: arbitration, retry policy, scope isolation.
 *
 * These outlived the fanout tool they were written for — orchestrate still reads the same note
 * store, so the guarantees are worth pinning down on their own.
 */

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

// ── 仲裁：多条便签给出同一个 key 的不同值时怎么办 ──────────────────────────
{
  const same = arbitrate([
    { scope: "s", key: "db", value: "Postgres", by: "a", createdAt: "2026-01-01T00:00:00Z" },
    { scope: "s", key: "db", value: "Postgres", by: "b", createdAt: "2026-01-01T00:01:00Z" },
  ]);
  check("agreement yields one value", same.resolved.length === 1 && same.conflicts.length === 0, JSON.stringify(same));

  const clash = arbitrate([
    { scope: "s", key: "db", value: "Postgres", by: "a", createdAt: "2026-01-01T00:00:00Z" },
    { scope: "s", key: "db", value: "MySQL", by: "b", createdAt: "2026-01-01T00:01:00Z" },
  ]);
  check("disagreement is reported", clash.conflicts.length === 1, JSON.stringify(clash.conflicts));
  check("last write wins", clash.conflicts[0]?.winner === "MySQL", JSON.stringify(clash.conflicts[0]));
  check("both values kept", clash.conflicts[0]?.values.length === 2, JSON.stringify(clash.conflicts[0]));

  const multi = arbitrate([
    { scope: "s", key: "a", value: "1", by: "x", createdAt: "2026-01-01T00:00:00Z" },
    { scope: "s", key: "b", value: "2", by: "x", createdAt: "2026-01-01T00:00:01Z" },
  ]);
  check("multiple keys resolved", multi.resolved.length === 2, JSON.stringify(multi.resolved));
}

// ── 重试策略：失败一次重试，两次放弃，成功永不重试 ────────────────────────
{
  check("failed once retries", shouldRetry("failed", 1) === true);
  check("failed twice stops", shouldRetry("failed", 2) === false);
  check("success never retries", shouldRetry("ok", 1) === false);
  check("retry prompt carries the reason", retryPrompt("做 A", "文件不存在").includes("文件不存在"));
}

// ── 便签存储：按 scope 隔离，读取有序 ────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-notes-"));
  const store = new NoteStore(dir);
  store.write("s1", "k1", "v1", "a");
  store.write("s1", "k2", "v2", "a");
  store.write("s2", "k1", "other", "a");
  check("writes are scoped", store.read("s1").length === 2 && store.read("s2").length === 1, JSON.stringify(store.read("s1")));
  check("reads are ordered", store.read("s1")[1].value === "v2", JSON.stringify(store.read("s1")));
  store.clear("s1");
  check("clear only affects its scope", store.read("s1").length === 0 && store.read("s2").length === 1);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
