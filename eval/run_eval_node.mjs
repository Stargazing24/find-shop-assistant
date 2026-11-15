// run_eval_node.mjs — 不用评估页、不需要管理员口令，直接用线上真实模型跑全部用例
//
// 用法（项目根目录，先 npm install）：
//   node eval/run_eval_node.mjs
// 输出 eval/reports/eval_results_<时间>.json，格式与评估页 eval.html "下载 JSON" 完全相同，然后打分：
//   node eval/score.mjs find eval/reports/eval_results_<时间>.json
//
// 与评估页的区别：店铺数据用本地 data/demo_shops.json（与 B0 一致，四个系统可直接比较），
// 评估页用的是云端数据。连接信息取自 public/config.js（endpoint、publishableKey 是公开配置，不含口令）。
// 调用的是 src/core.mjs 里与网页相同的 runFindPipeline / runBaseline。约 125 次模型调用（34 条用例）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import * as core from "../src/core.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = fs.readFileSync(path.join(ROOT, "public", "config.js"), "utf8");
const pick = (k) => (cfg.match(new RegExp(k + '\\s*:\\s*"([^"]+)"')) || [])[1];
const model = pick("model");
const cloud = createWorkBuddyCloud({ endpoint: pick("endpoint"), publishableKey: pick("publishableKey") });

let calls = 0;
async function callLLM({ system, user, images, temperature, maxTokens }) {
  calls++;
  const messages = [{ role: "system", content: system }];
  messages.push(images && images.length
    ? { role: "user", content: [{ type: "text", text: user }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))] }
    : { role: "user", content: user });
  let text = "";
  for await (const chunk of cloud.llm.chat.completions.create({ model, messages, stream: true, temperature: temperature ?? 0, max_tokens: maxTokens, stream_options: { include_usage: true } })) {
    const d = chunk.choices?.[0]?.delta;
    if (d?.content) text += d.content;
  }
  return text;
}

const { shops, dishes } = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "demo_shops.json"), "utf8"));
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "cases.json"), "utf8")).cases;
const out = [];
for (const c of cases) {
  try {
    const p = await core.runFindPipeline({ query: c.query, nowISO: c.now, shops, dishes, callLLM, includeDemo: true });
    const b1 = await core.runBaseline({ mode: "B1", query: c.query, nowISO: c.now, shops, dishes, callLLM });
    const b2 = await core.runBaseline({ mode: "B2", query: c.query, nowISO: c.now, shops, dishes, callLLM });
    out.push({
      case_id: c.id, split: c.split, type: c.type, model, ran_at: new Date().toISOString(),
      pipeline: {
        query: c.query, now: c.now, expected_filters: c.expected_filters, expected_shop_ids: c.expected_shop_ids,
        parser: p.parser, parseFirstTryOk: p.parseFirstTryOk, parseAttempts: p.parseAttempts, filters: p.filters,
        parsedFilters: p.parsedFilters, ruleFilters: p.ruleFilters, relaxed: p.relaxed,
        candidate_shop_ids: (p.candidates || []).map((x) => x.shopId), unknownHoursShopIds: p.unknownHoursShopIds,
        answer: p.answer, usedTemplate: p.usedTemplate, templateReason: p.templateReason, guard: p.guard,
        guardFirstTryOk: p.guardFirstTryOk, answerAttempts: p.answerAttempts, timings: p.timings, promptVersions: p.promptVersions,
      },
      b1: { answer: b1.answer, guard: b1.guard, mentionedShopIds: b1.mentionedShopIds, timings: b1.timings },
      b2: { answer: b2.answer, guard: b2.guard, mentionedShopIds: b2.mentionedShopIds, timings: b2.timings },
    });
    console.log(`[${c.id}] P=${(p.candidates || []).map((x) => x.shopId).join(",") || "(无)"} 期望=${JSON.stringify(c.expected_shop_ids)} ${p.timings.total_ms}ms`);
  } catch (e) { console.log(`[${c.id}] 出错：${e.message || e}`); }
}
const file = path.join(ROOT, "eval", "reports", `eval_results_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n完成：${out.length}/${cases.length} 条用例，${calls} 次模型调用 → ${path.relative(ROOT, file)}`);
console.log(`打分：node eval/score.mjs find ${path.relative(ROOT, file)}`);
