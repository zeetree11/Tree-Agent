/**
 * Which memory-retrieval engine answers `memory_search`.
 *
 * Two implementations exist and they are not equivalent:
 *
 *   sqlite (default) — vectors live in the memories table as BLOBs, cosine is computed in Node.
 *                      One process, zero services, exact results, O(n) per query.
 *   mem0             — Mem0 owns the index (optionally Qdrant), SQLite stays the source of truth
 *                      and is replayed into Mem0 on demand. Adds a service and a dependency, buys
 *                      an ANN index we do not need at a few hundred rows.
 *
 * The switch is an environment variable rather than a code edit, because the decision is
 * operational ("did the corpus outgrow brute force?") not architectural.
 */
export const ENGINE_ENV = "PI_RT_MEMORY_ENGINE";

/** `mem0` is the only opt-in; anything unrecognised stays on the safe default. */
export function pickEngine(env = process.env) {
  const raw = String(env[ENGINE_ENV] ?? "").trim().toLowerCase();
  if (raw === "qdrant") return "qdrant";
  if (raw === "mem0") return "mem0";
  if (raw === "" || raw === "sqlite") return "sqlite";
  throw new Error(`${ENGINE_ENV}=${raw} 不认识（可选 sqlite / mem0）`);
}

/**
 * Lazy import so the default path never pays for mem0ai (or fails when it is absent).
 *
 * The module lives with the app source because it imports `mem0ai/oss` and resolves it from
 * /app/node_modules; the MCP server itself is mounted from the workspace.
 */
export async function loadQdrant(env = process.env) {
  const { QdrantEngine, qdrantConfigFromEnv } = await import("./qdrant-engine.mjs");
  const config = qdrantConfigFromEnv(env);
  if (!config) throw new Error("qdrant 引擎缺少配置：需要 MEM0_QDRANT_URL 或 QDRANT_URL");
  return { QdrantEngine, config };
}

export async function loadMem0(env = process.env) {
  const target = env.PI_RT_MEM0_MODULE ?? "/app/src/mem0-engine.ts";
  const mod = await import(target);
  const config = mod.mem0ConfigFromEnv ? mod.mem0ConfigFromEnv(env) : null;
  if (!config) {
    throw new Error("mem0 引擎缺少配置：需要 MEM0_EMBED_BASE_URL / MEM0_EMBED_API_KEY");
  }
  return { Mem0Engine: mod.Mem0Engine, config };
}
