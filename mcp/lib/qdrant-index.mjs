/**
 * Keeping the Qdrant index in sync with SQLite — incrementally, from stored vectors.
 *
 * Two decisions worth stating:
 *
 * 1. **Vectors come from the database, not from the embedding API.** The rows already carry a
 *    BLOB (that is how the SQLite engine searches); re-embedding them on every sync would cost one
 *    API call per memory and could even drift if the model version changed under us.
 * 2. **The watermark lives in SQLite.** "Last synced updated_at" is small, transactional with the
 *    data it describes, and survives a Qdrant wipe — which is correct, because Qdrant is only a
 *    cache and a wipe must be recoverable by replay.
 */
import { DatabaseSync } from "node:sqlite";

const DEFAULT_COLLECTION = "memories";

export function ensureState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_watermark (
      collection TEXT PRIMARY KEY,
      synced_at  TEXT NOT NULL
    )
  `);
}

/** Rows changed since the last sync (watermark per collection). */
export function pendingRows(db, collection = DEFAULT_COLLECTION, limit = 500) {
  ensureState(db);
  const mark = db.prepare("SELECT synced_at FROM index_watermark WHERE collection = ?").get(collection);
  const since = mark?.synced_at ?? "";
  return db
    .prepare(
      `SELECT id, key, content, subject, category, importance, evidence_event_id, updated_at, embedding
         FROM memories
        WHERE status = 'active' AND embedding IS NOT NULL AND updated_at > ?
        ORDER BY updated_at
        LIMIT ?`,
    )
    .all(since, limit);
}

export function advanceWatermark(db, collection, updatedAt) {
  ensureState(db);
  db.prepare(
    `INSERT INTO index_watermark (collection, synced_at) VALUES (?, ?)
     ON CONFLICT(collection) DO UPDATE SET synced_at = excluded.synced_at`,
  ).run(collection, updatedAt);
}

export function readWatermark(db, collection = DEFAULT_COLLECTION) {
  ensureState(db);
  return db.prepare("SELECT synced_at FROM index_watermark WHERE collection = ?").get(collection)?.synced_at ?? "";
}

/** BLOB → Float32Array, matching how the SQLite engine reads its vectors. */
export function vectorFromBlob(blob) {
  if (!blob) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.byteLength % 4 !== 0) return null;
  const view = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < view.length; i += 1) view[i] = buffer.readFloatLE(i * 4);
  return view;
}

/**
 * One incremental pass. Returns what happened so callers (tool and timer) can log the same shape.
 */
export async function syncIndex({ db, engine, collection = DEFAULT_COLLECTION, limit = 500, dimension = 0 }) {
  const rows = pendingRows(db, collection, limit);
  if (rows.length === 0) {
    return { synced: 0, skipped: 0, watermark: readWatermark(db, collection), reason: "已是最新" };
  }
  const points = [];
  let skipped = 0;
  for (const row of rows) {
    const vector = vectorFromBlob(row.embedding);
    // A vector from another embedding space is not "close enough" — it is incomparable. Mixing them
    // is what produced a 400 (expected dim 1024, got 256) on the first real sync.
    if (!vector || (dimension > 0 && vector.length !== dimension)) {
      skipped += 1;
      continue;
    }
    points.push({
      id: row.id,
      vector: Array.from(vector),
      payload: {
        key: row.key,
        content: row.content,
        subject: row.subject ?? null,
        category: row.category ?? null,
        importance: row.importance ?? 3,
        evidenceEventId: row.evidence_event_id ?? null,
        updatedAt: row.updated_at ?? null,
      },
    });
  }
  if (points.length > 0) await engine.upsertPoints(points);
  const last = rows[rows.length - 1].updated_at;
  advanceWatermark(db, collection, last);
  return { synced: points.length, skipped, watermark: last, reason: "ok" };
}

export function openState(dbPath) {
  return new DatabaseSync(dbPath);
}
