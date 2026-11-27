/**
 * Async orchestration records.
 *
 * The point of this table is survivability: once `orchestrate` returns immediately, the only thing
 * tying a background run to the conversation it owes a report to is this row. If it lived in memory,
 * a restart would silently orphan the work — the user would be told "已派发" and never hear back,
 * which is worse than the synchronous blocking we are replacing.
 */
import { DatabaseSync } from "node:sqlite";

export type OrchestrationStatus = "running" | "done" | "failed" | "stopped";

export type OrchestrationRow = {
  id: string;
  thread: string;
  channel: string;
  chat_id: string;
  goal: string;
  status: OrchestrationStatus;
  created_at: string;
  updated_at: string;
  summary: string | null;
  error: string | null;
};

export class OrchestrationStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrations (
        id          TEXT PRIMARY KEY,
        thread      TEXT NOT NULL,
        channel     TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        goal        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        summary     TEXT,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orch_status ON orchestrations(status);
    `);
  }

  create(input: { id: string; thread: string; channel: string; chatId: string; goal: string }): OrchestrationRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO orchestrations (id, thread, channel, chat_id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,'running',?,?)",
      )
      .run(input.id, input.thread, input.channel, input.chatId, input.goal.slice(0, 2_000), now, now);
    return this.get(input.id)!;
  }

  get(id: string): OrchestrationRow | undefined {
    return this.db.prepare("SELECT * FROM orchestrations WHERE id = ?").get(id) as OrchestrationRow | undefined;
  }

  /** Only running rows can be finished — a late duplicate completion must not overwrite a stop. */
  finish(id: string, status: Exclude<OrchestrationStatus, "running">, patch: { summary?: string; error?: string } = {}): boolean {
    const result = this.db
      .prepare(
        "UPDATE orchestrations SET status = ?, summary = COALESCE(?, summary), error = COALESCE(?, error), updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(status, patch.summary ?? null, patch.error ?? null, new Date().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** Runs that were left `running` by a crash; the caller decides whether to resume or report failure. */
  unfinished(): OrchestrationRow[] {
    return this.db.prepare("SELECT * FROM orchestrations WHERE status = 'running' ORDER BY created_at").all() as OrchestrationRow[];
  }

  /** Is an orchestration already in flight? Single-user runtime: one at a time, others queue. */
  runningCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM orchestrations WHERE status = 'running'").get() as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }
}
