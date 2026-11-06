// stats.js — 被动反馈的汇总算法（纯函数）
// 本地演示后端直接调用；云端实现时应在数据库 RPC 里按同样口径计算，输出结构保持一致。
//
// 输入数据：
//   events:    shop_events 行 [{created_at, event, shop_id, source, filters, result_count, visit_id}]
//   queryLogs: query_logs 行  [{created_at, query, filters, parser, candidate_shop_ids, used_template}]
//   shops:     shops 行
import { filtersLabel } from "./util.js";
import { localParts } from "../core.mjs";

// 按北京时间取日期 YYYY-MM-DD
function bjDate(t) {
  const p = localParts(new Date(t).toISOString());
  return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}

const DAY = 86400000;

function since(rows, days, nowMs) {
  const from = nowMs - days * DAY;
  return (rows || []).filter((r) => new Date(r.created_at).getTime() >= from);
}

function uniqVisits(rows) {
  const s = new Set();
  let anon = 0;
  for (const r of rows) r.visit_id ? s.add(r.visit_id) : anon++;
  return s.size + anon;
}

function countBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

// 单个筛选条件拆开统计（"30元内"、"不辣"…），比统计组合更直观
function filterTags(f) {
  if (!f) return [];
  return filtersLabel(f) === "无条件" ? [] : filtersLabel(f).split(" + ");
}

// 没被满足的需求：筛选结果为 0 的组合 + AI 提问无候选店的条件
export function unmetDemand(events, queryLogs, { area = null } = {}) {
  const rows = [];
  for (const e of events) {
    if (e.event !== "filter_used" || e.result_count !== 0) continue;
    const areas = (e.filters && (e.filters.areas || (e.filters.area ? [e.filters.area] : []))) || [];
    if (area && areas.length && !areas.includes(area)) continue;
    rows.push({ label: filtersLabel(e.filters), via: "筛选" });
  }
  for (const q of queryLogs) {
    if ((q.candidate_shop_ids || []).length) continue;
    if (!q.filters) continue;
    if (area && q.filters.area && q.filters.area !== area) continue;
    const label = filtersLabel(q.filters);
    if (label === "无条件") continue;
    rows.push({ label, via: "AI 提问" });
  }
  return countBy(rows, (r) => r.label + "｜" + r.via).map(({ key, count }) => {
    const [label, via] = key.split("｜");
    return { label, via, count };
  });
}

// ---------------- 商家：本店汇总 ----------------
export function shopStats({ shopId, shop, events, queryLogs, days = 7, nowMs = Date.now() }) {
  const ev = since(events, days, nowMs);
  const ql = since(queryLogs, days, nowMs);
  const mine = ev.filter((e) => e.shop_id === shopId);
  const imp = mine.filter((e) => e.event === "impression");
  const clicks = mine.filter((e) => e.event === "card_click");
  const views = mine.filter((e) => e.event === "shop_view");
  const impressions = uniqVisits(imp);
  const clickVisits = uniqVisits(clicks);
  return {
    days,
    impressions,                       // 去重后看到本店的访问数
    clicks: clickVisits,               // 去重后点开本店的访问数
    views: views.length,               // 主页被打开次数（含直接打开链接）
    ctr: impressions ? clickVisits / impressions : null,
    aiRecommended: ql.filter((q) => (q.candidate_shop_ids || []).includes(shopId)).length,
    sources: countBy(imp, (e) => e.source || "list"),
    topFilters: countBy(imp.flatMap((e) => filterTags(e.filters).map((t) => ({ t }))), (r) => r.t).slice(0, 6),
    unmetDemand: unmetDemand(ev, ql, { area: shop && shop.area }).slice(0, 8),
  };
}

// ---------------- 管理员：全站汇总 ----------------
export function adminOverview({ shops, allShops, dishes, promotions, events, queryLogs, days = 7, nowMs = Date.now(), isPromoActive }) {
  const ev = since(events, days, nowMs);
  const ql = since(queryLogs, days, nowMs);
  const nowISO = new Date(nowMs).toISOString();

  // 每日趋势
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = bjDate(nowMs - i * DAY);
    const dayEv = ev.filter((e) => bjDate(e.created_at) === key);
    byDay.push({
      date: key,
      visits: uniqVisits(dayEv),
      clicks: dayEv.filter((e) => e.event === "card_click").length,
      filters: dayEv.filter((e) => e.event === "filter_used").length,
      aiQueries: ql.filter((q) => bjDate(q.created_at) === key).length,
    });
  }

  // 各店排行
  const ranking = shops.map((s) => {
    const st = shopStats({ shopId: s.id, shop: s, events: ev, queryLogs: ql, days, nowMs });
    return { shopId: s.id, name: s.name, area: s.area, impressions: st.impressions, clicks: st.clicks, ctr: st.ctr, aiRecommended: st.aiRecommended };
  }).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  // 区域：供给（已核实店铺数）vs 需求（筛选/提问里出现该区域的次数）
  const areaNames = [...new Set(shops.map((s) => s.area).filter(Boolean))];
  const filterEv = ev.filter((e) => e.event === "filter_used");
  const areaDemand = (a) =>
    filterEv.filter((e) => (e.filters && (e.filters.areas || []).includes(a))).length +
    ql.filter((q) => q.filters && q.filters.area === a).length;
  const areas = areaNames.map((a) => ({ area: a, shops: shops.filter((s) => s.area === a).length, demand: areaDemand(a) }))
    .sort((x, y) => y.demand - x.demand);

  const noResultQ = ql.filter((q) => !(q.candidate_shop_ids || []).length).length;
  return {
    days,
    totals: {
      verifiedShops: shops.length,
      unverifiedShops: (allShops || shops).length - shops.length,
      dishes: dishes.length,
      activePromotions: (promotions || []).filter((p) => isPromoActive ? isPromoActive(p, nowISO) : p.active).length,
      visits: uniqVisits(ev),
      clicks: ev.filter((e) => e.event === "card_click").length,
      filterUses: filterEv.length,
      aiQueries: ql.length,
      aiNoResultRate: ql.length ? noResultQ / ql.length : null,
      aiTemplateRate: ql.length ? ql.filter((q) => q.used_template).length / ql.length : null,
    },
    byDay,
    topFilters: countBy(filterEv.flatMap((e) => filterTags(e.filters).map((t) => ({ t }))), (r) => r.t).slice(0, 10),
    unmetDemand: unmetDemand(ev, ql).slice(0, 12),
    areas,
    ranking,
    recentQueries: ql.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30),
  };
}
