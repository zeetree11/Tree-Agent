import { routeTools, TOOL_REGISTRY } from "../src/tool-router.ts";

/**
 * Routing tests double as the Recall@K instrument: each case names the tool the request *needs*,
 * and the assertion is that it survives into the candidate set. A candidate set that drops the
 * right tool is unrecoverable — the model cannot call what it cannot see.
 *
 * K is deliberately small (8) because the point of routing is a shorter list, not a longer one.
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

/** 标注：请求 → 必须出现在候选集里的工具 */
const CASES = [
  { text: "帮我搜一下最近的 Agent 评测基准", expect: "mcp__fetch__search" },
  { text: "读一下 /workspace/report.md", expect: "read" },
  { text: "跑一下测试看看", expect: "bash" },
  { text: "把这个结论写成文件", expect: "write" },
  { text: "把 src/a.ts 里的 foo 改成 bar", expect: "edit" },
  { text: "我上次说的那个项目叫什么", expect: "mcp__memory__memory_search" },
  { text: "记住我喜欢用 C++", expect: "mcp__memory__memory_change" },
  { text: "分头调研三个方向，再汇总", expect: "mcp__spawn__orchestrate" },
  { text: "抓一下这个链接 https://example.com", expect: "mcp__fetch__fetch" },
  { text: "把结果发我一张图", expect: "mcp__spawn__send" },
];

for (const item of CASES) {
  const routed = routeTools(item.text);
  check(`召回 ${item.expect}：${item.text.slice(0, 12)}`, routed.tools.includes(item.expect), JSON.stringify(routed));
  check(`候选数 ≤ 8：${item.text.slice(0, 10)}`, routed.tools.length <= 8, String(routed.tools.length));
}

// 常驻工具永远在（少了它们，普通任务直接失去手脚）
{
  const routed = routeTools("今天天气不错");
  for (const tool of ["read", "bash", "mcp__fetch__search", "mcp__memory__memory_search"]) {
    check(`常驻保留 ${tool}`, routed.tools.includes(tool));
  }
}

// 高风险工具：没有明确诉求就不该出现
{
  const quiet = routeTools("帮我看下这个报错");
  check("默认不暴露改自己", !quiet.tools.includes("mcp__spawn__propose_self_edit"), JSON.stringify(quiet.tools));
  const asked = routeTools("你能不能改自己的人格，加个工具");
  check("明确要求时才暴露改自己", asked.tools.includes("mcp__spawn__propose_self_edit"), JSON.stringify(asked.tools));
}

// 兜底：绝不返回空集（空工具列表会让任务退化成聊天）
{
  const registry = TOOL_REGISTRY.filter((tool) => !tool.always);
  const routed = routeTools("嗯", { registry });
  check("非空兜底", routed.tools.length > 0, JSON.stringify(routed.tools));
}

// 排序：命中更多的排前面，且候选集稳定
{
  const a = routeTools("帮我搜一下并抓取这个链接");
  const b = routeTools("帮我搜一下并抓取这个链接");
  check("路由是确定性的", a.tools.join(",") === b.tools.join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
