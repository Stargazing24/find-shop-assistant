# 接入说明（写给 WorkBuddy）

## 1. 引入核心模块（只在后端使用）
- ES module 环境：`import * as core from "./src/core.mjs";`
- CommonJS 环境：`const core = require("./src/core.cjs");`
- 两个文件逻辑完全相同，选一个即可，**不要修改内容**。
- 如果运行环境有 Node.js，可以执行 `node --test test/core.test.mjs` 确认文件完整（应显示 17 项全部通过）。

## 2. 把内置 AI 包装成 callLLM
`core` 不自己调用模型。请写一个函数，用 WorkBuddy 的内置 AI 调用实现，签名必须是：
```js
async function callLLM({ system, user, images, temperature, maxTokens }) {
  // system：系统提示词（字符串）
  // user：用户消息（字符串）
  // images：可选，图片数组（data URL 或图片链接），只在菜单识别时传入；需要使用支持图片输入的模型
  // temperature、maxTokens：如果内置 AI 支持就传入，不支持可以忽略
  // 返回：模型输出的纯文本字符串
}
```
建议：识别菜单用支持图片的模型；找店解析和回答可以用同一个模型，也可以用更便宜的文本模型。请在日志里记录实际使用的模型名。

## 3. 找店（P1）
```js
const result = await core.runFindPipeline({
  query, nowISO: new Date().toISOString(),
  shops, dishes,            // 从云数据库读取的全部店铺和菜品（core 会自动只用 verified=true 的店）
  callLLM,
  includeDemo: true,        // 有真实店铺后改为 false（建议做成一个配置项 DEMO_MODE）
});
```
页面使用：`result.answer`（回答文本）、`result.candidates`（结果卡片：shopId、shopName、matchedDishes、openStatus、reasons）、`result.filters`（"系统理解的条件"）、`result.unknownHoursShopIds`（营业时间未知的店）。
写入 `query_logs`：问题、`filters`、`parser`、候选店铺 id、`answer`、`guard`、`usedTemplate`、`templateReason`、`timings`、`promptVersions`、模型名、时间。

## 4. 店铺主页（P3）
`core.isOpen(shop, new Date().toISOString())` 返回 true / false / null（null 显示"营业时间未提供"）；`core.todayHours(shop, nowISO)` 返回今日营业时间文字。

## 5. 商家入驻（P2）
```js
const ex = await core.runExtraction({ images: [dataUrl1, dataUrl2], callLLM });
// ex.ok 为 false 时提示识别失败，允许手动录入；ex.dishes 为识别出的菜品（含 confidence）
```
发布时为每道菜补上 `id`、`shop_id`；商家改过或新增的行设 `confidence = 1`、`vendor_confirmed = true`、新增行 `source = "vendor_input"`。写入 `extraction_logs`：`ex.raw`、`ex.attempts`、`ex.firstTryOk`、`ex.promptVersion`、`ex.timings`、商家修改的行数、发布总用时、模型名。

## 6. 评估页（P4）
对 `eval/cases.json` 中所选 split 的每条用例：
```js
const pipeline = await core.runFindPipeline({ query: c.query, nowISO: c.now, shops, dishes, callLLM, includeDemo: true });
const b1 = await core.runBaseline({ mode: "B1", query: c.query, nowISO: c.now, shops, dishes, callLLM });
const b2 = await core.runBaseline({ mode: "B2", query: c.query, nowISO: c.now, shops, dishes, callLLM });
// 存入 eval_results：{ case_id: c.id, split: c.split, type: c.type, model, ran_at, pipeline, b1, b2 }
```
注意：用 `c.now` 作为当前时间，不要用真实时间，否则结果不可复现。评估使用 `data/demo_shops.json` 的演示数据。
"下载 JSON"按钮导出本次运行的 `eval_results` 数组。每条用例约 3–4 次模型调用，运行前请显示预计调用次数。
