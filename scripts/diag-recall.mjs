import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { scoreRecall } from "../src/bench.ts";

const fx = JSON.parse(readFileSync("bench/recall-large.json", "utf8"));
const BASE = process.env.MEM0_EMBED_BASE_URL;
const KEY = process.env.MEM0_EMBED_API_KEY;
const MODEL = process.env.MEM0_EMBED_MODEL ?? "BAAI/bge-m3";

const embed = async (texts) => {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return (await r.json()).data.map((d) => new Float32Array(d.embedding));
};

const dir = mkdtempSync(path.join(tmpdir(), "diag-"));
const store = new MemoryStore(dir, "bench");
const mv = await embed(fx.memories.map((m) => m.content));
for (const [i, m] of fx.memories.entries()) {
  const r = store.apply({ action: "create", category: m.category, key: m.key, content: m.content, importance: 3 });
  if (typeof r.id === "number") store.setEmbedding(r.id, mv[i], MODEL);
}

const dev = fx.queries.filter((q) => q.split === "dev" && q.expect.length > 0);
const qv = await embed(dev.map((q) => q.q));

for (const k of [3, 5, 10, 20, 40]) {
  const runs = dev.map((q, i) => ({
    q: q.q,
    expected: q.expect,
    got: store.similaritySearch(qv[i], { limit: k, model: MODEL, minScore: 0.2 }).map((h) => h.row.key),
  }));
  const m = scoreRecall(runs, k);
  console.log(`k=${String(k).padStart(2)}  hit@k ${(m.hitRate * 100).toFixed(0)}%  recall@k ${(m.recallAtK * 100).toFixed(0)}%  precision ${(m.precisionAtK * 100).toFixed(0)}%`);
}

// 看几条失败样本：正确项排第几
let rankSum = 0;
let ranked = 0;
const examples = [];
for (const [i, q] of dev.entries()) {
  const hits = store.similaritySearch(qv[i], { limit: 40, model: MODEL, minScore: 0.2 }).map((h) => h.row.key);
  const rank = hits.findIndex((key) => q.expect.includes(key));
  if (rank >= 0) { rankSum += rank + 1; ranked += 1; }
  else if (examples.length < 4) examples.push({ q: q.q, expect: q.expect, top3: hits.slice(0, 3) });
}
console.log(`\n正确项在候选里的平均排名：${(rankSum / Math.max(1, ranked)).toFixed(1)}（${ranked}/${dev.length} 出现在 top-40 内）`);
for (const e of examples) console.log(`  未进 top-40: 「${e.q}」期望 ${e.expect.join(",")}，实得 ${e.top3.join(",")}`);

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
