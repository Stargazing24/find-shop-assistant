// backend-local.js — 本地演示后端（数据只存在当前浏览器的 localStorage）
//
// 用途：真正的数据库和 RPC 还没建好时，让学生版、商家版、管理员版三个页面都能完整跑通。
// - 首次使用时从 /data/demo_shops.json 导入演示店铺。
// - 管理码只存 SHA-256 哈希，明文只在新建店铺或重置时返回一次。
// - 本地模式没有真正的口令保护（入驻口令、管理员口令任意输入均可），只用于演示和开发。
// 接口与 backend-cloud.js 完全一致，由 api.js 选择使用哪一个。
import { newId, isPromoActive } from "./util.js";
import { shopStats, adminOverview } from "./stats.js";

const KEY = "fsa_local_db_v1";
let db = null;

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn("本地保存失败", e); }
}

async function load() {
  if (db) return db;
  try { db = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { db = null; }
  if (!db) {
    const res = await fetch("/data/demo_shops.json");
    if (!res.ok) throw new Error("演示数据加载失败");
    const seed = await res.json();
    db = { shops: seed.shops, dishes: seed.dishes, promotions: [], events: [], queryLogs: [], extractionLogs: [], secrets: {} };
    save();
  }
  return db;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function genCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 0/O、1/I/L
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return [...a].map((n) => A[n % A.length]).join("");
}

async function setCode(shopId) {
  const code = genCode();
  db.secrets[shopId] = { hash: await sha256(shopId + ":" + code), rotated_at: new Date().toISOString() };
  save();
  return code;
}

async function shopIdByCode(code) {
  await load();
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  for (const [shopId, s] of Object.entries(db.secrets)) {
    if (s.hash === (await sha256(shopId + ":" + c))) return shopId;
  }
  return null;
}

async function requireShop(code) {
  const id = await shopIdByCode(code);
  if (!id) throw new Error("管理码错误");
  return id;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();

function normDish(d, shopId) {
  return {
    id: d.id || newId("dish"),
    shop_id: shopId,
    name: String(d.name || "").trim(),
    price: d.price ?? null,
    category: d.category ?? null,
    spicy_level: d.spicy_level ?? null,
    is_vegetarian: d.is_vegetarian ?? null,
    is_signature: d.is_signature === true,
    confidence: d.confidence ?? 1,
    source: d.source || "vendor_input",
    vendor_confirmed: d.vendor_confirmed !== false,
  };
}

const SHOP_EDITABLE = ["name", "cuisine", "area", "address", "avg_price", "opening_hours", "services", "description", "contact", "notice"];

export const local = {
  mode: "local",

  // ---------- 学生 ----------
  async listPublic() {
    await load();
    const shops = db.shops.filter((s) => s.verified === true);
    const ids = new Set(shops.map((s) => s.id));
    return clone({
      shops,
      dishes: db.dishes.filter((d) => ids.has(d.shop_id)),
      promotions: db.promotions.filter((p) => ids.has(p.shop_id) && p.active === true),
    });
  },
  async insertQueryLog(entry) {
    await load();
    db.queryLogs.push({ id: newId("q"), created_at: now(), ...clone(entry) });
    save();
  },
  async insertEvents(rows) {
    await load();
    for (const r of rows) db.events.push({ id: newId("e"), created_at: now(), ...r });
    if (db.events.length > 20000) db.events = db.events.slice(-20000);
    save();
  },
  async insertExtractionLog(entry) {
    await load();
    db.extractionLogs.push({ id: newId("x"), created_at: now(), ...clone(entry) });
    save();
  },

  // ---------- 商家 ----------
  async createShop(joinPasscode, shop, dishes) {
    await load();
    if (!shop || !String(shop.name || "").trim()) throw new Error("请填写店名");
    const id = newId("shop");
    const t = now();
    const row = { id, is_demo: false, verified: true, verified_at: t, created_at: t, updated_at: t, updated_by_merchant_at: t,
      name: "", cuisine: [], area: null, address: null, avg_price: null, opening_hours: [], services: [], description: null, contact: null, notice: null };
    for (const k of SHOP_EDITABLE) if (k in shop) row[k] = shop[k];
    db.shops.push(row);
    db.dishes.push(...(dishes || []).map((d) => normDish(d, id)));
    const manageCode = await setCode(id);
    return { shopId: id, manageCode };
  },
  async openMyShop(code) {
    const id = await shopIdByCode(code);
    if (!id) return null;
    return clone({
      shop: db.shops.find((s) => s.id === id),
      dishes: db.dishes.filter((d) => d.shop_id === id),
      promotions: db.promotions.filter((p) => p.shop_id === id),
    });
  },
  async updateShop(code, fields) {
    const id = await requireShop(code);
    const s = db.shops.find((x) => x.id === id);
    for (const k of SHOP_EDITABLE) if (k in fields) s[k] = fields[k];
    s.updated_at = s.updated_by_merchant_at = now();
    save();
  },
  async replaceDishes(code, dishes) {
    const id = await requireShop(code);
    db.dishes = db.dishes.filter((d) => d.shop_id !== id).concat((dishes || []).map((d) => normDish(d, id)));
    const s = db.shops.find((x) => x.id === id);
    s.updated_at = s.updated_by_merchant_at = now();
    save();
  },
  async savePromotion(code, p) {
    const id = await requireShop(code);
    if (!String(p.title || "").trim()) throw new Error("请填写优惠标题");
    const t = now();
    const row = {
      id: p.id || newId("promo"), shop_id: id, title: String(p.title).trim(), kind: p.kind || "other",
      value: p.value ?? null, dish_ids: p.dish_ids || [], min_spend: p.min_spend ?? null, weekdays: p.weekdays || [],
      start_time: p.start_time || null, end_time: p.end_time || null, start_date: p.start_date || null, end_date: p.end_date || null,
      note: p.note || null, active: p.active !== false, updated_at: t,
    };
    const i = db.promotions.findIndex((x) => x.id === row.id && x.shop_id === id);
    if (i >= 0) db.promotions[i] = { ...db.promotions[i], ...row };
    else db.promotions.push({ ...row, created_at: t });
    save();
    return { id: row.id };
  },
  async setPromotionActive(code, promoId, active) {
    const id = await requireShop(code);
    const p = db.promotions.find((x) => x.id === promoId && x.shop_id === id);
    if (!p) throw new Error("优惠不存在");
    p.active = !!active;
    p.updated_at = now();
    save();
  },
  async getShopStats(code, days = 7) {
    const id = await requireShop(code);
    return shopStats({ shopId: id, shop: db.shops.find((s) => s.id === id), events: db.events, queryLogs: db.queryLogs, days });
  },

  // ---------- 管理员（本地模式不校验口令） ----------
  async adminLogin() { await load(); return true; },
  async getAdminOverview(_pass, days = 7) {
    await load();
    const shops = db.shops.filter((s) => s.verified === true);
    return adminOverview({ shops, allShops: db.shops, dishes: db.dishes, promotions: db.promotions,
      events: db.events, queryLogs: db.queryLogs, days, isPromoActive });
  },
  async listAllShops() {
    await load();
    return clone(db.shops.map((s) => ({
      ...s,
      dishCount: db.dishes.filter((d) => d.shop_id === s.id).length,
      promoCount: db.promotions.filter((p) => p.shop_id === s.id && p.active).length,
      hasManageCode: !!db.secrets[s.id],
    })));
  },
  async setShopVerified(_pass, shopId, verified) {
    await load();
    const s = db.shops.find((x) => x.id === shopId);
    if (!s) throw new Error("店铺不存在");
    s.verified = !!verified;
    s.verified_at = verified ? now() : null;
    save();
  },
  async resetManageCode(_pass, shopId) {
    await load();
    if (!db.shops.find((x) => x.id === shopId)) throw new Error("店铺不存在");
    return setCode(shopId);
  },
  async resetAll() {
    localStorage.removeItem(KEY);
    db = null;
    await load();
  },
};
