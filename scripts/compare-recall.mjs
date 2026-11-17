#!/usr/bin/env node
/**
 * Compare retrieval configurations on one fixture, with dev/holdout separation.
 *
 * Four configurations, same 103 memories and same 113 queries:
 *
 *   vector   — bge-m3 cosine only (what production runs)
 *   bm25     — lexical only
 *   hybrid   — reciprocal rank fusion of the two
 *   rerank   — hybrid shortlist, then a cross-encoder
 *
 * Thresholds are tuned on `dev`; every configuration is then reported **once** on `holdout`, with a
 * Wilson interval, plus the false-recall count on unanswerable queries. That last number matters as
 * much as recall: a retriever that answers "今天天气怎么样" with a memory is wrong in a way recall
 * alone never shows.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { scoreRecall } from "../src/bench.ts";
import { bm25, rerank, rrf } from "../src/hybrid.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const fixture = JSON.parse(readFileSync(flag("fixture", "bench/recall-large.json"), "utf8"));
const BASE = process.env.MEM0_EMBED_BASE_URL;
const KEY = process.env.MEM0_EMBED_API_KEY;
const MODEL = flag("model", process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3");
const RERANK_MODEL = flag("rerank-model", "BAAI/bge-reranker-v2-m3");
const K = 5;
const POOL = 20;

if (!BASE || !KEY) {
  console.error("缺少 MEM0_EMBED_BASE_URL / MEM0_EMBED_API_KEY");
  process.exit(1);
}

const wilson = (k, n, z = 1.96) => {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
};

async function embed(texts) {
  const response = await fetch(`${BASE.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 160));
  return (await response.json()).data.map((item) => new Float32Array(item.embedding));
}

const dir = mkdtempSync(path.join(tmpdir(), "cmp-"));
const store = new MemoryStore(dir, "bench");
const memoryVectors = await embed(fixture.memories.map((memory) => memory.content));
for (const [index, memory] of fixture.memories.entries()) {
  const result = store.apply({ action: "create", category: memory.category, key: memory.key, content: memory.content, importance: 3 });
  if (typeof result.id === "number") store.setEmbedding(result.id, memoryVectors[index], MODEL);
}
const docs = fixture.memories.map((memory) => ({ key: memory.key, text: memory.content }));
const queryVectors = await embed(fixture.queries.map((query) => query.q));
const vectorOf = new Map(fixture.queries.map((query, index) => [query, queryVectors[index]]));

const vectorTop = (query, limit, minScore) =>
  store.similaritySearch(vectorOf.get(query), { limit, model: MODEL, minScore }).map((hit) => hit.row.key);
const lexicalTop = (query, limit) => bm25(query.q, docs).slice(0, limit).map((hit) => hit.key);

function evaluate(queries, run) {
  const results = queries.map((query) => ({ expected: query.expect, got: run(query).slice(0, K) }));
  const metrics = scoreRecall(results.map((item, index) => ({ q: queries[index].q, ...item })), K);
  const unanswerable = results.filter((item) => item.expected.length === 0);
  const answerable = results.filter((item) => item.expected.length > 0);
  const hits = answerable.filter((item) => item.expected.some((key) => item.got.includes(key))).length;
  return {
    metrics,
    hits,
    answerable: answerable.length,
    falseRecall: unanswerable.filter((item) => item.got.length > 0).length,
    unanswerable: unanswerable.length,
  };
}

const dev = fixture.queries.filter((query) => query.split === "dev");
const holdout = fixture.queries.filter((query) => query.split === "holdout");

// 每个配置在 dev 上选参数；holdout 只用来报告
const configs = [];

{
  let best = { minScore: 0.6, rate: -1, falseRecall: 99 };
  for (const minScore of [0.45, 0.5, 0.55, 0.6, 0.65]) {
    const result = evaluate(dev, (query) => vectorTop(query, POOL, minScore));
    const rate = result.hits / Math.max(1, result.answerable);
    if (result.falseRecall === 0 && rate > best.rate) best = { minScore, rate, falseRecall: result.falseRecall };
  }
  configs.push({ name: `向量（minScore ${best.minScore}）`, run: (query) => vectorTop(query, POOL, best.minScore) });
}

{
  // BM25 没有阈值，用"分数 > 0"作为可回答判断，top-k 取前 K
  configs.push({ name: "BM25", run: (query) => lexicalTop(query, POOL) });
}

const fusion = (query) => rrf([vectorTop(query, POOL, 0.5), lexicalTop(query, POOL)]).map((item) => item.key);
configs.push({ name: "向量 + BM25（RRF）", run: fusion });

const fusionRerank = async (query) => {
  const fused = fusion(query).slice(0, 10);
  const candidates = fused.map((key) => docs.find((doc) => doc.key === key)).filter(Boolean);
  const ordered = await rerank(query.q, candidates, { baseURL: BASE, apiKey: KEY, model: RERANK_MODEL });
  return ordered ? ordered.map((item) => item.key) : fused;
};

const rows = [];
for (const config of configs) {
  const held = evaluate(holdout, config.run);
  const [lo, hi] = wilson(held.hits, held.answerable);
  rows.push({ name: config.name, ...held, lo, hi });
}

// 重排要 await，单独跑
{
  const results = [];
  for (const query of holdout) {
    results.push({ expected: query.expect, got: (await fusionRerank(query)).slice(0, K) });
  }
  const metrics = scoreRecall(results.map((item, index) => ({ q: holdout[index].q, ...item })), K);
  const unanswerable = results.filter((item) => item.expected.length === 0);
  const answerable = results.filter((item) => item.expected.length > 0);
  const hits = answerable.filter((item) => item.expected.some((key) => item.got.includes(key))).length;
  const [lo, hi] = wilson(hits, answerable.length);
  rows.push({
    name: `向量 + BM25 + 重排（${RERANK_MODEL}）`,
    metrics,
    hits,
    answerable: answerable.length,
    falseRecall: unanswerable.filter((item) => item.got.length > 0).length,
    unanswerable: unanswerable.length,
    lo,
    hi,
  });
}

console.log(`fixture ${fixture.memories.length} 条记忆 · dev ${dev.length} · holdout ${holdout.length} · top-${K}\n`);
console.log("holdout 报告（每个配置只跑一次）：");
console.log("| 配置 | hit@5 | 95% CI | precision@5 | MRR | 误召回 |");
console.log("|---|---|---|---|---|---|");
for (const row of rows) {
  const rate = (row.hits / Math.max(1, row.answerable)) * 100;
  console.log(
    `| ${row.name} | ${rate.toFixed(1)}% | [${(row.lo * 100).toFixed(1)}, ${(row.hi * 100).toFixed(1)}] | ${(row.metrics.precisionAtK * 100).toFixed(1)}% | ${row.metrics.mrr.toFixed(2)} | ${row.falseRecall}/${row.unanswerable} |`,
  );
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
