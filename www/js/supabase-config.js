/* ==================================================================
   سِكّاوي | js/supabase-config.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: إنشاء وتصدير عميل Supabase (Supabase
   Client) بمفتاح المشروع، ليستخدمه أي ملف آخر في التطبيق (auth.js،
   profiles.js، وأي ملف مستقبلي يحتاج قراءة أو كتابة في قاعدة
   البيانات).

   ملاحظة مهمة: القيم بتاعة SUPABASE_URL و SUPABASE_ANON_KEY لازم
   تتغير لقيم مشروعك الحقيقي في Supabase Dashboard > Project Settings
   > API. الـ anon key ده مفتاح عام آمن للاستخدام في الفرونت إند طالما
   عامل Row Level Security (RLS) على الجداول (موضح في ملف السكيما
   sql/profiles_table.sql).

   ملاحظة عن طريقة الاستيراد: الملف ده بيعتمد على متغيّر window.supabase
   العام، اللي بيتعرّف تلقائياً بمجرد ما وسم سكريبت Supabase CDN
   (https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2) يتحمّل في
   index.html. عشان كده لازم وسم الـ CDN ده يتحط في index.html قبل
   وسم <script type="module" src="js/supabase-config.js"> مباشرة،
   وإلا هيطلع خطأ إن window.supabase غير معرّف.
   ================================================================== */

const { createClient } = window.supabase;

/** رابط مشروع Supabase الخاص بتطبيق "سِكّاوي" */
const SUPABASE_URL = 'https://rvytcqozbwsqpslkehiw.supabase.co';

/** المفتاح العام (anon/public key) الخاص بمشروع Supabase */
const SUPABASE_ANON_KEY = 'sb_publishable_ieqWt5WLLppNF8HJJbQ9lQ_7PAd6mhN';

/**
 * عميل Supabase الموحّد لكل التطبيق.
 * تفعيل persistSession و autoRefreshToken يضمن إن جلسة المستخدم
 * (Session) تفضل محفوظة في الـ localStorage تلقائياً، فمايحتاجش
 * يسجّل دخول تاني كل ما يفتح التطبيق، وإن الـ access token يتجدد
 * لوحده قبل ما ينتهي.
 */
export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'sekkawy-auth-session',
    },
});