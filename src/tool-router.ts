/**
 * Tool routing: choose which tools the model is even allowed to see.
 *
 * Why bother at fifteen tools: every tool description is prompt tokens paid on *every* turn, and a
 * long list makes the model skim. Routing replaces "all tools, always" with "the few that could
 * plausibly apply", and because pi accepts `--tools`, the decision can be enforced rather than
 * suggested — a filtered-out tool cannot be called at all.
 *
 * Design, deliberately simple at this scale:
 *
 *   1. **Hard filter** — `always` tools never leave the candidate set (memory search, fetch); the
 *      risk gate drops tools a request has no business using (self-edit, file locks) unless asked.
 *   2. **Lexical scoring** — Chinese keywords plus tool names/tags. No embeddings: at 15 tools the
 *      classifier's own error rate would exceed the benefit (see TODO in the report), and a wrong
 *      first-stage bucket is unrecoverable.
 *   3. **Floor** — if nothing scores, fall back to the always set plus `bash`/`read`, never to an
 *      empty list: an empty tool list turns every task into a chat.
 */
export type Risk = "low" | "medium" | "high";

export type ToolMeta = {
  name: string;
  /** What it is for, in the words a user would use. Also the routing signal. */
  tags: string[];
  always?: boolean;
  risk?: Risk;
};

export const TOOL_REGISTRY: ToolMeta[] = [
  { name: "read", tags: ["读", "文件", "看", "内容", "查看", "打开", "代码"], always: true },
  { name: "bash", tags: ["运行", "命令", "脚本", "安装", "编译", "测试", "curl", "git"], always: true },
  { name: "write", tags: ["写", "保存", "生成", "创建", "文件", "输出"] },
  { name: "edit", tags: ["改", "修改", "替换", "修", "编辑", "补丁"] },
  { name: "mcp__fetch__fetch", tags: ["网页", "链接", "url", "抓取", "文章", "文档"], always: true },
  { name: "mcp__fetch__search", tags: ["搜索", "查一下", "搜一下", "最新", "新闻", "资料", "调研"], always: true },
  { name: "mcp__memory__memory_search", tags: ["上次", "之前", "记得", "记忆", "以前", "说过"], always: true },
  { name: "mcp__memory__memory_change", tags: ["记住", "忘掉", "撤销记忆", "改记忆", "新增记忆"], risk: "medium" },
  { name: "mcp__spawn__orchestrate", tags: ["多个", "并行", "同时", "多路", "subagent", "子 agent", "子agent", "拆", "分头", "编排", "子任务", "调研"] },
  { name: "mcp__spawn__note_write", tags: ["便签", "记录结论", "子任务", "共享"] },
  { name: "mcp__spawn__note_read", tags: ["便签", "之前结论", "子任务"] },
  { name: "mcp__spawn__lock_file", tags: ["锁", "并发", "同时改", "冲突"] },
  { name: "mcp__spawn__unlock_file", tags: ["解锁", "释放锁"] },
  { name: "mcp__spawn__list_locks", tags: ["锁", "谁在改"] },
  { name: "mcp__spawn__send", tags: ["进度", "发给我", "发我", "图片", "一张图", "截图", "文件", "播报"] },
  { name: "mcp__spawn__propose_self_edit", tags: ["改自己", "人格", "加工具", "mcp"], risk: "high" },
];

/** High-risk tools need an explicit signal in the message; otherwise they stay hidden. */
const RISK_HINTS: Record<string, string[]> = {
  "mcp__spawn__propose_self_edit": ["改你", "改自己", "人格", "加个工具", "加工具", "mcp", "能力"],
  "mcp__spawn__memory_change": ["记住", "忘掉", "撤销", "改成", "新增记忆", "删掉这条"],
};

export type RouteResult = {
  tools: string[];
  matched: string[];
  reason: string;
};

export function routeTools(text: string, options: { maxTools?: number; registry?: ToolMeta[] } = {}): RouteResult {
  const maxTools = Math.max(3, options.maxTools ?? 8);
  const registry = options.registry ?? TOOL_REGISTRY;
  const haystack = String(text ?? "").toLowerCase();

  const scored: Array<{ name: string; score: number }> = [];
  const matched: string[] = [];

  for (const tool of registry) {
    let score = 0;
    for (const tag of tool.tags) {
      if (tag && haystack.includes(tag.toLowerCase())) score += tag.length >= 2 ? 2 : 1;
    }
    if (haystack.includes(tool.name.split("__").pop()!.toLowerCase())) score += 1;

    // Risk gate: a high-risk tool is only visible when the message asks for it.
    const hints = RISK_HINTS[tool.name];
    if (hints && !hints.some((hint) => haystack.includes(hint.toLowerCase()))) score = 0;

    if (score > 0) {
      scored.push({ name: tool.name, score });
      matched.push(tool.name);
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const always = registry.filter((tool) => tool.always).map((tool) => tool.name);
  const chosen: string[] = [...always];
  for (const item of scored) {
    if (chosen.length >= maxTools) break;
    if (!chosen.includes(item.name)) chosen.push(item.name);
  }

  // Floor: never hand the model an empty set. bash+read can at least inspect the workspace.
  if (chosen.length === 0) {
    return { tools: ["read", "bash"], matched: [], reason: "无匹配 → 兜底 read+bash" };
  }

  const added = chosen.filter((name) => !always.includes(name));
  return {
    tools: chosen,
    matched,
    reason: added.length > 0 ? `常驻 ${always.length} + 命中 ${added.join(",")}` : `仅常驻 ${always.length} 个`,
  };
}
