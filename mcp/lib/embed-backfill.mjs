/**
 * Filling in embeddings for memories that never got one.
 *
 * Why this exists: a memory without a vector is not "slightly worse" at search — it is invisible.
 * The SQLite path filters `embedding IS NOT NULL`, the Qdrant path needs a vector to upsert, so an
 * unembedded row can never be recalled, no matter how relevant it is. In production this was 115 of
 * 143 active rows, which looks like "recall is mediocre" but is really "most memory is not indexed".
 *
 * Design notes:
 *
 * - **Model becomes part of the row.** A vector is only comparable with vectors from the same model,
 *   so `embedding_model` is written with the bytes; a mismatch is skipped rather than mixed in.
 * - **Bounded batches.** The backfill runs inside the same periodic tick as the index sync, a few
 *   rows at a time, so a large backlog does not turn into one enormous API burst.
 * - **`updated_at` moves.** Touching the row is deliberate: the indexer syncs by watermark, and a
 *   freshly embedded row must be picked up. The content is unchanged; what changed is that the row
 *   is now searchable.
 */
export function missingEmbeddings(db, model, limit = 20) {
  return db
    .prepare(
      `SELECT id, content FROM memories
        WHERE status = 'active'
          AND (embedding IS NULL OR embedding_model IS NOT ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(model, limit);
}

export function countMissing(db, model) {
  return db
    .prepare("SELECT COUNT(*) n FROM memories WHERE status = 'active' AND (embedding IS NULL OR embedding_model IS NOT ?)")
    .get(model).n;
}

/** Float32Array → BLOB, matching how the search paths decode it. */
export function vectorToBlob(vector) {
  const view = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Embed up to `limit` rows. Returns counts so the caller can log progress and decide whether to keep
 * going next tick; failures are counted, never thrown, because one bad row must not stall the queue.
 */
export async function backfillEmbeddings({ db, embed, model, limit = 20, now = () => new Date().toISOString() }) {
  const rows = missingEmbeddings(db, model, limit);
  if (rows.length === 0) return { filled: 0, failed: 0, remaining: 0 };

  const update = db.prepare("UPDATE memories SET embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?");
  let filled = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await embed(row.content);
      if (!result?.vector || result.vector.length === 0) {
        failed += 1;
        continue;
      }
      update.run(vectorToBlob(result.vector), result.model ?? model, now(), row.id);
      filled += 1;
    } catch {
      failed += 1;
    }
  }
  return { filled, failed, remaining: countMissing(db, model) };
}
