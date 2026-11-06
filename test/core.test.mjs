import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as core from "../src/core.mjs";

const data = JSON.parse(fs.readFileSync(new URL("../data/demo_shops.json", import.meta.url)));
const cases = JSON.parse(fs.readFileSync(new URL("../eval/cases.json", import.meta.url))).cases;
const { shops, dishes } = data;
const byId = Object.fromEntries(shops.map((s) => [s.id, s]));
const TUE = (hm) => `2026-11-10T${hm}:00+08:00`;

test("isOpen: normal, overnight, unknown, boundaries", () => {
  assert.equal(core.isOpen(byId["demo-s1"], TUE("06:59")), false);
  assert.equal(core.isOpen(byId["demo-s1"], TUE("07:00")), true);
  assert.equal(core.isOpen(byId["demo-s1"], TUE("21:30")), false); // close is exclusive
  assert.equal(core.isOpen(byId["demo-s3"], TUE("23:59")), true);
  assert.equal(core.isOpen(byId["demo-s3"], TUE("01:30")), true);  // spill from Monday
  assert.equal(core.isOpen(byId["demo-s3"], TUE("02:00")), false);
  assert.equal(core.isOpen(byId["demo-s5"], TUE("20:00")), null);
  assert.equal(core.isOpen(byId["demo-s2"], TUE("15:00")), false); // between two ranges
  // UTC input converted to Shanghai: 11:00Z = 19:00 Shanghai
  assert.equal(core.isOpen(byId["demo-s4"], "2026-11-10T11:00:00Z"), true);
  // no offset = Shanghai local
  assert.equal(core.isOpen(byId["demo-s4"], "2026-11-10T21:00:00"), false);
});

test("weekday-specific hours and overnight spill only from previous day", () => {
  const shop = { opening_hours: [{ weekday: 4, open: "20:00", close: "03:00" }] }; // Friday night only
  assert.equal(core.isOpen(shop, "2026-11-06T21:00:00+08:00"), true);  // Fri
  assert.equal(core.isOpen(shop, "2026-11-07T02:00:00+08:00"), true);  // Sat early
  assert.equal(core.isOpen(shop, "2026-11-08T02:00:00+08:00"), false); // Sun early
  assert.equal(core.todayHours(shop, "2026-11-06T12:00:00+08:00"), "20:00–03:00（次日）");
  assert.equal(core.todayHours(shop, "2026-11-05T12:00:00+08:00"), "今日休息");
  assert.equal(core.todayHours({ opening_hours: [] }, TUE("12:00")), "未提供");
});

test("ruleParse: key patterns", () => {
  const a = core.ruleParse("30块以内、不辣、现在还开着的晚饭", TUE("19:00"));
  assert.equal(a.budget, 30); assert.equal(a.spicy, "no_spicy"); assert.equal(a.open_at, "now"); assert.deepEqual(a.dish_keywords, []);
  assert.equal(core.ruleParse("晚上11点以后还有哪家开着", TUE("20:00")).open_at, "23:00");
  assert.equal(core.ruleParse("凌晨1点还能吃面吗", TUE("23:30")).open_at, "01:00");
  assert.equal(core.ruleParse("预算二十块，不要太辣", TUE("12:00")).budget, 20);
  assert.equal(core.ruleParse("预算二十块，不要太辣", TUE("12:00")).spicy, "mild_ok");
  assert.equal(core.ruleParse("一点点辣可以", TUE("12:00")).open_at, null); // "一点" is not 1 o'clock
  assert.equal(core.ruleParse("人均三十左右", TUE("12:00")).budget, 30);
  assert.ok(core.ruleParse("哪家对花生过敏的人安全", TUE("12:00")).unsupported.includes("过敏或食品安全"));
  assert.ok(core.ruleParse("哪家排队时间短", TUE("12:00")).unsupported.includes("排队时间"));
});

test("search with expected filters returns expected shops for every scored case", () => {
  for (const c of cases) {
    if (c.expected_shop_ids === null) continue;
    const { candidates } = core.search(shops, dishes, c.expected_filters, c.now, { includeDemo: true });
    const got = core.rank(candidates).map((x) => x.shopId).sort();
    assert.deepEqual(got, [...c.expected_shop_ids].sort(), `case ${c.id}`);
  }
});

test("search: unverified shop never appears; unknown hours listed separately", () => {
  const r = core.search(shops, dishes, { open_at: "now" }, TUE("21:00"), { includeDemo: true });
  assert.ok(!r.candidates.some((c) => c.shopId === "demo-s6"));
  assert.ok(r.unknownHoursShopIds.includes("demo-s5"));
  assert.ok(!r.candidates.some((c) => c.shopId === "demo-s5"));
  const noDemo = core.search(shops, dishes, {}, TUE("12:00"), { includeDemo: false });
  assert.equal(noDemo.candidates.length, 0);
});

test("budget boundary: price equal to budget counts", () => {
  const r = core.search(shops, dishes, { budget: 12, spicy: "no_spicy" }, TUE("12:00"), { includeDemo: true }); // 皮蛋瘦肉粥 is exactly 12
  assert.deepEqual(r.candidates.map((c) => c.shopId), ["demo-s1"]);
});

test("relaxOnce order", () => {
  assert.equal(core.relaxOnce({ budget: 10, spicy: "no_spicy" }).relaxed, "budget");
  assert.equal(core.relaxOnce({ budget: 10, spicy: "no_spicy" }, ["budget"]).relaxed, "spicy");
  assert.equal(core.relaxOnce({ open_at: "now" }).relaxed, null);
});

test("guard: grounded passes, fabricated price and shop caught, budget number allowed", () => {
  const { candidates } = core.search(shops, dishes, { budget: 30, spicy: "no_spicy" }, TUE("19:00"), { includeDemo: true });
  const top = core.rank(candidates);
  const ok = core.guard("【陈记粤式粥粉面（演示）】的皮蛋瘦肉粥 12 元，符合 30 块以内。", top, byId, { allowedNumbers: [30] });
  assert.equal(ok.ok, true);
  const badPrice = core.guard("【陈记粤式粥粉面（演示）】的牛腩面只要 9 元。", top, byId, { allowedNumbers: [30] });
  assert.deepEqual(badPrice.badPrices, [9]);
  const badShop = core.guard("推荐【阿强烧烤（演示）】。", top, byId);
  assert.ok(badShop.badShopNames.includes("阿强烧烤（演示）"));
  const unbracketed = core.guard("也可以去阿强烧烤（演示）看看。", top, byId);
  assert.ok(unbracketed.badShopNames.includes("阿强烧烤（演示）"));
});

// ---- mock LLM helpers ----
function scriptedLLM(responses) {
  const calls = [];
  const fn = async (args) => { calls.push(args); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; return typeof r === "function" ? r(args) : r; };
  fn.calls = calls;
  return fn;
}

test("pipeline: LLM parse + grounded answer", async () => {
  const llm = scriptedLLM([
    '```json\n{"budget":30,"open_at":"now","spicy":"no_spicy","vegetarian":null,"cuisine":[],"dish_keywords":[],"area":null,"unsupported":[]}\n```',
    "推荐【陈记粤式粥粉面（演示）】，皮蛋瘦肉粥 12 元，现在营业中。【川味小馆（演示）】有番茄炒蛋 18 元。",
  ]);
  const r = await core.runFindPipeline({ query: "30块以内、不辣、现在还开着的晚饭", nowISO: TUE("19:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.parser, "llm"); assert.equal(r.parseFirstTryOk, true);
  assert.deepEqual(r.candidates.map((c) => c.shopId).sort(), ["demo-s1", "demo-s2", "demo-s3"]);
  assert.equal(r.usedTemplate, false); assert.equal(r.guard.ok, true);
  assert.equal(llm.calls[0].temperature, 0);
  assert.ok(llm.calls[1].user.includes("<shop_data>"));
});

test("pipeline: bad JSON twice falls back to rule parser", async () => {
  const llm = scriptedLLM(["好的，我来帮你", "not json", "【深夜面馆（演示）】清汤馄饨面 16 元。"]);
  const r = await core.runFindPipeline({ query: "晚上11点以后还有哪家开着", nowISO: TUE("20:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.parser, "rule"); assert.equal(r.parseAttempts, 2);
  assert.deepEqual(r.candidates.map((c) => c.shopId), ["demo-s3"]);
});

test("pipeline: fabricated answer twice -> template", async () => {
  const parse = '{"budget":20,"open_at":null,"spicy":null,"vegetarian":null,"cuisine":[],"dish_keywords":["面"],"area":null,"unsupported":[]}';
  const llm = scriptedLLM([parse, "【深夜面馆（演示）】牛肉面 8 元。", "【阿强烧烤（演示）】全场 9 块。"]);
  const r = await core.runFindPipeline({ query: "推荐一家能吃面的店，20块以内", nowISO: TUE("12:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.guardFirstTryOk, false); assert.equal(r.usedTemplate, true); assert.equal(r.templateReason, "guard_failed");
  assert.ok(!r.answer.includes("阿强烧烤"));
  assert.ok(llm.calls[2].user.includes("上一次回答包含数据中没有的内容"));
});

test("pipeline: unsupported-only question makes no recommendation", async () => {
  const llm = scriptedLLM(['{"budget":null,"open_at":null,"spicy":null,"vegetarian":null,"cuisine":[],"dish_keywords":[],"area":null,"unsupported":["过敏"]}']);
  const r = await core.runFindPipeline({ query: "哪家对花生过敏的人安全", nowISO: TUE("12:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.candidates.length, 0); assert.equal(r.templateReason, "only_unsupported");
  assert.ok(r.answer.includes("请向店家确认"));
  assert.equal(llm.calls.length, 1); // no answer call spent
});

test("pipeline: no match relaxes or reports none without LLM answer call", async () => {
  const llm = scriptedLLM(['{"budget":10,"open_at":null,"spicy":null,"vegetarian":null,"cuisine":["火锅"],"dish_keywords":[],"area":null,"unsupported":[]}']);
  const r = await core.runFindPipeline({ query: "10块以内的火锅", nowISO: TUE("18:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.candidates.length, 0); assert.equal(r.templateReason, "no_candidates");
  assert.ok(r.answer.includes("没有找到"));
});

test("pipeline: relaxation by budget", async () => {
  const llm = scriptedLLM(['{"budget":11,"open_at":null,"spicy":null,"vegetarian":null,"cuisine":[],"dish_keywords":["粥"],"area":null,"unsupported":[]}', "【陈记粤式粥粉面（演示）】皮蛋瘦肉粥 12 元。"]);
  const r = await core.runFindPipeline({ query: "11块以内的粥", nowISO: TUE("12:00"), shops, dishes, callLLM: llm, includeDemo: true });
  assert.equal(r.relaxed, "budget"); assert.equal(r.filters.budget, 13);
  assert.deepEqual(r.candidates.map((c) => c.shopId), ["demo-s1"]);
});

test("pipeline works with no LLM at all (rule + template)", async () => {
  const r = await core.runFindPipeline({ query: "现在想吃粥", nowISO: TUE("08:00"), shops, dishes, callLLM: null, includeDemo: true });
  assert.equal(r.parser, "rule"); assert.equal(r.templateReason, "no_llm");
  assert.deepEqual(r.candidates.map((c) => c.shopId), ["demo-s1"]);
});

test("extraction: validation, retry, null prices kept", async () => {
  const llm = scriptedLLM(["我看不清", '{"dishes":[{"name":"牛腩面","price":"22元","confidence":0.9},{"name":"例汤","price":null,"confidence":0.4},{"price":5}]}']);
  const r = await core.runExtraction({ images: ["data:image/png;base64,AAA"], callLLM: llm });
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(r.firstTryOk, false);
  assert.equal(r.dishes.length, 2); assert.equal(r.dishes[0].price, 22); assert.equal(r.dishes[1].price, null);
  assert.deepEqual(llm.calls[0].images, ["data:image/png;base64,AAA"]);
});

test("baselines: B1 names are ungrounded, B2 gets all data", async () => {
  const b1 = await core.runBaseline({ mode: "B1", query: "30块以内不辣", nowISO: TUE("12:00"), shops, dishes, callLLM: async () => "推荐【老王面馆】牛肉面 15 元。" });
  assert.equal(b1.guard.ok, false);
  let seen = "";
  const b2 = await core.runBaseline({ mode: "B2", query: "30块以内不辣", nowISO: TUE("12:00"), shops, dishes, callLLM: async (a) => { seen = a.user; return "推荐【陈记粤式粥粉面（演示）】皮蛋瘦肉粥 12 元。"; } });
  assert.ok(seen.includes("阿强烧烤（演示）") && !seen.includes("未核实小店"));
  assert.equal(b2.guard.ok, true); assert.deepEqual(b2.mentionedShopIds, ["demo-s1"]);
});
