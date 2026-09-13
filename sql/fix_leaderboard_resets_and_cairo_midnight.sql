-- ====================================================================
-- سِكّاوي | sql/fix_leaderboard_resets_and_cairo_midnight.sql
-- --------------------------------------------------------------------
-- 1) إصلاح قيد notifications_type_check لقبول championship_win و championship_won
-- 2) تحديث دالة get_leaderboard لتنفيذ الفحص الاستباقي الذاتي (Self-Healing)
--    عند حلول الساعة 12:00 ص بتوقيت القاهرة Africa/Cairo دون انتظار مجدول الـ Cron
-- ====================================================================

-- 1) تحديث قيد جدول الإشعارات
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (
  type IN (
    'friend_request', 'friend_accept', 'achievement', 'achievement_unlocked',
    'system_broadcast', 'story_reaction', 'leaderboard_pass', 'comment_reply',
    'comment_like', 'daily_question_forfeited', 'championship_won', 'championship_win',
    'admin_message', 'admin_reply', 'support_message', 'system', 'points', 'streak'
  )
);

-- 2) تحديث دالة get_leaderboard مع الفحص الاستباقي الذاتي
DROP FUNCTION IF EXISTS public.get_leaderboard(text, integer);

CREATE OR REPLACE FUNCTION public.get_leaderboard(period_type text, limit_count integer DEFAULT 50)
RETURNS TABLE(
    id uuid,
    full_name text,
    avatar_url text,
    title text,
    steps bigint,
    points bigint,
    rank_position bigint,
    featured_badge_id text,
    is_verified boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cairo_today date := (now() AT TIME ZONE 'Africa/Cairo')::date;
    v_cairo_week_start date := date_trunc('week', (now() AT TIME ZONE 'Africa/Cairo'))::date;
    v_cairo_month_start date := date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date;
    v_last_daily date;
    v_last_weekly date;
    v_last_monthly date;
BEGIN
    -- فحص استباقي ذاتي: التحقق من حلول موعد التصفير بتوقيت القاهرة وتنفيذه فوراً إن لم يكن قد نُفذ
    SELECT last_reset_date INTO v_last_daily FROM public.championship_period_resets WHERE period_key = 'daily';
    SELECT last_reset_date INTO v_last_weekly FROM public.championship_period_resets WHERE period_key = 'weekly';
    SELECT last_reset_date INTO v_last_monthly FROM public.championship_period_resets WHERE period_key = 'monthly';

    IF (period_type = 'daily' AND (v_last_daily IS NULL OR v_last_daily < v_cairo_today))
       OR (period_type = 'weekly' AND (v_last_weekly IS NULL OR v_last_weekly < v_cairo_week_start))
       OR (period_type = 'monthly' AND (v_last_monthly IS NULL OR v_last_monthly < v_cairo_month_start)) THEN
        PERFORM public.process_leaderboard_period_resets();
    END IF;

    IF period_type = 'daily' THEN
        RETURN QUERY
        SELECT
            p.id,
            COALESCE(p.full_name, 'بطل')::text AS full_name,
            p.avatar_url,
            p.title,
            COALESCE(p.daily_steps, 0)::bigint AS steps,
            COALESCE(p.daily_points, 0)::bigint AS points,
            ROW_NUMBER() OVER (
                ORDER BY
                    COALESCE(p.daily_points, 0) DESC,
                    COALESCE(p.daily_steps, 0) DESC,
                    p.created_at ASC
            )::bigint AS rank_position,
            p.featured_badge_id::text,
            (COALESCE(p.is_verified, false) IS TRUE AND (p.verified_until IS NULL OR p.verified_until > now())) AS is_verified
        FROM public.profiles p
        WHERE p.is_blocked IS NOT TRUE
        ORDER BY rank_position ASC
        LIMIT limit_count;

    ELSIF period_type = 'weekly' THEN
        RETURN QUERY
        SELECT
            p.id,
            COALESCE(p.full_name, 'بطل')::text AS full_name,
            p.avatar_url,
            p.title,
            COALESCE(p.weekly_steps, 0)::bigint AS steps,
            COALESCE(p.weekly_points, 0)::bigint AS points,
            ROW_NUMBER() OVER (
                ORDER BY
                    COALESCE(p.weekly_points, 0) DESC,
                    COALESCE(p.weekly_steps, 0) DESC,
                    p.created_at ASC
            )::bigint AS rank_position,
            p.featured_badge_id::text,
            (COALESCE(p.is_verified, false) IS TRUE AND (p.verified_until IS NULL OR p.verified_until > now())) AS is_verified
        FROM public.profiles p
        WHERE p.is_blocked IS NOT TRUE
        ORDER BY rank_position ASC
        LIMIT limit_count;

    ELSE -- 'monthly'
        RETURN QUERY
        SELECT
            p.id,
            COALESCE(p.full_name, 'بطل')::text AS full_name,
            p.avatar_url,
            p.title,
            COALESCE(p.monthly_steps, 0)::bigint AS steps,
            COALESCE(p.monthly_points, 0)::bigint AS points,
            ROW_NUMBER() OVER (
                ORDER BY
                    COALESCE(p.monthly_points, 0) DESC,
                    COALESCE(p.monthly_steps, 0) DESC,
                    p.created_at ASC
            )::bigint AS rank_position,
            p.featured_badge_id::text,
            (COALESCE(p.is_verified, false) IS TRUE AND (p.verified_until IS NULL OR p.verified_until > now())) AS is_verified
        FROM public.profiles p
        WHERE p.is_blocked IS NOT TRUE
        ORDER BY rank_position ASC
        LIMIT limit_count;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_leaderboard(text, integer) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
