-- =====================================================================
-- سِكّاوي (بطل البلد) | sql/add_signup_location_to_profiles.sql
-- ---------------------------------------------------------------------
-- إضافة أعمدة رصد وتوثيق موقع التسجيل الجغرافي للمستخدمين الجدد:
-- 1) signup_lat: خط العرض وقت إنشاء الحساب
-- 2) signup_lng: خط الطول وقت إنشاء الحساب
-- 3) signup_distance_meters: المسافة بالمتر عن مركز نزلة عبيد
-- 4) signup_accuracy_meters: دقة إشارة الـ GPS بالمتر
-- ---------------------------------------------------------------------
-- ملاحظة: يتم تشغيل هذا الاستعلام في محرر SQL في لوحة تحكم Supabase
-- =====================================================================

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS signup_lat DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS signup_lng DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS signup_distance_meters INTEGER,
ADD COLUMN IF NOT EXISTS signup_accuracy_meters INTEGER;

-- فهرس اختياري لتسريع الاستعلامات الجغرافية
CREATE INDEX IF NOT EXISTS idx_profiles_signup_distance ON public.profiles(signup_distance_meters);

COMMENT ON COLUMN public.profiles.signup_lat IS 'خط العرض الجغرافي وقت تسجيل الحساب';
COMMENT ON COLUMN public.profiles.signup_lng IS 'خط الطول الجغرافي وقت تسجيل الحساب';
COMMENT ON COLUMN public.profiles.signup_distance_meters IS 'المسافة بالمتر عن مركز نزلة عبيد وقت تسجيل الحساب';
COMMENT ON COLUMN public.profiles.signup_accuracy_meters IS 'دقة إشارة الـ GPS بالمتر وقت تسجيل الحساب';
