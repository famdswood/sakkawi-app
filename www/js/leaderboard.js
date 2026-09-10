/* ==================================================================
   سِكّاوي | js/leaderboard.js
   ------------------------------------------------------------------
   المرحلة 3: محرك التايمر التنازلي (Countdown Timer Engine) + منطق
   تبديل تبويبات البطولات (Tabs Switching Logic) لصفحة "الترتيب
   والبطولات".

   المرحلة 4 (جديد): جلب البيانات والتزامن مع Supabase مباشرة من هنا -
   تنفيذ Stored Procedure "get_leaderboard(period_type)"، رسم منصّة
   التتويج (Top 3) وباقي القائمة (4-50)، شريط "مركزك الحالي" المثبت،
   وربط كل ده بتبديل التبويبات مع حالات تحميل (Skeleton) واضحة.

   ملحوظة معمارية مهمة (اتغيّرت في المرحلة 4 بقرار صريح): الوصف القديم
   تحت كان بيقول إن js/profiles.js هو "المصدر الوحيد للحقيقة" لبيانات
   الليدربورد، وإن الملف ده مايعرفش حاجة عن Supabase خالص. من دلوقتي،
   وبناءً على طلب صريح، الملف ده (js/leaderboard.js) بقى هو المسؤول
   المباشر عن جلب ورسم بيانات الليدربورد بنفسه عن طريق get_leaderboard،
   (تحديث - إصلاح باج "الأرقام الوهمية بتظهر وترجع تاني"): النسخة القديمة
   اللي كانت موجودة في js/profiles.js (fetchLeaderboardTop /
   loadAndRenderLeaderboard / renderLeaderboardPodium /
   renderLeaderboardRemainingList / renderCurrentUserRankBanner) اتشالت
   نهائياً من هناك - مكانتش فعلاً Dead Code زي ما كان مفترض؛ كانت لسه
   بتتنادى مباشرة من flushPendingStepsBatch() (بعد كل Flush خطوات)
   ومن refreshProfileAfterDailyQuestion() (بعد كل إجابة على السؤال
   اليومي)، وبترسم فوق نفس عناصر الـ DOM (p1-name/p1-points/...
   و#leaderboardList) بأرقام all-time إجمالية (مش مقسّمة يومي/أسبوعي/
   شهري زي get_leaderboard هنا) - وده كان بالظبط سبب ظهور أرقام غلط
   لحظياً وبعدين رجوعها للصح تاني لما loadAndRenderPeriod() هنا يرسم
   فوقها من جديد. بدل الاعتماد على آلية "تسجيل Loader خارجي"
   (registerLeaderboardDataLoader، اتشالت هي كمان)، دلوقتي فيه دالة
   واحدة مُصدّرة (refreshActiveLeaderboard) أي كود خارجي محتاج "يحدّث"
   الليدربورد الظاهر بيها، وهي بتنادي loadAndRenderPeriod() بنفس الفترة
   النشطة حالياً - مفيش أي مصدر بيانات تاني يرسم على نفس العناصر دي غير
   الملف ده.

   مسؤوليات هذا الملف حصرياً دلوقتي:
     1) حساب الوقت المتبقي لكل بطولة (يومية/أسبوعية/شهرية) بدقة على
        توقيت مصر (Africa/Cairo) - بغض النظر عن التوقيت المحلي
        لجهاز المستخدم نفسه (حتى لو فاتح الموقع من بلد تاني).
     2) تحديث الأرقام على الشاشة كل ثانية بالظبط من غير أي Drift
        تراكمي (بنعيد حساب "وقت النهاية" من الصفر كل Tick بدل ما
        نعتمد على عداد بينقص، فمفيش تراكم أخطاء حتى لو الجهاز اتأخر
        شوية في تنفيذ الـ setInterval).
     3) لما التايمر يوصل للصفر، بيرجع يحسب "دورة" جديدة تلقائياً من
        غير أي كود إضافي (لأن حساب "نهاية اليوم/الأسبوع/الشهر الحالي"
        دايماً بيرجع تاريخ في المستقبل بمجرد ما اللحظة الحالية تتخطى
        النهاية القديمة) - وده اللي بيخلي loadAndRenderPeriod() تتنادى
        تلقائياً تاني لحظة بداية الدورة الجديدة.
     4) تبديل تبويبات البطولة (Active State + aria-selected) وجلب/رسم
        بيانات البطولة المختارة فوراً من Supabase (المرحلة 4).
     5) (المرحلة 5 - جديد) تشغيل حركات الدخول التدريجي (Staggered
        Entrance) على كروت باقي المتصدرين ومنصّة التتويج مع كل رسم/
        تحديث بيانات، وبناء Skeleton Loaders حقيقية بأبعاد ثابتة بدل
        نص "..." الجامد (منعاً لأي Layout Shift)، وكشف شريط "مركزك
        الحالي" فعلياً أول مرة (كان فيه كلاس "hidden" متسيب عليه من
        غير أي كود بيشيله - شوف renderLeaderboardLoadingState تحت).
     6) (المرحلة 6 - جديد: تحديث مباشر Realtime) الاشتراك في تغييرات
        جدول profiles لحظياً عن طريق Supabase Realtime (Postgres
        Changes) - أي مستخدم تاني يزيد نقاطه/خطواته على أي جهاز، كل
        الأجهزة المفتوحة على الليدربورد بتحدّث نفسها لوحدها (بعد تجميع
        Debounce قصير) من غير أي فعل يدوي من المستخدم أو تبديل تبويب -
        شوف startLeaderboardRealtimeSync/scheduleRealtimeLeaderboardRefresh
        تحت. محتاج جدول profiles يكون مفعّل عليه Realtime فعلياً من
        لوحة تحكم Supabase (Database > Replication) وإلا مفيش أي Event
        هيوصل خالص.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { restoreSession } from './auth.js';
// (جديد - كاش الأوفلاين) fetchWithCache بتنفذ نمط Stale-While-Revalidate:
// تعرض آخر نسخة محفوظة فوراً، وتحدّثها في الخلفية لو النت شغال - شوف
// js/offline-cache.js للتفاصيل الكاملة
import { fetchWithCache } from './offline-cache.js';
// أيقونة "مفيش صورة" الموحّدة المستخدمة في كل مكان تاني بالمشروع (auth.js
// وprofiles.js) - بدل الاعتماد القديم على placehold.co?text=بطل، اللي كان
// بيتكسر ويظهر "؟؟؟" لأن خدمة placehold.co مابتعرفش ترندر الحروف العربية
// جوه بارامتر text (شوف باج "اللي مش حاطين صور ظاهرين بعلامات استفهام")
import { DEFAULT_AVATAR_URI } from './profiles.js';
// نقطة "أونلاين الآن" فوق صور البروفايل في الليدربورد (بودیوم Top 3 +
// باقي القائمة) - نفس المنطق المستخدم في كل مكان تاني بالتطبيق (شوف
// الشرح الكامل عن قاعدة الأمان في js/presence.js). كانت متسابة هنا في
// نسخة الليدربورد الجديدة (get_leaderboard) بعد ما بقت هي المسؤولة عن
// الرسم بدل النسخة القديمة في profiles.js.
import { presenceDotHtml, loadAndApplyPresence } from './presence.js';

const CAIRO_TIME_ZONE = 'Africa/Cairo';

/* ------------------------------------------------------------------
   0) إعداد كل بطولة: أي زرار تبويب بيتبعلها، أي مقياس ترتيب (metric)
      بتستخدمه (بيتحكم بس في وحدة القياس المعروضة وحساب الفرق عن
      اللي فوقك في شريط "مركزك الحالي" - الترتيب الفعلي نفسه بقى
      محسوب بالكامل جوه get_leaderboard على مستوى قاعدة البيانات)،
      ونصوص العنوان/التسمية الخاصة بيها في الواجهة.
   ------------------------------------------------------------------ */
const CHAMPIONSHIP_PERIODS = Object.freeze({
    today: {
        key: 'today',
        tabId: 'filter-today',
        metric: 'points',
        countdownLabel: 'الوقت المتبقي على نهاية البطولة اليومية',
        podiumSubtitle: 'أعلى 3 أبطال دلوقتي',
        winnerTitle: 'بطل اليوم',
    },
    week: {
        key: 'week',
        tabId: 'filter-week',
        metric: 'points',
        countdownLabel: 'الوقت المتبقي على نهاية البطولة الأسبوعية',
        podiumSubtitle: 'أعلى 3 أبطال الأسبوع ده',
        winnerTitle: 'بطل الأسبوع',
    },
    month: {
        key: 'month',
        tabId: 'filter-month',
        metric: 'total_steps',
        countdownLabel: 'الوقت المتبقي على نهاية البطولة الشهرية',
        podiumSubtitle: 'أعلى 3 أبطال الشهر ده',
        winnerTitle: 'بطل الشهر',
    },
});

/** تحويل مفتاح الفترة الداخلي (today/week/month) لقيمة period_type اللي get_leaderboard() متوقعاها فعلياً في Supabase */
const PERIOD_TYPE_MAP = Object.freeze({
    today: 'daily',
    week: 'weekly',
    month: 'monthly',
});

/** الفترة النشطة حالياً - بتتحدث بس من setActivePeriod() */
let activePeriod = 'today';

/** معرّف الـ setInterval الحالي لعداد الوقت - لازم نوقفه قبل أي بداية جديدة */
let countdownIntervalId = null;

/** آخر قيمة "وقت متبقي بالثانية" شفناها - بنستخدمها بس لاكتشاف لحظة الرجوع لدورة جديدة */
let lastKnownRemainingSeconds = null;

/** علم لمنع ربط أحداث أزرار التبويبات أكتر من مرة (Memory Leak Guard) - نفس فلسفة leaderboardEventsBound في profiles.js */
let tabEventsBound = false;

/* ------------------------------------------------------------------
   (جديد - تحديث مباشر Realtime) بدل ما الليدربورد يتحدّث بس لما
   المستخدم يبدّل تبويب أو يعمل فعل شخصي (Flush خطوات/سؤال يومي)، دلوقتي
   بيعمل subscribe على تغييرات جدول profiles نفسه في Supabase (Realtime
   Postgres Changes) - أي مستخدم تاني يزيد نقاطه/خطواته في أي مكان، كل
   الأجهزة المفتوحة على صفحة الليدربورد بتحدّث نفسها لوحدها من غير
   Refresh يدوي.

   ملحوظة سيرفر مهمة (لازم تتعمل مرة واحدة من لوحة تحكم Supabase، مش من
   الكود ده): جدول profiles لازم يكون Realtime مفعّل عليه فعلياً
   (Database > Replication > حط علامة صح جنب profiles)، غير كده مفيش
   أي Event هيوصل للكود ده خالص حتى لو مفيش أي خطأ ظاهر في الـ Console.
   ------------------------------------------------------------------ */

/** الـ Channel الحالي المشترك فيه لتحديثات جدول profiles - null لو التحديث المباشر لسه مابدأش أو اتوقف */
let leaderboardRealtimeChannel = null;

/** معرّف الـ setTimeout المستخدم لتجميع (Debounce) عدة تحديثات قريبة من بعض في تحديث واحد بس */
let leaderboardRealtimeDebounceId = null;

/** علم لمنع بدء التحديث المباشر أكتر من مرة (Memory Leak Guard) - لو initChampionshipTabs اتنادت أكتر من مرة */
let realtimeSyncStarted = false;

/**
 * أقل مدة (بالمللي ثانية) بين تحديث وتحديث بسبب Realtime - مفيش داعي
 * نعيد الجلب والرسم فوراً مع كل Event لوحده (ممكن ييجوا عشرات الأحداث
 * خلال ثانية واحدة لو فيه زحمة مستخدمين بيسجّلوا خطوات في نفس اللحظة)،
 * فبنستنى شوية بعد آخر تغيير وصلنا قبل ما نجلب ونرسم مرة واحدة بس.
 */
const LEADERBOARD_REALTIME_DEBOUNCE_MS = 2500;


/* ==================================================================
   1) حساب الوقت بدقة على توقيت مصر (Africa/Cairo) - بمعزل تماماً عن
      التوقيت المحلي لجهاز/متصفح المستخدم
   ================================================================== */

/**
 * حساب فرق التوقيت (بالدقايق) بين توقيت القاهرة ولحظة UTC معينة.
 * بيستخدم Intl.DateTimeFormat (اللي بيعرف قاعدة بيانات التوقيتات
 * الرسمية IANA) عشان يطلع الفرق صح تلقائياً حتى لو مصر غيّرت قاعدة
 * التوقيت الصيفي/الشتوي في المستقبل - من غير ما نكتب أي رقم offset
 * ثابت بإيدينا (زي +2 أو +3) ممكن يبقى غلط بعد أي قرار حكومي جديد.
 * @param {Date} referenceInstant - أي لحظة UTC حقيقية نحسب عندها الفرق
 * @returns {number} الفرق بالدقايق (موجب لمصر لأنها شرق جرينتش)
 */
function getCairoOffsetMinutes(referenceInstant) {
    const parts = getCairoWallClockParts(referenceInstant);
    const asIfUTC = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute, parts.second,
    );
    return Math.round((asIfUTC - referenceInstant.getTime()) / 60000);
}

/**
 * قراءة "الوقت الحائطي" الحالي في القاهرة (سنة/شهر/يوم/ساعة/دقيقة/ثانية)
 * المقابل للحظة UTC معينة - بغض النظر عن توقيت جهاز المستخدم نفسه
 * @param {Date} referenceInstant
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
function getCairoWallClockParts(referenceInstant) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: CAIRO_TIME_ZONE,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    return formatter.formatToParts(referenceInstant).reduce((parts, part) => {
        if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
        return parts;
    }, {});
}

/**
 * تحويل "وقت حائطي" مقصود بتوقيت القاهرة (مثلاً 23:59:59.999 يوم
 * معين) إلى لحظة UTC حقيقية (Date instance) نقدر نقارنها بـ Date.now()
 * @param {number} year
 * @param {number} month - من 1 لـ 12 (مش 0-based زي JS الأصلي)
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} millisecond
 * @returns {Date}
 */
function cairoWallClockToInstant(year, month, day, hour, minute, second, millisecond = 0) {
    // بنستخدم اللحظة الحالية كمرجع لحساب فرق التوقيت (offset) - كافي
    // جداً عملياً لأن مصر معندهاش قفزات توقيت صيفي/شتوي متكررة، وحتى
    // لو حصلت، الفرق هيتحسب صح تاني أول ما اللحظة الحالية تعدّي نقطة
    // التغيير فعلياً
    const offsetMinutes = getCairoOffsetMinutes(new Date());
    const naiveUTC = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    return new Date(naiveUTC - offsetMinutes * 60000);
}

/**
 * حساب "لحظة نهاية" البطولة الحالية حسب نوعها - كلها محسوبة بتوقيت
 * القاهرة بالظبط زي المطلوب:
 *   - "today": آخر لحظة في اليوم الحالي (23:59:59.999 بتوقيت القاهرة)
 *   - "week":  آخر لحظة في يوم الأحد الجاي (23:59:59.999) - لو اليوم
 *              نفسه أحد، بترجع نهاية النهارده (نفس منطق "امتى بينتهي
 *              الأسبوع الحالي؟")
 *   - "month": آخر لحظة في آخر يوم من الشهر الحالي (23:59:59.999)
 * الدالة دي بتتنادى من الصفر كل Tick (مش بتحفظ نتيجة قديمة)، فلما
 * اللحظة الحالية تعدّي "النهاية" المحسوبة، النداء اللي بعده بيرجّع
 * نهاية الدورة الجايّة تلقائياً - وده هو سر إعادة التصفير التلقائي
 * من غير أي كود reset منفصل.
 * @param {'today'|'week'|'month'} period
 * @returns {Date}
 */
function getChampionshipEndDate(period) {
    const now = new Date();
    const nowParts = getCairoWallClockParts(now);

    if (period === 'month') {
        // Date.UTC(year, month, 0) بترجع "آخر لحظة UTC في اليوم اللي قبل
        // أول يوم من الشهر رقم month" - يعني عملياً آخر يوم في الشهر
        // الحالي (لأن nowParts.month أصلاً 1-based، فبتبقى بديل الـ
        // "الشهر الجاي" الـ 0-based المطلوب لـ Date.UTC هنا)
        const lastDayOfMonth = new Date(Date.UTC(nowParts.year, nowParts.month, 0)).getUTCDate();
        return cairoWallClockToInstant(nowParts.year, nowParts.month, lastDayOfMonth, 23, 59, 59, 999);
    }

    if (period === 'week') {
        // بنحسب "رقم يوم الأسبوع" (0 = أحد ... 6 = سبت) لتاريخ القاهرة
        // الحالي عن طريق تفسيره كتاريخ UTC مجرّد (رقم اليوم مش بيتأثر
        // بفرق التوقيت أصلاً، بس بالتاريخ نفسه)
        const dateOnlyUTC = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
        const weekday = new Date(dateOnlyUTC).getUTCDay(); // 0=أحد .. 6=سبت
        const daysUntilSunday = (7 - weekday) % 7; // لو النهاردة أحد، = 0 (تنتهي النهاردة)

        const sundayDateUTC = new Date(dateOnlyUTC + daysUntilSunday * 86400000);
        return cairoWallClockToInstant(
            sundayDateUTC.getUTCFullYear(),
            sundayDateUTC.getUTCMonth() + 1,
            sundayDateUTC.getUTCDate(),
            23, 59, 59, 999,
        );
    }

    // period === 'today' (الافتراضي)
    return cairoWallClockToInstant(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999);
}


/* ==================================================================
   2) محرك التايمر التنازلي (Countdown Engine)
   ================================================================== */

/**
 * تحديث أرقام العداد على الشاشة (ساعات:دقايق:ثواني) + كلاس "is-urgent"
 * في آخر دقيقة، واكتشاف لحظة "الدورة اتصفرت وبدأت من جديد" عشان نبلغ
 * دالة تحميل البيانات تحدّث نفسها تلقائياً (بدون ما المستخدم يعمل
 * Refresh يدوي وقت منتصف الليل/نهاية الأسبوع/الشهر بالظبط)
 * @param {'today'|'week'|'month'} period
 */
function tickCountdown(period) {
    const countdownEl = document.getElementById('champCountdown');
    const daysBoxEl = document.getElementById('champDaysBox');
    const daysSepEl = document.getElementById('champDaysSep');
    const daysEl = document.getElementById('champDays');
    const hoursEl = document.getElementById('champHours');
    const minutesEl = document.getElementById('champMinutes');
    const secondsEl = document.getElementById('champSeconds');
    if (!countdownEl || !hoursEl || !minutesEl || !secondsEl) return;

    const endDate = getChampionshipEndDate(period);
    const remainingMs = Math.max(0, endDate.getTime() - Date.now());
    const remainingSeconds = Math.floor(remainingMs / 1000);

    // من 24 ساعة لحد اللحظة دي، بنعرض "يوم" كوحدة منفصلة (بطولات
    // الأسبوعية/الشهرية غالباً) بدل ما نسيب الساعات تكبر لأرقام غريبة
    // زي "153 ساعة" - وبمجرد ما يفضل أقل من يوم، الصندوق بيختفي
    // تلقائياً ويرجع العداد لصيغة ساعات:دقايق:ثواني عادية زي اليومية
    const days = Math.floor(remainingSeconds / 86400);
    const hours = days > 0
        ? Math.floor((remainingSeconds % 86400) / 3600)
        : Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;

    if (daysEl) daysEl.textContent = String(days).padStart(2, '0');
    if (daysBoxEl) daysBoxEl.classList.toggle('hidden', days === 0);
    if (daysSepEl) daysSepEl.classList.toggle('hidden', days === 0);
    hoursEl.textContent = String(hours).padStart(2, '0');
    minutesEl.textContent = String(minutes).padStart(2, '0');
    secondsEl.textContent = String(seconds).padStart(2, '0');

    countdownEl.classList.toggle('is-urgent', remainingSeconds > 0 && remainingSeconds <= 60);

    // اكتشاف "الدورة اتصفرت وبدأت من جديد فعلياً" - بيحصل لما القيمة
    // الجديدة تقفز لأعلى بفارق كبير عن القيمة اللي قبلها مباشرة (يعني
    // إحنا عدّينا نقطة النهاية القديمة ووصلنا لبداية دورة تانية بعيدة)
    if (lastKnownRemainingSeconds !== null && remainingSeconds > lastKnownRemainingSeconds + 5) {
        loadAndRenderPeriod(period);
    }
    lastKnownRemainingSeconds = remainingSeconds;
}

/**
 * تشغيل/إعادة تشغيل عداد بطولة معينة - بيوقف أي عداد شغال قبل كده
 * أولاً (تجنّباً لتراكم أكتر من setInterval شغال في نفس الوقت، وهو
 * سبب كلاسيكي لتسريبات الذاكرة/سلوك غريب لو اتنسي التنظيف)
 * @param {'today'|'week'|'month'} period
 */
function startCountdown(period) {
    stopCountdown();

    const labelEl = document.getElementById('champCountdownLabel');
    if (labelEl) labelEl.textContent = CHAMPIONSHIP_PERIODS[period].countdownLabel;

    lastKnownRemainingSeconds = null; // تصفير مرجع اكتشاف الدورة الجديدة مع كل بداية عداد جديد
    tickCountdown(period); // أول تحديث فوري من غير ما ننتظر أول Tick بعد ثانية
    countdownIntervalId = setInterval(() => tickCountdown(period), 1000);
}

/** إيقاف عداد الوقت الحالي بأمان (بيتنادى تلقائياً قبل أي بداية جديدة، ومتاح كمان لو حبيت توقف الصفحة كلها يدوياً) */
function stopCountdown() {
    if (countdownIntervalId !== null) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
}


/* ==================================================================
   3) منطق تبديل التبويبات (Tabs Switching Logic)
   ================================================================== */

/** تحديث الشكل البصري لكل أزرار التبويبات دفعة واحدة (is-active + aria-selected) */
function updateActiveTabUI(period) {
    Object.values(CHAMPIONSHIP_PERIODS).forEach((config) => {
        const btn = document.getElementById(config.tabId);
        if (!btn) return;

        const isActive = config.key === period;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
    });
}

/** تحديث عنوان "قمّة أبطال البطولة" الفرعي (podium subtitle) بما يناسب الفترة المختارة */
function updatePodiumSubtitle(period) {
    const subtitleEl = document.getElementById('champPodiumSubtitle');
    if (subtitleEl) subtitleEl.textContent = CHAMPIONSHIP_PERIODS[period].podiumSubtitle;
}

/** تحديث لقب صاحب المركز الأول (p1-title) بما يناسب الفترة المختارة -
 *  "بطل اليوم"/"بطل الأسبوع"/"بطل الشهر" بدل نص ثابت "بطل البطولة"،
 *  عشان يوضّح أنهي بطولة بالظبط هو بطلها من غير ما نغيّر هيكل المنصة نفسه */
function updatePodiumWinnerTitle(period) {
    const titleEl = document.getElementById('p1-title');
    if (titleEl) titleEl.textContent = CHAMPIONSHIP_PERIODS[period].winnerTitle;
}

/** تبديل كلاس ثيم الألوان الخاص بفترة البطولة الحالية على الحاوية
 *  الرئيسية (يومي = تركواز، أسبوعي = الذهبي الافتراضي (بدون كلاس
 *  إضافي فعّال)، شهري = ذهبي أغمق وأغنى) - شوف قسم "9) ثيم الألوان لكل
 *  فترة بطولة" في نهاية css/leaderboard-championships.css. بيأثر بس
 *  على التابات/شريط العداد/إطار المنصة، مش على شكل الترتيب نفسه */
function updatePeriodTheme(period) {
    const container = document.getElementById('leaderboardMainContent');
    if (!container) return;
    container.classList.remove('theme-today', 'theme-week', 'theme-month');
    container.classList.add(`theme-${period}`);
}

/**
 * تفعيل فترة بطولة معينة بالكامل: تحديث الشكل البصري، تشغيل عداد
 * الوقت الخاص بيها، وجلب ورسم بياناتها الحقيقية من Supabase. دي نقطة
 * الدخول الموحّدة اللي كل تبديل تبويب (بالكليك) أو تفعيل أول تحميل
 * للصفحة بيمرّوا من خلالها.
 * @param {'today'|'week'|'month'} period
 */
function setActivePeriod(period) {
    if (!CHAMPIONSHIP_PERIODS[period]) {
        console.error(`فترة بطولة غير معروفة: ${period}`);
        return;
    }

    activePeriod = period;

    updateActiveTabUI(period);
    updatePeriodTheme(period);
    updatePodiumSubtitle(period);
    updatePodiumWinnerTitle(period);
    startCountdown(period);
    loadAndRenderPeriod(period);
}

/**
 * ربط أزرار تبويبات البطولة الثلاثة بحدث الكليك - مرة واحدة بس بفضل
 * علم tabEventsBound (نفس فلسفة leaderboardEventsBound في profiles.js)
 * عشان initChampionshipTabs() لو اتنادت أكتر من مرة (مثلاً بعد
 * تسجيل دخول جديد) ما تراكمش Listeners فوق بعضها.
 */
function bindChampionshipTabs() {
    if (tabEventsBound) return;
    tabEventsBound = true;

    Object.values(CHAMPIONSHIP_PERIODS).forEach((config) => {
        const btn = document.getElementById(config.tabId);
        if (!btn) return;

        btn.addEventListener('click', () => {
            // زرار متعطّل (disabled) بيتجاهل الكليك تلقائياً من المتصفح
            // أصلاً، لكن بنتأكد هنا كمان لأي حالة تعطيل مستقبلية عن طريق
            // كلاس بس من غير attribute حقيقي
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
            if (config.key === activePeriod) return; // نفس الفترة النشطة - مفيش داعي نكرر نفس الشغل

            setActivePeriod(config.key);
        });
    });
}

/** علم لو فيه تحديث Realtime وصل بس التبويب مش مفتوح دلوقتي - يتحدّث أول ما يفتح */
let hasPendingLeaderboardUpdate = false;

/**
 * فحص هل تبويب الليدربورد مفتوح ومرئي للمستخدم حالياً
 * @returns {boolean}
 */
function isLeaderboardTabVisible() {
    const tabEl = document.getElementById('tab-leaderboard');
    const isVisible = !!(tabEl && tabEl.classList.contains('active') && !tabEl.classList.contains('hidden'));
    return isVisible && document.visibilityState === 'visible';
}

/**
 * جدولة تحديث مُجمَّع (Debounced) للفترة النشطة حالياً بسبب Event
 * Realtime وصل من Supabase - بيلغي أي مؤقّت سابق لسه مستني وبيبدأ
 * العدّ من الصفر تاني، عشان لو وصلنا شلال Events قريبة من بعض في وقت
 * قصير (مثلاً زحمة مستخدمين بيسجّلوا خطوات في نفس اللحظة) نعمل جلب
 * ورسم واحد بس بعد ما الزحمة تهدى، مش مرة لكل Event لوحده.
 * (تحديث ذكي): لا يتم الجلب إذا كان المستخدم في تبويب آخر (الرئيسية/البروفايل)
 * لتوفير الإنترنت والبطارية، ويُحفظ كطلب معلق يتنفّذ فور دخول التبويب.
 */
function scheduleRealtimeLeaderboardRefresh() {
    if (!isLeaderboardTabVisible()) {
        hasPendingLeaderboardUpdate = true;
        return;
    }

    if (leaderboardRealtimeDebounceId) clearTimeout(leaderboardRealtimeDebounceId);

    leaderboardRealtimeDebounceId = setTimeout(() => {
        leaderboardRealtimeDebounceId = null;
        if (!isLeaderboardTabVisible()) {
            hasPendingLeaderboardUpdate = true;
            return;
        }
        refreshActiveLeaderboard();
    }, LEADERBOARD_REALTIME_DEBOUNCE_MS);
}

/**
 * بدء الاشتراك (Subscribe) في تحديثات جدول profiles اللحظية عن طريق
 * Supabase Realtime (Postgres Changes) - أي INSERT/UPDATE على الجدول
 * (يعني أي زيادة نقاط/خطوات لأي مستخدم، أو انضمام مستخدم جديد) بيجدول
 * تحديث مُجمَّع للفترة النشطة حالياً (شوف scheduleRealtimeLeaderboardRefresh).
 * ملحوظ عمداً بدون أي "event: 'DELETE'" - حذف بروفايل حالة نادرة جداً
 * ومش لازم Realtime مخصص لها.
 *
 * بتتنادى مرة واحدة بس (نفس فلسفة bindChampionshipTabs/tabEventsBound)
 * لأن initChampionshipTabs ممكن تتنادى تاني بعد أحداث "auth:login"
 * زي ما موضّح فوق - مانعايزينش نراكم أكتر من Channel مشترك في نفس
 * التغييرات فوق بعضه.
 */
function startLeaderboardRealtimeSync() {
    if (realtimeSyncStarted) return;
    realtimeSyncStarted = true;

    leaderboardRealtimeChannel = supabaseClient
        .channel('leaderboard-live-updates')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'profiles' },
            () => scheduleRealtimeLeaderboardRefresh(),
        )
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'profiles' },
            () => scheduleRealtimeLeaderboardRefresh(),
        )
        .subscribe((status, err) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                // فشل الاشتراك المباشر (مثلاً Realtime مش مفعّل على جدول
                // profiles من لوحة تحكم Supabase، أو مشكلة شبكة/WebSocket)
                // - الليدربورد بيفضل شغال عادي بردو (بيتحدّث لما المستخدم
                // يبدّل تبويب أو يعمل فعل شخصي)، بس من غير تحديث لحظي
                // لأفعال المستخدمين التانيين لحد ما الاشتراك يعيد الاتصال
                // تلقائياً أو الصفحة تتعمل لها Refresh
                console.warn('[leaderboard.js] تعذّر الاشتراك في التحديث المباشر (Realtime) لليدربورد:', status, err?.message || '');
            }
        });
}

/** إيقاف الاشتراك في التحديث المباشر وإلغاء أي تحديث مُجمَّع لسه مستني - بتتنادى من destroyChampionshipTimers */
function stopLeaderboardRealtimeSync() {
    if (leaderboardRealtimeDebounceId) {
        clearTimeout(leaderboardRealtimeDebounceId);
        leaderboardRealtimeDebounceId = null;
    }

    if (leaderboardRealtimeChannel) {
        supabaseClient.removeChannel(leaderboardRealtimeChannel);
        leaderboardRealtimeChannel = null;
    }

    realtimeSyncStarted = false;
}

/** علم لمنع تكرار طلبات التحديث اليدوي أثناء دوران الأيقونة */
let isRefreshingLeaderboard = false;

/**
 * ربط زر التحديث اليدوي لليدربورد (#leaderboardRefreshBtn)
 * يقوم بتدوير الأيقونة وعمل جلب فوري لبيانات البطولة النشطة
 */
function bindLeaderboardRefreshButton() {
    const refreshBtn = document.getElementById('leaderboardRefreshBtn');
    const refreshIcon = document.getElementById('leaderboardRefreshIcon');
    if (!refreshBtn || refreshBtn.dataset.bound === 'true') return;
    refreshBtn.dataset.bound = 'true';

    refreshBtn.addEventListener('click', async () => {
        if (isRefreshingLeaderboard) return;
        isRefreshingLeaderboard = true;
        if (refreshIcon) {
            refreshIcon.classList.add('animate-spin');
        }
        try {
            await loadAndRenderPeriod(activePeriod);
        } finally {
            setTimeout(() => {
                if (refreshIcon) {
                    refreshIcon.classList.remove('animate-spin');
                }
                isRefreshingLeaderboard = false;
            }, 600);
        }
    });
}

// استئناف أي تحديثات Realtime معلقة فور عودة المستخدم لتطبيق/تبويب الليدربورد
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isLeaderboardTabVisible() && hasPendingLeaderboardUpdate) {
            hasPendingLeaderboardUpdate = false;
            refreshActiveLeaderboard();
        }
    });
}


/* ==================================================================
   4) المرحلة 4: جلب البيانات والتزامن (Supabase Integration)
   ------------------------------------------------------------------
   كل حاجة تحت مسؤولة عن: تنفيذ get_leaderboard(period_type)، توحيد
   شكل الصفوف الراجعة، رسم منصّة التتويج + باقي القائمة + شريط "مركزك
   الحالي"، حالات التحميل (Skeleton)، وحماية من Race Conditions لو
   المستخدم بدّل تبويب بسرعة قبل ما Request قديم يخلص.
   ================================================================== */

/** أقصى عدد صفوف نعرضهم في باقي القائمة (من المركز 4 لحد الرقم ده) -
 * (تحديث: الليدربورد بقى بيوقف عند أول 10 بس - المستخدم اللي ترتيبه
 * بره العشرة دول بيشوف ترتيبه في #selfRankBar تحت بدل ما يتحطله جوه
 * القائمة نفسها، شوف renderSelfRankBar) */
const LEADERBOARD_DISPLAY_LIMIT = 10;

/**
 * قيمة limit_count اللي بنطلبها من get_leaderboard مع كل نداء - الدالة
 * نفسها بتقبل أقصى حد 200 (شوف LEAST(limit_count, 200) في تعريفها)،
 * فبنطلب أقصى قيمة مسموحة عمداً (مش الافتراضي 50) عشان نقدر نلاقي
 * ونحسب ترتيب المستخدم الحالي بدقة في شريط "مركزك الحالي" حتى لو
 * ترتيبه بره أول 50 الظاهرين في الواجهة - من غير أي Request إضافي
 * منفصل. لو ترتيبه أبعد من الرقم ده أصلاً، بنرجع لرسالة تحفيزية عامة
 * (شوف renderSelfRankBar تحت).
 */
const LEADERBOARD_RPC_FETCH_LIMIT = 200;

/** عدد كروت الـ Skeleton الوهمية اللي بتتعرض في باقي القائمة أثناء التحميل */
const LEADERBOARD_SKELETON_ROWS = 6;

/** أقصى قيمة لمتغير --stagger-index بنبعتها لكروت باقي المتصدرين (شوف .rank-card.champ-pop-in في CSS) - عشان آخر كارت في قائمة طويلة (لحد 50 عنصر) ما يستناش تأخير تراكمي كبير قبل ما يظهر */
const CHAMP_MAX_STAGGER_INDEX = 10;

/** إعدادات كل مركز في منصّة التتويج (Top 3) - نفس عناصر index.html بالظبط */
const PODIUM_SLOTS = [
    { rank: 1, nameEl: 'p1-name', userTitleEl: 'p1-user-title', pointsEl: 'p1-points', stepsEl: 'p1-steps', avatarEl: 'p1-avatar', presenceEl: 'p1-avatar-presence', fallback: 'https://placehold.co/100x100/f59e0b/ffffff?text=1' },
    { rank: 2, nameEl: 'p2-name', userTitleEl: 'p2-user-title', pointsEl: 'p2-points', stepsEl: 'p2-steps', avatarEl: 'p2-avatar', presenceEl: 'p2-avatar-presence', fallback: 'https://placehold.co/100x100/cbd5e1/334155?text=2' },
    { rank: 3, nameEl: 'p3-name', userTitleEl: 'p3-user-title', pointsEl: 'p3-points', stepsEl: 'p3-steps', avatarEl: 'p3-avatar', presenceEl: 'p3-avatar-presence', fallback: 'https://placehold.co/100x100/b45309/ffffff?text=3' },
];

/** رقم كل Request جلب بيانات (بيزيد مع كل نداء جديد) - بنستخدمه كـ Race Condition Guard: أي نتيجة راجعة بعد ما رقمها بقى قديم بننكرها (شوف loadAndRenderPeriod) */
let leaderboardFetchToken = 0;

/** آخر مصفوفة بيانات ليدربورد اتجابت فعلياً من get_leaderboard - محتفظين بيها هنا (مش بس تحطيط) عشان أي استخدام مستقبلي (مثلاً لو حبينا نضيف بحث محلي من غير Request جديد) */
let leaderboardRows = [];

/**
 * المرحلة 7: كاش خفيف لكتالوج الأوسمة (id -> {icon, title}) - نفس فكرة
 * badgesCatalogCache في profiles.js بالظبط، بس نسخة منفصلة هنا عمداً
 * (بدل ما نستورد من profiles.js) عشان نتجنب أي Circular Import ثابت -
 * الملف ده أصلاً بيتستورد جوه profiles.js (import { initChampionshipTabs,
 * registerLeaderboardDataLoader } from './leaderboard.js'). جدول badges
 * قراءة عامة (SELECT للجميع)، فمفيش مشكلة نقراه هنا مباشرة من غير RPC.
 * @type {Map<string, {icon: string, title: string}> | null}
 */
let leaderboardBadgesCatalogCache = null;
let leaderboardBadgesCatalogLoadPromise = null;

/** بترجع كاش كتالوج الأوسمة، وتجيبه من Supabase أول مرة بس */
async function ensureLeaderboardBadgesCatalogCache() {
    if (leaderboardBadgesCatalogCache) return leaderboardBadgesCatalogCache;

    if (!leaderboardBadgesCatalogLoadPromise) {
        leaderboardBadgesCatalogLoadPromise = supabaseClient
            .from('badges')
            .select('id, icon, title')
            .then(({ data, error }) => {
                if (error) {
                    console.error('خطأ في جلب كتالوج الأوسمة (ليدربورد):', error.message);
                    leaderboardBadgesCatalogCache = new Map();
                } else {
                    leaderboardBadgesCatalogCache = new Map((data || []).map((badge) => [badge.id, { icon: badge.icon, title: badge.title }]));
                }
                leaderboardBadgesCatalogLoadPromise = null;
                return leaderboardBadgesCatalogCache;
            });
    }

    return leaderboardBadgesCatalogLoadPromise;
}

/**
 * تجهيز/تحديث أيقونة "الشارة المميزة" جنب اسم صاحب مركز في الليدربورد -
 * نفس فكرة renderFeaturedBadgeInline في profiles.js بالظبط (DOM API
 * مش innerHTML، عنصر <span> واحد بس بيتحدّث مكانه، مربوط بـ
 * data-featured-badge-for بمعرف عنصر الاسم)
 * @param {HTMLElement|null} nameEl
 * @param {string|null|undefined} featuredBadgeId
 */
function renderFeaturedBadgeInline(nameEl, featuredBadgeId) {
    if (!nameEl || !nameEl.id || !nameEl.parentElement) return;

    let badgeEl = nameEl.parentElement.querySelector(`[data-featured-badge-for="${nameEl.id}"]`);
    const badge = featuredBadgeId ? leaderboardBadgesCatalogCache?.get(featuredBadgeId) : null;

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
 * تنفيذ Stored Procedure الليدربورد الحقيقي على Supabase مباشرة -
 * get_leaderboard(period_type, limit_count). طابقنا التوقيع والأعمدة
 * هنا بالظبط على التعريف الفعلي المؤكد من قاعدة البيانات:
 *   RETURNS TABLE(id uuid, full_name text, avatar_url text,
 *                 steps bigint, points bigint, rank_position bigint)
 * (جديد - لقب الشرف): زي بالظبط featured_badge_id (المرحلة 7) - عمود
 * title لازم يترجع هو كمان من get_leaderboard() نفسها في Supabase قبل
 * ما اللقب يظهر فعلياً في الواجهة (normalizeLeaderboardRow تحت جاهزة
 * ومستنية العمود ده). لازم تشغّل في SQL Editor بتاع Supabase:
 *   CREATE OR REPLACE FUNCTION get_leaderboard(period_type text, limit_count int)
 *   RETURNS TABLE(id uuid, full_name text, avatar_url text, title text,
 *                 steps bigint, points bigint, rank_position bigint,
 *                 featured_badge_id uuid) AS $$ ... $$;
 * (انسخ تعريف الدالة الحالي زي ما هو وضيف بس p.title جوه الـ SELECT
 * وجوه RETURNS TABLE في المكان المناسب - نفس ما اتعمل بالظبط مع
 * featured_badge_id قبل كده)
 * ملحوظتين مهمتين عن سلوكها الفعلي:
 *   1) الأعمدة اسمها "steps" و"rank_position" (مش total_steps/rank) -
 *      شوف normalizeLeaderboardRow() تحت اللي بتوحّدهم لأسماء موحّدة
 *      نستخدمها في باقي الملف.
 *   2) الدالة بترجع بس أعلى limit_count صف (مش كل المستخدمين) - عشان
 *      كده بنبعت LEADERBOARD_RPC_FETCH_LIMIT (200) صراحة بدل الاعتماد
 *      على الافتراضي (50)، عشان نوسّع أكتر ما يمكن مدى حساب "مركزك
 *      الحالي" في renderSelfRankBar تحت من غير Request تاني منفصل.
 *      rank_position نفسه محسوب صح عالمياً (ROW_NUMBER() على كل صفوف
 *      profiles قبل ما الـ LIMIT يتطبّق)، فمفيش مشكلة في دقة الأرقام
 *      الراجعة حتى لو مقطوعة عند 200.
 *
 * (تصحيح - كاش الأوفلاين) كانت الدالة دي بترجع [] عند فشل الـ RPC (نفس
 * سلوكها الأصلي قبل إضافة الكاش)، وده كان بيسبب باج حقيقي بعد ربطها
 * بـ fetchWithCache: أي خطأ شبكة/RPC عابر كان بيترجم لـ "نجاح فعلي
 * برجوع مصفوفة فاضية" من وجهة نظر fetchWithCache (اللي بيفرّق بس بين
 * null/undefined = فشل، وأي حاجة تانية = نجاح) - يعني الليدربورد
 * المخزّن والمعروض صح كان بيتمسح وتحل محله شاشة فاضية لمجرد خطأ شبكة
 * عابر، بدل ما يفضل زي ما هو زي فلسفة الكاش الأساسية. الدالة دي مش
 * مستخدمة في أي مكان تاني في الملف غير جوه fetchWithCache (سطر ~1108)،
 * فمفيش داعي نفصلها لنسخة "خام" منفصلة زي ما اتعمل في profiles.js -
 * بنرجّع null صراحة عند الفشل هنا مباشرة بدل [].
 * @param {'today'|'week'|'month'} periodKey
 * @returns {Promise<Array<object>|null>} null يعني فشل الجلب (خطأ شبكة/RPC)
 */
async function fetchLeaderboardData(periodKey) {
    const periodType = PERIOD_TYPE_MAP[periodKey] || PERIOD_TYPE_MAP.today;

    const { data, error } = await supabaseClient.rpc('get_leaderboard', {
        period_type: periodType,
        limit_count: LEADERBOARD_RPC_FETCH_LIMIT,
    });

    if (error) {
        console.error(`خطأ في تنفيذ get_leaderboard(period_type: '${periodType}'):`, error.message);
        return null;
    }

    return dedupeLeaderboardRowsById((data || []).map(normalizeLeaderboardRow), periodType);
}

/**
 * (جديد) حماية من باج "المستخدم بيظهر مرتين بأرقام مختلفة" اللي بيحصل
 * أحياناً (مش كل مرة) في نتيجة get_leaderboard الراجعة من قاعدة
 * البيانات - نفس id بيظهر في أكتر من صف (مثلاً مرة في المنصة بأرقام،
 * ومرة تانية في باقي القائمة بأرقام مختلفة تماماً لنفس اليوزر). ده أصله
 * سلوك غير متوقع من الـ RPC نفسها في قاعدة البيانات (Join بيتفرّع/
 * Race Condition في تحديث الإحصائيات وقت تنفيذ الاستعلام) مش حاجة نقدر
 * نصلحها من هنا فعلياً، لكن أقل حاجة نقدر نعملها في الواجهة إننا منسيبش
 * نفس الشخص يظهر مرتين بأرقام متضاربة قدام المستخدم. بنسيب أول ظهور بس
 * (الأعلى ترتيباً، لأن get_leaderboard بترجع الصفوف مرتبة تصاعدياً
 * بالفعل حسب rank_position) ونرمي أي تكرار بعده، مع تسجيل تحذير واضح
 * في الـ Console يوضح إن المشكلة الحقيقية لازم تتصلح في تعريف
 * get_leaderboard() نفسها في قاعدة البيانات.
 * @param {Array<object>} rows
 * @param {string} periodType
 * @returns {Array<object>}
 */
function dedupeLeaderboardRowsById(rows, periodType) {
    const seenIds = new Set();
    const deduped = [];

    rows.forEach((row) => {
        if (seenIds.has(row.id)) {
            console.warn(
                `[leaderboard.js] باج بيانات: المستخدم (${row.id}) ظهر أكتر من مرة بأرقام مختلفة في نتيجة get_leaderboard(period_type: '${periodType}') - اتم تجاهل التكرار وعرض أول ظهور بس. المشكلة الحقيقية لازم تتراجع في تعريف get_leaderboard() نفسها في قاعدة البيانات.`,
            );
            return;
        }
        seenIds.add(row.id);
        deduped.push(row);
    });

    return deduped;
}

/**
 * جلب العدد الحقيقي لـ"المشاركين الفعليين" (نقط/خطوات أكبر من صفر) في
 * فترة بطولة معينة، عن طريق get_leaderboard_active_count - RPC منفصلة
 * بترجع count(*) خام من غير أي LIMIT، فمظبوطة 100% مهما كبر عدد
 * المستخدمين (بعكس الاعتماد القديم على طول rows المجلوبة من
 * get_leaderboard نفسها، اللي كانت هتفضل مقفولة عند LEADERBOARD_RPC_FETCH_LIMIT
 * = 200 لو التطبيق كبر أوي - شوف sql/... اللي فيه تعريفها). لو حصل أي
 * خطأ، بنرجع null (مش صفر) عشان renderRemainingParticipantsCount تعرف
 * تفرّق بين "معرفناش نجيب الرقم" و"فعلاً محدش تاني"، فمتخفيش الجملة
 * غلط بسبب خطأ شبكة عابر.
 * @param {'today'|'week'|'month'} periodKey
 * @returns {Promise<number|null>}
 */
/**
 * جلب إجمالي عدد المستخدمين المسجلين في التطبيق كله (بغض النظر عن أي
 * نشاط في أي فترة) - مستخدم في جملة الحماس تحت القائمة (شوف
 * buildRemainingParticipantsPhrase). القرار ده بديل عن العدّ بالنشاط
 * الفعلي بس (get_leaderboard_active_count كانت هتفضل بترجع صفر/رقم صغير
 * جداً في أول أيام التطبيق - قبل ما يتجمع نشاط حقيقي كفاية)؛ استخدمنا
 * إجمالي المسجلين بدل كده عشان الجملة تظهر من أول يوم وتحفّز أي حد
 * لسه ما لعبش إنه ينزل يشارك، مش بس تعكس اللي بيلعب فعلاً دلوقتي.
 *
 * (تعديل - إصلاح باج "النص التحفيزي مش ظاهر"): كانت بتعتمد على استعلام
 * مباشر على public_profiles (view عادي فوق profiles من غير أي Bypass)،
 * وده كان بيرجع 1 بس (بروفايل المستخدم نفسه) مش الإجمالي الحقيقي، لأن
 * public_profiles بتورّث سياسات RLS بتاعة profiles حرفياً ("Users can
 * view own profile": auth.uid() = id) - فمستخدم عادي مش أدمن كان بيشوف
 * نفسه بس، فالحساب (1 - 10) بيطلع صفر/سالب والجملة بتتخفي دايماً. بقينا
 * بننادي RPC جديدة (get_total_registered_users_count، SECURITY DEFINER
 * زي get_leaderboard بالظبط) بترجع العدد الحقيقي لأي مستخدم بغض النظر
 * عن دوره - شوف تعليق SQL المطلوب تنفيذه لإنشاء الدالة دي.
 *
 * ملحوظة: fetchTotalProfilesCount في profiles.js على الأغلب فيها نفس
 * الباج بالظبط (كانت بتستخدم نفس أسلوب public_profiles القديم) - محتاجة
 * تتحدّث بنفس الطريقة لو حابب تصلحها هناك كمان.
 * @returns {Promise<number|null>} null يعني فشل الجلب (خطأ شبكة/RPC)
 */
async function fetchTotalRegisteredUsersCount() {
    const { data, error } = await supabaseClient.rpc('get_total_registered_users_count');

    if (error) {
        console.error('خطأ في حساب إجمالي عدد المستخدمين المسجلين:', error.message);
        return null;
    }

    return Number(data ?? 0);
}

/**
 * توحيد شكل أي صف راجع من get_leaderboard (steps/rank_position) لأسماء
 * موحّدة (total_steps/rank) نستخدمها في باقي الملف - Number(...) هنا
 * احتياطاً بس، لأن أعمدة bigint في Postgres ممكن يرجعها بعض عملاء
 * PostgREST كـ string لتجنب فقدان الدقة مع أرقام كبيرة جداً، وده مش
 * متوقع يحصل هنا لأرقام نقاط/خطوات عادية لكن بنتحسب له.
 * @param {{id:string, full_name:string, avatar_url:string|null, steps:number|string, points:number|string, rank_position:number|string, title?:string|null}} row
 */
function normalizeLeaderboardRow(row) {
    return {
        id: row.id,
        full_name: row.full_name || 'بطل',
        avatar_url: row.avatar_url || null,
        points: Number(row.points ?? 0),
        total_steps: Number(row.steps ?? 0),
        rank: Number(row.rank_position ?? 0),
        // (المرحلة 7) هيفضل undefined لحد ما get_leaderboard() نفسها
        // تتحدّث في Supabase عشان ترجّع العمود ده - شوف sql/phase-7-badges.sql.
        // لحد ما يحصل ده، القيمة هتبقى undefined دايماً وأيقونة الشارة
        // المميزة ببساطة مش هتظهر في الليدربورد (من غير أي خطأ)
        featured_badge_id: row.featured_badge_id ?? null,
        // (جديد - لقب الشرف في الليدربورد) نفس منطق profile.title بالظبط
        // (renderProfileHeader في profiles.js) - null يعني المستخدم لسه
        // مختارش لقب، فمش هيتعرض خالص (مش placeholder). زي featured_badge_id
        // فوق، العمود ده لازم يترجع فعلياً من get_leaderboard() في
        // Supabase الأول (شوف تعليق SQL المطلوب) وإلا هيفضل undefined
        // دايماً واللقب ببساطة مش هيظهر لحد ما يتحدث
        title: row.title || null,
    };
}

/** رجوع معرف المستخدم الحالي (لو مسجل دخول) - قراءة sync سريعة من الجلسة المحفوظة محلياً (نفس ما بيستخدمه auth.js)، من غير أي Request شبكة إضافي */
function getCurrentUserId() {
    const user = restoreSession();
    return user?.id || null;
}

/** رجوع قيمة عمود معين (points أو total_steps) من صف - بديفولت صفر لو مش موجود */
function metricValueOf(row, metric) {
    return row?.[metric] ?? 0;
}

/** وحدة القياس المعروضة في نصوص الفرق (نقطة/خطوة) حسب المقياس */
function metricUnitLabel(metric) {
    return metric === 'total_steps' ? 'خطوة' : 'نقطة';
}

/**
 * بترجع جملة "(رقم) بطل تاني داخلين في السباق على مركزك 🏆" بصيغة عربية
 * سليمة حسب قواعد عدد/معدود العربي (١ مفرد، ٢ مثنى، ٣-١٠ جمع "أبطال"،
 * ١١+ مفرد "بطل" - نفس قاعدة "أعلى 3 أبطال" المستخدمة في نص
 * podiumSubtitle فوق).
 * [تعديل - طلب صريح]: الأسلوب القديم كان "تحذير/استعجال" (بينافسوك
 * عليها 🔥)، واتغيّر لأسلوب "إحصائية فخمة" بيوصف حجم السباق نفسه بدل ما
 * يحذّر المستخدم - نفس الفكرة بس نبرة أرقى تناسب شكل الـ chip الجديد.
 * الدالة دي بترجع الجملة كاملة جاهزة للعرض، أو null لو count <= 0 (يبقى
 * المفروض العنصر يتخفي تمامًا مش يتحط له نص فاضي)
 * @param {number} count - عدد "الأبطال" (المشاركين الفعليين) بره أول 10
 * @returns {string|null}
 */
function buildRemainingParticipantsPhrase(count) {
    if (!count || count <= 0) return null;
    if (count === 1) return 'و بطل واحد تاني داخل في السباق على مركزك 🏆';
    if (count === 2) return 'و بطلين تانيين داخلين في السباق على مركزك 🏆';
    if (count <= 10) return `و ${count} أبطال تانيين داخلين في السباق على مركزك 🏆`;
    return `و ${count} بطل تاني داخلين في السباق على مركزك 🏆`;
}

/**
 * تحديث جملة الحماس "و (رقم) بطل كمان بينافسوك عليها" تحت القائمة -
 * الرقم إجمالي المستخدمين المسجلين في التطبيق (شوف
 * fetchTotalRegisteredUsersCount) - مش مربوط بفترة بطولة معينة، فبيفضل
 * نفس القيمة في التبويبات التلاتة (يومي/أسبوعي/شهري).
 * @param {number|null} totalUsersCount - null يعني حصل خطأ في جلب
 * الرقم (شبكة/RPC) - في الحالة دي بنسيب الجملة زي ما هي (مخفية
 * افتراضياً من renderLeaderboardLoadingState) بدل ما نفترض صفر غلط
 */
function renderRemainingParticipantsCount(totalUsersCount) {
    const el = document.getElementById('leaderboardParticipantsCount');
    if (!el) return;

    if (totalUsersCount === null) return; // فشل الجلب - سيبها مخفية زي ما هي، متفترضش صفر

    const remainingCount = Math.max(0, totalUsersCount - LEADERBOARD_DISPLAY_LIMIT);
    const phrase = buildRemainingParticipantsPhrase(remainingCount);

    if (!phrase) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }

    el.textContent = phrase;
    el.classList.remove('hidden');
}

/** تنسيق رقم كبير بصيغة مختصرة ("12.4K"/"1.2M" بدل "12400"/"1200000") - نفس منطق formatCompactNumber المستخدم في باقي الملفات */
function formatCompactNumber(num) {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
}

/** إخراج آمن (HTML-escaped) لأي نص هيتحط جوه template string - مفيدة قبل عرض full_name/title جوه innerHTML */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/**
 * (المرحلة 7) بترجع HTML جاهز لأيقونة الشارة المميزة (أو نص فاضي لو
 * مفيش شارة/الكاش لسه مش جاهز) - تُستخدم جوه template باقي القائمة
 * (renderLeaderboardRemainingList) اللي بتتبني بالكامل بـ innerHTML مع
 * كل رسم، بعكس منصّة التتويج (عناصر ثابتة بتتحدّث في مكانها)
 * @param {string|null|undefined} featuredBadgeId
 * @returns {string}
 */
function featuredBadgeIconHtml(featuredBadgeId) {
    const badge = featuredBadgeId ? leaderboardBadgesCatalogCache?.get(featuredBadgeId) : null;
    if (!badge) return '';
    return `<span class="featured-badge-icon" title="${escapeHtml(badge.title)}" style="margin-inline-start:0.25rem;">${escapeHtml(badge.icon)}</span>`;
}

/** تحديث نص عنصر بمعرفه (id) لو موجود فعلاً في الصفحة - اختصار بسيط بيتكرر استخدامه كتير تحت */
function setElementText(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text;
}

/**
 * (المرحلة 5) إعادة تشغيل حركة الدخول (.champ-pop-in من CSS) على عنصر
 * ثابت في الصفحة زي كروت منصّة التتويج - العناصر دي (بعكس كروت باقي
 * القائمة) بتتحدّث في مكانها بنفس الـ DOM node مع كل تبديل تبويب، مش
 * بتتحذف وتتعاد، فمجرد إضافة الكلاس مرة واحدة من الأول مش كفاية عشان
 * الـ Animation يشتغل تاني. الحل القياسي: نشيل الكلاس، نجبر Reflow
 * بقراءة offsetWidth (المتصفح لازم "ينسى" إن الكلاس كان متحط قبل كده)،
 * وبعدين نرجّع الكلاس تاني عشان الحركة تبدأ من الصفر.
 * @param {HTMLElement|null} el
 */
function replayEntranceAnimation(el) {
    if (!el) return;
    el.classList.remove('champ-pop-in');
    void el.offsetWidth; // إجبار Reflow - سطر ضروري، متسيبوش
    el.classList.add('champ-pop-in');
}

/**
 * فتح البروفايل العام لصاحب صف معين بالضغط عليه - بنستورد
 * openPublicProfile من profiles.js بشكل ديناميكي (import() بدل import
 * ثابت فوق الملف) عمداً، بنفس أسلوب استيراد notifications.js الموجود
 * جوه profiles.js نفسه، عشان نتجنب أي Circular Import ثابت بين
 * leaderboard.js وprofiles.js (هي أصلاً بتعمل import ثابت من الملف ده).
 * @param {string} userId
 */
async function openLeaderboardUserProfile(userId) {
    if (!userId) return;
    try {
        const { openPublicProfile } = await import('./profiles.js');
        if (typeof openPublicProfile === 'function') await openPublicProfile(userId);
    } catch (err) {
        console.error('تعذر فتح البروفايل العام من لوحة الصدارة:', err);
    }
}

/**
 * رسم منصّة التتويج (المراكز 1، 2، 3) بالبيانات الحقيقية الراجعة من
 * get_leaderboard. كل صف بييجي معاه points وtotal_steps سوا دايماً،
 * فبنعرض الاتنين في الـ Dual-Stat Badge بغض النظر عن أي المقياسين هو
 * الأساس في ترتيب البطولة الحالية.
 * (تحديث - إصلاح باج "هبهبة سريعة عند فتح الليدربورد/تبديل البطولات"):
 * الدالة بقت بتاخد shouldAnimate - لما loadAndRenderPeriod ترسم مرتين
 * في نفس دورة التحميل (مرة بالكاش المحلي فوراً، ومرة تانية برد الشبكة
 * الحقيقي لما يوصل بعد كده - شوف fetchWithCache)، كانت replayEntranceAnimation
 * بتتنفذ في المرتين، يعني حركة الدخول (champFadeInUp) بتشتغل تاني من
 * الصفر خلال أجزاء من الثانية بعد أول ظهور - وده بالظبط اللي بيبان
 * كـ"هبهبة" سريعة قبل ما تستقر. دلوقتي بنشغّل الحركة أول مرة بس في كل
 * دورة تحميل (أول رسم فعلي بعد الـ Skeleton)، والرسم اللي بعده في نفس
 * الدورة (تحديث بالبيانات الحقيقية) بيحدّث القيم في مكانها من غير ما
 * يعيد تشغيل الحركة.
 * @param {Array<object>} rows
 * @param {boolean} [shouldAnimate=true]
 */
function renderLeaderboardPodium(rows, shouldAnimate = true) {
    const podiumUserIds = [];
    const currentUserId = getCurrentUserId();

    PODIUM_SLOTS.forEach((slot, index) => {
        const row = rows[slot.rank - 1] || null;
        const nameEl = document.getElementById(slot.nameEl);
        const userTitleEl = document.getElementById(slot.userTitleEl);
        const pointsEl = document.getElementById(slot.pointsEl);
        const stepsEl = document.getElementById(slot.stepsEl);
        const avatarEl = document.getElementById(slot.avatarEl);
        const presenceEl = document.getElementById(slot.presenceEl);
        const cardEl = document.querySelector(`.podium-card[data-rank="${slot.rank}"]`);
        // (جديد) لو صاحب المركز ده هو المستخدم الحالي نفسه - كان قبل
        // كده مفيش أي إشارة "أنت" على الإطلاق لو ترتيبك جوه أعلى 3 (بعكس
        // باقي القائمة اللي فيها .rank-card-self + "(أنت)")، فكان حرفياً
        // ترتيبك مش ظاهر إنه بتاعك في الحالة دي. شوف podium-card-self في
        // CSS للـ ring الذهبي المميز حوالين الصورة
        const isCurrentUser = Boolean(row?.id && currentUserId && row.id === currentUserId);

        // (المرحلة 5) إزالة حالة الـ Skeleton أولاً - لو لسه متحطة من
        // renderLeaderboardLoadingState - قبل ما نرسم القيم الحقيقية،
        // عشان النص/الإحصائيات الحقيقية تبان فوراً بدل ما تفضل مخفية
        // وراء ستايل الـ Skeleton سهواً
        [nameEl, pointsEl, stepsEl].forEach((el) => el?.classList.remove('champ-skel'));

        if (nameEl) nameEl.textContent = row ? `${row.full_name}${isCurrentUser ? ' (أنت)' : ''}` : '—';
        // (جديد - لقب الشرف): نفس فلسفة renderProfileHeader/renderPublicProfile
        // بالظبط - بيتعرض بس لو صاحب المركز فعلاً مختار لقب (row.title)،
        // وبيتخفي تماماً (مش نص بديل) لو لأ - مفيش أي "زحمة" لمين معندوش لقب
        if (userTitleEl) {
            if (row?.title) {
                userTitleEl.textContent = row.title;
                userTitleEl.classList.remove('hidden');
            } else {
                userTitleEl.textContent = '';
                userTitleEl.classList.add('hidden');
            }
        }
        if (pointsEl) pointsEl.textContent = row ? formatCompactNumber(row.points) : '—';
        if (stepsEl) stepsEl.textContent = row ? formatCompactNumber(row.total_steps) : '—';
        if (avatarEl) avatarEl.src = row?.avatar_url || slot.fallback;

        // نقطة "أونلاين الآن" لصاحب المركز ده - شوف js/presence.js. لو
        // مفيش صف أصلاً في المركز ده بنشيل الـ data attribute عشان
        // النقطة تفضل مخفية (مش هتتفعّل لأي id قديم متسيب من رسمة فاتت)
        if (presenceEl) {
            if (row?.id) {
                presenceEl.setAttribute('data-presence-avatar', row.id);
                podiumUserIds.push(row.id);
            } else {
                presenceEl.removeAttribute('data-presence-avatar');
                presenceEl.classList.remove('is-online');
            }
        }

        // (المرحلة 7) أيقونة الشارة المميزة جنب اسم صاحب المركز
        ensureLeaderboardBadgesCatalogCache().then(() => {
            renderFeaturedBadgeInline(nameEl, row?.featured_badge_id);
        });

        // الضغط على صورة أو اسم صاحب المركز (1، 2، أو 3) بيفتح بروفايله
        // العام - بنعيد تعيين onclick في كل رسم (بدل addEventListener)
        // عشان العناصر دي ثابتة في الصفحة وما بتتحذفش، فمش عايزين نراكم
        // نفس الـ Listener مرات كتير مع كل تحميل جديد للّيدربورد
        [nameEl, avatarEl].forEach((el) => {
            if (!el) return;
            el.onclick = row ? () => openLeaderboardUserProfile(row.id) : null;
            el.classList.toggle('cursor-pointer', Boolean(row));
        });

        // (المرحلة 5) دخول تدريجي متتالي (Staggered Entrance) - كل كارت
        // بيدخل بعد اللي قبله بفارق بسيط (شوف --stagger-index في CSS).
        // بنعيد تشغيلها مع كل تحديث بيانات (مش بس أول تحميل) عشان تبديل
        // التبويبات يحس بحركة حيّة بدل ما البيانات الجديدة تقفز فجأة
        if (cardEl) {
            cardEl.style.setProperty('--stagger-index', String(index));
            cardEl.classList.toggle('podium-card-self', isCurrentUser);
            if (shouldAnimate) replayEntranceAnimation(cardEl);
        }
    });

    if (podiumUserIds.length > 0) loadAndApplyPresence(podiumUserIds);
}

/**
 * رسم باقي القائمة (المراكز من 4 لحد LEADERBOARD_DISPLAY_LIMIT) وإبراز
 * صف المستخدم الحالي لو موجود ضمنهم - كروت زجاجية (.rank-card) بشريط
 * إحصائيات مزدوج (خطوات + نقاط سوا).
 * (تحديث - إصلاح باج "هبهبة سريعة عند فتح الليدربورد/تبديل البطولات"):
 * الدالة بقت بتاخد shouldAnimate بنفس فلسفة renderLeaderboardPodium فوق -
 * القائمة دي بتتحذف وتتعاد بالكامل (innerHTML) مع كل رسم، فلو الرسمتين
 * (كاش محلي فوري + رد شبكة حقيقي بعد كده) ضافوا كلاس champ-pop-in
 * الاتنين، الحركة كانت بتشتغل مرتين خلال أجزاء من الثانية - نفس سبب
 * الـ"هبهبة". دلوقتي كلاس champ-pop-in (وبالتالي حركة الدخول) بيتضاف
 * بس لما shouldAnimate = true (أول رسم فعلي في دورة التحميل)؛ الرسم
 * التاني في نفس الدورة بيحدّث الكروت من غير ما يعيد الحركة.
 * @param {Array<object>} rows
 * @param {boolean} [shouldAnimate=true]
 */
function renderLeaderboardRemainingList(rows, shouldAnimate = true) {
    const list = document.getElementById('leaderboardList');
    if (!list) return;

    const remaining = rows.slice(3, LEADERBOARD_DISPLAY_LIMIT);
    const currentUserId = getCurrentUserId();

    if (remaining.length === 0) {
        // (تعديل - المرحلة 4): #leaderboardList بقى grid بعمودين على تابلت
        // (index.html) - من غير col-span-full كانت الرسالة هتاخد نص العرض
        // بس وتبان مش متمركزة صح على شاشة واسعة
        list.innerHTML = `
            <p class="col-span-full text-xs text-lux-500 font-medium text-center py-6">
                لسه مفيش متسابقين تانيين في البطولة دي
            </p>
        `;
        return;
    }

    list.innerHTML = remaining.map((row, index) => {
        const isCurrentUser = Boolean(currentUserId && row.id === currentUserId);
        // (المرحلة 5) --stagger-index بيتحدد Inline لكل كارت هنا - كروت
        // القائمة دي بتتحذف وتتعاد بالكامل مع كل رسم (innerHTML)، فمجرد
        // ما العنصر الجديد يتضاف للـ DOM، الحركة (.champ-pop-in في CSS)
        // بتشتغل تلقائياً من غير أي Reflow-Trick زي منصّة التتويج فوق
        const staggerIndex = Math.min(index, CHAMP_MAX_STAGGER_INDEX);
        const popInClass = shouldAnimate ? ' champ-pop-in' : '';

        return `
            <article class="rank-card${popInClass}${isCurrentUser ? ' rank-card-self' : ''}" data-leaderboard-user-id="${row.id}" style="--stagger-index:${staggerIndex}">
                <span class="rank-card-number">${row.rank}</span>
                <span class="relative inline-block shrink-0">
                    <img src="${row.avatar_url || DEFAULT_AVATAR_URI}" alt="${escapeHtml(row.full_name)}"
                         class="rank-card-avatar"
                         onerror="this.onerror=null;this.src='${DEFAULT_AVATAR_URI}'">
                    ${presenceDotHtml(row.id)}
                </span>
                <div class="rank-card-info">
                    <h5 class="rank-card-name">${escapeHtml(row.full_name)}${isCurrentUser ? ' (أنت)' : ''}${featuredBadgeIconHtml(row.featured_badge_id)}</h5>
                    ${row.title ? `<span class="rank-card-title">${escapeHtml(row.title)}</span>` : ''}
                    <div class="dual-stat-badge dual-stat-badge-compact">
                        <span class="dual-stat-item" title="عدد الخطوات">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>
                            <span>${formatCompactNumber(row.total_steps)}</span>
                        </span>
                        <span class="dual-stat-divider" aria-hidden="true"></span>
                        <span class="dual-stat-item" title="النقاط">
                            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.9-6.2 3.9 1.6-7L2 9.2l7.1-.6z"/></svg>
                            <span>${row.points.toLocaleString()}</span>
                        </span>
                    </div>
                </div>
            </article>
        `;
    }).join('');

    list.querySelectorAll('[data-leaderboard-user-id]').forEach((rowEl) => {
        rowEl.addEventListener('click', () => openLeaderboardUserProfile(rowEl.dataset.leaderboardUserId));
    });

    loadAndApplyPresence(remaining.map((row) => row.id));
}

/**
 * تحديث شريط "مركزك الحالي" المثبت (#selfRankBar) بالترتيب والصورة
 * والإحصائيات المزدوجة (خطوات + نقاط) والفرق الحقيقي عن اللي فوقه
 * مباشرة في الترتيب. بما إن rows هنا (حسب الفرض المعماري في
 * fetchLeaderboardData) بترجع كل المستخدمين مش بس أعلى 50، فالحساب
 * دقيق دايماً حتى لو ترتيب المستخدم الحالي بره أعلى 10 الظاهرين في
 * الواجهة.
 *
 * (تحديث - طلب صريح): الشريط ده كان متسكّر تماماً (`display: none
 * !important` في leaderboard-championships.css) من قبل عشان كان بياخد
 * مساحة محسوسة ومشتّت أثناء التصفح. دلوقتي رجّعناه، لكن **بس** لما
 * ترتيب المستخدم يبقى بره أول 10 الظاهرين في الليدربورد نفسه (اللي
 * جواه أصلاً صفه بيتحدد بـ .rank-card-self، فمفيش داعي شريط سفلي زيادة
 * يكرر نفس المعلومة). النص بقى "ترتيبك (٣٧)" بدل الرقم والتسمية
 * المنفصلين "مركزك" - شوف #currentUserRankNumber في index.html.
 * @param {Array<object>} rows
 * @param {'points'|'total_steps'} metric
 */
function renderSelfRankBar(rows, metric) {
    const rankNumberEl = document.getElementById('currentUserRankNumber');
    const gapTextEl = document.getElementById('currentUserRankPercentText');
    const pointsEl = document.getElementById('currentUserRankPointsBadge');
    const stepsEl = document.getElementById('selfRankSteps');
    const avatarEl = document.getElementById('selfRankAvatar');
    const barEl = document.getElementById('selfRankBar');

    const currentUserId = getCurrentUserId();
    const myRow = currentUserId ? rows.find((row) => row.id === currentUserId) : null;

    // الشريط بيظهر بس لو المستخدم مسجّل دخول، ترتيبه معروف فعلاً، وبره
    // أول LEADERBOARD_DISPLAY_LIMIT الظاهرين في القائمة - غير كده بيفضل
    // مخفي (صفه ظاهر أصلاً جوه القائمة نفسها لو ضمن أول 10)
    const shouldShowBar = Boolean(myRow && myRow.rank > LEADERBOARD_DISPLAY_LIMIT);
    if (barEl) barEl.classList.toggle('hidden', !shouldShowBar);

    if (!shouldShowBar) return;

    if (avatarEl && myRow.avatar_url) avatarEl.src = myRow.avatar_url;
    if (rankNumberEl) rankNumberEl.textContent = `ترتيبك (${myRow.rank.toLocaleString()})`;
    if (pointsEl) pointsEl.textContent = myRow.points.toLocaleString();
    if (stepsEl) stepsEl.textContent = formatCompactNumber(myRow.total_steps);

    if (gapTextEl) {
        // اللي فوق المستخدم الحالي مباشرة - بنلاقيه بالـ rank نفسه
        // (مش بالـ index) عشان نفضل مظبوطين حتى لو فيه أي فجوة غير
        // متوقعة في الأرقام الراجعة من الـ RPC
        const aboveRow = rows.find((row) => row.rank === myRow.rank - 1);

        if (aboveRow) {
            const gapValue = Math.max(0, metricValueOf(aboveRow, metric) - metricValueOf(myRow, metric));
            const unit = metricUnitLabel(metric);
            const rivalName = aboveRow.full_name ? aboveRow.full_name.trim().split(' ')[0] : `المركز ${aboveRow.rank}`;
            gapTextEl.textContent = gapValue > 0
                ? `فاضلك ${gapValue.toLocaleString()} ${unit} وتسبق ${rivalName} (مركز ${aboveRow.rank})! 🔥`
                : `متساوي مع ${rivalName}! أي ${unit} زيادة هتخليك تسبقه! 🔥`;
        } else {
            gapTextEl.textContent = 'كمّل نشاطك عشان تتقدم في الترتيب!';
        }
    }

    if (barEl) barEl.classList.remove('is-topper');
}

/**
 * عرض حالة تحميل (Skeleton) في منصّة التتويج، باقي القائمة، وشريط
 * "مركزك الحالي" فوراً وقت بداية أي Request جديد - عشان مفيش أي قفزة
 * بصرية أو ظهور مفاجئ لبيانات فاضية/قديمة أثناء انتظار الرد من Supabase.
 */
function renderLeaderboardLoadingState() {
    lastRenderedLeaderboardSignature = null;
    const podium = document.getElementById('podiumContainer');
    if (podium) podium.classList.add('animate-pulse', 'opacity-60', 'pointer-events-none');

    // (المرحلة 5) Skeleton حقيقي بأبعاد ثابتة (كلاس champ-skel في CSS)
    // بدل نص "..." الجامد القديم - بيمنع أي قفزة بصرية (Layout Shift)
    // لما البيانات الحقيقية توصل، لأن أبعاد الشريط الرمادي قريبة جداً
    // من أبعاد النص الحقيقي اللي هيحل محله. المسافة الغير منقسمة
    // (NBSP) بدل نص فاضي تماماً عشان ارتفاع السطر يفضل ثابت حتى لو
    // المتصفح تجاهل أبعاد champ-skel لأي سبب
    PODIUM_SLOTS.forEach((slot) => {
        [slot.nameEl, slot.pointsEl, slot.stepsEl].forEach((elementId) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            el.textContent = '\u00A0';
            el.classList.add('champ-skel');
        });
    });

    const list = document.getElementById('leaderboardList');
    if (list) {
        list.innerHTML = Array.from({ length: LEADERBOARD_SKELETON_ROWS }).map(() => `
            <div class="rank-card" aria-hidden="true">
                <span class="w-5 h-3 rounded bg-white/10 animate-pulse inline-block flex-shrink-0"></span>
                <span class="w-10 h-10 rounded-full bg-white/10 animate-pulse inline-block flex-shrink-0"></span>
                <div class="flex-1 min-w-0 flex flex-col gap-2">
                    <span class="block w-24 h-3 rounded bg-white/10 animate-pulse"></span>
                    <span class="block w-32 h-3 rounded bg-white/5 animate-pulse"></span>
                </div>
            </div>
        `).join('');
    }

    setElementText('currentUserRankNumber', '—');
    setElementText('selfRankSteps', '—');
    setElementText('currentUserRankPointsBadge', '—');
    setElementText('currentUserRankPercentText', 'بنجيب بيانات ترتيبك...');

    const participantsCountEl = document.getElementById('leaderboardParticipantsCount');
    if (participantsCountEl) participantsCountEl.classList.add('hidden');

    const barEl = document.getElementById('selfRankBar');
    if (barEl) barEl.classList.add('animate-pulse');
}

/** إزالة كلاسات حالة التحميل (Skeleton) بعد وصول البيانات الحقيقية ورسمها */
function clearLeaderboardLoadingState() {
    const podium = document.getElementById('podiumContainer');
    if (podium) {
        podium.classList.remove('animate-pulse', 'opacity-60', 'pointer-events-none');
        // شبكة أمان إضافية (المرحلة 5) - renderLeaderboardPodium() بتشيل
        // champ-skel بنفسها أصلاً من كل عنصر بترسمه، لكن بنتأكد هنا كمان
        // من غير أي استثناء لو حصل خطأ غير متوقع في الرسم
        podium.querySelectorAll('.champ-skel').forEach((el) => el.classList.remove('champ-skel'));
    }

    const barEl = document.getElementById('selfRankBar');
    if (barEl) barEl.classList.remove('animate-pulse');
}

/**
 * نقطة الدخول الموحّدة لجلب ورسم بيانات فترة بطولة معينة بالكامل -
 * بتتنادى من setActivePeriod() (تبديل تبويب يدوي) ومن tickCountdown()
 * (لما دورة البطولة تتصفر تلقائياً في منتصف الليل/نهاية الأسبوع أو
 * الشهر). فيها حماية من Race Conditions عن طريق leaderboardFetchToken:
 * لو المستخدم بدّل تبويب تاني بسرعة قبل ما Request قديم يخلص، بنتجاهل
 * نتيجته لما توصل متأخرة عشان بيانات بطولة غلط ماتظهرش فوق تبويب جديد.
 * @param {'today'|'week'|'month'} periodKey
 */
async function loadAndRenderPeriod(periodKey) {
    const config = CHAMPIONSHIP_PERIODS[periodKey];
    if (!config) return;

    const requestToken = ++leaderboardFetchToken;

    // بنعرض حالة التحميل (Skeleton) فوراً زي الأول - لو فيه كاش
    // محفوظ، قراءته من IndexedDB هتوصل بعد أجزاء من الثانية وهتستبدل
    // الـ Skeleton ده على طول (شوف renderLeaderboardResult تحت)، فمش
    // هيبان فعلياً كـ "Flash" ملحوظ للمستخدم. لو مفيش كاش خالص (أول
    // فتح للتطبيق على الجهاز ده)، دي هي الحالة اللي محتاجينها أصلاً
    // لحد ما رد الشبكة يوصل.
    renderLeaderboardLoadingState();

    // (جديد - كاش الأوفلاين) دالة الرسم بقت مفصولة في renderLeaderboardResult
    // تحت عشان تتنادى مرتين محتمل: مرة فورية بالنسخة المخزّنة محلياً
    // (لو موجودة، وده اللي بيحصل جوه fetchWithCache نفسها)، ومرة تانية
    // لما رد الشبكة الحقيقي يوصل. Request Token بيتفحص جوه الدالة دي
    // نفسها في الحالتين عشان لو المستخدم بدّل تبويب في الوقت ده، مفيش
    // رسم قديم متأخر يظهر فوق التبويب الجديد.
    let hasRenderedRows = false;
    // (تحديث - إصلاح باج "هبهبة سريعة عند فتح الليدربورد/تبديل البطولات"):
    // fetchWithCache ممكن ينادي الـ callback ده مرتين في نفس دورة التحميل
    // دي - مرة فورية بالنسخة المخزّنة محلياً (لو موجودة)، ومرة تانية برد
    // الشبكة الحقيقي لما يوصل بعد كده. لو الاتنين شغّلوا حركة الدخول
    // (champFadeInUp/champ-pop-in) من الصفر، كانت الحركة بتتكرر خلال
    // أجزاء من الثانية - وده أصل الـ"هبهبة" اللي بتحصل بسرعة وبعدين
    // تستقر. بنشغّل الحركة أول مرة بس (hasAnimatedThisCycle لسه false)،
    // وأي رسم تاني بعد كده في نفس الدورة بيحدّث القيم من غير ما يعيد
    // الحركة تاني.
    let hasAnimatedThisCycle = false;

    await Promise.all([
        fetchWithCache(
            `cached_leaderboard:${periodKey}`,
            () => fetchLeaderboardData(periodKey),
            (rows, _source) => {
                if (requestToken !== leaderboardFetchToken) return;
                hasRenderedRows = true;
                renderLeaderboardResult(rows, config, !hasAnimatedThisCycle);
                hasAnimatedThisCycle = true;
            },
        ),
        fetchWithCache(
            'cached_total_registered_users',
            () => fetchTotalRegisteredUsersCount(),
            (totalUsersCount) => {
                if (requestToken !== leaderboardFetchToken) return;
                renderRemainingParticipantsCount(totalUsersCount);
            },
        ),
        // (المرحلة 7) كتالوج الأوسمة - نفس منطقه القديم زي ما هو، مش
        // جزء من كاش الأوفلاين الجديد (كاش داخلي خاص بيه أصلاً)
        ensureLeaderboardBadgesCatalogCache(),
    ]);

    // لو مفيش ولا كاش ولا رد شبكة نجح خالص (أول فتح للتطبيق من غير نت
    // ومن غير أي كاش سابق على الجهاز ده) - نفضّي حالة التحميل بدل ما
    // تفضل شغالة للأبد (Skeleton معلّق من غير أي محتوى ولا رسالة خطأ)
    if (requestToken === leaderboardFetchToken && !hasRenderedRows) {
        clearLeaderboardLoadingState();
    }
}

/** آخر توقيع (Signature) لقائمة الليدربورد المرئية - لمنع وميض الشاشة وإعادة بناء الـ DOM إذا لم تتغير البيانات */
let lastRenderedLeaderboardSignature = null;

/**
 * حساب توقيع رقمي للمراكز المرئية ومركز المستخدم الحالي
 * @param {Array<object>} rows
 * @param {string} periodKey
 * @returns {string}
 */
function computeLeaderboardSignature(rows, periodKey) {
    if (!rows || rows.length === 0) return `${periodKey}:empty`;
    const currentUserId = getCurrentUserId();
    const visibleRows = rows.slice(0, LEADERBOARD_DISPLAY_LIMIT);
    const myRow = currentUserId ? rows.find((r) => r.id === currentUserId) : null;

    const visibleSig = visibleRows.map((r) => `${r.id}:${r.rank}:${r.points}:${r.total_steps}:${r.featured_badge_id || ''}:${r.title || ''}`).join('|');
    const myRowSig = myRow ? `${myRow.id}:${myRow.rank}:${myRow.points}:${myRow.total_steps}` : 'none';

    return `${periodKey}#${visibleSig}#${myRowSig}`;
}

/**
 * (جديد - كاش الأوفلاين) رسم نتيجة فترة بطولة معينة - مفصولة عن
 * loadAndRenderPeriod عشان تتنادى مرتين: مرة بالداتا المخزّنة محلياً
 * (فوراً)، ومرة بالداتا الحقيقية الجديدة من الشبكة لما توصل.
 * (تحديث - إصلاح باج "هبهبة سريعة عند فتح الليدربورد/تبديل البطولات"):
 * بقت بتاخد shouldAnimate كمان وبتمررها لـrenderLeaderboardPodium
 * وrenderLeaderboardRemainingList - شوف التعليق فوق كل واحدة منهم
 * للتفاصيل الكاملة عن سبب الباج والحل.
 * (تحديث جديد - فحص التوقيع Signature Diffing): إذا كان الاستدعاء من الخلفية/Realtime
 * والبيانات لم تتغير إطلاقاً، يتم تفادي مسح وإعادة بناء الـ DOM تماماً لمنع القفز والوميض.
 * @param {Array<object>} rows
 * @param {{metric: string, key: string}} config - إعدادات الفترة النشطة (CHAMPIONSHIP_PERIODS[periodKey])
 * @param {boolean} [shouldAnimate=true]
 */
function renderLeaderboardResult(rows, config, shouldAnimate = true) {
    const currentSignature = computeLeaderboardSignature(rows, config.key);
    if (!shouldAnimate && lastRenderedLeaderboardSignature === currentSignature) {
        clearLeaderboardLoadingState();
        return;
    }
    lastRenderedLeaderboardSignature = currentSignature;
    leaderboardRows = rows;

    clearLeaderboardLoadingState();
    renderLeaderboardPodium(rows, shouldAnimate);
    renderLeaderboardRemainingList(rows, shouldAnimate);
    renderSelfRankBar(rows, config.metric);

    // (تحديث - إصلاح باج أمان + باج "وسام قدوة بيتفتح لحساب صفر
    // إنجاز"): الشرط اتنقل بالكامل لدالة SQL آمنة (check_and_unlock_top3_badge
    // في js/profiles.js -> unlockBadge) بتتحقق فعليًا من ترتيبك
    // الحقيقي all-time (عمود points في profiles) قبل أي INSERT - مش
    // من بيانات الفرونت إند (rows هنا) اللي أي حد يقدر يتلاعب فيها من
    // الـ Console (كان ده بالظبط سبب فتح الوسام لحساب صفر إنجاز).
    // مفيش داعي نحسب أي شرط رتبة هنا خالص، ولا نربطه بمقياس/فترة
    // معينة (يومي/أسبوعي/شهري) - "قدوة" إنجاز دائم all-time، والدالة
    // بتتأكد بنفسها إنك مش مستحقه أصلاً أو مفتوح بالفعل وترجع بسرعة
    // من غير أي تأثير - آمنة تتنادى في كل مرة الليدربورد يتحمّل (حتى
    // لو مرتين بسبب كاش الأوفلاين فوق - unlockBadge/الدالة idempotent)
    import('./profiles.js').then(({ unlockBadge }) => unlockBadge?.('top3_leaderboard'));
}


/* ==================================================================
   5) الواجهة العامة (Public API) - دي بس اللي المفروض تتستورد من برّه
   ================================================================== */

/** @returns {'today'|'week'|'month'} الفترة النشطة حالياً */
export function getActivePeriod() {
    return activePeriod;
}

/**
 * (إصلاح باج "الأرقام الوهمية بتظهر وترجع تاني") إعادة جلب ورسم بيانات
 * الفترة النشطة حالياً من غير ما تبديل تبويب فعلي - دي نقطة الدخول
 * الصح اللي أي كود خارجي (زي profiles.js بعد Flush خطوات أو بعد
 * الإجابة على السؤال اليومي) لازم ينادي عليها لو عايز "يحدّث" الليدربورد
 * الظاهر دلوقتي، بدل ما يرسم بأي مصدر بيانات تاني مباشرة فوق نفس عناصر
 * الـ DOM (p1-name/p1-points/... و#leaderboardList) - أي رسم من مصدر
 * تاني (حتى لو صحيح في حد ذاته) هيبقى بالتعريف "غير متزامن مع الفترة/
 * التبويب الظاهر فعلياً"، وده أصل باج الأرقام الوهمية اللي كانت بتظهر
 * وترجع.
 */
export function refreshActiveLeaderboard() {
    loadAndRenderPeriod(activePeriod);
}

/** @returns {'points'|'total_steps'} مقياس الترتيب المستخدم في الفترة النشطة حالياً */
export function getActiveMetric() {
    return CHAMPIONSHIP_PERIODS[activePeriod].metric;
}

/**
 * نقطة الدخول الرئيسية - تُستدعى من initLeaderboardUI() في js/profiles.js.
 * بتربط أزرار التبويبات وتفعّل فترة بطولة بكل ما يخصها (عداد + جلب ورسم
 * بيانات حقيقية من Supabase).
 *
 * ملحوظة مهمة: مش دايماً بتفعّل initialPeriod ("اليومية") بالقوة. أول
 * تهيئة فعلية بس (لسه tabEventsBound = false) هي اللي بتاخد initialPeriod.
 * أي نداء تاني بعد كده (مثلاً initProfileUI بتتنادى تاني من حدث
 * "auth:login" اللي Supabase ممكن يطلقه تاني بمجرد رجوع فوكس التاب أو
 * تجديد التوكن، حتى من غير أي تسجيل دخول فعلي جديد) بيحافظ على الفترة
 * اللي المستخدم كان واقف فيها فعلاً (activePeriod) بدل ما يرجّعه بالقوة
 * لـ"اليومية" من غير أي كليك منه - وده بالظبط سبب باج "بترجعني لليومية
 * فجأة وانا في الشهرية".
 * @param {'today'|'week'|'month'} [initialPeriod='today']
 */
export function initChampionshipTabs(initialPeriod = 'today') {
    const alreadyInitialized = tabEventsBound;
    bindChampionshipTabs();
    bindLeaderboardRefreshButton();
    // (جديد - تحديث مباشر) بدء الاشتراك في تحديثات Realtime لجدول
    // profiles - محمي بعلم realtimeSyncStarted جواه، فمفيش خطورة نناديها
    // هنا حتى لو initChampionshipTabs اتنادت أكتر من مرة (نفس فلسفة
    // bindChampionshipTabs فوق)
    startLeaderboardRealtimeSync();

    const periodToActivate = alreadyInitialized
        ? activePeriod
        : (CHAMPIONSHIP_PERIODS[initialPeriod] ? initialPeriod : 'today');

    setActivePeriod(periodToActivate);
}

/**
 * تنظيف كامل (إيقاف العداد الشغال) - مش لازم تتنادى في السياق العادي
 * للتطبيق (الصفحة SPA وعناصرها ثابتة طول عمر التبويب)، لكن متاحة لو
 * احتجت تفكيك الموديول ده يدوياً (مثلاً أثناء اختبارات Unit Tests)
 */
export function destroyChampionshipTimers() {
    stopCountdown();
    stopLeaderboardRealtimeSync();
}