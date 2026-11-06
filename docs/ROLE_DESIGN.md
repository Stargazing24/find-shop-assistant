# 学生版 / 商家版 设计稿 v0.1（草案，待确认）

> 目的：把"演示数据 + 一次性发布"变成真实的双向互动：
> **商家**持续维护自己的菜单、营业时间、优惠；**学生**照常找店，系统匿名记录"被动反馈"（看了哪些店、用了哪些筛选、搜了什么找不到），再汇总给商家看。
> 本文只是设计。数据库和云服务的改动要由组员或 WorkBuddy 执行（第 7 节有可以直接发给 WorkBuddy 的指令）。

---

## 1. 现状与差距

| 已有 | 缺口 |
|---|---|
| `merchant.html`：口令 → 拍菜单 → AI 识别 → 核对 → 发布（`publish_shop` RPC） | 所有商家共用**一个**口令；发布后**不能再修改**自己的店 |
| `shops` / `dishes` 表，匿名只读 verified 店 | 没有优惠/折扣字段 |
| `query_logs` 记录 AI 提问 | 学生的浏览、筛选行为没有记录；商家看不到任何反馈 |
| 首页只有学生视角 | 没有"学生 / 商家"切换入口 |

## 2. 数据库：继续用现有的 WorkBuddy 云数据库（推荐）

现在的云数据库已经是你们自己的数据库（Postgres 风格，支持行级权限 RLS 和 RPC 函数），里面已有 `shops`、`dishes`、日志表，也已经在用口令哈希校验。**建议在它上面加表**，不另起一套：
- 免费（符合 SPEC 第 2 节）；
- 前端已经接好，只需在 `api.js` 加函数；
- 另起数据库（自建服务器或第三方）要么花钱，要么需要把密钥放到前端，两者都违反 SPEC。

需要你决定的点见第 8 节。

## 3. 新增与修改的表

所有新表遵守 SPEC 第 4 节：**未知字段为 `null`，不记录学生个人信息。**

### 3.1 `shop_secrets`（新增，匿名不可读）
每家店独立的**店铺管理码**，取代"所有商家共用一个口令也能改别人的店"。
```
shop_id: string (PK, FK shops.id)
manage_code_hash: string        -- 只存哈希
created_at, rotated_at
```
流程：
- 新商家：输入**入驻口令**（现有的共用口令，只能用来"新建"）→ 发布 → 系统生成一个 8 位管理码，**只显示一次**，提示商家截图保存。
- 老商家：在商家版输入**管理码**，即可修改这家店。
- 管理码丢了：管理员在评估页（管理员口令）重置。
- 这不是账号登录：没有注册，没有用户名和密码，也不收集手机号。

### 3.2 `promotions`（新增）优惠/折扣
```
id: string
shop_id: string (FK)
title: string                   -- 必填，如"午市套餐 8 折"
kind: "percent_off" | "amount_off" | "special_price" | "gift" | "other"
value: number|null              -- 8折 → 20（percent_off）；满减 → 金额；特价 → 价格；其他为 null
dish_ids: string[]              -- 空数组 = 全店适用
min_spend: number|null          -- 满多少可用
weekdays: int[]                 -- 0-6（周一=0），空数组 = 每天
start_time / end_time: "HH:MM"|null   -- 时段，如午市 11:00–14:00
start_date / end_date: date|null      -- 有效期；end_date 过了自动不显示
note: string|null               -- 补充说明（作为数据显示，不进入 AI 提示词）
active: boolean                 -- 商家可随时下架
created_at, updated_at
```
展示规则：
- 首页卡片：当前有效的优惠显示一个"优惠"标签和标题，如"🏷 午市 8 折"。
- 店铺主页：新增"当前优惠"区块，列出全部有效优惠和有效期。
- 首页可以加一个"有优惠"筛选按钮（可选）。
- **AI 回答不提优惠**：优惠不传给 `core.runFindPipeline`，因此不用改 `core`，防编造也不受影响（AI 不会编出不存在的折扣价）。优惠只由页面直接展示。

### 3.3 `shops` 增加字段（可选）
```
notice: string|null             -- 店铺公告，如"本周日装修停业"
updated_by_merchant_at: ISO|null  -- 商家最近一次更新时间，卡片显示"3 天前更新"
```
`opening_hours`、`avg_price` 等字段不变，商家在商家版直接改。

### 3.4 `shop_events`（新增，匿名只能写入）学生被动反馈
```
id, created_at
event: "impression"   -- 卡片出现在列表或 AI 结果里
     | "card_click"   -- 点开店铺主页
     | "shop_view"    -- 店铺主页加载完成
     | "filter_used"  -- 用了哪些筛选按钮
shop_id: string|null        -- filter_used 为 null
source: "list" | "filter" | "ai" | "direct"   -- 从哪里来的
filters: jsonb|null         -- 当时选中的筛选条件，如 {"budget":30,"spicy":"no_spicy"}
result_count: int|null      -- filter_used 时有多少家店符合
visit_id: string|null       -- 浏览器内随机生成、每天更换的 id，只用于去重，不能关联到个人
```
- 不记录 IP、设备、账号、问题以外的任何学生信息。
- 匿名用户只能写入这张表，不能读取。只有商家（用管理码）能通过 RPC 读到**自己店的汇总数字**，看不到逐条记录。

### 3.5 已有表
- `query_logs`：不变。它已有 `filters` 和 `candidate_shop_ids`，可以直接算出"搜了但没有结果"的需求。
- `dishes`：不变。商家改菜时整批替换这家店的菜品（`vendor_confirmed = true`，`source = "vendor_input"`）。

## 4. 商家能看到的"被动反馈"（商家版首页）

由 RPC `get_shop_stats(shop_id, manage_code, days)` 汇总，默认最近 7 天：

| 指标 | 来源 | 示例 |
|---|---|---|
| 被看到次数 | `impression`（按 visit_id 去重） | 本周 132 人次在列表里看到你的店 |
| 点进主页 | `card_click` + `shop_view` | 41 人点开了店铺主页（点开率 31%） |
| AI 推荐次数 | `query_logs.candidate_shop_ids` 中包含本店 | AI 推荐了你的店 9 次 |
| 来源 | `source` 字段 | 列表 60% · 筛选 25% · AI 15% |
| 学生常用的筛选 | 本店被看到时的 `filters` | 看到你的学生里，48% 选了"30元内" |
| **没被满足的需求** | 同区域内 `filter_used` 结果为 0 的组合 + `query_logs` 无候选店的条件 | 北门：本周 17 次搜"素食"没有结果 |

最后一行是给商家的行动建议，例如"如果你有素食菜，标记出来就能出现在这些搜索里"。整个设计**不包含**学生评分、评论或文字评价（SPEC 第 1 节不做评价）。

## 5. 页面与切换

```
顶部栏： 🍜 找店助手      [ 学生 | 商家 ]   ← 分段切换，记在 localStorage
```
- **学生版** = 现在的首页（`index.html`），不变，只新增事件记录和优惠标签。
- **商家版** = 改造 `merchant.html`，分三屏：
  1. **进入**：两个入口："我是新商家（入驻口令）"和"管理我的店（管理码）"。
  2. **我的店铺**（管理码进入后）：
     - 反馈概览（第 4 节）
     - 编辑：基本信息 / 营业时间 / 菜单（可重新拍照识别，也可手动改）/ 优惠 / 公告
     - "预览学生看到的样子"链接 → `shop.html?id=…`
  3. **新建店铺**：就是现在的入驻流程，发布成功后显示管理码。
- 切换到"商家"只是跳到 `merchant.html`，**切换本身不需要密码**，进入店铺才需要。

## 6. 前端接口（全部放在 `public/js/api.js`）

保持第一版的约定：页面只调用 `api.js`，以后换后端只改这一个文件。

```
// 学生（匿名）
getVerifiedShopsAndDishes() → {shops, dishes, promotions}   // promotions 只含当前有效的
getShop(id) → {shop, dishes, promotions} | null
findShops(query) → PipelineResult                            // 不变
logEvent({event, shopId?, source, filters?, resultCount?}) → void   // 失败静默，不打扰学生

// 商家（全部经 RPC，管理码在数据库内校验，前端不保存明文）
createShop(joinPasscode, shop, dishes) → {shopId, manageCode}  // manageCode 只返回这一次
openMyShop(manageCode) → {shop, dishes, promotions} | null
updateShop(manageCode, shopFields) → void
replaceDishes(manageCode, dishes) → void
savePromotion(manageCode, promotion) → {id}      // 新增或修改
setPromotionActive(manageCode, id, active) → void
getShopStats(manageCode, days=7) → {impressions, clicks, aiRecommended, sources, topFilters, unmetDemand}
```

需要新增的数据库 RPC（`SECURITY DEFINER`，内部先校验管理码哈希）：
`create_shop`（替代/扩展现有 `publish_shop`）、`open_my_shop`、`update_shop`、`replace_dishes`、`save_promotion`、`set_promotion_active`、`get_shop_stats`、`reset_manage_code`（管理员口令）。

RLS：
- `shops` / `dishes`：匿名只读 `verified = true`（同现在）。
- `promotions`：匿名只读"所属店已核实、`active = true`、在有效期内"的行。
- `shop_events`：匿名只能写入（INSERT），字段长度和枚举值都要校验；没有读权限。
- `shop_secrets`：没有任何匿名权限。

## 7. 实施顺序（每步做完都能单独验收）

| 步骤 | 谁做 | 内容 | 验收 |
|---|---|---|---|
| 1 | WorkBuddy | 建 `shop_secrets`、`promotions`、`shop_events` 表 + RLS + 第 6 节的 RPC；给 5 家演示店各生成一个管理码 | 用管理码调用 `open_my_shop` 能拿到对应店铺；匿名读不到 `shop_secrets` |
| 2 | Claude Code | `api.js` 加上第 6 节的函数；首页和店铺主页显示优惠、记录事件 | 首页卡片出现"优惠"标签；店铺主页有"当前优惠"区块 |
| 3 | Claude Code | 改造 `merchant.html` 为商家版三屏 + 顶部切换 | 用 demo-s1 的管理码改营业时间，首页状态随之变化 |
| 4 | Claude Code | 商家版"反馈概览" | 手动点几次首页，商家版数字随之变化 |
| 5 | 组员 | 找 1–2 家真实店铺试用，`DEMO_MODE` 改为 `false` | 真实店铺出现在首页 |

可以直接发给 WorkBuddy 的第 1 步指令（发之前请先确认第 8 节）：
> 请阅读 docs/ROLE_DESIGN.md 第 3、6 节。在云数据库中新建 shop_secrets、promotions、shop_events 三张表，字段按第 3 节；按第 6 节设置 RLS，并新建 RPC：create_shop、open_my_shop、update_shop、replace_dishes、save_promotion、set_promotion_active、get_shop_stats、reset_manage_code。管理码只存哈希，校验在数据库函数内完成。为 demo-s1 到 demo-s5 各生成一个管理码，把明文发给我一次，不要写进任何文件。不要修改 src/ 和 public/ 下的文件，不要修改现有的 shops、dishes 数据。完成后告诉我每个 RPC 的输入输出，然后停下。

## 8. 需要你决定

1. **数据库位置**：继续用 WorkBuddy 云数据库（推荐），还是你说的"自己的 database"指别的平台？
2. **商家身份**：每店一个管理码（推荐）是否可以接受？这与 SPEC"不做登录"一致，但需要商家自己保管好管理码。
3. **被动反馈的范围**：是否同意记录匿名浏览和筛选事件？需要在 SPEC 第 4 节补上 `shop_events`，并在首页底部加一句"本站匿名统计浏览次数，不收集个人信息"。
4. **优惠是否进入 AI 回答**：推荐不进入（不用改 `core`）。如果要进入，就必须改 `core` 的提示词和防编造规则，需要重新跑评估。
5. **SPEC 更新**：以上内容确认后，要写进 SPEC.md v0.5 吗？WorkBuddy 和评估都以 SPEC 为准。
