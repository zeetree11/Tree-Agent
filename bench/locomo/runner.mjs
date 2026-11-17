#!/usr/bin/env node
/**
 * LoCoMo evaluation (snap-research/locomo, 2024) — long-conversation memory QA.
 *
 * Why this benchmark: it is the one most cited in memory-system papers, it ships real multi-session
 * dialogues with evidence ids, and its questions are categorised (multi-hop, temporal, single-hop,
 * adversarial). That last category is the reason to use it: a system that answers everything looks
 * great on recall@k and terrible on "this was never mentioned".
 *
 * Protocol, deliberately simple and reproducible:
 *
 *   1. ingest every dialogue turn as one memory (speaker-prefixed text), embedded with bge-m3
 *   2. for each question: retrieve top-k turns (k default 15), ask the model to answer **only** from them
 *   3. score with SQuAD-style token F1 against the gold answer; adversarial questions are scored by
 *      whether the model refuses instead
 *
 * This measures retrieval + answering together, not our product's full behaviour — no memory
 * distillation, no tool use. Stated plainly because the number is only meaningful with that scope.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/memory.ts";
import { bm25, rrf } from "../../src/hybrid.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DATA = flag("data", "/tmp/locomo10.json");
const SAMPLE = Number(flag("sample", "0"));
const LIMIT = Number(flag("limit", "40"));
const K = Number(flag("k", "15"));
const OUT = flag("out", "/tmp/locomo-result.json");
const AGENTIC = args.includes("--agentic");
const ONLY_CATEGORY = Number(flag("category", "0")) || 0;
const STRICT_SPAN = args.includes("--strict-span");
const HYBRID = args.includes("--hybrid");
const BASE = process.env.MEM0_EMBED_BASE_URL;
const EMB_KEY = process.env.MEM0_EMBED_API_KEY;
const EMB_MODEL = process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3";
const LLM_KEY = process.env.DEEPSEEK_API_KEY;
const LLM_MODEL = flag("model", "deepseek-chat");
const LLM_BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

if (!BASE || !EMB_KEY || !LLM_KEY) {
  console.error("缺少 MEM0_EMBED_* 或 DEEPSEEK_API_KEY");
  process.exit(1);
}

const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** SQuAD-style token F1. Crude for Chinese, fine for LoCoMo (English dialogue). */
function f1(prediction, gold) {
  const p = norm(prediction);
  const g = norm(gold);
  if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
  const used = new Array(g.length).fill(false);
  let common = 0;
  for (const token of p) {
    const index = g.findIndex((item, i) => !used[i] && item === token);
    if (index >= 0) {
      used[index] = true;
      common += 1;
    }
  }
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / g.length;
  return (2 * precision * recall) / (precision + recall);
}

async function embedBatch(texts) {
  const response = await fetch(`${BASE.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${EMB_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`embedding ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return (await response.json()).data.map((item) => new Float32Array(item.embedding));
}

/**
 * Split a question into sub-queries.
 *
 * Why this exists: multi-hop questions ("Who did X meet before moving to Y?") need two facts that
 * rarely sit in the same retrieved window. One query retrieves one region of the dialogue; two
 * queries retrieve two, and the union is what the answer needs.
 *
 * A single cheap model call, capped at 3 sub-queries — decomposition is a means, not a loop.
 */
async function decompose(question) {
  const response = await fetch(`${LLM_BASE.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "Split the question into 1-3 short retrieval queries, each targeting one fact needed. " +
            "Return ONLY JSON: {\"queries\":[\"...\"]}. If it needs a single fact, return one query.",
        },
        { role: "user", content: question },
      ],
    }),
  });
  if (!response.ok) return [question];
  try {
    const payload = await response.json();
    const text = String(payload.choices?.[0]?.message?.content ?? "");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [question];
    const parsed = JSON.parse(match[0]);
    const list = Array.isArray(parsed?.queries) ? parsed.queries : [];
    const cleaned = list.map((item) => String(item).trim()).filter(Boolean).slice(0, 3);
    return cleaned.length > 0 ? cleaned : [question];
  } catch {
    return [question];
  }
}

async function ask(question, context) {
  const response = await fetch(`${LLM_BASE.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You answer questions about a long conversation using ONLY the provided excerpts. " +
            "If the excerpts do not contain the answer, reply exactly: NOT_MENTIONED. " +
            STRICT_SPAN
              ? "Copy the answer verbatim from the excerpts: the exact words, no paraphrase, no added words. If the excerpts do not contain it, reply exactly NOT_MENTIONED."
              : "Answer as short as possible (a date, a name, or a few words).",
        },
        { role: "user", content: `Excerpts:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`llm ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  return String(payload.choices?.[0]?.message?.content ?? "").trim();
}

// ── 载入数据 ────────────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(DATA, "utf8"));
const sample = data[SAMPLE];
const conversation = sample.conversation;
const turns = [];
const sessionKeys = Object.keys(conversation)
  .filter((key) => /^session_\d+$/.test(key))
  .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
for (const key of sessionKeys) {
  const value = conversation[key];
  if (!Array.isArray(value)) continue;
  // 会话时间必须进正文：temporal 类问题问的就是"什么时候"，没有日期无从回答
  const when = String(conversation[`${key}_date_time`] ?? "").trim();
  for (const turn of value) {
    const id = turn.dia_id ?? `${key}-${turns.length}`;
    const prefix = when ? `[${when}] ` : "";
    turns.push({ id, text: `${prefix}${turn.speaker}: ${turn.text}` });
  }
}
console.log(`样本 ${SAMPLE}（${sample.sample_id}）：${turns.length} 轮对话，${sample.qa.length} 个问题`);

const turnDocs = turns.map((turn) => ({ key: `turn.${turn.id}`.toLowerCase(), text: turn.text }));

// ── 建库 ────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), "locomo-"));
const store = new MemoryStore(dir, "locomo");
const BATCH = 16;
for (let start = 0; start < turns.length; start += BATCH) {
  const slice = turns.slice(start, start + BATCH);
  const vectors = await embedBatch(slice.map((turn) => turn.text));
  for (const [index, turn] of slice.entries()) {
    const result = store.apply({
      action: "create",
      category: "event",
      key: `turn.${turn.id}`.toLowerCase(),
      content: turn.text,
      importance: 3,
    });
    if (typeof result.id === "number") store.setEmbedding(result.id, vectors[index], EMB_MODEL);
  }
}
console.log(`向量入库完成：${turns.length} 条`);

// ── 抽样评测 ────────────────────────────────────────────────────────────────
const questions = sample.qa
  .filter((item) => (ONLY_CATEGORY ? Number(item.category) === ONLY_CATEGORY : true))
  .slice(0, LIMIT);
const perCategory = new Map();
const records = [];
const recordsSubQueries = [];

for (const [index, qa] of questions.entries()) {
  const category = Number(qa.category);
  let hits;
  if (AGENTIC) {
    // 多跳：拆成子查询，各取 K/2，再按去重后的并集排序，总量控制在 2K
    const decomposed = await decompose(qa.question);
    // 原问题必须在内：子查询是对它的补充，不是替代
    const subQueries = [qa.question, ...decomposed.filter((item) => item !== qa.question)];
    const perQuery = Math.max(3, Math.ceil(K / 2));
    const merged = new Map();
    for (const subQuery of subQueries) {
      const vector = (await embedBatch([subQuery]))[0];
      for (const hit of store.similaritySearch(vector, { limit: perQuery, model: EMB_MODEL, minScore: 0.2 })) {
        const key = hit.row.key;
        const previous = merged.get(key);
        if (!previous || hit.score > previous.score) merged.set(key, hit);
      }
    }
    hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, K);
    recordsSubQueries.push({ index, subQueries });
  } else if (HYBRID) {
    const questionVector = (await embedBatch([qa.question]))[0];
    const vectorHits = store.similaritySearch(questionVector, { limit: K * 2, model: EMB_MODEL, minScore: 0.2 });
    const lexicalHits = bm25(qa.question, turnDocs).slice(0, K * 2);
    const fused = rrf([vectorHits.map((hit) => hit.row.key), lexicalHits.map((hit) => hit.key)]);
    const byKey = new Map(vectorHits.map((hit) => [hit.row.key, hit]));
    for (const lexical of lexicalHits) {
      if (!byKey.has(lexical.key)) {
        // 只被 BM25 命中的轮次没有向量分数，用原文补一个最小 row 供格式化
        byKey.set(lexical.key, { row: { key: lexical.key, content: lexical.text, importance: 3 }, score: 0 });
      }
    }
    hits = fused.slice(0, K).map((item) => byKey.get(item.key)).filter(Boolean);
  } else {
    const questionVector = (await embedBatch([qa.question]))[0];
    hits = store.similaritySearch(questionVector, { limit: K, model: EMB_MODEL, minScore: 0.2 });
  }
  const context = hits.map((hit) => `[${hit.row.key.replace("turn.", "")}] ${hit.row.content}`).join("\n");

  // adversarial（category 5）：正确行为是拒绝回答
  const isAdversarial = category === 5;
  const answer = await ask(qa.question, context);
  const refused = /NOT_MENTIONED/i.test(answer);
  const score = isAdversarial ? (refused ? 1 : 0) : refused ? 0 : f1(answer, qa.answer);

  records.push({
    index,
    category,
    question: qa.question,
    gold: qa.answer,
    answer,
    score,
    retrieved: hits.map((hit) => hit.row.key.replace("turn.", "")),
    evidence: qa.evidence ?? [],
  });

  const bucket = perCategory.get(category) ?? { n: 0, sum: 0 };
  bucket.n += 1;
  bucket.sum += score;
  perCategory.set(category, bucket);

  if ((index + 1) % 10 === 0) console.log(`  已评 ${index + 1}/${questions.length}`);
}

const labels = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
let totalSum = 0;
let totalN = 0;
console.log("\n| 类别 | n | 平均分 |");
console.log("|---|---|---|");
for (const category of [...perCategory.keys()].sort()) {
  const { n, sum } = perCategory.get(category);
  totalSum += sum;
  totalN += n;
  console.log(`| ${labels[category] ?? category} | ${n} | ${(sum / n).toFixed(3)} |`);
}
console.log(`| **总体** | **${totalN}** | **${(totalSum / totalN).toFixed(3)}** |`);

if (OUT) {
  writeFileSync(OUT, `${JSON.stringify({ sample: SAMPLE, limit: LIMIT, k: K, agentic: AGENTIC, perCategory: Object.fromEntries(perCategory), records, subQueries: recordsSubQueries }, null, 2)}\n`, "utf8");
  console.log(`\n明细写入 ${OUT}`);
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
