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
    return rpc("create_shop", { p_join_passcode: joinPasscode, p_shop: shop, p_dishes: dishes }); // → {shop_id, manage_code}
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
