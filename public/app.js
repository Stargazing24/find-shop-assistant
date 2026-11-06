// app.js — 应用公共基础设施：SDK 初始化、callLLM 封装、数据访问、口令校验
// 依赖：config.js（window.APP_CONFIG）、core.mjs（ES module，由各页面 import）

const cfg = window.APP_CONFIG;

// ---- 初始化云服务 SDK（CDN IIFE 全局 WorkBuddyCloud）----
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: cfg.endpoint,
  publishableKey: cfg.publishableKey,
});

// ---------------------------------------------------------------------------
// callLLM —— 把内置 AI 包装成 core 需要的签名，只返回正文，丢弃思考过程
// 签名：async ({system, user, images, temperature, maxTokens}) => string
// ---------------------------------------------------------------------------
async function callLLM({ system, user, images, temperature, maxTokens }) {
  const messages = [{ role: "system", content: system }];
  if (images && images.length) {
    const content = [{ type: "text", text: user }];
    for (const img of images) {
      content.push({ type: "image_url", image_url: { url: img } });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: user });
  }

  let text = "";
  for await (const chunk of cloud.llm.chat.completions.create({
    model: cfg.model,
    messages,
    stream: true,
    temperature: temperature ?? 0,
    max_tokens: maxTokens,
    stream_options: { include_usage: true },
  })) {
    const delta = chunk.choices?.[0]?.delta;
    // 只累加正文 content，丢弃 reasoning_content（思考过程）
    if (delta?.content) text += delta.content;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 数据访问：匿名读取已核实店铺和菜品（RLS 保证只返回 verified=true）
// ---------------------------------------------------------------------------
async function loadShops() {
  const { data, error } = await cloud.database.from("shops").select("*");
  if (error) throw error;
  return data || [];
}

async function loadDishes() {
  const { data, error } = await cloud.database.from("dishes").select("*");
  if (error) throw error;
  return data || [];
}

async function loadAll() {
  const [shops, dishes] = await Promise.all([loadShops(), loadDishes()]);
  return { shops, dishes };
}

// ---------------------------------------------------------------------------
// 口令校验（调用数据库 SECURITY DEFINER 函数，前端不存口令）
// ---------------------------------------------------------------------------
async function verifyPasscode(role, passcode) {
  const key = role === "admin" ? "admin" : "merchant";
  const { data, error } = await cloud.database.rpc("verify_passcode", {
    p_key: key,
    p_passcode: passcode,
  });
  if (error) throw error;
  return data === true;
}

// ---------------------------------------------------------------------------
// 日志写入（匿名只 INSERT）
// ---------------------------------------------------------------------------
async function logQuery(entry) {
  const { error } = await cloud.database.from("query_logs").insert({
    query: entry.query ?? null,
    filters: entry.filters ?? null,
    parser: entry.parser ?? null,
    candidate_shop_ids: entry.candidateShopIds ?? null,
    answer: entry.answer ?? null,
    used_template: entry.usedTemplate ?? null,
    template_reason: entry.templateReason ?? null,
    timings: entry.timings ?? null,
    prompt_versions: entry.promptVersions ?? null,
    model: entry.model ?? cfg.model,
    guard: entry.guard ?? null,
  });
  if (error) console.warn("写入 query_logs 失败:", error);
}

async function logExtraction(entry) {
  const { error } = await cloud.database.from("extraction_logs").insert({
    shop_id: entry.shopId ?? null,
    model: entry.model ?? cfg.model,
    prompt_version: entry.promptVersion ?? null,
    raw: entry.raw ?? null,
    timings: entry.timings ?? null,
    attempts: entry.attempts ?? null,
    first_try_ok: entry.firstTryOk ?? null,
    vendor_edited_rows: entry.vendorEditedRows ?? null,
    total_seconds: entry.totalSeconds ?? null,
  });
  if (error) console.warn("写入 extraction_logs 失败:", error);
}

// ---------------------------------------------------------------------------
// 商家发布（调用 publish_shop 函数，口令在数据库内校验）
// ---------------------------------------------------------------------------
async function publishShop(passcode, shop, dishes) {
  const { data, error } = await cloud.database.rpc("publish_shop", {
    p_passcode: passcode,
    p_shop: shop,
    p_dishes: dishes,
  });
  if (error) throw error;
  return data; // 返回 shop_id
}

// ---------------------------------------------------------------------------
// 图片压缩：长边 ≤1600 的 JPEG，转 base64 dataURL（不落文件存储）
// ---------------------------------------------------------------------------
async function compressImage(file, maxDim = 1600, quality = 0.85) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

// ---------------------------------------------------------------------------
// 导出到 window，供各页面使用
// ---------------------------------------------------------------------------
window.App = {
  cloud,
  cfg,
  callLLM,
  loadShops,
  loadDishes,
  loadAll,
  verifyPasscode,
  logQuery,
  logExtraction,
  publishShop,
  compressImage,
};
