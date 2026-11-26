import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backfillEmbeddings,
  countMissing,
  missingEmbeddings,
  vectorToBlob,
} from "../mcp/lib/embed-backfill.mjs";

/**
 * Backfill tests. The interesting cases are the ones that silently break search:
 * rows that already have a different model's vector, rows that fail to embed, and whether the
 * watermark-facing `updated_at` actually moves.
 */

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

const dir = mkdtempSync(path.join(tmpdir(), "pi-backfill-"));
const db = new DatabaseSync(path.join(dir, "runtime.db"));
db.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY, key TEXT, content TEXT, embedding BLOB,
    embedding_model TEXT, updated_at TEXT, status TEXT
  )
`);

const blob = (n) => {
  const view = new Float32Array([n, 0, 0]);
  return Buffer.from(view.buffer);
};
const insert = (id, content, model, status = "active", embedding = null) =>
  db.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?)").run(id, `k${id}`, content, embedding, model, "2026-11-01T00:00:00Z", status);

insert(1, "住在成都", null);
insert(2, "用 C++", "hash-256");
insert(3, "已废弃", null, "superseded");
insert(4, "正常", "BAAI/bge-m3", "active", blob(4));

const embed = async (text) => {
  if (text.includes("失败")) throw new Error("embedding 接口 500");
  return { vector: new Float32Array([text.length, 1, 2]), model: "BAAI/bge-m3" };
};

// ── 缺口识别 ────────────────────────────────────────────────────────────────
{
  check("counts null and foreign-model rows", countMissing(db, "BAAI/bge-m3") === 2, String(countMissing(db, "BAAI/bge-m3")));
  const rows = missingEmbeddings(db, "BAAI/bge-m3", 10);
  check("excludes superseded", !rows.some((r) => r.id === 3), JSON.stringify(rows.map((r) => r.id)));
  check("excludes already embedded with same model", !rows.some((r) => r.id === 4));
}

// ── 补一批 ──────────────────────────────────────────────────────────────────
{
  const before = db.prepare("SELECT updated_at FROM memories WHERE id = 1").get().updated_at;
  const result = await backfillEmbeddings({ db, embed, model: "BAAI/bge-m3", limit: 10, now: () => "2026-11-26T00:00:00Z" });
  check("fills both rows", result.filled === 2, JSON.stringify(result));
  check("nothing missing afterwards", result.remaining === 0);

  const row = db.prepare("SELECT embedding, embedding_model, updated_at FROM memories WHERE id = 1").get();
  check("vector written", row.embedding && row.embedding.byteLength === 12, String(row.embedding?.byteLength));
  check("model recorded", row.embedding_model === "BAAI/bge-m3", String(row.embedding_model));
  check("updated_at moved for the indexer", row.updated_at === "2026-11-26T00:00:00Z" && before !== row.updated_at);

  // 重新计算后不再是缺口
  check("no longer missing", countMissing(db, "BAAI/bge-m3") === 0);
}

// ── 失败计数，不抛错 ────────────────────────────────────────────────────────
{
  insert(5, "这条会失败", null);
  const result = await backfillEmbeddings({ db, embed, model: "BAAI/bge-m3", limit: 5 });
  check("failure counted not thrown", result.failed === 1 && result.filled === 0, JSON.stringify(result));
  check("failed row still missing", countMissing(db, "BAAI/bge-m3") === 1);
}

// ── limit 生效 ─────────────────────────────────────────────────────────────
{
  insert(6, "另一条", null);
  const result = await backfillEmbeddings({ db, embed, model: "BAAI/bge-m3", limit: 1 });
  // 这一批只处理一行，至于是成功的那行还是失败的那行，取决于 updated_at 排序——两者都算"只处理了一行"
  check("limit bounds the batch", result.filled + result.failed === 1, JSON.stringify(result));
  check("remaining still counted", result.remaining >= 1, String(result.remaining));
}

// ── BLOB 编码往返 ──────────────────────────────────────────────────────────
{
  const blob = vectorToBlob(new Float32Array([1.5, -2.25, 0]));
  const view = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  check("round trip preserves floats", view[0] === 1.5 && view[1] === -2.25 && view[2] === 0, JSON.stringify(Array.from(view)));
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
