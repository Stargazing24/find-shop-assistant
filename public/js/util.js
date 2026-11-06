// util.js — 页面共用的小工具（纯函数，不读写数据）
import { localParts } from "../core.mjs";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const WEEKDAY_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const AREAS = ["北门", "南门", "东门", "西门"]; // 演示区域，换学校时修改

export function openBadge(st) {
  if (st === true) return '<span class="badge open">营业中</span>';
  if (st === false) return '<span class="badge closed">已打烊</span>';
  return '<span class="badge unknown">营业时间未提供</span>';
}

export function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---------------- 优惠 ----------------
export const PROMO_KINDS = {
  percent_off: "折扣",
  amount_off: "满减",
  special_price: "特价",
  gift: "赠送",
  other: "其他",
};

function ymd(p) {
  return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
}

// 当前是否在有效期内（日期 + 星期 + active）。时段只作为文字展示，不据此隐藏。
export function isPromoActive(p, nowISO) {
  if (!p || p.active !== true) return false;
  const lp = localParts(nowISO);
  const today = ymd(lp);
  if (p.start_date && today < p.start_date) return false;
  if (p.end_date && today > p.end_date) return false;
  if (Array.isArray(p.weekdays) && p.weekdays.length && !p.weekdays.includes(lp.weekday)) return false;
  return true;
}

// 优惠数值的文字：percent_off 20 → "8 折"；amount_off 5 → "减 ¥5"；special_price 18 → "¥18"
export function promoValueText(p) {
  if (p.value == null) return "";
  if (p.kind === "percent_off") { const z = (100 - p.value) / 10; return z > 0 && z < 10 ? +z.toFixed(1) + " 折" : ""; }
  if (p.kind === "amount_off") return "减 ¥" + p.value;
  if (p.kind === "special_price") return "¥" + p.value;
  return "";
}

export function promoWhen(p) {
  const parts = [];
  if (Array.isArray(p.weekdays) && p.weekdays.length && p.weekdays.length < 7) parts.push(p.weekdays.map((w) => WEEKDAY_CN[w]).join("、"));
  // 数据库 time 类型返回 "11:00:00"，只显示到分钟
  if (p.start_time && p.end_time) parts.push(String(p.start_time).slice(0, 5) + "–" + String(p.end_time).slice(0, 5));
  if (p.end_date) parts.push("至 " + p.end_date);
  return parts.join(" · ");
}

// ---------------- 筛选条件的中文标签 ----------------
export function filtersLabel(f) {
  if (!f) return "无条件";
  const out = [];
  if (f.open_at === "now") out.push("营业中");
  else if (f.open_at) out.push(f.open_at + " 营业");
  if (f.budget != null) out.push(f.budget + "元内");
  if (f.spicy === "no_spicy") out.push("不辣");
  if (f.spicy === "mild_ok") out.push("不太辣");
  if (f.vegetarian === true) out.push("素食");
  if (f.promo === true) out.push("有优惠");
  for (const c of f.cuisine || []) out.push(c);
  for (const k of f.dish_keywords || []) out.push(k);
  if (Array.isArray(f.areas) && f.areas.length) out.push(f.areas.join("/"));
  else if (f.area) out.push(f.area);
  return out.length ? out.join(" + ") : "无条件";
}
