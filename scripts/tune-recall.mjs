#!/usr/bin/env node
/**
 * Threshold tuning on dev, reporting on holdout.
 *
 * The previous workflow swept thresholds and then reported the same queries — training on the test
 * set, which inflates the headline number by construction. This splits it:
 *
 *   dev      swept to pick minScore
 *   holdout  evaluated **once**, after the threshold is frozen
 *
 * Every rate is reported with a Wilson 95% interval. At n≈30 the interval is ~16 points wide, so a
 * bare "97%" would be misleading; with n≈110 it narrows to roughly ±6.
 *
 * Usage: node scripts/tune-recall.mjs [--fixture bench/recall-large.json] [--model BAAI/bge-m3]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { scoreRecall } from "../src/bench.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const fixture = JSON.parse(readFileSync(flag("fixture", "bench/recall-large.json"), "utf8"));
const BASE = process.env.MEM0_EMBED_BASE_URL;
const KEY = process.env.MEM0_EMBED_API_KEY;
const MODEL = flag("model", process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3");
const K = 5;

/** Wilson score interval — honest interval for a proportion, unlike the normal approximation. */
function wilson(successes, total, z = 1.96) {
  if (total === 0) return [0, 0];
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centre - margin) / denominator), Math.min(1, (centre + margin) / denominator)];
}

async function embed(texts) {
  const response = await fetch(`${BASE.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!response.ok) throw new Error(`embedding ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return (await response.json()).data.map((item) => new Float32Array(item.embedding));
}

if (!BASE || !KEY) {
  console.error("缺少 MEM0_EMBED_BASE_URL / MEM0_EMBED_API_KEY");
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "tune-"));
const store = new MemoryStore(dir, "bench");
const memoryVectors = await embed(fixture.memories.map((memory) => memory.content));
for (const [index, memory] of fixture.memories.entries()) {
  const result = store.apply({ action: "create", category: memory.category, key: memory.key, content: memory.content, importance: 3 });
  if (typeof result.id === "number") store.setEmbedding(result.id, memoryVectors[index], MODEL);
}

const dev = fixture.queries.filter((query) => query.split === "dev");
const holdout = fixture.queries.filter((query) => query.split === "holdout");
const queryVectors = await embed(fixture.queries.map((query) => query.q));
const vectorOf = new Map(fixture.queries.map((query, index) => [query, queryVectors[index]]));

function evaluate(queries, minScore) {
  const runs = queries.map((query) => ({
    q: query.q,
    expected: query.expect,
    got: store.similaritySearch(vectorOf.get(query), { limit: K, model: MODEL, minScore }).map((hit) => hit.row.key),
  }));
  const metrics = scoreRecall(runs, K);
  // 不可回答的查询单独算：期望为空时，"召回了东西"就是错
  const unanswerable = runs.filter((run) => run.expected.length === 0);
  const falseRecall = unanswerable.filter((run) => run.got.length > 0).length;
  const answerable = runs.filter((run) => run.expected.length > 0);
  const hits = answerable.filter((run) => run.expected.some((key) => run.got.includes(key))).length;
  return { metrics, answerable: answerable.length, hits, falseRecall, unanswerable: unanswerable.length };
}

console.log(`fixture: ${fixture.memories.length} 条记忆 · dev ${dev.length} 条查询 · holdout ${holdout.length} 条\n`);
console.log("在 dev 上扫阈值：");
console.log("| minScore | hit@5 | recall@5 | 误召回（不可回答） |");
console.log("|---|---|---|---|");

let best = { minScore: 0.5, hitRate: -1 };
for (const minScore of [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]) {
  const result = evaluate(dev, minScore);
  const hitRate = result.answerable === 0 ? 0 : result.hits / result.answerable;
  console.log(`| ${minScore.toFixed(2)} | ${(hitRate * 100).toFixed(0)}% | ${(result.metrics.recallAtK * 100).toFixed(0)}% | ${result.falseRecall}/${result.unanswerable} |`);
  // 选择规则：误召回为 0 的前提下，hit@5 最高；平手取更低的阈值（更宽松）
  if (result.falseRecall === 0 && hitRate > best.hitRate) best = { minScore, hitRate };
}
if (best.hitRate < 0) best = { minScore: 0.55, hitRate: 0 };

console.log(`\n选定 minScore = ${best.minScore}（dev 上误召回为 0 且 hit@5 最高）`);

const held = evaluate(holdout, best.minScore);
const [lo, hi] = wilson(held.hits, held.answerable);
console.log(`\nholdout 报告（只跑这一次）：`);
console.log(`  hit@5        ${held.hits}/${held.answerable} = ${(held.hitRate ?? held.hits / held.answerable * 100).toFixed?.(1) ?? ""}${((held.hits / held.answerable) * 100).toFixed(1)}%   95% CI [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]`);
console.log(`  recall@5     ${(held.metrics.recallAtK * 100).toFixed(1)}%`);
console.log(`  precision@5  ${(held.metrics.precisionAtK * 100).toFixed(1)}%`);
console.log(`  MRR          ${held.metrics.mrr.toFixed(2)}`);
console.log(`  误召回       ${held.falseRecall}/${held.unanswerable}（不可回答的查询被塞了结果）`);

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }
