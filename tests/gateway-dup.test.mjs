import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db.ts";
import { Members } from "../src/members.ts";
import { ingest } from "../src/gateway.ts";

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

const dir = mkdtempSync(path.join(tmpdir(), "pi-dup-"));
const store = new Store(path.join(dir, "runtime.db"));
const members = new Members(dir);
const deps = { store, members, ownerName: "Rick" };

const msg = (overrides = {}) => ({
  channel: "qq",
  chatId: "group:1049765710",
  chatType: "group",
  externalId: "u1",
  displayName: "我睡啦睡啦",
  text: "奶龙",
  messageId: "1001",
  addressed: true,
  ...overrides,
});

// 1) 第一条正常入库
{
  const first = ingest(deps, msg({ messageId: "1001" }));
  check("first message creates an event", first.eventId > 0 && !first.duplicate, JSON.stringify(first));
}

// 2) 同一个 message id 再来：传输层去重挡掉
{
  const again = ingest(deps, msg({ messageId: "1001" }));
  check("same message id is rejected", again.duplicate === true, JSON.stringify(again));
}

// 3) 换了 message id 但内容一样（11 秒内的真实故障形态）：内容层挡掉
{
  const resent = ingest(deps, msg({ messageId: "2002" }));
  check("same text under a new id is rejected", resent.duplicate === true, JSON.stringify(resent));
}

// 4) 不同内容不受影响
{
  const other = ingest(deps, msg({ messageId: "3003", text: "奶龙说规矩要先立住了" }));
  check("different text still goes through", other.eventId > 0 && !other.duplicate, JSON.stringify(other));
}

// 5) 同一个人换个群，同样的字应该照常处理
{
  const otherGroup = ingest(deps, msg({ chatId: "group:999", messageId: "4004" }));
  check("same text in another chat is not a duplicate", otherGroup.eventId > 0, JSON.stringify(otherGroup));
}

// 6) 不同人发同样的话也不该互相挡
{
  const otherPerson = ingest(deps, msg({ externalId: "u2", displayName: "别人", messageId: "5005" }));
  check("another speaker is not a duplicate", otherPerson.eventId > 0, JSON.stringify(otherPerson));
}

// 7) 窗口外的重复应放行（把时间往前挪 60 秒）
{
  // 窗口判断依赖 created_at，这里用一个新的 Store 模拟"时间已经过去"：
  // 直接构造一个早已存在的同文本事件不方便，所以验证窗口为 1 秒时的放行行为
  process.env.PI_RT_DUP_WINDOW_S = "1";
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const later = ingest(deps, msg({ messageId: "6006" }));
  delete process.env.PI_RT_DUP_WINDOW_S;
  check("outside the window a repeat is allowed", later.eventId > 0, JSON.stringify(later));
}

// 8) 关闭开关（窗口 0）时行为回到旧样
{
  process.env.PI_RT_DUP_WINDOW_S = "0";
  const later2 = ingest(deps, msg({ messageId: "7007" }));
  delete process.env.PI_RT_DUP_WINDOW_S;
  check("window 0 disables content dedupe", later2.eventId > 0, JSON.stringify(later2));
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
