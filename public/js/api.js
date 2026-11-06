// api.js — 页面读取数据的唯一入口（ES module）
//
// 页面只调用这里导出的函数，不直接访问数据库或接口。
// 当前实现：调用 /app.js 里的 window.App（WorkBuddy 云服务前端 SDK，匿名只读，
//            数据库行级权限保证只返回 verified=true 的店）。
// 以后迁移/更换后端时：只重写本文件，保持下面的输入输出不变即可。
//
// 使用前页面需先加载（classic script，顺序如下）：
//   SDK → /config.js → /app.js，然后 <script type="module"> import 本文件。
//
// ─────────────────────────────────────────────────────────────────────────────
// 导出函数（输入 → 输出）
//
// DEMO_MODE: boolean
//   true 时包含 is_demo 的演示店。有真实店铺后改为 false。
//
// getVerifiedShopsAndDishes() → Promise<{ shops: Shop[], dishes: Dish[] }>
//   输入：无
//   输出：全部 verified=true 的店铺，以及这些店铺的菜品。
//         Shop / Dish 字段见 SPEC.md 第 4 节。同一页面内结果会缓存。
//   失败：抛出 Error。
//
// getShop(id) → Promise<{ shop: Shop, dishes: Dish[] } | null>
//   输入：id —— 店铺 id 字符串（如 "demo-s1"）
//   输出：该店铺及其菜品；店铺不存在或未核实时返回 null。
//   失败：抛出 Error。
//
// findShops(query) → Promise<PipelineResult>
//   输入：query —— 学生的自然语言问题（字符串）
//   输出：core.runFindPipeline 的返回值，页面主要使用：
//         answer（回答文本）、candidates（[{shopId, shopName, matchedDishes, openStatus, reasons}]，最多 3 家）、
//         filters（系统理解的条件）、unknownHoursShopIds（营业时间未知的店 id）。
//         同时写一条 query_logs（失败只在控制台警告，不影响返回）。
//   失败：抛出 Error。
// ─────────────────────────────────────────────────────────────────────────────

import * as core from "../core.mjs";

export const DEMO_MODE = true;

function app() {
  if (!window.App) throw new Error("数据服务未加载（缺少 app.js）");
  return window.App;
}

let cache = null;

export function getVerifiedShopsAndDishes() {
  if (!cache) {
    cache = app()
      .loadAll()
      .then(({ shops, dishes }) => {
        const verified = (shops || []).filter((s) => s.verified === true && (DEMO_MODE || !s.is_demo));
        const ids = new Set(verified.map((s) => s.id));
        return { shops: verified, dishes: (dishes || []).filter((d) => ids.has(d.shop_id)) };
      })
      .catch((e) => {
        cache = null; // 失败不缓存，下次重试
        throw e;
      });
  }
  return cache;
}

export async function getShop(id) {
  const { shops, dishes } = await getVerifiedShopsAndDishes();
  const shop = shops.find((s) => s.id === id);
  if (!shop) return null;
  return { shop, dishes: dishes.filter((d) => d.shop_id === id) };
}

export async function findShops(query) {
  const { shops, dishes } = await getVerifiedShopsAndDishes();
  const A = app();
  const result = await core.runFindPipeline({
    query,
    nowISO: new Date().toISOString(),
    shops,
    dishes,
    callLLM: A.callLLM,
    includeDemo: DEMO_MODE,
  });
  A.logQuery({
    query,
    filters: result.filters,
    parser: result.parser,
    candidateShopIds: (result.candidates || []).map((c) => c.shopId),
    answer: result.answer,
    usedTemplate: result.usedTemplate,
    templateReason: result.templateReason,
    timings: result.timings,
    promptVersions: result.promptVersions,
    guard: result.guard,
  }).catch(() => {});
  return result;
}
