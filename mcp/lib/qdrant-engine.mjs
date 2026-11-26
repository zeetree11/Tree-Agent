/**
 * Qdrant as the vector index for `memory_search`.
 *
 * Deliberately not Mem0: Mem0 owns its own memory semantics (merge, dedupe, history) and drags in
 * a native SQLite binding that our image does not compile. All we actually need is an index —
 * "given a query vector, return the nearest active memories" — so this talks to Qdrant's REST API
 * directly. Memory decisions (what is active, what superseded what, which quote is the evidence)
 * stay in SQLite, where they are auditable.
 *
 * Division of responsibility:
 *
 *   SQLite    source of truth: rows, status, evidence, timestamps
 *   Qdrant    a *cache*: vectors keyed by row id, replayable at any time
 *
 * That is why `sync` is idempotent (same point ids are overwritten) and why losing the collection
 * costs only a replay, never data.
 */

const DEFAULT_COLLECTION = "memories";
const DEFAULT_DISTANCE = "Cosine";

export function qdrantConfigFromEnv(env = process.env) {
  const url = env.MEM0_QDRANT_URL ?? env.QDRANT_URL;
  if (!url) return null;
  return {
    url: url.replace(/\/$/, ""),
    apiKey: env.QDRANT_API_KEY ?? "",
    collection: env.MEM0_COLLECTION ?? DEFAULT_COLLECTION,
    dimension: Number(env.MEM0_EMBED_DIM ?? env.EMBEDDING_DIM ?? 1024),
    model: env.MEM0_EMBED_MODEL ?? env.EMBEDDING_MODEL ?? "BAAI/bge-m3",
  };
}

export class QdrantEngine {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.embed = options.embed;
    this.ready = false;
  }

  headers() {
    const headers = { "content-type": "application/json" };
    if (this.config.apiKey) headers["api-key"] = this.config.apiKey;
    return headers;
  }

  async request(method, path, body) {
    const response = await this.fetchImpl(`${this.config.url}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`qdrant ${method} ${path} ${response.status} ${text.slice(0, 160)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  /** Create the collection on first use; a dimension mismatch is a config error, not a runtime one. */
  async ensureCollection() {
    if (this.ready) return;
    const existing = await this.request("GET", `/collections/${this.config.collection}`).catch(() => null);
    if (!existing) {
      await this.request("PUT", `/collections/${this.config.collection}`, {
        vectors: { size: this.config.dimension, distance: DEFAULT_DISTANCE },
      });
    }
    this.ready = true;
  }

  /**
   * Replay rows into the index.
   *
   * Point id = row id, so re-syncing the same row overwrites instead of duplicating. Only the
   * fields needed to render a result are carried; everything else is re-read from SQLite by the
   * caller, which keeps the two sides from drifting.
   */
  async sync(rows) {
    if (rows.length === 0) return 0;
    await this.ensureCollection();
    const points = [];
    for (const row of rows) {
      if (!row.content) continue;
      const vector = await this.embed(row.content);
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
    if (points.length === 0) return 0;
    // Batch: a few hundred points, one request is fine and keeps replay fast.
    await this.request("PUT", `/collections/${this.config.collection}/points?wait=true`, { points });
    return points.length;
  }

  /** Raw upsert for callers that already built points (incremental sync reads vectors from SQLite). */
  async upsertPoints(points) {
    if (points.length === 0) return 0;
    await this.ensureCollection();
    await this.request("PUT", `/collections/${this.config.collection}/points?wait=true`, { points });
    return points.length;
  }

  async recall(query, limit = 5) {
    await this.ensureCollection();
    const vector = await this.embed(query);
    const result = await this.request("POST", `/collections/${this.config.collection}/points/search`, {
      vector: Array.from(vector),
      limit,
      with_payload: true,
    });
    const items = result?.result ?? [];
    return items.map((item) => ({
      id: Number(item.id),
      score: Number(item.score ?? 0),
      key: String(item.payload?.key ?? ""),
      text: String(item.payload?.content ?? ""),
      category: item.payload?.category ?? null,
      importance: item.payload?.importance ?? null,
    }));
  }

  describe() {
    return `qdrant/${this.config.collection} dim=${this.config.dimension} model=${this.config.model}`;
  }
}
