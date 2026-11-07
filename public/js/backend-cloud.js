// backend-cloud.js — 云端后端（当前：WorkBuddy 云数据库，通过 /app.js 的 window.App）
//
// 已可用：listPublic（shops/dishes）、insertQueryLog、insertExtractionLog、adminLogin。
// 其余函数调用的是 docs/ROLE_DESIGN.md 第 6 节设计的 RPC，数据库里建好之前会报错。
// 由负责后端的一方（DeepSeek）建好 RPC，或者换平台时重写本文件；参数名见各 rpc(...) 调用。
// 接口与 backend-local.js 完全一致。

function App() {
  if (!window.App) throw new Error("云端服务未加载（缺少 app.js）");
  return window.App;
}

async function rpc(name, params) {
  const { data, error } = await App().cloud.database.rpc(name, params);
  if (error) throw new Error(`云端接口 ${name} 调用失败：${error.message || error}（如果后端还没建好，请改用本地演示模式）`);
  return data;
}

// 数据库里没有这个函数（PostgREST PGRST202）
function isMissingFunction(error) {
  return /PGRST202/.test(String(error.code || "")) || /Could not find the function/i.test(String(error.message || ""));
}

// publish_shop 是 v0.4 的函数，只传它原本认识的字段（notice 等 v0.5 字段不传）
function legacyShop(s) {
  return {
    name: s.name,
    cuisine: s.cuisine || [],
    area: s.area ?? null,
    address: s.address ?? null,
    avg_price: s.avg_price ?? null,
    opening_hours: s.opening_hours ?? null,
    services: s.services || [],
    description: s.description ?? null,
    contact: s.contact ?? null,
  };
}
function legacyDishes(list) {
  return (list || []).map((d) => ({
    id: d.id,
    name: d.name,
    price: d.price ?? null,
    category: d.category ?? null,
    spicy_level: d.spicy_level ?? null,
    is_vegetarian: d.is_vegetarian ?? null,
    is_signature: d.is_signature === true,
    confidence: d.confidence ?? null,
    source: d.source ?? null,
    vendor_confirmed: true,
  }));
}

export const cloud = {
  mode: "cloud",

  // ---------- 学生 ----------
  async listPublic() {
    const { shops, dishes } = await App().loadAll();
    let promotions = [];
    try {
      const { data, error } = await App().cloud.database.from("promotions").select("*");
      if (!error) promotions = data || [];
    } catch { /* promotions 表还没建 */ }
    return { shops, dishes, promotions };
  },
  async insertQueryLog(entry) {
    await App().logQuery({
      query: entry.query, filters: entry.filters, parser: entry.parser,
      candidateShopIds: entry.candidate_shop_ids, answer: entry.answer,
      usedTemplate: entry.used_template, templateReason: entry.template_reason,
      timings: entry.timings, promptVersions: entry.prompt_versions, guard: entry.guard,
    });
  },
  async insertEvents(rows) {
    const { error } = await App().cloud.database.from("shop_events").insert(rows);
    if (error) throw error;
  },
  async insertExtractionLog(entry) {
    await App().logExtraction(entry);
  },

  // ---------- 商家 ----------
  async createShop(joinPasscode, shop, dishes) {
    const { data, error } = await App().cloud.database.rpc("create_shop", { p_join_passcode: joinPasscode, p_shop: shop, p_dishes: dishes });
    if (!error) return data; // → {shop_id, manage_code}
    if (!isMissingFunction(error)) throw new Error(`云端接口 create_shop 调用失败：${error.message || error}`);
    // 临时方案：create_shop（数据库第 2 批）还没建好时，改用 WorkBuddy 已有的 publish_shop。
    // 口令用商家入驻口令，在数据库内校验。没有管理码，发布后不能修改；第 2 批建好后自动走上面的 create_shop。
    const r = await App().cloud.database.rpc("publish_shop", { p_passcode: joinPasscode, p_shop: legacyShop(shop), p_dishes: legacyDishes(dishes) });
    if (r.error) {
      if (/invalid passcode/i.test(String(r.error.message || ""))) throw new Error("入驻口令不正确");
      throw new Error(`云端接口 publish_shop 调用失败：${r.error.message || r.error}`);
    }
    return { shop_id: r.data, manage_code: null, legacy: true };
  },
  async openMyShop(code) {
    return rpc("open_my_shop", { p_code: code }); // → {shop, dishes, promotions} | null
  },
  async updateShop(code, fields) {
    return rpc("update_shop", { p_code: code, p_fields: fields });
  },
  async replaceDishes(code, dishes) {
    return rpc("replace_dishes", { p_code: code, p_dishes: dishes });
  },
  async savePromotion(code, promotion) {
    return rpc("save_promotion", { p_code: code, p_promotion: promotion }); // → {id}
  },
  async setPromotionActive(code, promoId, active) {
    return rpc("set_promotion_active", { p_code: code, p_id: promoId, p_active: active });
  },
  async getShopStats(code, days = 7) {
    return rpc("get_shop_stats", { p_code: code, p_days: days }); // 结构同 stats.js shopStats()
  },

  // ---------- 管理员 ----------
  async adminLogin(passcode) {
    return App().verifyPasscode("admin", passcode);
  },
  async getAdminOverview(passcode, days = 7) {
    return rpc("get_admin_overview", { p_passcode: passcode, p_days: days }); // 结构同 stats.js adminOverview()
  },
  async listAllShops(passcode) {
    return rpc("admin_list_shops", { p_passcode: passcode });
  },
  async setShopVerified(passcode, shopId, verified) {
    return rpc("admin_set_verified", { p_passcode: passcode, p_shop_id: shopId, p_verified: verified });
  },
  async resetManageCode(passcode, shopId) {
    return rpc("reset_manage_code", { p_passcode: passcode, p_shop_id: shopId }); // → 新管理码（明文，只返回一次）
  },
  async resetAll() {
    throw new Error("云端模式不支持清空数据");
  },
};
