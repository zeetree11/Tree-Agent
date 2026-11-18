import { InterruptRegistry, isStopCommand } from "../src/interrupt.ts";

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

// ── 停止指令识别 ────────────────────────────────────────────────────────────
{
  const yes = ["停", "停下", "暂停", "停一下", "别做了", "取消", "stop", "停！", "算了", "打住"];
  for (const text of yes) check(`识别停止：${text}`, isStopCommand(text) === true, text);

  // 误判比漏判更贵：这些是正常请求，绝不能被当成停止
  const no = [
    "别忘了我明天要考试",
    "停下来想想这个方案哪里不对",
    "取消订单的接口怎么写",
    "帮我暂停一下这个项目再继续",
    "stop 这个词在这里是什么意思",
  ];
  for (const text of no) check(`不误判：${text.slice(0, 12)}`, isStopCommand(text) === false, text);
  check("空文本不是指令", isStopCommand("") === false);
}

// ── 注册表 ──────────────────────────────────────────────────────────────────
{
  const registry = new InterruptRegistry();
  const entry = registry.start("qq:group:1", "t1");
  check("登记后可查到", registry.current("qq:group:1")?.taskId === "t1");
  check("初始未中断", entry.controller.signal.aborted === false);

  // 同线程重复登记必须失败：否则两个任务会抢同一个中止信号
  let threw = false;
  try {
    registry.start("qq:group:1", "t2");
  } catch {
    threw = true;
  }
  check("同线程不允许并发登记", threw);

  // 中断
  check("中断返回 true", registry.abort("qq:group:1") === true);
  check("信号已触发", entry.controller.signal.aborted === true);

  // 没登记的线程不能中断（跨群隔离）
  check("别的群不受影响", registry.abort("qq:group:2") === false);

  // 结束后释放
  registry.finish("qq:group:1");
  check("结束后查不到", registry.current("qq:group:1") === undefined);
  check("结束后可再次登记", (() => {
    try {
      registry.start("qq:group:1", "t3");
      return true;
    } catch {
      return false;
    }
  })());

  // 快照用于诊断
  const snapshot = registry.snapshot();
  check("快照包含正在跑的任务", snapshot.length === 1 && snapshot[0].taskId === "t3", JSON.stringify(snapshot));
  check("快照带时长", typeof snapshot[0].seconds === "number");

  registry.finish("qq:group:1");
  check("全部释放后快照为空", registry.snapshot().length === 0);
}

// ── 中断原因会被带进信号 ────────────────────────────────────────────────────
{
  const registry = new InterruptRegistry();
  const entry = registry.start("feishu:oc_1", "t9");
  registry.abort("feishu:oc_1", "用户说停");
  check("信号里带原因", entry.controller.signal.reason?.message === "用户说停", String(entry.controller.signal.reason));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
