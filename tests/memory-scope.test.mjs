import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore, scopeThreadFor } from "../src/memory.ts";

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

// 1) 策略函数本身
{
  check("preference is global", scopeThreadFor("preference", "qq:group:1") === null, String(scopeThreadFor("preference", "qq:group:1")));
  check("fact is global", scopeThreadFor("fact", "feishu:oc_1") === null);
  check("event keeps its thread", scopeThreadFor("event", "qq:group:1") === "qq:group:1", String(scopeThreadFor("event", "qq:group:1")));
  check("event without thread stays null", scopeThreadFor("event", null) === null);
}

const dir = mkdtempSync(path.join(tmpdir(), "pi-scope-"));
const store = new MemoryStore(dir, "Rick");

// 2) 写在 A 群，B 群也能看到（偏好/事实）
store.apply({
  action: "create",
  category: "preference",
  key: "pref.lang",
  content: "以后都用 C++ 写",
  importance: 3,
  thread: "qq:group:A",
});
store.apply({
  action: "create",
  category: "fact",
  key: "user.city",
  content: "住在成都",
  importance: 3,
  thread: "qq:group:A",
});

// 3) 事件留在原线程
store.apply({
  action: "create",
  category: "event",
  key: "event.flight",
  content: "周五飞深圳",
  importance: 3,
  thread: "qq:group:A",
});

const fromB = store.contextBlock(4_000, "qq:group:B");
check("preference visible in another group", fromB.text.includes("C++"), fromB.text.slice(0, 120));
check("fact visible in another group", fromB.text.includes("成都"), fromB.text.slice(0, 120));
check("event stays local", !fromB.text.includes("深圳"), fromB.text.slice(0, 200));

const fromA = store.contextBlock(4_000, "qq:group:A");
check("event visible where it happened", fromA.text.includes("深圳"), fromA.text.slice(0, 200));

// 4) 落库的 thread 字段符合策略
const rows = store.list(undefined, true);
const pref = rows.find((row) => row.key === "pref.lang");
const evt = rows.find((row) => row.key === "event.flight");
check("preference stored with null thread", pref?.thread === null, String(pref?.thread));
check("event stored with its thread", evt?.thread === "qq:group:A", String(evt?.thread));

// 5) 旧数据迁移：带 thread 的偏好/事实被提为全局
{
  const migDir = mkdtempSync(path.join(tmpdir(), "pi-scope-mig-"));
  const first = new MemoryStore(migDir, "Rick");
  first.apply({
    action: "create",
    category: "preference",
    key: "legacy.pref",
    content: "喜欢 python",
    importance: 3,
    thread: "qq:group:OLD",
  });
  // 直接改成旧的形态（模拟策略上线前的数据）
  const raw = first["db"];
  raw.prepare("UPDATE memories SET thread = ? WHERE key = ?").run("qq:group:OLD", "legacy.pref");
  first.close();

  const reopened = new MemoryStore(migDir, "Rick");
  const migrated = reopened.list(undefined, true).find((row) => row.key === "legacy.pref");
  check("legacy preference migrated to global", migrated?.thread === null, String(migrated?.thread));
  check("migrated memory is visible elsewhere", reopened.contextBlock(1_800, "qq:group:NEW").text.includes("python"));
  reopened.close();
  try { rmSync(migDir, { recursive: true, force: true }); } catch { /* Windows handle */ }
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
