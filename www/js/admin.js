/* ==================================================================
   سِكّاوي | js/admin.js
   ------------------------------------------------------------------
   منطق واجهة تحكم الأدمن (admin.html). مسؤول عن:

     0) التحقق إن اللي فاتح الصفحة أدمن فعلاً (وإلا redirect فوري
        لـ index.html) - أول حاجة بتتنفذ قبل أي حاجة تانية
     1) قراءة/تعديل geofence_radius_meters في جدول app_settings
        (الصف الوحيد id = 1) عن طريق admin_update_geofence_radius
     2) البحث عن مستخدمين (عن طريق admin_search_users) + تعديل
        is_verified_override (عن طريق admin_toggle_verified_override)
     3) (المرحلة 2) حظر/إلغاء حظر أي حساب من نفس قائمة الحسابات
        (عن طريق admin_toggle_user_block) - شوف sql/phase-2-blocking.sql

   كل العمليات دلوقتي بتعدي عن طريق دوال RPC (SECURITY DEFINER) بتتحقق
   من role = 'admin' بنفسها في السيرفر - مش نداءات مباشرة لـ .update()
   زي قبل كده (كانت هترفض من RLS + الـ Trigger أصلاً). شوف
   sql/phase-0-security.sql للدوال دي كاملة.

   ES Module عادي (زي auth.js وgeofence.js بالظبط) - بيستورد
   supabaseClient من نفس ملف التهيئة المشترك.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { getCurrentUser } from './auth.js';


/* ==================================================================
   0) بوابة التحقق من صلاحية الأدمن - أول حاجة بتتنفذ في الصفحة
   ------------------------------------------------------------------
   بتشتغل قبل أي widget تاني. لو مفيش جلسة، أو فيه جلسة بس role مش
   admin، بنعمل redirect فوري لـ index.html من غير ما نعرض أي محتوى
   من لوحة التحكم خالص.
   ================================================================== */

/** id الأدمن الحالي (اللي فاتح لوحة التحكم) - بتتحدّد في
 * verifyAdminAccessOrRedirect وبنستخدمها كخط دفاع إضافي (بصري بس) في
 * الواجهة عشان نخفي زرار "حظر" من على صف حسابه هو، رغم إن الـ RPC
 * admin_toggle_user_block نفسها برضو بترفض حظر الأدمن لنفسه */
let currentAdminUserId = null;

async function verifyAdminAccessOrRedirect() {
    const user = await getCurrentUser();

    if (!user) {
        window.location.href = 'index.html';
        return false;
    }

    const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

    // ملاحظة: الاستعلام ده بيقرا صف المستخدم الحالي بس (auth.uid() = id)،
    // وده مسموح بيه في RLS الحالية لأي مستخدم مسجّل - مش محتاج دالة RPC
    // خاصة هنا لأننا بنقرا بياناتنا احنا بس، مش بيانات حد تاني
    if (error || !profile || profile.role !== 'admin') {
        window.location.href = 'index.html';
        return false;
    }

    currentAdminUserId = user.id;
    return true;
}


/* ==================================================================
   1) ثوابت عامة
   ================================================================== */

// عدد الأيام المعروضة في الرسم البياني البسيط لـ Widget الزوار
const VISITORS_CHART_DAYS = 7;

// أقصى مدة من غير heartbeat قبل ما نعتبر "أونلاين الآن" مش دقيقة -
// حتى لو profiles.is_online لسه true (ممكن يفضل true لو التاب اتقفل
// فجأة/الجهاز اتقفل من غير ما beforeunload يتنفذ في app.js، فمش نقدر
// نعتمد على العمود لوحده) - لازم تكون أكبر بوضوح من
// PRESENCE_HEARTBEAT_INTERVAL_MS (دقيقتين) في app.js عشان تتحمل تأخير
// شبكة عادي، بنفس فلسفة STALE_SESSION_THRESHOLD_MS في auth.js
const ONLINE_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 دقايق

// أقل وأقصى قيمة منطقية لنصف قطر النطاق بالمتر - مطابقة لقيم
// min/max الموجودة في admin.html (Slider + Input)، بنتحقق منها
// كمان هنا في الـ JS قبل الإرسال لـ Supabase كخط دفاع إضافي
const GEOFENCE_RADIUS_MIN_METERS = 100;
const GEOFENCE_RADIUS_MAX_METERS = 20000;

// (ملاحظة: ثوابت البحث القديمة MIN_CHARS/DEBOUNCE_MS/RESULTS_LIMIT
// اتشالت - Widget رقم 2 بقى بيحمّل كل الحسابات مرة واحدة ويفلترها
// محلياً بدل البحث المتقطّع (Debounced) على السيرفر، شوف
// loadAllUsers/renderFilteredUserList تحت)


/* ==================================================================
   1ب) Widget: الزوار والمستخدمين النشطين (المرحلة 1)
   ------------------------------------------------------------------
   بيعرض عدد زوار اليوم (مسجلين/عابرين) وإجمالي كل الوقت من جدول
   visitor_sessions (شوف sql/phase-1-visitors.sql)، بالإضافة لرسم
   بياني بسيط لآخر 7 أيام. الجدول محمي بـ RLS تسمح بالقراءة للأدمن بس
   (مباشرة، من غير RPC - شوف الشرح في ملف الـ SQL).
   ================================================================== */

/**
 * تجيب إحصائيات الزوار من visitor_sessions وترسمها في الـ Widget.
 * بتعمل استعلامين بس: واحد "عدّ فقط" (head: true) للإجمالي الكلي
 * (عشان منجيبش كل صفوف الجدول التاريخية للمتصفح)، وواحد بيجيب صفوف
 * آخر 7 أيام فقط (تاريخ + user_id) عشان نحسب منها اليوم + الرسم البياني
 */
async function loadVisitorStats() {
    const statusEl = document.getElementById('visitorsStatus');
    setStatusText(statusEl, 'جاري تحميل إحصائيات الزوار…', 'loading');

    const todayStr = new Date().toISOString().slice(0, 10);
    const chartStartDate = new Date();
    chartStartDate.setDate(chartStartDate.getDate() - (VISITORS_CHART_DAYS - 1));
    const chartStartStr = chartStartDate.toISOString().slice(0, 10);

    const [totalResult, recentResult] = await Promise.all([
        supabaseClient
            .from('visitor_sessions')
            .select('id', { count: 'exact', head: true }),
        supabaseClient
            .from('visitor_sessions')
            .select('visit_date, user_id')
            .gte('visit_date', chartStartStr),
    ]);

    if (totalResult.error || recentResult.error) {
        console.error('[admin.js] فشل تحميل إحصائيات الزوار:', totalResult.error || recentResult.error);
        setStatusText(statusEl, 'تعذّر تحميل إحصائيات الزوار. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, '', null);
    renderVisitorStats({
        allTimeTotal: totalResult.count || 0,
        recentRows: recentResult.data || [],
        todayStr,
    });
}

/**
 * ترسم كروت "مسجلين اليوم / عابرين اليوم / إجمالي كل الوقت" + الرسم
 * البياني لآخر 7 أيام، بناءً على الصفوف اللي loadVisitorStats جابتها
 * @param {{ allTimeTotal: number, recentRows: Array<{visit_date: string, user_id: string|null}>, todayStr: string }} stats
 */
function renderVisitorStats({ allTimeTotal, recentRows, todayStr }) {
    const todayRows = recentRows.filter((row) => row.visit_date === todayStr);
    const todayRegistered = todayRows.filter((row) => row.user_id !== null).length;
    const todayGuests = todayRows.filter((row) => row.user_id === null).length;

    const registeredEl = document.getElementById('visitorsTodayRegistered');
    const guestsEl = document.getElementById('visitorsTodayGuests');
    const totalEl = document.getElementById('visitorsAllTimeTotal');

    if (registeredEl) registeredEl.textContent = todayRegistered.toLocaleString('ar-EG');
    if (guestsEl) guestsEl.textContent = todayGuests.toLocaleString('ar-EG');
    if (totalEl) totalEl.textContent = allTimeTotal.toLocaleString('ar-EG');

    renderVisitorsWeeklyChart(recentRows, todayStr);
}

/**
 * [هوية "غرفة التحكم"] ترسم رسم بياني حقيقي (خط + مساحة متدرجة SVG)
 * لعدد الزيارات في آخر VISITORS_CHART_DAYS يوم - بدل أعمدة الـ divs
 * القديمة. لسه من غير أي مكتبة رسم بياني خارجية (SVG خام زي الأعمدة
 * القديمة بالظبط)، بس بشكل "قراءة بيانات حية" أقرب لروح غرفة تحكم
 * @param {Array<{visit_date: string, user_id: string|null}>} recentRows
 * @param {string} todayStr
 */
function renderVisitorsWeeklyChart(recentRows, todayStr) {
    const chartEl = document.getElementById('visitorsWeeklyChart');
    if (!chartEl) return;

    // بناء آخر VISITORS_CHART_DAYS يوم بترتيب زمني (الأقدم أولاً)، كل
    // يوم بعدد الزيارات المسجلة فيه (بغض النظر مسجل أو عابر)
    const dayBuckets = [];
    for (let i = VISITORS_CHART_DAYS - 1; i >= 0; i -= 1) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);
        dayBuckets.push({
            dateStr,
            isToday: dateStr === todayStr,
            count: recentRows.filter((row) => row.visit_date === dateStr).length,
            weekdayLabel: date.toLocaleDateString('ar-EG', { weekday: 'short' }),
        });
    }

    const maxCount = Math.max(1, ...dayBuckets.map((d) => d.count));

    // إحداثيات SVG ثابتة (viewBox) بتتحسب نسبياً - الـ SVG بياخد عرض
    // الحاوية بالكامل عن طريق class="w-full h-auto" في الـ CSS
    const width = 700;
    const height = 140;
    const paddingX = 4;
    const paddingY = 14;
    const usableWidth = width - paddingX * 2;
    const usableHeight = height - paddingY * 2;
    const stepX = dayBuckets.length > 1 ? usableWidth / (dayBuckets.length - 1) : 0;

    const points = dayBuckets.map((day, index) => ({
        x: paddingX + stepX * index,
        y: paddingY + usableHeight * (1 - day.count / maxCount),
        day,
    }));

    const linePath = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
    const baselineY = (height - paddingY).toFixed(1);
    const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${baselineY} `
        + `L ${points[0].x.toFixed(1)} ${baselineY} Z`;

    const dotsSvg = points
        .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.day.isToday ? 3.5 : 2.25}" `
            + `fill="${p.day.isToday ? '#E8C158' : '#4b5563'}"></circle>`)
        .join('');

    const weekdayLabelsHtml = dayBuckets
        .map((day) => `<span class="text-[0.6rem] font-mono ${day.isToday ? 'text-gold-400 font-bold' : 'text-lux-600'}">${escapeHtml(day.weekdayLabel)}</span>`)
        .join('');

    chartEl.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="w-full h-24" aria-hidden="true">
            <defs>
                <linearGradient id="visitorsChartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#D4AF37" stop-opacity="0.25"></stop>
                    <stop offset="100%" stop-color="#D4AF37" stop-opacity="0"></stop>
                </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#visitorsChartFill)" stroke="none"></path>
            <path d="${linePath}" fill="none" stroke="#D4AF37" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"></path>
            ${dotsSvg}
        </svg>
        <div class="flex items-center justify-between mt-1.5 px-0.5">${weekdayLabelsHtml}</div>
    `;
}

/**
 * بترجع true لو المستخدم "أونلاين الآن" فعلياً - بتجمع بين عمود
 * is_online وحداثة last_seen_at (شوف تعليق ONLINE_FRESHNESS_THRESHOLD_MS
 * فوق ليه معتمدناش على is_online لوحده)
 * @param {object} user - صف من profiles (فيه is_online وlast_seen_at)
 * @returns {boolean}
 */
function isUserOnline(user) {
    if (!user.is_online || !user.last_seen_at) return false;
    const elapsedMs = Date.now() - new Date(user.last_seen_at).getTime();
    return elapsedMs < ONLINE_FRESHNESS_THRESHOLD_MS;
}

/**
 * بتحوّل أي توقيت ISO لنص عربي نسبي مقروء: "دلوقتي"، "من كذا دقيقة"،
 * "من كذا ساعة"، "من كذا يوم" - دالة عامة مستخدمة لكل من نص "آخر
 * ظهور" (formatPresenceText) ونص "تاريخ الانضمام" (buildUserRowElement)
 * @param {string} isoDateString
 * @returns {string}
 */
/**
 * بترجع الصيغة العربية الصحيحة لعدد ووحدة زمن (دقيقة/ساعة/يوم) حسب
 * قواعد العدد والمعدود: ١ مفرد ("دقيقة واحدة")، ٢ مثنى ("دقيقتين")،
 * ٣-١٠ جمع ("٥ دقائق")، ١١+ مفرد بعد الرقم ("١٥ دقيقة") - نفس القاعدة
 * المستخدمة في buildRemainingParticipantsPhrase بتاعة الليدربورد
 * (js/leaderboard.js) بالظبط، مطبّقة هنا على وحدات الزمن بدل "الأبطال"
 * @param {number} count
 * @param {{one: string, two: string, few: string, many: string}} forms
 * @returns {string}
 */
function pluralizeArabicTimeUnit(count, forms) {
    if (count === 1) return forms.one;
    if (count === 2) return forms.two;
    const formattedCount = count.toLocaleString('ar-EG');
    if (count <= 10) return `${formattedCount} ${forms.few}`;
    return `${formattedCount} ${forms.many}`;
}

function formatRelativeArabicTime(isoDateString) {
    const elapsedMs = Date.now() - new Date(isoDateString).getTime();
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));

    if (elapsedMinutes < 1) return 'دلوقتي';
    if (elapsedMinutes < 60) {
        return `من ${pluralizeArabicTimeUnit(elapsedMinutes, { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' })}`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `من ${pluralizeArabicTimeUnit(elapsedHours, { one: 'ساعة واحدة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' })}`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    return `من ${pluralizeArabicTimeUnit(elapsedDays, { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يوم' })}`;
}


/**
 * بتحوّل last_seen_at لنص عربي مقروء: "أونلاين الآن" أو "آخر ظهور من
 * كذا دقيقة/ساعة/يوم"
 * @param {object} user - صف من profiles
 * @returns {string}
 */
function formatPresenceText(user) {
    if (isUserOnline(user)) return 'أونلاين الآن';
    if (!user.last_seen_at) return 'لسه ما ظهرش';
    return `آخر ظهور ${formatRelativeArabicTime(user.last_seen_at)}`;
}


/* ==================================================================
   2) Widget رقم 1: نصف قطر النطاق الجغرافي (app_settings)
   ================================================================== */

/**
 * تجيب إعدادات النطاق الحالية (المركز ونصف القطر) من app_settings
 * وتملأ بيها عناصر الواجهة (Slider + Input + شارة المركز)
 */
async function loadGeofenceSettings() {
    const statusEl = document.getElementById('geofenceRadiusStatus');
    setStatusText(statusEl, 'جاري تحميل إعدادات النطاق…', 'loading');

    const { data, error } = await supabaseClient
        .from('app_settings')
        .select('geofence_center_lat, geofence_center_lng, geofence_radius_meters')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[admin.js] فشل تحميل app_settings:', error);
        setStatusText(statusEl, 'تعذّر تحميل إعدادات النطاق الحالية. حاول تعمل تحديث للصفحة.', 'error');
        return;
    }

    applyGeofenceRadiusToInputs(data.geofence_radius_meters);
    setStatusText(statusEl, '', null);

    const centerBadge = document.getElementById('geofenceCenterBadge');
    if (centerBadge) {
        const lat = Number(data.geofence_center_lat).toFixed(4);
        const lng = Number(data.geofence_center_lng).toFixed(4);
        centerBadge.textContent = `المركز: ${lat}, ${lng}`;
    }
}

/**
 * [هوية "غرفة التحكم"] تحدّث نصف قطر الدائرة الممتلئة في الـ Dial
 * (#geofenceRadiusDialCircle) بشكل نسبي لقيمة نصف القطر الحالية -
 * تمثيل بصري فعلي للمسافة بدل ما تفضل مجرد رقم. بنستخدم Scale بالجذر
 * التربيعي (مش خطي) عشان الفرق البصري بين نطاق صغير وكبير يحس بيه
 * بشكل أوضح على الدايرة (المساحة بتكبر بمربع نصف القطر، فالجذر
 * التربيعي بيرجّع الإحساس البصري "خطي" مرة تانية)
 * @param {number} radiusMeters
 */
function updateGeofenceRadiusDial(radiusMeters) {
    const dialCircle = document.getElementById('geofenceRadiusDialCircle');
    if (!dialCircle) return;

    const clamped = clampGeofenceRadius(radiusMeters);
    const ratio = Math.sqrt(
        (clamped - GEOFENCE_RADIUS_MIN_METERS) / (GEOFENCE_RADIUS_MAX_METERS - GEOFENCE_RADIUS_MIN_METERS),
    );
    const dialRadius = 8 + ratio * 82; // بين 8px (أصغر نطاق) و90px (أقصى نطاق) على viewBox 200x200

    dialCircle.setAttribute('r', dialRadius.toFixed(1));
}

/**
 * تحدّث Slider + Input الرقمي + نصوص العرض (متر/كم) بقيمة نصف قطر معينة
 * @param {number} radiusMeters
 */
function applyGeofenceRadiusToInputs(radiusMeters) {
    const slider = document.getElementById('geofenceRadiusSlider');
    const numberInput = document.getElementById('geofenceRadiusInput');
    const metersLabel = document.getElementById('geofenceRadiusValueMeters');
    const kmLabel = document.getElementById('geofenceRadiusValueKm');

    const clamped = clampGeofenceRadius(radiusMeters);

    if (slider) slider.value = String(clamped);
    if (numberInput) numberInput.value = String(clamped);
    if (metersLabel) metersLabel.textContent = clamped.toLocaleString('ar-EG');
    if (kmLabel) kmLabel.textContent = `(${(clamped / 1000).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} كم)`;
    updateGeofenceRadiusDial(clamped);
}

/**
 * بتحصر أي قيمة مُدخلة جوه الحدود المنطقية المسموح بيها
 * @param {number} value
 * @returns {number}
 */
function clampGeofenceRadius(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) return GEOFENCE_RADIUS_MIN_METERS;
    return Math.min(GEOFENCE_RADIUS_MAX_METERS, Math.max(GEOFENCE_RADIUS_MIN_METERS, Math.round(numericValue)));
}

/**
 * الدالة الأساسية المطلوبة: تحديث geofence_radius_meters في app_settings
 * (الصف الوحيد id = 1) على Supabase
 * @param {number} newRadiusMeters
 * @returns {Promise<boolean>} true لو نجح التحديث
 */
async function updateGeofenceRadius(newRadiusMeters) {
    const statusEl = document.getElementById('geofenceRadiusStatus');
    const saveBtn = document.getElementById('geofenceRadiusSaveBtn');

    const clampedRadius = clampGeofenceRadius(newRadiusMeters);

    if (saveBtn) saveBtn.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const { error } = await supabaseClient
        .rpc('admin_update_geofence_radius', { p_new_radius: clampedRadius });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل تحديث geofence_radius_meters:', error);
        setStatusText(statusEl, 'حصل خطأ أثناء الحفظ. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return false;
    }

    applyGeofenceRadiusToInputs(clampedRadius);
    setStatusText(statusEl, 'تم حفظ نصف القطر الجديد بنجاح.', 'success');
    return true;
}

/** ربط أحداث الـ Slider والـ Input الرقمي وزرار الحفظ لأول Widget */
function initGeofenceRadiusWidget() {
    const slider = document.getElementById('geofenceRadiusSlider');
    const numberInput = document.getElementById('geofenceRadiusInput');
    const saveBtn = document.getElementById('geofenceRadiusSaveBtn');

    if (!slider || !numberInput || !saveBtn) return;

    // تحريك الـ Slider بيحدّث الـ Input الرقمي وعرض القيمة فورًا (Live)،
    // من غير أي استدعاء لـ Supabase لحد ما المستخدم يضغط "حفظ"
    slider.addEventListener('input', () => {
        applyGeofenceRadiusToInputs(slider.value);
    });

    // كتابة قيمة يدوياً في الـ Input الرقمي بتحدّث الـ Slider بالمثل
    numberInput.addEventListener('input', () => {
        if (numberInput.value === '') return;
        const clamped = clampGeofenceRadius(numberInput.value);
        slider.value = String(clamped);
        const metersLabel = document.getElementById('geofenceRadiusValueMeters');
        const kmLabel = document.getElementById('geofenceRadiusValueKm');
        if (metersLabel) metersLabel.textContent = clamped.toLocaleString('ar-EG');
        if (kmLabel) kmLabel.textContent = `(${(clamped / 1000).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} كم)`;
        updateGeofenceRadiusDial(clamped);
    });

    // لو المستخدم سايب الـ Input برقم برة الحدود أو فاضي، نظبطه لحدود
    // منطقية بمجرد ما يسيب الحقل (blur) بدل ما نسيبه غير صالح
    numberInput.addEventListener('blur', () => {
        applyGeofenceRadiusToInputs(numberInput.value || slider.value);
    });

    saveBtn.addEventListener('click', () => {
        updateGeofenceRadius(numberInput.value);
    });
}


/* ==================================================================
   3) Widget رقم 2: كل الحسابات (قائمة دايمة، لحظية) + is_verified_override
   ------------------------------------------------------------------
   بدل ما تبقى مبنية على بحث بيتطلق يدوياً، الـ Widget ده بيحمّل كل
   حسابات profiles مرة واحدة عند فتح الصفحة (مرتبة بالأحدث فوق -
   created_at desc)، وبيفضل محدّث نفسه لحظياً عن طريق Realtime من غير
   أي Refresh: حساب جديد بيتضاف فوق القائمة تلقائياً، وأي تغيير (حالة
   أونلاين، last_seen_at، تفعيل مغترب) بيتحدّث في مكانه على طول.

   مربع البحث فضل موجود بس بقى بيفلتر القائمة المحمّلة محلياً (Client-
   side) من غير أي طلب جديد لـ Supabase - مفيش داعي لـ Debounce لأن
   الفلترة بقت عملية محلية بحتة وسريعة.
   ================================================================== */

/** كل الحسابات المحمّلة حالياً، مرتبة بالأحدث فوق (created_at desc) */
let allUsersList = [];

/** نص الفلترة الحالي في مربع البحث (فلترة محلية بس، مش استعلام سيرفر) */
let userSearchFilterQuery = '';

/**
 * وضع ترتيب قائمة "كل الحسابات" الحالي - 'active' (الأونلاين أولاً) هو
 * الافتراضي دايماً عند فتح الصفحة، زي ما هو مطلوب. القيم التانية:
 * 'recent' (الأحدث نشاطاً بغض النظر هو أونلاين ولا لأ)، و'newest'
 * (تاريخ إنشاء الحساب - الترتيب الأصلي القديم)
 */
let userSortMode = 'active';

/** قناة الـ Realtime المشتركة لتحديثات profiles (INSERT/UPDATE) */
let allUsersRealtimeChannel = null;

/**
 * تحديث is_verified_override لمستخدم معيّن عن طريق دالة RPC إدارية
 * (admin_toggle_verified_override) بدل .update() مباشر - ده كان
 * هيترفض من الـ RLS والـ Trigger مع بعض
 * @param {string} userId
 * @param {boolean} newValue
 * @returns {Promise<boolean>} true لو نجح التحديث
 */
async function toggleUserVerifiedOverride(userId, newValue) {
    const { error } = await supabaseClient
        .rpc('admin_toggle_verified_override', { p_user_id: userId, p_new_value: newValue });

    if (error) {
        console.error('[admin.js] فشل تحديث is_verified_override:', error);
        return false;
    }

    return true;
}

/**
 * حظر/إلغاء حظر مستخدم عن طريق admin_toggle_user_block (المرحلة 2 -
 * شوف sql/phase-2-blocking.sql). زي admin_toggle_verified_override
 * بالظبط، الدالة دي بتتحقق من role = 'admin' في السيرفر نفسه، فمفيش
 * داعي لأي فحص إضافي هنا غير عرض رسالة الخطأ لو فشلت
 * @param {string} userId
 * @param {boolean} shouldBlock
 * @param {string|null} reason
 * @returns {Promise<boolean>} true لو نجح التحديث
 */
async function toggleUserBlock(userId, shouldBlock, reason) {
    const { error } = await supabaseClient
        .rpc('admin_toggle_user_block', {
            p_user_id: userId,
            p_should_block: shouldBlock,
            p_reason: reason || null,
        });

    if (error) {
        console.error('[admin.js] فشل تحديث حالة حظر المستخدم:', error);
        return false;
    }

    return true;
}

/**
 * تحمّل كل حسابات profiles مرة واحدة، مرتبة بالأحدث فوق. محتاجة
 * صلاحية "profiles_select_admin_full_access" (شوف
 * sql/phase-1b-full-user-list.sql) عشان ترجّع كل الصفوف مش صف الأدمن
 * نفسه بس
 */
async function loadAllUsers() {
    const statusEl = document.getElementById('userSearchStatus');
    setStatusText(statusEl, 'جاري تحميل قائمة الحسابات…', 'loading');

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('[admin.js] فشل تحميل قائمة الحسابات:', error);
        setStatusText(statusEl, 'تعذّر تحميل قائمة الحسابات. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return;
    }

    allUsersList = data || [];
    renderFilteredUserList();
}

/**
 * بترجع true لو المستخدم مطابق لنص الفلترة الحالي (بالاسم أو اسم
 * المستخدم) - فلترة نص بسيطة بدون حساسية لحالة الأحرف
 * @param {object} user
 * @param {string} query
 * @returns {boolean}
 */
function userMatchesFilter(user, query) {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) return true;

    const haystack = `${user.username || ''} ${user.full_name || ''}`.toLowerCase();
    return haystack.includes(trimmedQuery);
}

/**
 * ترجع نسخة مرتّبة (مش بتعدّل الأصل) من قايمة مستخدمين حسب وضع
 * الترتيب المطلوب:
 *   - 'active': الأونلاين أولاً (isUserOnline)، وتحتهم بالأحدث نشاطاً
 *     (last_seen_at) - ده الافتراضي دايماً
 *   - 'recent': بالأحدث نشاطاً (last_seen_at) بس، بغض النظر أونلاين
 *     دلوقتي ولا لأ
 *   - 'newest': بتاريخ إنشاء الحساب (created_at) - أحدث الحسابات فوق
 * @param {Array<object>} users
 * @param {'active'|'recent'|'newest'} mode
 * @returns {Array<object>}
 */
function sortUsersByMode(users, mode) {
    const sorted = users.slice();
    const lastSeenTime = (user) => (user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0);

    if (mode === 'newest') {
        sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } else if (mode === 'recent') {
        sorted.sort((a, b) => lastSeenTime(b) - lastSeenTime(a));
    } else {
        sorted.sort((a, b) => {
            const onlineDiff = (isUserOnline(b) ? 1 : 0) - (isUserOnline(a) ? 1 : 0);
            return onlineDiff !== 0 ? onlineDiff : lastSeenTime(b) - lastSeenTime(a);
        });
    }

    return sorted;
}

/** تفلتر وترتّب allUsersList حسب البحث ووضع الترتيب الحاليين، وترسم النتيجة + رسالة الحالة */
function renderFilteredUserList() {
    const statusEl = document.getElementById('userSearchStatus');
    const filtered = allUsersList.filter((user) => userMatchesFilter(user, userSearchFilterQuery));
    const sorted = sortUsersByMode(filtered, userSortMode);

    renderUserSearchResults(sorted);
    updateHeaderStats();

    if (allUsersList.length === 0) {
        setStatusText(statusEl, 'لسه مفيش أي حسابات مسجّلة.', 'empty');
    } else if (filtered.length === 0) {
        setStatusText(statusEl, 'مفيش نتائج مطابقة.', 'empty');
    } else {
        setStatusText(statusEl, '', null);
    }
}

/**
 * [تحديث الشكل] تحدّث صف "الإحصائيات السريعة" الثابت في هيدر الصفحة
 * (#headerStatTotalUsers / #headerStatRegisteredToday / #headerStatOnline)
 * - ده ظاهر فوق مهما كان التاب المفتوح، فبيدّي لمحة سريعة من غير ما
 * تدخل تاب "الحسابات" أصلاً. الأرقام كلها مبنية على allUsersList اللي
 * أصلاً محمّلة ومتحدّثة لحظياً بـ Realtime لتاب الحسابات (شوف
 * loadAllUsers/bindAllUsersRealtimeSubscription فوق) - من غير أي طلب
 * إضافي لـ Supabase، وبتتنادى تلقائياً من جوه renderFilteredUserList
 * (يعني بعد أول تحميل، وبعد أي حدث Realtime جديد أو تحديث)
 */
function updateHeaderStats() {
    const totalEl = document.getElementById('headerStatTotalUsers');
    const todayEl = document.getElementById('headerStatRegisteredToday');
    const onlineEl = document.getElementById('headerStatOnline');
    const sidebarOnlineEl = document.getElementById('sidebarOnlineReadout');

    if (totalEl) totalEl.textContent = allUsersList.length.toLocaleString('ar-EG');

    if (onlineEl || sidebarOnlineEl) {
        const onlineCount = allUsersList.filter((user) => isUserOnline(user)).length;
        if (onlineEl) onlineEl.textContent = onlineCount.toLocaleString('ar-EG');
        if (sidebarOnlineEl) sidebarOnlineEl.textContent = onlineCount.toLocaleString('ar-EG');
    }

    if (todayEl) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const registeredToday = allUsersList.filter(
            (user) => (user.created_at || '').slice(0, 10) === todayStr,
        ).length;
        todayEl.textContent = registeredToday.toLocaleString('ar-EG');
    }
}

/** ربط مربع البحث وشرائح الترتيب (فلترة/ترتيب محلي فوري) وتحميل/تحديث القائمة لثالث تاب */
function initUserVerificationWidget() {
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            userSearchFilterQuery = searchInput.value;
            renderFilteredUserList();
        });
    }

    const sortButtons = document.querySelectorAll('#userSortControls [data-sort-mode]');
    sortButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            userSortMode = btn.dataset.sortMode;
            sortButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
            renderFilteredUserList();
        });
    });

    loadAllUsers();
    bindAllUsersRealtimeSubscription();
}

/**
 * تشترك في تحديثات Realtime الحية على جدول profiles بالكامل (INSERT
 * لحساب جديد، UPDATE لأي تغيير زي أونلاين/آخر ظهور/تفعيل مغترب)، عشان
 * القائمة تفضل محدّثة من غير أي Refresh يدوي. بتلغي أي اشتراك قديم
 * الأول عشان مانفضلش مشتركين مرتين لو الدالة اتنادت أكتر من مرة
 */
function bindAllUsersRealtimeSubscription() {
    unbindAllUsersRealtimeSubscription();

    allUsersRealtimeChannel = supabaseClient
        .channel('admin-all-profiles-list')
        .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'profiles' },
            (payload) => handleUserInserted(payload.new),
        )
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'profiles' },
            (payload) => handleUserUpdated(payload.new),
        )
        .subscribe((status, err) => {
            if (err) {
                console.error('[admin.js] خطأ في اشتراك Realtime بتاع قائمة الحسابات:', err.message || err);
            }
        });
}

/** تلغي اشتراك Realtime بتاع قائمة الحسابات (لو شغال) */
function unbindAllUsersRealtimeSubscription() {
    if (allUsersRealtimeChannel) {
        supabaseClient.removeChannel(allUsersRealtimeChannel);
        allUsersRealtimeChannel = null;
    }
}

/**
 * بتتنادى لما حساب جديد يتسجل - بتضيفه للقائمة المحلية وتعيد رسم
 * القائمة كاملة عن طريق renderFilteredUserList() (بدل إضافة مستهدفة
 * في الـ DOM كان بيفترض ترتيب created_at desc ثابت دايماً - دلوقتي
 * بقى عندنا 3 أوضاع ترتيب مختلفة، فإعادة الرسم الكاملة هي الطريقة
 * الوحيدة اللي تضمن المكان الصح للحساب الجديد أياً كان وضع الترتيب
 * المختار حالياً). القائمة صغيرة الحجم (تطبيق قرية)، فإعادة الرسم دي
 * رخيصة ومش هيلاحظها حد
 * @param {object} newUserRow
 */
function handleUserInserted(newUserRow) {
    if (allUsersList.some((user) => user.id === newUserRow.id)) return; // حماية من تكرار نادر للحدث

    allUsersList.unshift(newUserRow);
    renderFilteredUserList();
}

/**
 * بتتنادى لما أي عمود يتحدّث في صف مستخدم (أونلاين، آخر ظهور، تفعيل
 * مغترب..إلخ) - بتحدّث النسخة المحلية وتعيد رسم القائمة كاملة (نفس
 * سبب handleUserInserted فوق - أي وضع ترتيب غير "الحسابات الجديدة"
 * ممكن يغيّر مكان الصف ده تماماً، مش بس محتواه)
 * @param {object} updatedUserRow
 */
function handleUserUpdated(updatedUserRow) {
    const index = allUsersList.findIndex((user) => user.id === updatedUserRow.id);
    if (index === -1) {
        allUsersList.unshift(updatedUserRow);
    } else {
        allUsersList[index] = updatedUserRow;
    }

    renderFilteredUserList();
}

/**
 * ترسم قائمة نتائج البحث في #userSearchResultsList
 * @param {Array<object>} users
 */
function renderUserSearchResults(users) {
    const listEl = document.getElementById('userSearchResultsList');
    if (!listEl) return;

    listEl.innerHTML = '';

    users.forEach((user) => {
        listEl.appendChild(buildUserRowElement(user));
    });
}

/**
 * تبني عنصر <li> واحد يمثل مستخدم في القائمة، بما فيه حالة الأونلاين،
 * تاريخ الانضمام، والـ Toggle Switch الخاص بـ is_verified_override
 * @param {object} user
 * @returns {HTMLLIElement}
 */
function buildUserRowElement(user) {
    const li = document.createElement('li');
    li.className = 'admin-user-row';
    li.dataset.userId = user.id;

    const avatarUrl = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    const displayName = escapeHtml(user.full_name || user.username || 'مستخدم بدون اسم');
    const usernameText = user.username ? `@${escapeHtml(user.username)}` : '';
    const isInside = Boolean(user.is_inside_bounds);
    const isVerifiedOverride = Boolean(user.is_verified_override);
    const toggleId = `userVerifiedToggle_${user.id}`;

    // (المرحلة 2) حالة الحظر - is_blocked/blocked_reason بييجوا تلقائياً
    // من نفس select('*') الموجود في loadAllUsers، زي أي عمود تاني على
    // profiles، فمفيش استعلام إضافي مطلوب هنا
    const isBlocked = Boolean(user.is_blocked);
    li.classList.toggle('is-blocked', isBlocked);
    const blockedReasonText = user.blocked_reason ? escapeHtml(user.blocked_reason) : '';

    // نص الظهور (أونلاين الآن / آخر ظهور من كذا) - شوف formatPresenceText
    // فوق. الأعمدة last_seen_at وis_online بترجع تلقائياً بما إنهم
    // أعمدة عادية على profiles وبنجيب الصف بالكامل (select *)
    const presenceText = escapeHtml(formatPresenceText(user));
    const presenceIsOnline = isUserOnline(user);

    // تاريخ الانضمام (من عمود created_at الجديد - شوف
    // sql/phase-1b-full-user-list.sql) - بيفيد تحديد "الحساب ده جديد
    // فعلاً" حتى لو القائمة اتفلترت أو الترتيب مش واضح بصرياً
    const joinedText = user.created_at
        ? `انضم ${formatRelativeArabicTime(user.created_at)}`
        : '';

    // زرار الحظر بيتخفي من على صف الأدمن نفسه (خط دفاع بصري إضافي -
    // الـ RPC نفسها برضو بترفض حظر الأدمن لنفسه، شوف admin_toggle_user_block)
    const isSelfRow = user.id === currentAdminUserId;

    li.innerHTML = `
        <span class="relative inline-block shrink-0">
            <img class="admin-user-avatar" src="${avatarUrl}" alt="" loading="lazy">
            <!-- نقطة "أونلاين الآن" فوق صورة المستخدم - الأدمن أصلاً عنده
                 is_online/last_seen_at لأي مستخدم من غير أي قيد (شوف
                 isUserOnline فوق)، فمفيش حاجة لأي RPC هنا زي presence.js
                 المستخدمة في باقي التطبيق - البيانات موجودة فعلاً في user -->
            <span class="presence-dot${presenceIsOnline ? ' is-online' : ''}" aria-hidden="true"></span>
        </span>
        <div class="admin-user-info">
            <div class="admin-user-name">${displayName}</div>
            <div class="admin-user-username">${usernameText}</div>
            <div class="text-[0.65rem] font-mono font-bold ${presenceIsOnline ? 'text-emerald-400' : 'text-lux-500'} mt-0.5">
                ${presenceIsOnline ? '● ' : ''}${presenceText}
            </div>
            ${joinedText ? `<div class="text-[0.6rem] font-mono font-medium text-lux-600 mt-0.5">${escapeHtml(joinedText)}</div>` : ''}
            ${isBlocked ? `<div class="admin-user-blocked-reason">محظور${blockedReasonText ? `: ${blockedReasonText}` : ''}</div>` : ''}
        </div>
        <span class="admin-user-bounds-badge ${isInside ? 'is-inside' : 'is-outside'}">
            ${isInside ? 'داخل النطاق' : 'خارج النطاق'}
        </span>
        <div class="admin-user-actions">
            <label class="admin-toggle-switch" for="${toggleId}" title="تفعيل يدوي كمغترب">
                <input type="checkbox" id="${toggleId}" ${isVerifiedOverride ? 'checked' : ''}>
                <span class="admin-toggle-switch-track"></span>
                <span class="admin-toggle-switch-thumb"></span>
            </label>
            ${isSelfRow ? '' : `
                <button type="button" class="admin-block-btn ${isBlocked ? 'is-blocked' : ''}">
                    ${isBlocked ? 'إلغاء الحظر' : 'حظر'}
                </button>
            `}
        </div>
    `;

    const toggleWrapper = li.querySelector('.admin-toggle-switch');
    const toggleInput = li.querySelector(`#${toggleId}`);

    toggleInput.addEventListener('change', async () => {
        const newValue = toggleInput.checked;

        toggleWrapper.classList.add('is-saving');
        const succeeded = await toggleUserVerifiedOverride(user.id, newValue);
        toggleWrapper.classList.remove('is-saving');

        if (!succeeded) {
            // فشل الحفظ - نرجّع السويتش لحالته القديمة (Rollback بصري)
            toggleInput.checked = !newValue;
            const statusEl = document.getElementById('userSearchStatus');
            setStatusText(statusEl, `تعذّر تحديث حالة تفعيل ${displayName}. حاول تاني.`, 'error');
        } else {
            user.is_verified_override = newValue;
        }
    });

    const blockBtn = li.querySelector('.admin-block-btn');
    if (blockBtn) {
        blockBtn.addEventListener('click', () => handleBlockButtonClick(blockBtn, user, displayName));
    }

    return li;
}

/**
 * بتتعامل مع الضغط على زرار "حظر" / "إلغاء الحظر" في صف مستخدم -
 * بتاخد سبب الحظر (اختياري) عن طريق prompt() وتأكيد عن طريق confirm()
 * (لوحة التحكم أداة داخلية للأدمن بس، فمفيش داعي لمودال تأكيد مخصص
 * زي اللي في profiles.js لتجربة المستخدم النهائي)، وبعد النجاح
 * السطر بيتحدّث تلقائياً عن طريق Realtime (handleUserUpdated) - مش
 * محتاجين نعدّل الـ DOM يدوياً هنا خالص
 * @param {HTMLButtonElement} blockBtn
 * @param {object} user
 * @param {string} displayName
 */
async function handleBlockButtonClick(blockBtn, user, displayName) {
    const isCurrentlyBlocked = Boolean(user.is_blocked);
    let reason = null;

    if (isCurrentlyBlocked) {
        if (!window.confirm(`تأكيد إلغاء حظر ${displayName}؟`)) return;
    } else {
        // prompt() بترجع null لو المستخدم ضغط "إلغاء" - وده بيلغي
        // العملية كلها (بيدمج التأكيد + إدخال السبب في خطوة واحدة)
        reason = window.prompt(`سبب حظر ${displayName} (اختياري):`, '');
        if (reason === null) return;
        reason = reason.trim() || null;
    }

    blockBtn.disabled = true;
    blockBtn.classList.add('is-saving');

    const succeeded = await toggleUserBlock(user.id, !isCurrentlyBlocked, reason);

    blockBtn.disabled = false;
    blockBtn.classList.remove('is-saving');

    if (!succeeded) {
        const statusEl = document.getElementById('userSearchStatus');
        setStatusText(statusEl, `تعذّر تحديث حالة حظر ${displayName}. حاول تاني.`, 'error');
        return;
    }

    // تحديث محلي فوري (بدل ما نستنى Realtime) - بيحصّل تحديث مضاعف
    // لو حدث الـ Realtime وصل بعده بلحظات، وده آمن (renderFilteredUserList
    // بيعيد الرسم بالكامل من allUsersList في الحالتين)
    user.is_blocked = !isCurrentlyBlocked;
    user.blocked_reason = isCurrentlyBlocked ? null : reason;
    renderFilteredUserList();
}

/**
 * أفاتار احتياطي (Data URI بسيط بحرف واحد) لو المستخدم مالوش avatar_url
 * @param {string} seedText
 * @returns {string}
 */
function buildFallbackAvatarUrl(seedText) {
    const initial = (seedText.trim()[0] || '؟').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="%2314171F"/><text x="20" y="26" font-size="16" font-family="Cairo,sans-serif" text-anchor="middle" fill="%23D4AF37">${initial}</text></svg>`;
    return `data:image/svg+xml,${svg}`;
}

/**
 * تنضيف بسيط للنصوص القادمة من قاعدة البيانات قبل حقنها في innerHTML
 * (حماية أساسية من XSS لأي اسم مستخدم يحتوي على HTML/سكريبت)
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}


/* ==================================================================
   3ب) Widget: إرسال إشعار - فردي أو بث للكل (المرحلة 3)
   ------------------------------------------------------------------
   بيستخدم دالتين RPC جديدتين (admin_send_notification لمستخدم واحد،
   admin_broadcast_notification للكل) بدل sendNotification() العادية
   الموجودة في notifications.js - لأن دي محمية بـ trigger في القاعدة
   يمنع نوع 'admin_message' إلا من الدالتين دول بالتحديد (شوف
   sql/phase-3-notifications.sql). اختيار المستخدم بيعتمد على
   allUsersList نفسها المحمّلة أصلاً لتاب "الحسابات" (فلترة محلية فورية
   من غير أي استعلام إضافي لـ Supabase).
   ================================================================== */

/** عنوان ثابت لكل رسائل الأدمن - المستخدم بيدخل النص (الرسالة) بس،
 * زي ما هو متفق عليه في الخطة ("textarea للنص" بس، من غير حقل عنوان
 * منفصل يزوّد الاحتكاك وقت الإرسال). من غير إيموجي (📣) عمداً - الشكل
 * "الرسمي" للرسالة بقى مسؤولية أيقونة الـ SVG المرسومة في notifications.js
 * (NOTIFICATION_SVG_ICONS.admin_message) بدل ما يتحط جوه النص نفسه اللي
 * بيتخزن في العمود title بقاعدة البيانات */
const ADMIN_NOTIFICATION_TITLE = 'رسالة من إدارة سِكّاوي';

/** الوضع الحالي لويدجت الإشعارات - 'single' (لمستخدم محدد) أو 'broadcast' (بث للكل) */
let notifyMode = 'single';

/** المستخدم المختار حالياً في وضع "لمستخدم محدد" - null لو مفيش اختيار بعد */
let notifySelectedUser = null;

/**
 * إرسال إشعار admin_message لمستخدم واحد عن طريق admin_send_notification
 * @param {string} userId
 * @param {string} message
 * @returns {Promise<boolean>}
 */
async function sendAdminNotificationToUser(userId, message) {
    const { error } = await supabaseClient.rpc('admin_send_notification', {
        p_user_id: userId,
        p_title: ADMIN_NOTIFICATION_TITLE,
        p_message: message,
    });

    if (error) {
        console.error('[admin.js] فشل إرسال الإشعار الفردي:', error);
        return false;
    }

    return true;
}

/**
 * بث إشعار admin_message لكل المستخدمين عن طريق admin_broadcast_notification
 * @param {string} message
 * @returns {Promise<boolean>}
 */
async function sendAdminNotificationBroadcast(message) {
    const { error } = await supabaseClient.rpc('admin_broadcast_notification', {
        p_title: ADMIN_NOTIFICATION_TITLE,
        p_message: message,
    });

    if (error) {
        console.error('[admin.js] فشل إرسال البث الجماعي:', error);
        return false;
    }

    return true;
}

/** يبني صف واحد في قائمة نتائج اختيار مستخدم لإرسال إشعار له */
function buildNotifyPickerRow(user) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-notify-picker-row';

    const avatarUrl = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    const displayName = escapeHtml(user.full_name || user.username || 'مستخدم بدون اسم');

    btn.innerHTML = `
        <img class="admin-user-avatar" src="${avatarUrl}" alt="" loading="lazy" style="width:26px;height:26px;">
        <span class="admin-notify-picker-row-name">${displayName}</span>
    `;

    btn.addEventListener('click', () => selectNotifyRecipient(user));
    return btn;
}

/** بتفلتر allUsersList محلياً حسب نص البحث وترسم النتائج (بحد أقصى 8 نتائج) */
function renderNotifyPickerResults(query) {
    const resultsEl = document.getElementById('notifyRecipientResultsList');
    if (!resultsEl) return;

    const trimmedQuery = query.trim();
    resultsEl.innerHTML = '';

    if (!trimmedQuery) {
        resultsEl.classList.add('hidden');
        return;
    }

    const matches = allUsersList
        .filter((user) => userMatchesFilter(user, trimmedQuery))
        .slice(0, 8);

    if (matches.length === 0) {
        resultsEl.classList.add('hidden');
        return;
    }

    matches.forEach((user) => resultsEl.appendChild(buildNotifyPickerRow(user)));
    resultsEl.classList.remove('hidden');
}

/** بتحدد مستخدم كمستقبل الإشعار، وتظهر شارته بدل مربع البحث */
function selectNotifyRecipient(user) {
    notifySelectedUser = user;

    const searchInput = document.getElementById('notifyRecipientSearchInput');
    const resultsEl = document.getElementById('notifyRecipientResultsList');
    const chipEl = document.getElementById('notifyRecipientSelectedChip');
    const chipAvatar = document.getElementById('notifyRecipientSelectedAvatar');
    const chipName = document.getElementById('notifyRecipientSelectedName');

    if (searchInput) {
        searchInput.value = '';
        searchInput.classList.add('hidden');
    }
    if (resultsEl) {
        resultsEl.innerHTML = '';
        resultsEl.classList.add('hidden');
    }
    if (chipAvatar) chipAvatar.src = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    if (chipName) chipName.textContent = user.full_name || user.username || 'مستخدم بدون اسم';
    if (chipEl) chipEl.classList.remove('hidden');
}

/** بتلغي اختيار المستخدم الحالي وترجّع مربع البحث تاني */
function clearNotifyRecipient() {
    notifySelectedUser = null;

    const searchInput = document.getElementById('notifyRecipientSearchInput');
    const chipEl = document.getElementById('notifyRecipientSelectedChip');

    if (searchInput) searchInput.classList.remove('hidden');
    if (chipEl) chipEl.classList.add('hidden');
}

/** بتبدّل وضع الويدجت (لمستخدم محدد / بث للكل) وتظهر/تخفي عنصر اختيار المستخدم بناءً عليه */
function setNotifyMode(mode) {
    notifyMode = mode;

    const pickerEl = document.getElementById('notifyRecipientPicker');
    if (pickerEl) pickerEl.classList.toggle('hidden', mode !== 'single');

    const modeButtons = document.querySelectorAll('#notifyModeControls [data-notify-mode]');
    modeButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.notifyMode === mode));
}

/** ربط كل أحداث ويدجت الإشعارات - تُستدعى مرة واحدة من initAdminPage */
function initNotifyWidget() {
    const modeButtons = document.querySelectorAll('#notifyModeControls [data-notify-mode]');
    modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => setNotifyMode(btn.dataset.notifyMode));
    });

    const searchInput = document.getElementById('notifyRecipientSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderNotifyPickerResults(searchInput.value));
    }

    const clearBtn = document.getElementById('notifyRecipientClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearNotifyRecipient);

    const sendBtn = document.getElementById('notifySendBtn');
    if (sendBtn) sendBtn.addEventListener('click', handleNotifySendClick);
}

/** بتتعامل مع الضغط على زرار "إرسال" - بتتحقق من صحة المدخلات حسب الوضع الحالي، ثم تنفّذ الإرسال المناسب */
async function handleNotifySendClick() {
    const statusEl = document.getElementById('notifyStatus');
    const messageInput = document.getElementById('notifyMessageInput');
    const sendBtn = document.getElementById('notifySendBtn');
    const message = (messageInput ? messageInput.value : '').trim();

    if (!message) {
        setStatusText(statusEl, 'اكتب نص الرسالة الأول.', 'error');
        return;
    }

    if (notifyMode === 'single' && !notifySelectedUser) {
        setStatusText(statusEl, 'اختار مستخدم الأول من نتائج البحث.', 'error');
        return;
    }

    if (notifyMode === 'broadcast') {
        // البث بيوصل لكل المستخدمين المسجلين دفعة واحدة - تأكيد إضافي
        // قبل التنفيذ عشان منبعتش بالغلط لكل حد بضغطة واحدة
        const confirmed = window.confirm('متأكد إنك عايز تبعت الرسالة دي لكل المستخدمين المسجّلين؟');
        if (!confirmed) return;
    }

    if (sendBtn) sendBtn.disabled = true;
    setStatusText(statusEl, 'جاري الإرسال…', 'loading');

    const succeeded = notifyMode === 'broadcast'
        ? await sendAdminNotificationBroadcast(message)
        : await sendAdminNotificationToUser(notifySelectedUser.id, message);

    if (sendBtn) sendBtn.disabled = false;

    if (!succeeded) {
        setStatusText(statusEl, 'تعذّر إرسال الإشعار. حاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, 'اتبعت بنجاح ✓', 'success');
    if (messageInput) messageInput.value = '';
    if (notifyMode === 'single') clearNotifyRecipient();
}


/* ==================================================================
   3ج) Widget: البانر العلوي في الصفحة الرئيسية (المرحلة 4)
   ------------------------------------------------------------------
   بيدير home_banner (صف واحد id=1) عن طريق admin_update_home_banner
   RPC بس - مفيش .update() مباشر عليه خالص (شوف sql/phase-4-banner.sql).
   رفع الصورة بيحصل فورًا وقت الاختيار (مش وقت الحفظ) على Storage
   bucket "banners"، والمعاينة الحية (#bannerPreviewBox) بتتحدث مع أي
   تغيير - صورة أو نص - قبل ما تضغط "حفظ ونشر" أصلاً. index.html بيقرا
   نفس الجدول مباشرة (SELECT عام) ويشترك في Realtime عليه من
   js/banner.js عشان أي حفظ هنا يوصله لحظياً.
   ================================================================== */

// أقصى حجم مسموح بيه لصورة البانر (بالبايت) - خط دفاع إضافي في الفرونت
// إند قبل الرفع، منعاً لصورة ضخمة تبطّئ تحميل الصفحة الرئيسية لكل
// المستخدمين
const BANNER_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 ميجا

// image_url الحالي (المرفوع فعلاً على Storage، محفوظ أو لسه مش
// محفوظ) - بنحتفظ بيه هنا لوحده (مش في input مخفي) عشان نقدر نبني
// المعاينة الحية ونبعته وقت الحفظ مع بعض
let bannerCurrentImageUrl = null;

// [تعديل] تحديد الجزء الظاهر من الصورة / ظلام الصورة / لون النص - نفس
// فلسفة bannerCurrentImageUrl فوق: حالة محفوظة هنا لوحدها عشان نبني بيها
// المعاينة الحية أول بأول ونبعتها وقت الحفظ مع باقي القيم. القيم دي
// بتتبعت لعمود image_position / overlay_opacity / text_color في
// home_banner عن طريق admin_update_home_banner RPC (لازم يتضاف لها
// باراميترز جديدة - شوف sql/phase-4-banner.sql). bannerImagePosition
// بقى بيتحدد بالسحب الحر فوق المعاينة (initBannerPositionDrag) بدل
// شبكة أزرار 3×3 ثابتة، فقيمته أي "X% Y%" ضمن 0-100 مش مجرد 9 قيم محددة
const BANNER_DEFAULT_POSITION = '50% 50%';
const BANNER_DEFAULT_OVERLAY_OPACITY = 40; // 0-100
const BANNER_DEFAULT_TEXT_COLOR = '#ffffff';

let bannerImagePosition = BANNER_DEFAULT_POSITION;
let bannerOverlayOpacity = BANNER_DEFAULT_OVERLAY_OPACITY;
let bannerTextColor = BANNER_DEFAULT_TEXT_COLOR;

/** تجيب الصف الحالي من home_banner وتملأ الويدجت بيه */
async function loadHomeBanner() {
    const statusEl = document.getElementById('bannerStatus');
    setStatusText(statusEl, 'جاري تحميل البانر…', 'loading');

    const { data, error } = await supabaseClient
        .from('home_banner')
        .select('image_url, banner_text, is_active, image_position, overlay_opacity, text_color')
        .eq('id', 1)
        .single();

    if (error || !data) {
        console.error('[admin.js] فشل تحميل home_banner:', error);
        setStatusText(statusEl, 'تعذّر تحميل البانر الحالي. حاول تعمل تحديث للصفحة.', 'error');
        return;
    }

    bannerCurrentImageUrl = data.image_url || null;
    // [تعديل] لو الصف قديم من قبل إضافة الأعمدة الجديدة (null) بنرجع
    // للقيم الافتراضية بدل ما نسيب البانر بلا موضع/تعتيم/لون
    bannerImagePosition = data.image_position || BANNER_DEFAULT_POSITION;
    bannerOverlayOpacity = (data.overlay_opacity ?? BANNER_DEFAULT_OVERLAY_OPACITY);
    bannerTextColor = data.text_color || BANNER_DEFAULT_TEXT_COLOR;

    const textInput = document.getElementById('bannerTextInput');
    const activeToggle = document.getElementById('bannerActiveToggle');
    if (textInput) textInput.value = data.banner_text || '';
    if (activeToggle) activeToggle.checked = Boolean(data.is_active);

    syncBannerOverlayInputUI();
    syncBannerTextColorInputUI();

    updateBannerRemoveButtonVisibility();
    updateBannerPreview();
    setStatusText(statusEl, '', null);
}

/** ترسم/تحدّث معاينة #bannerPreviewBox حسب الصورة والنص الحاليين (قبل الحفظ حتى) */
function updateBannerPreview() {
    const previewBox = document.getElementById('bannerPreviewBox');
    const previewImg = document.getElementById('bannerPreviewImage');
    const previewOverlay = document.getElementById('bannerPreviewOverlay');
    const previewText = document.getElementById('bannerPreviewText');
    const textInput = document.getElementById('bannerTextInput');

    const text = textInput ? textInput.value.trim() : '';

    if (previewImg) {
        if (bannerCurrentImageUrl) {
            previewImg.src = bannerCurrentImageUrl;
            previewImg.classList.remove('hidden');
            // [تعديل] الجزء الظاهر من الصورة - نفس القيمة اللي هتتبعت
            // للمستخدمين، مطبّقة هنا Inline عشان المعاينة تبقى مطابقة
            previewImg.style.objectPosition = bannerImagePosition;
        } else {
            previewImg.src = '';
            previewImg.classList.add('hidden');
        }
    }

    // [تعديل] ظلام الصورة - طبقة تعتيم شفافيتها بتتغير حسب السلايدر،
    // ومعندهاش معنى غير مع وجود صورة فعلاً (بانر النص بس بياخد خلفية
    // متدرجة بدل كده - شوف .home-banner.is-text-only في style.css)
    if (previewOverlay) {
        const opacity = bannerCurrentImageUrl ? (bannerOverlayOpacity / 100) : 0;
        previewOverlay.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;
    }

    if (previewText) {
        previewText.textContent = text;
        // [تعديل] لون النص - مطبّق دايماً (مع الصورة أو مع الخلفية
        // المتدرجة لبانر النص بس)
        previewText.style.color = bannerTextColor;
    }
    if (previewBox) previewBox.classList.toggle('has-content', Boolean(bannerCurrentImageUrl || text));

    // [تعديل] نقطة السحب بتتزامن هنا كمان عشان أي تغيير في bannerCurrentImageUrl
    // (رفع/إزالة صورة) يظهر/يخفي الطبقة أول بأول من غير ما نكرر النداء في كل مكان
    syncBannerPositionHandleUI();
}

/**
 * [تعديل] بديل syncBannerPositionGridUI القديمة (كانت بتفعّل الزرار المطابق
 * في شبكة الـ 3×3). دلوقتي بتحرّك نقطة السحب #bannerPositionHandle لمكانها
 * الصح حسب bannerImagePosition، وتحدّث القراءة النصية جنبها، وتظهر/تخفي
 * طبقة السحب #bannerPositionLayer كلها حسب وجود صورة من عدمه (زي حالة
 * disabled بتاعة الأزرار القديمة بالظبط)
 */
function syncBannerPositionHandleUI() {
    const layer = document.getElementById('bannerPositionLayer');
    const handle = document.getElementById('bannerPositionHandle');
    const valueEl = document.getElementById('bannerPositionValue');
    const hasImage = Boolean(bannerCurrentImageUrl);
    const { x, y } = parseBannerPosition(bannerImagePosition);

    if (layer) {
        layer.classList.toggle('hidden', !hasImage);
        layer.setAttribute('aria-valuenow', hasImage ? String(Math.round(x)) : '');
    }
    if (handle) {
        handle.style.left = `${x}%`;
        handle.style.top = `${y}%`;
    }
    if (valueEl) {
        valueEl.textContent = `${Math.round(x)}%، ${Math.round(y)}%`;
    }
}

/**
 * [تعديل] بتحوّل قيمة object-position المخزّنة ("X% Y%") لرقمين 0-100
 * قابلين للاستخدام في تحريك نقطة السحب - أي قيمة ناقصة أو مش رقم بترجع
 * للنص (50) عشان منوقعش في NaN تكسر الـ CSS
 * @param {string} value
 * @returns {{x: number, y: number}}
 */
function parseBannerPosition(value) {
    const parts = String(value || '').trim().split(/\s+/);
    const parseAxis = (token) => {
        const num = parseFloat(token);
        return Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : 50;
    };
    return {
        x: parts[0] !== undefined ? parseAxis(parts[0]) : 50,
        y: parts[1] !== undefined ? parseAxis(parts[1]) : 50,
    };
}

/** بتزامن سلايدر ظلام الصورة + الرقم الظاهر جنبه مع bannerOverlayOpacity الحالية */
function syncBannerOverlayInputUI() {
    const overlayInput = document.getElementById('bannerOverlayInput');
    const overlayValue = document.getElementById('bannerOverlayValue');
    if (overlayInput) overlayInput.value = String(bannerOverlayOpacity);
    if (overlayValue) overlayValue.textContent = `${bannerOverlayOpacity}%`;
}

/** بتزامن منتقي لون النص مع bannerTextColor الحالي */
function syncBannerTextColorInputUI() {
    const colorInput = document.getElementById('bannerTextColorInput');
    if (colorInput) colorInput.value = bannerTextColor;
}

/**
 * [تعديل] بتربط أحداث السحب (Pointer Events - موحّدة لماوس/لمس/قلم) على
 * #bannerPositionLayer عشان الأدمن يقدر يسحب نقطة التحكم فوق المعاينة
 * نفسها لتحديد bannerImagePosition بحرية (مش خطوات ثابتة زي شبكة الـ 3×3
 * القديمة). بتتنادى مرة واحدة بس من initHomeBannerWidget.
 *
 * ملاحظات:
 *  - setPointerCapture بيضمن إن pointermove/pointerup يوصلوا لنفس العنصر
 *    حتى لو المؤشر خرج بره حدود الطبقة أثناء السحب (سحب سريع/لمس)
 *  - الطبقة نفسها بتتخفي (كلاس hidden) لما مفيش صورة - شوف
 *    syncBannerPositionHandleUI - فمفيش داعي نتأكد من bannerCurrentImageUrl
 *    في pointermove/keydown، بس بنتأكد منه في بداية كل تفاعل (pointerdown/keydown)
 *    احتياطياً لأي حالة سباق (مثلاً إزالة الصورة أثناء سحب شغال بالفعل)
 *  - الأسهم (Arrow keys) + Home بديل السحب لمستخدمي لوحة المفاتيح، بخطوة
 *    ثابتة 5% - كانت الأزرار القديمة متاحة بلوحة المفاتيح تلقائياً بحكم
 *    إنها <button>، فده تعويض لازم مع طبقة السحب الحرة الجديدة
 */
function initBannerPositionDrag() {
    const layer = document.getElementById('bannerPositionLayer');
    if (!layer) return;

    let dragging = false;

    /** بتحسب %/% من مكان المؤشر نسبةً لحدود الطبقة، وتحدّث الحالة + المعاينة فوراً */
    const setPositionFromEvent = (event) => {
        const rect = layer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const rawX = ((event.clientX - rect.left) / rect.width) * 100;
        const rawY = ((event.clientY - rect.top) / rect.height) * 100;
        const x = Math.min(100, Math.max(0, rawX));
        const y = Math.min(100, Math.max(0, rawY));

        bannerImagePosition = `${Math.round(x)}% ${Math.round(y)}%`;

        // [تعديل] تحديث object-position على صورة المعاينة مباشرة هنا (Inline)
        // عشان السحب يحس إنه سلس لحظياً، من غير ما ننتظر updateBannerPreview
        // الكاملة تتنفذ مع كل حركة بكسل
        const previewImg = document.getElementById('bannerPreviewImage');
        if (previewImg) previewImg.style.objectPosition = bannerImagePosition;
        syncBannerPositionHandleUI();
    };

    layer.addEventListener('pointerdown', (event) => {
        if (!bannerCurrentImageUrl) return; // مفيش صورة أصلاً نتحكم في موضعها
        dragging = true;
        layer.classList.add('is-dragging');
        layer.setPointerCapture(event.pointerId);
        layer.focus();
        setPositionFromEvent(event);
        event.preventDefault();
    });

    layer.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        setPositionFromEvent(event);
    });

    const endDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        layer.classList.remove('is-dragging');
        try {
            layer.releasePointerCapture(event.pointerId);
        } catch (e) {
            // متجاهل - ممكن يكون الالتقاط اتشال أصلاً (مثلاً pointercancel)
        }
    };
    layer.addEventListener('pointerup', endDrag);
    layer.addEventListener('pointercancel', endDrag);

    layer.addEventListener('keydown', (event) => {
        if (!bannerCurrentImageUrl) return;

        const step = 5;
        const { x, y } = parseBannerPosition(bannerImagePosition);
        let nextX = x;
        let nextY = y;

        switch (event.key) {
            case 'ArrowLeft': nextX = x - step; break;
            case 'ArrowRight': nextX = x + step; break;
            case 'ArrowUp': nextY = y - step; break;
            case 'ArrowDown': nextY = y + step; break;
            case 'Home': nextX = 50; nextY = 50; break;
            default: return; // مفتاح تاني مش من دول - سيبه يعدي عادي
        }

        event.preventDefault();
        nextX = Math.min(100, Math.max(0, nextX));
        nextY = Math.min(100, Math.max(0, nextY));
        bannerImagePosition = `${Math.round(nextX)}% ${Math.round(nextY)}%`;
        updateBannerPreview();
    });
}

/** بتظهر/تخفي زرار "إزالة الصورة" حسب وجود صورة حالية من عدمه */
function updateBannerRemoveButtonVisibility() {
    const removeBtn = document.getElementById('bannerRemoveImageBtn');
    if (removeBtn) removeBtn.classList.toggle('hidden', !bannerCurrentImageUrl);
}

/**
 * بترفع صورة جديدة على Storage bucket "banners" (اسم فريد بالتاريخ
 * عشان منكسرش أي كاش قديم لنفس الاسم) وترجّع رابطها العام، أو null
 * لو فشل الرفع لأي سبب
 * @param {File} file
 * @returns {Promise<string|null>}
 */
async function uploadBannerImage(file) {
    const statusEl = document.getElementById('bannerStatus');

    if (file.size > BANNER_MAX_IMAGE_SIZE_BYTES) {
        setStatusText(statusEl, 'حجم الصورة أكبر من 5 ميجا - اختار صورة أصغر.', 'error');
        return null;
    }

    setStatusText(statusEl, 'جاري رفع الصورة…', 'loading');

    const fileExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const filePath = `banner-${Date.now()}.${fileExt}`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('banners')
        .upload(filePath, file, { upsert: false });

    if (uploadError) {
        console.error('[admin.js] فشل رفع صورة البانر:', uploadError);
        setStatusText(statusEl, 'تعذّر رفع الصورة. حاول تاني.', 'error');
        return null;
    }

    const { data: publicUrlData } = supabaseClient
        .storage
        .from('banners')
        .getPublicUrl(filePath);

    setStatusText(statusEl, '', null);
    return publicUrlData ? publicUrlData.publicUrl : null;
}

/** الحفظ الفعلي - بيعدّي عن طريق admin_update_home_banner RPC بس (مفيش .update() مباشر) */
async function saveHomeBanner() {
    const statusEl = document.getElementById('bannerStatus');
    const saveBtn = document.getElementById('bannerSaveBtn');
    const textInput = document.getElementById('bannerTextInput');
    const activeToggle = document.getElementById('bannerActiveToggle');

    const bannerText = textInput ? textInput.value.trim() : '';

    if (saveBtn) saveBtn.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const { error } = await supabaseClient.rpc('admin_update_home_banner', {
        p_image_url: bannerCurrentImageUrl,
        p_banner_text: bannerText || null,
        p_is_active: activeToggle ? activeToggle.checked : false,
        // [تعديل] الجزء الظاهر من الصورة / ظلام الصورة / لون النص -
        // لازم admin_update_home_banner RPC تتعدّل تستقبل الباراميترز
        // الجديدة دي (شوف sql/phase-4-banner.sql)
        p_image_position: bannerImagePosition,
        p_overlay_opacity: bannerOverlayOpacity,
        p_text_color: bannerTextColor,
    });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل حفظ البانر:', error);
        setStatusText(statusEl, 'حصل خطأ أثناء الحفظ. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, 'اتحفظ ونُشر بنجاح ✓', 'success');
}

/** ربط أحداث ويدجت البانر (رفع صورة، إزالتها، تحديث المعاينة، الحفظ) - تُستدعى مرة واحدة من initAdminPage */
function initHomeBannerWidget() {
    const uploadBtn = document.getElementById('bannerUploadBtn');
    const imageInput = document.getElementById('bannerImageInput');
    const removeImageBtn = document.getElementById('bannerRemoveImageBtn');
    const textInput = document.getElementById('bannerTextInput');
    const saveBtn = document.getElementById('bannerSaveBtn');

    if (uploadBtn && imageInput) {
        uploadBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', async () => {
            const file = imageInput.files && imageInput.files[0];
            imageInput.value = ''; // يسمح باختيار نفس الملف تاني لو احتاج الأدمن كده
            if (!file) return;

            const uploadedUrl = await uploadBannerImage(file);
            if (!uploadedUrl) return;

            bannerCurrentImageUrl = uploadedUrl;
            updateBannerRemoveButtonVisibility();
            updateBannerPreview();
        });
    }

    if (removeImageBtn) {
        // بتشيل الصورة من المعاينة/القيمة اللي هتتحفظ بس - الملف القديم
        // نفسه بيفضل موجود في Storage (مش بنعمل .remove() ليه هنا) لحد
        // ما الحفظ يتأكد فعلاً، بنفس فلسفة "الحفظ هو اللي بيثبّت التغيير"
        removeImageBtn.addEventListener('click', () => {
            bannerCurrentImageUrl = null;
            updateBannerRemoveButtonVisibility();
            updateBannerPreview();
        });
    }

    if (textInput) {
        textInput.addEventListener('input', updateBannerPreview);
    }

    // [تعديل] طبقة سحب الجزء الظاهر من الصورة - بديل شبكة الأزرار القديمة
    initBannerPositionDrag();

    // [تعديل] سلايدر ظلام الصورة
    const overlayInput = document.getElementById('bannerOverlayInput');
    if (overlayInput) {
        overlayInput.addEventListener('input', () => {
            bannerOverlayOpacity = Number(overlayInput.value);
            const overlayValue = document.getElementById('bannerOverlayValue');
            if (overlayValue) overlayValue.textContent = `${bannerOverlayOpacity}%`;
            updateBannerPreview();
        });
    }

    // [تعديل] منتقي لون النص
    const colorInput = document.getElementById('bannerTextColorInput');
    if (colorInput) {
        colorInput.addEventListener('input', () => {
            bannerTextColor = colorInput.value;
            updateBannerPreview();
        });
    }

    // [تعديل] زرار "حفظ ونشر" - كان الـ listener ده ناقص، فالزرار
    // كان مش بيعمل أي حاجة خالص لما تدوس عليه
    if (saveBtn) {
        saveBtn.addEventListener('click', saveHomeBanner);
    }

    loadHomeBanner();
}


/* ==================================================================
   3د) Widget: هوية "سِكّاوي" القابلة للتحكم (المرحلة 6)
   ------------------------------------------------------------------
   بيدير app_identity (صف واحد Singleton، id=true) عن طريق
   admin_update_app_identity RPC بس - مفيش .update() مباشر عليه خالص
   (نفس فلسفة home_banner - شوف sql/phase-6-app-identity.sql). صورة
   الأفاتار بترفع فورًا وقت "اعتماد القص" (مش وقت "حفظ الهوية") على
   نفس bucket "post-images" المستخدم لصور المنشورات (نفس الـ storage
   policy بتاعة الأدمن اللي اتعملت في الجزء أ كفاية، مفيش داعي لـ
   bucket جديد). القص الدائري بيحصل بمكتبة Cropper.js (CDN، شوف
   admin.html) - النتيجة النهائية Canvas مربع 256×256 بيتحفظ كملف PNG
   عادي، والدائرية نفسها بصرية بس (CSS border-radius: 50% زي أي أفاتار
   عادي في التطبيق، مش قص حقيقي في بيانات الصورة).
   ================================================================== */

const IDENTITY_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 ميجا
const IDENTITY_CROP_OUTPUT_SIZE = 256; // بكسل - مربع، عرض وارتفاع الـ Canvas النهائي

// avatar_url المحفوظ فعلاً/الجديد المرفوع (لسه مش محفوظ بالـ RPC) -
// بنفس فلسفة bannerCurrentImageUrl/postCreateImageUrl تمامًا
let identityCurrentAvatarUrl = null;

// نسخة Cropper.js الحالية - null لما منطقة القص مقفولة (مفيش صورة
// بتتقص دلوقتي)
let identityCropperInstance = null;

/** تجيب الصف الوحيد من app_identity وتملأ بيه الويدجت + معاينة المنشور الحية */
async function loadAppIdentity() {
    const statusEl = document.getElementById('identityStatus');
    setStatusText(statusEl, 'جاري تحميل الهوية…', 'loading');

    const { data, error } = await supabaseClient
        .from('app_identity')
        .select('display_name, avatar_url')
        .eq('id', true)
        .single();

    if (error || !data) {
        console.error('[admin.js] فشل تحميل app_identity:', error);
        setStatusText(statusEl, 'تعذّر تحميل الهوية الحالية. حاول تعمل تحديث للصفحة.', 'error');
        return;
    }

    identityCurrentAvatarUrl = data.avatar_url || null;

    const nameInput = document.getElementById('identityNameInput');
    if (nameInput) nameInput.value = data.display_name || '';

    updateIdentityRemoveButtonVisibility();
    syncIdentityAvatarPreview();
    setStatusText(statusEl, '', null);
}

/**
 * بتحدّث كل الأماكن اللي بتعرض أفاتار/اسم التطبيق حالياً في صفحة
 * الأدمن نفسها: أفاتار الويدجت + هيدر معاينة "نشر منشور جديد" الحية -
 * مركزية بدل ما نكررها في كل نداء
 */
function syncIdentityAvatarPreview() {
    const nameInput = document.getElementById('identityNameInput');
    const displayName = (nameInput && nameInput.value.trim()) || 'سِكّاوي';
    const initial = (displayName.trim()[0] || 'س').toUpperCase();

    [
        { img: 'identityAvatarPreview', fallback: 'identityAvatarFallback' },
        { img: 'postCreatePreviewAvatarImg', fallback: 'postCreatePreviewAvatarFallback' },
    ].forEach(({ img, fallback }) => {
        const imgEl = document.getElementById(img);
        const fallbackEl = document.getElementById(fallback);
        if (imgEl) {
            if (identityCurrentAvatarUrl) {
                imgEl.src = identityCurrentAvatarUrl;
                imgEl.classList.remove('hidden');
            } else {
                imgEl.src = '';
                imgEl.classList.add('hidden');
            }
        }
        if (fallbackEl) {
            fallbackEl.textContent = initial;
            fallbackEl.classList.toggle('hidden', Boolean(identityCurrentAvatarUrl));
        }
    });

    const nameLabelEl = document.getElementById('postCreatePreviewAppName');
    if (nameLabelEl) nameLabelEl.textContent = displayName;
}

/** بتظهر/تخفي زرار "إزالة الصورة" حسب وجود أفاتار حالي من عدمه */
function updateIdentityRemoveButtonVisibility() {
    const removeBtn = document.getElementById('identityRemoveAvatarBtn');
    if (removeBtn) removeBtn.classList.toggle('hidden', !identityCurrentAvatarUrl);
}

/**
 * بتفتح منطقة القص وتهيّئ Cropper.js على الصورة المختارة (Object URL
 * محلي - لسه مفيش أي رفع حصل) بنسبة عرض/ارتفاع 1:1 ثابتة (مربع، عشان
 * القص الدائري بعدين يبقى دائرة مظبوطة مش بيضاوية)
 * @param {File} file
 */
function openIdentityCropper(file) {
    const cropArea = document.getElementById('identityCropArea');
    const cropImage = document.getElementById('identityCropImage');
    if (!cropArea || !cropImage || typeof Cropper === 'undefined') return;

    // أي نسخة قديمة شغالة (لو المستخدم اختار صورة تانية من غير ما يعتمد
    // أو يلغي الأولى) - بنقفلها الأول عشان منسربش نسخ Cropper فوق بعض
    destroyIdentityCropper();

    const objectUrl = URL.createObjectURL(file);
    cropImage.src = objectUrl;
    cropArea.classList.remove('hidden');

    cropImage.onload = () => {
        identityCropperInstance = new Cropper(cropImage, {
            aspectRatio: 1,
            viewMode: 1,
            dragMode: 'move',
            autoCropArea: 1,
            cropBoxMovable: false,
            cropBoxResizable: false,
            background: false,
        });
    };
}

/** بتقفل منطقة القص وتتخلص من نسخة Cropper الحالية (لو موجودة) ومن الـ Object URL المؤقت */
function destroyIdentityCropper() {
    const cropArea = document.getElementById('identityCropArea');
    const cropImage = document.getElementById('identityCropImage');

    if (identityCropperInstance) {
        identityCropperInstance.destroy();
        identityCropperInstance = null;
    }
    if (cropImage && cropImage.src && cropImage.src.startsWith('blob:')) {
        URL.revokeObjectURL(cropImage.src);
    }
    if (cropImage) cropImage.src = '';
    if (cropArea) cropArea.classList.add('hidden');
}

/**
 * بتاخد الـ Canvas المقصوص من Cropper الحالي، تحوّله لملف PNG، وترفعه
 * على Storage bucket "post-images" (نفس bucket صور المنشورات) باسم
 * فريد بالتاريخ - وترجّع رابطه العام، أو null لو فشل أي جزء
 * @returns {Promise<string|null>}
 */
async function uploadCroppedIdentityAvatar() {
    const statusEl = document.getElementById('identityStatus');
    if (!identityCropperInstance) return null;

    const canvas = identityCropperInstance.getCroppedCanvas({
        width: IDENTITY_CROP_OUTPUT_SIZE,
        height: IDENTITY_CROP_OUTPUT_SIZE,
        imageSmoothingQuality: 'high',
    });
    if (!canvas) {
        setStatusText(statusEl, 'تعذّر قص الصورة. حاول تاني.', 'error');
        return null;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.92));
    if (!blob) {
        setStatusText(statusEl, 'تعذّر قص الصورة. حاول تاني.', 'error');
        return null;
    }
    if (blob.size > IDENTITY_MAX_IMAGE_SIZE_BYTES) {
        setStatusText(statusEl, 'حجم الصورة بعد القص أكبر من 5 ميجا - اختار صورة أصغر.', 'error');
        return null;
    }

    setStatusText(statusEl, 'جاري رفع الصورة…', 'loading');

    const filePath = `identity-${Date.now()}.png`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('post-images')
        .upload(filePath, blob, { upsert: false, contentType: 'image/png' });

    if (uploadError) {
        console.error('[admin.js] فشل رفع صورة هوية التطبيق:', uploadError);
        setStatusText(statusEl, 'تعذّر رفع الصورة. حاول تاني.', 'error');
        return null;
    }

    const { data: publicUrlData } = supabaseClient
        .storage
        .from('post-images')
        .getPublicUrl(filePath);

    setStatusText(statusEl, '', null);
    return publicUrlData ? publicUrlData.publicUrl : null;
}

/** الحفظ الفعلي - عن طريق admin_update_app_identity RPC بس */
async function saveAppIdentity() {
    const statusEl = document.getElementById('identityStatus');
    const saveBtn = document.getElementById('identitySaveBtn');
    const nameInput = document.getElementById('identityNameInput');

    const displayName = nameInput ? nameInput.value.trim() : '';

    if (saveBtn) saveBtn.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const { error } = await supabaseClient.rpc('admin_update_app_identity', {
        p_display_name: displayName || 'سِكّاوي',
        p_avatar_url: identityCurrentAvatarUrl,
    });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل حفظ هوية التطبيق:', error);
        setStatusText(statusEl, 'حصل خطأ أثناء الحفظ. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, 'اتحفظت الهوية بنجاح ✓', 'success');
}

/** ربط أحداث ويدجت الهوية (رفع صورة، قص، إزالة، حفظ) - تُستدعى مرة واحدة من initAdminPage */
function initAppIdentityWidget() {
    const uploadBtn = document.getElementById('identityUploadBtn');
    const imageInput = document.getElementById('identityImageInput');
    const removeBtn = document.getElementById('identityRemoveAvatarBtn');
    const nameInput = document.getElementById('identityNameInput');
    const saveBtn = document.getElementById('identitySaveBtn');
    const cropConfirmBtn = document.getElementById('identityCropConfirmBtn');
    const cropCancelBtn = document.getElementById('identityCropCancelBtn');

    if (uploadBtn && imageInput) {
        uploadBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', () => {
            const file = imageInput.files && imageInput.files[0];
            imageInput.value = ''; // يسمح باختيار نفس الملف تاني لو احتاج الأدمن كده

            if (!file) return;

            if (file.size > IDENTITY_MAX_IMAGE_SIZE_BYTES) {
                setStatusText(document.getElementById('identityStatus'), 'حجم الصورة أكبر من 5 ميجا - اختار صورة أصغر.', 'error');
                return;
            }

            openIdentityCropper(file);
        });
    }

    if (cropConfirmBtn) {
        cropConfirmBtn.addEventListener('click', async () => {
            cropConfirmBtn.disabled = true;
            const uploadedUrl = await uploadCroppedIdentityAvatar();
            cropConfirmBtn.disabled = false;

            if (!uploadedUrl) return;

            identityCurrentAvatarUrl = uploadedUrl;
            destroyIdentityCropper();
            updateIdentityRemoveButtonVisibility();
            syncIdentityAvatarPreview();
        });
    }

    if (cropCancelBtn) {
        cropCancelBtn.addEventListener('click', () => {
            destroyIdentityCropper();
        });
    }

    if (removeBtn) {
        // بتشيل الأفاتار من المعاينة/القيمة اللي هتتحفظ بس - نفس فلسفة
        // bannerRemoveImageBtn: الملف القديم بيفضل موجود في Storage
        // (مش بنعمل .remove() ليه هنا) لحد ما "حفظ الهوية" يتأكد فعلاً
        removeBtn.addEventListener('click', () => {
            identityCurrentAvatarUrl = null;
            updateIdentityRemoveButtonVisibility();
            syncIdentityAvatarPreview();
        });
    }

    if (nameInput) {
        // تحديث حي لحرف الأفاتار الافتراضي + اسم المعاينة مع الكتابة،
        // من غير أي نداء لـ Supabase لحد ما يضغط "حفظ الهوية"
        nameInput.addEventListener('input', syncIdentityAvatarPreview);
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', saveAppIdentity);
    }

    loadAppIdentity();
}


/* ==================================================================
   3ه) Widget: نشر/إدارة المنشورات (المرحلة 5، خطوة 25)
   ------------------------------------------------------------------
   النشر والحذف بيعدّوا بس عن طريق admin_create_post / admin_delete_post
   RPC (مفيش .insert()/.delete() مباشر على posts - شوف
   sql/phase-5-posts-admin.sql، RLS الجدول بيمنع غير الأدمن أصلاً).
   المعاينة الحية (#postCreatePreviewBox) بتستخدم بالظبط نفس كلاسات
   .post-card المستخدمة في posts.js/style.css عشان تبان مطابقة تماماً
   لشكل الكارت عند المستخدمين. رفع الصورة بيحصل فورًا وقت الاختيار
   (زي uploadBannerImage بالظبط) على bucket "post-images" جديد.
   ================================================================== */

const POST_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 ميجا
const POST_CONTENT_MAX_LENGTH = 2000;

// image_url الحالي للمنشور اللي بيتكتب دلوقتي (لسه مش منشور) - بنفس
// فلسفة bannerCurrentImageUrl، بس هنا بيترجع null بعد كل نشر ناجح
// عشان الفورم يفضى لمنشور جديد
let postCreateImageUrl = null;

/** ترسم/تحدّث معاينة #postCreatePreviewBox حسب النص والصورة الحاليين (قبل النشر حتى) */
function updatePostCreatePreview() {
    const contentInput = document.getElementById('postContentInput');
    const previewContent = document.getElementById('postCreatePreviewContent');
    const previewImage = document.getElementById('postCreatePreviewImage');
    const previewEmpty = document.getElementById('postCreatePreviewEmpty');

    const text = contentInput ? contentInput.value.trim() : '';

    if (previewContent) {
        previewContent.textContent = text;
        previewContent.classList.toggle('hidden', !text);
    }
    if (previewImage) {
        if (postCreateImageUrl) {
            previewImage.src = postCreateImageUrl;
            previewImage.classList.remove('hidden');
        } else {
            previewImage.src = '';
            previewImage.classList.add('hidden');
        }
    }
    if (previewEmpty) {
        previewEmpty.classList.toggle('hidden', Boolean(text || postCreateImageUrl));
    }
}

/** بتظهر/تخفي زرار "إزالة الصورة" حسب وجود صورة مختارة من عدمه */
function updatePostRemoveButtonVisibility() {
    const removeBtn = document.getElementById('postRemoveImageBtn');
    if (removeBtn) removeBtn.classList.toggle('hidden', !postCreateImageUrl);
}

/**
 * بترفع صورة جديدة على Storage bucket "post-images" (اسم فريد بالتاريخ)
 * وترجّع رابطها العام، أو null لو فشل الرفع لأي سبب
 * @param {File} file
 * @returns {Promise<string|null>}
 */
async function uploadPostImage(file) {
    const statusEl = document.getElementById('postCreateStatus');

    if (file.size > POST_MAX_IMAGE_SIZE_BYTES) {
        setStatusText(statusEl, 'حجم الصورة أكبر من 5 ميجا - اختار صورة أصغر.', 'error');
        return null;
    }

    setStatusText(statusEl, 'جاري رفع الصورة…', 'loading');

    const fileExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const filePath = `post-${Date.now()}.${fileExt}`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('post-images')
        .upload(filePath, file, { upsert: false });

    if (uploadError) {
        console.error('[admin.js] فشل رفع صورة المنشور:', uploadError);
        setStatusText(statusEl, 'تعذّر رفع الصورة. حاول تاني.', 'error');
        return null;
    }

    const { data: publicUrlData } = supabaseClient
        .storage
        .from('post-images')
        .getPublicUrl(filePath);

    setStatusText(statusEl, '', null);
    return publicUrlData ? publicUrlData.publicUrl : null;
}

/** النشر الفعلي - عن طريق admin_create_post RPC بس */
async function publishPost() {
    const statusEl = document.getElementById('postCreateStatus');
    const publishBtn = document.getElementById('postPublishBtn');
    const contentInput = document.getElementById('postContentInput');

    const content = contentInput ? contentInput.value.trim() : '';

    if (!content && !postCreateImageUrl) {
        setStatusText(statusEl, 'اكتب نص أو ارفع صورة الأول.', 'error');
        return;
    }

    if (publishBtn) publishBtn.disabled = true;
    setStatusText(statusEl, 'جاري النشر…', 'loading');

    const { error } = await supabaseClient.rpc('admin_create_post', {
        p_content: content || null,
        p_image_url: postCreateImageUrl,
    });

    if (publishBtn) publishBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل نشر المنشور:', error);
        setStatusText(statusEl, 'حصل خطأ أثناء النشر. تأكد إن عندك صلاحية أدمن وحاول تاني.', 'error');
        return;
    }

    // نفضّي الفورم بالكامل بعد النشر الناجح - المنشور مش صف واحد
    // بيتحدّث زي البانر، كل نشرة صف جديد، فمفيش داعي نسيب القيم القديمة
    if (contentInput) contentInput.value = '';
    postCreateImageUrl = null;
    updatePostRemoveButtonVisibility();
    updatePostCreatePreview();

    setStatusText(statusEl, 'اتنشر بنجاح ✓', 'success');
    loadRecentPostsForAdmin();
}

/** ربط أحداث ويدجت النشر (رفع صورة، إزالتها، تحديث المعاينة، النشر) */
function initPostCreateWidget() {
    const uploadBtn = document.getElementById('postImageUploadBtn');
    const imageInput = document.getElementById('postImageInput');
    const removeImageBtn = document.getElementById('postRemoveImageBtn');
    const contentInput = document.getElementById('postContentInput');
    const publishBtn = document.getElementById('postPublishBtn');

    if (uploadBtn && imageInput) {
        uploadBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', async () => {
            const file = imageInput.files && imageInput.files[0];
            imageInput.value = ''; // يسمح باختيار نفس الملف تاني لو احتاج الأدمن كده
            if (!file) return;

            const uploadedUrl = await uploadPostImage(file);
            if (!uploadedUrl) return;

            postCreateImageUrl = uploadedUrl;
            updatePostRemoveButtonVisibility();
            updatePostCreatePreview();
        });
    }

    if (removeImageBtn) {
        removeImageBtn.addEventListener('click', () => {
            postCreateImageUrl = null;
            updatePostRemoveButtonVisibility();
            updatePostCreatePreview();
        });
    }

    if (contentInput) {
        contentInput.addEventListener('input', updatePostCreatePreview);
    }

    if (publishBtn) {
        publishBtn.addEventListener('click', publishPost);
    }

    updatePostCreatePreview();
}

/** تجيب آخر 20 منشور وترسمهم في #postsManageList مع زرار حذف لكل واحد */
async function loadRecentPostsForAdmin() {
    const statusEl = document.getElementById('postsManageStatus');
    const listEl = document.getElementById('postsManageList');
    if (!listEl) return;

    setStatusText(statusEl, 'جاري تحميل المنشورات…', 'loading');

    const { data, error } = await supabaseClient
        .from('posts')
        .select('id, content, image_url, created_at')
        .order('created_at', { ascending: false })
        .limit(20);

    if (error) {
        console.error('[admin.js] فشل تحميل قائمة المنشورات:', error);
        setStatusText(statusEl, 'تعذّر تحميل المنشورات.', 'error');
        return;
    }

    renderAdminPostsList(data || []);
    setStatusText(statusEl, (data && data.length) ? '' : 'مفيش منشورات لسه.', (data && data.length) ? null : 'empty');
}

/** @param {Array<{id:string, content:string|null, image_url:string|null, created_at:string}>} posts */
function renderAdminPostsList(posts) {
    const listEl = document.getElementById('postsManageList');
    if (!listEl) return;

    listEl.innerHTML = '';

    posts.forEach((post) => {
        const li = document.createElement('li');
        li.className = 'admin-user-row';

        const timeText = escapeHtml(formatRelativeArabicTime(post.created_at));
        // معاينة نصية مختصرة (60 حرف) بدل النص كامل - القائمة دي للمراجعة
        // السريعة والحذف، مش لعرض المنشور كامل
        const rawExcerpt = (post.content || (post.image_url ? '(صورة بدون نص)' : '')).trim();
        const excerpt = rawExcerpt.length > 60 ? `${rawExcerpt.slice(0, 60)}…` : rawExcerpt;

        li.innerHTML = `
            ${post.image_url
                ? `<img class="admin-user-avatar" src="${post.image_url}" alt="" loading="lazy">`
                : `<span class="admin-user-avatar post-card-app-avatar" aria-hidden="true">س</span>`}
            <div class="admin-user-info">
                <div class="admin-user-name">${escapeHtml(excerpt) || '—'}</div>
                <div class="admin-user-username">${timeText}</div>
            </div>
            <div class="admin-user-actions">
                <button type="button" class="admin-notify-clear-btn post-delete-btn">حذف</button>
            </div>
        `;

        const deleteBtn = li.querySelector('.post-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => handleDeletePost(post.id, li));
        }

        listEl.appendChild(li);
    });
}

/** حذف منشور - عن طريق admin_delete_post RPC بس، بعد تأكيد من الأدمن */
async function handleDeletePost(postId, rowEl) {
    if (!window.confirm('تأكيد حذف المنشور ده؟ الحذف نهائي.')) return;

    const { error } = await supabaseClient.rpc('admin_delete_post', { p_post_id: postId });

    if (error) {
        console.error('[admin.js] فشل حذف المنشور:', error);
        window.alert('تعذّر حذف المنشور. حاول تاني.');
        return;
    }

    if (rowEl) rowEl.remove();

    const listEl = document.getElementById('postsManageList');
    const statusEl = document.getElementById('postsManageStatus');
    if (listEl && !listEl.children.length) {
        setStatusText(statusEl, 'مفيش منشورات لسه.', 'empty');
    }
}

/** تهيئة تاب المنشورات بالكامل - تُستدعى مرة واحدة من initAdminPage */
function initPostsWidget() {
    initPostCreateWidget();
    loadRecentPostsForAdmin();
}


/* ==================================================================
   3و) Widget: إدارة الأسئلة اليومية (المرحلة 6 + تحسينات المجموعة 1)
   ------------------------------------------------------------------
   بنك الأسئلة بالكامل بقى في جدول public.daily_questions (نص +
   اختيارات + إجابة صح + فئة + صعوبة)، والسيستم بيختار سؤالين مختلفين
   كل يوم تلقائياً عن طريق pg_cron (دالة pick_daily_questions - شوف
   sql/phase-6-daily-questions.sql). كل التعديل هنا بيعدّي عن طريق
   admin_create_daily_question / admin_update_daily_question /
   admin_set_daily_question_active / admin_delete_daily_question RPC
   بس - مفيش .insert()/.update() مباشر على daily_questions (RLS بيمنعه
   أصلاً، الجدول مقفول تماماً على المستخدم العادي).

   (تحسينات المجموعة 1) البحث/الفلترة بتشتغل بالكامل على القائمة
   المحمّلة أصلاً في المتصفح (allLoadedQuestions) - مفيش طلب شبكة
   إضافي لكل حرف يتكتب أو فلتر يتغيّر، شوف applyQuestionsListFilters.

   شكل كل سؤال ثابت: نص + 4 اختيارات (radio لتحديد الإجابة الصح) -
   نفس شكل DAILY_QUESTION_BANK القديم في daily-question.js بالظبط.
   ================================================================== */

const DAILY_QUESTION_OPTION_COUNT = 4;
const QUESTION_TEXT_MAX_LENGTH = 300;
const QUESTION_DIFFICULTY_LABELS = { easy: 'سهل', medium: 'متوسط', hard: 'صعب' };

/** (مجموعة 2) أقل عدد أسئلة مفعّلة قبل ما نبيّن تحذير فوق القائمة -
 *  مش رقم "سحري" دقيق، بس قيمة معقولة: بما إن السيستم بيسحب سؤالين
 *  مختلفين كل يوم من غير تكرار لحد ما البنك يدور بالكامل (شوف تعليق
 *  pick_daily_questions فوق)، لو العدد المفعّل قل عن كده البنك هيبدأ
 *  يكرر نفس الأسئلة كل كام يوم بس - عدّلها هنا لو حبيت رقم مختلف */
const MIN_ACTIVE_QUESTIONS_THRESHOLD = 6;

/** null = وضع "سؤال جديد" حاليًا، أو id السؤال اللي بيتعدّل دلوقتي */
let editingQuestionId = null;

/** IDs الأسئلة الظاهرة فعلاً النهاردة (Slot 1 و2) - بنجيبها مرة كل
 *  ما القائمة تتحمّل عشان نعرض وسم "ظاهر اليوم" على الصف المناسب،
 *  مفيش أي تعديل بيحصل هنا على الاختيار نفسه (ده شغل pick_daily_questions
 *  بس عن طريق pg_cron) */
let todaysQuestionIds = new Set();

/** (مجموعة 1) نسخة كاملة من آخر قائمة أسئلة جاية من السيرفر - مصدر
 *  الحقيقة اللي البحث/الفلترة بيشتغلوا عليه محلياً من غير ما يطلبوا
 *  الشبكة تاني في كل مرة */
let allLoadedQuestions = [];

/** (مجموعة 2) خريطة question_id → {totalAnswers, correctAnswers, correctPercentage}
 *  جاية من admin_get_question_answer_stats RPC - بتتحمّل مرة واحدة مع
 *  كل تحميل للقائمة وبتتربط بكل صف وقت الرسم (شوف renderQuestionsList).
 *  لو الـ RPC مش موجودة لسه (السكريبت sql/phase-7 لسه ما اتشغّلش) بتفضل
 *  فاضية والشارة بتتخفي بهدوء من غير ما تكسر باقي القائمة - شوف
 *  loadQuestionAnswerStats */
let questionAnswerStatsById = new Map();

/** بناء الـ 4 صفوف الثابتة لحقول الاختيارات مرة واحدة بس (بتتصفر
 *  قيمها بعد كده، مش بتتبني من جديد كل مرة) - كل صف فيه راديو مشترك
 *  الاسم (questionCorrectOption) لتحديد الإجابة الصح + حقل نص، وكل
 *  حقل مربوط بتحديث المعاينة الحية لحظيًا */
function buildQuestionOptionRows() {
    const container = document.getElementById('questionOptionsList');
    if (!container || container.children.length) return; // بُنيت بالفعل

    for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
        const row = document.createElement('div');
        row.className = 'admin-question-option-row';
        row.innerHTML = `
            <input type="radio" name="questionCorrectOption" value="${i}" id="questionOptionRadio${i}" class="admin-question-option-radio">
            <input type="text" id="questionOptionText${i}" maxlength="120"
                   class="admin-text-input flex-1" placeholder="نص الاختيار ${i}">
        `;
        container.appendChild(row);

        const radio = row.querySelector('input[type="radio"]');
        const textInput = row.querySelector('input[type="text"]');
        if (radio) radio.addEventListener('change', updateQuestionLivePreview);
        if (textInput) textInput.addEventListener('input', updateQuestionLivePreview);
    }
    // أول اختيار مُحدد افتراضيًا كإجابة صح (الأدمن يقدر يغيّره بسهولة،
    // بس منسيبش الفورم من غير أي راديو محدد خالص)
    const firstRadio = document.getElementById('questionOptionRadio1');
    if (firstRadio) firstRadio.checked = true;
}

/** قراءة قيم الفورم الحالية بشكل جاهز للإرسال لـ RPC - بيرجع null لو
 *  فيه نقص (نص فاضي في أي اختيار، أو نص السؤال فاضي) */
function getQuestionFormValues() {
    const textInput = document.getElementById('questionTextInput');
    const questionText = textInput ? textInput.value.trim() : '';
    if (!questionText) return null;

    const options = [];
    for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
        const optionInput = document.getElementById(`questionOptionText${i}`);
        const optionText = optionInput ? optionInput.value.trim() : '';
        if (!optionText) return null;
        options.push({ id: String(i), text: optionText });
    }

    const checkedRadio = document.querySelector('input[name="questionCorrectOption"]:checked');
    const correctOptionId = checkedRadio ? checkedRadio.value : null;
    if (!correctOptionId) return null;

    const categoryInput = document.getElementById('questionCategoryInput');
    const category = categoryInput ? categoryInput.value.trim() : '';

    const difficultyInput = document.getElementById('questionDifficultyInput');
    const difficulty = difficultyInput ? difficultyInput.value : 'medium';

    return { questionText, options, correctOptionId, category, difficulty };
}

/** (مجموعة 1) تحديث كارت المعاينة الحية (#questionPreviewCard) بنفس
 *  شكل كارت السؤال الحقيقي (dq-card/dq-options-grid/dq-option-card)
 *  حسب قيم الفورم الحالية - بتتنادى مع كل حرف يتكتب أو راديو يتغيّر */
function updateQuestionLivePreview() {
    const previewText = document.getElementById('questionPreviewText');
    const previewGrid = document.getElementById('questionPreviewOptionsGrid');
    if (!previewText || !previewGrid) return;

    const textInput = document.getElementById('questionTextInput');
    const questionText = textInput ? textInput.value.trim() : '';
    previewText.textContent = questionText || 'اكتب نص السؤال والاختيارات عشان تشوف شكله هنا';

    const checkedRadio = document.querySelector('input[name="questionCorrectOption"]:checked');
    const correctOptionId = checkedRadio ? checkedRadio.value : null;

    previewGrid.innerHTML = '';
    for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
        const optionInput = document.getElementById(`questionOptionText${i}`);
        const optionText = optionInput ? optionInput.value.trim() : '';
        if (!optionText) continue; // منعرضش صناديق فاضية في المعاينة

        const optionEl = document.createElement('div');
        optionEl.className = 'dq-option-card';
        if (String(i) === correctOptionId) optionEl.classList.add('is-correct');
        optionEl.textContent = optionText;
        previewGrid.appendChild(optionEl);
    }
}

/** عداد أحرف نص السؤال (0/300) - بيتلوّن أحمر لو قرب من الحد الأقصى */
function updateQuestionTextCounter() {
    const textInput = document.getElementById('questionTextInput');
    const counterEl = document.getElementById('questionTextCounter');
    if (!textInput || !counterEl) return;

    const length = textInput.value.length;
    counterEl.textContent = `${length}/${QUESTION_TEXT_MAX_LENGTH}`;
    counterEl.classList.toggle('text-rose-400', length >= QUESTION_TEXT_MAX_LENGTH - 20);
    counterEl.classList.toggle('text-lux-500', length < QUESTION_TEXT_MAX_LENGTH - 20);
}

/** إفراغ الفورم بالكامل والرجوع لوضع "سؤال جديد" */
function resetQuestionForm() {
    editingQuestionId = null;

    const textInput = document.getElementById('questionTextInput');
    if (textInput) textInput.value = '';

    for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
        const optionInput = document.getElementById(`questionOptionText${i}`);
        if (optionInput) optionInput.value = '';
    }
    const firstRadio = document.getElementById('questionOptionRadio1');
    if (firstRadio) firstRadio.checked = true;

    const categoryInput = document.getElementById('questionCategoryInput');
    if (categoryInput) categoryInput.value = '';

    const difficultyInput = document.getElementById('questionDifficultyInput');
    if (difficultyInput) difficultyInput.value = 'medium';

    const titleEl = document.getElementById('questionFormTitle');
    if (titleEl) titleEl.textContent = 'سؤال جديد';

    const cancelBtn = document.getElementById('questionCancelEditBtn');
    if (cancelBtn) cancelBtn.classList.add('hidden');

    setStatusText(document.getElementById('questionFormStatus'), '', null);
    updateQuestionTextCounter();
    updateQuestionLivePreview();
}

/** تعبئة الفورم ببيانات سؤال موجود عشان يتعدّل - بيدخل "وضع التعديل"
 * @param {{id:string, question_text:string, options:Array<{id:string,text:string}>, correct_option_id:string, category:string|null, difficulty:string}} question
 */
function fillQuestionFormForEdit(question) {
    editingQuestionId = question.id;

    const textInput = document.getElementById('questionTextInput');
    if (textInput) textInput.value = question.question_text || '';

    const options = Array.isArray(question.options) ? question.options : [];
    for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
        const optionInput = document.getElementById(`questionOptionText${i}`);
        const matchingOption = options.find((opt) => opt.id === String(i));
        if (optionInput) optionInput.value = matchingOption ? matchingOption.text : '';
    }

    const correctRadio = document.getElementById(`questionOptionRadio${question.correct_option_id}`);
    if (correctRadio) correctRadio.checked = true;

    const categoryInput = document.getElementById('questionCategoryInput');
    if (categoryInput) categoryInput.value = question.category || '';

    const difficultyInput = document.getElementById('questionDifficultyInput');
    if (difficultyInput) difficultyInput.value = question.difficulty || 'medium';

    const titleEl = document.getElementById('questionFormTitle');
    if (titleEl) titleEl.textContent = 'تعديل السؤال';

    const cancelBtn = document.getElementById('questionCancelEditBtn');
    if (cancelBtn) cancelBtn.classList.remove('hidden');

    // نطلع فوق الفورم عشان الأدمن يشوفه على طول (مفيد خصوصاً على الموبايل
    // لو كان قاعد في نص قائمة الأسئلة الطويلة وضغط "تعديل")
    const formWidget = document.getElementById('questionFormWidget');
    if (formWidget) formWidget.scrollIntoView({ behavior: 'smooth', block: 'start' });

    setStatusText(document.getElementById('questionFormStatus'), '', null);
    updateQuestionTextCounter();
    updateQuestionLivePreview();
}

/** حفظ السؤال - إنشاء جديد أو تعديل حسب editingQuestionId */
async function handleSaveQuestion() {
    const statusEl = document.getElementById('questionFormStatus');
    const saveBtn = document.getElementById('questionSaveBtn');

    const values = getQuestionFormValues();
    if (!values) {
        setStatusText(statusEl, 'لازم تملأ نص السؤال والـ 4 اختيارات كلهم.', 'error');
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const isEditing = Boolean(editingQuestionId);
    const { error } = isEditing
        ? await supabaseClient.rpc('admin_update_daily_question', {
            p_id: editingQuestionId,
            p_question_text: values.questionText,
            p_options: values.options,
            p_correct_option_id: values.correctOptionId,
            p_is_active: true,
            p_category: values.category || null,
            p_difficulty: values.difficulty,
        })
        : await supabaseClient.rpc('admin_create_daily_question', {
            p_question_text: values.questionText,
            p_options: values.options,
            p_correct_option_id: values.correctOptionId,
            p_category: values.category || null,
            p_difficulty: values.difficulty,
        });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل حفظ السؤال:', error);
        setStatusText(statusEl, error.message || 'تعذّر حفظ السؤال. حاول تاني.', 'error');
        return;
    }

    // (مجموعة 2) سجل التعديلات - بس لحالة "تعديل سؤال موجود" (زي ما
    // الطلب نص عليه: "مين عدّل/حذف")، مش لإنشاء سؤال جديد
    if (isEditing) {
        logQuestionAction('question_update', { id: editingQuestionId, question_text: values.questionText });
    }

    setStatusText(statusEl, isEditing ? 'اتحدّث بنجاح ✓' : 'اتضاف بنجاح ✓', 'success');
    resetQuestionForm();
    loadDailyQuestionsList();
}

/** تجيب بنك الأسئلة كامل + سؤالي اليوم (عشان الوسم) وترسمهم */
async function loadDailyQuestionsList() {
    const statusEl = document.getElementById('questionsListStatus');
    const listEl = document.getElementById('questionsListEl');
    if (!listEl) return;

    setStatusText(statusEl, 'جاري تحميل الأسئلة…', 'loading');

    const [{ data: questions, error: listError }, { data: todaysRows, error: todaysError }] = await Promise.all([
        supabaseClient.rpc('admin_list_daily_questions'),
        supabaseClient.rpc('get_todays_daily_questions'),
    ]);

    if (listError) {
        console.error('[admin.js] فشل تحميل بنك الأسئلة:', listError);
        setStatusText(statusEl, 'تعذّر تحميل الأسئلة.', 'error');
        return;
    }

    if (todaysError) {
        // مش خطأ قاطع - نكمل عرض القائمة من غير وسم "ظاهر اليوم" بس
        console.error('[admin.js] فشل تحميل سؤالي اليوم:', todaysError);
        todaysQuestionIds = new Set();
    } else {
        todaysQuestionIds = new Set((todaysRows || []).map((row) => row.question_id));
    }

    allLoadedQuestions = questions || [];
    populateQuestionCategoryFilterOptions();
    populateManualScheduleQuestionSelect(); // (مجموعة 4) قائمة اختيار السؤال اليدوي لازم تتزامن مع بنك الأسئلة كل مرة
    renderQuestionsActiveWarning();
    // (مجموعة 2) الإحصائيات بتتحمّل بالتوازي مع كده من غير ما توقف عرض
    // القائمة الأساسية - لو اتأخرت أو فشلت، القائمة بتتعرض عادي من غيرها
    // وبعدين تتحدث لوحدها لما توصل (شوف loadQuestionAnswerStats)
    loadQuestionAnswerStats();
    applyQuestionsListFilters();
}

/** (مجموعة 2) تحميل نسبة الإجابة الصح لكل سؤال عن طريق
 *  admin_get_question_answer_stats RPC (شوف sql/phase-7-questions-stats-and-log.sql)
 *  وتخزينها في questionAnswerStatsById، وبعدين إعادة رسم القائمة الحالية
 *  عشان الشارات تبان من غير ما نستنى الإحصائيات قبل ما نعرض القائمة
 *  أصلاً (تحميل تدريجي، مش Blocking) */
async function loadQuestionAnswerStats() {
    try {
        const { data, error } = await supabaseClient.rpc('admin_get_question_answer_stats');
        if (error) {
            // متوقع لو سكريبت phase-7 لسه ما اتشغّلش على قاعدة البيانات -
            // مش خطأ يستاهل إزعاج الأدمن، الشارة هتفضل مخفية بس
            console.error('[admin.js] فشل تحميل نسبة الإجابة الصح للأسئلة (تأكد من تشغيل sql/phase-7-questions-stats-and-log.sql):', error);
            return;
        }

        questionAnswerStatsById = new Map(
            (data || []).map((row) => [row.question_id, {
                totalAnswers: Number(row.total_answers) || 0,
                correctAnswers: Number(row.correct_answers) || 0,
                correctPercentage: row.correct_percentage === null ? null : Number(row.correct_percentage),
            }]),
        );

        // القائمة ممكن تكون اتعرضت بالفعل من غير الشارات - نعيد رسمها
        // دلوقتي بعد ما الإحصائيات وصلت (بنعيد تطبيق الفلاتر الحالية
        // نفسها بدل استدعاء renderQuestionsList مباشرة عشان لو الأدمن
        // كان بيبحث/يفلتر بالفعل، النتيجة المفلترة تفضل زي ما هي)
        applyQuestionsListFilters();
    } catch (err) {
        console.error('[admin.js] استثناء غير متوقع أثناء تحميل نسبة الإجابة الصح:', err);
    }
}

/** (مجموعة 2) تحديث بانر "الأسئلة المفعّلة قلّت" فوق شريط البحث/الفلترة -
 *  بيبان بس لو عدد الأسئلة المفعّلة (مش الكل، المفعّلة بس) تحت
 *  MIN_ACTIVE_QUESTIONS_THRESHOLD. بيتحسب من allLoadedQuestions نفسها
 *  (مفيش طلب شبكة إضافي) فبيتحدّث فورًا مع أي تفعيل/تعطيل/حذف/إضافة */
function renderQuestionsActiveWarning() {
    const warningEl = document.getElementById('questionsActiveWarning');
    if (!warningEl) return;

    const activeCount = allLoadedQuestions.filter((q) => q.is_active).length;

    if (activeCount >= MIN_ACTIVE_QUESTIONS_THRESHOLD) {
        warningEl.classList.add('hidden');
        return;
    }

    warningEl.classList.remove('hidden');
    const countText = activeCount === 0
        ? 'مفيش أي سؤال مفعّل دلوقتي'
        : `${activeCount} بس مفعّلين حالياً`;
    warningEl.querySelector('.admin-inline-warning-text').textContent =
        `⚠️ الأسئلة المفعّلة قلّت (${countText}) - السيستم هيبدأ يكرر نفس الأسئلة كل كام يوم. فعّل أسئلة أكتر أو ضيف جديدة من الفورم فوق.`;
}

/* ==================================================================
   3ز) سجل بسيط لمين عدّل/حذف سؤال (Audit Log) - المجموعة 2
   ------------------------------------------------------------------
   عن طريق admin_log_question_action / admin_list_recent_question_actions
   RPC (شوف sql/phase-7-questions-stats-and-log.sql) - جدول
   admin_action_log منفصل تمامًا عن daily_questions، فمفيش أي علاقة
   FK بينهم (السجل بيفضل موجود حتى لو السؤال نفسه اتحذف بعدين).
   التسجيل نفسه "Fire and forget" زي فلسفة تسجيل نتيجة السؤال اليومي في
   daily-question.js بالظبط: فشله ميوقفش العملية الأساسية (تعديل/حذف)
   اللي هو بيوثّقها، بس بيتسجل في console.error.
   ================================================================== */

const QUESTION_ACTION_LABELS = {
    question_update: 'عدّل السؤال',
    question_delete: 'حذف السؤال',
    question_toggle_active_on: 'فعّل السؤال',
    question_toggle_active_off: 'عطّل السؤال',
    question_bulk_import: 'استورد أسئلة جماعيًا',
    question_manual_assign: 'حدد سؤال يدوي ليوم معين',
    question_manual_clear: 'ألغى تحديد يدوي وأرجع يوم للعشوائي',
};

/** @param {string} action أحد مفاتيح QUESTION_ACTION_LABELS
 *  @param {{id:string, question_text:string}} question */
async function logQuestionAction(action, question) {
    const excerpt = (question.question_text || '').length > 60
        ? `${question.question_text.slice(0, 60)}…`
        : (question.question_text || '');
    const label = QUESTION_ACTION_LABELS[action] || action;
    const summary = `${label}: "${excerpt}"`;

    try {
        const { error } = await supabaseClient.rpc('admin_log_question_action', {
            p_action: action,
            p_entity_id: question.id,
            p_summary: summary,
        });
        if (error) {
            // متوقع لو سكريبت phase-7 لسه ما اتشغّلش - العملية الأساسية
            // (تعديل/حذف/تفعيل) خلصت بنجاح بالفعل قبل ما ندخل هنا أصلاً
            console.error('[admin.js] فشل تسجيل العملية في سجل التعديلات (تأكد من تشغيل sql/phase-7-questions-stats-and-log.sql):', error);
            return;
        }
        loadQuestionAuditLog(); // تحديث الودجت فورًا عشان العملية اللي حصلت دلوقتي تبان
    } catch (err) {
        console.error('[admin.js] استثناء غير متوقع أثناء تسجيل العملية:', err);
    }
}

/** تحميل آخر 20 عملية من السجل وعرضهم في #questionAuditLogList -
 *  بتتنادى مرة عند تحميل التاب + بعد كل عملية تعديل/حذف/تفعيل ناجحة */
async function loadQuestionAuditLog() {
    const listEl = document.getElementById('questionAuditLogList');
    const statusEl = document.getElementById('questionAuditLogStatus');
    if (!listEl) return;

    const { data, error } = await supabaseClient.rpc('admin_list_recent_question_actions', { p_limit: 20 });

    if (error) {
        // بنسيب الودجت فاضي بهدوء لو الـ RPC لسه مش موجودة، من غير
        // ما نعرض رسالة خطأ مقلقة لأدمن مش هو اللي هيحل المشكلة دي
        console.error('[admin.js] فشل تحميل سجل تعديلات الأسئلة:', error);
        if (statusEl) setStatusText(statusEl, '', null);
        return;
    }

    const rows = data || [];
    listEl.innerHTML = '';

    if (!rows.length) {
        if (statusEl) setStatusText(statusEl, 'مفيش أي عملية تعديل أو حذف مسجّلة لسه.', 'empty');
        return;
    }
    if (statusEl) setStatusText(statusEl, '', null);

    rows.forEach((row) => {
        const li = document.createElement('li');
        li.className = 'admin-audit-log-item';
        const who = row.admin_email ? escapeHtml(row.admin_email) : 'أدمن';
        const when = row.created_at ? new Date(row.created_at).toLocaleString('ar-EG', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        }) : '';
        li.innerHTML = `
            <span class="admin-audit-log-item-text">${who} — ${escapeHtml(row.summary || '')}</span>
            <span class="admin-audit-log-item-time">${escapeHtml(when)}</span>
        `;
        listEl.appendChild(li);
    });
}

/** (مجموعة 1) تبني قائمة الفئات (datalist اقتراحات الفورم + select
 *  فلترة القائمة) من الفئات الفعلية الموجودة في allLoadedQuestions -
 *  بتتحدث كل ما القائمة تتحمّل من جديد، فأي فئة جديدة تتضاف من فورم
 *  الإنشاء تبان في الفلتر تلقائيًا من غير أي تعديل يدوي في الكود */
function populateQuestionCategoryFilterOptions() {
    const categories = Array.from(new Set(
        allLoadedQuestions.map((q) => q.category).filter(Boolean),
    )).sort((a, b) => a.localeCompare(b, 'ar'));

    const datalistEl = document.getElementById('questionCategoryOptions');
    if (datalistEl) {
        datalistEl.innerHTML = categories.map((cat) => `<option value="${escapeHtml(cat)}"></option>`).join('');
    }

    const filterSelect = document.getElementById('questionsFilterCategory');
    if (filterSelect) {
        const currentValue = filterSelect.value;
        filterSelect.innerHTML = '<option value="">كل الفئات</option>'
            + categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
        // نحافظ على الفلتر المختار قبل التحديث لو لسه موجود ضمن الفئات الجديدة
        if (categories.includes(currentValue)) filterSelect.value = currentValue;
    }
}

/** (مجموعة 1) تطبيق البحث النصي + فلاتر الفئة/الصعوبة/الحالة على
 *  allLoadedQuestions محليًا (من غير أي طلب شبكة) وإعادة رسم القائمة -
 *  بتتنادى مع كل حرف بحث أو تغيير فلتر */
function applyQuestionsListFilters() {
    const searchInput = document.getElementById('questionsSearchInput');
    const categoryFilter = document.getElementById('questionsFilterCategory');
    const difficultyFilter = document.getElementById('questionsFilterDifficulty');
    const statusFilter = document.getElementById('questionsFilterStatus');

    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const categoryValue = categoryFilter ? categoryFilter.value : '';
    const difficultyValue = difficultyFilter ? difficultyFilter.value : '';
    const statusValue = statusFilter ? statusFilter.value : '';

    const filtered = allLoadedQuestions.filter((q) => {
        if (searchQuery && !q.question_text.toLowerCase().includes(searchQuery)) return false;
        if (categoryValue && q.category !== categoryValue) return false;
        if (difficultyValue && q.difficulty !== difficultyValue) return false;
        if (statusValue === 'active' && !q.is_active) return false;
        if (statusValue === 'inactive' && q.is_active) return false;
        return true;
    });

    renderQuestionsList(filtered);

    const statusEl = document.getElementById('questionsListStatus');
    if (!allLoadedQuestions.length) {
        setStatusText(statusEl, 'مفيش أسئلة في البنك لسه - ضيف أول سؤال من الفورم فوق.', 'empty');
    } else if (!filtered.length) {
        setStatusText(statusEl, 'مفيش أسئلة مطابقة للبحث/الفلتر ده.', 'empty');
    } else {
        setStatusText(statusEl, '', null);
    }
}

/** (مجموعة 2) بتبني نص + تصنيف (تير) شارة نسبة الإجابة الصح لسؤال معيّن
 *  من questionAnswerStatsById - بترجع null لو مفيش بيانات إحصائية خالص
 *  عن السؤال ده لسه (يا سؤال جديد، يا الـ RPC لسه مش موجودة) عشان
 *  الشارة تتخفي بدل ما تعرض "0%" مضلّلة */
function getQuestionStatBadge(questionId) {
    const stat = questionAnswerStatsById.get(questionId);
    if (!stat || stat.totalAnswers === 0) return null;

    const pct = stat.correctPercentage ?? 0;
    let tier = 'mid';
    if (pct >= 70) tier = 'good';
    else if (pct < 40) tier = 'low';

    return {
        tier,
        text: `${pct}% صح (${stat.totalAnswers.toLocaleString('ar-EG')} محاولة)`,
    };
}

/** @param {Array<{id:string, question_text:string, options:Array, correct_option_id:string, is_active:boolean, used_count:number, category:string|null, difficulty:string}>} questions */
function renderQuestionsList(questions) {
    const listEl = document.getElementById('questionsListEl');
    if (!listEl) return;

    listEl.innerHTML = '';

    questions.forEach((question) => {
        const isToday = todaysQuestionIds.has(question.id);
        const li = document.createElement('li');
        li.className = 'admin-user-row';
        if (!question.is_active) li.classList.add('is-blocked'); // إعادة استخدام نفس تلوين "غير مفعّل" بصريًا

        const excerpt = question.question_text.length > 70
            ? `${question.question_text.slice(0, 70)}…`
            : question.question_text;

        // (مجموعة 1) سطر معلومات ثاني: الفئة (لو موجودة) + الصعوبة +
        // عدد مرات الظهور، عشان القائمة تديك سياق كفاية من غير ما تفتح تعديل
        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[question.difficulty] || 'متوسط';
        const metaParts = [
            question.is_active ? 'مفعّل' : 'غير مفعّل',
            question.category ? escapeHtml(question.category) : null,
            difficultyLabel,
            `اتعرض ${question.used_count || 0} مرة`,
        ].filter(Boolean);

        // (مجموعة 2) شارة نسبة الإجابة الصح - بتتحط بس لو فيه بيانات
        // فعلاً (شوف getQuestionStatBadge)
        const statBadge = getQuestionStatBadge(question.id);

        li.innerHTML = `
            <div class="admin-user-info">
                <div class="admin-user-name">${escapeHtml(excerpt)}</div>
                <div class="admin-user-username">${metaParts.join(' · ')}</div>
            </div>
            ${isToday ? '<span class="admin-user-bounds-badge is-inside">ظاهر اليوم</span>' : ''}
            ${statBadge ? `<span class="admin-question-stat-badge" data-tier="${statBadge.tier}">${escapeHtml(statBadge.text)}</span>` : ''}
            <div class="admin-user-actions">
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-toggle-btn">${question.is_active ? 'إيقاف' : 'تفعيل'}</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-edit-btn">تعديل</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-delete-btn">حذف</button>
            </div>
        `;

        const toggleBtn = li.querySelector('.question-toggle-btn');
        if (toggleBtn) toggleBtn.addEventListener('click', () => handleToggleQuestionActive(question, toggleBtn, li));

        const editBtn = li.querySelector('.question-edit-btn');
        if (editBtn) editBtn.addEventListener('click', () => fillQuestionFormForEdit(question));

        const deleteBtn = li.querySelector('.question-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => handleDeleteQuestion(question, li));

        listEl.appendChild(li);
    });
}

/** (مجموعة 1) تفعيل/تعطيل سريع من غير ما تفتح فورم التعديل - عن طريق
 *  admin_set_daily_question_active RPC (خفيفة، بتلمس عمود is_active
 *  بس) - بتحدّث النسخة المحلية في allLoadedQuestions كمان عشان
 *  الفلترة اللاحقة تفضل متزامنة من غير إعادة تحميل كاملة */
async function handleToggleQuestionActive(question, buttonEl, rowEl) {
    const newValue = !question.is_active;
    if (buttonEl) buttonEl.disabled = true;

    const { error } = await supabaseClient.rpc('admin_set_daily_question_active', {
        p_id: question.id,
        p_is_active: newValue,
    });

    if (buttonEl) buttonEl.disabled = false;

    if (error) {
        console.error('[admin.js] فشل تغيير حالة تفعيل السؤال:', error);
        window.alert(error.message || 'تعذّر تغيير حالة السؤال. حاول تاني.');
        return;
    }

    question.is_active = newValue;
    const localQuestion = allLoadedQuestions.find((q) => q.id === question.id);
    if (localQuestion) localQuestion.is_active = newValue;

    if (rowEl) rowEl.classList.toggle('is-blocked', !newValue);
    if (buttonEl) buttonEl.textContent = newValue ? 'إيقاف' : 'تفعيل';

    const usernameEl = rowEl ? rowEl.querySelector('.admin-user-username') : null;
    if (usernameEl) {
        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[question.difficulty] || 'متوسط';
        const metaParts = [
            newValue ? 'مفعّل' : 'غير مفعّل',
            question.category ? escapeHtml(question.category) : null,
            difficultyLabel,
            `اتعرض ${question.used_count || 0} مرة`,
        ].filter(Boolean);
        usernameEl.textContent = metaParts.join(' · ');
    }

    // (مجموعة 2) البانر بيتحدّث فورًا (العدد المفعّل اتغيّر) + سطر جديد
    // في سجل التعديلات - الاتنين مش حرجين لعملية التفعيل نفسها، فلو
    // فشلوا لأي سبب (مثلاً سكريبت phase-7 لسه مش مشغّل) العملية
    // الأساسية فوق بتفضل ناجحة عادي
    renderQuestionsActiveWarning();
    logQuestionAction(newValue ? 'question_toggle_active_on' : 'question_toggle_active_off', question);
}

/** حذف سؤال - عن طريق admin_delete_daily_question RPC بس، بعد تأكيد.
 *  الدالة نفسها بترفض حذف سؤال معروض النهاردة فعلاً (شوف السبب في
 *  الـ SQL)، فبنعرض رسالة الخطأ اللي راجعة من السيرفر زي ما هي */
async function handleDeleteQuestion(question, rowEl) {
    if (!window.confirm('تأكيد حذف السؤال ده؟ الحذف نهائي.')) return;

    const { error } = await supabaseClient.rpc('admin_delete_daily_question', { p_id: question.id });

    if (error) {
        console.error('[admin.js] فشل حذف السؤال:', error);
        window.alert(error.message || 'تعذّر حذف السؤال. حاول تاني.');
        return;
    }

    if (editingQuestionId === question.id) resetQuestionForm();

    logQuestionAction('question_delete', question);

    allLoadedQuestions = allLoadedQuestions.filter((q) => q.id !== question.id);
    if (rowEl) rowEl.remove();
    renderQuestionsActiveWarning(); // (مجموعة 2) العدد المفعّل ممكن يكون قل لو السؤال المحذوف كان مفعّل

    const listEl = document.getElementById('questionsListEl');
    const statusEl = document.getElementById('questionsListStatus');
    if (listEl && !listEl.children.length) {
        setStatusText(statusEl, 'مفيش أسئلة في البنك لسه - ضيف أول سؤال من الفورم فوق.', 'empty');
    }
}

/* ==================================================================
   3ي) تحكم يدوي في سؤال يوم معين (المجموعة 4)
   ------------------------------------------------------------------
   بدل الاختيار العشوائي اليومي (pick_daily_questions عن طريق pg_cron
   كل 10 دقايق)، الأدمن يقدر يحدد سؤال بعينه ليوم/Slot معين -
   admin_set_manual_daily_question RPC. الدالة السيرفرية بترفض أي
   محاولة تحديد ليوم فات، وpick_daily_questions بقت idempotent لكل
   Slot لوحده (مش اليوم كله) عشان اختيار يدوي لـ Slot ميمنعش الكرون من
   ملء الـ Slot التاني - شوف sql/phase-8-manual-daily-question-override.sql.
   ================================================================== */

/** بناء قائمة اختيار السؤال (select) من allLoadedQuestions المحمّلة
 *  أصلاً - بتتحدث مع كل تحميل جديد للبنك (نفس نمط
 *  populateQuestionCategoryFilterOptions) عشان أي سؤال جديد يتضاف يبان
 *  فورًا من غير أي تعديل يدوي */
function populateManualScheduleQuestionSelect() {
    const selectEl = document.getElementById('manualScheduleQuestionInput');
    if (!selectEl) return;

    const currentValue = selectEl.value;
    const options = allLoadedQuestions.map((q) => {
        const excerpt = q.question_text.length > 60 ? `${q.question_text.slice(0, 60)}…` : q.question_text;
        const label = `${excerpt}${q.is_active ? '' : ' (غير مفعّل)'}`;
        return `<option value="${escapeHtml(q.id)}">${escapeHtml(label)}</option>`;
    });

    selectEl.innerHTML = '<option value="">اختر سؤال من البنك…</option>' + options.join('');
    if (allLoadedQuestions.some((q) => q.id === currentValue)) selectEl.value = currentValue;
}

/** تحميل أقرب 14 يوم جايين (من النهاردة) من admin_list_daily_question_picks
 *  وعرضهم - بيغطي اليدوي والتلقائي مع بعض عشان الأدمن يشوف الصورة
 *  كاملة */
async function loadManualScheduleList() {
    const listEl = document.getElementById('manualScheduleListEl');
    const statusEl = document.getElementById('manualScheduleListStatus');
    if (!listEl) return;

    setStatusText(statusEl, 'جاري تحميل الجدول…', 'loading');

    const today = new Date();
    const fromStr = today.toISOString().slice(0, 10);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 13);
    const toStr = toDate.toISOString().slice(0, 10);

    const { data, error } = await supabaseClient.rpc('admin_list_daily_question_picks', {
        p_from: fromStr,
        p_to: toStr,
    });

    if (error) {
        console.error('[admin.js] فشل تحميل جدول الأسئلة القادمة:', error);
        setStatusText(statusEl, 'تعذّر تحميل الجدول (تأكد من تشغيل sql/phase-8-manual-daily-question-override.sql).', 'error');
        return;
    }

    renderManualScheduleList(data || []);
    setStatusText(statusEl, (data || []).length ? '' : 'مفيش أي اختيار مسجّل للأيام الجاية لسه.', (data || []).length ? null : 'empty');
}

const MANUAL_SCHEDULE_DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('ar-EG', {
    weekday: 'short', day: '2-digit', month: '2-digit',
});

/** @param {Array<{question_date:string, question_slot:number, question_id:string, question_text:string, is_manual:boolean}>} rows */
function renderManualScheduleList(rows) {
    const listEl = document.getElementById('manualScheduleListEl');
    if (!listEl) return;

    listEl.innerHTML = '';
    const todayStr = new Date().toISOString().slice(0, 10);

    rows.forEach((row) => {
        const li = document.createElement('li');
        li.className = 'admin-user-row';

        const excerpt = row.question_text.length > 60 ? `${row.question_text.slice(0, 60)}…` : row.question_text;
        const dayLabel = MANUAL_SCHEDULE_DAY_LABEL_FORMATTER.format(new Date(`${row.question_date}T00:00:00`));
        const isToday = row.question_date === todayStr;

        li.innerHTML = `
            <div class="admin-user-info">
                <div class="admin-user-name">${escapeHtml(dayLabel)} · سؤال ${row.question_slot}</div>
                <div class="admin-user-username">${escapeHtml(excerpt)}</div>
            </div>
            <span class="admin-user-bounds-badge ${row.is_manual ? 'is-inside' : 'is-outside'}">${row.is_manual ? 'يدوي' : 'تلقائي'}</span>
            ${row.is_manual ? `<div class="admin-user-actions"><button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide manual-schedule-clear-btn">إرجاع للعشوائي</button></div>` : ''}
        `;

        const clearBtn = li.querySelector('.manual-schedule-clear-btn');
        if (clearBtn) clearBtn.addEventListener('click', () => handleClearManualSchedule(row, clearBtn, isToday));

        listEl.appendChild(li);
    });
}

/** حفظ الاختيار اليدوي - عن طريق admin_set_manual_daily_question RPC.
 *  لو التاريخ المحدد هو النهاردة، بنعيد تحميل قائمة بنك الأسئلة كمان
 *  عشان وسم "ظاهر اليوم" يتحدّث فورًا */
async function handleSaveManualSchedule() {
    const dateInput = document.getElementById('manualScheduleDateInput');
    const slotInput = document.getElementById('manualScheduleSlotInput');
    const questionInput = document.getElementById('manualScheduleQuestionInput');
    const saveBtn = document.getElementById('manualScheduleSaveBtn');
    const statusEl = document.getElementById('manualScheduleStatus');

    const date = dateInput ? dateInput.value : '';
    const slot = slotInput ? Number(slotInput.value) : null;
    const questionId = questionInput ? questionInput.value : '';

    if (!date || !slot || !questionId) {
        setStatusText(statusEl, 'اختار التاريخ والـ Slot والسؤال الأول.', 'error');
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const { error } = await supabaseClient.rpc('admin_set_manual_daily_question', {
        p_date: date,
        p_slot: slot,
        p_question_id: questionId,
    });

    if (saveBtn) saveBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل حفظ الاختيار اليدوي:', error);
        setStatusText(statusEl, error.message || 'تعذّر حفظ الاختيار اليدوي. حاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, 'اتحفظ بنجاح.', 'success');

    const question = allLoadedQuestions.find((q) => q.id === questionId);
    if (question) logQuestionAction('question_manual_assign', question);

    loadManualScheduleList();
    // لو التاريخ المحدد هو النهاردة، سؤالي اليوم في البنك ممكن يكونوا
    // اتغيّروا فعليًا - نعيد تحميل القائمة عشان وسم "ظاهر اليوم" يتزامن
    if (date === new Date().toISOString().slice(0, 10)) loadDailyQuestionsList();
}

/** إلغاء اختيار يدوي (النهاردة أو أي يوم جاي - مش أيام فاتت) - عن
 *  طريق admin_clear_manual_daily_question RPC. لو النهاردة، الـ Slot
 *  بيترجع للعشوائي فورًا (السيرفر نفسه بيعمل ده)، ولو يوم جاي الكرون
 *  هيملأه في تشغيله الطبيعي */
async function handleClearManualSchedule(row, buttonEl, isToday) {
    const confirmMsg = isToday
        ? 'إرجاع سؤال النهاردة للعشوائي؟ السؤال المعروض للمستخدمين هيتغيّر فورًا.'
        : 'إرجاع اليوم ده للاختيار العشوائي؟';
    if (!window.confirm(confirmMsg)) return;

    if (buttonEl) buttonEl.disabled = true;

    const { error } = await supabaseClient.rpc('admin_clear_manual_daily_question', {
        p_date: row.question_date,
        p_slot: row.question_slot,
    });

    if (buttonEl) buttonEl.disabled = false;

    if (error) {
        console.error('[admin.js] فشل إلغاء الاختيار اليدوي:', error);
        window.alert(error.message || 'تعذّر إلغاء الاختيار اليدوي. حاول تاني.');
        return;
    }

    logQuestionAction('question_manual_clear', { id: null, question_text: `${row.question_date} - سؤال ${row.question_slot}` });
    loadManualScheduleList();
}

/** تهيئة ويدجت التحكم اليدوي - تُستدعى مرة واحدة من initDailyQuestionsWidget */
function initManualScheduleWidget() {
    const dateInput = document.getElementById('manualScheduleDateInput');
    if (dateInput) {
        const todayStr = new Date().toISOString().slice(0, 10);
        dateInput.min = todayStr;
        dateInput.value = todayStr;
    }

    const saveBtn = document.getElementById('manualScheduleSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', handleSaveManualSchedule);

    loadManualScheduleList();
}

/** تهيئة تاب الأسئلة اليومية بالكامل - تُستدعى مرة واحدة من initAdminPage */
function initDailyQuestionsWidget() {
    buildQuestionOptionRows();

    const saveBtn = document.getElementById('questionSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', handleSaveQuestion);

    const cancelBtn = document.getElementById('questionCancelEditBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', resetQuestionForm);

    // (مجموعة 1) عداد الأحرف + المعاينة الحية بيتحدّثوا مع كل حرف
    const textInput = document.getElementById('questionTextInput');
    if (textInput) {
        textInput.addEventListener('input', () => {
            updateQuestionTextCounter();
            updateQuestionLivePreview();
        });
    }
    const categoryInput = document.getElementById('questionCategoryInput');
    if (categoryInput) categoryInput.addEventListener('input', updateQuestionLivePreview);
    const difficultyInput = document.getElementById('questionDifficultyInput');
    if (difficultyInput) difficultyInput.addEventListener('change', updateQuestionLivePreview);

    // (مجموعة 1) البحث والفلاتر - كلهم بيعيدوا رسم القائمة محليًا بس
    const searchInput = document.getElementById('questionsSearchInput');
    if (searchInput) searchInput.addEventListener('input', applyQuestionsListFilters);
    ['questionsFilterCategory', 'questionsFilterDifficulty', 'questionsFilterStatus'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', applyQuestionsListFilters);
    });

    updateQuestionTextCounter();
    updateQuestionLivePreview();
    loadDailyQuestionsList();
    loadQuestionAuditLog(); // (مجموعة 2) سجل التعديلات - مستقل عن قائمة الأسئلة، بيتحمّل بالتوازي
    initQuestionsBulkToolsWidget(); // (مجموعة 3) استيراد/تصدير جماعي
    initManualScheduleWidget(); // (مجموعة 4) تحكم يدوي في سؤال يوم معين
}


/* ==================================================================
   3ح) أدوات جماعية: استيراد أسئلة من ملف + تصدير نسخة احتياطية
   (المجموعة 3)
   ------------------------------------------------------------------
   التصدير: مفيش أي طلب شبكة - بيبني ملف JSON من allLoadedQuestions
   المحمّلة أصلاً في المتصفح وينزّله زي ما هو.

   الاستيراد: بيقبل نفس صيغة JSON اللي التصدير بيطلعها (round-trip
   كامل)، أو ملف CSV بأعمدة مبسّطة (شوف parseImportCsv). بعد التحليل
   بيبيّن معاينة (عدد الصفوف الصحيحة + أي أخطاء هيتم تجاهلها) قبل ما
   يستورد فعليًا - الاستيراد نفسه بيمر على admin_create_daily_question
   الموجودة بالفعل سؤال سؤال (مفيش RPC جماعي جديد، فمفيش أي تعديل SQL
   مطلوب عشان الميزة دي تشتغل من أول مرة).
   ================================================================== */

/** الصفوف الصحيحة اللي جاهزة للاستيراد بعد آخر معاينة - null لحد ما
 *  ملف يتقرا وينتحلل بنجاح */
let pendingImportRows = null;

/** (مجموعة 3) تصدير - يبني ملف JSON من allLoadedQuestions وينزّله.
 *  نفس الحقول اللي هيحتاجها الاستيراد بعدين (question_text/options/
 *  correct_option_id/category/difficulty) + id الأصلي كمرجع بس (مش
 *  بيتستخدم وقت إعادة الاستيراد - كل استيراد بيعمل سؤال جديد بـ id
 *  جديد تمامًا، مفيش "تحديث" جماعي) */
function handleExportQuestionsBackup() {
    const statusEl = document.getElementById('questionsImportStatus');

    if (!allLoadedQuestions.length) {
        setStatusText(statusEl, 'مفيش أسئلة في البنك لسه تتصدّر.', 'empty');
        return;
    }

    const payload = {
        exported_at: new Date().toISOString(),
        source: 'سِكّاوي - لوحة تحكم الأدمن',
        questions: allLoadedQuestions.map((q) => ({
            question_text: q.question_text,
            options: q.options,
            correct_option_id: q.correct_option_id,
            category: q.category || null,
            difficulty: q.difficulty || 'medium',
            is_active: Boolean(q.is_active),
        })),
    };

    downloadTextFile(
        `skkawy-daily-questions-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(payload, null, 2),
        'application/json',
    );
    setStatusText(statusEl, `اتصدّر ${allLoadedQuestions.length} سؤال بنجاح ✓`, 'success');
}

/** (مجموعة 3) تنزيل نموذج CSV فاضي بالأعمدة المطلوبة + صف مثال واحد -
 *  عشان الأدمن يعرف الشكل المضبوط قبل ما يملأ ملفه هو */
function handleDownloadCsvTemplate() {
    const header = 'question_text,option_1,option_2,option_3,option_4,correct_option,category,difficulty';
    const example = '"عاصمة مصر إيه؟","القاهرة","الإسكندرية","الأقصر","أسوان",1,"جغرافيا","easy"';
    downloadTextFile('skkawy-daily-questions-template.csv', `${header}\n${example}\n`, 'text/csv');
}

/** مساعدة عامة: تنزيل نص كملف عن طريق <a download> مؤقت - مفيش
 *  استدعاء شبكة، كل حاجة بتحصل جوه المتصفح */
function downloadTextFile(filename, text, mimeType) {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/** تطبيع صف واحد (من JSON أو CSV) لشكل موحّد جاهز للتحقق منه، أو
 *  بيرجع { error } لو فيه نقص واضح - القيم المفقودة (category/
 *  difficulty/is_active) بتاخد نفس الافتراضي المستخدم في فورم الإضافة
 *  اليدوي (متوسط/مفعّل) */
function normalizeImportRow(raw, rowIndex) {
    const questionText = String(raw.question_text ?? raw.questionText ?? '').trim();
    if (!questionText) return { error: `سطر ${rowIndex}: نص السؤال فاضي` };
    if (questionText.length > QUESTION_TEXT_MAX_LENGTH) {
        return { error: `سطر ${rowIndex}: نص السؤال أطول من ${QUESTION_TEXT_MAX_LENGTH} حرف` };
    }

    let options = [];
    if (Array.isArray(raw.options)) {
        options = raw.options.map((opt, i) => ({
            id: String(opt.id ?? (i + 1)),
            text: String(opt.text ?? '').trim(),
        }));
    } else {
        // شكل CSV: option_1..option_4 كأعمدة منفصلة
        for (let i = 1; i <= DAILY_QUESTION_OPTION_COUNT; i += 1) {
            const value = raw[`option_${i}`];
            options.push({ id: String(i), text: String(value ?? '').trim() });
        }
    }

    if (options.length !== DAILY_QUESTION_OPTION_COUNT || options.some((o) => !o.text)) {
        return { error: `سطر ${rowIndex}: لازم ${DAILY_QUESTION_OPTION_COUNT} اختيارات كلهم مليانين` };
    }

    const correctRaw = String(raw.correct_option_id ?? raw.correct_option ?? '').trim();
    const correctOptionId = options.some((o) => o.id === correctRaw) ? correctRaw : null;
    if (!correctOptionId) {
        return { error: `سطر ${rowIndex}: correct_option لازم يكون رقم اختيار موجود (1-${DAILY_QUESTION_OPTION_COUNT})` };
    }

    const difficultyRaw = String(raw.difficulty ?? '').trim().toLowerCase();
    const difficulty = ['easy', 'medium', 'hard'].includes(difficultyRaw) ? difficultyRaw : 'medium';

    const category = raw.category ? String(raw.category).trim() : '';

    return {
        row: {
            questionText,
            options,
            correctOptionId,
            category,
            difficulty,
        },
    };
}

/** بارسر CSV بسيط بيدعم الحقول المتحطة بين علامتي اقتباس (زي نموذجنا)
 *  ومنها الفاصلة أو الاقتباس نفسه جوه النص ("" = اقتباس واحد حرفي) -
 *  بيرجع Array من الصفوف كـ Object حسب أول سطر (الهيدر) */
function parseImportCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
            else if (ch === '"') { inQuotes = false; }
            else { field += ch; }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            pushField();
        } else if (ch === '\n') {
            pushField(); pushRow();
        } else if (ch === '\r') {
            // نتجاهله - \n اللي بعده هو اللي بيقفل الصف (تعامل مع CRLF)
        } else {
            field += ch;
        }
    }
    if (field.length || row.length) { pushField(); pushRow(); }

    const nonEmptyRows = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
    if (!nonEmptyRows.length) return [];

    const header = nonEmptyRows[0].map((h) => h.trim());
    return nonEmptyRows.slice(1).map((cells) => {
        const obj = {};
        header.forEach((key, i) => { obj[key] = cells[i] ?? ''; });
        return obj;
    });
}

/** قراءة الملف المختار وتحليله (JSON أو CSV حسب الامتداد) لمصفوفة
 *  raw objects قبل التطبيع - بترجع Promise<Array<object>> أو ترمي
 *  Error برسالة واضحة لو الملف مش مفهوم */
function readImportFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('تعذّر قراءة الملف.'));
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const isJson = file.name.toLowerCase().endsWith('.json');

                if (isJson) {
                    const parsed = JSON.parse(text);
                    const list = Array.isArray(parsed) ? parsed : parsed.questions;
                    if (!Array.isArray(list)) throw new Error('شكل ملف الـ JSON مش متوقع - محتاج يكون Array أو Object فيه questions.');
                    resolve(list);
                } else {
                    resolve(parseImportCsv(text));
                }
            } catch (err) {
                reject(new Error(isJsonParseErrorMessage(err, file.name)));
            }
        };
        reader.readAsText(file, 'utf-8');
    });
}

function isJsonParseErrorMessage(err, filename) {
    if (filename.toLowerCase().endsWith('.json')) {
        return `الملف مش JSON صحيح: ${err.message}`;
    }
    return err.message || 'تعذّر تحليل الملف.';
}

/** رسم كارت المعاينة بعد تحليل الملف - عدد الصفوف الصحيحة الجاهزة
 *  للاستيراد + قائمة أي أخطاء هيتم تجاهلها (لو فيه) */
function renderImportPreview(validRows, errors) {
    pendingImportRows = validRows;

    const box = document.getElementById('questionsImportPreviewBox');
    const summaryEl = document.getElementById('questionsImportPreviewSummary');
    const errorsEl = document.getElementById('questionsImportPreviewErrors');
    const confirmBtn = document.getElementById('questionsImportConfirmBtn');
    if (!box || !summaryEl || !errorsEl) return;

    box.classList.remove('hidden');

    const parts = [`هيتم استيراد ${validRows.length} سؤال`];
    if (errors.length) parts.push(`${errors.length} سطر فيه مشكلة وهيتجاهل`);
    summaryEl.textContent = parts.join(' - ') + (validRows.length ? '.' : ' - مفيش أي سؤال صالح للاستيراد.');

    errorsEl.innerHTML = errors.map((e) => `<li>⚠️ ${escapeHtml(e)}</li>`).join('');

    if (confirmBtn) confirmBtn.disabled = validRows.length === 0;
}

/** إخفاء/تصفير كارت المعاينة بالكامل - بعد إلغاء أو نجاح الاستيراد */
function resetImportPreview() {
    pendingImportRows = null;
    const box = document.getElementById('questionsImportPreviewBox');
    if (box) box.classList.add('hidden');
    const fileNameEl = document.getElementById('questionsImportFileName');
    if (fileNameEl) fileNameEl.textContent = '';
    const fileInput = document.getElementById('questionsImportFileInput');
    if (fileInput) fileInput.value = '';
}

/** بعد اختيار ملف: قراءة + تحليل + تطبيع كل صف + عرض المعاينة */
async function handleImportFileSelected(file) {
    const statusEl = document.getElementById('questionsImportStatus');
    const fileNameEl = document.getElementById('questionsImportFileName');
    if (fileNameEl) fileNameEl.textContent = file.name;

    setStatusText(statusEl, 'جاري تحليل الملف…', 'loading');

    let rawRows;
    try {
        rawRows = await readImportFile(file);
    } catch (err) {
        setStatusText(statusEl, err.message || 'تعذّر قراءة الملف.', 'error');
        return;
    }

    if (!rawRows.length) {
        setStatusText(statusEl, 'الملف فاضي أو مفيش صفوف مفهومة فيه.', 'error');
        return;
    }

    const validRows = [];
    const errors = [];
    rawRows.forEach((raw, i) => {
        const { row, error } = normalizeImportRow(raw, i + 1);
        if (error) errors.push(error);
        else validRows.push(row);
    });

    setStatusText(statusEl, '', null);
    renderImportPreview(validRows, errors);
}

/** تأكيد الاستيراد - بيمر على pendingImportRows سؤال سؤال عن طريق
 *  admin_create_daily_question الموجودة بالفعل (تسلسلي مش متوازي، عشان
 *  ميضغطش على السيرفر بمئات الطلبات مرة واحدة لو الملف كبير)، وبيبيّن
 *  تقدّم حي (كام اتحفظ من كام) */
async function handleConfirmImport() {
    if (!pendingImportRows || !pendingImportRows.length) return;

    const statusEl = document.getElementById('questionsImportStatus');
    const confirmBtn = document.getElementById('questionsImportConfirmBtn');
    const cancelBtn = document.getElementById('questionsImportCancelBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    const total = pendingImportRows.length;
    let successCount = 0;
    const failedMessages = [];

    for (let i = 0; i < total; i += 1) {
        const row = pendingImportRows[i];
        setStatusText(statusEl, `جاري الاستيراد… ${i + 1}/${total}`, 'loading');

        // eslint-disable-next-line no-await-in-loop
        const { error } = await supabaseClient.rpc('admin_create_daily_question', {
            p_question_text: row.questionText,
            p_options: row.options,
            p_correct_option_id: row.correctOptionId,
            p_category: row.category || null,
            p_difficulty: row.difficulty,
        });

        if (error) {
            console.error(`[admin.js] فشل استيراد السؤال رقم ${i + 1}:`, error);
            failedMessages.push(`سؤال ${i + 1}: ${error.message || 'فشل الحفظ'}`);
        } else {
            successCount += 1;
        }
    }

    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;

    const resultParts = [`اتستورد ${successCount} من ${total} سؤال بنجاح ✓`];
    if (failedMessages.length) resultParts.push(`${failedMessages.length} فشلوا (شوف الـ Console للتفاصيل)`);
    setStatusText(statusEl, resultParts.join(' - '), successCount === total ? 'success' : 'error');

    // (مجموعة 2) سطر واحد في سجل التعديلات يلخّص عملية الاستيراد كلها -
    // مش سطر لكل سؤال عشان السجل ميتغرقش برقم كبير مرة واحدة
    if (successCount > 0) {
        logQuestionAction('question_bulk_import', { id: null, question_text: `${successCount} سؤال` });
    }

    resetImportPreview();
    loadDailyQuestionsList();
}

/** ربط كل أحداث ودجت الأدوات الجماعية - تُستدعى مرة واحدة من initDailyQuestionsWidget */
function initQuestionsBulkToolsWidget() {
    const exportBtn = document.getElementById('questionsExportBtn');
    if (exportBtn) exportBtn.addEventListener('click', handleExportQuestionsBackup);

    const templateBtn = document.getElementById('questionsDownloadTemplateBtn');
    if (templateBtn) templateBtn.addEventListener('click', handleDownloadCsvTemplate);

    const pickBtn = document.getElementById('questionsImportPickBtn');
    const fileInput = document.getElementById('questionsImportFileInput');
    if (pickBtn && fileInput) {
        pickBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) handleImportFileSelected(file);
        });
    }

    const confirmBtn = document.getElementById('questionsImportConfirmBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', handleConfirmImport);

    const cancelBtn = document.getElementById('questionsImportCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', resetImportPreview);
}


/* ==================================================================
   3د) Widget: الأوسمة والشارة المميزة (المرحلة 7)
   ------------------------------------------------------------------
   جدولي badges/user_badges موجودين بالفعل من المرحلة 4 (شوف
   js/profiles.js). الويدجت هنا بتضيف واجهة تحكم فوقهم بس: بحث عن
   مستخدم (نفس نمط اختيار المستخدم في ويدجت الإشعارات - فلترة محلية
   على allUsersList الموجودة أصلاً)، وبعد الاختيار: قائمة كل الأوسمة
   بالكتالوج مع Toggle لكل وسام (فتح/إلغاء يدوي عن طريق
   admin_set_user_badge RPC)، وقائمة منسدلة لتحديد "الشارة المميزة" -
   مقصورة على الأوسمة المفتوحة فعلاً عند المستخدم ده (عن طريق
   admin_set_featured_badge RPC). شوف sql/phase-7-badges.sql للدوال دي
   كاملة + عمود profiles.featured_badge_id الجديد.
   ================================================================== */

/** كتالوج كل الأوسمة الممكنة في اللعبة (id, icon, title, description, sort_order) - جدول badges قراءة عامة، فبنجيبه مباشرة من غير RPC */
let badgesCatalog = [];

/** المستخدم المختار حالياً لإدارة أوسمته - null لو مفيش اختيار بعد */
let badgesSelectedUser = null;

/** معرّفات الأوسمة المفتوحة فعلاً عند المستخدم المختار حالياً */
let badgesSelectedUserUnlockedIds = new Set();

/** جلب كتالوج الأوسمة كامل من Supabase مرة واحدة عند تحميل الصفحة */
async function loadBadgesCatalog() {
    const { data, error } = await supabaseClient
        .from('badges')
        .select('id, icon, title, description, sort_order')
        .order('sort_order', { ascending: true });

    if (error) {
        console.error('[admin.js] فشل تحميل كتالوج الأوسمة:', error);
        return;
    }

    badgesCatalog = data || [];
}

/** يبني صف واحد في قائمة نتائج اختيار مستخدم لإدارة أوسمته - نفس نمط buildNotifyPickerRow بالظبط */
function buildBadgesUserPickerRow(user) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-notify-picker-row';

    const avatarUrl = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    const displayName = escapeHtml(user.full_name || user.username || 'مستخدم بدون اسم');

    btn.innerHTML = `
        <img class="admin-user-avatar" src="${avatarUrl}" alt="" loading="lazy" style="width:26px;height:26px;">
        <span class="admin-notify-picker-row-name">${displayName}</span>
    `;

    btn.addEventListener('click', () => selectBadgesUser(user));
    return btn;
}

/** بتفلتر allUsersList محلياً حسب نص البحث وترسم النتائج (بحد أقصى 8 نتائج) - نفس renderNotifyPickerResults بالظبط */
function renderBadgesUserPickerResults(query) {
    const resultsEl = document.getElementById('badgesUserResultsList');
    if (!resultsEl) return;

    const trimmedQuery = query.trim();
    resultsEl.innerHTML = '';

    if (!trimmedQuery) {
        resultsEl.classList.add('hidden');
        return;
    }

    const matches = allUsersList
        .filter((user) => userMatchesFilter(user, trimmedQuery))
        .slice(0, 8);

    if (matches.length === 0) {
        resultsEl.classList.add('hidden');
        return;
    }

    matches.forEach((user) => resultsEl.appendChild(buildBadgesUserPickerRow(user)));
    resultsEl.classList.remove('hidden');
}

/**
 * بتحدد مستخدم لإدارة أوسمته - بتظهر شارته بدل مربع البحث (زي
 * selectNotifyRecipient بالظبط)، وبعدين بتجيب أوسمته المفتوحة فعلاً
 * عن طريق admin_get_user_badges RPC (لازم RPC هنا مش .from() مباشر،
 * لأن RLS على user_badges بتسمح بالقراءة لصاحب الصف بس)
 * @param {object} user
 */
async function selectBadgesUser(user) {
    badgesSelectedUser = user;

    const searchInput = document.getElementById('badgesUserSearchInput');
    const resultsEl = document.getElementById('badgesUserResultsList');
    const chipEl = document.getElementById('badgesUserSelectedChip');
    const chipAvatar = document.getElementById('badgesUserSelectedAvatar');
    const chipName = document.getElementById('badgesUserSelectedName');
    const manageSection = document.getElementById('badgesManageSection');
    const statusEl = document.getElementById('badgesManageStatus');

    if (searchInput) {
        searchInput.value = '';
        searchInput.classList.add('hidden');
    }
    if (resultsEl) {
        resultsEl.innerHTML = '';
        resultsEl.classList.add('hidden');
    }
    if (chipAvatar) chipAvatar.src = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    if (chipName) chipName.textContent = user.full_name || user.username || 'مستخدم بدون اسم';
    if (chipEl) chipEl.classList.remove('hidden');
    if (manageSection) manageSection.classList.remove('hidden');

    setStatusText(statusEl, 'جاري تحميل أوسمة المستخدم…', 'loading');

    const { data, error } = await supabaseClient.rpc('admin_get_user_badges', { p_user_id: user.id });

    if (error) {
        console.error('[admin.js] فشل تحميل أوسمة المستخدم:', error);
        setStatusText(statusEl, 'تعذّر تحميل أوسمة المستخدم. حاول تاني.', 'error');
        badgesSelectedUserUnlockedIds = new Set();
    } else {
        badgesSelectedUserUnlockedIds = new Set((data || []).map((row) => row.badge_id));
        setStatusText(statusEl, '', null);
    }

    renderBadgesToggleList();
    renderBadgesFeaturedSelect(user.featured_badge_id ?? null);
}

/** بتلغي اختيار المستخدم الحالي وترجّع مربع البحث تاني (زي clearNotifyRecipient بالظبط) */
function clearBadgesUser() {
    badgesSelectedUser = null;
    badgesSelectedUserUnlockedIds = new Set();

    const searchInput = document.getElementById('badgesUserSearchInput');
    const chipEl = document.getElementById('badgesUserSelectedChip');
    const manageSection = document.getElementById('badgesManageSection');

    if (searchInput) searchInput.classList.remove('hidden');
    if (chipEl) chipEl.classList.add('hidden');
    if (manageSection) manageSection.classList.add('hidden');
}

/** يرسم قائمة كل الأوسمة بالكتالوج مع Toggle لكل واحد يعكس حالة الفتح الحالية عند badgesSelectedUser */
function renderBadgesToggleList() {
    const listEl = document.getElementById('badgesToggleList');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (badgesCatalog.length === 0) {
        listEl.innerHTML = `<li class="admin-status-text" data-state="empty">لسه مفيش أوسمة في الكتالوج.</li>`;
        return;
    }

    badgesCatalog.forEach((badge) => {
        listEl.appendChild(buildBadgeToggleRowElement(badge));
    });
}

/**
 * تبني عنصر <li> واحد يمثل وسام في القائمة، بما فيه الـ Toggle Switch
 * الخاص بفتحه/إلغائه لصاحب badgesSelectedUser - نفس نمط buildUserRowElement
 * (Toggle) بالظبط
 * @param {object} badge
 * @returns {HTMLLIElement}
 */
function buildBadgeToggleRowElement(badge) {
    const li = document.createElement('li');
    li.className = 'admin-user-row';

    const isUnlocked = badgesSelectedUserUnlockedIds.has(badge.id);
    const toggleId = `badgeToggle_${badge.id}`;

    li.innerHTML = `
        <span class="text-xl shrink-0" aria-hidden="true">${escapeHtml(badge.icon)}</span>
        <div class="admin-user-info">
            <div class="admin-user-name">${escapeHtml(badge.title)}</div>
            <div class="text-[0.65rem] font-medium text-lux-500 mt-0.5">${escapeHtml(badge.description || '')}</div>
        </div>
        <div class="admin-user-actions">
            <label class="admin-toggle-switch" for="${toggleId}" title="فتح/إلغاء الوسام">
                <input type="checkbox" id="${toggleId}" ${isUnlocked ? 'checked' : ''}>
                <span class="admin-toggle-switch-track"></span>
                <span class="admin-toggle-switch-thumb"></span>
            </label>
        </div>
    `;

    const toggleWrapper = li.querySelector('.admin-toggle-switch');
    const toggleInput = li.querySelector(`#${toggleId}`);

    toggleInput.addEventListener('change', async () => {
        const newValue = toggleInput.checked;

        toggleWrapper.classList.add('is-saving');
        const succeeded = await handleBadgeToggleChange(badge.id, newValue);
        toggleWrapper.classList.remove('is-saving');

        if (!succeeded) {
            toggleInput.checked = !newValue;
        }
    });

    return li;
}

/**
 * بتتعامل مع تغيير Toggle وسام معين - بتنادي admin_set_user_badge RPC،
 * وبعد النجاح بتحدّث badgesSelectedUserUnlockedIds محلياً + تعيد رسم
 * قائمة "الشارة المميزة" (لو الوسام اتقفل وكان هو نفسه الشارة المميزة،
 * الدالة في السيرفر بتشيلها تلقائياً - فبنعيد رسم الـ select بقيمة
 * badgesSelectedUser.featured_badge_id القديمة برضو عشان تتنضف بصرياً
 * لو اتشالت)
 * @param {string} badgeId
 * @param {boolean} unlocked
 * @returns {Promise<boolean>}
 */
async function handleBadgeToggleChange(badgeId, unlocked) {
    if (!badgesSelectedUser) return false;

    const statusEl = document.getElementById('badgesManageStatus');
    const { error } = await supabaseClient.rpc('admin_set_user_badge', {
        p_user_id: badgesSelectedUser.id,
        p_badge_id: badgeId,
        p_unlocked: unlocked,
    });

    if (error) {
        console.error('[admin.js] فشل تحديث حالة الوسام:', error);
        setStatusText(statusEl, 'تعذّر تحديث حالة الوسام. حاول تاني.', 'error');
        return false;
    }

    if (unlocked) {
        badgesSelectedUserUnlockedIds.add(badgeId);
    } else {
        badgesSelectedUserUnlockedIds.delete(badgeId);
        // لو الوسام المُلغى كان هو الشارة المميزة، الدالة في السيرفر
        // بتشيلها تلقائياً من profiles.featured_badge_id - بنعكس نفس
        // الحاجة محلياً عشان الـ select يتحدّث فوراً من غير Reload
        if (badgesSelectedUser.featured_badge_id === badgeId) {
            badgesSelectedUser.featured_badge_id = null;
        }
    }

    setStatusText(statusEl, 'اتحفظ ✓', 'success');
    renderBadgesFeaturedSelect(badgesSelectedUser.featured_badge_id ?? null);
    return true;
}

/**
 * يرسم قائمة "الشارة المميزة" المنسدلة - مقصورة على الأوسمة المفتوحة
 * فعلاً عند badgesSelectedUser (badgesSelectedUserUnlockedIds)، بترتيب
 * sort_order نفسه المستخدم في الكتالوج
 * @param {string|null} currentFeaturedBadgeId
 */
function renderBadgesFeaturedSelect(currentFeaturedBadgeId) {
    const selectEl = document.getElementById('badgesFeaturedSelect');
    if (!selectEl) return;

    const unlockedBadges = badgesCatalog.filter((badge) => badgesSelectedUserUnlockedIds.has(badge.id));

    selectEl.innerHTML = `
        <option value="">بدون شارة مميزة</option>
        ${unlockedBadges.map((badge) => `
            <option value="${escapeHtml(badge.id)}">${escapeHtml(badge.icon)} ${escapeHtml(badge.title)}</option>
        `).join('')}
    `;

    selectEl.value = currentFeaturedBadgeId && unlockedBadges.some((b) => b.id === currentFeaturedBadgeId)
        ? currentFeaturedBadgeId
        : '';
}

/** بتتعامل مع تغيير قائمة "الشارة المميزة" - بتنادي admin_set_featured_badge RPC */
async function handleBadgesFeaturedSelectChange() {
    if (!badgesSelectedUser) return;

    const selectEl = document.getElementById('badgesFeaturedSelect');
    const statusEl = document.getElementById('badgesManageStatus');
    const newBadgeId = selectEl.value || null;
    const previousBadgeId = badgesSelectedUser.featured_badge_id ?? null;

    selectEl.disabled = true;
    setStatusText(statusEl, 'جاري الحفظ…', 'loading');

    const { error } = await supabaseClient.rpc('admin_set_featured_badge', {
        p_user_id: badgesSelectedUser.id,
        p_badge_id: newBadgeId,
    });

    selectEl.disabled = false;

    if (error) {
        console.error('[admin.js] فشل تحديث الشارة المميزة:', error);
        setStatusText(statusEl, 'تعذّر تحديث الشارة المميزة. حاول تاني.', 'error');
        renderBadgesFeaturedSelect(previousBadgeId); // Rollback بصري
        return;
    }

    badgesSelectedUser.featured_badge_id = newBadgeId;
    setStatusText(statusEl, 'اتحفظ ✓', 'success');
}

/** ربط كل أحداث ويدجت الأوسمة - تُستدعى مرة واحدة من initAdminPage */
function initBadgesWidget() {
    const searchInput = document.getElementById('badgesUserSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderBadgesUserPickerResults(searchInput.value));
    }

    const clearBtn = document.getElementById('badgesUserClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearBadgesUser);

    const featuredSelect = document.getElementById('badgesFeaturedSelect');
    if (featuredSelect) featuredSelect.addEventListener('change', handleBadgesFeaturedSelectChange);

    loadBadgesCatalog();
}


/* ==================================================================
   3ه) Widget: صندوق رسائل الدعم (المرحلة 8)
   ------------------------------------------------------------------
   جدول support_messages + RLS + trigger الإشعار التلقائي كلهم في
   sql/phase-8-support-messages.sql. الويدجت هنا بترسم قائمة كل
   المحادثات (admin_list_support_conversations RPC)، وبالضغط على
   محادثة بتحول العرض لثريد رسايلها (قراءة مباشرة عن طريق .from()
   العادي - RLS بتسمح للأدمن بيها من غير أي RPC، شوف الملف SQL)، ومربع
   رد بسيط (INSERT مباشر بـ is_from_admin=true - نفس شرط الرد "من جوه
   التطبيق بحسابك الشخصي" في خطوة 40، الـ trigger في القاعدة هو اللي
   بيبعت إشعار admin_message للمستخدم تلقائياً، مفيش داعي نكرر منطق
   الإشعار هنا تاني).
   ================================================================== */

/** معرّف صاحب المحادثة المفتوحة حالياً في الويدجت - null لو لسه في وضع القائمة */
let supportInboxActiveUserId = null;

/** (تعديل) قناة Realtime لصندوق رسائل الدعم في لوحة التحكم - مشتركة
 * طول ما صفحة الأدمن مفتوحة، بتتابع أي رسالة جديدة (من أي مستخدم) عشان
 * القائمة/الثريد المفتوح يتحدثوا فوراً من غير ما تحتاج تعمل Refresh
 * للصفحة يدوياً */
let supportInboxRealtimeChannel = null;

/** بداية/إعادة الاشتراك في قناة Realtime بتاعة صندوق الرسائل */
function subscribeSupportInboxRealtime() {
    if (supportInboxRealtimeChannel) return;

    supportInboxRealtimeChannel = supabaseClient
        .channel('admin_support_messages_dashboard')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'support_messages',
        }, async (payload) => {
            // لو الثريد المفتوح دلوقتي هو بتاع نفس المستخدم صاحب الرسالة
            // الجديدة، بنعيد رسمه فوراً (ونعلّمه مقروء لو كانت من المستخدم
            // مش رد منك انت)
            if (supportInboxActiveUserId && payload.new.sender_id === supportInboxActiveUserId) {
                await loadAndRenderSupportThread(supportInboxActiveUserId);
                if (!payload.new.is_from_admin) {
                    await supabaseClient.rpc('admin_mark_support_conversation_read', { p_user_id: supportInboxActiveUserId });
                }
            } else {
                // مش الثريد المفتوح دلوقتي (أو لسه في وضع القائمة) - بس
                // نعيد رسم قائمة كل المحادثات عشان الترتيب/آخر رسالة/عداد
                // غير المقروء يتحدثوا
                loadAndRenderSupportInboxList();
            }
        })
        .subscribe();
}

/** جلب ورسم قائمة كل المحادثات */
async function loadAndRenderSupportInboxList() {
    const listEl = document.getElementById('supportInboxConversationsList');
    const statusEl = document.getElementById('supportInboxStatus');
    if (!listEl) return;

    listEl.innerHTML = `<li class="admin-status-text" data-state="loading">جاري تحميل المحادثات…</li>`;

    const { data, error } = await supabaseClient.rpc('admin_list_support_conversations');

    if (error) {
        console.error('[admin.js] فشل تحميل محادثات الدعم:', error);
        listEl.innerHTML = '';
        setStatusText(statusEl, 'تعذّر تحميل المحادثات. حاول تاني.', 'error');
        return;
    }

    setStatusText(statusEl, '', null);

    if (!data || data.length === 0) {
        listEl.innerHTML = `<li class="admin-status-text" data-state="empty">مفيش رسايل دعم لسه.</li>`;
        return;
    }

    listEl.innerHTML = '';
    data.forEach((conversation) => listEl.appendChild(buildSupportConversationRow(conversation)));
}

/**
 * تبني صف واحد في قائمة المحادثات - نفس نمط buildUserRowElement بصرياً
 * @param {object} conversation - صف من admin_list_support_conversations
 * @returns {HTMLLIElement}
 */
function buildSupportConversationRow(conversation) {
    const li = document.createElement('li');
    li.className = 'admin-user-row cursor-pointer';

    const avatarUrl = conversation.avatar_url || buildFallbackAvatarUrl(conversation.full_name || '?');
    const unreadCount = Number(conversation.unread_count || 0);
    const lastMessagePrefix = conversation.last_message_from_admin ? 'انت: ' : '';

    li.innerHTML = `
        <img class="admin-user-avatar" src="${avatarUrl}" alt="" loading="lazy">
        <div class="admin-user-info">
            <div class="admin-user-name">${escapeHtml(conversation.full_name || 'مستخدم')}</div>
            <div class="text-[0.65rem] font-medium text-lux-500 mt-0.5 truncate">${escapeHtml(lastMessagePrefix + (conversation.last_message || ''))} · ${formatRelativeArabicTime(conversation.last_message_at)}</div>
        </div>
        <div class="admin-user-actions">
            ${unreadCount > 0
                ? `<span class="shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-gold-500 text-lux-950 text-[10px] font-black">${unreadCount}</span>`
                : ''}
        </div>
    `;

    li.addEventListener('click', () => openSupportConversation(conversation.user_id));
    return li;
}

/** فتح محادثة معينة - بيحول العرض من القائمة لثريد الرسايل + يعلّمها مقروءة */
async function openSupportConversation(userId) {
    supportInboxActiveUserId = userId;

    document.getElementById('supportInboxConversationsList')?.classList.add('hidden');
    document.getElementById('supportInboxBackBtn')?.classList.remove('hidden');
    document.getElementById('supportInboxTitle').textContent = 'محادثة الدعم';
    document.getElementById('supportInboxThreadView')?.classList.remove('hidden');

    await loadAndRenderSupportThread(userId);

    await supabaseClient.rpc('admin_mark_support_conversation_read', { p_user_id: userId });
}

/** الرجوع من ثريد محادثة لقائمة كل المحادثات تاني */
function backToSupportInboxList() {
    supportInboxActiveUserId = null;

    document.getElementById('supportInboxThreadView')?.classList.add('hidden');
    document.getElementById('supportInboxBackBtn')?.classList.add('hidden');
    document.getElementById('supportInboxTitle').textContent = 'صندوق رسائل الدعم';
    document.getElementById('supportInboxConversationsList')?.classList.remove('hidden');

    loadAndRenderSupportInboxList();
}

/** جلب ورسم كل رسايل محادثة معينة - قراءة مباشرة (RLS بتسمح للأدمن يشوف أي محادثة) */
async function loadAndRenderSupportThread(userId) {
    const messagesEl = document.getElementById('supportInboxMessagesList');
    if (!messagesEl) return;

    messagesEl.innerHTML = `<p class="admin-status-text" data-state="loading">جاري التحميل…</p>`;

    const { data, error } = await supabaseClient
        .from('support_messages')
        .select('id, is_from_admin, content, created_at')
        .eq('sender_id', userId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('[admin.js] فشل تحميل رسايل المحادثة:', error);
        messagesEl.innerHTML = `<p class="admin-status-text" data-state="error">تعذّر تحميل الرسايل.</p>`;
        return;
    }

    if (!data || data.length === 0) {
        messagesEl.innerHTML = `<p class="admin-status-text" data-state="empty">مفيش رسايل لسه.</p>`;
        return;
    }

    messagesEl.innerHTML = data.map((msg) => `
        <div class="flex flex-col ${msg.is_from_admin ? 'items-end' : 'items-start'}">
            <div class="max-w-[85%] rounded-2xl px-3 py-2 text-xs font-medium leading-relaxed whitespace-pre-wrap break-words ${
                msg.is_from_admin ? 'bg-gold-500 text-lux-950' : 'bg-lux-800 text-lux-50'
            }">${escapeHtml(msg.content)}</div>
            <span class="text-[10px] text-lux-500 font-bold mt-1 px-1">${formatRelativeArabicTime(msg.created_at)}</span>
        </div>
    `).join('');

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** إرسال رد الأدمن على المحادثة المفتوحة حالياً */
async function handleSupportInboxReplySend() {
    if (!supportInboxActiveUserId) return;

    const inputEl = document.getElementById('supportInboxReplyInput');
    const sendBtn = document.getElementById('supportInboxReplySendBtn');
    const statusEl = document.getElementById('supportInboxStatus');
    if (!inputEl) return;

    const content = inputEl.value.trim();
    if (!content) return;

    if (sendBtn) sendBtn.disabled = true;
    setStatusText(statusEl, 'جاري الإرسال…', 'loading');

    const { error } = await supabaseClient
        .from('support_messages')
        .insert({
            sender_id: supportInboxActiveUserId,
            is_from_admin: true,
            content,
        });

    if (sendBtn) sendBtn.disabled = false;

    if (error) {
        console.error('[admin.js] فشل إرسال الرد:', error);
        setStatusText(statusEl, 'تعذّر إرسال الرد. حاول تاني.', 'error');
        return;
    }

    inputEl.value = '';
    setStatusText(statusEl, 'اتبعت ✓', 'success');
    await loadAndRenderSupportThread(supportInboxActiveUserId);
}

/** ربط كل أحداث ويدجت صندوق الرسائل - تُستدعى مرة واحدة من initAdminPage */
function initSupportInboxWidget() {
    const backBtn = document.getElementById('supportInboxBackBtn');
    if (backBtn) backBtn.addEventListener('click', backToSupportInboxList);

    const sendBtn = document.getElementById('supportInboxReplySendBtn');
    if (sendBtn) sendBtn.addEventListener('click', handleSupportInboxReplySend);

    const replyInput = document.getElementById('supportInboxReplyInput');
    if (replyInput) {
        replyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSupportInboxReplySend();
            }
        });
    }

    loadAndRenderSupportInboxList();
    subscribeSupportInboxRealtime();
}


/* ==================================================================
   4) دالة مساعدة عامة: تحديث نص وحالة عنصر رسالة الحالة
   ================================================================== */

/**
 * @param {HTMLElement|null} el
 * @param {string} message
 * @param {'loading'|'success'|'error'|'empty'|null} state
 */
function setStatusText(el, message, state) {
    if (!el) return;
    el.textContent = message;
    if (state) {
        el.dataset.state = state;
    } else {
        delete el.dataset.state;
    }
}


/* ==================================================================
   4ب) التنقل بين التابات (Sidebar بالديسكتوب + شريط سفلي بالموبايل)
   ------------------------------------------------------------------
   بتبدّل ظهور 3 أقسام (#tabPanelVisitors / #tabPanelGeofence /
   #tabPanelUsers) عن طريق كلاس hidden - تاب واحد بس ظاهر في المرة
   الواحدة، ومنطقة المحتوى (<main>) هي بس اللي بتعمل Scroll (شوف
   overflow-y-auto على <main> في admin.html) بدل الصفحة كلها.

   [تحديث الشكل] admin.html بقى فيه نسختين من نفس أزرار التنقل بنفس
   data-tab-target (الـ Sidebar بالديسكتوب + الشريط السفلي بالموبايل -
   واحدة بس ظاهرة فعلياً في كل مرة حسب حجم الشاشة). querySelectorAll
   تحت بتلقط الاتنين مع بعض، فلازم نزامن حالة .is-active بينهم بالـ
   data-tab-target مش بمقارنة العنصر اللي اتضغط نفسه (b === btn) زي
   قبل كده - وإلا لو ضغطت من الـ Sidebar، الزرار المقابل في الشريط
   السفلي (لو اتعرض بعدين برضو، زي عند تصغير الشاشة من غير Refresh)
   هيفضل واقف على تاب قديم
   ================================================================== */

function initAdminTabNavigation() {
    const tabButtons = document.querySelectorAll('.admin-nav-tab[data-tab-target]');
    const panels = document.querySelectorAll('.admin-tab-panel');

    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.tabTarget;

            panels.forEach((panel) => {
                panel.classList.toggle('hidden', panel.id !== targetId);
            });
            // بنزامن كل نسخ الزرار (Sidebar + شريط سفلي) اللي بتشاور
            // على نفس التاب، مش بس الزرار اللي اتضغط فعلياً
            tabButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.tabTarget === targetId));

            // نرجّع منطقة المحتوى لأول سطر لما تفتح تاب جديد - تجربة
            // أنضف من إنك تلاقي نفسك في نص Scroll قديم من تاب سابق
            const mainEl = document.querySelector('main');
            if (mainEl) mainEl.scrollTop = 0;
        });
    });
}


/* ==================================================================
   5) التهيئة العامة
   ================================================================== */

async function initAdminPage() {
    // بوابة الصلاحية أول حاجة - لو مش أدمن، بترجع false وتكون عملت
    // redirect فعلاً لـ index.html، فمنكملش نعرض أي widget خالص
    const isAdmin = await verifyAdminAccessOrRedirect();
    if (!isAdmin) return;

    // اتأكدنا إنه أدمن فعلاً - نظهر المحتوى اللي كان مخفي بـ visibility:hidden
    const contentEl = document.getElementById('adminPageContent');
    if (contentEl) contentEl.style.visibility = 'visible';

    initAdminTabNavigation();
    initGeofenceRadiusWidget();
    initUserVerificationWidget();
    initNotifyWidget();
    initHomeBannerWidget();
    initAppIdentityWidget();
    initPostsWidget();
    initDailyQuestionsWidget();
    initBadgesWidget();
    initSupportInboxWidget();
    loadGeofenceSettings();
    loadVisitorStats();
}

document.addEventListener('DOMContentLoaded', initAdminPage);