# 校园找店助手（MIS3011 课程项目）

> 用一个专业的网页，代替校园里各家小店的"微信接龙群"：
> **商家**上传菜单、营业时间、优惠和公告；**学生**用筛选或一句话找店、到店前看菜单；**管理员**在数据中控台看全站数据和"没被满足的需求"。

本文件写给组员，也写给接手的 AI 模型（DeepSeek、Claude、GPT 等）。**如果你是 AI 模型，请先读完本文件，再读"阅读顺序"里列出的文档，然后再改代码。**

---

## 1. 一句话说明

学生说"北门附近 30 块以内、不辣、现在还开着的店"，系统先用**确定性代码**按价格、营业时间、辣度、区域等条件筛选，再让大模型**只根据筛选结果**写一段回答，并附上店铺卡片和主页链接。大模型不负责判断哪家店符合条件，所以不会编出不存在的店。

不做的事（产品边界，已锁定）：点单、外卖、支付、学生评价、学生注册登录、商家账号注册、地图距离、多轮对话。

## 2. 三个版本

页面顶部有"学生 / 商家 / 管理员"切换。

| 版本 | 页面 | 能做什么 |
|---|---|---|
| 学生版 | `public/index.html` | AI 提问框 + 示例问题；多选筛选（营业中、30元内、不辣、素食、有优惠、北门/南门/东门），筛选在浏览器里完成、不调用 AI；店铺卡片显示营业状态、人均、区域、招牌菜和价格、当前优惠 |
| 店铺主页 | `public/shop.html?id=<店铺id>` | 店铺信息、公告、当前优惠、完整菜单；未核实的店显示"不存在或尚未核实" |
| 商家版 | `public/merchant.html` | 用**本店管理码**进入：数据反馈（曝光、点击、来源、学生常用筛选、附近没被满足的需求）、店铺信息、菜单、优惠。新店用**入驻口令**开店：拍菜单→AI 识别→商家核对→生成管理码（只显示一次） |
| 管理员版 | `public/admin.html` | 数据中控台：总览与每日趋势、需求洞察（区域供需、没结果的筛选/提问）、店铺管理（核实/取消核实、重置管理码）、提问记录 |

学生端的数据是**匿名被动反馈**：只记录"看到/点开了哪家店、用了什么筛选、结果有几家"，带一个每天更换的随机访问 id，不收集任何个人信息。

## 3. 当前进度（2026-11-15，interim 提交版）

| 部分 | 状态 |
|---|---|
| 核心逻辑 `src/core.mjs`（筛选、排序、营业判断、AI 流程、菜单识别、安全检查） | ✅ 完成，17 项测试全部通过 |
| 三个版本的前端页面 | ✅ 完成，**本地演示模式**下全流程可用 |
| 评估（34 条用例，线上真实模型，2026-11-14） | ✅ 本系统 30/34（88%），编造 0/34；基线 B0 规则 17/34、B1 无数据 0/34、B2 全量数据 9/34。test 集 15/17、解析全字段正确 79%，**两项未达 `eval/targets.md` 草稿线**。报告：`eval/reports/find_report_2026-11-14-08-52-46.md` |
| 已知问题（来自评估） | 4 条失败都因大模型把非菜名（宵夜、早餐、热乎、素食）放进菜品/菜系字段，筛选结果为空；修复是下一步第 1 项 |
| 数据库第 1 批（新表与权限，`db/001_tables.sql`） | 📝 已写好并审阅，**尚未在 WorkBuddy 执行** |
| 数据库第 2 批（商家/管理员用的后端函数 RPC） | ⏳ 未开始，等第 1 批执行并验证后再写 |
| 前端切换到云数据库 | ⏳ 等第 2 批完成（改 `public/js/api.js` 里的 `DEFAULT_BACKEND`） |

**重要：** 目前默认使用**本地演示模式**，数据存在你自己的浏览器里（localStorage），从 `data/demo_shops.json` 导入 6 家演示店（其中 1 家未核实，不会显示）。你在本地新建的店、改的优惠，别人看不到。页面顶部的黄色提示条就是这个意思。

## 4. 如何在自己电脑上运行

不需要安装任何东西，只要能起一个静态文件服务器：

```bash
cd public
python3 -m http.server 8765
```

然后浏览器打开：

- 学生版：http://127.0.0.1:8765/
- 商家版：http://127.0.0.1:8765/merchant.html
- 管理员版：http://127.0.0.1:8765/admin.html

本地模式下不校验口令：商家入驻口令、管理员口令随便填都能进。演示店的管理码会显示在管理员版"店铺管理"里（点"重置管理码"生成）。管理员版"工具"页可以清空并重新导入演示数据。

注意：
- 必须通过 `http://` 打开，直接双击 html 文件不行（ES module 需要服务器）。
- **AI 提问和菜单识别**走 WorkBuddy 的内置 AI（`public/app.js` 的 `callLLM`），本地可能用不了；筛选、店铺主页、商家后台、管理员中控台都不依赖 AI。
- 网址加 `?backend=cloud` 切到云数据库（会记住），`?backend=local` 切回本地。云端的商家/管理员功能要等数据库第 2 批完成才能用。

运行测试（需要 Node.js 18+）：

```bash
node --test test/core.test.mjs
```

应显示 17 项全部通过。

### 评估打分（`eval/score.mjs`）

1. 跑用例（调用线上模型、消耗资源点）。两种方式，输出格式相同：
   - 不需要口令（推荐）：`npm install` 后运行 `node eval/run_eval_node.mjs`，结果写到 `eval/reports/eval_results_<时间>.json`（店铺数据用本地演示数据，与 B0 一致）。
   - 评估页：打开 `eval.html`，输入管理员口令，选 dev 或 test，点"运行评估"，跑完点"下载 JSON"（用云端数据）。
2. 打分（不调用模型、不花钱）：

```bash
node eval/score.mjs find ~/Downloads/eval_results_xxxx.json
```

报告写到 `eval/reports/find_report_<时间>.md`（另有 `.summary.json`）。报告把四个系统放在一起比：B0 规则解析+模板（脚本离线计算）、B1 无数据聊天机器人、B2 大模型拿全部数据、P 本系统。指标包括整体正确率、编造率、店铺精确率/召回率、各类型正确率、抗注入、耗时、问题解析准确率（大模型 vs 规则），以及失败用例清单。可以一次传多个结果文件（例如两个模型），报告按模型分开。不给结果文件时只计算 B0：`node eval/score.mjs find`。

菜单识别：在评估页逐张上传菜单照片，点"下载识别结果 JSON"。另外把每张菜单的正确答案手工写进 `eval/menus/labels.json`，格式如下：`{"menus": [{"image": "menu01.jpg", "kind": "printed", "dishes": [{"name": "牛腩面", "price": 22}]}]}`。`image` 要和上传的文件名一致，`kind` 填 printed 或 handwritten。然后运行：

```bash
node eval/score.mjs extract --labels eval/menus/labels.json ~/Downloads/extraction_results_xxxx.json
```

输出召回、精确、菜名和价格准确率、编造的菜，以及置信度阈值表（阈值设多少能拦下多少错误）。

判定口径写在 `eval/score.mjs` 文件开头。injection 用例用 `forbidden_shop_ids` 指定回答里不能出现的店。

## 5. 文件地图

```
README.md                 ← 本文件
SPEC.md                   产品规格与接口契约 v0.5（数据结构、页面、核心规则）——最权威
docs/ROLE_DESIGN.md       学生/商家/管理员设计稿：表结构、被动反馈口径、RPC 列表、实施顺序
docs/HANDOFF_DEEPSEEK.md  给后端（DeepSeek）的交接说明和 RPC 契约
db/001_tables.sql         数据库第 1 批：新表、新字段、RLS 权限（未执行）
data/demo_shops.json      演示数据（6 家店及菜品）
src/core.mjs, core.cjs    核心逻辑（两份逻辑相同）——不要随意修改
test/core.test.mjs        核心逻辑测试（17 项）
eval/cases.json           评估用例
eval/score.mjs            评估打分脚本（报告写到 eval/reports/）
eval/run_eval_node.mjs    不用口令、直接用线上模型跑全部用例
eval/reports/             评估原始结果和报告（interim 用的是 2026-11-14 这一次）
eval/targets.md           评估达标线（跑 test 集之前必须由组员确认）
INTEGRATION.md            早期写给 WorkBuddy 的接入说明（历史文档）
WORKBUDDY_STEPS.md        早期给 WorkBuddy 的分步指令（历史文档）

public/                   网页（直接部署这个文件夹）
  index.html              学生版首页
  shop.html               店铺主页
  merchant.html           商家版
  admin.html              管理员数据中控台
  eval.html               评估页
  style.css               全部样式
  core.mjs                与 src/core.mjs 完全相同的副本（浏览器用）
  config.js               WorkBuddy 公开配置（endpoint、publishableKey，都是公开信息）
  app.js                  WorkBuddy SDK 连接、callLLM
  data/demo_shops.json    演示数据副本（本地模式用）
  js/api.js               ★ 页面读写数据的唯一入口，函数说明写在文件开头
  js/backend-local.js     本地演示后端（localStorage）
  js/backend-cloud.js     云端后端（WorkBuddy 云数据库，RPC 名称和参数即契约）
  js/stats.js             被动反馈的统计算法（云端 RPC 要按同样口径计算）
  js/nav.js               顶部三版本切换栏
  js/shop-editor.js       商家端：菜单拍照识别、菜品编辑、店铺信息表单
  js/util.js              小工具：转义、营业状态徽章、优惠文字等
```

### 架构要点

- **页面只调用 `public/js/api.js`**，不直接访问数据库。`api.js` 根据设置选择 `backend-local.js` 或 `backend-cloud.js`，两者方法完全相同。以后换后端（比如迁到 Supabase），只需要重写一个 backend 文件。
- **确定性代码做判断，大模型只做理解和表达。** 筛选、营业状态、排序都在 `core.mjs` 里；优惠和公告不传给 AI，AI 回答里不会提到优惠。
- **管理码：** 每家店一个 8 位管理码，数据库只存哈希，明文只在生成时显示一次；忘了由管理员重置。
- **权限（数据库 RLS）：** 匿名用户只能读已核实的店、菜品和有效优惠；`shop_events` 只能写不能读；`shop_secrets` 完全不可访问。商家和管理员的操作都通过后端函数（RPC）校验管理码/口令。

## 6. 规则（改代码前必读）

1. **不要修改 `src/core.mjs`、`src/core.cjs` 的逻辑**（`public/core.mjs` 是副本，要保持一致）。如果确实必须改，先说明原因，并保证 17 项测试仍然通过。
2. **口令、管理码、数据库连接串、任何密钥都不能写进 `public/` 或提交到仓库。** `config.js` 里的 publishableKey 是公开的，可以保留。
3. 不要增加点单、外卖、支付、登录、评价等功能。
4. 不要改 WorkBuddy 云服务的配置和发布设置；数据库改动写成 `db/00X_*.sql` 文件，由人审阅后手动执行。
5. 界面用简体中文，手机优先。学校名称只是举例，产品不绑定某一所学校（区域列表在 `public/js/util.js` 的 `AREAS`）。
6. 改完请在本地三个版本都点一遍，并运行测试。

## 7. 给 AI 模型的阅读顺序

1. 本文件 `README.md`
2. `SPEC.md`（数据结构和规则）
3. `docs/ROLE_DESIGN.md`（三个版本的设计和统计口径）
4. `public/js/api.js` 文件开头的函数说明
5. 要做后端：`docs/HANDOFF_DEEPSEEK.md` 第 9 节和 `public/js/backend-cloud.js`（RPC 名称与参数）
6. 要做前端：对应的 html 页面和 `public/js/` 下的模块

## 8. 下一步

1. 在 WorkBuddy 执行 `db/001_tables.sql`。执行前先跑两条只读检查：pgcrypto 扩展是否存在、`anon` / `authenticated` 角色是否存在。
2. 用 `?backend=cloud` 验证：首页显示 5 家店、`demo-s6` 不显示、浏览事件能写入、匿名读不到 `shop_secrets` 和 `shop_events`。
3. 写数据库第 2 批：`create_shop`、`open_my_shop`、`update_shop`、`replace_dishes`、`save_promotion`、`set_promotion_active`、`get_shop_stats`、`get_admin_overview`、`admin_list_shops`、`admin_set_verified`、`reset_manage_code`（参数见 `backend-cloud.js`，返回结构见 `api.js` 和 `stats.js`）。
4. 把 `api.js` 的 `DEFAULT_BACKEND` 改为 `"cloud"`，重新发布；有真实店铺后把 `DEMO_MODE` 改为 `false`。

## 9. 已知问题

- 云数据库里有一个菜名乱码："豥汁排骈饭"（原数据是"豉汁排骨饭"），需要在数据库里改正。
- 匿名写入 `shop_events` 暂时没有频率限制，课程演示可以接受，真实上线前要加。
- AI 提问框还没有在新页面上完整手动测试过。
