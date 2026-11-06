-- ============================================================================
-- db/001_tables.sql — 第 1 批：只新增表 / 列 / 策略
-- 项目：校园找店助手（MIS3011）
-- 日期：2026-11-07
--
-- 本文件做什么：
--   1. shops 增加两列：notice（店铺公告）、updated_by_merchant_at（商家最近更新时间）
--   2. 新建 shop_secrets：每店管理码，只存 bcrypt 哈希，匿名无任何权限
--   3. 新建 promotions：优惠；匿名只能读“所属店 verified=true 且 active=true”的行
--   4. 新建 shop_events：匿名只能 INSERT，不能 SELECT；event/source 限定枚举，
--      filters 限制 4KB，visit_id 限制 8–64 字符
--
-- 本文件不做什么（按本批要求）：
--   - 不 DROP 任何对象
--   - 不修改 shops / dishes 的现有数据
--   - 不修改已有的 RLS 策略
--   - 不修改 verify_passcode、publish_shop 等已有函数
--   - 不创建 RPC（第 2、3 批再做）
--
-- 执行方式：WorkBuddy 云数据库 SQL 控制台，mode=migrate。
--   WorkBuddy 的 db_exec_sql 单次只支持一条 SQL；请按下面的语句逐条执行，
--   不要整文件一次性粘贴。
--
-- 重要口径：
--   - shop_events.source 允许 NULL。前端 filter_used 事件不带 source（api.js 里
--     会落成 null）；若这里写成 NOT NULL，筛选事件会全部插入失败且前端静默 catch，
--     “没被满足的需求”会永远为空。CHECK 仍然只允许 SPEC 的四个枚举值或 NULL。
--   - promotions 的匿名策略按本批要求只挡 verified + active；优惠的日期 / 星期
--     有效期由前端 util.isPromoActive 判断（页面只展示当前有效的优惠）。
--     如果以后希望匿名直接查也看不到过期优惠，可在后续批次把日期条件加进策略。
--
-- 回滚：见文件末尾（会删表 / 删列，执行前先确认没有要保留的数据）。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. shops：新增两列（可空；不影响现有行和现有查询）
-- ----------------------------------------------------------------------------
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS notice text;

ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS updated_by_merchant_at timestamptz;


-- ----------------------------------------------------------------------------
-- 2. shop_secrets：每店管理码，只存 bcrypt 哈希
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shop_secrets (
  shop_id          text PRIMARY KEY REFERENCES public.shops(id) ON DELETE CASCADE,
  manage_code_hash text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz
);

ALTER TABLE public.shop_secrets ENABLE ROW LEVEL SECURITY;

-- 匿名 / 登录用户都没有任何权限；只有 SECURITY DEFINER 函数能读写
REVOKE ALL ON TABLE public.shop_secrets FROM PUBLIC, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. promotions：优惠
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promotions (
  id          text PRIMARY KEY DEFAULT ('promo_' || encode(gen_random_bytes(8), 'hex')),
  shop_id     text NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  kind        text NOT NULL CHECK (kind IN ('percent_off', 'amount_off', 'special_price', 'gift', 'other')),
  value       double precision CHECK (value IS NULL OR value >= 0),
  dish_ids    text[] NOT NULL DEFAULT '{}',
  min_spend   double precision CHECK (min_spend IS NULL OR min_spend >= 0),
  weekdays    int[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]),
  start_time  time,
  end_time    time,
  start_date  date,
  end_date    date,
  note        text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_percent_check CHECK (
    kind <> 'percent_off' OR value IS NULL OR (value > 0 AND value < 100)
  ),
  CONSTRAINT promotions_dates_check CHECK (
    start_date IS NULL OR end_date IS NULL OR start_date <= end_date
  ),
  CONSTRAINT promotions_times_check CHECK (
    start_time IS NULL OR end_time IS NULL OR start_time <> end_time
  )
);

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.promotions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.promotions TO anon, authenticated;

-- 匿名只读：所属店已核实、优惠 active
CREATE POLICY promotions_read_active ON public.promotions
  FOR SELECT TO anon, authenticated
  USING (
    active
    AND EXISTS (
      SELECT 1
      FROM public.shops s
      WHERE s.id = promotions.shop_id
        AND s.verified = true
    )
  );


-- ----------------------------------------------------------------------------
-- 4. shop_events：匿名只能写，不能读
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shop_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL CHECK (event IN ('impression', 'card_click', 'shop_view', 'filter_used')),
  shop_id      text REFERENCES public.shops(id) ON DELETE SET NULL,
  -- 允许 NULL：filter_used 事件前端不带 source；见文件头“重要口径”
  source       text CHECK (source IS NULL OR source IN ('list', 'filter', 'ai', 'direct')),
  filters      jsonb CHECK (filters IS NULL OR octet_length(filters::text) <= 4096),
  result_count int CHECK (result_count IS NULL OR result_count >= 0),
  visit_id     text CHECK (visit_id IS NULL OR length(visit_id) BETWEEN 8 AND 64)
);

ALTER TABLE public.shop_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shop_events FROM PUBLIC, anon, authenticated;

-- 只给 INSERT，且按列授权：匿名不能伪造 id / created_at
GRANT INSERT (event, shop_id, source, filters, result_count, visit_id)
  ON TABLE public.shop_events TO anon, authenticated;

-- 只允许写；没有 SELECT 策略 / 没有 SELECT 授权
CREATE POLICY shop_events_insert ON public.shop_events
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);


-- ============================================================================
-- 回滚（不要和上面的语句一起执行；只有需要撤销本批时才手动跑）
-- 会删掉本批新增的三张表和两列，先确认没有要保留的数据。
-- ============================================================================
-- DROP TABLE IF EXISTS public.shop_events;
-- DROP TABLE IF EXISTS public.promotions;
-- DROP TABLE IF EXISTS public.shop_secrets;
-- ALTER TABLE public.shops DROP COLUMN IF EXISTS updated_by_merchant_at;
-- ALTER TABLE public.shops DROP COLUMN IF EXISTS notice;
