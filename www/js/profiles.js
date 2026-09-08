/* ==================================================================
   سِكّاوي | js/profiles.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: عرض بيانات بروفايل المستخدم (اسمه،
   صورته، لقبه، إحصائياته)، وإدارة دولاب الأوسمة (الشارات المفتوحة/
   المقفولة)، وإدارة قائمة الأصدقاء (إضافة/حذف).

   ملاحظة مهمة (كانت السبب في ظهور بيانات وهمية بدل الحقيقية):
   الاسم والصورة واللقب وكل الإحصائيات (إجمالي الخطوات، النقاط،
   الإجابات الصحيحة، الستريك الحالي وأطول ستريك) دلوقتي بتتقرا فعلياً
   من صف المستخدم في جدول profiles على Supabase (عن طريق
   fetchUserProfile)، مش من قيم ثابتة في الكود. لو الصف مش موجود لأي
   سبب (مثلاً فشل الـ insert وقت التسجيل)، بيتم الرجوع لقيم افتراضية
   واضحة بدل بيانات شخص تاني.

   منطق الستريك (المرحلة 3): بيعتمد على عمودين في profiles:
   last_active_date (آخر يوم كان فيه نشاط حقيقي) و streak_count (عدد
   الأيام المتتالية الحالي). كل مرة يحصل نشاط حقيقي (حل سؤال صح، تسجيل
   خطوات، أو حتى مجرد تسجيل دخول) بنستدعي applyDailyCheckIn/
   buildActivityUpdates اللي بتقارن last_active_date بتاريخ النهاردة:
     - لو النهاردة    -> الستريك يفضل زي ما هو (نشاط تاني في نفس اليوم)
     - لو إمبارح      -> الستريك +1 (استمرارية)
     - أي حاجة أقدم   -> الستريك يترجع لـ 1 (انقطع)
   best_streak_days بيتحدث تلقائياً لو الستريك الحالي عدّى أعلى رقم
   وصله المستخدم قبل كده.

   المرحلة 4 (الأوسمة الحقيقية): بنستخدم جدولين -
     - badges       : الكتالوج الكامل لكل الأوسمة الممكنة في اللعبة
                      (id, icon, title, description, sort_order)
     - user_badges  : أي وسام فتحه أي مستخدم فعلياً
                      (user_id, badge_id, unlocked_at)
   بدل عمل SQL JOIN معقد، بنجيب الكتالوج كامل + قايمة user_badges بتاعة
   المستخدم الحالي بس، وبندمجهم في الجافاسكريبت (أبسط وأسهل صيانة).

   المرحلة 5 (الليدربورد ونظام الأصدقاء الحقيقي):
     - الليدربورد: Query مباشر على جدول profiles نفسه (مفيش حاجة زيادة)
       مرتب حسب points أو total_steps، + حساب ترتيب المستخدم الحالي
       عن طريق عدّ كام حد قيمته أعلى منه (count where column > mine).
       ملحوظة: زرارَي "ترتيب النهاردة" و"ترتيب الشهر ده" الموجودين في
       التصميم الأصلي بيحتاجوا فعلياً جدول تاريخي منفصل (زي
       points_history) عشان نقدر نفرّق بين نقاط اليوم والشهر - مش
       متوفر حالياً، فبنستخدمهم مؤقتاً كـ toggle بين الترتيب حسب
       "النقاط" (زرار النهاردة) والترتيب حسب "إجمالي الخطوات" (زرار
       الشهر) لحد ما يتضاف جدول تاريخي حقيقي.
     - نظام الأصدقاء: جدول friends بعمودين requester_id/addressee_id
       وحالة status ('pending' | 'accepted' | 'rejected' أو مسحه بالكامل
       عند الحذف). مفيش "دعوة صديق"/بحث عن مستخدمين تاني (اتشالت) -
       إرسال طلب الصداقة دلوقتي بيتم بس من زرار "إضافة صديق" في صفحة
       "بروفايل عام" (renderPublicProfileFriendButton) لأي حد وصلته
       عن طريق الستوري أو لوحة الصدارة.
     - البحث في لوحة الصدارة: خانة بحث بالاسم فوق اللوحة (مش مرتبطة
       بنظام الأصدقاء) بتدوّر في كل المستخدمين مش بس أعلى 10 الظاهرين -
       شوف searchLeaderboardUsers/bindLeaderboardSearchInput تحت.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
// (إصلاح - باج حقيقي) عشان نزبط عداد الخطوات المحلي مع daily_steps
// الحقيقية القادمة من Supabase وقت تحميل البروفايل - شوف
// reconcileWithServerSteps تحت في loadAndRenderRealProfile
import { reconcileWithServerSteps, reconcileServerBestSteps, syncActiveUser } from './sensors.js';
import { pushModalState, closeModal, replaceModalState } from './modal-history.js';
import { signOut } from './auth.js';
import { initChampionshipTabs, refreshActiveLeaderboard, getActiveMetric } from './leaderboard.js';
// (المرحلة 8) رسائل الدعم - بنستورد بس نقطة الفتح + دالة معرفة الأدمن
// من support-chat.js (اتجاه استيراد واحد؛ support-chat.js مايستورد منا
// حاجة خالص، فمفيش أي Circular Import هنا)
import { openSupportChatWithAdmin, openSupportChatAsAdminWithUser, getSupportAdminUserId } from './support-chat.js';
// (جديد) الاستبدال الكامل لتبويب "بروفايلي" بالنسبة للزائر (مفيش user.id) -
// زرار "سجّل دلوقتي" في #profileGuestView بيفتح نفس شاشة الاختيار الكاملة
// (showAuthGate بدون باراميتر) المستخدمة في js/guest-banner.js بالظبط
import { showAuthGate } from './onboarding.js';
// نقطة "أونلاين الآن" الخضراء فوق صورة البروفايل (مقيّدة: نفسي/صديق
// مقبول/أدمن بس - شوف الشرح الكامل في js/presence.js)
import { presenceDotHtml, loadAndApplyPresence } from './presence.js';
// (جديد - كاش الأوفلاين) شوف js/offline-cache.js للتفاصيل الكاملة
import { fetchWithCache } from './offline-cache.js';

/**
 * أيقونة "مفيش صورة" العامة الموحّدة - Data URI جاهزة تتحط مباشرة كـ src
 * لأي <img> في التطبيق (مش عنصر SVG منفصل، عشان نقدر نستخدمها في القوالب
 * الديناميكية اللي بتبني <img> كـ نص - زي بطاقات الأصحاب/الليدربورد/
 * البروفايل العام) بدل صور "بطل"/"صديق" الوهمية القديمة من placehold.co
 * اللي كانت بتوهم إنها صورة حقيقية.
 *
 * (تحديث الألوان): كانت خلفية الأيقونة دي فاتحة/بيضا (#E2E8F0 + خط رمادي
 * #94A3B8)، وده كان مختلف عن تصميم الأيقونة الداكنة الفعلية المستخدمة في
 * #headerAvatarGuestIcon و#profileAvatarGuestIcon (خلفية داكنة bg-lux-800
 * + خط lux-400) - بطلب صريح اتغيّرت ألوان الـ SVG هنا لنفس القيم بالظبط
 * (خلفية #14171F، خط #9A96A0) عشان الهوية تبقى موحدة تمامًا في كل مكان
 * (مننساش إن دي <img> ثابتة الألوان (data URI)، مش عنصر CSS، فمش بتتغيّر
 * تلقائيًا مع تبديل المود الفاتح/الداكن زي #headerAvatarGuestIcon بالظبط -
 * الألوان دي بتفضل ثابتة كـ"علامة" الأفاتار الافتراضي في المودين).
 *
 * (تحديث سابق): كانت أفاتار منصة الليدربورد (p1/p2/p3 في renderLeaderboardPodium)
 * مستثناة عمدًا وسايبينها بألوان placehold.co الذهبي/الفضي/البرونزي - اتغيّر
 * القرار ده بطلب صريح، ودلوقتي بتستخدم نفس الأيقونة الموحدة زي باقي المشروع
 * (شوف renderLeaderboardPodium تحت)، وبرضه مُصدّرة (export) عشان js/stories.js
 * و js/auth.js يقدروا يستخدموا نفس الأيقونة بالظبط بدل التكرار.
 */
export const DEFAULT_AVATAR_URI = "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20100%20100%27%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2750%27%20r%3D%2750%27%20fill%3D%27%2314171F%27%2F%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2738%27%20r%3D%2716%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%2F%3E%3Cpath%20d%3D%27M20%2084c0-18%2013.5-30%2030-30s30%2012%2030%2030%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E";

/**
 * نسخة محفوظة من مستخدم Supabase Auth الحالي (زي ما بييجي من auth.js)،
 * لازمة عشان handleEditProfileSubmit يعرف يحدّث صف مين بالظبط في
 * profiles من غير ما يحتاج ياخده كباراميتر تاني وقت الحفظ
 * @type {import('@supabase/supabase-js').User | null}
 */
let currentAuthUser = null;

/**
 * نسخة محفوظة من صف profiles الحقيقي الحالي للمستخدم (من آخر
 * loadAndRenderRealProfile ناجحة)، لازمة عشان نعبّي فورم التعديل
 * بالقيم الحالية (الاسم واللقب) بدل ما تفضل فاضية
 * @type {object | null}
 */
let currentProfileRow = null;

/** الصورة النهائية (بعد القص) اللي هتترفع فعلياً مع الحفظ - لو المستخدم مختارش صورة جديدة، بتفضل null و avatar_url القديمة بتتسيب زي ما هي */
let editSelectedAvatarFile = null;

/** true لو المستخدم ضغط زرار "حذف الصورة" جوه مودال تعديل البروفايل ولسه مختارش صورة جديدة بدلها - بتخلي handleEditProfileSubmit يبعت avatar_url: null بدل ما يسيبها زي ما هي، شوف handleDeleteEditAvatar تحت */
let editAvatarRemoved = false;

/** نسخة Cropper.js الحالية الشغالة على صورة مودال قص صورة التعديل (لو المودال مفتوح) */
let editAvatarCropperInstance = null;

/** true بمجرد ما نربط أحداث مودال التعديل مرة، عشان منربطهاش تاني كل ما initProfileUI تتنادى (بعد أي تسجيل دخول جديد مثلاً) ويحصل تكرار submit */
let editProfileEventsBound = false;

/** true بمجرد ما نربط أحداث النشاط (steps:progress) مرة، لنفس سبب editProfileEventsBound بالظبط */
let activityEventsBound = false;

/* ------------------------------------------------------------------
   المرحلة 7: Batch Update لخطوات Supabase
   ------------------------------------------------------------------
   sensors.js بيبعت حدث 'steps:progress' مع كل خطوة مفردة تقريباً (كل
   ~350ms أثناء المشي بسبب STEP_COOLDOWN_MS) - لو كل حدث كان بيعمل
   UPDATE مباشر على Supabase كنا هنغرق قاعدة البيانات بمئات الـ
   Requests في الدقيقة الواحدة. بدل كده، بنجمّع (Accumulate) الخطوات
   والنقاط المكتسبة منها محلياً في المتغيرات دي، وبنعمل Flush (كتابة
   فعلية على Supabase) بس كل STEPS_BATCH_FLUSH_INTERVAL_MS، أو فوراً
   لو تراكم عدد خطوات كبير (STEPS_BATCH_FORCE_FLUSH_THRESHOLD)، أو لو
   المستخدم قافل التاب/مغيّر الشاشة (شوف bindStepsFlushLifecycleEvents).
   ملحوظة: الواجهة (عداد الخطوات في app.js) بتتحدّث فوراً ومباشرة من
   غير أي انتظار للـ Batch - الـ Batch بس بيأخر وقت الكتابة الفعلية في
   قاعدة البيانات، مش وقت ظهور الرقم للمستخدم.
   ------------------------------------------------------------------ */

/** إجمالي الخطوات المتراكمة (لسه متبعتتش لـ Supabase) منذ آخر Flush ناجح */
let pendingStepsDelta = 0;

/** إجمالي النقاط المكتسبة من الخطوات المتراكمة (لسه متبعتتش لـ Supabase) منذ آخر Flush ناجح */
let pendingStepsPointsDelta = 0;

/** مُعرّف مؤقت الـ Flush الدوري الحالي (setTimeout) - null لو مفيش Flush مجدول دلوقتي */
let stepsBatchFlushTimer = null;

/** كام ميلي ثانية بين كل Flush دوري وتاني لخطوات الـ Batch (8 ثواني - توازن معقول بين حداثة البيانات وعدد الـ Requests) */
const STEPS_BATCH_FLUSH_INTERVAL_MS = 8000;

/** لو الخطوات المتراكمة وصلت للرقم ده قبل معاد الـ Flush الدوري، بنعمل Flush فوري (يفيد وقت الجري/المشي السريع عشان الفرق بين localStorage و Supabase يفضل معقول) */
const STEPS_BATCH_FORCE_FLUSH_THRESHOLD = 40;

/** مفتاح تخزين الخطوات/النقاط المتراكمة اللي لسه متبعتتش لـ Supabase -
 *  بنستخدمه بس كـ"شبكة أمان" وقت إغلاق الصفحة والمستخدم offline (راجع
 *  persistPendingStepsToStorage/restorePendingStepsFromStorage تحت) */
const PENDING_STEPS_STORAGE_KEY = 'ta7t-el-balad-pending-steps';

/**
 * مفتاح localStorage اللي بنخزّن فيه آخر اسم/لقب حقيقي وصلنا من صف
 * profiles - مش الاسم اللي بيوصل مع الـ Session (username) خالص.
 * الهدف: أول ما الصفحة تتفتح (أو تتعمل Refresh)، renderProfileHeader
 * تقدر تعرض الاسم الحقيقي فورًا من الكاش ده (نفس اللحظة اللي بيتحقن
 * فيها الهيدر) بدل ما تعرض اسم المستخدم (username) كـ "قيمة مؤقتة"
 * لحد ما نستنى رحلة الشبكة لـ Supabase تخلّص - وده كان سبب باج
 * "الاسم بيهبهب" (يظهر اليوزر نيم للحظة قبل ما يترجع للاسم الحقيقي).
 * بيتحدّث في كل مرة renderProfileHeader بتستقبل profile.full_name
 * حقيقي (شوف الدالة تحت).
 */
const CACHED_DISPLAY_NAME_KEY = 'sakkawy-cached-display-name';
const CACHED_DISPLAY_TITLE_KEY = 'sakkawy-cached-display-title';

/** قراءة آمنة من localStorage (بترجع null لو فشلت لأي سبب - خصوصية متصفح..إلخ) */
function readCachedHeaderField(key) {
    try {
        return window.localStorage.getItem(key) || null;
    } catch (err) {
        return null;
    }
}

/** كتابة آمنة لـ localStorage - بتتجاهل أي فشل بهدوء (مش وظيفة حرجة) */
function writeCachedHeaderField(key, value) {
    try {
        if (value) window.localStorage.setItem(key, value);
    } catch (err) {
        // تجاهل بهدوء
    }
}

/** مسح الكاش المحلي بتاع اسم/لقب الهيدر - بتتنادى وقت تسجيل الخروج
 * عشان جهاز مشترك ميفضلش عارض اسم آخر مستخدم دخل بيه قبل ما بروفايل
 * المستخدم الجديد يوصل (شوف bindLogoutButton/signOut تحت) */
export function clearCachedHeaderFields() {
    try {
        window.localStorage.removeItem(CACHED_DISPLAY_NAME_KEY);
        window.localStorage.removeItem(CACHED_DISPLAY_TITLE_KEY);
    } catch (err) {
        // تجاهل بهدوء
    }
}

/** true بمجرد ما نربط أحداث Flush الطارئة (تغيير رؤية الصفحة/مغادرتها) مرة واحدة، لنفس سبب activityEventsBound */
let stepsFlushLifecycleBound = false;

/** true بمجرد ما نربط خانة البحث في الليدربورد مرة، لنفس سبب editProfileEventsBound بالظبط - ملحوظة: علم أزرار فلتر البطولة نفسه (tabEventsBound) بقى جوه js/leaderboard.js دلوقتي (المرحلة 3) */
let leaderboardSearchEventsBound = false;

/** true بمجرد ما نربط أحداث صفحة "بروفايل عام" (زرار الرجوع + lightbox تكبير الصورة) مرة، لنفس سبب editProfileEventsBound بالظبط */
let publicProfileEventsBound = false;

/** معرّف صاحب صفحة "بروفايل عام" المفتوحة دلوقتي - لازم نحتفظ بيه عشان لو فتحنا بروفايل وبعدين بروفايل تاني بسرعة، آخر نتيجة توصل هي اللي تتعرض فعلياً */
let currentPublicProfileTargetId = null;

/** التبويب (home/leaderboard/profile) اللي كان مفتوح قبل ما ندخل على صفحة "بروفايل عام" - لازم عشان زرار "رجوع" يرجع بالظبط للمكان اللي جينا منه */
let previousTabIdBeforePublicProfile = null;

/** التبويب اللي كان مفتوح قبل ما ندخل على صفحة "إعدادات الحساب" - نفس فكرة previousTabIdBeforePublicProfile بالظبط */
let previousTabIdBeforeAccountSettings = null;

/** التبويب اللي كان مفتوح قبل ما ندخل على صفحة "الأوسمة والشارات" الكاملة - نفس فكرة previousTabIdBeforeAccountSettings بالظبط */
let previousTabIdBeforeBadgesPage = null;

/** نفس previousTabIdBeforeBadgesPage بالظبط، بس لصفحة "الأوسمة والشارات" الكاملة الخاصة ببروفايل عام (مش أوسمتي انا) - شوف openPublicBadgesPage */
let previousTabIdBeforePublicBadgesPage = null;

/** التبويب اللي كان مفتوح قبل ما ندخل على صفحة "كل الأصدقاء" الكاملة - نفس فكرة previousTabIdBeforeBadgesPage بالظبط */
let previousTabIdBeforeFriendsListPage = null;

/** التبويب اللي كان مفتوح قبل ما ندخل على صفحة "كل طلبات الصداقة الواردة" الكاملة - نفس فكرة previousTabIdBeforeFriendsListPage بالظبط */
let previousTabIdBeforeFriendRequestsListPage = null;

/** معرّف صف العلاقة (friend.id) اللي المستخدم ضغط زرار حذفه، ولسه مستني تأكيده جوه removeFriendConfirmModal - null لو مفيش طلب حذف معلّق حاليًا */
let pendingRemoveFriendId = null;

/** دالة اختيارية بتتنفذ بعد نجاح الحذف الفعلي (removeFriend) لو المستخدم أكّد - بتُستخدم لما الحذف مطلوب من مكان محتاج يحدّث واجهته هو بنفسه بعد كده (زي زرار "إلغاء الصداقة" في البروفايل العام)، شوف openRemoveFriendConfirmModal تحت */
let pendingRemoveFriendCallback = null;

/** true بمجرد ما نربط أحداث صفحة "الأوسمة والشارات" الكاملة (فتح من دولاب البروفايل + زرار الرجوع) مرة، لنفس سبب editProfileEventsBound بالظبط */
let badgesPageEventsBound = false;

/** نفس badgesPageEventsBound بالظبط، بس لصفحة "الأوسمة والشارات" الكاملة الخاصة ببروفايل عام - شوف bindPublicBadgesPageEvents */
let publicBadgesPageEventsBound = false;

/**
 * أوسمة صاحب البروفايل العام المفتوح دلوقتي، مرتّبة (شوف
 * sortBadgesForDisplay) - نفس دور badgesData بالظبط، بس لبروفايل عام
 * بدل بروفايلي انا. بتتحدّث في loadAndRenderPublicProfileBadges، وبيتم
 * استخدامها في renderPublicBadgesPage (الصفحة الكاملة مقسّمة بالتصنيفات)
 */
let publicProfileBadgesData = [];

/**
 * ترتيب عرض تصنيفات الأوسمة الأربعة + تسمية كل تصنيف - نفس التصنيفات
 * اللي اتفقنا عليها (عادية/متوسطة/صعبة/أسطورية)، وعمود tier في جدول
 * badges هو مصدر الحقيقة الوحيد لتصنيف كل وسام (شوف badges-catalog.sql)
 */
const BADGE_TIER_ORDER = ['normal', 'medium', 'hard', 'legendary'];
const BADGE_TIER_LABELS = {
    normal: '🟢 عادية',
    medium: '🟡 متوسطة',
    hard: '🔴 صعبة',
    legendary: '⚡ أسطورية',
};

/**
 * قائمة كل الأوسمة الممكنة في اللعبة (مفتوحة أو مقفولة) - دلوقتي
 * بتتعبّى من Supabase (جدولي badges + user_badges) عن طريق
 * loadAndRenderBadges()، مش Mock Data ثابتة زي الأول.
 * الشكل بعد التعبئة: { id, icon, title, desc, tier, sortOrder, unlocked, unlockedAt }
 * الترتيب في المصفوفة نفسها دايماً مرتّب بـ sortBadgesForDisplay (تصنيف
 * ثم الأحدث فتحًا أولاً جوه نفس التصنيف) - renderBadges (المعاينة
 * المصغّرة) وrenderBadgesPage (الصفحة الكاملة) الاتنين بيعتمدوا على
 * الترتيب ده جاهز من غير ما يعيدوا فرزه بنفسهم
 */
let badgesData = [];

/** (إصلاح - باج حقيقي خطير): كانت متسجّلة قيمة ليها بس (badgesLoadedOnce
 * = false داخل initProfileUI) من غير أي تعريف (let/const) في الملف كله
 * - وده بيرمي ReferenceError حقيقي (مش Global ضمني زي غير Strict Mode)
 * لأن ES Modules شغالة Strict Mode دايمًا. النتيجة: أي مرة initProfileUI(null)
 * تتنادى (زائر، أو بعد تسجيل خروج فعلي) كان الاستثناء ده بيتقفز *قبل*
 * ما يوصل لأي حاجة بعده في الدالة - يعني bindEditProfileEvents/
 * bindLogoutButton/bindActivityEvents/bindPublicProfileEvents/
 * bindBadgesPageEvents، والأهم "await initLeaderboardUI()" - كل ده كان
 * ببساطة مبيتنفذش خالص للزائر (Uncaught in promise، شوف initProfileUI
 * تحت). دلوقتي بقت متعرّفة هنا فعليًا كمتغيّر Module-level زي باقي
 * أعلام "اتحمّل مرة واحدة" التانية في الملف ده. */
let badgesLoadedOnce = false;

/**
 * المرحلة 7: كاش خفيف لكتالوج الأوسمة (id -> {icon, title}) لازم عشان
 * نعرض أيقونة "الشارة المميزة" (featured_badge_id) جنب أي اسم في
 * الشاشة (بروفايلي، الهيدر العلوي، بروفايل عام) من غير ما نحتاج نداء
 * شبكة منفصل في كل مرة. بيتعبّى أول مرة من loadAndRenderBadges (لو
 * المستخدم الحالي داخل على تبويب بروفايله) أو من ensureBadgesCatalogCache
 * (لو حد فتح بروفايل عام مباشرة من غير ما يعدي على بروفايله هو الأول)
 * @type {Map<string, {icon: string, title: string}> | null}
 */
let badgesCatalogCache = null;

/** الـ Promise الحالي لتحميل كتالوج الأوسمة (لو شغال) - عشان لو أكتر من مكان في نفس اللحظة طلب ensureBadgesCatalogCache، ما نعملش نداء شبكة مكرر */
let badgesCatalogLoadPromise = null;

/**
 * قائمة أصدقاء المستخدم الحالي المقبولين فعلاً (status = 'accepted') -
 * دلوقتي بتتعبّى من Supabase (جدولي friends + profiles) عن طريق
 * loadAndRenderFriends()، مش Mock Data ثابتة زي الأول.
 * الشكل بعد التعبئة: { id (=friendRowId), userId, name, points, avatar }
 */
let friendsData = [];

/** قائمة طلبات الصداقة الواردة للمستخدم الحالي (status = 'pending' ومُرسلة له) */
let incomingFriendRequests = [];

/**
 * إحصائيات المستخدم المعروضة في كارت البروفايل وشارات الهيدر. كل
 * الحقول دلوقتي أعمدة حقيقية في جدول profiles (بعد المرحلتين 2 و3):
 * total_steps, correct_answers, best_streak_days, points,
 * streak_count. لو الصف مش موجود، بتفضل كلها 0 بدل ما توهم ببيانات
 * وهمية.
 */
let profileStats = {
    totalSteps: 0,
    correctAnswers: 0,
    bestStreakDays: 0,
    points: 0,
    streakCount: 0,
    dailyChampionshipWins: 0,
    weeklyChampionshipWins: 0,
    monthlyChampionshipWins: 0,
};

/**
 * جلب صف بروفايل المستخدم الحقيقي من جدول profiles على Supabase
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function fetchUserProfile(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('خطأ في جلب بيانات البروفايل الحقيقية:', error.message);
        return null;
    }

    return data;
}

/**
 * (كاش الأوفلاين) نسخة "خام" من fetchUserProfile تُستخدم فقط في
 * loadAndRenderRealProfile عن طريق fetchWithCache - بترجع null صراحة
 * عند فشل حقيقي في الجلب (مشكلة شبكة/سيرفر)، أو { profile: data }
 * (حتى لو data نفسها null - يعني صف البروفايل مش موجود فعلاً، مثلاً فشل
 * الـ insert وقت التسجيل) في حالة النجاح - نفس فلسفة fetchHomeBannerRow
 * في js/banner.js بالظبط، عشان fetchWithCache تقدر تفرّق بين "الطلب
 * فشل، سيب المعروض زي ما هو" و"الطلب نجح ورجع إن الصف مش موجود فعلاً".
 * fetchUserProfile الأصلية فوق فضلت من غير أي تغيير لأنها كمان بتتستخدم
 * مباشرة (بدون كاش) في refreshProfileAfterDailyQuestion بعد كتابة فعلية
 * (إجابة سؤال يومي) واللي محتاجة فعلياً أحدث نسخة من السيرفر وقتها، مش
 * كاش قديم ممكن يكون لسه مش شايف نتيجة الكتابة دي.
 * @param {string} userId
 * @returns {Promise<{profile: object|null}|null>}
 */
async function fetchUserProfileFromServer(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('خطأ في جلب بيانات البروفايل الحقيقية:', error.message);
        return null;
    }

    return { profile: data };
}

/**
 * تحديث جزئي (Partial UPDATE) لصف profiles بتاع المستخدم الحالي،
 * وإرجاع الصف بعد التحديث. مسؤولة عن نفس الحماية اللي كانت مكررة في
 * handleEditProfileSubmit: بنستخدم maybeSingle() بدل single() عشان
 * منرميش خطأ 406 ("Cannot coerce the result to a single JSON object")
 * لو مفيش صف اتطابق مع الـ UPDATE أصلاً، وبنعمل upsert احتياطي في
 * الحالة النادرة دي بدل ما نسيب المستخدم من غير حفظ.
 * بعد أي تحديث ناجح، بتحدّث currentProfileRow وكل عناصر الواجهة
 * المرتبطة (الاسم/الصورة/الإحصائيات/شارتي النقاط والستريك) تلقائياً.
 * @param {object} updates - الأعمدة المطلوب تحديثها فقط
 * @returns {Promise<object|null>}
 */
async function patchProfileRow(updates) {
    if (!currentAuthUser || !updates || Object.keys(updates).length === 0) return currentProfileRow;

    const { data: updatedRow, error: updateError } = await supabaseClient
        .from('profiles')
        .update(updates)
        .eq('id', currentAuthUser.id)
        .select()
        .maybeSingle();

    if (updateError) {
        console.error('خطأ في تحديث البروفايل:', updateError.message);
        throw new Error(`حصل خطأ أثناء حفظ التحديث (${updateError.message}) - حاول تاني`);
    }

    let finalRow = updatedRow;

    if (!finalRow) {
        const { data: upsertedRow, error: upsertError } = await supabaseClient
            .from('profiles')
            .upsert({ id: currentAuthUser.id, ...updates }, { onConflict: 'id' })
            .select()
            .maybeSingle();

        if (upsertError) {
            console.error('خطأ في إنشاء البروفايل أثناء الحفظ:', upsertError.message);
            throw new Error(`حصل خطأ أثناء حفظ التحديث (${upsertError.message}) - حاول تاني`);
        }

        finalRow = upsertedRow;
    }

    if (finalRow) {
        currentProfileRow = finalRow;
        renderProfileHeader(finalRow, currentAuthUser);
        updateProfileStats({
            totalSteps: finalRow.total_steps ?? 0,
            correctAnswers: finalRow.correct_answers ?? 0,
            bestStreakDays: finalRow.best_streak_days ?? 0,
            points: finalRow.points ?? 0,
            streakCount: finalRow.streak_count ?? 0,
            dailyChampionshipWins: finalRow.daily_championship_wins ?? 0,
            weeklyChampionshipWins: finalRow.weekly_championship_wins ?? 0,
            monthlyChampionshipWins: finalRow.monthly_championship_wins ?? 0,
        });
    }

    return finalRow;
}

/** إرجاع تاريخ النهاردة بصيغة YYYY-MM-DD حسب توقيت جهاز المستخدم (مش UTC، عشان مايحصلش فرق يوم غلط قرب منتصف الليل) */
function getLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** إرجاع تاريخ إمبارح (بالنسبة للنهاردة) بنفس صيغة YYYY-MM-DD */
function getLocalYesterdayString() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return getLocalDateString(yesterday);
}

/**
 * قلب منطق حساب الستريك (المرحلة 3): بتقارن last_active_date المخزّن
 * في البروفايل بتاريخ النهاردة/إمبارح، وترجع الستريك الجديد + هل
 * محتاج نكتب تحديث في الداتابيز ولا لأ (changed=false يعني نشاط تاني
 * في نفس اليوم، مفيش داعي نكتب تاني).
 * @param {string|null} lastActiveDate - قيمة last_active_date الحالية (YYYY-MM-DD) أو null لو أول نشاط على الإطلاق
 * @param {number} currentStreakCount - قيمة streak_count الحالية
 * @returns {{streakCount: number, lastActiveDate: string, changed: boolean}}
 */
function computeStreakUpdate(lastActiveDate, currentStreakCount) {
    const today = getLocalDateString();

    // 1) لو المستخدم عمل نشاط النهاردة بالفعل - الستريك يفضل زي ما هو
    if (lastActiveDate === today) {
        return {
            streakCount: currentStreakCount > 0 ? currentStreakCount : 1,
            lastActiveDate: today,
            changed: false,
        };
    }

    // 2) لو آخر نشاط كان إمبارح - استمرارية، الستريك +1
    if (lastActiveDate === getLocalYesterdayString()) {
        return { streakCount: currentStreakCount + 1, lastActiveDate: today, changed: true };
    }

    // 3) أي حالة تانية (مفيش نشاط قبل كده، أو غاب يوم أو أكتر) - الستريك يترجع لـ 1
    return { streakCount: 1, lastActiveDate: today, changed: true };
}

/**
 * تجميع كل تحديثات "النشاط" (نقاط + إجابات صحيحة + خطوات + الستريك)
 * في Object واحد جاهز يتبعت لـ patchProfileRow في UPDATE واحد بس
 * (بدل ما كل حاجة تعمل رحلة شبكة منفصلة). لو مفيش أي تغيير حقيقي
 * (كل الـ deltas صفر وستريك اليوم متسجل بالفعل)، بترجع Object فاضي
 * عشان patchProfileRow تتجاهل النداء بالكامل.
 * @param {{pointsDelta?: number, correctAnswersDelta?: number, totalStepsDelta?: number, dailyStepsDelta?: number}} deltas
 * @returns {object}
 * @deprecated (إصلاح أمني) الدالة دي بقت مش مستخدمة تاني لتحديث الخطوات/
 * النقاط الحقيقية - كانت هي أصل ثغرة "أي حد يقدر يزوّر نقاطه من الكونسول"
 * لأنها بتحسب القيمة الجديدة في الفرونت إند وتسيب patchProfileRow تبعتها
 * كـ UPDATE مباشر يقبل أي رقم. استُبدلت بـ applyStepsProgressServerSide
 * اللي بتبعت بس "عدد الخطوات المضافة" لدالة RPC سيرفر-سايد (apply_steps_progress)
 * وهي اللي بتحسب وتكتب القيم الحقيقية. سايبينها هنا لسه من غير حذف
 * كمرجع تاريخي بس - محدش يرجع يستخدمها في تحديث points/total_steps.
 */
function buildActivityUpdates({
    pointsDelta = 0,
    correctAnswersDelta = 0,
    totalStepsDelta = 0,
    dailyStepsDelta = 0,
} = {}) {
    if (!currentProfileRow) return {};

    const updates = {};

    // (إصلاح الليدربورد الأسبوعي/الشهري) كل نقطة/خطوة بتتحسب دلوقتي في
    // أعمدة الفترات الثلاثة مع بعض (يومي + أسبوعي + شهري) مش بس التراكمي
    // القديم - كل فترة بتتصفّر لوحدها في وقتها عن طريق reset_daily/weekly/
    // monthly_leaderboard() (المُنفَّذة من process_leaderboard_period_resets
    // عبر Cron Job كل 10 دقايق)، فالتراكم هنا بيفضل مظبوط تلقائياً حتى بعد
    // كل تصفير لأن كل فترة بتاخد نسخة مستقلة تبدأ من صفر وقت التصفير بتاعها
    if (pointsDelta) {
        updates.points = (currentProfileRow.points ?? 0) + pointsDelta;
        updates.daily_points = (currentProfileRow.daily_points ?? 0) + pointsDelta;
        updates.weekly_points = (currentProfileRow.weekly_points ?? 0) + pointsDelta;
        updates.monthly_points = (currentProfileRow.monthly_points ?? 0) + pointsDelta;
    }
    if (correctAnswersDelta) updates.correct_answers = (currentProfileRow.correct_answers ?? 0) + correctAnswersDelta;
    if (totalStepsDelta) {
        updates.total_steps = (currentProfileRow.total_steps ?? 0) + totalStepsDelta;
        updates.weekly_steps = (currentProfileRow.weekly_steps ?? 0) + totalStepsDelta;
        updates.monthly_steps = (currentProfileRow.monthly_steps ?? 0) + totalStepsDelta;
    }
    if (dailyStepsDelta) updates.daily_steps = (currentProfileRow.daily_steps ?? 0) + dailyStepsDelta;

    const streakUpdate = computeStreakUpdate(currentProfileRow.last_active_date, currentProfileRow.streak_count ?? 0);
    if (streakUpdate.changed) {
        updates.streak_count = streakUpdate.streakCount;
        updates.last_active_date = streakUpdate.lastActiveDate;
        updates.best_streak_days = Math.max(currentProfileRow.best_streak_days ?? 0, streakUpdate.streakCount);
    }

    return updates;
}

/**
 * "تسجيل حضور" يومي بسيط - بيتنادى مرة عند كل تحميل بروفايل ناجح
 * (يعني فعلياً عند تسجيل الدخول)، وبيحسب الستريك بس من غير أي نقاط
 * أو إحصائيات تانية. لو المستخدم عمل بالفعل نشاط النهاردة (حل سؤال
 * أو سجّل خطوات) قبل ما الدالة دي تتنادى، buildActivityUpdates هترجع
 * Object فاضي فمفيش رحلة شبكة زيادة عن اللازم.
 */
async function applyDailyCheckIn() {
    if (!currentAuthUser || !currentProfileRow) return;

    try {
        // (إصلاح أمني) الستريك دلوقتي بيتحسب ويتكتب جوه دالة RPC سيرفر-سايد
        // (apply_steps_progress) مش بـ UPDATE مباشر من هنا - شوف
        // applyStepsProgressServerSide تحت. بنبعتلها 0 خطوة عشان الغرض
        // الوحيد هنا هو "تسجيل الحضور" (تحديث last_active_date/streak_count)
        // من غير أي إضافة خطوات أو نقاط فعلية.
        await applyStepsProgressServerSide(0);
    } catch (error) {
        // فشل تسجيل الحضور مش لازم يوقف باقي تحميل البروفايل أو يزعج
        // المستخدم بـ Toast - بنسجله في الكونسول بس ونكمل عادي
        console.error('خطأ في تسجيل حضور اليوم (الستريك):', error.message);
    }
}

/**
 * (إصلاح أمني) بديل آمن لـ buildActivityUpdates + patchProfileRow بتاعة
 * الخطوات/النقاط: بدل ما الفرونت إند يحسب القيم الجديدة ويبعتها في UPDATE
 * مباشر (اللي كان أي حد يقدر يزوّره من الكونسول بنفس طريقة is_verified_override
 * قبل كده)، الدالة دي بتنادي RPC سيرفر-سايد (apply_steps_progress - شوف
 * secure_activity_progress.sql) بتاخد بس *عدد الخطوات المضافة* كمدخل،
 * وهي اللي بتحسب النقاط/الستريك وتكتبها في الداتابيز نفسها تحت
 * auth.uid() بتاع المستخدم المسجّل دخوله فعلاً - مفيش أي عمود نقاط/خطوات
 * بيتكتب من الفرونت إند تاني خالص. بترجع الصف المحدّث وتحدّث الواجهة
 * بيه (زي ما patchProfileRow كانت بتعمل بالظبط).
 * @param {number} addedSteps - عدد الخطوات المضافة (0 لو الغرض تسجيل حضور بس)
 * @returns {Promise<object|null>}
 */
async function applyStepsProgressServerSide(addedSteps) {
    if (!currentAuthUser) return currentProfileRow;

    const { data: updatedRow, error } = await supabaseClient
        .rpc('apply_steps_progress', { p_added_steps: addedSteps })
        .maybeSingle();

    if (error) {
        console.error('خطأ في تحديث تقدّم الخطوات:', error.message);
        throw new Error(`حصل خطأ أثناء حفظ التقدّم (${error.message}) - حاول تاني`);
    }

    if (updatedRow) {
        currentProfileRow = updatedRow;
        renderProfileHeader(updatedRow, currentAuthUser);
        updateProfileStats({
            totalSteps: updatedRow.total_steps ?? 0,
            correctAnswers: updatedRow.correct_answers ?? 0,
            bestStreakDays: updatedRow.best_streak_days ?? 0,
            points: updatedRow.points ?? 0,
            streakCount: updatedRow.streak_count ?? 0,
            dailyChampionshipWins: updatedRow.daily_championship_wins ?? 0,
            weeklyChampionshipWins: updatedRow.weekly_championship_wins ?? 0,
            monthlyChampionshipWins: updatedRow.monthly_championship_wins ?? 0,
        });

        // (المرحلة 9) بعد أي تحديث حقيقي للخطوات/النقاط/الستريك، نفحص لو
        // فتح بيه وسام جديد (Fire and forget - فشل الفحص مش لازم يوقف
        // تحديث تقدّم الخطوات نفسه)
        checkAndUnlockBadges();
    }

    return updatedRow;
}

/* ==================================================================
   تحدي الذكاء اليومي القديم (سؤالين: ديني + معلومات عامة، جدول
   public.user_quiz_answers، الدوال tryRecordQuizAnswerOnce /
   fetchQuizAnsweredToday / recordQuizAnswer، والأحداث
   'quiz:answer-submitted' / 'quiz:answered-today') اتشال نهائياً من
   هنا ومن index.html وjs/app.js - بقى عندنا تحدي يومي واحد بس هو
   "السؤال اليومي" المُدار من js/daily-question.js.
   ملحوظة: جدول public.user_quiz_answers نفسه على Supabase لسه موجود
   (مفيش حذف تلقائي لجداول قاعدة البيانات من هنا) - لو عايز تشيله
   خالص من الداتابيز نفسها ده قرار منفصل تاخده يدوياً.
   ================================================================== */


/**
 * (المرحلة 7) تطبيق التحديث الفعلي على Supabase لكل الخطوات والنقاط
 * المتراكمة محلياً منذ آخر Flush ناجح (Batch Update)، في UPDATE واحد
 * بس - بدل ما كل خطوة مفردة تعمل Request منفصل. بتتصفّر المتغيرات
 * المتراكمة فور ما تاخد نسخة منها هنا (قبل الـ await) عشان أي خطوات
 * جديدة توصل أثناء تنفيذ الـ Request الحالي تتجمّع في دفعة (Batch)
 * تالية بدل ما تتفقد.
 */
async function flushPendingStepsBatch() {
    if (stepsBatchFlushTimer) {
        clearTimeout(stepsBatchFlushTimer);
        stepsBatchFlushTimer = null;
    }

    if (!currentAuthUser || !currentProfileRow || pendingStepsDelta <= 0) return;

    const stepsToFlush = pendingStepsDelta;
    const pointsToFlush = pendingStepsPointsDelta;
    pendingStepsDelta = 0;
    pendingStepsPointsDelta = 0;

    try {
        const oldPoints = currentProfileRow.points ?? 0;
        const oldTotalSteps = currentProfileRow.total_steps ?? 0;

        // (إصلاح أمني) مبقناش بنحسب points/total_steps الجداد هنا في
        // الفرونت إند ونبعتهم في UPDATE مباشر (ده اللي كان بيسمح لأي حد
        // يفتح الكونسول ويزوّر نقاطه/خطواته زي ما اتأكد بالاختبار).
        // دلوقتي بنبعت بس *عدد الخطوات المضافة* لدالة RPC سيرفر-سايد
        // (apply_steps_progress) وهي اللي بتتحقق من القيمة وتحسب النقاط
        // وتكتبها فعليًا جوه الداتابيز - pointsToFlush بقت مجرد قيمة
        // تقديرية للعرض المحلي، مش مصدر الحقيقة تاني.
        await applyStepsProgressServerSide(stepsToFlush);

        // الـ Flush بيحدّث المقياسين (points و total_steps) مع بعض، فبنتحقق
        // من التخطي على الاتنين - كل واحد وليدربورده المستقل (شوف
        // notifyLeaderboardPassIfNeeded فوق)
        await notifyLeaderboardPassIfNeeded('points', oldPoints, currentProfileRow?.points ?? oldPoints);
        await notifyLeaderboardPassIfNeeded('total_steps', oldTotalSteps, currentProfileRow?.total_steps ?? oldTotalSteps);

        // تحديث فوري لترتيب الليدربورد (نفس فلسفة recordCorrectAnswer فوق)
        // (إصلاح باج "الأرقام الوهمية"): كان بينادي هنا على النسخة
        // القديمة loadAndRenderLeaderboard اللي بترسم أرقام all-time
        // بغض النظر عن التبويب (يومي/أسبوعي/شهري) الظاهر فعلاً - بقى
        // بينادي على refreshActiveLeaderboard() من js/leaderboard.js
        // اللي بتحدّث بس الفترة النشطة حالياً بنفس مصدر البيانات الصح
        await refreshActiveLeaderboard();
    } catch (error) {
        // لو الـ Flush فشل (مشكلة شبكة مؤقتة مثلاً)، بنرجّع الخطوات
        // والنقاط دي لقايمة الانتظار عشان تتحاول تاني في الـ Flush
        // الجاي بدل ما تتفقد نهائياً
        pendingStepsDelta += stepsToFlush;
        pendingStepsPointsDelta += pointsToFlush;
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: error.message, type: 'error' } }));
    }
}

/**
 * (إصلاح أمني) قيمة نقاط الإجابة الصحيحة على السؤال اليومي (5 نقاط)
 * بقت معرّفة *في السيرفر بس* جوه دالة record_daily_question_result في
 * daily-question-security.sql - مش هنا. القيمة دي اتشالت من هنا عمداً
 * عشان محدش يقدر يتلاعب بيها من الـ Frontend؛ لو احتجت تغيّرها لازم
 * تتغيّر جوه الـ SQL function مباشرة.
 */

/**
 * (إصلاح أمني) بعد ما دالة RPC في السيرفر (record_daily_question_result
 * - شوف daily-question-security.sql) تتحقق من الإجابة وتمنح النقاط
 * فعلياً *جوه الداتابيز*، الدالة دي بتتنادى بس عشان "تعكس" الرقم الجديد
 * على الواجهة - بإعادة جلب صف profiles بـ SELECT بحت، من غير أي UPDATE
 * من هنا خالص.
 *
 * ده الفرق الجوهري عن النسخة القديمة (awardDailyQuestionPoints) اللي
 * كانت بتعمل UPDATE على points مباشرة بمجرد استقبال الحدث - وده اللي
 * كان بيخلي أي حد يقدر يطلق الحدث يدوياً من الـ Console (زي
 * document.dispatchEvent(new CustomEvent('dailyQuestion:answered', ...)))
 * ويكسب نقاط وهمية من غير ما يحل حاجة أصلاً. دلوقتي: حتى لو حد بعت
 * الحدث ده وهمي، أقصى حاجة هتحصل هي إعادة قراءة نفس الأرقام الحقيقية
 * من الداتابيز - مفيش أي كتابة نقاط ممكنة من الـ Frontend تاني.
 * النقاط بتتضاف فعلياً بس جوه الدالة السيرفرية نفسها، وبس لو الـ RPC
 * رجّعت alreadyRecorded: false (يعني أول مرة فعلاً السؤال ده بيتسجّل
 * النهاردة) - شوف finalizeSlot في daily-question.js.
 */
async function refreshProfileAfterDailyQuestion() {
    if (!currentAuthUser) return;

    try {
        const oldPoints = currentProfileRow?.points ?? 0;

        const freshRow = await fetchUserProfile(currentAuthUser.id);
        if (!freshRow) return;

        currentProfileRow = freshRow;
        renderProfileHeader(freshRow, currentAuthUser);
        updateProfileStats({
            totalSteps: freshRow.total_steps ?? 0,
            correctAnswers: freshRow.correct_answers ?? 0,
            bestStreakDays: freshRow.best_streak_days ?? 0,
            points: freshRow.points ?? 0,
            streakCount: freshRow.streak_count ?? 0,
            dailyChampionshipWins: freshRow.daily_championship_wins ?? 0,
            weeklyChampionshipWins: freshRow.weekly_championship_wins ?? 0,
            monthlyChampionshipWins: freshRow.monthly_championship_wins ?? 0,
        });

        // (المرحلة 9) إجابة صح على السؤال اليومي ممكن تفتح وسام (بداية
        // موفقة/دماغ حديد/قناص) أو حتى تكمل ستريك يفتح وسام
        checkAndUnlockBadges();

        await notifyLeaderboardPassIfNeeded('points', oldPoints, freshRow.points ?? oldPoints);
        // (إصلاح باج "الأرقام الوهمية") - نفس السبب المذكور في
        // flushPendingStepsBatch() فوق
        await refreshActiveLeaderboard();
    } catch (error) {
        // فشل التحديث البصري مش لازم يكسر تجربة السؤال اليومي نفسها
        // (النقاط أصلاً اتسجّلت أو متسجّلتش في السيرفر بغض النظر عن
        // نجاح الجلب ده) - بنسجل الخطأ بس ونعرض Toast
        console.error('خطأ في تحديث بيانات البروفايل بعد السؤال اليومي:', error.message);
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: error.message, type: 'error' } }));
    }
}


function scheduleStepsBatchFlush() {
    if (stepsBatchFlushTimer) return; // فيه Flush مجدول بالفعل، مفيش داعي نكرر
    stepsBatchFlushTimer = setTimeout(flushPendingStepsBatch, STEPS_BATCH_FLUSH_INTERVAL_MS);
}

/**
 * تُستدعى من app.js لما المستخدم يكسب خطوات جديدة (من حساس الحركة
 * الحقيقي فقط دلوقتي). (المرحلة 7) بدل ما تعمل UPDATE مباشر على
 * Supabase مع كل نداء، بتجمّع (Accumulate) الخطوات والنقاط في
 * pendingStepsDelta/pendingStepsPointsDelta وتجدول Flush دوري
 * (scheduleStepsBatchFlush). لو الكمية المتراكمة كبيرة (مشي/جري سريع)
 * بتعمل Flush فوري بدل ما تستنى الـ 8 ثواني كاملة.
 * @param {number} addedSteps - عدد الخطوات المضافة في النداء ده
 * @param {number} [pointsEarned] - عدد النقاط المكتسبة من الخطوات دي (اختياري)
 */
export function recordStepsProgress(addedSteps, pointsEarned = 0) {
    if (!addedSteps) return;

    // (إصلاح - باج حقيقي): كنا بنرفض الخطوة كاملة هنا لو currentAuthUser/
    // currentProfileRow لسه مش متظبطين (يعني لسه بنحمّل بيانات البروفايل
    // من الشبكة، أو bindActivityEvents اتربطت متأخرة). الرفض ده كان
    // بيضيع الخطوة نهائيًا من غير أي حفظ احتياطي، فمجموع البروفايل/
    // الليدربورد كان بيفضل أقل من الشاشة الرئيسية (اللي بتتحدث فورًا من
    // غير الشرط ده في app.js).
    // دلوقتي: بنجمّع الخطوات دايمًا بغض النظر عن حالة تسجيل الدخول.
    pendingStepsDelta += addedSteps;
    pendingStepsPointsDelta += pointsEarned;

    if (!currentAuthUser || !currentProfileRow) {
        // لسه مفيش مستخدم/بروفايل جاهز نبعت له - نحفظ الرصيد ده محليًا
        // كشبكة أمان (زي ما بيحصل وقت إغلاق الصفحة أو انقطاع النت) لحد
        // ما loadAndRenderRealProfile تخلص وتعمل flushPendingStepsBatch
        persistPendingStepsToStorage();
        return;
    }

    if (pendingStepsDelta >= STEPS_BATCH_FORCE_FLUSH_THRESHOLD) {
        flushPendingStepsBatch();
    } else {
        scheduleStepsBatchFlush();
    }
}

// (إصلاح - باج حقيقي) كان الـ listener بتاع 'steps:progress' بيتربط بس
// جوه bindActivityEvents، اللي بدورها بتتنادى بس *بعد* ما initProfileUI
// تخلص await loadAndRenderRealProfile (نداء شبكة). في الفترة من فتح
// التطبيق لحد ما النداء ده يخلص، أي حدث 'steps:progress' كان بيتبعث
// من app.js من غير أي listener مسجّل أصلاً يستقبله - يعني بيضيع نهائيًا
// (CustomEvent مالوش Queue). ده كان بيسبب فرق دايم بين عداد الشاشة
// الرئيسية (بيتحدث فورًا من app.js) وعداد البروفايل/الليدربورد (اللي
// بيتغذى من هنا). دلوقتي بنربط الـ listener ده فورًا عند تحميل الملف،
// مستقل تمامًا عن حالة تسجيل الدخول - recordStepsProgress نفسها بقت
// بتجمّع الخطوة في pendingStepsDelta وتحفظها احتياطيًا حتى لو المستخدم
// لسه مسجّلش دخول/البروفايل لسه بيتحمّل.
document.addEventListener('steps:progress', (event) => {
    recordStepsProgress(event.detail?.addedSteps ?? 0, event.detail?.pointsEarned ?? 0);
});

// نسترجع فورًا عند تحميل الملف أي رصيد خطوات فضل محفوظ في localStorage
// من جلسة سابقة اتقفلت قبل ما تتبعت (شوف persistPendingStepsToStorage) -
// لازم يحصل ده *قبل* أي حدث 'steps:progress' جديد يوصل، وإلا الرصيد
// الجديد هيطغى (Overwrite) على النسخة المحفوظة القديمة وتضيع. النداء
// التاني بتاع نفس الدالة جوه bindStepsFlushLifecycleEvents آمن تمامًا -
// المفتاح بيتمسح فور القراءة فمفيش أي احتمال يتضاعف الرصيد.
restorePendingStepsFromStorage();

/**
 * ربط أحداث دورة حياة الصفحة (تبديل التاب/تصغير المتصفح/إغلاقه) بعمل
 * Flush فوري لأي خطوات لسه متراكمة ومتبعتتش لـ Supabase - عشان مفيش
 * فرق كبير يضيع لو المستخدم قفل التاب قبل ما الـ Flush الدوري (كل 8
 * ثواني) يجيله دوره. visibilitychange بيتغطّى بيه أغلب الحالات
 * (تبديل تاب، تصغير، قفل الشاشة على الموبايل)، وpagehide بتغطي حالة
 * إغلاق/مغادرة الصفحة نهائياً. محمية بعلم عشان الربط يحصل مرة واحدة
 * بس (initProfileUI ممكن تتنادى أكتر من مرة).
 */
/**
 * حفظ الخطوات/النقاط المتراكمة (اللي لسه متبعتتش لـ Supabase) في
 * localStorage كـ"شبكة أمان" - بتتنادى بس وقت إغلاق/مغادرة الصفحة
 * والمستخدم offline (شوف bindStepsFlushLifecycleEvents)، عشان لو حصل
 * كده نقدر نسترجعها تاني في الجلسة الجاية بدل ما تضيع نهائياً
 */
function persistPendingStepsToStorage() {
    if (pendingStepsDelta <= 0) return;

    try {
        window.localStorage.setItem(PENDING_STEPS_STORAGE_KEY, JSON.stringify({
            stepsDelta: pendingStepsDelta,
            pointsDelta: pendingStepsPointsDelta,
        }));
    } catch (err) {
        console.error('تعذر حفظ الخطوات المتراكمة محلياً قبل إغلاق الصفحة:', err);
    }
}

/**
 * استرجاع أي خطوات/نقاط اتحفظت في localStorage من جلسة سابقة (المستخدم
 * قفل الصفحة وهو offline قبل ما يحصل Flush)، وضمّها لأي خطوات متراكمة
 * حالياً - بتتنادى مرة واحدة بس عند بداية تشغيل التطبيق (راجع
 * bindStepsFlushLifecycleEvents). بتمسح المفتاح فور القراءة عشان
 * منضمّهاش تاني بالغلط في المرة الجاية
 */
function restorePendingStepsFromStorage() {
    try {
        const raw = window.localStorage.getItem(PENDING_STEPS_STORAGE_KEY);
        if (!raw) return;

        window.localStorage.removeItem(PENDING_STEPS_STORAGE_KEY);

        const saved = JSON.parse(raw);
        if (saved?.stepsDelta > 0) {
            pendingStepsDelta += saved.stepsDelta;
            pendingStepsPointsDelta += saved.pointsDelta || 0;
            scheduleStepsBatchFlush();
        }
    } catch (err) {
        console.error('تعذر استرجاع الخطوات المتراكمة من localStorage:', err);
    }
}

/**
 * ربط أحداث دورة حياة الصفحة (تبديل التاب/تصغير المتصفح/إغلاقه) وحالة
 * الشبكة (online/offline) بعمل Flush فوري لأي خطوات لسه متراكمة
 * ومتبعتتش لـ Supabase - عشان مفيش فرق كبير يضيع لو المستخدم قفل التاب
 * قبل ما الـ Flush الدوري (كل 8 ثواني) يجيله دوره. visibilitychange
 * بيتغطّى بيه أغلب الحالات (تبديل تاب، تصغير، قفل الشاشة على الموبايل)،
 * وpagehide بتغطي حالة إغلاق/مغادرة الصفحة نهائياً.
 *
 * إضافتين هنا:
 * 1) 'online': لو النت رجع بعد ما كان مقطوع، بنعمل flushPendingStepsBatch
 *    فوراً بدل ما نستنى الـ Flush الدوري - عشان أي خطوات اتراكمت أثناء
 *    الانقطاع تتبعت لـ Supabase على طول.
 * 2) لو المستخدم بيقفل/بيغادر الصفحة وهو offline فعلاً (navigator.onLine
 *    === false)، محاولة flushPendingStepsBatch هتفشل أكيد (مفيش نت)،
 *    فبدل ما نضيع الخطوات دي، بنحفظها في localStorage
 *    (persistPendingStepsToStorage) عشان تتسترجع (restorePendingStepsFromStorage)
 *    وتتبعت تاني أول ما التطبيق يفتح تاني (أو أول ما النت يرجع لو التاب
 *    لسه فاتح - راجع الـ 'online' listener فوق).
 *
 * محمية بعلم عشان الربط يحصل مرة واحدة بس (initProfileUI ممكن تتنادى
 * أكتر من مرة).
 */
function bindStepsFlushLifecycleEvents() {
    if (stepsFlushLifecycleBound) return;
    stepsFlushLifecycleBound = true;

    // أي خطوات اتحفظت من جلسة سابقة (المستخدم قفل الصفحة وهو offline)
    // بنضمّها دلوقتي عشان تتبعت مع أول Flush جاي
    restorePendingStepsFromStorage();

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') return;

        if (navigator.onLine) {
            flushPendingStepsBatch();
        } else {
            persistPendingStepsToStorage();
        }
    });

    window.addEventListener('pagehide', () => {
        if (navigator.onLine) {
            flushPendingStepsBatch();
        } else {
            // مفيش نت = طلب الـ Flush هيفشل أكيد، فبدل ما نضيع الخطوات
            // دي، بنحفظها محلياً عشان تتسترجع في الجلسة الجاية
            persistPendingStepsToStorage();
        }
    });

    // أول ما النت يرجع بعد انقطاع، ابعت أي خطوات متراكمة فوراً بدل ما
    // تستنى معاد الـ Flush الدوري
    window.addEventListener('online', () => {
        flushPendingStepsBatch();
    });
}

/**
 * ربط أحداث النشاط الجايّة من app.js (تسجيل خطوات) بدوال الحفظ في
 * Supabase - بنستخدم CustomEvents بدل استيراد مباشر من app.js عشان
 * نتجنب الاعتماد الدائري (Circular Import)، بنفس فلسفة باقي التطبيق
 * (شوف app:toast)
 * ملحوظة: الـ Listener بتاع 'quiz:answer-submitted' (تحدي الذكاء
 * اليومي القديم) اتشال من هنا مع باقي منطق الكويز القديم.
 */
function bindActivityEvents() {
    if (activityEventsBound) return;
    activityEventsBound = true;

    // (إصلاح أمني) js/daily-question.js دلوقتي بيطلق الحدث ده بس *بعد*
    // ما دالة RPC في السيرفر (record_daily_question_result) تتحقق من
    // الإجابة وتمنح النقاط فعلياً جوه الداتابيز - isCorrect هنا قيمة
    // مؤكدة من السيرفر مش من المتصفح، وalreadyRecorded بتبقى true لو
    // الـ Slot ده كان اتسجّل بالفعل النهاردة (فمفيش داعي نعمل أي حاجة).
    // حتى لو حد طلق الحدث ده يدوياً من الـ Console بقيم وهمية، الدالة
    // اللي بتتنادى هنا (refreshProfileAfterDailyQuestion) بتعمل SELECT
    // بس من غير أي كتابة نقاط - فمفيش أي فايدة من التلاعب بالحدث تاني.
    document.addEventListener('dailyQuestion:answered', (event) => {
        if (event.detail?.isCorrect && !event.detail?.alreadyRecorded) {
            refreshProfileAfterDailyQuestion();
        }
    });

    // (المرحلة 7) ربط Flush الطارئ عند مغادرة/إخفاء الصفحة، مرة واحدة بس
    bindStepsFlushLifecycleEvents();
}

/**
 * حساب عدد الشهور منذ تاريخ معين (تُستخدم مع created_at بتاع البروفايل)
 * @param {string} isoDateString
 * @returns {number}
 */
function monthsSince(isoDateString) {
    if (!isoDateString) return 0;
    const createdDate = new Date(isoDateString);
    if (Number.isNaN(createdDate.getTime())) return 0;

    const now = new Date();
    const months = (now.getFullYear() - createdDate.getFullYear()) * 12
        + (now.getMonth() - createdDate.getMonth());
    return Math.max(0, months);
}

/**
 * تحديث النصوص الأساسية والصورة في كارت البروفايل (الاسم، الصورة،
 * اللقب، تاريخ الانضمام) اعتماداً على صف profiles الحقيقي من
 * Supabase. لو الصف مش موجود، بنرجع لقيم افتراضية واضحة بدل ما نعرض
 * بيانات وهمية زي "أحمد كابو" (كانت متسيبة في الـ HTML كمعاينة تصميم).
 * @param {object|null} profile - صف profiles الحقيقي (من fetchUserProfile)
 * @param {object} user - بيانات المستخدم القادمة من js/auth.js (Fallback)
 */
export function renderProfileHeader(profile, user) {
    const nameEl = document.getElementById('profileName');
    const titleEl = document.getElementById('profileTitle');
    const joinedEl = document.getElementById('profileJoinedText');
    const avatarEl = document.getElementById('profileAvatar');
    // (جديد) أيقونة الشخص العامة بتاعة كارت البروفايل - نفس فلسفة
    // #headerAvatarGuestIcon تحت بالظبط، شوف toggleAvatarPair لتفاصيل أكتر
    const avatarGuestIconEl = document.getElementById('profileAvatarGuestIcon');
    // العناصر دي في الـ Header العلوي بتاع الصفحة الرئيسية (مش كارت
    // البروفايل) - كانت متسيبة Hardcoded في index.html من غير أي id،
    // فمكانش فيه طريقة نحدّثها؛ دلوقتي بعد إضافة الـ id ليهم بنحدّثهم
    // هنا كمان عشان الاسم والصورة يتزامنوا في كل الشاشة مش بس تبويب
    // "بروفايلي"
    const headerAvatarEl = document.getElementById('headerAvatar');
    const headerNameEl = document.getElementById('headerUserName');
    // زي headerNameEl بالظبط: عنصر اللقب اللي تحت الاسم في الهيدر العلوي.
    // كان النص فيه ثابت Hardcoded ("سِكّاوي") كمعاينة تصميم مؤقتة
    // بس، ومكانش بيتحدّث باللقب الحقيقي للمستخدم؛ دلوقتي بنربطه بنفس
    // مصدر البيانات الحقيقي (profile.title) اللي بيغذّي #profileTitle
    // جوه تبويب "بروفايلي"، عشان الاتنين يتزامنوا دايماً.
    const headerTitleEl = document.getElementById('headerUserTitle');
    // (جديد) أيقونة "زائر" العامة (نفس أيقونة #profileGuestView) اللي
    // بتاخد مكان #headerAvatar الحقيقية لما مفيش حساب فعلي
    const headerAvatarGuestIconEl = document.getElementById('headerAvatarGuestIcon');

    /**
     * (تصحيح - باج حقيقي كان ظاهر في السكرين شوت): على نت بطيء، الصورة
     * الوهمية (Unsplash) الـ Hardcoded في HTML كانت هي الافتراضية الأولى
     * (قبل ما JS يتنفذ خالص)، فكانت بتفضل ظاهرة كأنها صورة بروفايل حقيقية
     * لثواني - حتى لزائر معندوش حساب أصلاً. دلوقتي الأيقونة العامة هي
     * الافتراضية الأكيدة في الـ HTML نفسه (مش بس في الـ JS)، والصورة
     * الحقيقية بتظهر بس لما تتأكد فعليًا إن avatar_url وصل من Supabase.
     * نفس الدالة دي بتتحكم في زوج <img>/<icon div> سواء بتاع الهيدر أو
     * كارت البروفايل - بتاخد العنصرين + رابط الصورة (لو موجود فعلاً).
     * @param {HTMLElement|null} imgEl
     * @param {HTMLElement|null} iconEl
     * @param {string|null|undefined} avatarUrl
     */
    function toggleAvatarPair(imgEl, iconEl, avatarUrl) {
        const hasRealAvatar = Boolean(avatarUrl);
        if (imgEl) {
            imgEl.classList.toggle('hidden', !hasRealAvatar);
            if (hasRealAvatar) imgEl.src = avatarUrl;
        }
        if (iconEl) iconEl.classList.toggle('hidden', hasRealAvatar);
    }

    // (جديد - طلب صريح): الهيدر العلوي الثابت (ظاهر في كل التابات مش
    // بس تبويب بروفايلي) كان بيفضل معلّق على شكل "هيكل تحميل" (Skeleton)
    // للأبد للزائر - لأن مفيش profile.full_name ولا كاش هيوصلوله أبدًا.
    // دلوقتي: زائر (مفيش user.id) => أيقونة شخص عامة بدل الصورة، نص
    // "زائر" بدل الاسم، واللقب بيتخفي بالكامل (مالوش معنى لزائر أصلاً)
    const isGuestHeader = !user?.id;
    toggleAvatarPair(headerAvatarEl, headerAvatarGuestIconEl, isGuestHeader ? null : profile?.avatar_url);
    toggleAvatarPair(avatarEl, avatarGuestIconEl, isGuestHeader ? null : profile?.avatar_url);
    if (headerTitleEl) headerTitleEl.classList.toggle('hidden', isGuestHeader);

    // نقطة "أونلاين الآن" فوق صورتي أنا (هيدر علوي + كارت البروفايل) -
    // مفيش داعي نخبيها للزائر عشان أصلاً مفيش صورة حقيقية ظاهرة أصلاً؛
    // get_presence_for_users بترجع صف نفسي دايماً (auth.uid() = id)
    // شوف js/presence.js
    const headerPresenceDotEl = document.getElementById('headerAvatarPresenceDot');
    const profilePresenceDotEl = document.getElementById('profileAvatarPresenceDot');
    if (!isGuestHeader && user?.id) {
        if (headerPresenceDotEl) headerPresenceDotEl.setAttribute('data-presence-avatar', user.id);
        if (profilePresenceDotEl) profilePresenceDotEl.setAttribute('data-presence-avatar', user.id);
        loadAndApplyPresence([user.id]);
    } else {
        if (headerPresenceDotEl) headerPresenceDotEl.classList.remove('is-online');
        if (profilePresenceDotEl) profilePresenceDotEl.classList.remove('is-online');
    }

    if (isGuestHeader) {
        if (headerNameEl) {
            headerNameEl.classList.remove('header-name-skeleton');
            headerNameEl.textContent = 'زائر';
        }
        // مفيش داعي نكمل باقي الدالة (الاسم/اللقب/الصورة الحقيقية) للزائر -
        // مفيش profile حقيقي أصلاً نعرضه، وأيقونة الشارة المميزة (الأوسمة)
        // مالهاش معنى برضه من غير حساب
        return;
    }

    // (إصلاح - "لقب الشرف" بقى مرتبط بالأوسمة): مفيش قايمة ألقاب ثابتة
    // نرجع لها كـ Fallback (كانت "ابن البلد") - لو المستخدم لسه ملوش
    // لقب محدد (title لسه null لأنه لسه معملش اختيار، أو حتى معندوش أي
    // وسام مفتوح أصلاً)، بنعرض نص واضح بدل ما نختلق لقب وهمي
    const cachedName = readCachedHeaderField(CACHED_DISPLAY_NAME_KEY);
    const cachedTitle = readCachedHeaderField(CACHED_DISPLAY_TITLE_KEY);

    const displayName = profile?.full_name || cachedName;
    const displayTitle = profile?.title || cachedTitle || null;
    const joinedMonthsAgo = monthsSince(profile?.created_at);

    // بمجرد ما نوصل لاسم/لقب حقيقي فعلاً (مش كاش) من صف profiles،
    // بنحدّث الكاش المحلي عشان يبقى جاهز لأول رسمة في زيارة/Refresh
    // جاية على نفس الجهاز
    if (profile?.full_name) writeCachedHeaderField(CACHED_DISPLAY_NAME_KEY, profile.full_name);
    if (profile?.title) writeCachedHeaderField(CACHED_DISPLAY_TITLE_KEY, profile.title);

    // لو مفيش لسه أي اسم (لا حقيقي ولا كاش - أول مرة على الجهاز ده)،
    // بنعرض هيكل تحميل هادي (Skeleton) بدل أي نص وهمي، وبنسيب باقي
    // العناصر (اللقب، تاريخ الانضمام، الصورة) على حالها لحد ما تتحدث
    if (nameEl) {
        if (displayName) {
            nameEl.classList.remove('header-name-skeleton');
            nameEl.textContent = displayName;
        } else {
            nameEl.classList.add('header-name-skeleton');
            nameEl.textContent = '';
        }
    }
    if (titleEl) {
        titleEl.textContent = displayTitle
            ? `لقب الشرف: ${displayTitle}`
            : 'لسه معندكش لقب شرف - افتح وسام واختاره من إعدادات الحساب';
    }
    if (joinedEl) {
        joinedEl.textContent = joinedMonthsAgo > 0
            ? `انضم لـ "سِكّاوي" من ${joinedMonthsAgo} شهور`
            : 'انضم لـ "سِكّاوي" حديثاً';
    }

    if (headerNameEl) {
        if (displayName) {
            headerNameEl.classList.remove('header-name-skeleton');
            headerNameEl.textContent = displayName;
        } else {
            headerNameEl.classList.add('header-name-skeleton');
            headerNameEl.textContent = '';
        }
    }
    if (headerTitleEl) headerTitleEl.textContent = displayTitle || 'لسه من غير لقب';

    // (المرحلة 7) أيقونة الشارة المميزة جنب الاسم - في كارت "بروفايلي"
    // وفي الهيدر العلوي مع بعض. بنستنى الكتالوج لو لسه مش محمّل (Fire
    // and forget - من غير await هنا عشان renderProfileHeader نفسها
    // فضلت sync زي ما هي، الشارة هتظهر بمجرد ما الكتالوج يوصل)
    ensureBadgesCatalogCache().then(() => {
        renderFeaturedBadgeInline(nameEl, profile?.featured_badge_id);
        renderFeaturedBadgeInline(headerNameEl, profile?.featured_badge_id);
    });
}

/**
 * تحديث شبكة الإحصائيات السريعة (إجمالي الخطوات، الإجابات الصحيحة،
 * أطول ستريك)، وكمان شارتي "النقاط" و"الستريك الحالي" في الهيدر
 * العلوي - كل ده من نفس مصدر البيانات الحقيقي (صف profiles)
 * @param {Partial<typeof profileStats>} newStats - القيم الجديدة (جزئية أو كاملة)
 */
export function updateProfileStats(newStats = {}) {
    profileStats = { ...profileStats, ...newStats };

    const totalStepsEl = document.getElementById('statTotalSteps');
    const correctAnswersEl = document.getElementById('statCorrectAnswers');
    const bestStreakEl = document.getElementById('statBestStreak');
    const headerPointsEl = document.getElementById('userPoints');
    const headerStreakEl = document.getElementById('headerStreakCount');
    const dailyWinsEl = document.getElementById('statDailyWins');
    const weeklyWinsEl = document.getElementById('statWeeklyWins');
    const monthlyWinsEl = document.getElementById('statMonthlyWins');

    if (totalStepsEl) totalStepsEl.textContent = formatCompactNumber(profileStats.totalSteps);
    if (correctAnswersEl) correctAnswersEl.textContent = profileStats.correctAnswers;
    if (bestStreakEl) bestStreakEl.textContent = `${profileStats.bestStreakDays} أيام`;
    if (headerPointsEl) headerPointsEl.textContent = profileStats.points.toLocaleString();
    if (headerStreakEl) headerStreakEl.textContent = `${profileStats.streakCount} أيام`;
    // (جديد) عدد مرات الفوز بكل بطولة - القيم دي مصدرها الوحيد هو
    // process_leaderboard_period_resets() على Supabase (بتتزود تلقائياً
    // وقت تصفير كل فترة لو المستخدم كان البطل)، مفيش أي منطق تاني في
    // الفرونت إند بيغيّرها
    if (dailyWinsEl) dailyWinsEl.textContent = profileStats.dailyChampionshipWins;
    if (weeklyWinsEl) weeklyWinsEl.textContent = profileStats.weeklyChampionshipWins;
    if (monthlyWinsEl) monthlyWinsEl.textContent = profileStats.monthlyChampionshipWins;
}

/** تنسيق رقم كبير بصيغة مختصرة (142500 -> 142.5K) */
function formatCompactNumber(num) {
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
}

/* ==================================================================
   المرحلة 4: الأوسمة الحقيقية (Badges System)
   ------------------------------------------------------------------
   بيتطلب جدولين على Supabase:

   create table public.badges (
       id           text primary key,        -- زي 'runner', 'champion'
       icon         text not null,            -- إيموجي أو رابط أيقونة
       title        text not null,
       description  text not null,
       sort_order   int  not null default 0
   );

   create table public.user_badges (
       id          uuid primary key default gen_random_uuid(),
       user_id     uuid not null references public.profiles(id) on delete cascade,
       badge_id    text not null references public.badges(id) on delete cascade,
       unlocked_at timestamptz not null default now(),
       unique (user_id, badge_id)
   );

   RLS المقترحة: badges قراءة عامة (select للجميع)، user_badges قراءة
   لصاحب الصف بس (auth.uid() = user_id)، والإدراج (unlock) إما من
   Edge Function موثوقة أو بشرط auth.uid() = user_id لو بيتم من العميل.

   المرحلة 9 (فتح الأوسمة تلقائياً): كل الأوسمة اللي شرطها رقم بسيط في
   profiles (خطوات/إجابات صح/ستريك/بطولات) أو عدد أصدقاء بتتفحص وتتفتح
   سيرفر-سايد بالكامل عن طريق Triggers على Supabase (on_profile_stats_updated
   على profiles + on_friend_accepted على friends، بينادوا دالة واحدة
   check_and_unlock_badges - شوف badges-catalog.sql) - مش بحساب شروط في
   الفرونت إند. checkAndUnlockBadges() هنا في الفرونت إند مالهاش أي علاقة
   بفتح الوسام نفسه، دورها بس إنها تكتشف "إيه اللي اتفتح جديد" (بمقارنة
   الأوسمة المفتوحة قبل/بعد) عشان تبعت إشعار "وسام جديد!" فورًا. الوسام
   الوحيد المستثنى تمامًا من الـ Triggers هو "قدوة" (top3_leaderboard)
   لأن شرطه ترتيب نسبي وسط كل المستخدمين مش عمود ثابت في صف واحد - ده
   بيتفتح دلوقتي من جوه loadAndRenderPeriod() في js/leaderboard.js (بعد
   نقل الفحص ده من هنا - شوف إصلاح باج "الأرقام الوهمية").
   ================================================================== */

/**
 * جلب كتالوج كل الأوسمة الممكنة في اللعبة (مفتوحة كانت أو مقفولة لأي حد)
 * @returns {Promise<Array<object>>}
 */
async function fetchBadgesCatalog() {
    const { data, error } = await supabaseClient
        .from('badges')
        .select('id, icon, title, description, tier, sort_order')
        .order('sort_order', { ascending: true });

    if (error) {
        console.error('خطأ في جلب كتالوج الأوسمة:', error.message);
        return [];
    }

    return data || [];
}

/**
 * جلب أوسمة المستخدم الحالي المفتوحة فعلاً + وقت فتح كل واحدة منها
 * (unlocked_at) - محتاجين الوقت عشان نرتّب الوسام الأحدث فتحًا في
 * بداية تصنيفه (شوف sortBadgesForDisplay تحت)
 * @param {string} userId
 * @returns {Promise<Map<string, string>>} badge_id -> unlocked_at (ISO string)
 */
async function fetchUnlockedBadgesMap(userId) {
    const { data, error } = await supabaseClient
        .from('user_badges')
        .select('badge_id, unlocked_at')
        .eq('user_id', userId);

    if (error) {
        console.error('خطأ في جلب أوسمة المستخدم:', error.message);
        return new Map();
    }

    return new Map((data || []).map((row) => [row.badge_id, row.unlocked_at]));
}

/**
 * ترتيب مصفوفة أوسمة (كل واحدة فيها tier + unlocked + unlockedAt +
 * sortOrder) حسب: التصنيف الأول (عادية -> متوسطة -> صعبة -> أسطورية)،
 * وجوه نفس التصنيف: المفتوح قبل المقفول، والمفتوح الأحدث فتحًا في
 * البداية (unlocked_at الأكبر الأول)، والمقفول بترتيب sort_order
 * الأصلي (تدرّج الصعوبة المعتاد)
 * @param {Array<object>} list
 * @returns {Array<object>} نسخة جديدة مرتّبة (مش بتعدّل المصفوفة الأصلية)
 */
function sortBadgesForDisplay(list) {
    return [...list].sort((a, b) => {
        const tierDiff = BADGE_TIER_ORDER.indexOf(a.tier) - BADGE_TIER_ORDER.indexOf(b.tier);
        if (tierDiff !== 0) return tierDiff;

        if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;

        if (a.unlocked && b.unlocked) {
            return new Date(b.unlockedAt).getTime() - new Date(a.unlockedAt).getTime();
        }

        return a.sortOrder - b.sortOrder;
    });
}

/**
 * جلب كتالوج الأوسمة كامل + دمجه مع أوسمة المستخدم الحالي المفتوحة،
 * وتحديث badgesData ورسمها في الشبكة. تُستدعى من initProfileUI وكمان
 * بعد أي unlockBadge ناجحة.
 * @param {string} userId
 */
async function loadAndRenderBadges(userId) {
    const [catalog, unlockedMap] = await Promise.all([
        fetchBadgesCatalog(),
        fetchUnlockedBadgesMap(userId),
    ]);

    const rawBadges = catalog.map((badge) => ({
        id: badge.id,
        icon: badge.icon,
        title: badge.title,
        desc: badge.description,
        tier: badge.tier,
        sortOrder: badge.sort_order,
        unlocked: unlockedMap.has(badge.id),
        unlockedAt: unlockedMap.get(badge.id) || null,
    }));

    badgesData = sortBadgesForDisplay(rawBadges);

    // (المرحلة 7) نبني/نحدّث كاش الأيقونات هنا كمان من نفس الكتالوج اللي
    // جبناه فوق بالظبط - من غير أي نداء شبكة إضافي (شوف ensureBadgesCatalogCache تحت)
    badgesCatalogCache = new Map(catalog.map((badge) => [badge.id, { icon: badge.icon, title: badge.title }]));

    renderBadges();

    // لو صفحة "الأوسمة والشارات" الكاملة مفتوحة فعلاً دلوقتي (نادرة، بس
    // ممكن لو Trigger فتح وسام جديد أثناء ما المستخدم فاتحها)، حدّثها
    // كمان فوراً بدل ما تفضل عارضة بيانات قديمة لحد ما يقفلها ويفتحها تاني
    const badgesPage = document.getElementById('tab-badges-page');
    if (badgesPage && badgesPage.classList.contains('active')) {
        renderBadgesPage();
    }
}

/**
 * بترجع كاش كتالوج الأوسمة (id -> {icon, title})، وتجيبه من Supabase
 * أول مرة بس لو لسه مش محمّل (مثلاً حد فتح بروفايل عام مباشرة من غير
 * ما loadAndRenderBadges تتنادى الأول لبروفايله هو). كل الأماكن اللي
 * محتاجة تعرض أيقونة الشارة المميزة (renderProfileHeader،
 * renderPublicProfileContent) بتمر من هنا.
 * @returns {Promise<Map<string, {icon: string, title: string}>>}
 */
async function ensureBadgesCatalogCache() {
    if (badgesCatalogCache) return badgesCatalogCache;

    if (!badgesCatalogLoadPromise) {
        badgesCatalogLoadPromise = fetchBadgesCatalog().then((catalog) => {
            badgesCatalogCache = new Map(catalog.map((badge) => [badge.id, { icon: badge.icon, title: badge.title }]));
            badgesCatalogLoadPromise = null;
            return badgesCatalogCache;
        });
    }

    return badgesCatalogLoadPromise;
}

/**
 * المرحلة 7: تجهيز/تحديث أيقونة "الشارة المميزة" اللي بتظهر يمين اسم
 * أي مستخدم مباشرة (لو محدد featured_badge_id عنده). بننشئ عنصر
 * <span> واحد بس أول مرة جنب عنصر الاسم (data-featured-badge-for=
 * "id بتاع عنصر الاسم")، وبعد كده بس بنحدّث محتواه أو نشيله - بنستخدم
 * DOM API (مش innerHTML) عشان منحتاجش نعمل escape للاسم بنفسنا هنا.
 * لازم يكون عنصر الاسم عنده id فعلي عشان نربط الشارة بيه.
 * @param {HTMLElement|null} nameEl
 * @param {string|null|undefined} featuredBadgeId
 */
function renderFeaturedBadgeInline(nameEl, featuredBadgeId) {
    if (!nameEl || !nameEl.id || !nameEl.parentElement) return;

    let badgeEl = nameEl.parentElement.querySelector(`[data-featured-badge-for="${nameEl.id}"]`);

    const badge = featuredBadgeId ? badgesCatalogCache?.get(featuredBadgeId) : null;

    if (!badge) {
        if (badgeEl) badgeEl.remove();
        return;
    }

    if (!badgeEl) {
        badgeEl = document.createElement('span');
        badgeEl.dataset.featuredBadgeFor = nameEl.id;
        badgeEl.className = 'featured-badge-icon';
        badgeEl.style.marginInlineStart = '0.25rem';
        nameEl.insertAdjacentElement('afterend', badgeEl);
    }

    badgeEl.textContent = badge.icon;
    badgeEl.title = badge.title;
}

/**
 * الـ HTML بتاع كارت وسام واحد (مفتوح أو مقفول) - مُستخرجة لدالة واحدة
 * عشان تتستخدم في المعاينة المصغّرة (renderBadges) والصفحة الكاملة
 * (renderBadgesPage) من غير ما نكرر نفس الـ Markup في المكانين
 * @param {{icon:string, title:string, desc:string, unlocked:boolean}} badge
 * @returns {string}
 */
function badgeCardHtml(badge) {
    return `
        <div class="${badge.unlocked
            ? 'bg-gold-500/10 border border-gold-500/30 badge-glow'
            : 'bg-lux-800/50 border border-gold-500/15 grayscale opacity-60 relative'}
            p-3 rounded-2xl text-center flex flex-col items-center justify-center space-y-1 shadow-xs">
            ${!badge.unlocked ? '<span class="absolute top-1 right-1 text-lux-400"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' : ''}
            <span class="text-2xl">${badge.icon}</span>
            <span class="font-extrabold text-lux-100 text-xs">${badge.title}</span>
            <span class="text-[9px] ${badge.unlocked ? 'text-gold-400' : 'text-lux-400'} font-bold">${badge.desc}</span>
        </div>
    `;
}

/**
 * أول 6 أوسمة بس (من نفس ترتيب badgesData الجاهز - تصنيف ثم الأحدث
 * فتحًا أولاً، شوف sortBadgesForDisplay) داخل شبكة البروفايل المصغّرة.
 * الشبكة كلها (بالتصنيفات) بتتعرض من زرار "دولاب الأوسمة والشارات" ->
 * openBadgesPage تحت.
 */
export function renderBadges() {
    const grid = document.getElementById('badgesGrid');
    const countLabel = document.getElementById('badgesUnlockedCount');
    if (!grid) return;

    if (badgesData.length === 0) {
        grid.innerHTML = `<p class="col-span-3 text-xs text-lux-500 font-medium text-center py-3">لسه مفيش أوسمة متاحة</p>`;
        if (countLabel) countLabel.textContent = '0 / 0 مفتوح';
        return;
    }

    grid.innerHTML = badgesData.slice(0, 6).map(badgeCardHtml).join('');

    if (countLabel) {
        const unlockedCount = badgesData.filter((b) => b.unlocked).length;
        countLabel.textContent = `${unlockedCount} / ${badgesData.length} مفتوح`;
    }
}

/**
 * رسم صفحة "الأوسمة والشارات" الكاملة (#tab-badges-page) - كل الأوسمة
 * مقسّمة بعنوان لكل تصنيف (عادية/متوسطة/صعبة/أسطورية)، وجوه كل تصنيف
 * الترتيب جاهز من badgesData (الأحدث فتحًا أولاً). بتتنادى من
 * openBadgesPage، وكمان من loadAndRenderBadges لو الصفحة كانت مفتوحة
 * وقت ما وسام جديد اتفتح.
 */
function renderBadgesPage() {
    const container = document.getElementById('badgesPageGroups');
    const countLabel = document.getElementById('badgesPageCount');
    if (!container) return;

    if (badgesData.length === 0) {
        container.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-8">لسه مفيش أوسمة متاحة</p>`;
        if (countLabel) countLabel.textContent = '0 / 0 مفتوح';
        return;
    }

    container.innerHTML = BADGE_TIER_ORDER.map((tierKey) => {
        const tierBadges = badgesData.filter((b) => b.tier === tierKey);
        if (tierBadges.length === 0) return '';

        return `
            <div class="space-y-3">
                <h4 class="text-xs font-extrabold text-lux-300">${BADGE_TIER_LABELS[tierKey]}</h4>
                <div class="grid grid-cols-3 gap-3">
                    ${tierBadges.map(badgeCardHtml).join('')}
                </div>
            </div>
        `;
    }).join('');

    if (countLabel) {
        const unlockedCount = badgesData.filter((b) => b.unlocked).length;
        countLabel.textContent = `${unlockedCount} / ${badgesData.length} مفتوح`;
    }
}

/**
 * تفعيل صفحة "الأوسمة والشارات" الكاملة (#tab-badges-page) - نفس آلية
 * تبديل ".tab-content" اللي activatePublicProfilePage/openAccountSettingsPage
 * بتستخدمها بالظبط، مع تسجيل التبويب اللي كنا فيه قبلها عشان زرار
 * "رجوع" يرجعله بالظبط. بتتنادى لما المستخدم يدوس على "دولاب الأوسمة
 * والشارات" في تبويب بروفايله (مش من بروفايل عام لحد تاني - ده نطاق
 * تاني لو حبينا نضيفه بعدين)
 */
function openBadgesPage() {
    const page = document.getElementById('tab-badges-page');
    if (!page) return;

    renderBadgesPage();

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-badges-page') {
        previousTabIdBeforeBadgesPage = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    page.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    pushModalState(hideBadgesPage);
}

/** الإخفاء الخام لصفحة "الأوسمة والشارات" فقط - استخدم closeBadgesPage تحت */
function hideBadgesPage() {
    const targetTabId = previousTabIdBeforeBadgesPage || 'home';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    previousTabIdBeforeBadgesPage = null;
}

/** الرجوع من صفحة "الأوسمة والشارات" - الدالة اللي زرار "رجوع" لازم ينادي عليها بدل hideBadgesPage مباشرة */
function closeBadgesPage() {
    closeModal();
}

/**
 * ربط زرار فتح صفحة "الأوسمة والشارات" الكاملة (من دولاب البروفايل)
 * وزرار "رجوع" جوه الصفحة نفسها - مرة واحدة بس، نفس فكرة
 * editProfileEventsBound بالظبط
 */
function bindBadgesPageEvents() {
    if (badgesPageEventsBound) return;
    badgesPageEventsBound = true;

    const openBtn = document.getElementById('btnOpenBadgesPage');
    if (openBtn) openBtn.addEventListener('click', () => openBadgesPage());

    const backBtn = document.getElementById('btnBackFromBadgesPage');
    if (backBtn) backBtn.addEventListener('click', () => closeBadgesPage());
}

/**
 * تفعيل صفحة "كل الأصدقاء" الكاملة (#tab-friends-list) - نفس آلية تبديل
 * ".tab-content" اللي openBadgesPage/openAccountSettingsPage بتستخدمها
 * بالظبط، مع تسجيل التبويب اللي كنا فيه قبلها عشان زرار "رجوع" يرجعله
 * بالظبط. بتتنادى من زرار "شوف كل الأصدقاء" (#btnShowAllFriends) اللي
 * بيظهر بس لو عدد الأصدقاء أكتر من FRIENDS_PREVIEW_LIMIT (شوف renderFriends)
 */
function openFriendsListPage() {
    const page = document.getElementById('tab-friends-list');
    if (!page) return;

    renderFriendsFull();

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-friends-list') {
        previousTabIdBeforeFriendsListPage = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    page.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    pushModalState(hideFriendsListPage);
}

/** الإخفاء الخام لصفحة "كل الأصدقاء" فقط - استخدم closeFriendsListPage تحت */
function hideFriendsListPage() {
    const targetTabId = previousTabIdBeforeFriendsListPage || 'home';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    previousTabIdBeforeFriendsListPage = null;
}

/** الرجوع من صفحة "كل الأصدقاء" - الدالة اللي زرار "رجوع" لازم ينادي عليها بدل hideFriendsListPage مباشرة */
function closeFriendsListPage() {
    closeModal();
}

/**
 * ربط زرار فتح صفحة "كل الأصدقاء" (#btnShowAllFriends جوه تبويب
 * البروفايل) وزرار "رجوع" جوه الصفحة نفسها - مرة واحدة بس، نفس فكرة
 * bindBadgesPageEvents فوق بالظبط
 */
let friendsListPageEventsBound = false;
function bindFriendsListPageEvents() {
    if (friendsListPageEventsBound) return;
    friendsListPageEventsBound = true;

    const openBtn = document.getElementById('btnShowAllFriends');
    if (openBtn) openBtn.addEventListener('click', () => openFriendsListPage());

    const backBtn = document.getElementById('btnBackFromFriendsList');
    if (backBtn) backBtn.addEventListener('click', () => closeFriendsListPage());
}

/**
 * تفعيل صفحة "كل طلبات الصداقة الواردة" الكاملة (#tab-friend-requests-list) -
 * نفس آلية تبديل ".tab-content" اللي openFriendsListPage بتستخدمها
 * بالظبط. بتتنادى من زرار "شوف كل الطلبات" (#btnShowAllFriendRequests)
 * اللي بيظهر بس لو عدد الطلبات الواردة أكتر من FRIENDS_PREVIEW_LIMIT
 * (شوف renderIncomingFriendRequests)
 */
function openFriendRequestsListPage() {
    const page = document.getElementById('tab-friend-requests-list');
    if (!page) return;

    renderFriendRequestsFull();

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-friend-requests-list') {
        previousTabIdBeforeFriendRequestsListPage = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    page.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    pushModalState(hideFriendRequestsListPage);
}

/** الإخفاء الخام لصفحة "كل طلبات الصداقة الواردة" فقط - استخدم closeFriendRequestsListPage تحت */
function hideFriendRequestsListPage() {
    const targetTabId = previousTabIdBeforeFriendRequestsListPage || 'home';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    previousTabIdBeforeFriendRequestsListPage = null;
}

/** الرجوع من صفحة "كل طلبات الصداقة الواردة" - الدالة اللي زرار "رجوع" لازم ينادي عليها بدل hideFriendRequestsListPage مباشرة */
function closeFriendRequestsListPage() {
    closeModal();
}

/**
 * ربط زرار فتح صفحة "كل طلبات الصداقة الواردة" (#btnShowAllFriendRequests
 * جوه تبويب البروفايل) وزرار "رجوع" جوه الصفحة نفسها - مرة واحدة بس،
 * نفس فكرة bindFriendsListPageEvents فوق بالظبط
 */
let friendRequestsListPageEventsBound = false;
function bindFriendRequestsListPageEvents() {
    if (friendRequestsListPageEventsBound) return;
    friendRequestsListPageEventsBound = true;

    const openBtn = document.getElementById('btnShowAllFriendRequests');
    if (openBtn) openBtn.addEventListener('click', () => openFriendRequestsListPage());

    const backBtn = document.getElementById('btnBackFromFriendRequestsList');
    if (backBtn) backBtn.addEventListener('click', () => closeFriendRequestsListPage());
}

/**
 * فتح مودال تأكيد "حذف صديق" (#removeFriendConfirmModal) وتسجيل معرّف
 * صف العلاقة المطلوب حذفه (pendingRemoveFriendId) عشان btnConfirmRemoveFriend
 * يعرف يمسح مين بالظبط لما المستخدم يأكّد - بدل الحذف المباشر اللي كان
 * شغال قبل كده من غير أي تأكيد
 * @param {string} friendRelationId - القيمة المخزّنة في friend.id (شوف fetchAcceptedFriends)
 * @param {string} [friendName] - اسم الصديق، بيتعرض جوه نص التأكيد لو متوفر
 * @param {() => void} [onConfirmed] - دالة اختيارية بتتنفذ بعد نجاح الحذف
 *   الفعلي بس (مش لو المستخدم عمل إلغاء) - لازمة للأماكن اللي محتاجة
 *   تحدّث واجهتها هي بنفسها بعد الحذف (زي زرار "إلغاء الصداقة" في
 *   البروفايل العام، شوف renderPublicProfileFriendButton)
 */
function openRemoveFriendConfirmModal(friendRelationId, friendName, onConfirmed) {
    const modal = document.getElementById('removeFriendConfirmModal');
    const nameEl = document.getElementById('removeFriendConfirmName');
    if (!modal) return;

    pendingRemoveFriendId = friendRelationId;
    pendingRemoveFriendCallback = typeof onConfirmed === 'function' ? onConfirmed : null;
    if (nameEl) nameEl.textContent = friendName || 'الصديق ده';

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/** الإخفاء الخام لمودال تأكيد حذف الصديق، وتصفير الطلب المعلّق (والـ callback المرتبط بيه لو موجود) */
function closeRemoveFriendConfirmModal() {
    const modal = document.getElementById('removeFriendConfirmModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    pendingRemoveFriendId = null;
    pendingRemoveFriendCallback = null;
}

/**
 * ربط أزرار مودال تأكيد "حذف صديق" (إلغاء/تأكيد) والضغط على الخلفية
 * المعتمة - مرة واحدة بس، نفس فكرة bindLogoutButton بالظبط
 */
let removeFriendConfirmModalBound = false;
function bindRemoveFriendConfirmModal() {
    if (removeFriendConfirmModalBound) return;
    removeFriendConfirmModalBound = true;

    const modal = document.getElementById('removeFriendConfirmModal');
    const cancelBtn = document.getElementById('btnCancelRemoveFriend');
    const confirmBtn = document.getElementById('btnConfirmRemoveFriend');
    if (!modal) return;

    if (cancelBtn) cancelBtn.addEventListener('click', closeRemoveFriendConfirmModal);

    // الضغط برّه الكارت (على الخلفية المعتمة) بيقفل المودال زي أي مودال
    // تأكيد تاني في التطبيق - نفس فحص event.target === modal المستخدم
    // في logoutConfirmModal بالظبط
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeRemoveFriendConfirmModal();
    });

    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const friendRelationId = pendingRemoveFriendId;
            const onConfirmed = pendingRemoveFriendCallback;
            closeRemoveFriendConfirmModal();
            if (friendRelationId) {
                await removeFriend(friendRelationId);
                if (onConfirmed) onConfirmed();
            }
        });
    }
}

/** بادئة مفتاح localStorage اللي بنسجّل فيه أي وسام "اتعمله توست فعلاً"
 * قبل كده لمستخدم معيّن - المفتاح الكامل بيبقى البادئة + user id.
 * الغرض الوحيد منه: ضمان إن كل وسام يظهر ليه توست/كونفيتي مرة واحدة بس
 * طول عمر الحساب، حتى لو الصفحة اتعمللها Refresh مية مرة بعد كده (شوف
 * تعليق checkAndUnlockBadges تحت لتفاصيل المشكلة اللي كانت بتحصل من غيره) */
const NOTIFIED_BADGES_STORAGE_PREFIX = 'sakkawy_notified_badges_';

/**
 * قراءة مجموعة (Set) معرّفات الأوسمة اللي اتبعتلها توست فعلاً قبل كده
 * لمستخدم معيّن، من localStorage
 * @param {string} userId
 * @returns {Set<string>}
 */
function getNotifiedBadgeIds(userId) {
    try {
        const raw = window.localStorage.getItem(NOTIFIED_BADGES_STORAGE_PREFIX + userId);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch (err) {
        // localStorage مش متاح لأي سبب (تصفح خاص محظور فيه مثلاً) - بنرجع
        // مجموعة فاضية بأمان بدل ما نكسر الفحص كله؛ أسوأ حاجة ممكن تحصل
        // في الحالة النادرة دي إن التوست يتكرر تاني بعد Refresh
        return new Set();
    }
}

/**
 * إضافة مجموعة معرّفات أوسمة لقائمة "الأوسمة اللي اتبعتلها توست فعلاً"
 * الخاصة بمستخدم معيّن في localStorage
 * @param {string} userId
 * @param {Array<string>} badgeIds
 */
function markBadgesAsNotified(userId, badgeIds) {
    if (!badgeIds.length) return;
    try {
        const current = getNotifiedBadgeIds(userId);
        badgeIds.forEach((id) => current.add(id));
        window.localStorage.setItem(NOTIFIED_BADGES_STORAGE_PREFIX + userId, JSON.stringify([...current]));
    } catch (err) {
        // نفس ملحوظة getNotifiedBadgeIds فوق - فشل الحفظ هنا مش لازم يوقف
        // عرض التوست نفسه، بس يعني احتمال ضعيف إنه يتكرر بعد Refresh تاني
    }
}

/**
 * فتح وسام جديد فعلياً في Supabase (INSERT في user_badges) لما المستخدم
 * يحقق الشرط المطلوب، وإعادة رسم الشبكة بعد نجاح الحفظ. لو الوسام مفتوح
 * أصلاً بترجع من غير أي نداء شبكة زيادة (upsert بيحمي من تكرار الصف
 * برضه بفضل unique(user_id, badge_id) في الجدول)
 * @param {string} badgeId - معرّف الوسام (زي 'champion' أو 'blaze')
 */
export async function unlockBadge(badgeId) {
    if (!currentAuthUser) return;

    const badge = badgesData.find((b) => b.id === badgeId);
    if (badge && badge.unlocked) return; // مفتوح بالفعل، مفيش داعي لنداء شبكة

    const { error } = await supabaseClient
        .from('user_badges')
        .upsert({ user_id: currentAuthUser.id, badge_id: badgeId }, { onConflict: 'user_id,badge_id' });

    if (error) {
        console.error('خطأ في فتح الوسام:', error.message);
        return;
    }

    await loadAndRenderBadges(currentAuthUser.id);
    const unlockedBadge = badgesData.find((b) => b.id === badgeId);
    markBadgesAsNotified(currentAuthUser.id, [badgeId]);
    document.dispatchEvent(new CustomEvent('profiles:badge-unlocked', { detail: { badge: unlockedBadge } }));

    // إشعار "achievement_unlocked" للمستخدم نفسه (هو صاحب الإنجاز) عشان
    // يشوفه في جرس الإشعارات، ولو ضغط عليه يوديه لقسم الأوسمة في
    // بروفايله (شوف navigateToAchievementsSection في notifications.js).
    // بنستورد sendNotification هنا محلياً (Dynamic Import) بدل import
    // ثابت أعلى الملف - نفس سبب acceptFriendRequest/sendFriendRequest
    // فوق (تجنب Circular Import مع notifications.js)
    const { sendNotification } = await import('./notifications.js');
    await sendNotification({
        userId: currentAuthUser.id,
        type: 'achievement_unlocked',
        title: 'وسام جديد!',
        message: `مبروك! لقد حصلت على وسام ${unlockedBadge?.title || badgeId}`,
        data: {
            badge_id: badgeId,
        },
    });
}

/**
 * (المرحلة 9 - إصلاح نهائي) فتح الأوسمة "الرقمية" (خطوات/إجابات صح/
 * ستريك/بطولات/أصدقاء) بيحصل تلقائيًا وسيرفر-سايد بالكامل عن طريق
 * Triggers على Supabase (on_profile_stats_updated على profiles +
 * on_friend_accepted على friends). وإشعار "وسام جديد!" نفسه بقى كمان
 * بيتبعت من جوه نفس الـ Trigger مباشرة (شوف badges-atomic-notifications.sql)
 * - مش من هنا. السبب: مقارنة "قبل/بعد" في الفرونت إند كانت عرضة لأي
 * توقيت غريب بين applyDailyCheckIn وloadAndRenderBadges عند تحميل
 * الصفحة (وده اللي كان بيسبب تكرار الإشعار مع كل Refresh)، لكن
 * الـ Trigger عارف بالظبط أنهي وسام "اتعمله INSERT فعلاً الآن" بضمان
 * ON CONFLICT DO NOTHING + RETURNING - مفيش أي مجال لسباق توقيت هناك.
 * الدالة دي بقى غرضها الوحيد إعادة رسم شبكة الأوسمة (وصفحة الأوسمة
 * الكاملة لو مفتوحة) عشان تعكس أي وسام جديد فوراً في نفس الجلسة، مع
 * الاحتفاظ بحدث 'profiles:badge-unlocked' (بيستخدمه app.js لعرض
 * الكونفيتي).
 *
 * (إصلاح - تكرار توست الأوسمة مع كل Refresh) previouslyUnlockedIds تحت
 * بتتحسب من badgesData الحالية في الذاكرة، واللي بتتصفر لصفر (badgesData = [])
 * مع كل Refresh للصفحة (متغير Module State عادي، مش محفوظ). يعني لو
 * الدالة دي اتنادت قبل ما badgesData تتعبّى لأول مرة في نفس الجلسة (زي
 * مثلاً مزامنة خطوات تلقائية بتحصل عند فتح التطبيق)، previouslyUnlockedIds
 * هتبقى فاضية، وكل الأوسمة اللي المستخدم فاتحها بالفعل من زمان هتظهر
 * "جديدة" غلط - يعني توست لكل وسام كسبه المستخدم في تاريخه دفعة واحدة.
 * عشان كده بنستخدم alreadyNotifiedIds كمان (محفوظة في localStorage -
 * شوف getNotifiedBadgeIds/markBadgesAsNotified فوق) كخط حماية إضافي
 * دائم: أي وسام اتبعتله توست قبل كده في أي جلسة سابقة (مش بس الجلسة
 * الحالية) مش هيتبعتله توست تاني أبداً، حتى لو previouslyUnlockedIds
 * غلط بسبب التوقيت. بكده كل وسام بيوصله توست مرة واحدة بس طول عمر
 * الحساب - سواء وسام قديم أو جديد.
 *
 * بتتنادى بعد أي حدث ممكن يفتح وسام: تحديث خطوات، إجابة صح على السؤال
 * اليومي، أو قبول صداقة - مفيش داعي تتنادى يدوياً من مكان تاني.
 */
async function checkAndUnlockBadges() {
    if (!currentAuthUser) return;

    const previouslyUnlockedIds = new Set(badgesData.filter((b) => b.unlocked).map((b) => b.id));

    await loadAndRenderBadges(currentAuthUser.id);

    const alreadyNotifiedIds = getNotifiedBadgeIds(currentAuthUser.id);

    const newlyUnlockedBadges = badgesData.filter(
        (b) => b.unlocked && !previouslyUnlockedIds.has(b.id) && !alreadyNotifiedIds.has(b.id),
    );

    if (newlyUnlockedBadges.length === 0) return;

    markBadgesAsNotified(currentAuthUser.id, newlyUnlockedBadges.map((b) => b.id));

    for (const badge of newlyUnlockedBadges) {
        document.dispatchEvent(new CustomEvent('profiles:badge-unlocked', { detail: { badge } }));
    }
}

/* ==================================================================
   المرحلة 5أ: الليدربورد الحقيقي (Leaderboard)
   ------------------------------------------------------------------
   (تحديث - إصلاح باج "الأرقام الوهمية بتظهر وترجع تاني"): كل منطق
   الجلب والرسم الفعلي (podium/باقي القائمة/شريط مركزك الحالي) اتشال
   من هنا نهائياً واتنقل بالكامل لـ js/leaderboard.js (get_leaderboard
   RPC، مقسّم فعليًا يومي/أسبوعي/شهري). كان فيه نسخة قديمة هنا
   (fetchLeaderboardTop/renderLeaderboardPodium/renderLeaderboardRemainingList/
   renderCurrentUserRankBanner/loadAndRenderLeaderboard) بترسم فوق نفس
   عناصر الـ DOM بأرقام all-time إجمالية (من غير أي تقسيم لفترة بطولة)
   - وكانت لسه بتتنادى فعليًا من flushPendingStepsBatch() و
   refreshProfileAfterDailyQuestion() تحت، فبتفضل تظهر لحظيًا وتختفي كل
   ما حد يمشي/يجاوب سؤال يومي. شوف refreshActiveLeaderboard() المستوردة
   من js/leaderboard.js - هي الطريقة الصح دلوقتي لأي كود هنا يحدّث
   الليدربورد الظاهر.
   ================================================================== */

/** أقصى عدد أشخاص نبلغهم بإشعار "leaderboard_pass" في نفس دفعة التخطي الواحدة - لو المستخدم قفز قفزة كبيرة (مثلاً أول Flush خطوات كبير بعد فترة off) وخطى ناس كتير مرة واحدة، منبعتش سيل إشعارات لعدد كبير، بنبلغ الأقرب ليه بس (الأقل فرق نقط/خطوات) */
const LEADERBOARD_PASS_NOTIFY_LIMIT = 5;

/**
 * بعد أي زيادة في points أو total_steps للمستخدم الحالي، بنشوف هل
 * الزيادة دي خلته يتخطى حد كان لسه فوقه (بين قيمته القديمة والجديدة)
 * في الترتيب - لو آه، بنبعت لكل واحد منهم إشعار "leaderboard_pass".
 * "Fire and forget" بنفس فلسفة sendNotification العادية - فشلها
 * متمنعش حفظ النقاط نفسه من إنه يتم (اتحفظ بالفعل قبل ما الدالة دي
 * تتنادى، شوف patchProfileRow/flushPendingStepsBatch).
 * @param {'points'|'total_steps'} metric
 * @param {number} oldValue - قيمة المستخدم قبل التحديث
 * @param {number} newValue - قيمة المستخدم بعد التحديث
 */
async function notifyLeaderboardPassIfNeeded(metric, oldValue, newValue) {
    if (!currentAuthUser || !(newValue > oldValue)) return;

    try {
        // أي مستخدم قيمته وقعت بين القديمة والجديدة (استبعاداً للقديمة
        // نفسها، وشاملة الجديدة) يبقى فعلياً اتخطى دلوقتي - مرتبين
        // بالأقرب أولاً (الأقل فرق) عشان لو في حد أكتر من الحد الأقصى
        // المسموح بيهم نبلغ الأقرب/الأكثر إثارة للتنافس بس
        // (إصلاح - باج حقيقي): نفس سبب fetchCurrentUserRank فوق - profiles
        // مباشرة كانت بترجع فاضية دايماً لغير صفك انت (وبما إن الشرط هنا
        // أصلاً بيستبعد صفك بـ neq، كانت النتيجة صفر نهائي دايماً ومفيش
        // إشعار "leaderboard_pass" بيتبعت لحد خالص).
        const { data: passedUsers, error } = await supabaseClient
            .from('public_profiles')
            .select('id')
            .gt(metric, oldValue)
            .lte(metric, newValue)
            .neq('id', currentAuthUser.id)
            .order(metric, { ascending: true })
            .limit(LEADERBOARD_PASS_NOTIFY_LIMIT);

        if (error) {
            console.error('خطأ في التحقق من تخطي الترتيب:', error.message);
            return;
        }
        if (!passedUsers || passedUsers.length === 0) return;

        const myName = currentProfileRow?.full_name || 'مستخدم';
        const { sendNotification } = await import('./notifications.js');

        await Promise.all(passedUsers.map((row) => sendNotification({
            userId: row.id,
            type: 'leaderboard_pass',
            title: 'حد تخطاك في الترتيب!',
            message: `${myName} تخطاك في لوحة الصدارة`,
            data: {
                sender_id: currentAuthUser.id,
                sender_avatar_url: currentProfileRow?.avatar_url || null,
                metric,
            },
        })));
    } catch (err) {
        console.error('استثناء غير متوقع أثناء التحقق من تخطي الترتيب:', err);
    }
}


/**
 * البحث عن أي مستخدم بالاسم في كل جدول profiles (مش بس أعلى 10 الظاهرين
 * في اللوحة)، مرتبين حسب نفس المقياس الحالي للّيدربورد (نقاط أو إجمالي
 * خطوات) عشان يبان أعلى نتيجة أولاً. بيرجع أول 20 نتيجة بس.
 * @param {string} query - نص البحث (اسم، جزئي أو كامل)
 * @param {'points'|'total_steps'} metric
 * @returns {Promise<Array<object>>}
 */
async function searchLeaderboardUsers(query, metric) {
    const trimmedQuery = (query || '').trim();
    if (!trimmedQuery) return [];

    // (جديد) public_profiles بدل profiles - نفس السبب المذكور في fetchLeaderboardTop
    const { data, error } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url, points, total_steps')
        .ilike('full_name', `%${trimmedQuery}%`)
        .order(metric, { ascending: false, nullsFirst: false })
        .limit(20);

    if (error) {
        console.error('خطأ في البحث في لوحة الصدارة:', error.message);
        return [];
    }

    return data || [];
}

/**
 * رسم نتايج البحث في لوحة الصدارة - نفس شكل صفوف #leaderboardList
 * بالظبط، والضغط على أي صف بيفتح بروفايل صاحبه العام
 * @param {Array<object>} results
 * @param {'points'|'total_steps'} metric
 */
function renderLeaderboardSearchResults(results, metric) {
    const container = document.getElementById('leaderboardSearchResults');
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">مفيش نتايج، جرّب اسم تاني</p>`;
        return;
    }

    container.innerHTML = results.map((row) => {
        const isCurrentUser = currentAuthUser && row.id === currentAuthUser.id;
        return `
            <article class="rank-card${isCurrentUser ? ' rank-card-self' : ''}" data-leaderboard-search-user-id="${row.id}">
                <span class="relative inline-block shrink-0">
                    <img src="${row.avatar_url || DEFAULT_AVATAR_URI}" alt="${row.full_name || 'بطل'}"
                         class="rank-card-avatar"
                         onerror="this.src='${DEFAULT_AVATAR_URI}'">
                    ${presenceDotHtml(row.id)}
                </span>
                <div class="rank-card-info">
                    <h5 class="rank-card-name">${row.full_name || 'بطل'}${isCurrentUser ? ' (أنت)' : ''}</h5>
                    <div class="dual-stat-badge dual-stat-badge-compact">
                        <span class="dual-stat-item" title="عدد الخطوات">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>
                            <span>${formatCompactNumber(row.total_steps ?? 0)}</span>
                        </span>
                        <span class="dual-stat-divider" aria-hidden="true"></span>
                        <span class="dual-stat-item" title="النقاط">
                            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.9-6.2 3.9 1.6-7L2 9.2l7.1-.6z"/></svg>
                            <span>${(row.points ?? 0).toLocaleString()}</span>
                        </span>
                    </div>
                </div>
            </article>
        `;
    }).join('');

    container.querySelectorAll('[data-leaderboard-search-user-id]').forEach((rowEl) => {
        rowEl.addEventListener('click', () => openPublicProfile(rowEl.dataset.leaderboardSearchUserId));
    });

    loadAndApplyPresence(results.map((row) => row.id));
}

/**
 * ربط خانة البحث فوق لوحة الصدارة - بـ debounce بسيط (300ms) عشان منبعتش
 * Request لكل حرف بيتكتب. وقت ما فيه نص في الخانة، بنخفي #leaderboardMainContent
 * (المنصة + البانر + باقي القايمة) ونعرض #leaderboardSearchResults بدله،
 * ولما الخانة تتفضى بنرجع الوضع الطبيعي تاني.
 */
function bindLeaderboardSearchInput() {
    if (leaderboardSearchEventsBound) return;
    leaderboardSearchEventsBound = true;

    const input = document.getElementById('leaderboardSearchInput');
    const mainContent = document.getElementById('leaderboardMainContent');
    const resultsContainer = document.getElementById('leaderboardSearchResults');
    if (!input) return;

    let debounceTimer = null;
    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const query = input.value.trim();

        if (!query) {
            if (mainContent) mainContent.classList.remove('hidden');
            if (resultsContainer) resultsContainer.classList.add('hidden');
            return;
        }

        if (mainContent) mainContent.classList.add('hidden');
        if (resultsContainer) resultsContainer.classList.remove('hidden');

        debounceTimer = setTimeout(async () => {
            // (تحديث - إصلاح باج "الأرقام الوهمية"): كانت بتستخدم متغير
            // currentLeaderboardMetric المحلي هنا اللي كان بيتحدّث بس
            // جوه loadAndRenderLeaderboard القديمة (المحذوفة دلوقتي) -
            // بقت بتاخد المقياس الحقيقي للفترة النشطة فعلاً من
            // js/leaderboard.js (getActiveMetric) عشان نتائج البحث
            // تتفق مع نفس ترتيب الفترة الظاهرة (يومي/أسبوعي = نقاط،
            // شهري = خطوات) بدل ما تفضل مقفولة على "نقاط" ثابتة
            const metric = getActiveMetric();
            const results = await searchLeaderboardUsers(query, metric);
            renderLeaderboardSearchResults(results, metric);
        }, 300);
    });
}

/**
 * تهيئة تبويب "لوحة الصدارة" بالكامل - ربط أزرار الفلتر + خانة البحث +
 * أول تحميل للبيانات الحقيقية بمقياس "النقاط" افتراضياً. تُستدعى مرة
 * واحدة من initProfileUI (بنفس فلسفة باقي initXxxUI في الملف ده)
 */
export async function initLeaderboardUI() {
    bindLeaderboardSearchInput();

    // initChampionshipTabs() هي اللي هتربط أزرار التبويبات التلاتة،
    // تشغّل عداد "اليومية" كفترة افتراضية، وتستدعي أول تحميل بيانات
    // تلقائياً بنفسها من js/leaderboard.js - مفيش داعي نسجّل أي Loader
    // خارجي هنا تاني (شوف إصلاح باج "الأرقام الوهمية" فوق)
    initChampionshipTabs('today');
}

/* ==================================================================
   المرحلة 5ب: نظام الأصدقاء الحقيقي (Friends System)
   ------------------------------------------------------------------
   بيتطلب جدول واحد إضافي على Supabase:

   create table public.friends (
       id            uuid primary key default gen_random_uuid(),
       requester_id  uuid not null references public.profiles(id) on delete cascade,
       addressee_id  uuid not null references public.profiles(id) on delete cascade,
       status        text not null default 'pending' check (status in ('pending','accepted','rejected')),
       created_at    timestamptz not null default now(),
       unique (requester_id, addressee_id)
   );

   RLS المقترحة: قراءة/تعديل مسموح بس لو auth.uid() يساوي requester_id
   أو addressee_id في نفس الصف.

   ملاحظة: خانة البحث في تبويب لوحة الصدارة (searchLeaderboardUsers)
   بتدوّر بالاسم بس (full_name.ilike) - مفيش داعي لعمود username.
   ================================================================== */

/**
 * جلب الأصدقاء المقبولين فعلاً (status = 'accepted') للمستخدم الحالي،
 * في أي الاتجاهين (سواء المستخدم هو اللي بعت الطلب أو اللي استقبله)،
 * مع بيانات كل صديق من جدول profiles
 * @param {string} userId
 * @returns {Promise<Array<object>>}
 */
async function fetchAcceptedFriends(userId) {
    const { data: relations, error: relationsError } = await supabaseClient
        .from('friends')
        .select('id, requester_id, addressee_id')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .eq('status', 'accepted');

    if (relationsError) {
        console.error('خطأ في جلب علاقات الصداقة:', relationsError.message);
        return [];
    }

    if (!relations || relations.length === 0) return [];

    const friendIdByRelationId = new Map();
    relations.forEach((rel) => {
        const friendId = rel.requester_id === userId ? rel.addressee_id : rel.requester_id;
        friendIdByRelationId.set(rel.id, friendId);
    });

    const friendIds = [...new Set(friendIdByRelationId.values())];

    // (إصلاح - باج حقيقي): كانت بتجيب من جدول profiles مباشرة، واللي RLS
    // بتاعه بيسمح بس إنك تقرا بروفايلك انت (auth.uid() = id) - فبيانات
    // أي صديق تاني كانت بترجع فاضية تماماً من غير أي خطأ ظاهر، فالكود
    // تحت كان بيقع على كل القيم الافتراضية ('بطل'، ٠ نقطة، صورة
    // placeholder) لكل الأصدقاء من غير استثناء. public_profiles هي نفس
    // الـ View الآمنة المستخدمة في لوحة الصدارة (fetchLeaderboardTop) -
    // متاحة لأي مستخدم يقرا منها بيانات أي حد تاني بأمان.
    const { data: friendProfiles, error: profilesError } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url, points')
        .in('id', friendIds);

    if (profilesError) {
        console.error('خطأ في جلب بيانات بروفايلات الأصدقاء:', profilesError.message);
        return [];
    }

    const profileById = new Map((friendProfiles || []).map((p) => [p.id, p]));

    return [...friendIdByRelationId.entries()].map(([relationId, friendId]) => {
        const profile = profileById.get(friendId);
        return {
            id: relationId, // معرّف صف friends نفسه، لازم للحذف
            userId: friendId,
            name: profile?.full_name || 'بطل',
            points: profile?.points ?? 0,
            avatar: profile?.avatar_url || DEFAULT_AVATAR_URI,
        };
    });
}

/**
 * جلب طلبات الصداقة الواردة (status = 'pending' ومُرسلة للمستخدم
 * الحالي، يعني addressee_id = userId) مع بيانات مُرسل الطلب
 * @param {string} userId
 * @returns {Promise<Array<object>>}
 */
async function fetchIncomingFriendRequests(userId) {
    const { data: relations, error: relationsError } = await supabaseClient
        .from('friends')
        .select('id, requester_id')
        .eq('addressee_id', userId)
        .eq('status', 'pending');

    if (relationsError) {
        console.error('خطأ في جلب طلبات الصداقة الواردة:', relationsError.message);
        return [];
    }

    if (!relations || relations.length === 0) return [];

    const requesterIds = [...new Set(relations.map((r) => r.requester_id))];

    // (إصلاح - باج حقيقي): نفس مشكلة fetchAcceptedFriends فوق بالظبط -
    // profiles مباشرة كانت بترجع فاضية لبيانات أي مستخدم مش أنا.
    const { data: requesterProfiles, error: profilesError } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url')
        .in('id', requesterIds);

    if (profilesError) {
        console.error('خطأ في جلب بيانات مُرسلي طلبات الصداقة:', profilesError.message);
        return [];
    }

    const profileById = new Map((requesterProfiles || []).map((p) => [p.id, p]));

    return relations.map((rel) => {
        const profile = profileById.get(rel.requester_id);
        return {
            id: rel.id, // معرّف صف friends نفسه، لازم للقبول/الرفض
            requesterId: rel.requester_id,
            name: profile?.full_name || 'بطل',
            avatar: profile?.avatar_url || DEFAULT_AVATAR_URI,
        };
    });
}

/**
 * تحميل قائمة الأصدقاء المقبولين + طلبات الصداقة الواردة معاً، ورسمهم
 * تُستدعى بعد أي عملية إضافة/حذف/قبول/رفض ناجحة (مش من التحميل الأول -
 * شوف loadAndRenderFriendsCached تحت) - قراءة مباشرة من الشبكة من غير
 * كاش، بالعمد: المستخدم لسه عامل عملية دلوقتي وبيتوقع يشوف نتيجتها
 * فعلياً على طول، مش نسخة قديمة من الكاش لحد ما رد الشبكة يوصل
 * @param {string} userId
 */
async function loadAndRenderFriends(userId) {
    const [accepted, incoming] = await Promise.all([
        fetchAcceptedFriends(userId),
        fetchIncomingFriendRequests(userId),
    ]);

    friendsData = accepted;
    incomingFriendRequests = incoming;

    renderFriends();
    renderIncomingFriendRequests();
}

/**
 * (كاش الأوفلاين) نسخة "خام" من fetchAcceptedFriends تُستخدم فقط في
 * loadAndRenderFriendsCached تحت - بترجع null صراحة عند فشل حقيقي بدل []
 * (زي fetchAcceptedFriends الأصلية فوق) عشان fetchWithCache تقدر تفرّق
 * بين "الطلب فشل، سيب المعروض زي ما هو" و"الطلب نجح ورجع إن مفيش
 * أصدقاء فعلاً" - fetchAcceptedFriends الأصلية فضلت من غير تغيير لأنها
 * بتتستخدم في loadAndRenderFriends فوق (تحديث بعد كتابة، مش محتاج كاش)
 * @param {string} userId
 * @returns {Promise<Array<object>|null>}
 */
async function fetchAcceptedFriendsFromServer(userId) {
    const { data: relations, error: relationsError } = await supabaseClient
        .from('friends')
        .select('id, requester_id, addressee_id')
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .eq('status', 'accepted');

    if (relationsError) {
        console.error('خطأ في جلب علاقات الصداقة:', relationsError.message);
        return null;
    }

    if (!relations || relations.length === 0) return [];

    const friendIdByRelationId = new Map();
    relations.forEach((rel) => {
        const friendId = rel.requester_id === userId ? rel.addressee_id : rel.requester_id;
        friendIdByRelationId.set(rel.id, friendId);
    });

    const friendIds = [...new Set(friendIdByRelationId.values())];

    const { data: friendProfiles, error: profilesError } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url, points')
        .in('id', friendIds);

    if (profilesError) {
        console.error('خطأ في جلب بيانات بروفايلات الأصدقاء:', profilesError.message);
        return null;
    }

    const profileById = new Map((friendProfiles || []).map((p) => [p.id, p]));

    return [...friendIdByRelationId.entries()].map(([relationId, friendId]) => {
        const profile = profileById.get(friendId);
        return {
            id: relationId,
            userId: friendId,
            name: profile?.full_name || 'بطل',
            points: profile?.points ?? 0,
            avatar: profile?.avatar_url || DEFAULT_AVATAR_URI,
        };
    });
}

/**
 * (كاش الأوفلاين) نفس فكرة fetchAcceptedFriendsFromServer فوق بس
 * لطلبات الصداقة الواردة - بترجع null عند فشل حقيقي بدل []
 * @param {string} userId
 * @returns {Promise<Array<object>|null>}
 */
async function fetchIncomingFriendRequestsFromServer(userId) {
    const { data: relations, error: relationsError } = await supabaseClient
        .from('friends')
        .select('id, requester_id')
        .eq('addressee_id', userId)
        .eq('status', 'pending');

    if (relationsError) {
        console.error('خطأ في جلب طلبات الصداقة الواردة:', relationsError.message);
        return null;
    }

    if (!relations || relations.length === 0) return [];

    const requesterIds = [...new Set(relations.map((r) => r.requester_id))];

    const { data: requesterProfiles, error: profilesError } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url')
        .in('id', requesterIds);

    if (profilesError) {
        console.error('خطأ في جلب بيانات مُرسلي طلبات الصداقة:', profilesError.message);
        return null;
    }

    const profileById = new Map((requesterProfiles || []).map((p) => [p.id, p]));

    return relations.map((rel) => {
        const profile = profileById.get(rel.requester_id);
        return {
            id: rel.id,
            requesterId: rel.requester_id,
            name: profile?.full_name || 'بطل',
            avatar: profile?.avatar_url || DEFAULT_AVATAR_URI,
        };
    });
}

/**
 * (كاش الأوفلاين) نقطة الدخول لتحميل الأصدقاء وطلبات الصداقة الواردة
 * أول ما تبويب البروفايل يتفتح (شوف loadAndRenderRealProfile) - بتعرض
 * النسخة المخزّنة محلياً فوراً لكل مفتاح لو موجودة، وتحدّثها في الخلفية
 * تلقائياً بعد كل قراءة ناجحة من الشبكة. مفتاحين مستقلين (cached_friends_list
 * / cached_friend_requests) عشان كل نوع بيانات يتحدّث لوحده من غير ما
 * ينتظر التاني. ملحوظة: loadAndRenderFriends() فوق فضلت زي ما هي
 * (بدون كاش) وبتتستخدم بعد أي عملية إضافة/حذف/قبول/رفض صداقة
 * @param {string} userId
 */
async function loadAndRenderFriendsCached(userId) {
    await Promise.all([
        fetchWithCache(`cached_friends_list:${userId}`, () => fetchAcceptedFriendsFromServer(userId), (data) => {
            friendsData = data;
            renderFriends();
        }),
        fetchWithCache(`cached_friend_requests:${userId}`, () => fetchIncomingFriendRequestsFromServer(userId), (data) => {
            incomingFriendRequests = data;
            renderIncomingFriendRequests();
        }),
    ]);
}

/** أقصى عدد أصدقاء بيتعرض في القائمة المختصرة جوه تبويب البروفايل قبل ما زرار "شوف كل الأصدقاء" يظهر بدل الباقي - شوف renderFriends تحت */
const FRIENDS_PREVIEW_LIMIT = 3;

/**
 * بناء الـ HTML الخاص بصف صديق واحد (صورة + اسم + نقاط + زرار حذف) -
 * مشتركة بين القائمة المختصرة في تبويب البروفايل (renderFriends) وصفحة
 * "كل الأصدقاء" الكاملة (renderFriendsFull) عشان الشكل والسلوك يفضلوا
 * متطابقين تمامًا في المكانين
 * @param {object} friend
 */
function buildFriendRowHtml(friend) {
    return `
        <div class="bg-lux-800 p-2.5 rounded-2xl flex items-center justify-between">
            <button type="button" class="friend-row-profile-btn flex items-center gap-2.5 text-right flex-1 min-w-0" data-user-id="${friend.userId}" aria-label="بروفايل ${friend.name}">
                <span class="relative inline-block shrink-0">
                    <img src="${friend.avatar}" alt="${friend.name}"
                         class="w-9 h-9 rounded-full object-cover border border-gold-500/20"
                         onerror="this.src='${DEFAULT_AVATAR_URI}'">
                    ${presenceDotHtml(friend.userId)}
                </span>
                <span class="text-xs font-extrabold text-lux-100 truncate">${friend.name}</span>
            </button>
            <div class="flex items-center gap-2 shrink-0">
                <span class="text-[11px] font-black text-gold-400">${friend.points.toLocaleString()} ن</span>
                <button class="remove-friend-btn text-lux-500 hover:text-rose-400 text-xs" data-friend-id="${friend.id}" data-friend-name="${friend.name}" aria-label="حذف الصديق">✕</button>
            </div>
        </div>
    `;
}

/**
 * ربط أحداث الضغط (فتح بروفايل + طلب تأكيد الحذف) لكل صفوف الأصدقاء
 * جوه حاوية معيّنة - مشتركة بين renderFriends وrenderFriendsFull
 * @param {HTMLElement} container
 */
function bindFriendRowEvents(container) {
    // ربط الضغط على صورة/اسم الصديق بفتح بروفايله العام (نفس فلسفة
    // فتح البروفايل من الليدربورد ومن الاستوريز - أي حساب في المشروع
    // المفروض يفتح بروفايله بالضغط عليه، حتى لو كان جوه قائمة أصدقائي)
    container.querySelectorAll('.friend-row-profile-btn').forEach((btn) => {
        btn.addEventListener('click', () => openPublicProfile(btn.dataset.userId));
    });

    // ربط أزرار الحذف بطلب تأكيد أول (مودال removeFriendConfirmModal)
    // بدل الحذف المباشر - شوف openRemoveFriendConfirmModal تحت
    container.querySelectorAll('.remove-friend-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            openRemoveFriendConfirmModal(btn.dataset.friendId, btn.dataset.friendName);
        });
    });
}

/**
 * رسم قائمة الأصدقاء المقبولين الحالية جوه تبويب البروفايل - نسخة
 * مختصرة بحد أقصى FRIENDS_PREVIEW_LIMIT صديق، ولو العدد الحقيقي أكتر
 * منها بيظهر زرار "شوف كل الأصدقاء" (#btnShowAllFriends) بدل الباقي،
 * اللي بيفتح صفحة "كل الأصدقاء" الكاملة (#tab-friends-list، شوف
 * renderFriendsFull وopenFriendsListPage تحت)
 */
export function renderFriends() {
    const list = document.getElementById('friendsList');
    const countLabel = document.getElementById('friendsCount');
    const showAllBtn = document.getElementById('btnShowAllFriends');
    if (!list) return;

    if (friendsData.length === 0) {
        list.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">لسه معندكش أصحاب مضافين، ابدأ ادعُهم!</p>`;
    } else {
        const previewFriends = friendsData.slice(0, FRIENDS_PREVIEW_LIMIT);
        list.innerHTML = previewFriends.map(buildFriendRowHtml).join('');
        bindFriendRowEvents(list);
        loadAndApplyPresence(previewFriends.map((f) => f.userId));
    }

    if (countLabel) countLabel.textContent = `${friendsData.length} صديق`;

    // زرار "شوف كل الأصدقاء" بيظهر بس لو العدد الحقيقي أكتر من حد
    // المعاينة المختصرة فوق
    if (showAllBtn) {
        const hasMoreFriends = friendsData.length > FRIENDS_PREVIEW_LIMIT;
        showAllBtn.classList.toggle('hidden', !hasMoreFriends);
        showAllBtn.classList.toggle('flex', hasMoreFriends);
    }

    // نفس القائمة بالظبط بس كاملة، تتعرض جوه صفحة "كل الأصدقاء" لو
    // كانت مفتوحة أصلاً (تحديث حي بعد أي حذف/إضافة) - رسمها هنا حتى لو
    // الصفحة مقفولة دلوقتي مش مكلّف، وبيضمن إنها تبقى محدّثة أول ما تتفتح
    renderFriendsFull();
}

/**
 * رسم قائمة الأصدقاء المقبولين الكاملة (من غير أي حد أقصى) جوه صفحة
 * "كل الأصدقاء" المستقلة (#tab-friends-list)
 */
function renderFriendsFull() {
    const list = document.getElementById('friendsListFull');
    const countLabel = document.getElementById('friendsListFullCount');
    if (!list) return;

    if (friendsData.length === 0) {
        list.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">لسه معندكش أصحاب مضافين، ابدأ ادعُهم!</p>`;
    } else {
        list.innerHTML = friendsData.map(buildFriendRowHtml).join('');
        bindFriendRowEvents(list);
        loadAndApplyPresence(friendsData.map((f) => f.userId));
    }

    if (countLabel) countLabel.textContent = `${friendsData.length} صديق`;
}

/**
 * بناء الـ HTML الخاص بصف طلب صداقة وارد واحد (صورة + اسم + زراري
 * قبول/رفض) - مشتركة بين القائمة المختصرة في تبويب البروفايل
 * (renderIncomingFriendRequests) وصفحة "كل الطلبات" الكاملة
 * (renderFriendRequestsFull)، نفس فكرة buildFriendRowHtml بالظبط
 * @param {object} req
 */
function buildFriendRequestRowHtml(req) {
    return `
        <div class="bg-lux-800 p-2.5 rounded-2xl flex items-center justify-between">
            <button type="button" class="friend-request-profile-btn flex items-center gap-2.5 text-right flex-1 min-w-0" data-user-id="${req.requesterId}" aria-label="بروفايل ${req.name}">
                <span class="relative inline-block shrink-0">
                    <img src="${req.avatar}" alt="${req.name}"
                         class="w-9 h-9 rounded-full object-cover border border-gold-500/20"
                         onerror="this.src='${DEFAULT_AVATAR_URI}'">
                    ${presenceDotHtml(req.requesterId)}
                </span>
                <span class="text-xs font-extrabold text-lux-100 truncate">${req.name}</span>
            </button>
            <div class="flex items-center gap-1.5 shrink-0">
                <button class="accept-friend-request-btn text-[11px] font-black text-teal-400 hover:text-teal-300 bg-teal-500/10 px-2.5 py-1.5 rounded-xl" data-request-id="${req.id}">قبول</button>
                <button class="reject-friend-request-btn text-[11px] font-black text-rose-400 hover:text-rose-300 bg-rose-500/10 px-2.5 py-1.5 rounded-xl" data-request-id="${req.id}">رفض</button>
            </div>
        </div>
    `;
}

/**
 * ربط أحداث الضغط (فتح بروفايل + قبول/رفض) لكل صفوف طلبات الصداقة
 * الواردة جوه حاوية معيّنة - مشتركة بين renderIncomingFriendRequests
 * وrenderFriendRequestsFull، نفس فكرة bindFriendRowEvents بالظبط
 * @param {HTMLElement} container
 */
function bindFriendRequestRowEvents(container) {
    // ربط الضغط على صورة/اسم مُرسل الطلب بفتح بروفايله العام (نفس مبدأ
    // فتح البروفايل من أي مكان في المشروع - شوف تعليق renderFriends فوق)
    container.querySelectorAll('.friend-request-profile-btn').forEach((btn) => {
        btn.addEventListener('click', () => openPublicProfile(btn.dataset.userId));
    });
    container.querySelectorAll('.accept-friend-request-btn').forEach((btn) => {
        btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.requestId));
    });
    container.querySelectorAll('.reject-friend-request-btn').forEach((btn) => {
        btn.addEventListener('click', () => rejectFriendRequest(btn.dataset.requestId));
    });
}

/**
 * رسم قائمة طلبات الصداقة الواردة جوه تبويب البروفايل - نسخة مختصرة
 * بحد أقصى FRIENDS_PREVIEW_LIMIT طلب (نفس حد قائمة الأصدقاء المختصرة)،
 * ولو العدد الحقيقي أكتر منها بيظهر زرار "شوف كل الطلبات"
 * (#btnShowAllFriendRequests) بدل الباقي، اللي بيفتح صفحة "كل الطلبات"
 * الكاملة (#tab-friend-requests-list)، ويخفي القسم بالكامل لو مفيش طلبات
 */
export function renderIncomingFriendRequests() {
    const section = document.getElementById('friendRequestsSection');
    const list = document.getElementById('friendRequestsList');
    const countLabel = document.getElementById('friendRequestsCount');
    const showAllBtn = document.getElementById('btnShowAllFriendRequests');
    if (!section || !list) return;

    if (incomingFriendRequests.length === 0) {
        section.classList.add('hidden');
        list.innerHTML = '';
        if (showAllBtn) showAllBtn.classList.add('hidden');
        // القائمة الكاملة (لو الصفحة كانت مفتوحة) لازم تتفرغ هي كمان
        renderFriendRequestsFull();
        return;
    }

    section.classList.remove('hidden');
    if (countLabel) countLabel.textContent = String(incomingFriendRequests.length);

    const previewRequests = incomingFriendRequests.slice(0, FRIENDS_PREVIEW_LIMIT);
    list.innerHTML = previewRequests.map(buildFriendRequestRowHtml).join('');
    bindFriendRequestRowEvents(list);
    loadAndApplyPresence(previewRequests.map((r) => r.requesterId));

    if (showAllBtn) {
        const hasMoreRequests = incomingFriendRequests.length > FRIENDS_PREVIEW_LIMIT;
        showAllBtn.classList.toggle('hidden', !hasMoreRequests);
        showAllBtn.classList.toggle('flex', hasMoreRequests);
    }

    // نفس القائمة بالظبط بس كاملة، تتعرض جوه صفحة "كل الطلبات" لو كانت
    // مفتوحة أصلاً (تحديث حي بعد أي قبول/رفض) - نفس فلسفة renderFriends
    // مع renderFriendsFull بالظبط
    renderFriendRequestsFull();
}

/**
 * رسم قائمة طلبات الصداقة الواردة الكاملة (من غير أي حد أقصى) جوه صفحة
 * "كل الطلبات" المستقلة (#tab-friend-requests-list)
 */
function renderFriendRequestsFull() {
    const list = document.getElementById('friendRequestsListFull');
    const countLabel = document.getElementById('friendRequestsListFullCount');
    if (!list) return;

    if (incomingFriendRequests.length === 0) {
        list.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">مفيش طلبات صداقة واردة دلوقتي</p>`;
    } else {
        list.innerHTML = incomingFriendRequests.map(buildFriendRequestRowHtml).join('');
        bindFriendRequestRowEvents(list);
        loadAndApplyPresence(incomingFriendRequests.map((r) => r.requesterId));
    }

    if (countLabel) countLabel.textContent = String(incomingFriendRequests.length);
}

/**
 * قبول طلب صداقة وارد (تحديث status لـ 'accepted') وإعادة تحميل
 * قائمتي الأصدقاء والطلبات الواردة + إرسال إشعار "قبل طلب صداقتك"
 * لصاحب الطلب الأصلي (المُرسل) عشان يعرف إن طلبه اتقبل
 * @param {string} requestId - معرّف صف friends
 */
export async function acceptFriendRequest(requestId) {
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تقبل طلبات الصداقة', type: 'info' },
        }));
        return { error: new Error('وضع الزائر') };
    }
    if (!currentAuthUser) return { error: new Error('لا يوجد مستخدم مسجل دخول') };

    // بنلحق requester_id من نفس استعلام الـ update (بدل استعلام SELECT
    // منفصل قبله) عشان نعرف نبعت إشعار "friend_accept" لصاحب الطلب
    // الأصلي بعد كده - هو المُرسل (requester_id)، مش أنا (المستقبِل
    // اللي بيقبل دلوقتي)
    const { data: updatedRow, error } = await supabaseClient
        .from('friends')
        .update({ status: 'accepted' })
        .eq('id', requestId)
        .select('requester_id')
        .single();

    if (error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'حصل خطأ أثناء قبول الطلب، حاول تاني', type: 'error' } }));
        return { error };
    }

    document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'تمام، بقيتوا أصحاب!', type: 'success' } }));
    await loadAndRenderFriends(currentAuthUser.id);

    // (المرحلة 9) قبول الصداقة ممكن يفتح وسام "اجتماعي"/"شبكة علاقات" -
    // Trigger on_friend_accepted بيفتحه فعليًا لطرفَي الصداقة مع بعض
    // (أنا وصاحب الطلب الأصلي) لحظة القبول مباشرة. النداء هنا بس عشان
    // أنا (المستقبِل/القابل) أشوف إشعار "وسام جديد!" فورًا في نفس
    // الجلسة؛ صاحب الطلب الأصلي وسامه اتفتح بالفعل في الداتابيز، بس
    // واجهته هو هتعكسه أول ما يفتح تبويب الأوسمة أو يعمل أي نشاط تاني
    checkAndUnlockBadges();

    // حذف إشعار "طلب صداقة جديد" بتاعي أنا (المستقبِل) بعد ما اتقبل -
    // مهم نعمل الخطوة دي هنا (مركزياً جوه acceptFriendRequest نفسها)
    // مش بس من جوه كارت الإشعار (notifications.js)، عشان الدالة دي هي
    // نفسها اللي بتتنادى لو المستخدم قبل الطلب من أي مكان تاني في
    // التطبيق (قائمة "الطلبات الواردة" في تبويب البروفايل، أو زرار
    // "قبول الطلب" في صفحة البروفايل العام لصاحب الطلب) - في الحالتين
    // دول الإشعار كان فاضل عالق في لوحة الإشعارات من غير أي داعي بعد
    // ما الطلب اتعالج فعلياً. الحذف هنا "Fire and forget" (منستناهوش
    // ولا بنوقف نجاح القبول لو فشل) بنفس فلسفة sendNotification، وبما
    // إن notifications.js بتستمع لحدث DELETE على الجدول ده عبر
    // Realtime أصلاً (لحالة إلغاء/رفض الطلب)، لوحة الإشعارات المفتوحة
    // هتتزامن معاها فوراً من غير أي كود إضافي هناك
    supabaseClient
        .from('notifications')
        .delete()
        .eq('user_id', currentAuthUser.id)
        .eq('type', 'friend_request')
        .eq('data->>request_id', requestId)
        .then(({ error: deleteError }) => {
            if (deleteError) {
                console.error('خطأ في حذف إشعار طلب الصداقة بعد قبوله:', deleteError.message);
            }
        });

    // إرسال إشعار "friend_accept" لصاحب الطلب الأصلي - بعد كل حاجة
    // أساسية فوق خلصت بنجاح (نفس فلسفة sendFriendRequest: أي مشكلة هنا
    // متمنعش قبول الطلب نفسه من إنه يتم، الإشعار ده مجرد تنبيه إضافي).
    // بنستورد sendNotification هنا محلياً (Dynamic Import) بدل import
    // ثابت أعلى الملف عشان notifications.js نفسها بتستورد
    // acceptFriendRequest من هنا (profiles.js)، فـ import ثابت في
    // الاتجاهين كان هيعمل Circular Import حقيقي
    if (updatedRow?.requester_id) {
        const { sendNotification } = await import('./notifications.js');
        const myName = currentProfileRow?.full_name || 'مستخدم';
        await sendNotification({
            userId: updatedRow.requester_id,
            type: 'friend_accept',
            title: 'تم قبول طلب الصداقة',
            message: `${myName} وافق على طلب الصداقة الخاص بك`,
            data: {
                sender_id: currentAuthUser.id,
                sender_avatar_url: currentProfileRow?.avatar_url || null,
            },
        });
    }

    return { error: null };
}

/**
 * رفض طلب صداقة وارد (حذف الصف بالكامل) وإعادة تحميل الطلبات الواردة
 * @param {string} requestId - معرّف صف friends
 */
export async function rejectFriendRequest(requestId) {
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر ترفض طلبات الصداقة', type: 'info' },
        }));
        return { error: new Error('وضع الزائر') };
    }
    if (!currentAuthUser) return { error: new Error('لا يوجد مستخدم مسجل دخول') };

    const { error } = await supabaseClient
        .from('friends')
        .delete()
        .eq('id', requestId);

    if (error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'حصل خطأ أثناء رفض الطلب، حاول تاني', type: 'error' } }));
        return { error };
    }

    // حذف إشعار "طلب صداقة جديد" بتاعي بعد رفضه - بنفس فلسفة الحذف في
    // acceptFriendRequest فوق (Fire and forget، ومتزامن أوتوماتيك مع
    // أي لوحة إشعارات مفتوحة عبر Realtime). صف friends نفسه اتحذف
    // بالفعل فوق، فمن المفروض ده يحصل تلقائياً أصلاً لو فيه trigger على
    // مستوى القاعدة بيسمع لحذف friends، لكن بنعملها هنا صراحة كمان
    // عشان نضمن سلوك موحّد ومتوقع أياً كان شكل الـ trigger الفعلي
    supabaseClient
        .from('notifications')
        .delete()
        .eq('user_id', currentAuthUser.id)
        .eq('type', 'friend_request')
        .eq('data->>request_id', requestId)
        .then(({ error: deleteError }) => {
            if (deleteError) {
                console.error('خطأ في حذف إشعار طلب الصداقة بعد رفضه:', deleteError.message);
            }
        });

    await loadAndRenderFriends(currentAuthUser.id);
    return { error: null };
}

/**
 * حذف صديق فعلياً (حذف صف العلاقة من جدول friends) بمعرّف صف العلاقة
 * (مش معرّف المستخدم)، وإعادة تحميل القائمة
 * @param {string} friendRelationId - القيمة المخزّنة في friend.id (شوف fetchAcceptedFriends)
 */
export async function removeFriend(friendRelationId) {
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تحذف صديق', type: 'info' },
        }));
        return;
    }
    if (!currentAuthUser) return;

    const { error } = await supabaseClient
        .from('friends')
        .delete()
        .eq('id', friendRelationId);

    if (error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'حصل خطأ أثناء حذف الصديق، حاول تاني', type: 'error' } }));
        return;
    }

    await loadAndRenderFriends(currentAuthUser.id);
}

/**
 * إرجاع قائمة الأصدقاء الحالية (نسخة للقراءة فقط)
 */
export function getFriendsList() {
    return [...friendsData];
}

/**
 * إرسال طلب صداقة (INSERT بحالة 'pending') لمستخدم آخر بمعرّفه. لو فيه
 * طلب متبادل أصلاً (هو بعتلك قبل كده)، بنقبله تلقائياً بدل ما نرمي
 * خطأ Unique Constraint غير مفهوم للمستخدم.
 * @param {string} targetUserId
 * @returns {Promise<boolean>} true لو نجح الإرسال (أو القبول التلقائي)
 */
export async function sendFriendRequest(targetUserId) {
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تضيف صديق', type: 'info' },
        }));
        return false;
    }
    if (!currentAuthUser || !targetUserId || targetUserId === currentAuthUser.id) return false;

    // هل هو بعتلك طلب صداقة أصلاً؟ لو آه، بنقبله بدل ما نبعت طلب جديد
    const { data: existingIncoming } = await supabaseClient
        .from('friends')
        .select('id, status')
        .eq('requester_id', targetUserId)
        .eq('addressee_id', currentAuthUser.id)
        .maybeSingle();

    if (existingIncoming) {
        if (existingIncoming.status === 'accepted') {
            document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'انتوا أصحاب بالفعل', type: 'info' } }));
            return true;
        }
        await acceptFriendRequest(existingIncoming.id);
        return true;
    }

    // هل أنا أصلاً بعتله طلب قبل كده ولسه معلّق (pending) أو انتوا
    // أصحاب بالفعل؟ لو آه، منعملش أي حاجة تانية - لا upsert ولا إشعار
    // جديد - عشان كده بالظبط كان بيحصل التكرار: كل ضغطة "إضافة صديق"
    // (من نتائج البحث أو من صفحة البروفايل) كانت بتنشئ صف إشعار جديد
    // في notifications حتى لو الطلب نفسه أصلاً مبعوت وموجود ومعلّق،
    // فصاحب الطلب كان بيشوف نفس طلب الصداقة مكرر أكتر من مرة في جرسه
    // (rejectFriendRequest/removeFriend بيحذفوا الصف بالكامل من الجدول
    // - شوف تعليقهم - فمفيش حالة "rejected" باقية هنا تمنع إعادة الإرسال
    // الفعلية بعد الرفض، ده بيتعامل معاه طبيعي في الفرع تحت)
    const { data: existingOutgoing } = await supabaseClient
        .from('friends')
        .select('id, status')
        .eq('requester_id', currentAuthUser.id)
        .eq('addressee_id', targetUserId)
        .maybeSingle();

    if (existingOutgoing) {
        if (existingOutgoing.status === 'accepted') {
            document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'انتوا أصحاب بالفعل', type: 'info' } }));
        }
        // (تعديل) توست "الطلب متبعت بالفعل، مستنيين رده" اتشال بناءً على
        // طلب صريح - الحالة دي (طلب معلّق أصلاً) بترجع بصمت دلوقتي من غير
        // أي رسالة، فمفيش أي تكرار إرسال أو إشعار زيادة يحصل برضه
        return true;
    }

    // بنضيف .select('id').single() هنا عشان نلحق معرّف صف friends
    // (friendRequestRow.id) على طول من نفس الاستعلام - محتاجينه بعد
    // شوية عشان نحطه في data.request_id بتاع إشعار طلب الصداقة اللي
    // هننشئه لصاحب الطلب (شوف notifications table + js/notifications.js)
    const { data: friendRequestRow, error } = await supabaseClient
        .from('friends')
        .upsert(
            { requester_id: currentAuthUser.id, addressee_id: targetUserId, status: 'pending' },
            { onConflict: 'requester_id,addressee_id' },
        )
        .select('id')
        .single();

    if (error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'حصل خطأ أثناء إرسال طلب الصداقة، حاول تاني', type: 'error' } }));
        return false;
    }

    // (تعديل) توست "تم إرسال طلب الصداقة" اتشال بناءً على طلب صريح

    // إرسال إشعار (notifications) لصاحب الطلب عشان يشوفه في جرس
    // الإشعارات (js/notifications.js هو اللي بيعرضه لاحقاً + يستخدم
    // data.request_id في زراري قبول/رفض، وdata.sender_avatar_url عشان
    // يعرض صورة بروفايل صاحب الطلب الفعلية بدل إيموجي عام). بنعمل
    // الإرسال ده بعد ما الـ Toast اتبعت فعلاً، ومن غير await صريح على
    // فشلها، عشان أي مشكلة هنا (مثلاً RLS) متمنعش المستخدم من إتمام
    // إرسال طلب الصداقة نفسه - الطلب في جدول friends أصلاً اتبعت بنجاح،
    // الإشعار ده مجرد تنبيه إضافي وليس جزء أساسي من نجاح العملية
    // (sendNotification نفسها بتتعامل مع أي خطأ داخلي وترجع false بدل
    // ما ترمي - راجع تعليقها في notifications.js).
    //
    // بنستورد sendNotification هنا محلياً (Dynamic Import) بدل import
    // ثابت أعلى الملف، لنفس السبب المذكور في acceptFriendRequest تحت:
    // notifications.js بتستورد دوال من profiles.js أصلاً (acceptFriendRequest/
    // rejectFriendRequest/openPublicProfile)، فـ import ثابت في الاتجاهين
    // كان هيعمل Circular Import حقيقي بين الملفين.
    const senderName = currentProfileRow?.full_name || 'مستخدم';
    const { sendNotification } = await import('./notifications.js');
    await sendNotification({
        userId: targetUserId,
        type: 'friend_request',
        title: 'طلب صداقة جديد',
        message: `${senderName} أرسل لك طلب صداقة`,
        data: {
            request_id: friendRequestRow.id,
            sender_id: currentAuthUser.id,
            sender_avatar_url: currentProfileRow?.avatar_url || null,
        },
    });

    return true;
}

/* ==================================================================
   المرحلة 5ج: البروفايل العام (Public Profile) + إرسال طلب صداقة منه
   ------------------------------------------------------------------
   الميزة دي بتستخدم نفس جدول friends وأدوات نظام الأصدقاء الحقيقي
   المبني بالفعل فوق (fetchAcceptedFriends/sendFriendRequest/
   acceptFriendRequest..إلخ) - من غير ما نضيف جدول جديد أو ننشئ نظام
   صداقة موازي مختلف عن اللي شغال فعلاً في تبويب البروفايل.

   القرار المعماري المهم هنا: البروفايل العام صفحة مستقلة كاملة
   (#tab-public-profile) - مش مودال منبثق - وبتستخدم بالظبط نفس آلية
   تبديل ".tab-content" اللي app.js شغّالة بيها فعلاً بين تبويبات
   home/leaderboard/profile (شوف .tab-content/.tab-content.active في
   style.css). الفرق الوحيد إن #tab-public-profile مالهاش زرار nav-btn
   في الشريط السفلي (مش تبويب أساسي)، فبندخلها/بنخرج منها برمجياً بس
   (activatePublicProfilePage/goBackFromPublicProfilePage تحت)، وعامدين
   منستوردش switchTab من app.js هنا عشان منعملش Circular Import بين
   الملفين (نفس المبدأ المكتوب صراحة في تعليق app.js).

   ملحوظة مهمة عن أسماء الأعمدة: جدول friends المستخدم فعلياً في المشروع
   عمود الطرف الثاني فيه اسمه addressee_id (مش receiver_id) - راجع
   الملاحظة أعلى قسم "نظام الأصدقاء الحقيقي" فوق لتفاصيل الـ Schema
   الكاملة. لو حابب تغيّر الاسم لـ receiver_id فعلاً على Supabase،
   المطلوب بس تستبدل كل "addressee_id" في القسم ده وفي القسم اللي فوق
   بـ "receiver_id" - المنطق مش هيتغيّر.
   ================================================================== */

/**
 * فحص حالة الصداقة بين المستخدم الحالي ومستخدم مستهدف، بيرجع واحدة من:
 * 'self' (البروفايل ده بتاع المستخدم الحالي نفسه)، 'none' (مفيش أي
 * علاقة)، 'pending_sent' (أنا بعتّه طلب ولسه مستنيين رد)،
 * 'pending_received' (هو بعتلي طلب ولسه محتاج قرار مني)، أو 'accepted'
 * (أصحاب فعلاً). بيرجع كمان requestId (معرّف صف friends) لو محتاجينه
 * بعد كده (زي زرار "قبول الطلب")
 * @param {string} targetUserId
 * @returns {Promise<{status: 'self'|'none'|'pending_sent'|'pending_received'|'accepted', requestId: string|null}>}
 */
async function fetchFriendshipStatusWith(targetUserId) {
    if (!currentAuthUser || !targetUserId) return { status: 'none', requestId: null };
    if (targetUserId === currentAuthUser.id) return { status: 'self', requestId: null };

    const { data, error } = await supabaseClient
        .from('friends')
        .select('id, requester_id, addressee_id, status')
        .or(`and(requester_id.eq.${currentAuthUser.id},addressee_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},addressee_id.eq.${currentAuthUser.id})`)
        .maybeSingle();

    if (error) {
        console.error('خطأ في فحص حالة الصداقة:', error.message);
        return { status: 'none', requestId: null };
    }

    if (!data || data.status === 'rejected') return { status: 'none', requestId: null };

    if (data.status === 'accepted') return { status: 'accepted', requestId: data.id };

    // status === 'pending': مين اللي بعت الطلب هو اللي بيحدد شكل الزرار
    return {
        status: data.requester_id === currentAuthUser.id ? 'pending_sent' : 'pending_received',
        requestId: data.id,
    };
}

/**
 * جلب بيانات بروفايل عام كاملة (اسم/صورة/نقاط/ستريك حالي/أطول ستريك/
 * إجمالي خطوات/عدد إجابات صح) لأي مستخدم بمعرّفه، لعرضها في صفحة
 * البروفايل العام - نفس الأعمدة المستخدمة في بروفايل المستخدم الحالي
 * بالظبط (شوف fetchUserProfile فوق)
 * @param {string} targetUserId
 * @returns {Promise<object|null>}
 */
async function fetchPublicProfileRow(targetUserId) {
    // (جديد) public_profiles بدل profiles - نفس السبب المذكور في fetchLeaderboardTop
    const { data, error } = await supabaseClient
        .from('public_profiles')
        .select('id, full_name, avatar_url, points, streak_count, best_streak_days, total_steps, correct_answers, daily_championship_wins, weekly_championship_wins, monthly_championship_wins, featured_badge_id')
        .eq('id', targetUserId)
        .maybeSingle();

    if (error) {
        console.error('خطأ في جلب بيانات البروفايل العام:', error.message);
        return null;
    }

    return data;
}

/** إرجاع صفحة البروفايل العام لحالة "بيتحمّل" مؤقتة (قيم افتراضية) لحد ما البيانات الحقيقية توصل */
function setPublicProfileLoadingState() {
    const nameEl = document.getElementById('publicProfileName');
    const avatarEl = document.getElementById('publicProfileAvatar');
    const pointsEl = document.getElementById('publicProfilePoints');
    const streakEl = document.getElementById('publicProfileStreakCount');
    const stepsEl = document.getElementById('publicProfileTotalSteps');
    const answersEl = document.getElementById('publicProfileCorrectAnswers');
    const bestStreakEl = document.getElementById('publicProfileBestStreak');
    const dailyWinsEl = document.getElementById('publicProfileDailyWins');
    const weeklyWinsEl = document.getElementById('publicProfileWeeklyWins');
    const monthlyWinsEl = document.getElementById('publicProfileMonthlyWins');
    const actionContainer = document.getElementById('publicProfileFriendActionContainer');
    const badgesGrid = document.getElementById('publicProfileBadgesGrid');
    const badgesCount = document.getElementById('publicProfileBadgesCount');

    if (nameEl) nameEl.textContent = 'بنجيب البيانات...';
    if (avatarEl) avatarEl.src = DEFAULT_AVATAR_URI;
    if (pointsEl) pointsEl.textContent = '— نقطة';
    if (streakEl) streakEl.textContent = '— يوم ستريك حالي';
    if (stepsEl) stepsEl.textContent = '—';
    if (answersEl) answersEl.textContent = '—';
    if (bestStreakEl) bestStreakEl.textContent = '—';
    if (dailyWinsEl) dailyWinsEl.textContent = '—';
    if (weeklyWinsEl) weeklyWinsEl.textContent = '—';
    if (monthlyWinsEl) monthlyWinsEl.textContent = '—';
    if (actionContainer) actionContainer.innerHTML = '';
    if (badgesGrid) badgesGrid.innerHTML = '';
    if (badgesCount) badgesCount.textContent = '— / —';
    publicProfileBadgesData = [];

    // (المرحلة 7) نشيل أيقونة الشارة المميزة القديمة (لو موجودة من
    // بروفايل عام سابق) لحد ما بيانات البروفايل الجديد توصل
    renderFeaturedBadgeInline(nameEl, null);

    // (المرحلة 8) نفضّي زرار "إرسال رسالة" القديم برضه (بروفايل عام
    // سابق ممكن يكون كان بروفايل الأدمن نفسه) لحد ما renderPublicProfileSupportButton
    // يعيد رسمه صح لصاحب البروفايل الجديد
    const supportContainer = document.getElementById('publicProfileSupportActionContainer');
    if (supportContainer) supportContainer.innerHTML = '';
}

/**
 * رسم بيانات البروفايل العام (اسم/صورة/نقاط/ستريك حالي/أطول ستريك/
 * إجمالي خطوات/عدد إجابات صح) جوه صفحة البروفايل العام
 * @param {object} profileRow
 */
function renderPublicProfileContent(profileRow) {
    const nameEl = document.getElementById('publicProfileName');
    const avatarEl = document.getElementById('publicProfileAvatar');
    const pointsEl = document.getElementById('publicProfilePoints');
    const streakEl = document.getElementById('publicProfileStreakCount');
    const stepsEl = document.getElementById('publicProfileTotalSteps');
    const answersEl = document.getElementById('publicProfileCorrectAnswers');
    const bestStreakEl = document.getElementById('publicProfileBestStreak');
    const dailyWinsEl = document.getElementById('publicProfileDailyWins');
    const weeklyWinsEl = document.getElementById('publicProfileWeeklyWins');
    const monthlyWinsEl = document.getElementById('publicProfileMonthlyWins');

    const avatarUrl = profileRow.avatar_url || DEFAULT_AVATAR_URI;

    if (nameEl) nameEl.textContent = profileRow.full_name || 'بطل';
    if (avatarEl) {
        avatarEl.src = avatarUrl;
        avatarEl.dataset.fullUrl = avatarUrl; // نفس رابط الصورة، لازم لـ lightbox التكبير
    }
    // نقطة "أونلاين الآن" لصاحب البروفايل العام - بتتحقق من صلاحية
    // الرؤية على السيرفر نفسه (نفسي/صديقه المقبول/أدمن) شوف js/presence.js
    const publicPresenceDotEl = document.getElementById('publicProfileAvatarPresenceDot');
    if (profileRow.id) {
        if (publicPresenceDotEl) publicPresenceDotEl.setAttribute('data-presence-avatar', profileRow.id);
        loadAndApplyPresence([profileRow.id]);
    } else if (publicPresenceDotEl) {
        publicPresenceDotEl.classList.remove('is-online');
    }
    if (pointsEl) pointsEl.textContent = `${(profileRow.points ?? 0).toLocaleString()} نقطة`;
    if (streakEl) streakEl.textContent = `${profileRow.streak_count ?? 0} يوم ستريك حالي`;
    if (stepsEl) stepsEl.textContent = formatCompactNumber(profileRow.total_steps ?? 0);
    if (answersEl) answersEl.textContent = String(profileRow.correct_answers ?? 0);
    if (bestStreakEl) bestStreakEl.textContent = String(profileRow.best_streak_days ?? 0);
    if (dailyWinsEl) dailyWinsEl.textContent = String(profileRow.daily_championship_wins ?? 0);
    if (weeklyWinsEl) weeklyWinsEl.textContent = String(profileRow.weekly_championship_wins ?? 0);
    if (monthlyWinsEl) monthlyWinsEl.textContent = String(profileRow.monthly_championship_wins ?? 0);

    // (المرحلة 7) أيقونة الشارة المميزة جنب اسم صاحب البروفايل العام
    ensureBadgesCatalogCache().then(() => {
        renderFeaturedBadgeInline(nameEl, profileRow.featured_badge_id);
    });
}

/**
 * جلب دولاب أوسمة صاحب البروفايل العام (كتالوج الأوسمة كامل + دمجه مع
 * الأوسمة اللي هو فتحها فعلياً) ورسمه - نفس منطق loadAndRenderBadges
 * بالظبط (نفس الترتيب - sortBadgesForDisplay - ونفس منطق "أول 6 بس" في
 * المعاينة المصغّرة)، بس بمعرّف مستخدم مختلف ورسم في شبكة
 * #publicProfileBadgesGrid المنفصلة (عشان منلخبطش دولاب أوسمة المستخدم
 * الحالي نفسه لو مفتوح في نفس الوقت). القائمة الكاملة (كل الأوسمة
 * مقسّمة بالتصنيفات) بتتعرض من زرار "دولاب الأوسمة والشارات" ->
 * openPublicBadgesPage تحت.
 * @param {string} targetUserId
 */
async function loadAndRenderPublicProfileBadges(targetUserId) {
    const [catalog, unlockedMap] = await Promise.all([
        fetchBadgesCatalog(),
        fetchUnlockedBadgesMap(targetUserId),
    ]);

    // نفس المستخدم اللي فتحنا بروفايله لسه هو نفسه لحد دلوقتي؟ (مش حد
    // ضغط بسرعة على بروفايل تاني وإحنا لسه مستنيين الرد ده) - نفس فحص
    // currentPublicProfileTargetId في openPublicProfile بالظبط
    if (currentPublicProfileTargetId !== targetUserId) return;

    const grid = document.getElementById('publicProfileBadgesGrid');
    const countLabel = document.getElementById('publicProfileBadgesCount');

    if (catalog.length === 0) {
        publicProfileBadgesData = [];
        if (grid) grid.innerHTML = `<p class="col-span-3 text-xs text-lux-500 font-medium text-center py-3">لسه مفيش أوسمة متاحة</p>`;
        if (countLabel) countLabel.textContent = '0 / 0 مفتوح';
        return;
    }

    const rawBadges = catalog.map((badge) => ({
        id: badge.id,
        icon: badge.icon,
        title: badge.title,
        desc: badge.description,
        tier: badge.tier,
        sortOrder: badge.sort_order,
        unlocked: unlockedMap.has(badge.id),
        unlockedAt: unlockedMap.get(badge.id) || null,
    }));

    publicProfileBadgesData = sortBadgesForDisplay(rawBadges);

    if (grid) grid.innerHTML = publicProfileBadgesData.slice(0, 6).map(badgeCardHtml).join('');

    if (countLabel) {
        const unlockedCount = publicProfileBadgesData.filter((b) => b.unlocked).length;
        countLabel.textContent = `${unlockedCount} / ${publicProfileBadgesData.length} مفتوح`;
    }

    // لو صفحة "الأوسمة والشارات" الكاملة الخاصة بالبروفايل العام ده مفتوحة
    // فعلاً دلوقتي (نادرة، بس ممكن حصل شيء غيّر أوسمته وهي مفتوحة)، حدّثها
    // كمان فوراً - نفس فحص loadAndRenderBadges بالظبط
    const publicBadgesPage = document.getElementById('tab-public-badges-page');
    if (publicBadgesPage && publicBadgesPage.classList.contains('active')) {
        renderPublicBadgesPage();
    }
}

/**
 * رسم صفحة "الأوسمة والشارات" الكاملة **الخاصة ببروفايل عام**
 * (#tab-public-badges-page) - نفس renderBadgesPage بالظبط بس بتقرأ من
 * publicProfileBadgesData بدل badgesData، وبترسم في #publicBadgesPageGroups/
 * #publicBadgesPageCount المنفصلين (IDs مختلفة عن صفحة أوسمتي انا، عشان
 * الاتنين يقدروا يتفتحوا في نفس الجلسة من غير تعارض)
 */
function renderPublicBadgesPage() {
    const container = document.getElementById('publicBadgesPageGroups');
    const countLabel = document.getElementById('publicBadgesPageCount');
    if (!container) return;

    if (publicProfileBadgesData.length === 0) {
        container.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-8">لسه مفيش أوسمة متاحة</p>`;
        if (countLabel) countLabel.textContent = '0 / 0 مفتوح';
        return;
    }

    container.innerHTML = BADGE_TIER_ORDER.map((tierKey) => {
        const tierBadges = publicProfileBadgesData.filter((b) => b.tier === tierKey);
        if (tierBadges.length === 0) return '';

        return `
            <div class="space-y-3">
                <h4 class="text-xs font-extrabold text-lux-300">${BADGE_TIER_LABELS[tierKey]}</h4>
                <div class="grid grid-cols-3 gap-3">
                    ${tierBadges.map(badgeCardHtml).join('')}
                </div>
            </div>
        `;
    }).join('');

    if (countLabel) {
        const unlockedCount = publicProfileBadgesData.filter((b) => b.unlocked).length;
        countLabel.textContent = `${unlockedCount} / ${publicProfileBadgesData.length} مفتوح`;
    }
}

/**
 * تفعيل صفحة "الأوسمة والشارات" الكاملة الخاصة ببروفايل عام
 * (#tab-public-badges-page) - نفس آلية openBadgesPage بالظبط، بس
 * previousTabIdBeforePublicBadgesPage هنا هيبقى دايماً 'public-profile'
 * عمليًا (الزرار اللي بينادي عليها مش موجود إلا جوه صفحة البروفايل
 * العام نفسها)، فزرار "رجوع" هنا بيرجّع لبروفايل الشخص نفسه، مش لأي
 * تبويب كان مفتوح قبل ما تفتح بروفايله من الأساس
 */
function openPublicBadgesPage() {
    const page = document.getElementById('tab-public-badges-page');
    if (!page) return;

    renderPublicBadgesPage();

    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-public-badges-page') {
        previousTabIdBeforePublicBadgesPage = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    page.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    pushModalState(hidePublicBadgesPage);
}

/** الإخفاء الخام لصفحة "الأوسمة والشارات" الخاصة ببروفايل عام فقط - استخدم closePublicBadgesPage تحت */
function hidePublicBadgesPage() {
    const targetTabId = previousTabIdBeforePublicBadgesPage || 'public-profile';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    previousTabIdBeforePublicBadgesPage = null;
}

/** الرجوع من صفحة "الأوسمة والشارات" الخاصة ببروفايل عام - الدالة اللي زرار "رجوع" لازم ينادي عليها بدل hidePublicBadgesPage مباشرة */
function closePublicBadgesPage() {
    closeModal();
}

/**
 * ربط زرار فتح صفحة "الأوسمة والشارات" الكاملة (من دولاب البروفايل العام)
 * وزرار "رجوع" جوه الصفحة نفسها - مرة واحدة بس، نفس فكرة bindBadgesPageEvents بالظبط
 */
function bindPublicBadgesPageEvents() {
    if (publicBadgesPageEventsBound) return;
    publicBadgesPageEventsBound = true;

    const openBtn = document.getElementById('btnOpenPublicBadgesPage');
    if (openBtn) openBtn.addEventListener('click', () => openPublicBadgesPage());

    const backBtn = document.getElementById('btnBackFromPublicBadgesPage');
    if (backBtn) backBtn.addEventListener('click', () => closePublicBadgesPage());
}

/**
 * رسم زرار الصداقة التفاعلي جوه صفحة البروفايل العام حسب حالة الصداقة
 * الحالية، وربط سلوكه (إرسال طلب/قبول طلب) بالضغط عليه. بتُعاد مناداتها
 * بعد أي عملية ناجحة عشان الزرار يتحدّث فوراً من غير ما نحتاج نرجع
 * ونفتح الصفحة تاني
 * @param {string} targetUserId
 * @param {'self'|'none'|'pending_sent'|'pending_received'|'accepted'} status
 * @param {string|null} requestId - معرّف صف friends (لازم بس لحالة pending_received)
 */
function renderPublicProfileFriendButton(targetUserId, status, requestId) {
    const container = document.getElementById('publicProfileFriendActionContainer');
    if (!container) return;

    // (جديد) الزائر (window.isGuestMode) مش عنده حساب حقيقي أصلاً، فمفيش
    // "طلب صداقة" ممكن يبعته أو يستقبله. من غير الشرط ده، fetchFriendshipStatusWith
    // بترجع status: 'none' افتراضياً لما currentAuthUser يبقى null (شوف
    // تعليقها فوق)، فكان بيظهر زرار "إضافة صديق" عادي للزائر رغم إنه هيفشل
    // فعلياً لو ضغط عليه (sendFriendRequest محتاجة currentAuthUser). بنمنع
    // الزرار من الأساس هنا بدل ما نسيبه يفشل بصمت أو يطلع رسالة خطأ مربكة.
    if (window.isGuestMode) {
        container.innerHTML = '';
        return;
    }

    // البروفايل ده بتاع المستخدم الحالي نفسه -> مفيش زرار صداقة خالص
    if (status === 'self') {
        container.innerHTML = '';
        return;
    }

    // كل حالة دلوقتي ليها فعل واضح ممكن تضغط عليه - بما فيها 'pending_sent'
    // (تقدر تلغي الطلب اللي بعتّه) و'accepted' (تقدر تلغي الصداقة) بدل ما
    // كانوا زرارين معطّلين من غير أي سلوك زي الأول
    const buttonVariants = {
        none: {
            text: 'إضافة صديق',
            classes: 'bg-gold-500 text-lux-950 hover:opacity-90',
            action: 'send',
        },
        pending_sent: {
            text: 'إلغاء الطلب',
            classes: 'bg-lux-800 text-rose-400 hover:bg-rose-500/10 border border-rose-500/20',
            action: 'cancel',
        },
        pending_received: {
            text: 'قبول الطلب',
            classes: 'bg-teal-500 text-white hover:bg-teal-400',
            action: 'accept',
        },
        accepted: {
            text: 'إلغاء الصداقة',
            classes: 'bg-lux-800 text-rose-400 hover:bg-rose-500/10 border border-rose-500/20',
            action: 'unfriend',
        },
    };

    const variant = buttonVariants[status] || buttonVariants.none;

    container.innerHTML = `
        <button type="button" id="publicProfileFriendBtn"
                class="w-full py-2.5 rounded-2xl text-sm font-black transition-all duration-200 ${variant.classes}">
            ${variant.text}
        </button>
    `;

    const btn = document.getElementById('publicProfileFriendBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        // (تحسين) "إلغاء الصداقة" فعل مدمّر زي أي حذف صديق تاني في
        // التطبيق - لازم يمر على نفس مودال تأكيد الحذف (removeFriendConfirmModal)
        // بدل ما يتنفذ على طول من غير أي تأكيد زي ما كان قبل كده. "إلغاء
        // الطلب" (طلب لسه معلّق ومقبلش يتقبل) فعل خفيف ومقصود يفضل فوري
        // من غير تأكيد، فمش بيمر على المودال
        if (variant.action === 'unfriend' && requestId) {
            const targetName = document.getElementById('publicProfileName')?.textContent || null;
            openRemoveFriendConfirmModal(requestId, targetName, async () => {
                if (currentPublicProfileTargetId !== targetUserId) return;
                const refreshed = await fetchFriendshipStatusWith(targetUserId);
                renderPublicProfileFriendButton(targetUserId, refreshed.status, refreshed.requestId);
            });
            return;
        }

        btn.disabled = true;
        btn.textContent = '...';

        if (variant.action === 'send') {
            await sendFriendRequest(targetUserId);
        } else if (variant.action === 'accept' && requestId) {
            await acceptFriendRequest(requestId);
        } else if (variant.action === 'cancel' && requestId) {
            // إلغاء طلب صداقة لسه معلّق - نفس عملية حذف صف friends
            // (removeFriend)، بس من غير تأكيد لأنه فعل خفيف
            await removeFriend(requestId);
        }

        // لو المستخدم رجع للتبويب اللي قبله أو فتح بروفايل شخص تاني أثناء
        // انتظار الرد، منعملش إعادة رسم لبيانات مش بتاعت الشخص المعروض حالياً
        if (currentPublicProfileTargetId !== targetUserId) return;

        // تحديث حالة الزرار فوراً بعد نجاح العملية (بنعيد الفحص من
        // Supabase بدل افتراض النتيجة يدوياً، عشان نغطي حالة القبول
        // التلقائي جوه sendFriendRequest لو الطرف التاني كان بعتلك
        // طلب أصلاً - شوف تعليق sendFriendRequest فوق)
        const refreshed = await fetchFriendshipStatusWith(targetUserId);
        renderPublicProfileFriendButton(targetUserId, refreshed.status, refreshed.requestId);
    });
}

/**
 * تفعيل صفحة البروفايل العام (#tab-public-profile) بنفس آلية تبديل
 * ".tab-content" اللي app.js بتستخدمها بين home/leaderboard/profile،
 * وتسجيل التبويب اللي كنا فيه قبل كده عشان زرار "رجوع" يرجعله بالظبط.
 * مقصود عمداً إننا منلمسش أزرار nav-btn في الشريط السفلي هنا (تفضل
 * واخدة شكل التبويب الأصلي)، لأن صفحة البروفايل العام صفحة "متفرعة"
 * مش تبويب أساسي في التنقل
 */
/**
 * @param {boolean} replaceHistory - true لو الصفحة دي بتحل محل مودال
 *   تاني كان مفتوح واتقفل توّه (زي storyViewerModal)
 *   بدل ما تُفتح فوق تبويب عادي - بنستخدم replaceModalState بدل
 *   pushModalState في الحالة دي عشان نتجنب مضاعفة خطوات تاريخ المتصفح
 *   (شوف openPublicProfile وتعليق replaceModalState في modal-history.js)
 */
function activatePublicProfilePage(replaceHistory) {
    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-public-profile') {
        previousTabIdBeforePublicProfile = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const publicProfileTab = document.getElementById('tab-public-profile');
    if (publicProfileTab) publicProfileTab.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (replaceHistory) {
        replaceModalState(hidePublicProfilePage);
    } else {
        pushModalState(hidePublicProfilePage);
    }
}

/** الإخفاء الخام لصفحة البروفايل العام فقط - استخدم goBackFromPublicProfilePage تحت */
function hidePublicProfilePage() {
    const targetTabId = previousTabIdBeforePublicProfile || 'home';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    currentPublicProfileTargetId = null;
    previousTabIdBeforePublicProfile = null;
}

/**
 * الرجوع من صفحة البروفايل العام للتبويب اللي كان مفتوح قبلها (home
 * افتراضياً لو مش متسجل لأي سبب) - الدالة العامة اللي زرار "رجوع" في
 * الصفحة لازم ينادي عليها بدل hidePublicProfilePage مباشرة
 */
function goBackFromPublicProfilePage() {
    closeModal();
}

/**
 * فتح صفحة "بروفايل عام" لأي مستخدم بمعرّفه - بتُنادى من:
 *  - js/stories.js عند الضغط على اسم/صورة صاحب الستوري المفتوحة
 *  - js/leaderboard.js (openLeaderboardUserProfile، عن طريق import()
 *    ديناميكي) عند الضغط على أي صف/بطل في لوحة المتصدرين
 * @param {string} targetUserId
 * @param {{ replaceHistory?: boolean }} [options] - مرّر
 *   { replaceHistory: true } لو الاستدعاء ده جاي فوراً بعد إغلاق مودال
 *   تاني (مش بعد تبويب عادي) - زي storyViewerModal
 */
export async function openPublicProfile(targetUserId, options) {
    if (!targetUserId) return;

    currentPublicProfileTargetId = targetUserId;
    setPublicProfileLoadingState();
    activatePublicProfilePage(Boolean(options?.replaceHistory));

    const [profileRow, friendship] = await Promise.all([
        fetchPublicProfileRow(targetUserId),
        fetchFriendshipStatusWith(targetUserId),
    ]);

    // لو المستخدم رجع بالضغط على "رجوع" أو فتح بروفايل شخص تاني أثناء
    // انتظار الرد (ضغطات سريعة متتالية على أكتر من صف/ستوري)، منرسمش
    // بيانات شخص قديم فوق صفحة بقت بتعرض حد تاني دلوقتي
    if (currentPublicProfileTargetId !== targetUserId) return;

    if (!profileRow) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'مقدرناش نجيب بيانات البروفايل ده، حاول تاني', type: 'error' } }));
        goBackFromPublicProfilePage();
        return;
    }

    renderPublicProfileContent(profileRow);
    renderPublicProfileFriendButton(targetUserId, friendship.status, friendship.requestId);
    renderPublicProfileSupportButton(targetUserId);
    await loadAndRenderPublicProfileBadges(targetUserId);
}

/**
 * (المرحلة 8) زرار "إرسال رسالة" - ليه حالتين دلوقتي:
 *   1) بروفايل الأدمن نفسه (getSupportAdminUserId من support-chat.js)
 *      وأنت مستخدم عادي بتفتحه -> بيبعتك لمحادثتك انت مع الأدمن (زي
 *      ما كان بالظبط قبل كده).
 *   2) (تعديل) انت الأدمن نفسك وفاتح بروفايل أي حد تاني (غير بروفايلك
 *      انت) -> بيفتحلك شات مباشر معاه (openSupportChatAsAdminWithUser)،
 *      حتى لو مفيش رسايل بينكم لسه - عشان تقدر تبدأ محادثة مع أي حد
 *      من غير ما تستنى هو يبعتلك الأول.
 * وفي الحالتين: بروفايلك انت لنفسك (self) ما بيعرضش الزرار (مفيش معنى
 * تبعت رسالة لنفسك)، وزائر بره النطاق الجغرافي (isGuestMode) برضه ما
 * بيشوفوش، بنفس منطق زرار الصداقة تماماً.
 * @param {string} targetUserId
 */
function renderPublicProfileSupportButton(targetUserId) {
    const container = document.getElementById('publicProfileSupportActionContainer');
    if (!container) return;

    const isSelf = currentAuthUser && currentAuthUser.id === targetUserId;

    if (isSelf || window.isGuestMode) {
        container.innerHTML = '';
        return;
    }

    const adminUserId = getSupportAdminUserId();
    const isAdminProfile = targetUserId === adminUserId;
    const viewerIsAdmin = Boolean(currentAuthUser && currentAuthUser.id === adminUserId);

    // الزرار بيظهر بس في حالتين: (أ) بروفايل الأدمن ومستخدم عادي فاتحه،
    // أو (ب) الأدمن نفسه فاتح بروفايل أي حد تاني - أي تركيبة تانية
    // (مستخدم عادي فاتح بروفايل مستخدم عادي تاني) ملهاش معنى هنا
    if (!isAdminProfile && !viewerIsAdmin) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <button type="button" id="publicProfileSupportBtn"
                class="w-full py-2.5 rounded-2xl text-sm font-black transition-all duration-200 bg-lux-800 text-gold-400 hover:bg-lux-800/70 border border-gold-500/20 flex items-center justify-center gap-1.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
                <path d="M4 4h16v12H7l-3 3z"></path>
            </svg>
            <span>إرسال رسالة</span>
        </button>
    `;

    document.getElementById('publicProfileSupportBtn')?.addEventListener('click', () => {
        if (viewerIsAdmin && !isAdminProfile) {
            openSupportChatAsAdminWithUser(targetUserId);
        } else {
            openSupportChatWithAdmin();
        }
    });
}

/**
 * فتح Lightbox تكبير الصورة الشخصية بحجم كبير وواضح - بتُنادى بالضغط
 * على صورة أي بروفايل عام (publicProfileAvatarBtn)
 * @param {string} imageUrl
 * @param {string} altText
 */
function openAvatarLightbox(imageUrl, altText) {
    const lightbox = document.getElementById('avatarLightbox');
    const image = document.getElementById('avatarLightboxImage');
    if (!lightbox || !image || !imageUrl) return;

    image.src = imageUrl;
    image.alt = altText || 'صورة مكبّرة';
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');

    pushModalState(hideAvatarLightbox);
}

/** الإخفاء الخام لـ Lightbox تكبير الصورة الشخصية فقط - استخدم closeAvatarLightbox تحت */
function hideAvatarLightbox() {
    const lightbox = document.getElementById('avatarLightbox');
    if (lightbox) {
        lightbox.classList.add('hidden');
        lightbox.classList.remove('flex');
    }
}

/**
 * إغلاق Lightbox تكبير الصورة الشخصية - الدالة العامة اللي زرار
 * الإغلاق والضغط برّه الصورة لازم ينادوا عليها بدل hideAvatarLightbox
 */
function closeAvatarLightbox() {
    closeModal();
}

/**
 * ربط كل أحداث صفحة البروفايل العام (زرار الرجوع، الضغط على الصورة
 * لتكبيرها، زرار إغلاق الـ lightbox، والضغط برّه الصورة المكبّرة لقفلها)
 * مرة واحدة بس - نفس فلسفة باقي bindXxxEvents في الملف ده
 */
function bindPublicProfileEvents() {
    if (publicProfileEventsBound) return;
    publicProfileEventsBound = true;

    const backBtn = document.getElementById('btnBackFromPublicProfile');
    if (backBtn) backBtn.addEventListener('click', goBackFromPublicProfilePage);

    const avatarBtn = document.getElementById('publicProfileAvatarBtn');
    if (avatarBtn) {
        avatarBtn.addEventListener('click', () => {
            const avatarImg = document.getElementById('publicProfileAvatar');
            const name = document.getElementById('publicProfileName')?.textContent || 'صورة البطل';
            const fullUrl = avatarImg?.dataset.fullUrl || avatarImg?.src;
            openAvatarLightbox(fullUrl, name);
        });
    }

    const closeLightboxBtn = document.getElementById('btnCloseAvatarLightbox');
    if (closeLightboxBtn) closeLightboxBtn.addEventListener('click', closeAvatarLightbox);

    const lightbox = document.getElementById('avatarLightbox');
    if (lightbox) {
        lightbox.addEventListener('click', (event) => {
            if (event.target === lightbox) closeAvatarLightbox(); // قفل لو ضغط برّه الصورة نفسها
        });
    }
}

/**
 * جلب صف البروفايل الحقيقي وعرضه بالكامل (الاسم/الصورة/اللقب/
 * الإحصائيات)، تُستدعى مرة واحدة من initProfileUI وكمان ممكن تتنادى
 * تاني بعد أي تحديث للبروفايل (زي بعد "إعداد البطل لأول مرة")
 * @param {object} user - بيانات المستخدم القادمة من js/auth.js
 */
async function loadAndRenderRealProfile(user) {
    currentAuthUser = user;
    // (إصلاح - باج حقيقي) لازم قبل أي قراءة/مزامنة للخطوات - بيصفّر
    // العداد المحلي في sensors.js لو الحساب ده مختلف عن آخر حساب كانت
    // الحالة المحلية باسمه (تبديل حساب على نفس الجهاز)، عشان
    // reconcileWithServerSteps تحت ماتحسبش خطوات الحساب القديم غلط
    // كـ"تقدم أعلى" للحساب الجديد
    syncActiveUser(user.id);

    // (كاش الأوفلاين) كل الخطوات اللي كانت جوه الدالة دي قبل التعديل
    // (تسجيل حضور/مزامنة الخطوات/جلب الأوسمة والأصحاب) دلوقتي مجمّعة في
    // runProfilePipeline تحت، ومحمية بـ pipelineRan عشان تتنفذ **مرة
    // واحدة بس** لكل نداء لـ loadAndRenderRealProfile - مش مرتين (مرة
    // بالبروفايل المخزّن محلياً في الكاش لعرض سريع، ومرة تانية بالبروفايل
    // الحقيقي لما رد الشبكة يوصل)، غير كده كنا هنعمل RPC مزدوج
    // (apply_steps_progress) وفحص أوسمة/جلب أصحاب مكرر من غير أي فايدة.
    // الكتابة الفعلية جوه applyDailyCheckIn بتعتمد على السيرفر كمصدر
    // الحقيقة (RPC مش قيم محلية - شوف applyStepsProgressServerSide)،
    // فتشغيلها بأول بيانات توصلنا (كاش أو شبكة أيهم الأسرع) آمن.
    let pipelineRan = false;

    const runProfilePipeline = async (profile) => {
        if (pipelineRan) return;
        pipelineRan = true;

        // (إصلاح - باج حقيقي) currentAuthUser/currentProfileRow دلوقتي
        // متظبطين - أي خطوات اتجمّعت في pendingStepsDelta قبل كده (من
        // غير ما تتبعت، لأن المستخدم ماكانش مسجّل دخول لسه) موجودة أصلاً
        // في الذاكرة (recordStepsProgress بتجمّعها هناك مباشرة) -
        // مبنعملش restorePendingStepsFromStorage هنا عشان مش نضيفها مرة
        // تانية فوق نفسها. bindStepsFlushLifecycleEvents (بتتنادى
        // لاحقًا من initProfileUI) هي المسؤولة عن استرجاع أي رصيد اتحفظ
        // من *جلسة سابقة* فعلاً اتقفلت (شوف restorePendingStepsFromStorage).
        if (pendingStepsDelta > 0) {
            flushPendingStepsBatch();
        }

        // "تسجيل حضور" اليوم بعد ما البروفايل اتحمّل بنجاح - ده اللي
        // بيحقق شرط "الستريك +1 عند تسجيل الدخول" (المرحلة 3). بنتجاهلها
        // لو الصف مش موجود أصلاً (مستخدم لسه معملش "إعداد البطل لأول مرة")
        if (profile) {
            await applyDailyCheckIn();
        }

        // (إصلاح - باج حقيقي) لو دخلنا من جهاز/متصفح جديد، localStorage
        // هنا فاضي فعداد الخطوات المحلي (sensors.js) بيبدأ من صفر رغم إن
        // daily_steps الحقيقية موجودة أصلاً في صف البروفايل. بعد
        // applyDailyCheckIn فوق (اللي ممكن يحدّث currentProfileRow لو
        // السيرفر عمل Reset ليوم جديد)، بنزبط العداد المحلي على أحدث
        // قيمة معروفة من Supabase - reconcileWithServerSteps بتتجاهل
        // النداء لو القيمة المحلية أصلاً أكبر أو مساوية (مفيش تراجع للخلف).
        if (currentProfileRow) {
            reconcileWithServerSteps(currentProfileRow.daily_steps ?? 0);
            // (جديد) نفس فكرة السطر اللي فوق بالظبط بس للرقم القياسي
            // (best_daily_steps) - عشان "رقمك القياسي" يفضل صح عبر كل
            // الأجهزة لنفس الحساب، مش بس محفوظ محليًا على جهاز واحد
            reconcileServerBestSteps(currentProfileRow.best_daily_steps ?? 0);
        }

        // تحميل الأوسمة الحقيقية وقائمة الأصدقاء (المرحلتين 4 و5) بعد ما
        // نتأكد إن عندنا currentAuthUser صحيح - loadAndRenderFriendsCached
        // (كاش الأوفلاين) بدل loadAndRenderFriends هنا تحديداً عشان تبويب
        // البروفايل يعرض آخر قائمة أصدقاء/طلبات محفوظة فوراً لو النت مقطوع
        await Promise.all([
            loadAndRenderBadges(user.id),
            loadAndRenderFriendsCached(user.id),
        ]);

        // (إصلاح - تكرار توست الأوسمة) بمجرد ما نجيب الأوسمة الحقيقية أول
        // مرة في الجلسة دي، بنسجّل كل وسام مفتوح بالفعل دلوقتي كـ"اتبعتله
        // توست قبل كده" في localStorage (من غير أي توست فعلي هنا - بس
        // تسجيل). ده بيضمن إن حتى أول مرة يتفعّل فيها الإصلاح ده، أي وسام
        // المستخدم كسبه من زمان مش هيظهرله توست تاني أبداً - التوست هيفضل
        // مقصور بس على أي وسام "جديد فعلاً" هيتفتح بعد كده (شوف checkAndUnlockBadges)
        markBadgesAsNotified(user.id, badgesData.filter((b) => b.unlocked).map((b) => b.id));
    };

    // (كاش الأوفلاين) نقطة الدخول الرئيسية - تعرض النسخة المخزّنة محلياً
    // (cached_profile:<userId>) فوراً لو موجودة، وتحدّثها في الخلفية
    // تلقائياً بعد كل قراءة ناجحة من الشبكة
    await fetchWithCache(`cached_profile:${user.id}`, () => fetchUserProfileFromServer(user.id), async ({ profile }) => {
        currentProfileRow = profile;

        renderProfileHeader(profile, user);
        updateProfileStats({
            totalSteps: profile?.total_steps ?? 0,
            correctAnswers: profile?.correct_answers ?? 0,
            bestStreakDays: profile?.best_streak_days ?? 0,
            points: profile?.points ?? 0,
            streakCount: profile?.streak_count ?? 0,
            dailyChampionshipWins: profile?.daily_championship_wins ?? 0,
            weeklyChampionshipWins: profile?.weekly_championship_wins ?? 0,
            monthlyChampionshipWins: profile?.monthly_championship_wins ?? 0,
        });

        await runProfilePipeline(profile);
    });

    // (كاش الأوفلاين) مفيش كاش محفوظ ومفيش رد شبكة نجح خالص (أول فتح
    // للتطبيق من غير نت ومن غير أي كاش سابق على الجهاز) - fetchWithCache
    // فوق ماكانتش نادت الـ Callback خالص في الحالة دي، فبنعرض نفس الحالة
    // الافتراضية اللي initProfileUI بتعرضها قبل استدعاء الدالة دي أصلاً
    // (البروفايل الحقيقي هيظهر لوحده أول ما المستخدم يفتح الشاشة تاني
    // والنت يرجع، زي أي شاشة تانية في المشروع - مفيش Sync يدوي هنا)
    if (!pipelineRan) {
        renderProfileHeader(null, user);
        updateProfileStats();
    }
}

/**
 * رفع صورة بروفايل جديدة (من فورم التعديل، بعد ما الحساب اتعمل بالفعل)
 * لباكت "avatars" في Supabase Storage، وإرجاع الرابط العام بتاعها.
 * نفس منطق الرفع المستخدم وقت التسجيل في auth.js، مكرر هنا لأن
 * الملفين مسؤولين عن سياقين مختلفين (تسجيل جديد VS تعديل لاحق)
 * @param {string} userId
 * @param {File} file
 * @returns {Promise<string>}
 */
async function uploadEditAvatarFile(userId, file) {
    const fileExtension = (file.name && file.name.includes('.'))
        ? file.name.split('.').pop()
        : (file.type && file.type.includes('/') ? file.type.split('/').pop() : 'jpg');

    const filePath = `${userId}/avatar-${Date.now()}.${fileExtension}`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('avatars')
        .upload(filePath, file, { upsert: true, contentType: file.type || 'image/jpeg' });

    if (uploadError) {
        throw new Error('حصل خطأ أثناء رفع الصورة، جرّب صورة تانية');
    }

    const { data } = supabaseClient.storage.from('avatars').getPublicUrl(filePath);
    return data.publicUrl;
}

/**
 * تعبئة قايمة "لقب الشرف" (#editTitleSelect) ديناميكيًا من عناوين
 * الأوسمة اللي المستخدم فتحها فعلاً بس (badgesData.unlocked) - بدل
 * قايمة ألقاب ثابتة كانت متاحة للجميع بغض النظر عن أي إنجاز حقيقي.
 * كل وسام مفتوح بيبقى اختيار ممكن (value = عنوان الوسام نفسه، بنفس
 * القيمة اللي بتتخزن في profiles.title)، وبيتحدد افتراضيًا اللقب
 * المحفوظ فعلاً في currentProfileRow.title لو لسه من ضمن الأوسمة
 * المفتوحة (ممكن يتغير لاحقًا لو الوسام اتشال من الكتالوج مثلاً).
 * لو المستخدم لسه معندوش أي وسام مفتوح خالص، بنسيب Placeholder واحد
 * بس معطّل يوضح السبب بدل ما نعرضله قايمة فاضية أو مضلّلة.
 */
function populateEditTitleSelectOptions() {
    const titleSelect = document.getElementById('editTitleSelect');
    if (!titleSelect) return;

    const unlockedBadges = badgesData.filter((badge) => badge.unlocked);
    const currentTitle = currentProfileRow?.title || '';

    if (unlockedBadges.length === 0) {
        titleSelect.innerHTML = `<option value="">لسه معندكش أوسمة تقدر تستخدمها كلقب</option>`;
        titleSelect.value = '';
        titleSelect.disabled = true;
        return;
    }

    titleSelect.disabled = false;
    // خيار "بدون لقب" صريح - يسيب profiles.title فاضي (null) لو حابب
    // يشيل اللقب الحالي من غير ما يضطر يختار وسام تاني بدلاً منه
    const noneOptionHtml = `<option value="">من غير لقب</option>`;
    const badgeOptionsHtml = unlockedBadges
        .map((badge) => `<option value="${escapeHtml(badge.title)}">${escapeHtml(badge.title)}</option>`)
        .join('');

    titleSelect.innerHTML = noneOptionHtml + badgeOptionsHtml;

    // لو اللقب المحفوظ حاليًا لسه من ضمن الأوسمة المفتوحة، بنحدده -
    // وإلا (اتشال من الكتالوج، أو حساب قديم كان عليه لقب ثابت زمان)
    // بنسيب "من غير لقب" محدد بدل ما نفترض اختيار غلط
    const matchesUnlockedBadge = unlockedBadges.some((badge) => badge.title === currentTitle);
    titleSelect.value = matchesUnlockedBadge ? currentTitle : '';
}

/** Escape بسيط لأي نص بيتحط جوه innerHTML (عناوين الأوسمة نصوص إدارية
 * من جدول badges مش مدخلة من المستخدم النهائي، بس بنعمل escape
 * احتياطيًا عشان منسيبش أي فرصة لـ HTML injection لو حد غيّرها لاحقًا) */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/**
 * تفعيل صفحة "إعدادات الحساب" (#tab-account-settings) بنفس آلية تبديل
 * ".tab-content" اللي app.js بتستخدمها بين home/leaderboard/profile،
 * ونفس فلسفة activatePublicProfilePage بالظبط - صفحة مستقلة كاملة
 * (مش مودال منبثق فوق الصفحة)، وتعبئتها بالقيم الحقيقية الحالية
 * (currentProfileRow) بدل ما تفتح فاضية أو بقيم افتراضية غلط
 */
function openAccountSettingsPage() {
    const page = document.getElementById('tab-account-settings');
    if (!page) return;

    if (!currentAuthUser) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'حصل خطأ في التعرف على المستخدم، حاول تسجل دخول تاني', type: 'error' },
        }));
        return;
    }

    const nameInput = document.getElementById('editFullNameInput');
    const previewImg = document.getElementById('editProfileAvatarPreview');
    const currentAvatarEl = document.getElementById('profileAvatar');
    const birthDateInput = document.getElementById('editBirthDateInput');

    if (nameInput) nameInput.value = currentProfileRow?.full_name || '';
    // (إصلاح - "لقب الشرف" بقى مرتبط بالأوسمة): بدل ما نحط قيمة ثابتة
    // هنا، بنبني قايمة الاختيارات نفسها ديناميكيًا من الأوسمة المفتوحة
    // فعليًا (شوف populateEditTitleSelectOptions فوق)
    populateEditTitleSelectOptions();
    if (previewImg) {
        // بنستخدم الصورة الظاهرة فعلياً في كارت البروفايل كنقطة بداية
        // (أدق من currentProfileRow?.avatar_url لأنها ممكن تكون null
        // في حالات نادرة رغم إن فيه صورة ظاهرة فعلاً من fallback تاني)
        previewImg.src = currentProfileRow?.avatar_url || currentAvatarEl?.src || previewImg.src;
    }
    // كل مرة نفتح فيها الصفحة من جديد لازم نصفّر علم "حذف الصورة" ونعيد
    // حساب ظهور زرار الحذف من الصفر، عشان مايفضلش متأثر بفتحة سابقة
    // اتلغت (زرار "إلغاء"/"رجوع") من غير حفظ
    editAvatarRemoved = false;
    updateEditAvatarDeleteButtonVisibility();
    // تاريخ الميلاد راجع من Supabase بصيغة "YYYY-MM-DD" بالظبط، فمينفعش
    // نحتاج أي تحويل عشان يتحط في input[type=date] مباشرة
    if (birthDateInput) birthDateInput.value = currentProfileRow?.birth_date || '';
    // النوع: لو مسجّل بالفعل بيتحدد شكله، ولو null (حساب قديم من قبل ما
    // النوع بقى إجباري مثلاً) بيفضل الزرارين من غير أي واحد متحدد
    selectEditGender(currentProfileRow?.gender || null);

    // فورم تغيير الباسورد لازم يفضل فاضي كل مرة (منعاً لأي التباس إنه
    // "لسه محتفظ" بباسورد كتبته قبل كده في فتحة سابقة للصفحة)
    const newPasswordInput = document.getElementById('newPasswordInput');
    const confirmNewPasswordInput = document.getElementById('confirmNewPasswordInput');
    if (newPasswordInput) newPasswordInput.value = '';
    if (confirmNewPasswordInput) confirmNewPasswordInput.value = '';

    // تعبئة حقل الـ username المخفي بإيميل المستخدم الحالي عشان مديري
    // الباسورد في المتصفح يقدروا يربطوا الباسورد الجديد بالحساب الصح
    // (شوف تعليق الحقل نفسه في index.html)
    const changePasswordUsernameInput = document.getElementById('changePasswordUsernameInput');
    if (changePasswordUsernameInput) changePasswordUsernameInput.value = currentAuthUser?.email || '';

    editSelectedAvatarFile = null;

    // نفس منطق activatePublicProfilePage: نسجّل التبويب الحالي عشان زرار
    // "رجوع" يرجعله بالظبط، وبعدين نبدّل .tab-content
    const currentActiveTab = document.querySelector('.tab-content.active');
    if (currentActiveTab && currentActiveTab.id !== 'tab-account-settings') {
        previousTabIdBeforeAccountSettings = currentActiveTab.id.replace('tab-', '');
    }

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    page.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    pushModalState(hideAccountSettingsPage);
}

/**
 * تحديد النوع المختار جوه مودال إعدادات الحساب، وتحديث شكل الزرارين -
 * نفس فكرة selectSignupGender في js/auth.js بالظبط بس على عناصر
 * editGenderMale/editGenderFemale/editGenderInput (مش نسخة فورم التسجيل)
 * @param {'male'|'female'|null} gender
 */
function selectEditGender(gender) {
    const genderHiddenInput = document.getElementById('editGenderInput');
    if (genderHiddenInput) genderHiddenInput.value = gender || '';

    const maleBtn = document.getElementById('editGenderMale');
    const femaleBtn = document.getElementById('editGenderFemale');

    [maleBtn, femaleBtn].forEach((btn) => {
        if (!btn) return;
        const isSelected = Boolean(gender) && btn.dataset.gender === gender;
        btn.classList.toggle('bg-gold-500', isSelected);
        btn.classList.toggle('border-gold-500', isSelected);
        btn.classList.toggle('text-lux-950', isSelected);
        btn.classList.toggle('shadow-glow-amber', isSelected);
        btn.classList.toggle('bg-lux-800', !isSelected);
        btn.classList.toggle('border-gold-500/15', !isSelected);
        btn.classList.toggle('text-lux-300', !isSelected);
    });
}

/**
 * الإخفاء الخام لصفحة "إعدادات الحساب" فقط - استخدم closeAccountSettingsPage
 * تحت. بتنضف كمان أي بقايا من مودال قص الصورة (لو كان لسه مفتوح فوقها)
 * بالإخفاء الخام بتاعه (hideEditAvatarCropModal) - عمداً مش عن طريق
 * closeEditAvatarCropModal، عشان الأخيرة بتنادي closeModal() اللي ممكن
 * يستهلك خطوة تاريخ غلط (خطوة الصفحة دي نفسها) لو مودال القص أصلاً
 * مكانش فاتح ومالوش state متسجلة في الـ Stack.
 * نفس فكرة hidePublicProfilePage بالظبط: بترجع للتبويب اللي كنا فيه قبلها
 */
function hideAccountSettingsPage() {
    const targetTabId = previousTabIdBeforeAccountSettings || 'home';

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
    const targetTab = document.getElementById(`tab-${targetTabId}`);
    if (targetTab) targetTab.classList.add('active');

    previousTabIdBeforeAccountSettings = null;

    hideEditAvatarCropModal();
}

/**
 * الرجوع من صفحة "إعدادات الحساب" - الدالة العامة اللي زرار "رجوع"
 * والحفظ الناجح لازم ينادوا عليها بدل hideAccountSettingsPage مباشرة
 */
function closeAccountSettingsPage() {
    closeModal();
}

/**
 * التحكم في ظهور مؤشر التحميل جوه زرار "حفظ التعديلات"
 * @param {boolean} isLoading
 */
function setEditProfileLoading(isLoading) {
    const submitBtn = document.getElementById('btnSaveEditProfile');
    const spinner = document.getElementById('editProfileLoadingSpinner');

    if (submitBtn) submitBtn.disabled = isLoading;
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
}

/**
 * حفظ تعديلات البروفايل (الاسم، اللقب، وصورة جديدة لو المستخدم
 * اختار واحدة) في جدول profiles - UPDATE على صف المستخدم بس
 * (auth.uid() = id بيضمنها الـ RLS Policy profiles_update_own)
 */
async function handleEditProfileSubmit(event) {
    event.preventDefault();

    // منع حفظ أي تعديل بروفايل في وضع الزائر - نفس النمط المستخدم في
    // handleStepsIncrease (js/app.js). data-requires-membership بيقفل
    // الزرار بصريًا بس، الفحص ده هو المنع الفعلي لتنفيذ الدالة نفسها
    // حتى لو الزرار اتفعّل بأي طريقة تانية (استدعاء مباشر من الكونسول مثلاً)
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تعدّل بروفايلك', type: 'info' },
        }));
        return;
    }

    if (!currentAuthUser) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'حصل خطأ في التعرف على المستخدم، حاول تسجل دخول تاني', type: 'error' },
        }));
        return;
    }

    const fullName = document.getElementById('editFullNameInput').value.trim();
    const title = document.getElementById('editTitleSelect').value || null;
    const birthDate = document.getElementById('editBirthDateInput').value;
    const gender = document.getElementById('editGenderInput').value;

    if (!fullName) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'من فضلك اكتب الاسم', type: 'error' },
        }));
        return;
    }

    if (!birthDate) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'من فضلك اختار تاريخ الميلاد', type: 'error' },
        }));
        return;
    }

    if (gender !== 'male' && gender !== 'female') {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'من فضلك اختار النوع', type: 'error' },
        }));
        return;
    }

    setEditProfileLoading(true);

    try {
        const updates = { full_name: fullName, title, birth_date: birthDate, gender };

        // لو المستخدم اختار صورة جديدة بس، بنرفعها ونضيف رابطها
        // للتحديث - لو مختارش صورة جديدة، avatar_url مش بتتحط في
        // updates خالص فتفضل زي ما هي في القاعدة (منعاً لمسحها بالغلط)
        if (editSelectedAvatarFile) {
            updates.avatar_url = await uploadEditAvatarFile(currentAuthUser.id, editSelectedAvatarFile);
        } else if (editAvatarRemoved) {
            // المستخدم ضغط "حذف الصورة" ومختارش صورة جديدة بدلها - بنمسح
            // avatar_url فعليًا في القاعدة (مش بس بصريًا في المعاينة)
            updates.avatar_url = null;
        }

        // بنستخدم patchProfileRow المشتركة (بدل تكرار منطق update/upsert
        // هنا) - هي كمان اللي بتحدّث currentProfileRow والواجهة تلقائياً
        const finalProfile = await patchProfileRow(updates);

        if (!finalProfile) {
            throw new Error('تعذر حفظ التعديلات، حاول تاني');
        }

        editAvatarRemoved = false;

        closeAccountSettingsPage();
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تم تحديث بروفايلك بنجاح', type: 'success' },
        }));
    } catch (error) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: error.message, type: 'error' } }));
    } finally {
        setEditProfileLoading(false);
    }
}

/**
 * التحكم في ظهور مؤشر التحميل جوه زرار "تغيير الباسورد"
 * @param {boolean} isLoading
 */
function setChangePasswordLoading(isLoading) {
    const submitBtn = document.getElementById('btnChangePassword');
    const spinner = document.getElementById('changePasswordLoadingSpinner');

    if (submitBtn) submitBtn.disabled = isLoading;
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
}

/**
 * حفظ باسورد جديد للمستخدم الحالي عن طريق supabaseClient.auth.updateUser -
 * ده تحديث على جدول auth.users نفسه (مش profiles)، فلازم نداء منفصل
 * تماماً عن handleEditProfileSubmit فوق، وفورم مستقل (changePasswordForm)
 * عشان تغيير الباسورد يبقى ممكن يحصل من غير ما يلمس باقي بيانات الحساب
 */
async function handleChangePasswordSubmit(event) {
    event.preventDefault();

    // نفس حماية handleEditProfileSubmit - الدالة دي كانت بتنادي
    // supabaseClient.auth.updateUser() على طول من غير أي فحص لا
    // لـ currentAuthUser ولا لـ window.isGuestMode
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تغيّر الباسورد', type: 'info' },
        }));
        return;
    }

    const newPassword = document.getElementById('newPasswordInput').value;
    const confirmNewPassword = document.getElementById('confirmNewPasswordInput').value;

    if (!newPassword || newPassword.length < 6) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'الباسورد لازم يكون 6 حروف/أرقام على الأقل', type: 'error' },
        }));
        return;
    }

    if (newPassword !== confirmNewPassword) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'الباسوردين مش متطابقين', type: 'error' },
        }));
        return;
    }

    setChangePasswordLoading(true);

    try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (error) throw error;

        document.getElementById('newPasswordInput').value = '';
        document.getElementById('confirmNewPasswordInput').value = '';

        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تم تغيير الباسورد بنجاح', type: 'success' },
        }));
    } catch (error) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: error.message || 'تعذر تغيير الباسورد، حاول تاني', type: 'error' },
        }));
    } finally {
        setChangePasswordLoading(false);
    }
}

/**
 * فتح مودال قص صورة البروفايل (خاص بمودال تعديل البروفايل)، وتشغيل
 * Cropper.js على الصورة اللي المستخدم اختارها من جهازه، بإطار دائري
 * متناسق (Aspect Ratio 1:1) - نفس فكرة openAvatarCropModal في
 * js/auth.js لكن على عناصر DOM مختلفة (editAvatarCropModal) عشان
 * منتعارضش مع مودال القص بتاع فورم التسجيل
 * @param {File} file
 */
function openEditAvatarCropModal(file) {
    const modal = document.getElementById('editAvatarCropModal');
    const cropImage = document.getElementById('editAvatarCropperImage');

    if (!modal || !cropImage || typeof Cropper === 'undefined') {
        // لو المكتبة مش متحملة لأي سبب، منسيبش المستخدم من غير معاينة
        // على الأقل - بنستخدم الصورة زي ما هي من غير قص
        editSelectedAvatarFile = file;
        editAvatarRemoved = false;
        const previewImg = document.getElementById('editProfileAvatarPreview');
        if (previewImg) previewImg.src = URL.createObjectURL(file);
        updateEditAvatarDeleteButtonVisibility();
        return;
    }

    cropImage.src = URL.createObjectURL(file);
    modal.classList.remove('hidden');

    pushModalState(hideEditAvatarCropModal);

    // Cropper.js محتاج الصورة تكون معمولها render فعلياً في الـ DOM
    // قبل ما نبنيه عليها، فبنستنى فريم واحد (requestAnimationFrame)
    window.requestAnimationFrame(() => {
        if (editAvatarCropperInstance) {
            editAvatarCropperInstance.destroy();
            editAvatarCropperInstance = null;
        }

        editAvatarCropperInstance = new Cropper(cropImage, {
            aspectRatio: 1,
            viewMode: 1,
            dragMode: 'move',
            autoCropArea: 1,
            cropBoxMovable: true,
            cropBoxResizable: true,
            toggleDragModeOnDblclick: false,
            background: false,
        });
    });
}

/**
 * الإخفاء الخام لمودال قص صورة التعديل وتنظيف نسخة Cropper.js الحالية
 * (لو موجودة) فقط - استخدم closeEditAvatarCropModal تحت
 */
function hideEditAvatarCropModal() {
    const modal = document.getElementById('editAvatarCropModal');
    const cropImage = document.getElementById('editAvatarCropperImage');

    if (editAvatarCropperInstance) {
        editAvatarCropperInstance.destroy();
        editAvatarCropperInstance = null;
    }

    if (cropImage && cropImage.src) {
        URL.revokeObjectURL(cropImage.src);
        cropImage.src = '';
    }

    if (modal) modal.classList.add('hidden');
}

/**
 * إغلاق مودال قص صورة التعديل - الدالة العامة اللي زرار الإلغاء
 * وتأكيد القص لازم ينادوا عليها بدل hideEditAvatarCropModal مباشرة
 */
function closeEditAvatarCropModal() {
    closeModal();
}

/**
 * تأكيد قص صورة التعديل: بتاخد المنطقة المحددة من Cropper.js، تحولها
 * لـ Blob، تستخدمها كمعاينة فورية في مودال التعديل، وتخزّنها في
 * editSelectedAvatarFile عشان تترفع فعلياً لـ Supabase Storage لما
 * المستخدم يضغط "حفظ التعديلات" (شوف uploadEditAvatarFile واللي
 * أصلاً بيتعامل مع الحالة دي حتى لو الـ Blob من غير اسم ملف)
 */
function confirmEditAvatarCrop() {
    if (!editAvatarCropperInstance) {
        closeEditAvatarCropModal();
        return;
    }

    const canvas = editAvatarCropperInstance.getCroppedCanvas({
        width: 400,
        height: 400,
        imageSmoothingQuality: 'high',
    });

    if (!canvas) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تعذّر قص الصورة، جرّب تاني', type: 'error' },
        }));
        closeEditAvatarCropModal();
        return;
    }

    canvas.toBlob((blob) => {
        if (!blob) {
            document.dispatchEvent(new CustomEvent('app:toast', {
                detail: { message: 'تعذّر قص الصورة، جرّب تاني', type: 'error' },
            }));
            closeEditAvatarCropModal();
            return;
        }

        editSelectedAvatarFile = blob;
        editAvatarRemoved = false;

        const previewImg = document.getElementById('editProfileAvatarPreview');
        if (previewImg) previewImg.src = URL.createObjectURL(blob);
        updateEditAvatarDeleteButtonVisibility();

        closeEditAvatarCropModal();
    }, 'image/jpeg', 0.92);
}

/**
 * إظهار/إخفاء زرار "حذف الصورة" (#btnEditProfileDeleteAvatar) جوه مودال
 * تعديل البروفايل حسب المعاينة الحالية (#editProfileAvatarPreview) - بيظهر
 * بس لو فيه صورة حقيقية محطوطة فعلاً (مش أيقونة "مفيش صورة" الافتراضية
 * DEFAULT_AVATAR_URI)، عشان مفيش معنى إن المستخدم "يحذف" صورة مش موجودة
 * أصلاً. بتتنادى بعد أي تحديث لـ previewImg.src (فتح الصفحة، اختيار صورة
 * جديدة وقصها، أو الحذف نفسه)
 */
function updateEditAvatarDeleteButtonVisibility() {
    const previewImg = document.getElementById('editProfileAvatarPreview');
    const deleteBtn = document.getElementById('btnEditProfileDeleteAvatar');
    if (!previewImg || !deleteBtn) return;

    const hasRealAvatar = Boolean(previewImg.src) && previewImg.src !== DEFAULT_AVATAR_URI;
    deleteBtn.classList.toggle('hidden', !hasRealAvatar);
}

/**
 * حذف الصورة الحالية من مودال تعديل البروفايل - بيرجّع المعاينة لأيقونة
 * "مفيش صورة" الموحدة على طول (تفاعل فوري بدون تأكيد، بناءً على طلب
 * صريح)، ويصفّر أي صورة جديدة كانت متختارة قبل كده (editSelectedAvatarFile)
 * عشان مايتبقاش تعارض وقت الحفظ. الحذف الفعلي من قاعدة البيانات (avatar_url
 * = null) بيحصل بس لما المستخدم يضغط "حفظ التعديلات" فعليًا، شوف
 * handleEditProfileSubmit تحت
 */
function handleDeleteEditAvatar() {
    const previewImg = document.getElementById('editProfileAvatarPreview');
    if (previewImg) previewImg.src = DEFAULT_AVATAR_URI;

    editSelectedAvatarFile = null;
    editAvatarRemoved = true;

    updateEditAvatarDeleteButtonVisibility();
}

/**
 * ربط كل عناصر تحكم مودال تعديل البروفايل (فتح/إغلاق/رفع صورة/حفظ).
 * محمية بعلم editProfileEventsBound عشان الربط يحصل مرة واحدة بس
 * (initProfileUI ممكن تتنادى أكتر من مرة على مدار عمر الصفحة، زي بعد
 * تسجيل خروج ودخول تاني بحساب مختلف من غير Refresh للصفحة)
 */
function bindEditProfileEvents() {
    if (editProfileEventsBound) return;
    editProfileEventsBound = true;

    const editTriggerBtn = document.getElementById('btnEditAvatar');
    // زرار "إعدادات الحساب" في تبويب البروفايل - نفس المودال بالظبط اللي
    // بيفتحه زرار قلم الصورة (btnEditAvatar)، بس بيوفر كل بيانات الحساب
    // (مش بس الصورة) - شوف عنوان المودال "إعدادات الحساب" في index.html
    const accountSettingsBtn = document.getElementById('btnAccountSettings');
    const cancelBtn = document.getElementById('btnCancelEditProfile');
    const form = document.getElementById('editProfileForm');
    const changePasswordForm = document.getElementById('changePasswordForm');
    const uploadBtn = document.getElementById('btnEditProfileUploadAvatar');
    const deleteAvatarBtn = document.getElementById('btnEditProfileDeleteAvatar');
    const fileInput = document.getElementById('editProfileAvatarFileInput');
    const previewImg = document.getElementById('editProfileAvatarPreview');
    const btnConfirmEditAvatarCrop = document.getElementById('btnConfirmEditAvatarCrop');
    const btnCancelEditAvatarCrop = document.getElementById('btnCancelEditAvatarCrop');
    const genderMaleBtn = document.getElementById('editGenderMale');
    const genderFemaleBtn = document.getElementById('editGenderFemale');
    const backBtn = document.getElementById('btnBackFromAccountSettings');

    if (editTriggerBtn) editTriggerBtn.addEventListener('click', openAccountSettingsPage);
    if (accountSettingsBtn) accountSettingsBtn.addEventListener('click', openAccountSettingsPage);
    if (cancelBtn) cancelBtn.addEventListener('click', closeAccountSettingsPage);
    if (backBtn) backBtn.addEventListener('click', closeAccountSettingsPage);
    if (genderMaleBtn) genderMaleBtn.addEventListener('click', () => selectEditGender('male'));
    if (genderFemaleBtn) genderFemaleBtn.addEventListener('click', () => selectEditGender('female'));
    if (changePasswordForm) changePasswordForm.addEventListener('submit', handleChangePasswordSubmit);

    if (uploadBtn && fileInput) uploadBtn.addEventListener('click', () => fileInput.click());
    if (deleteAvatarBtn) deleteAvatarBtn.addEventListener('click', handleDeleteEditAvatar);
    // الضغط على الصورة نفسها بيفتح نفس نافذة اختيار الملف كمان (زي
    // نفس التجربة المستخدمة في فورم التسجيل بـ auth.js)
    if (previewImg && fileInput) previewImg.addEventListener('click', () => fileInput.click());

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                document.dispatchEvent(new CustomEvent('app:toast', {
                    detail: { message: 'من فضلك اختار ملف صورة صحيح', type: 'error' },
                }));
                fileInput.value = '';
                return;
            }

            // بدل ما نحط الصورة في المعاينة على طول، بنفتح مودال القص
            // الدائري الأول عشان المستخدم يضبط حدود الصورة قبل ما تتأكد
            // (نفس تجربة "إعداد البطل لأول مرة" وفورم التسجيل)
            openEditAvatarCropModal(file);

            // بنصفّر قيمة الـ input عشان لو المستخدم اختار نفس الملف
            // تاني بعد ما ألغى القص، حدث change يتطلق برضه
            fileInput.value = '';
        });
    }

    if (btnConfirmEditAvatarCrop) btnConfirmEditAvatarCrop.addEventListener('click', confirmEditAvatarCrop);
    if (btnCancelEditAvatarCrop) btnCancelEditAvatarCrop.addEventListener('click', () => closeEditAvatarCropModal());

    if (form) form.addEventListener('submit', handleEditProfileSubmit);
}

/**
 * ربط زرار "تسجيل خروج" في تبويب البروفايل ومودال تأكيده (logoutConfirmModal) -
 * بدل window.confirm الافتراضي بتاع المتصفح، بيفتح مودال تأكيد من نفس
 * تصميم التطبيق (زي editAvatarCropModal بالظبط)، وبس لما المستخدم يضغط
 * "تسجيل خروج" فعلياً جوه المودال بينادي signOut() المستوردة من
 * js/auth.js، اللي هي المسؤولة فعلياً عن قفل الجلسة في Supabase وإظهار
 * شاشة تسجيل الدخول تاني (شوف onAuthStateChange / showAuthModal في
 * auth.js - مفيش داعي نعمل أي حاجة تانية هنا غيرها)
 */
let logoutButtonBound = false;
function bindLogoutButton() {
    if (logoutButtonBound) return;
    logoutButtonBound = true;

    const btn = document.getElementById('btnLogout');
    const modal = document.getElementById('logoutConfirmModal');
    const cancelBtn = document.getElementById('btnCancelLogout');
    const confirmBtn = document.getElementById('btnConfirmLogout');
    if (!btn || !modal) return;

    const openLogoutConfirmModal = () => {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    };
    const closeLogoutConfirmModal = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    };

    btn.addEventListener('click', openLogoutConfirmModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeLogoutConfirmModal);
    // الضغط برّه الكارت (على الخلفية المعتمة) بيقفل المودال زي أي مودال
    // تأكيد تاني في التطبيق - بنتأكد إن الضغطة على الخلفية نفسها بس
    // (event.target === modal) مش على أي عنصر جواها
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeLogoutConfirmModal();
    });
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            closeLogoutConfirmModal();
            // مسح كاش اسم/لقب الهيدر المحلي (شوف تعليق CACHED_DISPLAY_NAME_KEY
            // فوق) - عشان جهاز مشترك ميعرضش اسم الحساب اللي عمل خروج
            // للحظة لأي حساب تاني يدخل بعده على نفس الجهاز
            clearCachedHeaderFields();
            signOut();
        });
    }
}

/** true بمجرد ما نربط زرار "المساعدة والشكاوى" مرة، لنفس سبب logoutButtonBound بالظبط */
let supportHelpButtonBound = false;

/**
 * ربط زرار "المساعدة والشكاوى" في تبويب البروفايل - بيفتح شات دعم مباشر
 * مع الأدمن على طول (نفس openSupportChatWithAdmin المستخدمة بالفعل في
 * زرار "إرسال رسالة" جوه بروفايل الأدمن العام، شوف renderPublicProfileSupportButton
 * فوق)، بدل ما يفضل زرار من غير أي وظيفة فعلية
 */
function bindSupportHelpButton() {
    if (supportHelpButtonBound) return;
    supportHelpButtonBound = true;

    const btn = document.getElementById('btnSupportHelp');
    if (!btn) return;

    btn.addEventListener('click', () => openSupportChatWithAdmin());
}

/**
 * التبديل بين حالتي تبويب "بروفايلي": #profileGuestView (كارت واحد
 * "سجّل دلوقتي" بديل كامل) لو مفيش user.id، أو #profileAccountView
 * (كل محتوى البروفايل الحقيقي - الصورة، الإحصائيات، الأوسمة، الأصدقاء،
 * إعدادات الحساب، تسجيل خروج..إلخ) لو فيه حساب فعلي مسجّل دخول.
 *
 * ملحوظة: القرار هنا مبني على وجود user.id (يعني فيه جلسة Supabase Auth
 * حقيقية) مش على window.isGuestMode - الاتنين عمليًا بيتوافقوا مع بعض
 * لأن أي حد برّه نطاق نزلة عبيد بيترفض تسجيله أصلاً (evaluateSignupLocationGate
 * في onboarding.js)، فمفيش حالة عندها user.id وفي نفس الوقت isGuestMode=true.
 *
 * @param {object|null} user
 */
function renderProfileGuestOrAccountView(user) {
    const guestView = document.getElementById('profileGuestView');
    const accountView = document.getElementById('profileAccountView');
    if (!guestView || !accountView) return;

    const isGuest = !user?.id;
    guestView.classList.toggle('hidden', !isGuest);
    accountView.classList.toggle('hidden', isGuest);
}

/** true بمجرد ما نربط زرار "سجّل دلوقتي" (#profileGuestCtaBtn) مرة، عشان منربطهوش تاني كل ما initProfileUI تتنادى */
let profileGuestCtaBound = false;

/**
 * ربط زرار "سجّل دلوقتي" في #profileGuestView - بيفتح نفس شاشة الاختيار
 * الكاملة (showAuthGate من غير باراميتر) اللي بيفتحها زرار "تسجيل الدخول"
 * في guest-banner.js بالظبط، عشان الزائر يختار بنفسه "إنشاء حساب" أو
 * "تسجيل الدخول". الأمان متأثرش: لو غريب عن البلد ضغط "إنشاء حساب"،
 * evaluateSignupLocationGate هيرفضه وقت الضغط الفعلي زي أي مكان تاني.
 */
function bindProfileGuestCta() {
    if (profileGuestCtaBound) return;
    profileGuestCtaBound = true;

    const ctaBtn = document.getElementById('profileGuestCtaBtn');
    if (!ctaBtn) return;

    ctaBtn.addEventListener('click', () => showAuthGate());
}

/**
 * ربط زر تعديل الصورة الشخصية بتفاعل بسيط (بداية فقط، لحد ما يتوفر رفع صور حقيقي)
 * تُستدعى مرة واحدة من app.js عند بداية تشغيل التطبيق
 * @param {object} user - بيانات المستخدم القادمة من js/auth.js
 */
export async function initProfileUI(user) {
    // (جديد) تبديل عرض تبويب "بروفايلي" كامل - كارت "سجّل دلوقتي" للزائر،
    // أو كل محتوى البروفايل الحقيقي لصاحب الحساب. بنعملها الأول قبل أي
    // تحميل بيانات عشان الزائر ميشوفش أي فلاش لمحتوى حساب مش بتاعه
    renderProfileGuestOrAccountView(user);
    bindProfileGuestCta();

    // بنعرض قيم افتراضية فورية الأول (من غير ما نستنى الشبكة) عشان
    // الشاشة متفضلش فاضية، وبعدين بنستبدلها بالبيانات الحقيقية أول ما
    // توصل من Supabase.
    renderProfileHeader(null, user);
    updateProfileStats();
    renderBadges();
    renderFriends();
    renderIncomingFriendRequests();

    if (user?.id) {
        await loadAndRenderRealProfile(user);
    } else {
        // (إصلاح) لما initProfileUI(null) تتنادى بعد تسجيل خروج فعلي،
        // كنا بنعرض واجهة زائر فاضية بس من غير ما نصفّر currentAuthUser/
        // currentProfileRow نفسهم - وهما بس بيتحدثوا جوه loadAndRenderRealProfile
        // اللي مش بتتنادى هنا خالص لو مفيش user. النتيجة: أي دالة حساسة
        // بترجع بعد كده (handleEditProfileSubmit، sendFriendRequest،
        // acceptFriendRequest..إلخ) كانت لسه شايفة currentAuthUser بتاع
        // آخر حساب مسجّل دخول قبل الخروج، فلو حصل استدعاء غير متوقع (أو
        // bug تاني) كانت العمليات دي بتتنفذ فعلياً باسم الحساب القديم
        // وهو المستخدم بقى "زائر" ظاهريًا بس. تصفيرهم هنا صراحة يقفل
        // الثغرة دي من جذرها، مش بس بصريًا.
        currentAuthUser = null;
        currentProfileRow = null;
        // (إصلاح - باج حقيقي) يصفّر عداد الخطوات المحلي في sensors.js وقت
        // الخروج/وضع الزائر، عشان لو حساب تاني دخل بعد كده على نفس
        // الجهاز مياخدش خطوات الحساب اللي خرج غلط (شوف syncActiveUser)
        syncActiveUser(null);
        // (إصلاح) نصفّر baseline الأوسمة كمان - لو حساب تاني دخل بعد كده
        // على نفس الجهاز، مينفعش يفضل شايف badgesLoadedOnce=true وbadgesData
        // بتاعة الحساب اللي خرج (هتتفحص واحدة صح من loadAndRenderRealProfile
        // بتاعة الحساب الجديد قبل ما أي checkAndUnlockBadges تشتغل عليه أصلاً)
        badgesData = [];
        badgesLoadedOnce = false;
    }

    // ربط مودال "تعديل البروفايل" الحقيقي (صورة + اسم + لقب) - بيستبدل
    // زرار "قريباً" القديم اللي كان مجرد Placeholder
    bindEditProfileEvents();

    // ربط زرار "تسجيل خروج" الجديد في تبويب البروفايل
    bindLogoutButton();

    // ربط أحداث النشاط (حل سؤال صح / تسجيل خطوات) الجايّة من app.js -
    // دي اللي بتحدّث النقاط والإحصائيات والستريك في Supabase (المرحلة 3)
    bindActivityEvents();

    // ربط صفحة "بروفايل عام" (زرار الرجوع + lightbox تكبير الصورة) - الصفحة
    // نفسها بتتفتح من openPublicProfile من أي مكان في التطبيق (المرحلة 5ج)
    bindPublicProfileEvents();

    // ربط صفحة "الأوسمة والشارات" الكاملة (فتح من دولاب البروفايل + زرار الرجوع)
    bindBadgesPageEvents();

    // نفس الفكرة، بس لصفحة "الأوسمة والشارات" الخاصة ببروفايل عام (مش
    // أوسمتي انا) - شوف loadAndRenderPublicProfileBadges/openPublicBadgesPage
    bindPublicBadgesPageEvents();

    // ربط صفحة "كل الأصدقاء" الكاملة (فتح من زرار "شوف كل الأصدقاء" + زرار الرجوع)
    bindFriendsListPageEvents();

    // ربط صفحة "كل طلبات الصداقة الواردة" الكاملة (فتح من زرار "شوف كل الطلبات" + زرار الرجوع)
    bindFriendRequestsListPageEvents();

    // ربط مودال تأكيد "حذف صديق" (إلغاء/تأكيد)
    bindRemoveFriendConfirmModal();

    // ربط زرار "المساعدة والشكاوى" بفتح شات دعم مباشر مع الأدمن
    bindSupportHelpButton();

    // تهيئة تبويب "لوحة الصدارة" بالبيانات الحقيقية من profiles (المرحلة 5)
    await initLeaderboardUI();
}