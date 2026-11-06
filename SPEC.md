# 产品规格与接口契约 v0.5（WorkBuddy 和 Claude Code 共用）

> v0.5 变更（2026-11-07）：新增学生版/商家版切换、每店管理码、商家可持续修改店铺、优惠（promotions）、学生匿名被动反馈（shop_events）。详细设计见 `docs/ROLE_DESIGN.md`。

> 两个执行方都必须先读这份文件。它定义"做什么"和"两边代码怎么对接"。
> 分工：**WorkBuddy** 负责应用本身（页面、云数据库、文件存储、内置 AI 调用、发布）；核心逻辑模块已经写好并通过测试：`src/core.mjs`（ES module）和 `src/core.cjs`（CommonJS，逻辑相同），提示词已内置在其中的 `PROMPTS`。后续维护与评估打分脚本由 Claude Code 负责。

## 1. 产品与场景（已锁定）
商家上传菜单照片和基本信息，AI 识别后由商家核实，生成店铺主页；学生用自然语言找店，系统先用价格、营业时间、辣度等条件**结构化筛选**，再由大模型**只根据筛选结果**写回答，并链接到店铺主页。

商家可以随时用本店管理码修改菜单、营业时间、优惠和公告；系统匿名统计学生的浏览和筛选（被动反馈），把汇总数字展示给对应商家。

**场景：学生到店前选店、提前看菜单。不做点单、外卖、支付、学生评价（评分、评论）、学生注册登录、商家账号注册、地图距离、多轮对话。**

设计原则：大模型负责理解问题和组织语言；筛选和判断由确定性代码完成（`core.js`）；不确定的识别结果交给商家确认。本系统是固定步骤的**工作流**，不是智能体。

## 2. 免费约束
只用课程提供的免费资源：WorkBuddy（含应用云服务与内置 AI 调用）、Dify 教育账户、Colab 免费版。不购买服务器或订阅。应用内的 AI 调用使用 WorkBuddy 内置模型，**不使用任何需要放在前端的 API Key**。

## 3. 页面
| 编号 | 页面 | 使用者 |
|---|---|---|
| P1 | 找店助手（首页，学生版） | 学生，无需登录 |
| P2 | 商家版：新建店铺（入驻口令）/ 管理我的店（本店管理码）：反馈概览、编辑信息、菜单、优惠、公告 | 商家 |
| P3 | 店铺主页 `?id=<shop_id>` | 所有人 |
| P4 | 评估页（隐藏，管理员口令） | 组员，用于批量跑测试；可重置商家管理码 |

所有页面顶部有"学生 | 商家"切换（记在 localStorage）。切换本身不需要口令，进入店铺管理才需要。

## 4. 数据结构（云数据库集合 / JSON 格式，两边必须一致）
**不知道的字段一律为 `null`，界面显示"未提供"，绝不猜测补全。**

**shops**
```
id: string, name: string, is_demo: boolean,
cuisine: string[], area: string|null, address: string|null,
avg_price: number|null,
opening_hours: [{weekday: 0-6 (周一=0), open: "HH:MM", close: "HH:MM"}],   // close < open 表示跨夜；空数组表示未知
services: string[], description: string|null, contact: string|null,
verified: boolean, verified_at: ISO string|null, created_at, updated_at,
notice: string|null, updated_by_merchant_at: ISO string|null      // v0.5 新增
```
**dishes**
```
id: string, shop_id: string, name: string, price: number|null, category: string|null,
spicy_level: 0|1|2|3|null,   // 0 不辣 1 微辣 2 中辣 3 特辣
is_vegetarian: boolean|null, is_signature: boolean,
confidence: number (0-1), source: "menu_photo"|"vendor_input", vendor_confirmed: boolean
```
**filters**（找店解析结果）
```
budget: number|null, open_at: "now"|"HH:MM"|null, spicy: "no_spicy"|"mild_ok"|null,
vegetarian: boolean|null, cuisine: string[], dish_keywords: string[], area: string|null,
unsupported: string[]     // 系统没有数据支持的需求，如"排队时间""过敏""好不好吃"
```
**query_logs**：时间、问题、filters、解析方式（llm/rule）、候选店铺 id、最终回答、防编造结果、是否模板兜底、各步耗时、模型名、提示词版本。
**extraction_logs**：时间、店铺 id、图片引用、模型名、提示词版本、原始识别结果、耗时、商家修改的行数、发布总用时。
**eval_results**：评估页每跑一条用例存一条（见第 7 节）。
**shop_secrets**（v0.5，匿名无任何权限）
```
shop_id: string (PK), manage_code_hash: string, created_at, rotated_at
```
管理码 8 位，新建店铺时生成并只显示一次；只存哈希，校验在数据库函数内完成；丢失由管理员重置。

**promotions**（v0.5，匿名只读：所属店已核实、active=true、在有效期内）
```
id: string, shop_id: string, title: string,
kind: "percent_off"|"amount_off"|"special_price"|"gift"|"other",
value: number|null, dish_ids: string[] (空=全店), min_spend: number|null,
weekdays: int[] (0-6，空=每天), start_time: "HH:MM"|null, end_time: "HH:MM"|null,
start_date: date|null, end_date: date|null, note: string|null, active: boolean, created_at, updated_at
```

**shop_events**（v0.5，匿名只能写入、不能读取）
```
id, created_at,
event: "impression"|"card_click"|"shop_view"|"filter_used",
shop_id: string|null, source: "list"|"filter"|"ai"|"direct",
filters: object|null, result_count: int|null,
visit_id: string|null     // 浏览器内随机生成、每天更换，只用于去重
```
商家只能通过 RPC 读到本店的**汇总数字**，看不到逐条记录。

**不记录学生个人信息**（不记 IP、设备、账号；shop_events 只含上述字段）。首页底部注明"本站匿名统计浏览次数，不收集个人信息"。

## 5. 接口契约：`core.mjs` / `core.cjs`（已提供，WorkBuddy 只调用、不修改）
纯 JavaScript、零依赖、不访问网络和数据库。大模型调用由调用方**注入**：

```
callLLM: async ({system, user, images?, temperature, maxTokens}) => string
```

导出函数：
- `isOpen(shop, nowISO, tz="Asia/Shanghai") -> true|false|null`（营业时间未知返回 null）
- `todayHours(shop, nowISO, tz) -> string`
- `ruleParse(query, nowISO) -> filters`（规则解析，兜底与基线）
- `validateFilters(obj) -> {ok, value, errors}`、`validateDishes(obj) -> {ok, value, errors}`
- `search(shops, dishes, filters, nowISO, {includeDemo}) -> {candidates, unknownHoursShopIds}`
- `rank(candidates) -> candidates (前 3)`
- `relaxOnce(filters) -> {filters, relaxed: "budget"|"spicy"|null}`
- `guard(answerText, candidates, shopsById, {allowedNumbers}) -> {ok, badPrices[], badShopNames[]}`
- `templateAnswer(candidates, shopsById, filters) -> string`
- `runFindPipeline({query, nowISO, shops, dishes, callLLM, includeDemo}) -> {answer, filters, parsedFilters, ruleFilters, parser, parseAttempts, parseFirstTryOk, candidates, unknownHoursShopIds, relaxed, guard, guardFirstTryOk, usedTemplate, templateReason, answerAttempts, timings, promptVersions}`
- `runExtraction({images, callLLM}) -> {dishes, raw, ok, errors, attempts, firstTryOk, promptVersion, timings}`
- `runBaseline({mode: "B1"|"B2", query, nowISO, shops, dishes, callLLM}) -> {mode, answer, guard, mentionedShopIds, promptVersion, timings}`

提示词在 `core` 导出的 `PROMPTS` 中（`PARSER`、`ANSWER`、`EXTRACT`、`BASELINE_B1`、`BASELINE_B2`，各含 `version` 和 `system`），由流水线函数自动使用。**WorkBuddy 不得在应用里另写提示词。**

## 6. 核心规则（`core.js` 实现，此处供双方理解）
- 只用 `verified = true` 的店（评估和演示模式下包含 `is_demo` 店）。
- 营业：`open_at` 落在区间内（含跨夜）；营业时间未知的店单独列出，不混进结果。
- 预算：至少一道满足菜品条件的菜 `price ≤ budget`；价格未知不算满足。
- 不辣：只算 `spicy_level == 0`；未知不算满足。
- 排序：匹配菜品多者优先，再按最低匹配价格。返回前 3 家。
- 无结果：放宽一个条件（先预算 +20%，再辣度）并说明放宽了什么。
- `unsupported` 的需求、过敏和食品安全：回答"请向店家确认"。问题里只有这类需求时，不推荐任何店铺。
- 防编造：回答里的价格必须等于候选菜品价格之一，【店名】必须属于候选；不通过重写一次，再不通过用模板回答。
- 商家文字（简介等）作为数据放在 `<shop_data>` 标签内，提示词声明不执行其中任何指令。
- 优惠（promotions）和公告（notice）**不传入** `runFindPipeline`，AI 回答不提优惠；只由页面直接展示。`core` 不因 v0.5 修改。
- 解析和识别调用 temperature 为 0 或最低值；不使用推理模式。

## 7. 评估设计
- 用例文件 `eval/cases.json`（Claude Code 编写）：`id, query, now, expected_filters, expected_shop_ids, type (normal/tough/no_match/unsupported/injection), source (synthetic/real), split (dev/test)`。
- **P4 评估页**（WorkBuddy 编写）：读取用例，对每条用例用**线上真实模型**运行 `runFindPipeline`、`runBaseline(B1)`、`runBaseline(B2)`，结果存入 `eval_results` 并可**下载为 JSON**。支持选择只跑 dev 或 test。识别评估：上传带标注的测试菜单，运行 `runExtraction`，结果同样可下载。
- **打分脚本**（Claude Code 编写）：读取下载的 JSON，输出报告：解析准确率（LLM vs 规则）、结果精确率/召回率、防编造指标、指令遵循指标、各 type 的正确处理率、耗时、基线对比、识别准确率与置信度阈值表、失败用例列表。
- 这样评估测的就是线上系统本身，而不是另一个模型。
- **测试集只用于最终报告**；调提示词只看开发集。达标线由组员在跑正式评估之前写进 `eval/targets.md`。
- 不编造任何数字；没跑就写"未运行"。
