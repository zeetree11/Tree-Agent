# 异步编排（async orchestrate）

## 问题

`orchestrate` 是同步工具调用：模型发起后必须等 tool_result，才能说下一句话。
子任务跑几分钟，这期间模型被挂起，用户看到的是"死了一样"——**不是它不想回，是协议上没有输出位置**。

三重阻塞：

```
模型挂起（等 tool_result）
  + handler await runTask()
  + busy 集合挡住同会话新消息
```

## 目标行为

```
你：调研三个方向
它：已派发 3 个子任务（A/B/C），预计 2 分钟，跑完汇报   ← 立即
你：（可以继续说话，不再 busy）
它：A 结论… B 结论… C 结论…（汇总）                    ← 完成时主动推送
```

## 设计

### 1. 派发即返回

`orchestrate` 工具改为：

```
入参: goal, count
行为: 建一个 orchestration 记录（DB 表），启动后台执行，立即返回 runId + 预计任务数
返回给模型: "已派发 3 个子任务（runId=xxx），完成后会主动汇报；不要现在编结论。"
```

模型这一轮立刻答完，**会话不再 busy**。

### 2. 运行态入库（要能跨重启）

新表：

```sql
CREATE TABLE orchestrations (
  id           TEXT PRIMARY KEY,      -- runId
  thread       TEXT NOT NULL,         -- 汇报回哪个会话
  channel      TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL,         -- running | done | failed | stopped
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  summary      TEXT,                  -- 完成后的 digest
  error        TEXT
);
```

**为什么入库**：进程重启后要能继续汇报，否则"派发了但永远不汇报"比同步更糟。

### 3. 后台执行器

```
runOrchestration(runId) →
  读记录 → orchestrate(...)（复用现有同步实现）
  子任务事件写 events（type=orchestration_*）
  完成 → 写回 summary/status → 触发汇报
```

**并发上限**：全局同时最多 1 个编排（和现在的 `isRunning()` 一致），超出的排队并在汇报里说明。

### 4. 汇报通道

完成时：

```
发一条 send（owner 会话）：摘要前 N 字 + "完整结果：cli trace <taskId>"
可选：起一个"汇总任务"，让模型基于子任务结果写一段话（而不是直接贴 digest）
```

**推荐后者**：digest 是机器拼的，读起来硬；让模型复述一遍更像人。

### 5. 停止与超时

```
orchestrations.status = stopped：
  · 用户对同一会话说"停" → 中断该 run
  · 超过 PI_RT_ORCHESTRATE_MAX_MS（默认 15 分钟）→ 标 failed 并汇报"超时"
```

## 验收

```
① 派发后 2 秒内收到回执
② 派发后用户能立刻发新消息并得到回应（不再 busy）
③ 子任务完成后收到汇总（进程重启也要能收到）
④ 同时只跑一个编排，第二个排队并告知
⑤ "停"能中断正在跑的编排
```

## 不做

```
· 不做到"子任务进度实时流式推送"（成本高、噪音大）
· 不做多用户并发编排（单用户场景）
```

## 迁移

`orchestrate` 保留同步模式一个版本（`PI_RT_ORCHESTRATE_ASYNC=0` 回滚），
默认异步；等验收通过再删同步路径。
