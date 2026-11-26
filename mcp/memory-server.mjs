#!/usr/bin/env node
/**
 * MCP server exposing read-only memory search.
 *
 * This is the "pull" half of the memory system: the runtime still injects a scoped block every
 * turn (free, no latency), and this server lets the model look further when the injected block
 * does not cover the question — "上次那个并发的问题" style recall.
 *
 * Three deliberate limits:
 *
 * 1. READ-ONLY. Opens the database read-only; a write here would break the invariant that the
 *    read path never mutates memory.
 * 2. Only `active` rows. Cross-checked against the same status filter the injector uses, so a
 *    search can never surface a superseded/invalidated/contested claim as fact.
 * 3. Same embedding model only. Vectors from different providers are incomparable; rows whose
 *    `embedding_model` differs from the query's are skipped instead of mis-scored.
 */
import { DatabaseSync } from "node:sqlite";
import { blobToVector, cosine, embedText } from "./lib/embed.mjs";
import { loadMem0, loadQdrant, pickEngine } from "./lib/recall-engine.mjs";
import { openState } from "./lib/qdrant-index.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const DB_PATH = process.env.PI_RT_DB ?? "/data/runtime.db";

const INDEX_TOOL = {
  name: "memory_index",
  description:
    "把当前有效记忆增量写入向量索引（Qdrant）。默认由后台定时执行；这个工具用于手动触发或查看同步水位。" +
    "action=sync 立即同步一次，action=status 只看水位不写。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["sync", "status"], description: "默认 status。" },
    },
    additionalProperties: false,
  },
};

const EMBED_TOOL = {
  name: "memory_embed",
  description:
    "给还没有向量的记忆补算 embedding（没有向量的记忆永远搜不到）。定时任务会自动补；这个工具用于手动触发或查看缺口。" +
    "action=run 补一批（默认 20 条），action=status 只看还缺多少。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["run", "status"], description: "默认 status。" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "这一批补多少条，默认 20。" },
    },
    additionalProperties: false,
  },
};

const TOOL = {
  name: "memory_search",
  description:
    "在长期记忆里做语义检索，返回相关的事实及其证据。当注入的记忆块没有覆盖用户提到的事情时使用，" +
    "例如「上次那个并发的问题」。只返回当前有效的记忆，附带原始对话引文。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要查找的内容（自然语言）。" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 5。" },
      thread: { type: "string", description: "可选：限定到某个会话，防止跨会话串味。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function openReadOnly() {
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    // Fallback for Node builds that ignore the option: opening normally and refusing writes is
    // still safer than failing the whole tool.
    return new DatabaseSync(DB_PATH);
  }
}

/**
 * mem0 path: replay active rows into Mem0 (it is a cache, SQLite is the truth), then search.
 *
 * Kept separate from the SQLite path on purpose — the two return different shapes of confidence
 * (Mem0 scores are its own), and pretending otherwise would make the output silently incomparable.
 */
/**
 * Qdrant path: replay active rows into the collection (idempotent, keyed by row id), then search.
 *
 * Qdrant returns only what it indexed; the caller re-reads rows by id so evidence and status still
 * come from SQLite. If the collection is lost, one replay rebuilds it — that is the whole point of
 * keeping it a cache.
 */
async function searchViaQdrant(query, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 20);
  const { embedText } = await import("./lib/embed.mjs");
  const db = openReadOnly();
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id, key, subject, category, content, evidence_event_id, evidence_quote,
                importance, thread, updated_at
           FROM memories WHERE status = 'active'`,
      )
      .all();
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  if (options.thread) rows = rows.filter((row) => !row.thread || row.thread === options.thread);

  const { QdrantEngine, config } = await loadQdrant();
  const engine = new QdrantEngine(config, { embed: async (text) => (await embedText(text)).vector });
  await engine.sync(rows);

  const hits = await engine.recall(query, limit);
  if (hits.length === 0) return `记忆库里没有和「${query}」相关的内容（引擎 ${engine.describe()}）。`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const lines = hits.map((hit) => {
    const row = byId.get(hit.id);
    const quote = row?.evidence_quote ? `\n   证据 #${row.evidence_event_id}：「${row.evidence_quote}」` : "";
    const who = row?.subject ? `${row.subject} · ` : "";
    return `- [${who}${row?.category ?? "memory"}·${row?.importance ?? 3}] ${hit.text}（相关度 ${hit.score.toFixed(2)}）${quote}`;
  });
  return [`## 检索到的记忆（${lines.length} 条，引擎 ${engine.describe()}）`, ...lines].join("\n");
}

async function searchViaMem0(query, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 20);
  const db = openReadOnly();
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT id, key, subject, category, content, evidence_event_id, evidence_quote,
                importance, thread, updated_at
           FROM memories WHERE status = 'active'`,
      )
      .all();
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  if (options.thread) rows = rows.filter((row) => !row.thread || row.thread === options.thread);

  const { Mem0Engine, config } = await loadMem0();
  const engine = new Mem0Engine(config);
  await engine.sync(
    rows.map((row) => ({
      key: row.key,
      content: row.content,
      subject: row.subject,
      category: row.category,
      evidenceEventId: row.evidence_event_id,
      updatedAt: row.updated_at,
    })),
  );

  const hits = await engine.recall(query, limit);
  if (hits.length === 0) {
    return `记忆库里没有和「${query}」相关的内容（引擎 ${engine.describe()}）。`;
  }
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const lines = hits.map((hit) => {
    const row = byKey.get(hit.key);
    const quote = row?.evidence_quote ? `\n   证据 #${row.evidence_event_id}：「${row.evidence_quote}」` : "";
    const who = row?.subject ? `${row.subject} · ` : "";
    return `- [${who}${row?.category ?? "memory"}·${row?.importance ?? 3}] ${hit.text}（相关度 ${hit.score.toFixed(2)}）${quote}`;
  });
  return [`## 检索到的记忆（${lines.length} 条，引擎 ${engine.describe()}）`, ...lines].join("\n");
}

export async function searchMemory(query, options = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) throw new Error("查询为空");
  if (trimmed.length > 300) throw new Error("查询过长（上限 300 字符）");
  const limit = Math.min(Math.max(Number(options.limit ?? 5), 1), 20);

  const engine = pickEngine();
  if (engine === "qdrant") {
    return searchViaQdrant(trimmed, { limit, thread: options.thread });
  }
  if (engine === "mem0") {
    return searchViaMem0(trimmed, { limit, thread: options.thread });
  }

  const { vector, model } = await embedText(trimmed);
  // bge-style models cluster higher than the hash fallback; one threshold cannot serve both.
  const MIN_SCORE = Number(process.env.PI_RT_MEMORY_MINSIM ?? (model.startsWith("hash") ? 0.12 : 0.55));
  const db = openReadOnly();
  try {
    const rows = db
      .prepare(
        `SELECT id, key, target_name, subject, category, content, evidence_event_id,
                evidence_quote, importance, thread, updated_at
           FROM memories
          WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ?`,
      )
      .all(model);

    const scored = [];
    for (const row of rows) {
      if (options.thread && row.thread && row.thread !== options.thread) continue;
      const stored = blobToVector(row.embedding ?? null);
      if (!stored || stored.length !== vector.length) continue;
      const score = cosine(vector, stored);
      if (score < MIN_SCORE) continue;
      scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return `记忆库里没有和「${trimmed}」相关的内容（可能还没建向量索引）。`;
    }

    const lines = scored.slice(0, limit).map(({ row, score }) => {
      const who = row.target_name ? `${row.target_name} · ` : "";
      const quote = row.evidence_quote ? `\n   证据 #${row.evidence_event_id}：「${row.evidence_quote}」` : "";
      return `- [${who}${row.category}·${row.importance}] ${row.content}（相关度 ${score.toFixed(2)}）${quote}`;
    });

    return [`## 检索到的记忆（${lines.length} 条，模型 ${model}）`, ...lines].join("\n");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "memory", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL, INDEX_TOOL, EMBED_TOOL] });
    return;
  }
  if (method === "tools/call") {
    if (params?.name === EMBED_TOOL.name) {
      const action = String(params?.arguments?.action ?? "status");
      const limit = Math.min(Math.max(Number(params?.arguments?.limit ?? 20), 1), 100);
      const db = openState(DB_PATH);
      try {
        const { backfillEmbeddings, countMissing } = await import("./lib/embed-backfill.mjs");
        const { embedText } = await import("./lib/embed.mjs");
        const model = process.env.EMBEDDING_MODEL ?? process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3";
        if (action === "status") {
          reply(id, { content: [{ type: "text", text: `缺向量 ${countMissing(db, model)} 条（模型 ${model}）` }], isError: false });
          return;
        }
        const result = await backfillEmbeddings({ db, embed: embedText, model, limit });
        reply(id, { content: [{ type: "text", text: `补 ${result.filled} 条，失败 ${result.failed}，还剩 ${result.remaining} 条` }], isError: false });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reply(id, { content: [{ type: "text", text: `补向量失败：${reason}` }], isError: true });
      } finally {
        try { db.close(); } catch { /* 已关闭 */ }
      }
      return;
    }
    if (params?.name === INDEX_TOOL.name) {
      const action = String(params?.arguments?.action ?? "status");
      const db = openState(DB_PATH);
      try {
        const { QdrantEngine, qdrantConfigFromEnv } = await import("./lib/qdrant-engine.mjs");
        const { syncIndex, readWatermark } = await import("./lib/qdrant-index.mjs");
        const config = qdrantConfigFromEnv();
        if (!config) throw new Error("未配置 Qdrant（需要 MEM0_QDRANT_URL）");
        if (action === "status") {
          const mark = readWatermark(db, config.collection);
          reply(id, { content: [{ type: "text", text: `collection=${config.collection} 水位=${mark || "（尚未同步）"}` }], isError: false });
          return;
        }
        const engine = new QdrantEngine(config);
        const result = await syncIndex({ db, engine, collection: config.collection, dimension: config.dimension });
        reply(id, { content: [{ type: "text", text: `同步 ${result.synced} 条，跳过 ${result.skipped} 条，水位 ${result.watermark}` }], isError: false });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reply(id, { content: [{ type: "text", text: `索引同步失败：${reason}` }], isError: true });
      } finally {
        try { db.close(); } catch { /* 已关闭 */ }
      }
      return;
    }
    if (params?.name !== TOOL.name) {
      fail(id, `未知工具：${params?.name}`);
      return;
    }
    try {
      const text = await searchMemory(params?.arguments?.query, params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: "text", text: `记忆检索失败：${reason}` }], isError: true });
    }
    return;
  }
  if (typeof id !== "undefined") fail(id, `未知方法：${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        const message = JSON.parse(line);
        void handle(message).catch((error) => {
          if (message?.id !== undefined) fail(message.id, error.message);
        });
      } catch {
        /* ignore malformed line */
      }
    }
    index = buffer.indexOf("\n");
  }
});
