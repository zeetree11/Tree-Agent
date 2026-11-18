/**
 * Interrupting a running task from chat.
 *
 * Before this existed, a task that went wrong could only be out-waited: the model loop owns the
 * thread, and there was no path from "user types 停" back into the running `pi` process. That is a
 * control problem, not a prompt problem — telling the model "you can be stopped" changes nothing,
 * because by the time it reads that line it is already the thing that needs stopping.
 *
 * The mechanism is deliberately narrow:
 *
 * - only the **same thread** can be stopped (a stop in group A must not kill a task in group B)
 * - a stop only affects **one** running task, the current one
 * - the signal is cooperative (the worker checks it between steps), so in-flight tool calls finish
 *
 * What it is not: a kill switch for the whole process. That would drop state for every conversation.
 */

export type RunningTask = {
  thread: string;
  taskId: string;
  startedAt: number;
  controller: AbortController;
};

export class InterruptRegistry {
  private readonly running = new Map<string, RunningTask>();

  /** Register a task as interruptible. Throws if the thread already has one — callers must serialise. */
  start(thread: string, taskId: string): RunningTask {
    if (this.running.has(thread)) {
      throw new Error(`线程 ${thread} 已有任务在跑（${this.running.get(thread)!.taskId}）`);
    }
    const entry: RunningTask = { thread, taskId, startedAt: Date.now(), controller: new AbortController() };
    this.running.set(thread, entry);
    return entry;
  }

  /** Ask the running task to stop. Returns false when there was nothing to stop. */
  abort(thread: string, reason = "用户要求停止"): boolean {
    const entry = this.running.get(thread);
    if (!entry) return false;
    entry.controller.abort(new Error(reason));
    return true;
  }

  /** Called on completion (success, failure or abort); must be called or the thread stays locked. */
  finish(thread: string): void {
    this.running.delete(thread);
  }

  current(thread: string): RunningTask | undefined {
    return this.running.get(thread);
  }

  /** For diagnostics: what is running right now, and for how long. */
  snapshot(): Array<{ thread: string; taskId: string; seconds: number }> {
    return [...this.running.values()].map((entry) => ({
      thread: entry.thread,
      taskId: entry.taskId,
      seconds: Math.round((Date.now() - entry.startedAt) / 1000),
    }));
  }
}

/**
 * Commands that mean "stop what you are doing".
 *
 * Kept short and exact on purpose: this is checked *before* the message becomes a task, so a false
 * positive throws away a real request. "别" alone is not enough (别忘了我明天要考…), so the patterns
 * require the word to stand near the start or to be a standalone phrase.
 */
const STOP_PATTERNS: RegExp[] = [
  /^(停|停下|停停|暂停|打住|住手|别做了|别写了|别搞了|不用了|算了|取消|cancel|stop)[\s!！。.~]*$/i,
  /^(先)?(停|暂停)(一下|下|吧|了)?[\s!！。.~]*$/i,
  /^(停|暂停|取消|stop)[\s,，]+(吧|一下|了)?[\s!！。.~]*$/i,
];

export function isStopCommand(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > 12) return false;
  return STOP_PATTERNS.some((pattern) => pattern.test(trimmed));
}
