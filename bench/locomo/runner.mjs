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
 *   2. for each question: retrieve top-k turns, ask the model to answer **only** from them
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

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DATA = flag("data", "/tmp/locomo10.json");
const SAMPLE = Number(flag("sample", "0"));
const LIMIT = Number(flag("limit", "40"));
const K = Number(flag("k", "5"));
const OUT = flag("out", "");
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
            "Answer as short as possible (a date, a name, or a few words).",
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
for (const [key, value] of Object.entries(conversation)) {
  if (!/^session_\d+$/.test(key) || !Array.isArray(value)) continue;
  for (const turn of value) {
    const id = turn.dia_id ?? `${key}-${turns.length}`;
    turns.push({ id, text: `${turn.speaker}: ${turn.text}` });
  }
}
console.log(`样本 ${SAMPLE}（${sample.sample_id}）：${turns.length} 轮对话，${sample.qa.length} 个问题`);

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
const questions = sample.qa.slice(0, LIMIT);
const perCategory = new Map();
const records = [];

for (const [index, qa] of questions.entries()) {
  const category = Number(qa.category);
  const questionVector = (await embedBatch([qa.question]))[0];
  const hits = store.similaritySearch(questionVector, { limit: K, model: EMB_MODEL, minScore: 0.2 });
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
  writeFileSync(OUT, `${JSON.stringify({ sample: SAMPLE, limit: LIMIT, k: K, perCategory: Object.fromEntries(perCategory), records }, null, 2)}\n`, "utf8");
  console.log(`\n明细写入 ${OUT}`);
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
