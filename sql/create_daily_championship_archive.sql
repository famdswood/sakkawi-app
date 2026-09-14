-- ====================================================================
-- سِكّاوي | sql/create_daily_championship_archive.sql
-- --------------------------------------------------------------------
-- إنشاء جدول الأرشيف اليومي التاريخي لبطولات نزلة عبيد
-- يحفظ الفائزين بالمراكز الثلاثة الأولى وإجمالي خطوات القرية كل ليلة
-- ====================================================================

-- 1) إنشاء جدول الأرشيف اليومي
CREATE TABLE IF NOT EXISTS public.daily_championship_archive (
    archive_date DATE PRIMARY KEY,
    first_place_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    first_place_name TEXT,
    first_place_username TEXT,
    first_place_steps BIGINT DEFAULT 0,
    first_place_avatar_url TEXT,
    second_place_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    second_place_name TEXT,
    second_place_username TEXT,
    second_place_steps BIGINT DEFAULT 0,
    second_place_avatar_url TEXT,
    third_place_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    third_place_name TEXT,
    third_place_username TEXT,
    third_place_steps BIGINT DEFAULT 0,
    third_place_avatar_url TEXT,
    total_village_steps BIGINT DEFAULT 0,
    active_walkers_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2) تفعيل سياسات الأمان RLS
ALTER TABLE public.daily_championship_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_championship_archive_select_all"
    ON public.daily_championship_archive
    FOR SELECT
    USING (true);

-- 3) دالة أرشفة نتائج اليوم تلقائياً قبل تصفير العدادات
CREATE OR REPLACE FUNCTION public.archive_daily_championship()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cairo_yesterday DATE := ((now() AT TIME ZONE 'Africa/Cairo') - interval '1 day')::date;
    v_winner_1 RECORD;
    v_winner_2 RECORD;
    v_winner_3 RECORD;
    v_total_steps BIGINT := 0;
    v_active_count INT := 0;
BEGIN
    -- التحقق إن كان اليوم مؤرشفاً مسبقاً
    IF EXISTS (SELECT 1 FROM public.daily_championship_archive WHERE archive_date = v_cairo_yesterday) THEN
        RETURN;
    END IF;

    -- حساب إجمالي خطوات القرية والمتسابقين النشطين
    SELECT
        COALESCE(SUM(daily_steps), 0),
        COUNT(*) FILTER (WHERE daily_steps > 0)
    INTO v_total_steps, v_active_count
    FROM public.profiles
    WHERE is_blocked IS NOT TRUE;

    -- استخراج المراكز الثلاثة الأولى
    SELECT id, full_name, username, daily_steps, avatar_url INTO v_winner_1
    FROM public.profiles
    WHERE is_blocked IS NOT TRUE AND daily_steps > 0
    ORDER BY daily_steps DESC, created_at ASC
    LIMIT 1 OFFSET 0;

    SELECT id, full_name, username, daily_steps, avatar_url INTO v_winner_2
    FROM public.profiles
    WHERE is_blocked IS NOT TRUE AND daily_steps > 0
    ORDER BY daily_steps DESC, created_at ASC
    LIMIT 1 OFFSET 1;

    SELECT id, full_name, username, daily_steps, avatar_url INTO v_winner_3
    FROM public.profiles
    WHERE is_blocked IS NOT TRUE AND daily_steps > 0
    ORDER BY daily_steps DESC, created_at ASC
    LIMIT 1 OFFSET 2;

    -- حفظ السجل التاريخي لليوم
    INSERT INTO public.daily_championship_archive (
        archive_date,
        first_place_id, first_place_name, first_place_username, first_place_steps, first_place_avatar_url,
        second_place_id, second_place_name, second_place_username, second_place_steps, second_place_avatar_url,
        third_place_id, third_place_name, third_place_username, third_place_steps, third_place_avatar_url,
        total_village_steps,
        active_walkers_count
    ) VALUES (
        v_cairo_yesterday,
        v_winner_1.id, v_winner_1.full_name, v_winner_1.username, COALESCE(v_winner_1.daily_steps, 0), v_winner_1.avatar_url,
        v_winner_2.id, v_winner_2.full_name, v_winner_2.username, COALESCE(v_winner_2.daily_steps, 0), v_winner_2.avatar_url,
        v_winner_3.id, v_winner_3.full_name, v_winner_3.username, COALESCE(v_winner_3.daily_steps, 0), v_winner_3.avatar_url,
        v_total_steps,
        v_active_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.archive_daily_championship() TO anon, authenticated, service_role;
