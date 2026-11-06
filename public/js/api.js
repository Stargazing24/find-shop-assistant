// api.js — 页面读写数据的唯一入口（ES module）
//
// 页面只调用这里导出的函数，不直接访问数据库或接口。
// 后端有两种实现，接口完全相同：
//   - "local"：backend-local.js，数据存在当前浏览器（演示/开发用，数据库建好之前的默认值）
//   - "cloud"：backend-cloud.js，云数据库（目前是 WorkBuddy 云服务）
// 切换方法：网址加 ?backend=cloud 或 ?backend=local（会记住）；或修改下面的 DEFAULT_BACKEND。
// 以后迁移后端：重写 backend-cloud.js，或者新增一个实现了同样方法的文件，在这里切换。
//
// 页面使用前需先加载（classic script）：SDK → /config.js → /app.js（提供 callLLM 和云端连接），
// 然后在 <script type="module"> 里 import 本文件。
//
// ─────────────────────────────────────────────────────────────────────────────
// 数据结构见 SPEC.md 第 4 节（Shop / Dish / Promotion）。所有函数失败时抛出 Error（logEvent 除外）。
//
// 【公共】
// BACKEND: "local" | "cloud"         当前使用的后端
// DEMO_MODE: boolean                  true 时学生端包含 is_demo 的演示店
// setBackend(mode)                    切换后端并刷新页面
//
// 【学生（匿名）】
// getVerifiedShopsAndDishes() → {shops, dishes, promotions}
//     全部 verified=true 的店、它们的菜品、active=true 的优惠（是否在有效期内由页面用 util.isPromoActive 判断）。同一页面内缓存。
// getShop(id) → {shop, dishes, promotions} | null
//     店铺不存在或未核实时返回 null。
// findShops(query) → core.runFindPipeline 的返回值
//     （answer、candidates 最多 3 家、filters、unknownHoursShopIds…）。同时写一条 query_logs。
// logEvent({event, shopId?, source?, filters?, resultCount?}) → void
//     event: "impression" | "card_click" | "shop_view" | "filter_used"；source: "list" | "filter" | "ai" | "direct"。
//     匿名，不含个人信息；失败静默。也可传数组批量写入。
//
// 【商家（店铺管理码在后端校验，前端不保存明文）】
// extractMenu(images) → core.runExtraction 的返回值   images: data URL 数组（1–3 张）
// logExtraction(entry) → void                          写 extraction_logs，失败静默
// createShop(joinPasscode, shop, dishes) → {shopId, manageCode}   manageCode 只返回这一次
// openMyShop(manageCode) → {shop, dishes, promotions} | null      管理码错误返回 null
// updateShop(manageCode, fields) → void       fields 可含 name/cuisine/area/address/avg_price/opening_hours/services/description/contact/notice
// replaceDishes(manageCode, dishes) → void    整批替换本店菜品
// savePromotion(manageCode, promotion) → {id} 有 id 则修改，没有则新增
// setPromotionActive(manageCode, promoId, active) → void
// getShopStats(manageCode, days=7) → {days, impressions, clicks, views, ctr, aiRecommended,
//                                      sources[{key,count}], topFilters[{key,count}], unmetDemand[{label,via,count}]}
//
// 【管理员（管理员口令在后端校验）】
// adminLogin(passcode) → boolean
// getAdminOverview(passcode, days=7) → {days, totals{...}, byDay[...], topFilters, unmetDemand, areas, ranking, recentQueries}
//     结构见 stats.js adminOverview()
// listAllShops(passcode) → Shop[]（含未核实；附 dishCount、promoCount、hasManageCode）
// setShopVerified(passcode, shopId, verified) → void
// resetManageCode(passcode, shopId) → string   新管理码，只返回这一次
// resetLocalData() → void                      仅本地模式：清空并重新导入演示数据
// ─────────────────────────────────────────────────────────────────────────────

import * as core from "../core.mjs";
import { local } from "./backend-local.js";
import { cloud } from "./backend-cloud.js";

const DEFAULT_BACKEND = "local"; // 云端 RPC 建好后改为 "cloud"
export const DEMO_MODE = true;   // 有真实店铺后改为 false

function pickBackend() {
  let m = null;
  try {
    m = new URLSearchParams(location.search).get("backend");
    if (m === "local" || m === "cloud") localStorage.setItem("fsa_backend", m);
    else m = localStorage.getItem("fsa_backend");
  } catch { /* 隐私模式等 */ }
  return m === "cloud" || m === "local" ? m : DEFAULT_BACKEND;
}

export const BACKEND = pickBackend();
const B = BACKEND === "cloud" ? cloud : local;

export function setBackend(mode) {
  try { localStorage.setItem("fsa_backend", mode); } catch {}
  const u = new URL(location.href);
  u.searchParams.delete("backend");
  location.href = u.toString();
}

function callLLM(args) {
  if (!window.App || !window.App.callLLM) throw new Error("AI 服务未加载（缺少 app.js）");
  return window.App.callLLM(args);
}

// ---------------- 学生 ----------------
let cache = null;

export function getVerifiedShopsAndDishes() {
  if (!cache) {
    cache = B.listPublic()
      .then(({ shops, dishes, promotions }) => {
        const verified = (shops || []).filter((s) => s.verified === true && (DEMO_MODE || !s.is_demo));
        const ids = new Set(verified.map((s) => s.id));
        return {
          shops: verified,
          dishes: (dishes || []).filter((d) => ids.has(d.shop_id)),
          promotions: (promotions || []).filter((p) => ids.has(p.shop_id) && p.active === true),
        };
      })
      .catch((e) => { cache = null; throw e; });
  }
  return cache;
}

export async function getShop(id) {
  const { shops, dishes, promotions } = await getVerifiedShopsAndDishes();
  const shop = shops.find((s) => s.id === id);
  if (!shop) return null;
  return { shop, dishes: dishes.filter((d) => d.shop_id === id), promotions: promotions.filter((p) => p.shop_id === id) };
}

export async function findShops(query) {
  const { shops, dishes } = await getVerifiedShopsAndDishes();
  const result = await core.runFindPipeline({ query, nowISO: new Date().toISOString(), shops, dishes, callLLM, includeDemo: DEMO_MODE });
  B.insertQueryLog({
    query,
    filters: result.filters,
    parser: result.parser,
    candidate_shop_ids: (result.candidates || []).map((c) => c.shopId),
    answer: result.answer,
    used_template: result.usedTemplate,
    template_reason: result.templateReason,
    timings: result.timings,
    prompt_versions: result.promptVersions,
    guard: result.guard,
    model: (window.APP_CONFIG && window.APP_CONFIG.model) || null,
  }).catch((e) => console.warn("写入 query_logs 失败", e));
  return result;
}

// 匿名访问 id：浏览器内随机生成，每天更换，只用于去重
function visitId() {
  const lp = core.localParts(new Date().toISOString());
  const today = lp.y + "-" + lp.mo + "-" + lp.d; // 北京时间日期
  try {
    const v = JSON.parse(localStorage.getItem("fsa_visit") || "null");
    if (v && v.day === today) return v.id;
    // 16 位十六进制，满足数据库 visit_id 长度 8–64 的约束
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("fsa_visit", JSON.stringify({ day: today, id }));
    return id;
  } catch { return null; }
}

const EVENTS = new Set(["impression", "card_click", "shop_view", "filter_used"]);
const SOURCES = new Set(["list", "filter", "ai", "direct"]);

export function logEvent(e) {
  const list = (Array.isArray(e) ? e : [e]).filter((x) => x && EVENTS.has(x.event));
  if (!list.length) return;
  const vid = visitId();
  const rows = list.map((x) => ({
    event: x.event,
    shop_id: x.shopId ?? null,
    source: SOURCES.has(x.source) ? x.source : null,
    filters: x.filters ?? null,
    result_count: Number.isInteger(x.resultCount) ? x.resultCount : null,
    visit_id: vid,
  }));
  Promise.resolve().then(() => B.insertEvents(rows)).catch(() => {});
}

// ---------------- 商家 ----------------
export function extractMenu(images) {
  return core.runExtraction({ images, callLLM });
}
export function logExtraction(entry) {
  Promise.resolve().then(() => B.insertExtractionLog(entry)).catch(() => {});
}
export async function createShop(joinPasscode, shop, dishes) {
  const r = await B.createShop(joinPasscode, shop, dishes);
  cache = null;
  return { shopId: r.shopId ?? r.shop_id, manageCode: r.manageCode ?? r.manage_code ?? null };
}
export const openMyShop = (code) => B.openMyShop(code);
export async function updateShop(code, fields) { await B.updateShop(code, fields); cache = null; }
export async function replaceDishes(code, dishes) { await B.replaceDishes(code, dishes); cache = null; }
export async function savePromotion(code, p) { const r = await B.savePromotion(code, p); cache = null; return r; }
export async function setPromotionActive(code, id, active) { await B.setPromotionActive(code, id, active); cache = null; }
export const getShopStats = (code, days = 7) => B.getShopStats(code, days);

// ---------------- 管理员 ----------------
export const adminLogin = (pass) => B.adminLogin(pass);
export const getAdminOverview = (pass, days = 7) => B.getAdminOverview(pass, days);
export const listAllShops = (pass) => B.listAllShops(pass);
export async function setShopVerified(pass, id, v) { await B.setShopVerified(pass, id, v); cache = null; }
export const resetManageCode = (pass, id) => B.resetManageCode(pass, id);
export async function resetLocalData() {
  if (BACKEND !== "local") throw new Error("只有本地演示模式可以清空数据");
  await local.resetAll();
  cache = null;
}
