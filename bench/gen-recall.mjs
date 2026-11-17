#!/usr/bin/env node
/**
 * Generate a larger recall fixture, deterministically.
 *
 * Why generate: 30 queries gave a 95% CI about 16 points wide — the headline number could not
 * support a claim. This fixture is bigger (and reports its own CI), so the number becomes usable.
 *
 * Two properties are load-bearing:
 *
 * 1. **Deterministic** (seeded PRNG). A fixture that regenerates differently each run measures
 *    nothing; every run must see identical data.
 * 2. **Anchored queries.** Each query names the *topic* (project, person, tool) but never the
 *    *answer* (database, role, number). Otherwise the test degenerates into substring matching.
 *
 * Near-duplicate families are kept as distractors: several memories about the same project with
 * different values, so recall is only achievable by reading the content, not by matching the topic.
 *
 * Output: bench/recall-large.json — `split` on each query (dev for tuning, holdout for reporting).
 */
import { writeFileSync } from "node:fs";

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = prng(20261117);
const memories = [];
// MemoryStore lowercases keys on write; every fixture key must follow the same rule, otherwise
// the comparison fails for reasons that have nothing to do with retrieval quality.
const K = (key) => String(key).toLowerCase();
const add = (key, category, content) => {
  const normalized = K(key);
  if (memories.some((item) => item.key === normalized)) return;
  memories.push({ key: normalized, category, content });
};

const cities = ["成都", "杭州", "西安", "长沙", "厦门", "武汉", "重庆", "南京", "青岛", "昆明"];
const drinks = ["无糖的茶", "冰美式", "热拿铁", "柠檬水", "气泡水", "豆浆"];
const langs = ["TypeScript", "Python", "C++", "Rust", "Go", "Java"];
const editors = ["VS Code", "Neovim", "JetBrains", "Zed", "Sublime"];
const dbs = ["SQLite", "Postgres", "MySQL", "Redis", "DuckDB", "ClickHouse"];
const projects = ["Orion", "Falcon", "Eagle", "Titan", "Atlas", "Nova", "Vega", "Lyra"];
const people = ["王工", "李敏", "张涛", "陈曦", "周航", "刘洋", "赵磊", "孙倩"];
const roles = ["负责安全评审", "负责数据管道", "负责前端联调", "负责压测", "负责部署脚本", "负责接口对齐", "负责告警治理", "负责成本核算"];
const tools = ["Docker", "Kubernetes", "Terraform", "GitHub Actions", "Nginx", "Prometheus"];

// ── 记忆：每个主题一组，同族带不同取值（天然干扰项）────────────────────────
for (const [i, project] of projects.entries()) {
  add(`project.${project}.db`, "fact", `${project} 这个项目的存储选型是 ${dbs[i]}`);
  add(`project.${project}.budget`, "fact", `${project} 本季度预算 ${10 + i * 7} 万，超出要重新审批`);
  add(`project.${project}.deadline`, "event", `${project} 计划 ${i + 1} 月底交付 v${i + 1}.2`);
}
for (const [i, person] of people.entries()) {
  add(`team.${person}`, "fact", `${person} ${roles[i]}`);
  add(`team.${person}.channel`, "preference", `找${person}走${i % 2 === 0 ? "飞书" : "邮件"}，不要走群`);
}
for (const [i, tool] of tools.entries()) {
  add(`infra.${tool}`, "fact", `${tool} 的配置放在 infra/${tool.toLowerCase()}/ 目录`);
}
for (const [i, lang] of langs.entries()) {
  add(`pref.lang.${i}`, "preference", `写代码主要用 ${lang}，其他语言只读不写`);
}
for (const [i, drink] of drinks.entries()) {
  add(`pref.drink.${i}`, "preference", `只喝${drink}，别的饮料基本不碰`);
}
for (const [i, editor] of editors.entries()) {
  add(`pref.editor.${i}`, "preference", `习惯用 ${editor}，不喜欢重量级 IDE`);
}
for (const [i, city] of cities.entries()) {
  add(`user.city.${city}`, "fact", `住在${city}，已经住了 ${i % 5 + 1} 年`);
  add(`trip.${city}`, "event", `第 ${i + 1} 次出差去${city}，当天回不来`);
}
for (const [i, project] of projects.entries()) {
  add(`metric.${project}`, "fact", `${project} 的 p95 延迟目前是 ${120 + i * 37} 毫秒`);
}
for (let i = 0; i < 12; i += 1) {
  add(`habit.${i}`, "preference", `${["凌晨一点", "晚上十一点", "十二点半"][i % 3]} 才睡，${["早上八点", "九点", "十点"][i % 3]} 起`);
}

// ── 查询：锚点唯一，答案不在查询里 ──────────────────────────────────────────
const queries = [];
const addQuery = (q, expect, distractors = []) => {
  if (queries.some((item) => item.q === q)) return;
  queries.push({ q, expect: expect.map(K), distractors: distractors.map(K) });
};

for (const project of projects) {
  addQuery(`${project} 这个项目的存储选型是什么`, [`project.${project}.db`], [`metric.${project}`, `project.${project}.budget`]);
  addQuery(`${project} 本季度预算多少`, [`project.${project}.budget`], [`metric.${project}`]);
  addQuery(`${project} 什么时候交付，交付哪个版本`, [`project.${project}.deadline`], [`project.${project}.db`]);
  addQuery(`${project} 现在的 p95 延迟是多少`, [`metric.${project}`], [`project.${project}.budget`]);
}
for (const person of people) {
  addQuery(`${person} 负责哪一部分`, [`team.${person}`], [`team.${person}.channel`]);
  addQuery(`和${person}沟通应该走什么渠道`, [`team.${person}.channel`], [`team.${person}`]);
}
for (const tool of tools) {
  addQuery(`${tool} 的配置放在哪个目录`, [`infra.${tool}`], []);
}
for (const [i, lang] of langs.entries()) {
  const others = langs.filter((item) => item !== lang).slice(0, 2).map((item, k) => `pref.lang.${(i + k + 1) % langs.length}`);
  addQuery(`我写代码主要用什么语言（第 ${i + 1} 个偏好）`, [`pref.lang.${i}`], others);
}
for (const [i, drink] of drinks.entries()) {
  addQuery(`我平时喝什么（偏好 ${i + 1}）`, [`pref.drink.${i}`], [`pref.drink.${(i + 1) % drinks.length}`]);
}
for (const [i, editor] of editors.entries()) {
  addQuery(`我用什么编辑器（偏好 ${i + 1}）`, [`pref.editor.${i}`], [`pref.editor.${(i + 1) % editors.length}`]);
}
for (const [i, city] of cities.entries()) {
  addQuery(`我在${city}住了几年`, [`user.city.${city}`], [`trip.${city}`]);
  addQuery(`第 ${i + 1} 次出差去哪，能当天回吗`, [`trip.${city}`], [`user.city.${city}`]);
}
for (let i = 0; i < 12; i += 1) {
  addQuery(`我的作息是怎样的（第 ${i + 1} 条）`, [`habit.${i}`], [`habit.${(i + 1) % 12}`]);
}
// 不可回答：空 expect，考察是否乱召回
for (let i = 0; i < 10; i += 1) {
  addQuery(`今天天气怎么样（无关问题 ${i + 1}）`, [], []);
}

// 7:3 切分，按查询序号稳定决定
queries.forEach((query, index) => {
  query.split = index % 10 < 7 ? "dev" : "holdout";
});

writeFileSync(
  process.argv[2] ?? "bench/recall-large.json",
  `${JSON.stringify(
    {
      version: 2,
      note: "确定性生成；锚点在问题里、答案不在问题里；同族记忆互为干扰项。holdout 只能用于报告，不能用于调参。",
      memories,
      queries,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const count = (split) => queries.filter((item) => item.split === split).length;
console.log(`记忆 ${memories.length} 条，查询 ${queries.length} 条（dev ${count("dev")} / holdout ${count("holdout")}）`);
