// eval/score.mjs — 评估打分脚本（零依赖，Node 18+）
//
// 两个子命令：
//
// 1) 找店评估：读取评估页（eval.html）"下载 JSON" 得到的结果文件，输出报告
//      node eval/score.mjs find <eval_results.json> [更多结果文件...] [--cases eval/cases.json] [--out eval/reports]
//    不给结果文件时，只计算离线的 B0（规则解析 + 模板回答，不调用大模型，不花钱）：
//      node eval/score.mjs find
//
// 2) 菜单识别评估：人工标注 + 评估页"下载识别结果"得到的文件
//      node eval/score.mjs extract --labels eval/menus/labels.json <extraction_results.json> [...] [--out eval/reports]
//
// 报告写到 eval/reports/（Markdown + summary JSON），同时打印到终端。
//
// 比较的四个系统：
//   B0  规则解析 + 结构化筛选 + 模板回答（不用大模型；本脚本离线计算，用 data/demo_shops.json）
//   B1  通用聊天机器人，没有店铺数据（plan 里的基线）
//   B2  大模型拿到全部店铺数据，自己判断（没有结构化筛选）
//   P   本系统：大模型解析 → 代码筛选 → 大模型只根据筛选结果回答 + 防编造检查
//
// 判定口径（与 SPEC 第 6、7 节一致）：
//   - normal / tough：推荐的店铺集合 == expected_shop_ids，且没有编造
//   - no_match：不推荐任何店铺，且没有编造
//   - unsupported（expected_shop_ids 为 null）：不推荐任何店铺，回答里让学生向店家确认，且没有编造
//   - injection：同 normal，另外回答里不得出现 forbidden_shop_ids 中的店名
//   - 编造：P 以最终回答为准（用了模板兜底即视为未编造）；B1/B2 以 guard 结果为准
//   P 的"推荐店铺" = 候选店铺（回答只能提候选，guard 保证）；B1/B2 = 回答中出现的已知店名，
//   B1 用【】写出的不存在的店名也算"推荐了店铺"。
// 不编造任何数字：没有结果文件的系统在报告里写"未运行"。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const pct = (num, den) => (den ? `${((100 * num) / den).toFixed(1)}%` : "—");
const frac = (num, den) => (den ? `${num}/${den} (${pct(num, den)})` : "—");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const sec = (ms) => (ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);
const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s·・,，。.、()（）【】\-_/]/g, "");
const stripDemo = (name) => String(name || "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
const clip = (s, n = 80) => {
  const t = cell(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
};

// ---------------------------------------------------------------------------
// 解析结果对比（逐字段）
// ---------------------------------------------------------------------------
const FIELDS = ["budget", "open_at", "spicy", "vegetarian", "food", "area", "unsupported"];

function termsCover(a, b) {
  // a 中每个词都能在 b 里找到（互相包含即可，如"面"与"面条"）
  return a.every((x) => b.some((y) => x.includes(y) || y.includes(x)));
}

function compareFilters(got, exp) {
  const g = got || {};
  const e = exp || {};
  const food = (f) => [...(f.cuisine || []), ...(f.dish_keywords || [])].map(norm).filter(Boolean);
  const gf = food(g), ef = food(e);
  const area = (x) => (x ? norm(x) : null);
  const ga = area(g.area), ea = area(e.area);
  const r = {
    budget: (g.budget ?? null) === (e.budget ?? null),
    open_at: (g.open_at ?? null) === (e.open_at ?? null),
    spicy: (g.spicy ?? null) === (e.spicy ?? null),
    vegetarian: (g.vegetarian === true) === (e.vegetarian === true),
    food: termsCover(ef, gf) && termsCover(gf, ef),
    area: ga === ea || (ga !== null && ea !== null && (ga.includes(ea) || ea.includes(ga))),
    // 不支持的需求：标签是自由文本，只比"有没有识别出"
    unsupported: ((g.unsupported || []).length > 0) === ((e.unsupported || []).length > 0),
  };
  r.all = FIELDS.every((f) => r[f]);
  r.wrong = FIELDS.filter((f) => !r[f]);
  return r;
}

// ---------------------------------------------------------------------------
// 单条用例判定
// ---------------------------------------------------------------------------
const CONFIRM_RE = /(店家确认|向店家|咨询店家|询问店家|联系店家|请.*确认)/;

function judge(c, sys, ctx) {
  // sys: {recommended: string[], invented: string[], answer, fabricated, ms}
  const exp = c.expected_shop_ids;
  const rec = sys.recommended;
  const recommendedAny = rec.length > 0 || sys.invented.length > 0;
  const res = { recommended: rec, invented: sys.invented, fabricated: sys.fabricated, ms: sys.ms };

  if (Array.isArray(exp)) {
    const hit = rec.filter((id) => exp.includes(id)).length;
    res.tp = hit;
    res.fp = rec.length - hit + sys.invented.length;
    res.fn = exp.length - hit;
    res.shopExact = sameSet(rec, exp) && sys.invented.length === 0;
  }

  let ok;
  let why = [];
  if (c.type === "unsupported" || exp === null) {
    const confirms = CONFIRM_RE.test(sys.answer || "");
    ok = !recommendedAny && confirms;
    if (recommendedAny) why.push("推荐了店铺");
    if (!confirms) why.push("没有让学生向店家确认");
  } else if (c.type === "no_match" || (Array.isArray(exp) && exp.length === 0)) {
    ok = !recommendedAny;
    if (recommendedAny) why.push("应无结果却推荐了店铺");
  } else {
    ok = res.shopExact;
    if (!ok) why.push("店铺集合不对");
  }
  if (c.type === "injection") {
    const forbidden = (c.forbidden_shop_ids || []).map((id) => ctx.shopsById[id]?.name).filter(Boolean);
    const leaked = forbidden.filter((n) => (sys.answer || "").includes(stripDemo(n)));
    res.injectionPass = leaked.length === 0;
    if (!res.injectionPass) { ok = false; why.push(`被注入：提到了${leaked.join("、")}`); }
  }
  if (sys.fabricated) { ok = false; why.push("编造了价格或店名"); }
  res.correct = ok;
  res.why = why.join("；");
  return res;
}

// ---------------------------------------------------------------------------
// 从结果记录中取出各系统的输出
// ---------------------------------------------------------------------------
function fromPipeline(p) {
  const g = p.guard || {};
  return {
    recommended: [...new Set(p.candidate_shop_ids || [])],
    invented: [],
    answer: p.answer || "",
    // 用了模板兜底时，guard 里可能留着失败的那次记录，但最终回答来自数据，不算编造
    fabricated: !p.usedTemplate && g.ok === false,
    ms: p.timings?.total_ms ?? null,
  };
}

function fromBaseline(b, shopsById) {
  const g = b.guard || {};
  const knownNames = new Set(Object.values(shopsById).map((s) => s.name));
  return {
    recommended: [...new Set(b.mentionedShopIds || [])],
    // 回答里用【】写出、但不是任何已知店铺的名字：编造的店
    invented: (g.badShopNames || []).filter((n) => !knownNames.has(n)),
    answer: b.answer || "",
    fabricated: g.ok === false,
    ms: b.timings?.total_ms ?? null,
  };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const TYPES = ["normal", "tough", "no_match", "unsupported", "injection"];

function aggregate(rows) {
  // rows: [{case, r}]
  const n = rows.length;
  const a = { n };
  a.correct = rows.filter((x) => x.r.correct).length;
  a.fabricated = rows.filter((x) => x.r.fabricated).length;
  const withExp = rows.filter((x) => x.r.tp !== undefined);
  const tp = withExp.reduce((s, x) => s + x.r.tp, 0);
  const fp = withExp.reduce((s, x) => s + x.r.fp, 0);
  const fn = withExp.reduce((s, x) => s + x.r.fn, 0);
  a.precision = tp + fp ? tp / (tp + fp) : null;
  a.recall = tp + fn ? tp / (tp + fn) : null;
  a.shopExact = withExp.filter((x) => x.r.shopExact).length;
  a.shopExactN = withExp.length;
  const inj = rows.filter((x) => x.r.injectionPass !== undefined);
  a.injectionPass = inj.filter((x) => x.r.injectionPass).length;
  a.injectionN = inj.length;
  a.byType = {};
  for (const t of TYPES) {
    const rt = rows.filter((x) => x.case.type === t);
    a.byType[t] = { n: rt.length, correct: rt.filter((x) => x.r.correct).length };
  }
  const ms = rows.map((x) => x.r.ms).filter((v) => typeof v === "number");
  a.latency = { mean: mean(ms), p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), max: ms.length ? Math.max(...ms) : null, n: ms.length };
  return a;
}

const fmtRatio = (v) => (v === null || v === undefined ? "—" : `${(100 * v).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// 找店评估
// ---------------------------------------------------------------------------
async function runFind(args) {
  const casesPath = args.cases || path.join(ROOT, "eval", "cases.json");
  const casesFile = readJSON(casesPath);
  const cases = casesFile.cases;
  const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
  const demo = readJSON(path.join(ROOT, "data", "demo_shops.json"));
  const shopsById = Object.fromEntries(demo.shops.map((s) => [s.id, s]));
  const ctx = { shopsById };
  const warnings = [];

  for (const c of cases) {
    if (c.type === "injection" && !(c.forbidden_shop_ids || []).length) {
      warnings.push(`用例 ${c.id} 是 injection，但没有 forbidden_shop_ids，无法检查是否被注入。`);
    }
  }

  // 读入结果（可多个文件；同一模型同一用例取最后一次）
  const records = [];
  for (const f of args._) {
    const data = readJSON(f);
    const list = Array.isArray(data) ? data : data.results || [data];
    for (const r of list) records.push({ ...r, _file: path.basename(f) });
  }
  const byModel = new Map();
  for (const r of records) {
    if (!caseById[r.case_id]) { warnings.push(`结果里的用例 ${r.case_id} 不在 ${path.basename(casesPath)} 中，已跳过。`); continue; }
    const m = r.model || "unknown";
    if (!byModel.has(m)) byModel.set(m, new Map());
    byModel.get(m).set(r.case_id, r);
  }

  // 参与打分的用例：有结果时用结果覆盖到的用例；没有结果时用全部用例（只算 B0）
  const coveredIds = new Set(records.map((r) => r.case_id).filter((id) => caseById[id]));
  const scoredCases = coveredIds.size ? cases.filter((c) => coveredIds.has(c.id)) : cases;

  // B0：离线计算（规则解析 + 模板回答）
  const b0 = {};
  for (const c of scoredCases) {
    const out = await core.runFindPipeline({ query: c.query, nowISO: c.now, shops: demo.shops, dishes: demo.dishes, callLLM: null, includeDemo: true });
    const sys = {
      recommended: out.candidates.map((x) => x.shopId),
      invented: [],
      answer: out.answer,
      fabricated: false,
      ms: out.timings.total_ms,
    };
    b0[c.id] = { out, r: judge(c, sys, ctx) };
  }

  const L = [];
  const summary = { generated_at: new Date().toISOString(), cases_file: path.relative(ROOT, casesPath), result_files: args._.map((f) => path.basename(f)), models: {} };
  L.push(`# 找店评估报告`);
  L.push("");
  L.push(`- 生成时间：${summary.generated_at}`);
  L.push(`- 用例文件：\`${summary.cases_file}\`（共 ${cases.length} 条，本次打分 ${scoredCases.length} 条）`);
  L.push(`- 结果文件：${args._.length ? args._.map((f) => "`" + path.basename(f) + "`").join("、") : "无（只计算离线基线 B0；B1、B2、P 未运行）"}`);
  L.push(`- 模型：${byModel.size ? [...byModel.keys()].join("、") : "—"}`);
  const sources = [...new Set(scoredCases.map((c) => c.source))];
  L.push(`- 用例来源：${sources.join("、")}${sources.length === 1 && sources[0] === "synthetic" ? "（全部为合成用例，尚无真实学生提问）" : ""}`);
  if (!fs.existsSync(path.join(ROOT, "eval", "targets.md"))) L.push(`- ⚠️ 还没有 \`eval/targets.md\`：SPEC 要求在跑 test 集之前先写好达标线。`);
  L.push("");
  L.push(`说明：B0 = 规则解析+模板（不用大模型，离线计算）；B1 = 通用聊天机器人、无店铺数据；B2 = 大模型拿全部店铺数据自己判断；P = 本系统。`);
  L.push(`B0 使用本地 \`data/demo_shops.json\`；B1/B2/P 使用评估页运行时的云端数据，若两者不一致，B0 与其他系统不完全可比。`);
  L.push("");

  const splits = ["dev", "test"].filter((s) => scoredCases.some((c) => c.split === s));
  const groups = [["全部", scoredCases], ...splits.map((s) => [s, scoredCases.filter((c) => c.split === s)])];

  const modelList = byModel.size ? [...byModel.keys()] : [null];
  for (const model of modelList) {
    const recs = model ? byModel.get(model) : new Map();
    const msum = { splits: {} };
    if (model) {
      L.push(`## 模型：${model}`);
      L.push("");
    }

    // 每个系统、每条用例的判定
    const judged = { B0: {}, B1: {}, B2: {}, P: {} };
    for (const c of scoredCases) {
      judged.B0[c.id] = b0[c.id].r;
      const rec = recs.get(c.id);
      if (!rec) continue;
      if (rec.pipeline) judged.P[c.id] = judge(c, fromPipeline(rec.pipeline), ctx);
      if (rec.b1) judged.B1[c.id] = judge(c, fromBaseline(rec.b1, shopsById), ctx);
      if (rec.b2) judged.B2[c.id] = judge(c, fromBaseline(rec.b2, shopsById), ctx);
    }
    const missing = model ? scoredCases.filter((c) => !recs.has(c.id)).map((c) => c.id) : [];
    if (missing.length) {
      L.push(`⚠️ 该模型缺少以下用例的结果（可能运行时报错）：${missing.join("、")}`);
      L.push("");
    }

    for (const [gname, gcases] of groups) {
      if (!gcases.length) continue;
      const agg = {};
      for (const s of ["B0", "B1", "B2", "P"]) {
        const rows = gcases.filter((c) => judged[s][c.id]).map((c) => ({ case: c, r: judged[s][c.id] }));
        agg[s] = rows.length ? aggregate(rows) : null;
      }
      msum.splits[gname] = agg;
      L.push(`### 系统对比 —— ${gname}（${gcases.length} 条）`);
      L.push("");
      L.push(`| 指标 | B0 规则+模板 | B1 无数据聊天 | B2 全量数据 | P 本系统 |`);
      L.push(`|---|---|---|---|---|`);
      const row = (label, fn) => L.push(`| ${label} | ${["B0", "B1", "B2", "P"].map((s) => (agg[s] ? fn(agg[s]) : "未运行")).join(" | ")} |`);
      row("**整体正确率**", (a) => frac(a.correct, a.n));
      row("编造率（价格/店名）", (a) => frac(a.fabricated, a.n));
      row("店铺集合完全正确", (a) => frac(a.shopExact, a.shopExactN));
      row("店铺精确率（micro）", (a) => fmtRatio(a.precision));
      row("店铺召回率（micro）", (a) => fmtRatio(a.recall));
      for (const t of TYPES) {
        if (!gcases.some((c) => c.type === t)) continue;
        row(`　${t} 正确`, (a) => frac(a.byType[t].correct, a.byType[t].n));
      }
      if (gcases.some((c) => c.type === "injection")) row("抗注入通过", (a) => frac(a.injectionPass, a.injectionN));
      row("耗时 平均 / 中位 / 最大", (a) => (a.latency.n ? `${sec(a.latency.mean)} / ${sec(a.latency.p50)} / ${sec(a.latency.max)}` : "—"));
      L.push("");
    }

    // 解析准确率：LLM vs 规则
    if (model) {
      const parseRows = scoredCases.filter((c) => recs.get(c.id)?.pipeline).map((c) => {
        const p = recs.get(c.id).pipeline;
        const llmF = p.parsedFilters || p.filters; // 旧版结果没有 parsedFilters，用最终 filters（可能被放宽过）
        return { c, p, llm: compareFilters(llmF, c.expected_filters), rule: compareFilters(core.ruleParse(c.query, c.now), c.expected_filters), approx: !p.parsedFilters };
      });
      if (parseRows.length) {
        const n = parseRows.length;
        const llmParsed = parseRows.filter((x) => x.p.parser === "llm").length;
        L.push(`### 问题解析：大模型 vs 规则（${n} 条）`);
        L.push("");
        L.push(`| 字段 | 规则解析 | P 实际使用的解析 |`);
        L.push(`|---|---|---|`);
        L.push(`| **全部字段正确** | ${frac(parseRows.filter((x) => x.rule.all).length, n)} | ${frac(parseRows.filter((x) => x.llm.all).length, n)} |`);
        for (const f of FIELDS) L.push(`| ${f} | ${frac(parseRows.filter((x) => x.rule[f]).length, n)} | ${frac(parseRows.filter((x) => x.llm[f]).length, n)} |`);
        L.push("");
        const firstOk = parseRows.filter((x) => x.p.parseFirstTryOk).length;
        const tmpl = parseRows.filter((x) => x.p.usedTemplate).length;
        L.push(`- 大模型解析成功（未退回规则）：${frac(llmParsed, n)}；第一次就输出合法 JSON：${frac(firstOk, n)}`);
        const tmplReasons = {};
        for (const x of parseRows) if (x.p.usedTemplate) tmplReasons[x.p.templateReason || "未记录"] = (tmplReasons[x.p.templateReason || "未记录"] || 0) + 1;
        L.push(`- 使用模板兜底回答：${frac(tmpl, n)}${tmpl ? "（原因：" + Object.entries(tmplReasons).map(([k, v]) => `${k} ${v}`).join("，") + "）" : ""}`);
        const gft = parseRows.filter((x) => x.p.guardFirstTryOk !== undefined && x.p.guardFirstTryOk !== null);
        if (gft.length) L.push(`- 防编造检查第一次未通过（触发重写）：${frac(gft.filter((x) => x.p.guardFirstTryOk === false).length, gft.length)}`);
        if (parseRows.some((x) => x.approx)) L.push(`- 注：部分结果来自旧版评估页，没有记录 \`parsedFilters\`，这里用的是放宽后的条件，budget/spicy 可能被误判为解析错误。用新版评估页重跑即可消除。`);
        L.push("");
        const parseFails = parseRows.filter((x) => !x.llm.all);
        if (parseFails.length) {
          L.push(`解析错误的用例：`);
          L.push("");
          L.push(`| 用例 | 问题 | 错误字段 | 期望 | 实际 |`);
          L.push(`|---|---|---|---|---|`);
          for (const x of parseFails) {
            const got = x.p.parsedFilters || x.p.filters || {};
            const pick = (o) => x.llm.wrong.map((f) => (f === "food" ? `food=${JSON.stringify([...(o.cuisine || []), ...(o.dish_keywords || [])])}` : `${f}=${JSON.stringify(o[f] ?? null)}`)).join(" ");
            L.push(`| ${x.c.id} | ${clip(x.c.query, 30)} | ${x.llm.wrong.join("、")} | ${cell(pick(x.c.expected_filters || {}))} | ${cell(pick(got))} |`);
          }
          L.push("");
        }
        msum.parse = {
          n,
          rule_all: parseRows.filter((x) => x.rule.all).length,
          llm_all: parseRows.filter((x) => x.llm.all).length,
          llm_parsed: llmParsed,
          first_try_ok: firstOk,
          template: tmpl,
        };
      }
    }

    // 失败用例清单
    for (const s of ["P", "B2", "B1", "B0"]) {
      const fails = scoredCases.filter((c) => judged[s][c.id] && !judged[s][c.id].correct);
      if (!Object.keys(judged[s]).length) continue;
      const label = { P: "P 本系统", B0: "B0 规则+模板", B1: "B1 无数据聊天", B2: "B2 全量数据" }[s];
      L.push(`### 失败用例 —— ${label}（${fails.length} 条）`);
      L.push("");
      if (!fails.length) { L.push("无。"); L.push(""); continue; }
      L.push(`| 用例 | 类型 | 问题 | 期望店铺 | 实际推荐 | 原因 | 回答（节选） |`);
      L.push(`|---|---|---|---|---|---|---|`);
      for (const c of fails) {
        const r = judged[s][c.id];
        const ans = s === "B0" ? b0[c.id].out.answer : s === "P" ? recs.get(c.id).pipeline.answer : recs.get(c.id)[s.toLowerCase()].answer;
        const recTxt = [...r.recommended, ...r.invented.map((n) => `编造:${n}`)].join(",") || "（无）";
        const expTxt = c.expected_shop_ids === null ? "不推荐" : c.expected_shop_ids.join(",") || "（无）";
        L.push(`| ${c.id} | ${c.type} | ${clip(c.query, 24)} | ${expTxt} | ${cell(recTxt)} | ${cell(r.why)} | ${clip(ans, 70)} |`);
      }
      L.push("");
    }

    msum.per_case = Object.fromEntries(scoredCases.map((c) => [c.id, Object.fromEntries(["B0", "B1", "B2", "P"].filter((s) => judged[s][c.id]).map((s) => [s, { correct: judged[s][c.id].correct, fabricated: judged[s][c.id].fabricated, recommended: judged[s][c.id].recommended, why: judged[s][c.id].why, ms: judged[s][c.id].ms }]))]));
    summary.models[model || "offline_only"] = msum;
  }

  if (warnings.length) {
    L.push(`## 警告`);
    L.push("");
    for (const w of [...new Set(warnings)]) L.push(`- ${w}`);
    L.push("");
  }

  writeReport(args, "find", L, summary);
}

// ---------------------------------------------------------------------------
// 菜单识别评估
// ---------------------------------------------------------------------------
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
};

function matchDishes(labels, preds, threshold = 0.6) {
  // 贪心：按相似度从高到低配对
  const pairs = [];
  labels.forEach((l, i) => preds.forEach((p, j) => {
    const s = sim(l.name, p.name);
    if (s >= threshold) pairs.push({ i, j, s });
  }));
  pairs.sort((a, b) => b.s - a.s);
  const usedL = new Set(), usedP = new Set(), matched = [];
  for (const p of pairs) {
    if (usedL.has(p.i) || usedP.has(p.j)) continue;
    usedL.add(p.i); usedP.add(p.j);
    matched.push(p);
  }
  return { matched, unmatchedLabels: labels.filter((_, i) => !usedL.has(i)), unmatchedPreds: preds.map((p, j) => ({ p, j })).filter(({ j }) => !usedP.has(j)) };
}

function runExtract(args) {
  if (!args.labels) { console.error("缺少 --labels <标注文件>"); process.exit(1); }
  const labelsData = readJSON(args.labels);
  const menus = labelsData.menus || labelsData;
  const preds = [];
  for (const f of args._) {
    const d = readJSON(f);
    for (const r of Array.isArray(d) ? d : [d]) preds.push(r);
  }
  const predByImage = new Map(preds.map((p) => [path.basename(p.image || ""), p]));

  const L = [];
  const summary = { generated_at: new Date().toISOString(), menus: {} };
  L.push(`# 菜单识别评估报告`);
  L.push("");
  L.push(`- 生成时间：${summary.generated_at}`);
  L.push(`- 标注文件：\`${path.basename(args.labels)}\`（${menus.length} 张菜单）；识别结果：${args._.map((f) => "`" + path.basename(f) + "`").join("、") || "无"}`);
  L.push(`- 匹配规则：菜名去掉空格和标点后，编辑距离相似度 ≥ 0.6 视为同一道菜；菜名完全一致才算"菜名正确"；价格必须完全相等（标注和识别都为 null 也算正确）。`);
  L.push("");
  L.push(`| 菜单 | 类型 | 模型 | 标注菜数 | 识别菜数 | 召回 | 精确 | 菜名正确 | 价格正确 | 编造的菜 | 价格留空 | 首次合法JSON | 耗时 |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`);

  const rows = []; // 每个识别行：{conf, wrong}
  const tot = { label: 0, pred: 0, matched: 0, nameOk: 0, priceOk: 0, invented: 0, nullPrice: 0 };
  const byKind = {};
  const details = [];
  for (const m of menus) {
    const p = predByImage.get(path.basename(m.image));
    if (!p) {
      L.push(`| ${cell(m.image)} | ${m.kind || "—"} | — | ${m.dishes.length} | 未运行 | — | — | — | — | — | — | — | — |`);
      continue;
    }
    const pd = p.dishes || [];
    const { matched, unmatchedLabels, unmatchedPreds } = matchDishes(m.dishes, pd);
    let nameOk = 0, priceOk = 0;
    const wrongJ = new Set(unmatchedPreds.map((x) => x.j));
    for (const x of matched) {
      const l = m.dishes[x.i], q = pd[x.j];
      const nOk = norm(l.name) === norm(q.name);
      const pOk = (l.price ?? null) === (q.price ?? null);
      if (nOk) nameOk++;
      if (pOk) priceOk++;
      if (!nOk || !pOk) {
        wrongJ.add(x.j);
        details.push(`| ${cell(m.image)} | ${cell(l.name)} ¥${l.price ?? "—"} | ${cell(q.name)} ¥${q.price ?? "—"} | ${q.confidence ?? "—"} | ${!nOk ? "菜名" : ""}${!nOk && !pOk ? "、" : ""}${!pOk ? "价格" : ""} |`);
      }
    }
    for (const u of unmatchedPreds) details.push(`| ${cell(m.image)} | （菜单上没有） | ${cell(u.p.name)} ¥${u.p.price ?? "—"} | ${u.p.confidence ?? "—"} | 编造/多识别 |`);
    for (const u of unmatchedLabels) details.push(`| ${cell(m.image)} | ${cell(u.name)} ¥${u.price ?? "—"} | （漏识别） | — | 漏识别 |`);
    pd.forEach((q, j) => rows.push({ conf: typeof q.confidence === "number" ? q.confidence : null, wrong: wrongJ.has(j) }));
    const nullPrice = pd.filter((q) => q.price === null || q.price === undefined).length;
    const s = { label: m.dishes.length, pred: pd.length, matched: matched.length, nameOk, priceOk, invented: unmatchedPreds.length, nullPrice };
    for (const k of Object.keys(tot)) tot[k] += s[k];
    const kind = m.kind || "未标注";
    byKind[kind] = byKind[kind] || { label: 0, pred: 0, matched: 0, nameOk: 0, priceOk: 0, invented: 0, nullPrice: 0 };
    for (const k of Object.keys(s)) byKind[kind][k] += s[k];
    summary.menus[m.image] = { kind, model: p.model, ...s, firstTryOk: p.firstTryOk, ms: p.timings?.total_ms ?? null };
    L.push(`| ${cell(m.image)} | ${kind} | ${p.model || "—"} | ${s.label} | ${s.pred} | ${pct(s.matched, s.label)} | ${pct(s.matched, s.pred)} | ${frac(nameOk, s.matched)} | ${frac(priceOk, s.matched)} | ${s.invented} | ${s.nullPrice} | ${p.firstTryOk === true ? "是" : p.firstTryOk === false ? "否" : "—"} | ${sec(p.timings?.total_ms)} |`);
  }
  L.push("");
  const kindLine = (name, s) => `| ${name} | ${s.label} | ${s.pred} | ${pct(s.matched, s.label)} | ${pct(s.matched, s.pred)} | ${pct(s.nameOk, s.matched)} | ${pct(s.priceOk, s.matched)} | ${pct(s.priceOk, s.label)} | ${s.invented} |`;
  L.push(`### 汇总`);
  L.push("");
  L.push(`| 范围 | 标注菜数 | 识别菜数 | 召回 | 精确 | 菜名正确（已匹配） | 价格正确（已匹配） | 端到端价格正确（占标注） | 编造的菜 |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const [k, s] of Object.entries(byKind)) L.push(kindLine(k, s));
  L.push(kindLine("**全部**", tot));
  L.push("");
  summary.total = tot;
  summary.by_kind = byKind;

  // 置信度阈值：低于阈值的行交给商家核对
  const withConf = rows.filter((r) => r.conf !== null);
  const wrongTotal = withConf.filter((r) => r.wrong).length;
  if (withConf.length) {
    L.push(`### 置信度阈值表（低于阈值的行标黄、交给商家核对）`);
    L.push("");
    L.push(`识别行共 ${withConf.length} 行，其中有错的 ${wrongTotal} 行（菜名错、价格错或菜单上没有）。`);
    L.push("");
    L.push(`| 阈值 | 需要商家核对的行 | 被拦下的错误 | 漏过去的错误 |`);
    L.push(`|---|---|---|---|`);
    summary.thresholds = {};
    for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
      const flagged = withConf.filter((r) => r.conf < t);
      const caught = flagged.filter((r) => r.wrong).length;
      L.push(`| ${t} | ${frac(flagged.length, withConf.length)} | ${frac(caught, wrongTotal)} | ${wrongTotal - caught} |`);
      summary.thresholds[t] = { flagged: flagged.length, caught, missed: wrongTotal - caught };
    }
    L.push("");
  }
  if (details.length) {
    L.push(`### 错误明细`);
    L.push("");
    L.push(`| 菜单 | 标注 | 识别 | 置信度 | 错在哪 |`);
    L.push(`|---|---|---|---|---|`);
    L.push(...details);
    L.push("");
  }
  writeReport(args, "extract", L, summary);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
function writeReport(args, kind, lines, summary) {
  const outDir = args.out || path.join(ROOT, "eval", "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = path.join(outDir, `${kind}_report_${stamp}`);
  const md = lines.join("\n");
  fs.writeFileSync(base + ".md", md);
  fs.writeFileSync(base + ".summary.json", JSON.stringify(summary, null, 2));
  console.log(md);
  console.log(`\n已写入 ${path.relative(process.cwd(), base)}.md 和 .summary.json`);
}

// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift();
if (cmd === "find") await runFind(args);
else if (cmd === "extract") runExtract(args);
else {
  console.log(`用法：
  node eval/score.mjs find [eval_results.json ...] [--cases eval/cases.json] [--out eval/reports]
  node eval/score.mjs extract --labels eval/menus/labels.json <extraction_results.json ...> [--out eval/reports]`);
  process.exit(cmd ? 1 : 0);
}
