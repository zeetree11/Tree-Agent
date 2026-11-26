import { QdrantEngine, qdrantConfigFromEnv } from "../mcp/lib/qdrant-engine.mjs";

/**
 * The Qdrant engine is a thin REST client, so the tests drive it with a fake fetch and assert the
 * requests it makes. What matters is not that Qdrant works — it does — but that we send point ids
 * that match row ids (idempotent replay) and read scores back without inventing fields.
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

const calls = [];
const makeFetch = (handler) => async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ method: init.method ?? "GET", url, body });
  return handler({ method: init.method ?? "GET", url, body });
};

const json = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

// ── 配置解析 ────────────────────────────────────────────────────────────────
{
  check("missing url -> null", qdrantConfigFromEnv({}) === null);
  const cfg = qdrantConfigFromEnv({ MEM0_QDRANT_URL: "http://qdrant:6333/", MEM0_EMBED_DIM: "1024" });
  check("url trimmed", cfg?.url === "http://qdrant:6333", JSON.stringify(cfg));
  check("default collection", cfg?.collection === "memories");
  check("dimension parsed", cfg?.dimension === 1024);
}

// ── 首次使用：建集合 + 写点 + 查询 ──────────────────────────────────────────
{
  calls.length = 0;
  const engine = new QdrantEngine(
    qdrantConfigFromEnv({ MEM0_QDRANT_URL: "http://q:6333" }),
    {
      embed: async (text) => new Float32Array([text.length, 1, 0]),
      fetchImpl: makeFetch(({ method, url }) => {
        if (method === "GET" && url.endsWith("/collections/memories")) return json({ status: 200, result: null }, 404);
        if (method === "PUT" && url.endsWith("/collections/memories")) return json({ result: true });
        if (method === "PUT" && url.includes("/points")) return json({ result: { status: "completed" } });
        if (method === "POST" && url.includes("/points/search")) {
          return json({ result: [{ id: 7, score: 0.91, payload: { key: "k7", content: "住在成都", category: "fact", importance: 3 } }] });
        }
        return json({}, 404);
      }),
    },
  );

  const added = await engine.sync([
    { id: 7, key: "k7", content: "住在成都", category: "fact", importance: 3, evidence_event_id: 42, updated_at: "2026-11-01" },
    { id: 8, key: "k8", content: "", category: "fact" },
  ]);
  check("skips empty content", added === 1, String(added));
  check("creates collection once", calls.filter((c) => c.method === "PUT" && c.url.endsWith("/collections/memories")).length === 1);
  const upsert = calls.find((c) => c.method === "PUT" && c.url.includes("/points"));
  check("upsert uses row id", upsert?.body?.points?.[0]?.id === 7, JSON.stringify(upsert?.body?.points?.[0]?.id));
  check("upsert carries payload", upsert?.body?.points?.[0]?.payload?.key === "k7");
  check("upsert carries vector", Array.isArray(upsert?.body?.points?.[0]?.vector) && upsert.body.points[0].vector.length === 3);

  const hits = await engine.recall("成都", 3);
  check("search returns hit", hits.length === 1 && hits[0].key === "k7", JSON.stringify(hits));
  check("score preserved", hits[0].score === 0.91);
  check("text from payload", hits[0].text === "住在成都");
  const search = calls.find((c) => c.url.includes("/points/search"));
  check("search uses limit", search?.body?.limit === 3);
  check("search asks for payload", search?.body?.with_payload === true);
  check("describe names the collection", engine.describe().includes("qdrant/memories"));
}

// ── 幂等：同一个 id 再同步不会新增点，只会覆盖 ──────────────────────────────
{
  calls.length = 0;
  const engine = new QdrantEngine(
    qdrantConfigFromEnv({ MEM0_QDRANT_URL: "http://q:6333" }),
    {
      embed: async () => new Float32Array([1, 0, 0]),
      fetchImpl: makeFetch(({ method, url }) => {
        if (method === "GET") return json({ result: {} });
        if (method === "PUT") return json({ result: {} });
        return json({ result: [] });
      }),
    },
  );
  await engine.sync([{ id: 1, key: "a", content: "x" }, { id: 1, key: "a", content: "x" }]);
  const puts = calls.filter((c) => c.method === "PUT" && c.url.includes("/points"));
  check("two rows with same id produce two points in one request", puts[0]?.body?.points?.length === 2, JSON.stringify(puts[0]?.body?.points?.length));
}

// ── 错误传播：Qdrant 报错要带状态码，不能静默返回空 ──────────────────────────
{
  const engine = new QdrantEngine(
    qdrantConfigFromEnv({ MEM0_QDRANT_URL: "http://q:6333" }),
    {
      embed: async () => new Float32Array([1]),
      fetchImpl: makeFetch(() => json({ status: { error: "boom" } }, 500)),
    },
  );
  let message = "";
  try {
    await engine.recall("x", 1);
  } catch (error) {
    message = error.message;
  }
  check("http error surfaces", /500/.test(message), message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
