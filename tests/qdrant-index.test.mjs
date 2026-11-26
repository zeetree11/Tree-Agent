import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  advanceWatermark,
  pendingRows,
  readWatermark,
  syncIndex,
  vectorFromBlob,
} from "../mcp/lib/qdrant-index.mjs";

/**
 * Incremental sync: what gets sent, what is skipped, and where the watermark ends up.
 *
 * The point of these tests is the *second* run — a sync that re-sends everything is the bug this
 * module exists to prevent, and it is invisible with one call.
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

const dir = mkdtempSync(path.join(tmpdir(), "pi-index-"));
const db = new DatabaseSync(path.join(dir, "runtime.db"));
db.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY, key TEXT, content TEXT, subject TEXT, category TEXT,
    importance INTEGER, evidence_event_id INTEGER, updated_at TEXT,
    embedding BLOB, status TEXT
  )
`);

const vector = (n) => {
  const buffer = Buffer.alloc(4 * 3);
  buffer.writeFloatLE(n, 0);
  buffer.writeFloatLE(n + 1, 4);
  buffer.writeFloatLE(n + 2, 8);
  return buffer;
};

db.prepare("INSERT INTO memories VALUES (1,'a','内容 A','Rick','fact',3,10,'2026-11-01T00:00:00Z',?,'active')").run(vector(1));
db.prepare("INSERT INTO memories VALUES (2,'b','内容 B','Rick','fact',3,11,'2026-11-02T00:00:00Z',?,'active')").run(vector(2));
db.prepare("INSERT INTO memories VALUES (3,'c','已失效',NULL,'fact',3,12,'2026-11-03T00:00:00Z',?,'superseded')").run(vector(3));
db.prepare("INSERT INTO memories VALUES (4,'d','没有向量',NULL,'fact',3,13,'2026-11-04T00:00:00Z',NULL,'active')").run();

const points = [];
const engine = { upsertPoints: async (batch) => { points.push(...batch); return batch.length; } };

// ── 首次同步：只发 active 且有向量的行 ──────────────────────────────────────
{
  const result = await syncIndex({ db, engine, collection: "memories" });
  check("first sync sends active+vector rows", result.synced === 2, JSON.stringify(result));
  check("superseded excluded", !points.some((p) => p.id === 3));
  check("row without vector skipped", !points.some((p) => p.id === 4));
  check("watermark advances to last row", result.watermark === "2026-11-02T00:00:00Z", result.watermark);
  check("vector read from blob", Array.isArray(points[0].vector) && points[0].vector.length === 3, JSON.stringify(points[0].vector));
  check("payload carries evidence", points[0].payload.evidenceEventId === 10, JSON.stringify(points[0].payload));
}

// ── 第二次同步：没有变化就不该再发 ──────────────────────────────────────────
{
  points.length = 0;
  const result = await syncIndex({ db, engine, collection: "memories" });
  check("second sync is a no-op", result.synced === 0 && result.reason === "已是最新", JSON.stringify(result));
  check("nothing re-sent", points.length === 0, String(points.length));
}

// ── 新增一条：只发新增那条 ──────────────────────────────────────────────────
{
  points.length = 0;
  db.prepare("INSERT INTO memories VALUES (5,'e','内容 E',NULL,'preference',2,14,'2026-11-05T00:00:00Z',?,'active')").run(vector(5));
  const result = await syncIndex({ db, engine, collection: "memories" });
  check("only the new row is sent", result.synced === 1 && points[0].id === 5, JSON.stringify({ result, ids: points.map((p) => p.id) }));
  check("watermark moved", readWatermark(db, "memories") === "2026-11-05T00:00:00Z", readWatermark(db, "memories"));
}

// ── pendingRows 尊重 limit ─────────────────────────────────────────────────
{
  db.prepare("INSERT INTO memories VALUES (6,'f','内容 F',NULL,'fact',3,15,'2026-11-06T00:00:00Z',?,'active')").run(vector(6));
  const rows = pendingRows(db, "memories", 1);
  check("limit respected", rows.length === 1, String(rows.length));
  advanceWatermark(db, "memories", "2026-11-06T00:00:00Z");
  check("manual watermark write works", pendingRows(db, "memories").length === 0);
}

// ── BLOB 解码 ──────────────────────────────────────────────────────────────
{
  const decoded = vectorFromBlob(vector(7));
  check("blob decodes to floats", decoded?.[0] === 7 && decoded?.[2] === 9, JSON.stringify(decoded && Array.from(decoded)));
  check("null blob -> null", vectorFromBlob(null) === null);
  check("bad length -> null", vectorFromBlob(Buffer.alloc(3)) === null);
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handle */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
