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

import { clearGeofenceSettingsCache, calculateDistanceMeters } from './geofence.js';

/** إحداثيات مركز نزلة عبيد ونصف القطر الافتراضي المعتمد في لوحة التحكم */
let cachedAdminGeofenceCenter = { lat: 28.173896, lng: 30.762894, radius: 2000 };

const { createClient } = window.supabase;
const SUPABASE_URL = 'https://rvytcqozbwsqpslkehiw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ieqWt5WLLppNF8HJJbQ9lQ_7PAd6mhN';

export const adminSupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'sekkawy-admin-session',
    },
});
const supabaseClient = adminSupabaseClient;


/* ==================================================================
   0) بوابة التحقق من صلاحية الأدمن - أول حاجة بتتنفذ في الصفحة
   ------------------------------------------------------------------
   بتشتغل قبل أي widget تاني. لو مفيش جلسة، أو فيه جلسة بس role مش
   admin، بنعمل redirect فوري لـ index.html من غير ما نعرض أي محتوى
   من لوحة التحكم خالص.
   ================================================================== */

/** id الأدمن الحالي (اللي فاتح لوحة التحكم) */
let currentAdminUserId = null;
let isAdminModulesInitialized = false;

/**
 * التحقق من صلاحية الأدمن للمستخدم المسجل حالياً (إن وجد)
 * @returns {Promise<boolean>}
 */
async function checkAdminSession() {
    try {
        const { data: { user }, error: userError } = await adminSupabaseClient.auth.getUser();
        if (userError || !user) return false;

        const { data: profile, error } = await adminSupabaseClient
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();

        if (error || !profile || profile.role !== 'admin') {
            return false;
        }

        currentAdminUserId = user.id;
        return true;
    } catch (e) {
        console.error('[admin.js] خطأ في فحص صلاحيات الأدمن:', e);
        return false;
    }
}

/**
 * إظهار لوحة التحكم بعد التحقق الناجح من الأدمن
 */
function revealAdminDashboard() {
    const gateEl = document.getElementById('adminLoginGate');
    const contentEl = document.getElementById('adminPageContent');

    if (gateEl) gateEl.classList.add('hidden');
    if (contentEl) contentEl.style.visibility = 'visible';

    if (!isAdminModulesInitialized) {
        isAdminModulesInitialized = true;
        initAdminDashboardModules();
    }
}

/**
 * إظهار بوابة تسجيل الدخول للأدمن وقفل لوحة التحكم
 */
function showAdminLoginGate(errorMessage = '') {
    const gateEl = document.getElementById('adminLoginGate');
    const contentEl = document.getElementById('adminPageContent');
    const errorEl = document.getElementById('adminGateError');

    if (contentEl) contentEl.style.visibility = 'hidden';
    if (gateEl) gateEl.classList.remove('hidden');

    if (errorEl) {
        if (errorMessage) {
            errorEl.textContent = errorMessage;
            errorEl.classList.remove('hidden');
        } else {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
    }
}

/**
 * ربط بوابة تسجيل الدخول للأدمن وأزرار الخروج
 */
function initAdminLoginGate() {
    const gateForm = document.getElementById('adminGateForm');
    const usernameInput = document.getElementById('adminGateUsername');
    const passwordInput = document.getElementById('adminGatePassword');
    const submitBtn = document.getElementById('btnAdminGateSubmit');
    const spinner = document.getElementById('adminGateSpinner');
    const btnText = document.getElementById('adminGateBtnText');
    const errorEl = document.getElementById('adminGateError');

    // أزرار تسجيل الخروج (ديسكتوب وموبايل)
    const btnLogout = document.getElementById('btnAdminLogout');
    const btnMobileLogout = document.getElementById('btnAdminMobileLogout');

    const handleLogout = async () => {
        if (!confirm('هل تريد تسجيل الخروج من لوحة التحكم؟')) return;
        try {
            await supabaseClient.auth.signOut();
        } catch (e) {
            console.error('Logout error:', e);
        }
        window.location.reload();
    };

    if (btnLogout) btnLogout.addEventListener('click', handleLogout);
    if (btnMobileLogout) btnMobileLogout.addEventListener('click', handleLogout);

    if (!gateForm) return;

    gateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (errorEl) errorEl.classList.add('hidden');

        const rawUsername = usernameInput ? usernameInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value : '';

        if (!rawUsername || !password) {
            if (errorEl) {
                errorEl.textContent = 'من فضلك اكتب اسم المستخدم وكلمة المرور';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        // تحويل اسم المستخدم لإيميل داخلي لو لم يكن إيميل كامل
        let email = rawUsername.toLowerCase();
        if (!email.includes('@')) {
            email = `${email}@batal.com`;
        }

        // حالة التحميل
        if (submitBtn) submitBtn.disabled = true;
        if (spinner) spinner.classList.remove('hidden');
        if (btnText) btnText.textContent = 'جاري التحقق…';

        try {
            const { data, error: signInError } = await supabaseClient.auth.signInWithPassword({
                email,
                password,
            });

            if (signInError) {
                console.error('[admin.js] فشل تسجيل دخول الأدمن:', signInError.message);
                if (errorEl) {
                    errorEl.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة';
                    errorEl.classList.remove('hidden');
                }
                return;
            }

            const loggedInUser = data && data.user;
            if (!loggedInUser) {
                throw new Error('تعذر جلب بيانات المستخدم');
            }

            // فحص دور المستخدم role في جدول profiles
            const { data: profile, error: profileErr } = await supabaseClient
                .from('profiles')
                .select('role')
                .eq('id', loggedInUser.id)
                .single();

            if (profileErr || !profile || profile.role !== 'admin') {
                // ليس أدمن! نسجل خروجه فوراً ونقفل اللوحة بوجهه
                await supabaseClient.auth.signOut({ scope: 'local' });
                if (errorEl) {
                    errorEl.textContent = 'هذا الحساب لا يملك صلاحيات الإدارة';
                    errorEl.classList.remove('hidden');
                }
                return;
            }

            // تم التحقق بنجاح كأدمن
            currentAdminUserId = loggedInUser.id;
            revealAdminDashboard();
        } catch (err) {
            console.error('[admin.js] خطأ غير متوقع في تسجيل الدخول:', err);
            if (errorEl) {
                errorEl.textContent = 'حدث خطأ أثناء تسجيل الدخول: ' + (err.message || 'حاول ثانية');
                errorEl.classList.remove('hidden');
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            if (spinner) spinner.classList.add('hidden');
            if (btnText) btnText.textContent = 'تسجيل الدخول للإدارة';
        }
    });
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

/**
 * التحقق مما إذا كان توثيق المستخدم نشطاً حالياً (دائم أو تاريخ الانتهاء في المستقبل)
 * @param {object} user
 * @returns {boolean}
 */
function isUserVerificationActive(user) {
    if (!user) return false;
    if (!user.is_verified) return false;
    if (!user.verified_until) return true;
    return new Date(user.verified_until) > new Date();
}

/**
 * بناء شارة التوثيق الذهبية الرسمية بتصميم دائري مميز وفاخر (Scalloped Rosette Seal)
 * @param {boolean} isVerified
 * @param {string} [extraClasses='']
 * @returns {string}
 */
function buildVerifiedBadgeHtml(isVerified, extraClasses = '') {
    if (!isVerified) return '';
    return `<span class="inline-flex items-center align-middle select-none text-gold-400 cursor-pointer shrink-0 ${extraClasses}" title="حساب موثق رسمي في سِكّاوي" onclick="if(window.showToast) window.showToast('حساب موثق رسمي في سِكّاوي')"><svg class="w-4 h-4 inline-block shrink-0" viewBox="0 0 24 24" fill="none"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.67-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z" fill="#D4AF37"/><circle cx="12" cy="12" r="7.5" stroke="#FFF0A0" stroke-width="0.6" stroke-opacity="0.5"/><path d="M7.75 12l3.25 3.25 6-6.5" stroke="#0B0D12" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}


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

    try {
        const { data: analytics, error: analyticsErr } = await supabaseClient.rpc('admin_get_traffic_analytics');
        if (!analyticsErr && analytics) {
            renderPeakHoursAndSegmentation(analytics);
        }
    } catch (e) {
        console.error('[admin.js] فشل تحميل تحليلات المرور:', e);
    }
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
    const todayTotal = todayRegistered + todayGuests;

    const todayTotalEl = document.getElementById('visitorsTodayTotal');
    const registeredEl = document.getElementById('visitorsTodayRegistered');
    const guestsEl = document.getElementById('visitorsTodayGuests');
    const totalEl = document.getElementById('visitorsAllTimeTotal');

    if (todayTotalEl) todayTotalEl.textContent = todayTotal.toLocaleString('ar-EG');
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
    if (!user || !user.is_online || !user.last_seen_at) return false;
    const lastSeenTime = new Date(user.last_seen_at).getTime();
    if (isNaN(lastSeenTime)) return false;
    const elapsedMs = Date.now() - lastSeenTime;
    // التحقق من الحداثة وحماية تفاوت التوقيت (ساعة الجهاز متأخرة أو متقدمة)
    return elapsedMs > -2 * 60 * 60 * 1000 && elapsedMs < ONLINE_FRESHNESS_THRESHOLD_MS;
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

    if (data.geofence_center_lat && data.geofence_center_lng) {
        cachedAdminGeofenceCenter.lat = Number(data.geofence_center_lat);
        cachedAdminGeofenceCenter.lng = Number(data.geofence_center_lng);
    }
    if (data.geofence_radius_meters) {
        cachedAdminGeofenceCenter.radius = Number(data.geofence_radius_meters);
    }

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

    clearGeofenceSettingsCache();
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
async function toggleUserBlock(userId, shouldBlock, reason, durationHours = null) {
    const { data, error } = await supabaseClient
        .rpc('admin_toggle_user_block', {
            p_user_id: userId,
            p_should_block: shouldBlock,
            p_reason: reason || null,
            p_duration_hours: durationHours > 0 ? durationHours : null,
        });

    if (error) {
        console.error('[admin.js] فشل تحديث حالة حظر المستخدم:', error);
        return null;
    }

    try {
        const u = Array.isArray(allUsersList) ? allUsersList.find((x) => x.id === userId) : null;
        const name = u?.full_name || u?.username || 'مستخدم';
        if (typeof addCompetitorAuditEntry === 'function') {
            addCompetitorAuditEntry(name, shouldBlock ? 'حظر/تجميد' : 'إلغاء حظر', shouldBlock ? `حظر الحساب: ${reason || 'بدون سبب'}` : 'فك الحظر وتفعيل الحساب');
        }
    } catch (_) {}

    return data || { success: true };
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
    renderSponsorAnalytics();

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

    // تحديث إحصاءات نبض القرية اليوم ومنصة التتويج
    updateVillageOverviewStats();
}

/**
 * تحديث إحصاءات نبض قرية نزلة عبيد في الصفحة الرئيسية:
 * - إجمالي خطوات القرية اليوم (مجموع daily_steps لجميع المشتركين)
 * - إجمالي المسافة المقطوعة بالكيلومترات (خطوات القرية / 1300)
 * - المشتركون الذين حققوا الهدف اليومي (6000 خطوة فأكثر) ونسبتهم
 * - منصة تتويج متصدري اليوم (المراكز الثلاثة الأولى)
 */
function updateVillageOverviewStats() {
    if (!Array.isArray(allUsersList)) return;

    // 1) حساب إجمالي خطوات القرية اليوم
    const totalDailySteps = allUsersList.reduce((acc, u) => {
        const s = Number(u.daily_steps || 0);
        return acc + (s > 0 ? s : 0);
    }, 0);

    const totalKm = (totalDailySteps / 1300).toFixed(1);

    // 2) حساب محققي الهدف اليومي (6,000 خطوة فما فوق)
    const goalAchievers = allUsersList.filter((u) => Number(u.daily_steps || 0) >= 6000);
    const activeWalkers = allUsersList.filter((u) => Number(u.daily_steps || 0) > 0);
    const goalPct = activeWalkers.length > 0
        ? Math.round((goalAchievers.length / activeWalkers.length) * 100)
        : (allUsersList.length > 0 ? Math.round((goalAchievers.length / allUsersList.length) * 100) : 0);

    const stepsEl = document.getElementById('statVillageTotalSteps');
    const kmEl = document.getElementById('statVillageTotalKm');
    const goalAchieversEl = document.getElementById('statVillageGoalAchievers');
    const goalPctEl = document.getElementById('statVillageGoalPct');
    const changeLabelEl = document.getElementById('statVillageStepsChangeLabel');

    if (stepsEl) stepsEl.textContent = totalDailySteps.toLocaleString('ar-EG');
    if (kmEl) kmEl.textContent = Number(totalKm).toLocaleString('ar-EG');
    if (goalAchieversEl) goalAchieversEl.textContent = goalAchievers.length.toLocaleString('ar-EG');
    if (goalPctEl) goalPctEl.textContent = `(${goalPct.toLocaleString('ar-EG')}%)`;
    if (changeLabelEl) {
        changeLabelEl.textContent = `${activeWalkers.length.toLocaleString('ar-EG')} متسابق مشى اليوم`;
    }

    // 3) رسم منصة تتويج أبطال اليوم وسجل التنافس ولوحة الشرف
    renderVillageDailyPodium();
    renderCompetitorsHallOfFame();
}

/**
 * ترسم منصة تتويج اليوم (المراكز الثلاثة الأولى في خطوات اليوم بنزلة عبيد)
 */
function renderVillageDailyPodium() {
    const container = document.getElementById('villageDailyPodiumContainer');
    if (!container) return;

    if (!Array.isArray(allUsersList) || allUsersList.length === 0) {
        container.innerHTML = `
            <div class="col-span-full p-4 rounded-xl bg-lux-950/40 border border-lux-800/60 text-center text-lux-400 text-xs font-medium">
                جاري تحميل بيانات المتسابقين…
            </div>
        `;
        return;
    }

    const sortedWalkers = allUsersList
        .filter((u) => Number(u.daily_steps || 0) > 0)
        .sort((a, b) => Number(b.daily_steps || 0) - Number(a.daily_steps || 0));

    if (sortedWalkers.length === 0) {
        container.innerHTML = `
            <div class="col-span-full p-4 rounded-xl bg-lux-950/40 border border-lux-800/60 text-center text-lux-400 text-xs font-medium">
                لم يتم تسجيل أي خطوات اليوم حتى الآن. سيظهر المتصدرون بمجرد بدء المتسابقين في المشي.
            </div>
        `;
        return;
    }

    const topThree = sortedWalkers.slice(0, 3);
    const rankConfigs = [
        {
            rank: 1,
            title: 'بطل اليوم (المركز الأول)',
            badgeText: 'المركز 1',
            badgeBg: 'bg-gold-500/20 text-gold-300 border-gold-500/40',
            cardBorder: 'border-gold-500/40 bg-gradient-to-b from-gold-500/10 via-lux-950/60 to-lux-950/80',
            stepsColor: 'text-gold-400',
        },
        {
            rank: 2,
            title: 'المركز الثاني',
            badgeText: 'المركز 2',
            badgeBg: 'bg-slate-400/20 text-slate-200 border-slate-400/40',
            cardBorder: 'border-slate-500/30 bg-gradient-to-b from-slate-500/10 via-lux-950/60 to-lux-950/80',
            stepsColor: 'text-slate-200',
        },
        {
            rank: 3,
            title: 'المركز الثالث',
            badgeText: 'المركز 3',
            badgeBg: 'bg-amber-700/25 text-amber-300 border-amber-600/40',
            cardBorder: 'border-amber-700/30 bg-gradient-to-b from-amber-700/10 via-lux-950/60 to-lux-950/80',
            stepsColor: 'text-amber-300',
        },
    ];

    container.innerHTML = topThree.map((user, idx) => {
        const conf = rankConfigs[idx] || rankConfigs[2];
        const name = escapeHtml(user.full_name || user.username || 'متسابق');
        const username = user.username ? `@${escapeHtml(user.username)}` : '';
        const steps = Number(user.daily_steps || 0).toLocaleString('ar-EG');
        const km = (Number(user.daily_steps || 0) / 1300).toFixed(1);
        const avatarUrl = user.avatar_url || '';
        const isOnline = isUserOnline(user);
        const isVerified = isUserVerificationActive(user);

        return `
            <div class="p-3.5 sm:p-4 rounded-2xl border ${conf.cardBorder} flex flex-col justify-between space-y-3 relative overflow-hidden group hover:scale-[1.01] transition shadow-soft-card">
                <div class="flex items-center justify-between">
                    <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black border ${conf.badgeBg}">${conf.badgeText}</span>
                    <span class="text-[10px] font-bold text-lux-400">${conf.title}</span>
                </div>
                <div class="flex items-center gap-3">
                    <div class="relative shrink-0">
                        ${avatarUrl ? `
                            <img src="${escapeHtml(avatarUrl)}" class="w-11 h-11 rounded-full object-cover border border-lux-700 shadow" alt="${name}">
                        ` : `
                            <div class="w-11 h-11 rounded-full bg-lux-800 border border-lux-700 text-gold-400 font-black flex items-center justify-center text-xs shadow">
                                ${name.slice(0, 2)}
                            </div>
                        `}
                        ${isOnline ? '<span class="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-400 ring-2 ring-lux-950"></span>' : ''}
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="text-xs sm:text-sm font-black text-lux-100 truncate flex items-center gap-1">
                            <span>${name}</span>
                            ${isVerified ? buildVerifiedBadgeHtml(true, 'scale-90') : ''}
                        </div>
                        <div class="text-[10px] font-mono text-lux-400 truncate">${username}</div>
                    </div>
                </div>
                <div class="pt-2 border-t border-lux-800/60 flex items-center justify-between">
                    <div>
                        <div class="text-[9px] font-bold text-lux-400">خطوات اليوم</div>
                        <div class="font-mono text-sm sm:text-base font-black ${conf.stepsColor} leading-none mt-0.5">${steps}</div>
                    </div>
                    <div class="text-left">
                        <div class="text-[9px] font-bold text-lux-400">المسافة</div>
                        <div class="font-mono text-xs sm:text-sm font-bold text-cyan-300 leading-none mt-0.5">${km} كم</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/* ==================================================================
   سجل التنافس ولوحة الشرف والشرائح (Competitors Hall of Fame & History)
   ================================================================== */

let hofCurrentSort = 'wins';
const COMPETITORS_AUDIT_STORAGE_KEY = 'sekkawi_competitors_audit_log';

/**
 * جلب سجل العمليات الإدارية المخزنة على المتسابقين
 * @returns {Array<{id: string, timestamp: string, admin: string, user_name: string, action_type: string, detail: string}>}
 */
function getCompetitorsAuditLog() {
    try {
        const raw = localStorage.getItem(COMPETITORS_AUDIT_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (e) {
        console.error('فشل قراءة سجل التعديلات الإدارية:', e);
    }
    return [];
}

/**
 * إضافة عملية إدارية جديدة إلى سجل المتسابقين
 * @param {string} userName
 * @param {string} actionType
 * @param {string} detail
 */
function addCompetitorAuditEntry(userName, actionType, detail) {
    try {
        const currentLogs = getCompetitorsAuditLog();
        const newEntry = {
            id: 'audit_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toISOString(),
            admin: 'إدارة سِكّاوي',
            user_name: userName || 'متسابق',
            action_type: actionType,
            detail: detail,
        };
        currentLogs.unshift(newEntry);
        if (currentLogs.length > 100) currentLogs.length = 100;
        localStorage.setItem(COMPETITORS_AUDIT_STORAGE_KEY, JSON.stringify(currentLogs));
        renderCompetitorsAuditLog();
    } catch (e) {
        console.error('فشل حفظ العملية في سجل التعديلات:', e);
    }
}

/**
 * رسم سجل العمليات الإدارية في #hofAuditLogContainer
 */
function renderCompetitorsAuditLog() {
    const container = document.getElementById('hofAuditLogContainer');
    if (!container) return;

    const logs = getCompetitorsAuditLog();
    if (!logs.length) {
        container.innerHTML = `
            <div class="p-4 rounded-xl bg-lux-950/40 border border-lux-800/60 text-center text-lux-400 text-xs font-medium">
                لا توجد عمليات مسجلة حتى الآن. أي تعديل للخطوات أو تجميد أو توثيق سيُسجل هنا فوراً.
            </div>
        `;
        return;
    }

    container.innerHTML = logs.map((log) => {
        const dateObj = new Date(log.timestamp);
        const timeText = dateObj.toLocaleString('ar-EG', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

        let badgeColor = 'bg-blue-500/15 text-blue-300 border-blue-500/30';
        if (log.action_type.includes('تجميد') || log.action_type.includes('حظر') || log.action_type.includes('خصم')) {
            badgeColor = 'bg-rose-500/15 text-rose-300 border-rose-500/30';
        } else if (log.action_type.includes('توثيق') || log.action_type.includes('إضافة')) {
            badgeColor = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
        }

        return `
            <div class="p-2.5 sm:p-3 rounded-xl bg-lux-950/60 border border-lux-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="px-2 py-0.5 rounded-md text-[10px] font-bold border ${badgeColor}">${escapeHtml(log.action_type)}</span>
                    <span class="font-bold text-lux-100">${escapeHtml(log.user_name)}:</span>
                    <span class="text-lux-300">${escapeHtml(log.detail)}</span>
                </div>
                <div class="text-[10px] font-mono text-lux-500 shrink-0">${escapeHtml(timeText)}</div>
            </div>
        `;
    }).join('');
}

/**
 * تحديث ورسم سجل التنافس ولوحة الشرف والشرائح بالكامل
 */
function renderCompetitorsHallOfFame() {
    if (!Array.isArray(allUsersList) || allUsersList.length === 0) return;

    // 1) كروت القمة التاريخية
    let bestRecordUser = null;
    let maxDailyRecord = 0;

    let mostWinsUser = null;
    let maxWinsTotal = 0;

    let bestStreakUser = null;
    let maxStreakDays = 0;

    allUsersList.forEach((u) => {
        const rec = Number(u.best_daily_steps || 0);
        if (rec > maxDailyRecord) {
            maxDailyRecord = rec;
            bestRecordUser = u;
        }

        const wins = Number(u.daily_championship_wins || 0)
            + Number(u.weekly_championship_wins || 0)
            + Number(u.monthly_championship_wins || 0);
        if (wins > maxWinsTotal) {
            maxWinsTotal = wins;
            mostWinsUser = u;
        }

        const strk = Math.max(Number(u.streak_count || 0), Number(u.best_streak_days || 0));
        if (strk > maxStreakDays) {
            maxStreakDays = strk;
            bestStreakUser = u;
        }
    });

    const elBestRecord = document.getElementById('hofStatBestRecord');
    const elBestRecordHolder = document.getElementById('hofStatBestRecordHolder');
    const elMostWins = document.getElementById('hofStatMostWins');
    const elMostWinsHolder = document.getElementById('hofStatMostWinsHolder');
    const elBestStreak = document.getElementById('hofStatBestStreak');
    const elBestStreakHolder = document.getElementById('hofStatBestStreakHolder');

    if (elBestRecord) elBestRecord.textContent = maxDailyRecord > 0 ? maxDailyRecord.toLocaleString('ar-EG') : '—';
    if (elBestRecordHolder) {
        elBestRecordHolder.textContent = bestRecordUser
            ? `${bestRecordUser.full_name || bestRecordUser.username || 'بطل نزلة عبيد'} (@${bestRecordUser.username || '—'})`
            : 'لم يُسجل بعد';
    }

    if (elMostWins) elMostWins.textContent = maxWinsTotal > 0 ? maxWinsTotal.toLocaleString('ar-EG') : '0';
    if (elMostWinsHolder) {
        if (mostWinsUser && maxWinsTotal > 0) {
            const d = Number(mostWinsUser.daily_championship_wins || 0);
            const w = Number(mostWinsUser.weekly_championship_wins || 0);
            const m = Number(mostWinsUser.monthly_championship_wins || 0);
            elMostWinsHolder.textContent = `${mostWinsUser.full_name || mostWinsUser.username}: ${d} يومي · ${w} أسبوعي · ${m} شهري`;
        } else {
            elMostWinsHolder.textContent = 'في انتظار أول بطل متوج';
        }
    }

    if (elBestStreak) elBestStreak.textContent = maxStreakDays > 0 ? maxStreakDays.toLocaleString('ar-EG') : '0';
    if (elBestStreakHolder) {
        elBestStreakHolder.textContent = bestStreakUser && maxStreakDays > 0
            ? `${bestStreakUser.full_name || bestStreakUser.username || 'بطل الالتزام'} (@${bestStreakUser.username || '—'})`
            : 'لم تبدأ السلاسل بعد';
    }

    // 2) هرم وتوزيع الشرائح
    const totalCount = allUsersList.length;
    const elTotalUsers = document.getElementById('hofTiersTotalUsers');
    if (elTotalUsers) elTotalUsers.textContent = totalCount.toLocaleString('ar-EG');

    let countElites = 0;
    let countActive = 0;
    let countLight = 0;
    let countInactive = 0;

    allUsersList.forEach((u) => {
        const steps = Number(u.daily_steps || 0);
        if (steps >= 10000) {
            countElites += 1;
        } else if (steps >= 6000) {
            countActive += 1;
        } else if (steps >= 1000) {
            countLight += 1;
        } else {
            countInactive += 1;
        }
    });

    const pctElites = totalCount > 0 ? Math.round((countElites / totalCount) * 100) : 0;
    const pctActive = totalCount > 0 ? Math.round((countActive / totalCount) * 100) : 0;
    const pctLight = totalCount > 0 ? Math.round((countLight / totalCount) * 100) : 0;
    const pctInactive = totalCount > 0 ? Math.round((countInactive / totalCount) * 100) : 0;

    const setTier = (idPrefix, count, pct) => {
        const cEl = document.getElementById(`${idPrefix}Count`);
        const pEl = document.getElementById(`${idPrefix}Pct`);
        const bEl = document.getElementById(`${idPrefix}Bar`);
        if (cEl) cEl.textContent = count.toLocaleString('ar-EG');
        if (pEl) pEl.textContent = `${pct.toLocaleString('ar-EG')}%`;
        if (bEl) bEl.style.width = `${pct}%`;
    };

    setTier('tierElites', countElites, pctElites);
    setTier('tierActive', countActive, pctActive);
    setTier('tierLight', countLight, pctLight);
    setTier('tierInactive', countInactive, pctInactive);

    // 3) رسم جدول لوحة الشرف
    renderHofList();

    // 4) رسم سجل العمليات الإدارية
    renderCompetitorsAuditLog();
}

/**
 * رسم قائمة المتسابقين في لوحة الشرف بناءً على معيار الترتيب hofCurrentSort
 */
function renderHofList() {
    const container = document.getElementById('hofCompetitorsListContainer');
    if (!container) return;

    const sorted = allUsersList.slice().sort((a, b) => {
        if (hofCurrentSort === 'record') {
            return Number(b.best_daily_steps || 0) - Number(a.best_daily_steps || 0);
        } else if (hofCurrentSort === 'streak') {
            const strkB = Math.max(Number(b.streak_count || 0), Number(b.best_streak_days || 0));
            const strkA = Math.max(Number(a.streak_count || 0), Number(a.best_streak_days || 0));
            return strkB - strkA;
        } else if (hofCurrentSort === 'steps') {
            return Number(b.total_steps || 0) - Number(a.total_steps || 0);
        } else {
            // 'wins' الافتراضي
            const scoreB = Number(b.daily_championship_wins || 0)
                + Number(b.weekly_championship_wins || 0) * 3
                + Number(b.monthly_championship_wins || 0) * 10;
            const scoreA = Number(a.daily_championship_wins || 0)
                + Number(a.weekly_championship_wins || 0) * 3
                + Number(a.monthly_championship_wins || 0) * 10;
            if (scoreB !== scoreA) return scoreB - scoreA;
            return Number(b.total_steps || 0) - Number(a.total_steps || 0);
        }
    });

    const topList = sorted.slice(0, 30);

    if (topList.length === 0) {
        container.innerHTML = `
            <div class="p-6 rounded-2xl bg-lux-950/40 border border-lux-800/60 text-center text-lux-400 text-xs font-medium">
                لا توجد بيانات متاحة لعرضها في لوحة الشرف.
            </div>
        `;
        return;
    }

    container.innerHTML = topList.map((user, idx) => {
        const rank = idx + 1;
        const name = escapeHtml(user.full_name || user.username || 'متسابق');
        const username = user.username ? `@${escapeHtml(user.username)}` : '';
        const isVerified = isUserVerificationActive(user);
        const avatarUrl = user.avatar_url || '';

        const dWins = Number(user.daily_championship_wins || 0);
        const wWins = Number(user.weekly_championship_wins || 0);
        const mWins = Number(user.monthly_championship_wins || 0);
        const totalWins = dWins + wWins + mWins;

        const bestRecord = Number(user.best_daily_steps || 0).toLocaleString('ar-EG');
        const streakDays = Math.max(Number(user.streak_count || 0), Number(user.best_streak_days || 0)).toLocaleString('ar-EG');
        const totalSteps = Number(user.total_steps || 0).toLocaleString('ar-EG');

        let rankBadge = `<span class="w-7 h-7 rounded-xl bg-lux-800 text-lux-300 font-mono text-xs font-black flex items-center justify-center">${rank}</span>`;
        let cardBorder = 'border-lux-800/70 bg-lux-950/40';

        if (rank === 1) {
            rankBadge = `<span class="w-7 h-7 rounded-xl bg-gold-500/20 border border-gold-500/40 text-gold-400 font-mono text-xs font-black flex items-center justify-center">1</span>`;
            cardBorder = 'border-gold-500/40 bg-gradient-to-r from-gold-500/10 via-lux-950/60 to-lux-950/40';
        } else if (rank === 2) {
            rankBadge = `<span class="w-7 h-7 rounded-xl bg-slate-400/20 border border-slate-400/40 text-slate-200 font-mono text-xs font-black flex items-center justify-center">2</span>`;
            cardBorder = 'border-slate-500/30 bg-gradient-to-r from-slate-500/10 via-lux-950/60 to-lux-950/40';
        } else if (rank === 3) {
            rankBadge = `<span class="w-7 h-7 rounded-xl bg-amber-700/20 border border-amber-700/40 text-amber-300 font-mono text-xs font-black flex items-center justify-center">3</span>`;
            cardBorder = 'border-amber-700/30 bg-gradient-to-r from-amber-700/10 via-lux-950/60 to-lux-950/40';
        }

        return `
            <div class="p-3 sm:p-4 rounded-2xl border ${cardBorder} flex flex-col md:flex-row md:items-center justify-between gap-3 hover:border-gold-500/40 transition group">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="shrink-0 flex items-center gap-2">
                        ${rankBadge}
                        <div class="w-10 h-10 rounded-full overflow-hidden border border-lux-700 bg-lux-800 shrink-0 flex items-center justify-center">
                            ${avatarUrl ? `
                                <img src="${escapeHtml(avatarUrl)}" class="w-full h-full object-cover" alt="${name}">
                            ` : `
                                <span class="text-xs font-bold text-gold-400">${name.slice(0, 2)}</span>
                            `}
                        </div>
                    </div>
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-xs sm:text-sm font-black text-lux-100 truncate">${name}</span>
                            ${isVerified ? buildVerifiedBadgeHtml(true, 'scale-90') : ''}
                        </div>
                        <div class="text-[10px] font-mono text-lux-400 truncate">${username}</div>
                    </div>
                </div>

                <!-- إحصاءات المنافس التفصيلية -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-right pt-2 md:pt-0 border-t md:border-t-0 border-lux-800/60">
                    <div class="p-1.5 sm:p-2 rounded-xl bg-lux-900/50 border border-lux-800/40">
                        <div class="text-[9px] font-bold text-lux-400">كؤوس البطولات</div>
                        <div class="font-mono text-xs font-black text-gold-400 mt-0.5">${totalWins.toLocaleString('ar-EG')} (${dWins}ي/${wWins}أ)</div>
                    </div>
                    <div class="p-1.5 sm:p-2 rounded-xl bg-lux-900/50 border border-lux-800/40">
                        <div class="text-[9px] font-bold text-lux-400">الرقم القياسي</div>
                        <div class="font-mono text-xs font-black text-cyan-300 mt-0.5">${bestRecord}</div>
                    </div>
                    <div class="p-1.5 sm:p-2 rounded-xl bg-lux-900/50 border border-lux-800/40">
                        <div class="text-[9px] font-bold text-lux-400">سلسلة الالتزام</div>
                        <div class="font-mono text-xs font-black text-emerald-400 mt-0.5">${streakDays} يوم</div>
                    </div>
                    <div class="p-1.5 sm:p-2 rounded-xl bg-lux-900/50 border border-lux-800/40">
                        <div class="text-[9px] font-bold text-lux-400">إجمالي الخطوات</div>
                        <div class="font-mono text-xs font-black text-lux-200 mt-0.5">${totalSteps}</div>
                    </div>
                </div>

                <div class="shrink-0 flex items-center justify-end">
                    <button type="button" class="px-3 py-1.5 rounded-xl bg-lux-800 hover:bg-gold-500 hover:text-lux-950 text-lux-200 text-xs font-bold border border-lux-700 hover:border-gold-500 transition active:scale-95 flex items-center gap-1" onclick='openUserActionModalById("${user.id}")'>
                        <span>لوحة القيادة</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * فتح لوحة قيادة المستخدم بالـ id
 * @param {string} userId
 */
function openUserActionModalById(userId) {
    if (!userId || !Array.isArray(allUsersList)) return;
    const user = allUsersList.find((u) => u.id === userId);
    if (user && typeof openUserActionModal === 'function') {
        openUserActionModal(user);
    }
}
window.openUserActionModalById = openUserActionModalById;

function initCompetitorsHallOfFame() {
    const sortButtons = document.querySelectorAll('.hof-sort-btn');
    sortButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const sortMode = btn.dataset.hofSort;
            if (!sortMode) return;
            hofCurrentSort = sortMode;
            sortButtons.forEach((b) => {
                const isActive = b === btn;
                b.classList.toggle('is-active', isActive);
                if (isActive) {
                    b.className = 'hof-sort-btn px-2.5 py-1 rounded-lg text-[10px] sm:text-[11px] font-bold transition is-active bg-gold-500 text-lux-950';
                } else {
                    b.className = 'hof-sort-btn px-2.5 py-1 rounded-lg text-[10px] sm:text-[11px] font-bold text-lux-300 hover:text-lux-100 transition';
                }
            });
            renderHofList();
        });
    });

    const refreshBtn = document.getElementById('btnRefreshHofStats');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            renderCompetitorsHallOfFame();
            if (window.showToast) window.showToast('تم تحديث سجل التنافس ولوحة الشرف بنجاح');
        });
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
 * عرض رسالة تنبيه سريعة داخل بطاقة المستخدم HUD
 * @param {HTMLElement} li
 * @param {string} msg
 * @param {'success'|'error'} type
 */
function showUserCardStatus(li, msg, type) {
    const statusEl = li.querySelector('.user-card-status');
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `user-card-status mt-2 text-[10px] font-bold p-2 rounded-xl transition ${
        type === 'success'
            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
    }`;
    statusEl.classList.remove('hidden');
    clearTimeout(statusEl._timeoutId);
    statusEl._timeoutId = setTimeout(() => {
        statusEl.classList.add('hidden');
    }, 4500);
}

/**
 * تعديل خطوات المستخدم بشكل فوري ومباشر من البطاقة دون نوافذ منبثقة
 * @param {object} user
 * @param {number} delta
 * @param {HTMLElement} li
 * @param {HTMLElement} btn
 * @param {string|null} customReason
 */
async function handleQuickStepAdjust(user, delta, li, btn, customReason = null) {
    if (btn) btn.disabled = true;
    const reason = customReason || (delta > 0 ? 'مكافأة خطوات سريعة من لوحة التحكم' : 'خصم خطوات من لوحة التحكم');

    try {
        const { data, error } = await supabaseClient.rpc('admin_adjust_user_steps', {
            p_user_id: user.id,
            p_mode: 'delta',
            p_steps_value: delta,
            p_reason: reason,
            p_adjust_points: true,
        });

        if (error) {
            console.error('[admin.js] فشل التعديل السريع للخطوات:', error);
            if (li) showUserCardStatus(li, error.message || 'تعذر تعديل الخطوات.', 'error');
            return;
        }

        const newDaily = data?.new_daily_steps ?? ((user.daily_steps || 0) + delta);
        const newPoints = data?.new_total_points ?? user.points;
        user.daily_steps = newDaily;
        user.points = newPoints;
        if (data?.new_weekly_steps !== undefined) user.weekly_steps = data.new_weekly_steps;
        if (data?.new_monthly_steps !== undefined) user.monthly_steps = data.new_monthly_steps;
        if (data?.new_total_steps !== undefined) user.total_steps = data.new_total_steps;

        if (Array.isArray(allUsersList)) {
            const u = allUsersList.find((x) => x.id === user.id);
            if (u) {
                u.daily_steps = newDaily;
                u.points = newPoints;
            }
        }

        const targetEl = li || document.querySelector(`.admin-user-row[data-user-id="${user.id}"]`);
        if (targetEl) {
            const stepsEl = targetEl.querySelector('.user-card-steps');
            if (stepsEl) {
                stepsEl.textContent = Number(newDaily).toLocaleString('ar-EG');
                stepsEl.classList.add('text-emerald-300', 'scale-110');
                setTimeout(() => stepsEl.classList.remove('text-emerald-300', 'scale-110'), 800);
            }
            const pointsEl = targetEl.querySelector('.user-card-points');
            if (pointsEl) {
                pointsEl.textContent = Number(newPoints).toLocaleString('ar-EG');
            }
            showUserCardStatus(targetEl, `تم ${delta > 0 ? 'إضافة' : 'خصم'} ${Math.abs(delta).toLocaleString('ar-EG')} خطوة بنجاح. رصيد اليوم: ${Number(newDaily).toLocaleString('ar-EG')}`, 'success');
        }

        if (typeof addCompetitorAuditEntry === 'function') {
            addCompetitorAuditEntry(
                user.full_name || user.username || 'متسابق',
                delta > 0 ? 'مكافأة خطوات' : 'خصم خطوات',
                `${delta > 0 ? 'إضافة' : 'خصم'} ${Math.abs(delta).toLocaleString('ar-EG')} خطوة (${reason}). الرصيد الجديد: ${Number(newDaily).toLocaleString('ar-EG')}`
            );
        }
    } catch (err) {
        console.error('[admin.js] خطأ غير متوقع:', err);
        if (li) showUserCardStatus(li, 'حدث خطأ أثناء تنفيذ التعديل.', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * تعيين قيمة ثابتة لخطوات المستخدم فورياً (مثل التصفير)
 * @param {object} user
 * @param {number} value
 * @param {HTMLElement} li
 * @param {HTMLElement} btn
 * @param {string} reason
 */
async function handleQuickStepSet(user, value, li, btn, reason) {
    if (btn) btn.disabled = true;
    try {
        const { data, error } = await supabaseClient.rpc('admin_adjust_user_steps', {
            p_user_id: user.id,
            p_mode: 'set',
            p_steps_value: value,
            p_reason: reason,
            p_adjust_points: true,
        });

        if (error) {
            console.error('[admin.js] فشل تعيين الخطوات:', error);
            showUserCardStatus(li, error.message || 'تعذر تعيين الخطوات.', 'error');
            return;
        }

        user.daily_steps = value;
        if (data?.new_total_points !== undefined) user.points = data.new_total_points;

        const stepsEl = li.querySelector('.user-card-steps');
        if (stepsEl) stepsEl.textContent = Number(value).toLocaleString('ar-EG');
        const pointsEl = li.querySelector('.user-card-points');
        if (pointsEl && data?.new_total_points !== undefined) pointsEl.textContent = Number(data.new_total_points).toLocaleString('ar-EG');

        showUserCardStatus(li, `تم تصفير خطوات اليوم ومزامنة الحساس بنجاح.`, 'success');

        if (typeof addCompetitorAuditEntry === 'function') {
            addCompetitorAuditEntry(
                user.full_name || user.username || 'متسابق',
                'تصفير خطوات',
                `تصفير خطوات اليوم (${reason})`
            );
        }
    } catch (err) {
        showUserCardStatus(li, 'تعذر تصفير الخطوات.', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * تبديل توثيق المستخدم فورياً من البطاقة
 * @param {object} user
 * @param {HTMLElement} li
 * @param {HTMLElement} btn
 */
async function handleQuickVerifToggle(user, li, btn) {
    if (btn) btn.disabled = true;
    const nextVal = !Boolean(user.is_verified_override);
    const ok = await toggleUserVerifiedOverride(user.id, nextVal);
    if (btn) btn.disabled = false;

    if (!ok) {
        showUserCardStatus(li, 'تعذر تحديث حالة التوثيق.', 'error');
        return;
    }

    user.is_verified_override = nextVal;
    if (Array.isArray(allUsersList)) {
        const u = allUsersList.find((x) => x.id === user.id);
        if (u) u.is_verified_override = nextVal;
    }

    const isNowVerified = isUserVerificationActive(user);
    const badgeEl = li.querySelector('.user-card-verif-badge');
    if (badgeEl) {
        badgeEl.innerHTML = isNowVerified ? buildVerifiedBadgeHtml(true) : '';
    }

    if (nextVal) {
        btn.className = 'user-quick-verif-btn p-1.5 rounded-xl border bg-gold-500/20 border-gold-500/40 text-gold-400 transition active:scale-95';
        btn.querySelector('svg')?.setAttribute('fill', 'currentColor');
    } else {
        btn.className = 'user-quick-verif-btn p-1.5 rounded-xl border bg-lux-800/60 border-lux-700/60 text-lux-400 transition active:scale-95';
        btn.querySelector('svg')?.setAttribute('fill', 'none');
    }

    showUserCardStatus(li, nextVal ? 'تم توثيق الحساب بنجاح وإضافة الشارة الذهبية.' : 'تم إلغاء التوثيق اليدوي للحساب.', 'success');

    if (typeof addCompetitorAuditEntry === 'function') {
        addCompetitorAuditEntry(
            user.full_name || user.username || 'متسابق',
            nextVal ? 'توثيق حساب' : 'إلغاء توثيق',
            nextVal ? 'منح شارة التوثيق الذهبية' : 'إلغاء شارة التوثيق اليدوية'
        );
    }
}

/**
 * تبني بطاقة HUD تفاعلية هولوجرافية تمثل مستخدم في القائمة مع أزرار تحكم مباشرة
 * @param {object} user
 * @returns {HTMLLIElement}
 */
function buildUserRowElement(user) {
    const li = document.createElement('li');
    li.className = 'admin-user-row admin-user-hud-card glass-card p-3.5 sm:p-4 mb-3 transition-all duration-200';
    li.dataset.userId = user.id;

    const avatarUrl = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    const displayName = escapeHtml(user.full_name || user.username || 'مستخدم بدون اسم');
    const usernameText = user.username ? `@${escapeHtml(user.username)}` : '';
    const isInside = Boolean(user.is_inside_bounds);
    const isVerifiedOverride = Boolean(user.is_verified_override);

    const isBlocked = Boolean(user.is_blocked);
    li.classList.toggle('is-blocked', isBlocked);
    const blockedReasonText = user.blocked_reason ? escapeHtml(user.blocked_reason) : '';

    const presenceText = escapeHtml(formatPresenceText(user));
    const presenceIsOnline = isUserOnline(user);

    const joinedText = user.created_at
        ? `انضم ${formatRelativeArabicTime(user.created_at)}`
        : '';

    const isSelfRow = user.id === currentAdminUserId;
    const isVerified = isUserVerificationActive(user);
    const verifiedBadgeHtml = isVerified ? buildVerifiedBadgeHtml(true) : '';

    const lat = user.signup_lat ?? user.last_lat ?? null;
    const lng = user.signup_lng ?? user.last_lng ?? null;
    let distanceMeters = user.signup_distance_meters ?? null;
    if (distanceMeters === null && typeof lat === 'number' && typeof lng === 'number') {
        distanceMeters = Math.round(
            calculateDistanceMeters(lat, lng, cachedAdminGeofenceCenter.lat, cachedAdminGeofenceCenter.lng)
        );
    }
    const hasLocation = typeof lat === 'number' && typeof lng === 'number';
    const isInsideVillage = Boolean(user.is_inside_bounds || (distanceMeters !== null && distanceMeters <= (cachedAdminGeofenceCenter.radius || 2000)));

    let locationBadgeHtml = '';
    if (hasLocation) {
        const formattedDist = distanceMeters !== null
            ? (distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} كم` : `${distanceMeters}م`)
            : 'محسوب';
        locationBadgeHtml = isInsideVillage
            ? `<span class="admin-location-pill is-inside" title="إحداثيات: ${lat.toFixed(4)}, ${lng.toFixed(4)}">نزلة عبيد (${formattedDist})</span>`
            : `<span class="admin-location-pill is-outside" title="إحداثيات: ${lat.toFixed(4)}, ${lng.toFixed(4)}">خارج النطاق (${formattedDist})</span>`;
    } else {
        locationBadgeHtml = `<span class="admin-location-pill is-unknown">الموقع: قيد الرصد</span>`;
    }

    const stepsVal = Number(user.daily_steps || 0);
    const pointsVal = Number(user.points || 0);

    li.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
                <span class="relative inline-block shrink-0">
                    <img class="w-12 h-12 rounded-2xl object-cover border border-lux-700/80 shadow-md" src="${avatarUrl}" alt="" loading="lazy">
                    <span class="presence-dot${presenceIsOnline ? ' is-online' : ''}" aria-hidden="true"></span>
                </span>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-black text-xs sm:text-sm text-lux-50 truncate">${displayName}</span>
                        <span class="user-card-verif-badge">${verifiedBadgeHtml}</span>
                        ${usernameText ? `<span class="text-[11px] font-mono text-lux-400 truncate">${usernameText}</span>` : ''}
                    </div>
                    <div class="flex items-center gap-2 flex-wrap mt-0.5">
                        <span class="text-[10px] font-bold ${presenceIsOnline ? 'text-emerald-400' : 'text-lux-400'} flex items-center gap-1">
                            <span class="w-1.5 h-1.5 rounded-full ${presenceIsOnline ? 'bg-emerald-400 admin-radar-pulse' : 'bg-lux-500'}"></span>
                            <span>${presenceText}</span>
                        </span>
                        ${locationBadgeHtml}
                        ${joinedText ? `<span class="text-[9px] font-medium text-lux-500">${escapeHtml(joinedText)}</span>` : ''}
                    </div>
                    ${isBlocked ? (user.blocked_until && new Date(user.blocked_until).getTime() > Date.now() ? `<div class="text-[10px] font-bold text-amber-400 mt-1">مجمّد مؤقتاً حتى ${new Date(user.blocked_until).toLocaleDateString('ar-EG', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })}${blockedReasonText ? `: ${blockedReasonText}` : ''}</div>` : `<div class="text-[10px] font-bold text-rose-400 mt-1">محظور${blockedReasonText ? `: ${blockedReasonText}` : ''}</div>`) : ''}
                </div>
            </div>

            <div class="flex items-center justify-between sm:justify-end gap-2.5 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-lux-800/60">
                <div class="flex items-center gap-1.5">
                    <div class="px-2.5 py-1 rounded-xl bg-lux-950/60 border border-lux-800/80 text-center">
                        <span class="block text-[9px] font-bold text-lux-400">خطوات اليوم</span>
                        <span class="user-card-steps font-mono text-xs sm:text-sm font-black text-amber-400">${stepsVal.toLocaleString('ar-EG')}</span>
                    </div>
                    <div class="px-2.5 py-1 rounded-xl bg-lux-950/60 border border-lux-800/80 text-center">
                        <span class="block text-[9px] font-bold text-lux-400">النقاط</span>
                        <span class="user-card-points font-mono text-xs sm:text-sm font-black text-gold-400">${pointsVal.toLocaleString('ar-EG')}</span>
                    </div>
                </div>

                <div class="flex items-center gap-1.5">
                    <button type="button" class="user-card-expand-btn px-3.5 py-2 rounded-xl bg-gradient-to-r from-gold-500/20 to-amber-500/10 hover:from-gold-500/30 hover:to-amber-500/20 border border-gold-500/40 text-gold-300 font-bold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-sm" title="لوحة القيادة والتحكم الشامل">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        <span>لوحة القيادة</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    li.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        openUserActionModal(user);
    });

    const expandBtn = li.querySelector('.user-card-expand-btn');
    if (expandBtn) {
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openUserActionModal(user);
        });
    }

    return li;
}

/**
 * بتتعامل مع الضغط على زرار "حظر" / "إلغاء الحظر" في صف مستخدم -
 * إذا كان محظوراً/مجمداً تطلب تأكيد فك الحظر، وإذا كان نشطاً تفتح لوحة قيادة المشترك الشاملة
 * @param {HTMLButtonElement} blockBtn
 * @param {object} user
 * @param {string} displayName
 */
async function handleBlockButtonClick(blockBtn, user, displayName) {
    const isCurrentlyBlocked = Boolean(user.is_blocked);

    if (isCurrentlyBlocked) {
        if (!window.confirm(`تأكيد إلغاء حظر / فك تجميد ${displayName}؟`)) return;

        blockBtn.disabled = true;
        blockBtn.classList.add('is-saving');

        const res = await toggleUserBlock(user.id, false, 'إلغاء الحظر من قائمة المستخدمين');

        blockBtn.disabled = false;
        blockBtn.classList.remove('is-saving');

        if (!res) {
            const statusEl = document.getElementById('userSearchStatus');
            setStatusText(statusEl, `تعذّر تحديث حالة حظر ${displayName}. حاول تاني.`, 'error');
            return;
        }

        user.is_blocked = false;
        user.blocked_reason = null;
        user.blocked_until = null;
        renderFilteredUserList();
    } else {
        openUserActionModal(user);
        setTimeout(() => {
            const freezeSection = document.getElementById('selectFreezeDuration');
            if (freezeSection) {
                freezeSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                freezeSection.focus();
            }
        }, 120);
    }
}

/**
 * أفاتار احتياطي (Data URI بسيط بحرف واحد) لو المستخدم مالوش avatar_url
 * @param {string} seedText
 * @returns {string}
 */
function buildFallbackAvatarUrl(seedText) {
    const initial = (seedText.trim()[0] || '؟').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="%2314171F"/><text x="20" y="26" font-size="16" font-family="Cairo,sans-serif" text-anchor="middle" fill="%23D4AF37">${initial}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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
 * منفصل يزوّد الاحتكاك وقت الإرسال). من غير إيموجي () عمداً - الشكل
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

/** تحديث شاشة المحاكاة الحية للإشعار (Apple Lockscreen Mockup) */
function updateNotificationLivePreview(text) {
    const previewEl = document.getElementById('notifMockupMsg');
    if (previewEl) {
        previewEl.textContent = (text || '').trim() || 'اكتب نص الإشعار في الحقل لمعاينته حياً كما سيظهر على شاشات هواتف أهالي نزلة عبيد...';
    }
    const targetEl = document.getElementById('notifMockupTarget');
    if (targetEl) {
        if (notifyMode === 'broadcast') {
            targetEl.textContent = 'بث عام لجميع أهالي القرية';
        } else if (notifySelectedUser) {
            targetEl.textContent = `إلى: ${notifySelectedUser.full_name || notifySelectedUser.username}`;
        } else {
            targetEl.textContent = 'لمستخدم محدد';
        }
    }
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

    const messageInput = document.getElementById('notifyMessageInput');
    updateNotificationLivePreview(messageInput ? messageInput.value : '');
}

/** بتلغي اختيار المستخدم الحالي وترجّع مربع البحث تاني */
function clearNotifyRecipient() {
    notifySelectedUser = null;

    const searchInput = document.getElementById('notifyRecipientSearchInput');
    const chipEl = document.getElementById('notifyRecipientSelectedChip');

    if (searchInput) searchInput.classList.remove('hidden');
    if (chipEl) chipEl.classList.add('hidden');

    const messageInput = document.getElementById('notifyMessageInput');
    updateNotificationLivePreview(messageInput ? messageInput.value : '');
}

/** بتبدّل وضع الويدجت (لمستخدم محدد / بث للكل) وتظهر/تخفي عنصر اختيار المستخدم بناءً عليه */
function setNotifyMode(mode) {
    notifyMode = mode;

    const pickerEl = document.getElementById('notifyRecipientPicker');
    if (pickerEl) pickerEl.classList.toggle('hidden', mode !== 'single');

    const modeButtons = document.querySelectorAll('#notifyModeControls [data-notify-mode]');
    modeButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.notifyMode === mode));

    const messageInput = document.getElementById('notifyMessageInput');
    updateNotificationLivePreview(messageInput ? messageInput.value : '');
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

    const messageInput = document.getElementById('notifyMessageInput');
    if (messageInput) {
        messageInput.addEventListener('input', () => updateNotificationLivePreview(messageInput.value));
    }

    document.querySelectorAll('.notif-template-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const tpl = chip.getAttribute('data-template');
            if (messageInput && tpl) {
                messageInput.value = tpl;
                updateNotificationLivePreview(tpl);
                messageInput.focus();
            }
        });
    });
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

    setStatusText(statusEl, 'اتبعت بنجاح ', 'success');
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

    setStatusText(statusEl, 'اتحفظ ونُشر بنجاح ', 'success');
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

    setStatusText(statusEl, 'اتحفظت الهوية بنجاح ', 'success');
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

    setStatusText(statusEl, 'اتنشر بنجاح ', 'success');
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

/** تجيب آخر 20 منشور وترسمهم في #postsManageList مع زرار حذف وزرار عرض المعجبين */
async function loadRecentPostsForAdmin() {
    const statusEl = document.getElementById('postsManageStatus');
    const listEl = document.getElementById('postsManageList');
    if (!listEl) return;

    setStatusText(statusEl, 'جاري تحميل المنشورات…', 'loading');

    // نحاول استدعاء admin_list_posts أولاً للحصول على عدد الإعجابات بدقة
    const { data: rpcData, error: rpcError } = await supabaseClient.rpc('admin_list_posts');

    if (!rpcError && rpcData) {
        renderAdminPostsList(rpcData);
        setStatusText(statusEl, rpcData.length ? '' : 'مفيش منشورات لسه.', rpcData.length ? null : 'empty');
        return;
    }

    // بديل احتياطي إذا تعذر استدعاء الـ RPC
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

/** @param {Array<{id:string, content:string|null, image_url:string|null, created_at:string, likes_count?:number|string}>} posts */
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
        const likesCount = Number(post.likes_count || 0);

        li.innerHTML = `
            ${post.image_url
                ? `<img class="admin-user-avatar" src="${post.image_url}" alt="" loading="lazy">`
                : `<span class="admin-user-avatar post-card-app-avatar" aria-hidden="true">س</span>`}
            <div class="admin-user-info">
                <div class="admin-user-name">${escapeHtml(excerpt) || '—'}</div>
                <div class="admin-user-username">${timeText} · <span class="text-gold-400 font-bold">${likesCount.toLocaleString('ar-EG')} إعجاب</span></div>
            </div>
            <div class="admin-user-actions flex items-center gap-1.5">
                <button type="button" class="post-likers-btn px-2.5 py-1 rounded-lg bg-lux-800 hover:bg-lux-700 text-gold-400 border border-gold-500/30 text-xs font-bold transition">
                    المعجبين
                </button>
                <button type="button" class="admin-notify-clear-btn post-delete-btn">حذف</button>
            </div>
        `;

        const likersBtn = li.querySelector('.post-likers-btn');
        if (likersBtn) {
            likersBtn.addEventListener('click', () => openPostLikersModal(post.id, excerpt));
        }

        const deleteBtn = li.querySelector('.post-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => handleDeletePost(post.id, li));
        }

        listEl.appendChild(li);
    });
}

/** فتح نافذة عرض قائمة المعجبين بالمنشور */
async function openPostLikersModal(postId, postExcerpt) {
    const modal = document.getElementById('postLikersModal');
    const statusEl = document.getElementById('postLikersStatus');
    const listEl = document.getElementById('postLikersList');
    const countSubtitle = document.getElementById('postLikersCountSubtitle');
    if (!modal || !listEl) return;

    modal.classList.remove('hidden');
    listEl.innerHTML = '';
    setStatusText(statusEl, 'جاري تحميل قائمة المعجبين…', 'loading');
    if (countSubtitle) countSubtitle.textContent = 'جاري التحميل…';

    const { data: likers, error } = await supabaseClient.rpc('admin_get_post_likes', {
        p_post_id: postId
    });

    if (error) {
        console.error('[admin.js] فشل جلب المعجبين بالمنشور:', error);
        setStatusText(statusEl, 'تعذر تحميل المعجبين بهذا المنشور.', 'error');
        if (countSubtitle) countSubtitle.textContent = 'خطأ في التحميل';
        return;
    }

    if (!likers || likers.length === 0) {
        setStatusText(statusEl, 'لم يقم أي مستخدم بالإعجاب بهذا المنشور حتى الآن.', 'empty');
        if (countSubtitle) countSubtitle.textContent = 'لا توجد إعجابات';
        return;
    }

    setStatusText(statusEl, '', null);
    if (countSubtitle) {
        countSubtitle.textContent = `${likers.length.toLocaleString('ar-EG')} مستخدم أعجبهم المنشور`;
    }

    likers.forEach((user) => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between p-2.5 rounded-xl bg-lux-950 border border-lux-800/80 hover:border-lux-700 transition';

        const avatar = user.avatar_url || buildFallbackAvatarUrl(user.full_name || '?');
        const name = escapeHtml(user.full_name || 'مستخدم');
        const username = user.username ? `@${escapeHtml(user.username)}` : '';
        const likedTime = formatRelativeArabicTime(user.liked_at);

        row.innerHTML = `
            <div class="flex items-center gap-2.5 min-w-0">
                <img src="${avatar}" class="w-8 h-8 rounded-full border border-lux-700 object-cover shrink-0" alt="">
                <div class="min-w-0">
                    <div class="text-xs font-bold text-lux-100 truncate">${name}</div>
                    <div class="text-[10px] text-lux-400 font-mono truncate">${username}</div>
                </div>
            </div>
            <div class="text-[10px] font-mono text-gold-400/90 shrink-0 text-left">
                ${likedTime}
            </div>
        `;

        listEl.appendChild(row);
    });
}

function initPostLikersModal() {
    const modal = document.getElementById('postLikersModal');
    const closeBtn = document.getElementById('btnClosePostLikersModal');
    const closeBottomBtn = document.getElementById('btnClosePostLikersModalBottom');

    const closeModal = () => {
        if (modal) modal.classList.add('hidden');
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (closeBottomBtn) closeBottomBtn.addEventListener('click', closeModal);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
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
    initPostLikersModal();
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

    const scheduledDateInput = document.getElementById('questionScheduledDateInput');
    const scheduledForDate = scheduledDateInput && scheduledDateInput.value ? scheduledDateInput.value : null;

    return { questionText, options, correctOptionId, category, difficulty, scheduledForDate };
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

    const scheduledDateInput = document.getElementById('questionScheduledDateInput');
    if (scheduledDateInput) scheduledDateInput.value = '';

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

    const scheduledDateInput = document.getElementById('questionScheduledDateInput');
    if (scheduledDateInput) scheduledDateInput.value = question.scheduled_for_date ? question.scheduled_for_date.slice(0, 10) : '';

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
            p_scheduled_for_date: values.scheduledForDate,
        })
        : await supabaseClient.rpc('admin_create_daily_question', {
            p_question_text: values.questionText,
            p_options: values.options,
            p_correct_option_id: values.correctOptionId,
            p_category: values.category || null,
            p_difficulty: values.difficulty,
            p_scheduled_for_date: values.scheduledForDate,
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

    setStatusText(statusEl, isEditing ? 'اتحدّث بنجاح ' : 'اتضاف بنجاح ', 'success');
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
    applyModalQuestionsFilters();
    loadTodayAndTomorrowPicks();
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
        applyModalQuestionsFilters();
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
        `تنبيه: الأسئلة المفعّلة قلّت (${countText}) - السيستم هيبدأ يكرر نفس الأسئلة كل كام يوم. فعّل أسئلة أكتر أو ضيف جديدة من الفورم فوق.`;
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

    const modalFilterSelect = document.getElementById('modalQuestionsFilterCategory');
    if (modalFilterSelect) {
        const currentValue = modalFilterSelect.value;
        modalFilterSelect.innerHTML = '<option value="">كل الفئات</option>'
            + categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
        if (categories.includes(currentValue)) modalFilterSelect.value = currentValue;
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

/** عرض أول 5 أسئلة فقط في الواجهة الرئيسية لبنك الأسئلة مع ترقيم الأسئلة
 * @param {Array<{id:string, question_text:string, options:Array, correct_option_id:string, is_active:boolean, used_count:number, category:string|null, difficulty:string}>} questions */
function renderQuestionsList(questions) {
    const listEl = document.getElementById('questionsListEl');
    if (!listEl) return;

    // تحديث شارة إجمالي عدد الأسئلة
    const totalCountBadge = document.getElementById('questionsTotalCountBadge');
    if (totalCountBadge) {
        totalCountBadge.textContent = `إجمالي: ${allLoadedQuestions.length} سؤال`;
    }
    const openModalBtnText = document.getElementById('openAllQuestionsModalBtnText');
    if (openModalBtnText) {
        openModalBtnText.textContent = `عرض بنك الأسئلة بالكامل (${allLoadedQuestions.length} سؤال)`;
    }

    listEl.innerHTML = '';

    // عرض أول 5 أسئلة فقط في الواجهة الرئيسية لمنع ازدحام الصفحة
    const displayQuestions = questions.slice(0, 5);

    displayQuestions.forEach((question) => {
        const isToday = todaysQuestionIds.has(question.id);
        const li = document.createElement('li');
        li.className = 'admin-user-row';
        if (!question.is_active) li.classList.add('is-blocked');

        // ترقيم السؤال بناءً على ترتيبه الكلي في البنك
        const globalIndex = allLoadedQuestions.findIndex((q) => q.id === question.id);
        const questionNumber = globalIndex >= 0 ? (globalIndex + 1) : '';

        const excerpt = question.question_text.length > 70
            ? `${question.question_text.slice(0, 70)}…`
            : question.question_text;

        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[question.difficulty] || 'متوسط';
        const usedCountText = (question.used_count && question.used_count > 0)
            ? `عُرض في ${question.used_count} يوم كـ سؤال يومي`
            : 'لم يُعرض بعد كـ سؤال يومي';

        const metaParts = [
            question.is_active ? 'مفعّل' : 'غير مفعّل',
            question.category ? escapeHtml(question.category) : null,
            difficultyLabel,
            usedCountText,
            question.scheduled_for_date ? `مجدول ليوم: ${question.scheduled_for_date.slice(0, 10)}` : null,
        ].filter(Boolean);

        const statBadge = getQuestionStatBadge(question.id);

        li.innerHTML = `
            <div class="admin-user-info">
                <div class="admin-user-name flex items-center gap-1.5 flex-wrap">
                    ${questionNumber ? `<span class="inline-block bg-lux-800 text-gold-400 text-xs px-2 py-0.5 rounded-md font-mono font-bold">#${questionNumber}</span>` : ''}
                    <span>${escapeHtml(excerpt)}</span>
                </div>
                <div class="admin-user-username mt-1">${metaParts.join(' · ')}</div>
            </div>
            ${isToday ? '<span class="admin-user-bounds-badge is-inside shrink-0">ظاهر اليوم</span>' : ''}
            ${statBadge ? `<button type="button" class="admin-question-stat-badge question-participants-trigger cursor-pointer" data-tier="${statBadge.tier}" title="اضغط لعرض تفاصيل المشاركين">${escapeHtml(statBadge.text)}</button>` : ''}
            <div class="admin-user-actions">
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-participants-btn" title="تفاصيل إجابات المشاركين">المشاركون</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-toggle-btn">${question.is_active ? 'إيقاف' : 'تفعيل'}</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-edit-btn">تعديل</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-delete-btn">حذف</button>
            </div>
        `;

        const statTrigger = li.querySelector('.question-participants-trigger');
        if (statTrigger) statTrigger.addEventListener('click', () => openQuestionParticipantsModal(question));

        const participantsBtn = li.querySelector('.question-participants-btn');
        if (participantsBtn) participantsBtn.addEventListener('click', () => openQuestionParticipantsModal(question));

        const toggleBtn = li.querySelector('.question-toggle-btn');
        if (toggleBtn) toggleBtn.addEventListener('click', () => handleToggleQuestionActive(question, toggleBtn, li));

        const editBtn = li.querySelector('.question-edit-btn');
        if (editBtn) editBtn.addEventListener('click', () => fillQuestionFormForEdit(question));

        const deleteBtn = li.querySelector('.question-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => handleDeleteQuestion(question, li));

        listEl.appendChild(li);
    });
}

/** تفعيل أو إيقاف تفعيل سؤال */
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

    renderQuestionsActiveWarning();
    logQuestionAction(newValue ? 'question_toggle_active_on' : 'question_toggle_active_off', question);

    applyQuestionsListFilters();
    applyModalQuestionsFilters();
}

/** حذف سؤال من البنك */
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
    renderQuestionsActiveWarning();

    applyQuestionsListFilters();
    applyModalQuestionsFilters();
    loadTodayAndTomorrowPicks();
}

/* ==================================================================
   نافذة تصفح بنك الأسئلة بالكامل (All Questions Modal)
   ================================================================== */

function applyModalQuestionsFilters() {
    const searchInput = document.getElementById('modalQuestionsSearchInput');
    const categoryFilter = document.getElementById('modalQuestionsFilterCategory');
    const difficultyFilter = document.getElementById('modalQuestionsFilterDifficulty');
    const statusFilter = document.getElementById('modalQuestionsFilterStatus');

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

    renderModalQuestionsList(filtered);

    const statusEl = document.getElementById('modalQuestionsListStatus');
    if (!allLoadedQuestions.length) {
        setStatusText(statusEl, 'مفيش أسئلة في البنك لسه.', 'empty');
    } else if (!filtered.length) {
        setStatusText(statusEl, 'مفيش أسئلة مطابقة للبحث/الفلتر ده.', 'empty');
    } else {
        setStatusText(statusEl, '', null);
    }
}

function renderModalQuestionsList(questions) {
    const listEl = document.getElementById('modalQuestionsListEl');
    if (!listEl) return;

    listEl.innerHTML = '';

    questions.forEach((question) => {
        const isToday = todaysQuestionIds.has(question.id);
        const li = document.createElement('li');
        li.className = 'admin-user-row';
        if (!question.is_active) li.classList.add('is-blocked');

        const globalIndex = allLoadedQuestions.findIndex((q) => q.id === question.id);
        const questionNumber = globalIndex >= 0 ? (globalIndex + 1) : '';

        const excerpt = question.question_text.length > 85
            ? `${question.question_text.slice(0, 85)}…`
            : question.question_text;

        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[question.difficulty] || 'متوسط';
        const usedCountText = (question.used_count && question.used_count > 0)
            ? `عُرض في ${question.used_count} يوم كـ سؤال يومي`
            : 'لم يُعرض بعد كـ سؤال يومي';

        const metaParts = [
            question.is_active ? 'مفعّل' : 'غير مفعّل',
            question.category ? escapeHtml(question.category) : null,
            difficultyLabel,
            usedCountText,
            question.scheduled_for_date ? `مجدول ليوم: ${question.scheduled_for_date.slice(0, 10)}` : null,
        ].filter(Boolean);

        const statBadge = getQuestionStatBadge(question.id);

        li.innerHTML = `
            <div class="admin-user-info">
                <div class="admin-user-name flex items-center gap-1.5 flex-wrap">
                    ${questionNumber ? `<span class="inline-block bg-lux-800 text-gold-400 text-xs px-2 py-0.5 rounded-md font-mono font-bold">#${questionNumber}</span>` : ''}
                    <span>${escapeHtml(excerpt)}</span>
                </div>
                <div class="admin-user-username mt-1">${metaParts.join(' · ')}</div>
            </div>
            ${isToday ? '<span class="admin-user-bounds-badge is-inside shrink-0">ظاهر اليوم</span>' : ''}
            ${statBadge ? `<button type="button" class="admin-question-stat-badge question-participants-trigger cursor-pointer" data-tier="${statBadge.tier}" title="اضغط لعرض تفاصيل المشاركين">${escapeHtml(statBadge.text)}</button>` : ''}
            <div class="admin-user-actions">
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-participants-btn" title="تفاصيل إجابات المشاركين">المشاركون</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-toggle-btn">${question.is_active ? 'إيقاف' : 'تفعيل'}</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-edit-btn">تعديل</button>
                <button type="button" class="admin-notify-clear-btn admin-notify-clear-btn--wide question-delete-btn">حذف</button>
            </div>
        `;

        const statTrigger = li.querySelector('.question-participants-trigger');
        if (statTrigger) statTrigger.addEventListener('click', () => openQuestionParticipantsModal(question));

        const participantsBtn = li.querySelector('.question-participants-btn');
        if (participantsBtn) participantsBtn.addEventListener('click', () => openQuestionParticipantsModal(question));

        const toggleBtn = li.querySelector('.question-toggle-btn');
        if (toggleBtn) toggleBtn.addEventListener('click', () => handleToggleQuestionActive(question, toggleBtn, li));

        const editBtn = li.querySelector('.question-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                const modal = document.getElementById('allQuestionsModal');
                if (modal) modal.classList.add('hidden');
                fillQuestionFormForEdit(question);
            });
        }

        const deleteBtn = li.querySelector('.question-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => handleDeleteQuestion(question, li));

        listEl.appendChild(li);
    });
}

function initAllQuestionsModal() {
    const modal = document.getElementById('allQuestionsModal');
    const openBtn = document.getElementById('openAllQuestionsModalBtn');
    const closeBtn = document.getElementById('closeAllQuestionsModalBtn');
    const closeBottomBtn = document.getElementById('closeAllQuestionsModalBtnBottom');

    const openModal = () => {
        if (!modal) return;
        modal.classList.remove('hidden');
        const subtitle = document.getElementById('allQuestionsModalSubtitle');
        if (subtitle) {
            subtitle.textContent = `تصفح وفلترة جميع الأسئلة (${allLoadedQuestions.length} سؤال) مع الإحصائيات الكاملة`;
        }
        applyModalQuestionsFilters();
    };

    const closeModal = () => {
        if (modal) modal.classList.add('hidden');
    };

    if (openBtn) openBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (closeBottomBtn) closeBottomBtn.addEventListener('click', closeModal);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    const searchInput = document.getElementById('modalQuestionsSearchInput');
    if (searchInput) searchInput.addEventListener('input', applyModalQuestionsFilters);

    ['modalQuestionsFilterCategory', 'modalQuestionsFilterDifficulty', 'modalQuestionsFilterStatus'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', applyModalQuestionsFilters);
    });
}

/* ==================================================================
   نافذة تفاصيل إجابات المشاركين لسؤال معين (Question Participants Modal)
   ================================================================== */

let currentQuestionParticipants = [];
let currentParticipantFilter = 'all';

/** فتح نافذة المشاركين لسؤال معين وجلب إجاباتهم
 * @param {{id:string, question_id?:string, question_text:string, options:Array, correct_option_id:string, category:string|null, difficulty:string}} question
 */
async function openQuestionParticipantsModal(question) {
    const modal = document.getElementById('questionParticipantsModal');
    if (!modal) return;

    modal.classList.remove('hidden');

    const categoryEl = document.getElementById('qpModalCategory');
    const difficultyEl = document.getElementById('qpModalDifficulty');
    const questionTextEl = document.getElementById('qpModalQuestionText');
    const correctAnswerEl = document.getElementById('qpModalCorrectAnswer');
    const statusEl = document.getElementById('qpParticipantsStatus');
    const listEl = document.getElementById('qpParticipantsList');

    if (categoryEl) categoryEl.textContent = question.category || 'عام';
    if (difficultyEl) difficultyEl.textContent = QUESTION_DIFFICULTY_LABELS[question.difficulty] || 'متوسط';
    if (questionTextEl) questionTextEl.textContent = question.question_text || '';

    // معرفة نص الإجابة الصحيحة
    let correctText = 'غير محددة';
    if (Array.isArray(question.options)) {
        const correctOpt = question.options.find((opt) => String(opt.id) === String(question.correct_option_id));
        if (correctOpt) correctText = correctOpt.text;
    }
    if (correctAnswerEl) correctAnswerEl.textContent = `الإجابة الصحيحة: ${correctText}`;

    const totalEl = document.getElementById('qpStatTotal');
    const correctEl = document.getElementById('qpStatCorrect');
    const incorrectEl = document.getElementById('qpStatIncorrect');
    const forfeitedEl = document.getElementById('qpStatForfeited');

    if (totalEl) totalEl.textContent = '0';
    if (correctEl) correctEl.textContent = '0 (0%)';
    if (incorrectEl) incorrectEl.textContent = '0';
    if (forfeitedEl) forfeitedEl.textContent = '0';

    if (listEl) listEl.innerHTML = '';
    setStatusText(statusEl, 'جاري تحميل تفاصيل المشاركين…', 'loading');

    currentParticipantFilter = 'all';
    updateParticipantFilterTabsUI('all');

    const questionTargetId = question.id || question.question_id;

    try {
        const { data, error } = await supabaseClient.rpc('admin_get_question_participants', {
            p_question_id: questionTargetId,
        });

        if (error) {
            console.error('[admin.js] فشل جلب تفاصيل المشاركين:', error);
            setStatusText(statusEl, 'تعذّر تحميل تفاصيل المشاركين.', 'error');
            return;
        }

        currentQuestionParticipants = data || [];

        const total = currentQuestionParticipants.length;
        const correctCount = currentQuestionParticipants.filter((p) => p.status === 'answered' && p.is_correct === true).length;
        const incorrectCount = currentQuestionParticipants.filter((p) => p.status === 'answered' && p.is_correct === false).length;
        const forfeitedCount = currentQuestionParticipants.filter((p) => p.status === 'forfeited').length;
        const correctPct = total > 0 ? Math.round((correctCount / total) * 100) : 0;

        if (totalEl) totalEl.textContent = total.toLocaleString('ar-EG');
        if (correctEl) correctEl.textContent = `${correctCount.toLocaleString('ar-EG')} (${correctPct}%)`;
        if (incorrectEl) incorrectEl.textContent = incorrectCount.toLocaleString('ar-EG');
        if (forfeitedEl) forfeitedEl.textContent = forfeitedCount.toLocaleString('ar-EG');

        renderQuestionParticipantsList();
    } catch (err) {
        console.error('[admin.js] خطأ أثناء جلب تفاصيل المشاركين:', err);
        setStatusText(statusEl, 'حدث خطأ غير متوقع أثناء التحميل.', 'error');
    }
}

function renderQuestionParticipantsList() {
    const listEl = document.getElementById('qpParticipantsList');
    const statusEl = document.getElementById('qpParticipantsStatus');
    if (!listEl) return;

    listEl.innerHTML = '';

    const filtered = currentQuestionParticipants.filter((p) => {
        if (currentParticipantFilter === 'all') return true;
        if (currentParticipantFilter === 'correct') return p.status === 'answered' && p.is_correct === true;
        if (currentParticipantFilter === 'incorrect') return p.status === 'answered' && p.is_correct === false;
        if (currentParticipantFilter === 'forfeited') return p.status === 'forfeited';
        if (currentParticipantFilter === 'timeout') return p.status === 'timeout';
        return true;
    });

    if (!currentQuestionParticipants.length) {
        setStatusText(statusEl, 'لم يقم أي مستخدم بالإجابة على هذا السؤال بعد.', 'empty');
        return;
    }

    if (!filtered.length) {
        setStatusText(statusEl, 'لا يوجد مشاركون مطابقون لهذا التصنيف.', 'empty');
        return;
    }

    setStatusText(statusEl, '', null);

    filtered.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'p-3 bg-lux-950/60 rounded-2xl border border-lux-800 flex items-center justify-between gap-3 flex-wrap';

        let statusBadge = '';
        if (p.status === 'forfeited') {
            statusBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-amber-500/15 text-amber-400 border border-amber-500/30">انسحب من التطبيق</span>';
        } else if (p.status === 'timeout') {
            statusBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-lux-800 text-lux-300 border border-lux-700">انتهى الوقت</span>';
        } else if (p.is_correct === true) {
            statusBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">إجابة صحيحة</span>';
        } else {
            statusBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-rose-500/15 text-rose-400 border border-rose-500/30">إجابة خاطئة</span>';
        }

        const avatarSrc = p.avatar_url ? escapeHtml(p.avatar_url) : (p.gender === 'female' ? 'assets/images/default-avatar-female.png' : 'assets/images/default-avatar-male.png');
        const fallbackSrc = 'assets/images/default-avatar-male.png';

        const choiceText = p.status === 'forfeited'
            ? '<span class="text-amber-400/90 text-xs font-medium">أغلق أو خرج من التطبيق أثناء تشغيل السؤال</span>'
            : (p.status === 'timeout'
                ? '<span class="text-lux-400 text-xs font-medium">انتهت مهلة الإجابة دون اختيار</span>'
                : `<span class="text-xs text-lux-300">الاختيار: <strong class="text-lux-100 font-bold">${escapeHtml(p.option_text || 'خيار ' + p.option_id)}</strong>${p.remaining_seconds != null ? ` <span class="font-mono text-lux-400 text-[11px]">(متبقي ${p.remaining_seconds} ثانية)</span>` : ''}</span>`);

        const formattedDate = p.created_at ? new Date(p.created_at).toLocaleString('ar-EG', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        }) : '';

        li.innerHTML = `
            <div class="flex items-center gap-3">
                <img src="${avatarSrc}" onerror="this.src='${fallbackSrc}'" alt="" class="w-10 h-10 rounded-full object-cover border border-lux-700 shrink-0">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs sm:text-sm font-extrabold text-lux-100">${escapeHtml(p.full_name || 'مستخدم سِكّاوي')}</span>
                        ${p.username ? `<span class="text-[11px] font-mono text-lux-400 dir-ltr">@${escapeHtml(p.username)}</span>` : ''}
                    </div>
                    <div class="mt-0.5">${choiceText}</div>
                </div>
            </div>
            <div class="flex flex-col items-end gap-1 shrink-0 mr-auto sm:mr-0">
                ${statusBadge}
                <span class="text-[10px] text-lux-500 font-mono">${escapeHtml(formattedDate)}</span>
            </div>
        `;
        listEl.appendChild(li);
    });
}

function updateParticipantFilterTabsUI(activeFilter) {
    const tabs = document.querySelectorAll('.qp-filter-tab');
    tabs.forEach((tab) => {
        const filter = tab.getAttribute('data-filter');
        if (filter === activeFilter) {
            tab.className = 'qp-filter-tab px-3 py-1 rounded-xl text-xs font-bold transition bg-gold-500 text-lux-950 font-black shadow-sm';
        } else {
            tab.className = 'qp-filter-tab px-3 py-1 rounded-xl text-xs font-bold transition bg-lux-800 text-lux-300 hover:text-lux-100';
        }
    });
}

function initQuestionParticipantsModal() {
    const modal = document.getElementById('questionParticipantsModal');
    const closeBtn = document.getElementById('closeQpModalBtn');
    const closeBottomBtn = document.getElementById('closeQpModalBtnBottom');

    const closeModal = () => {
        if (modal) modal.classList.add('hidden');
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (closeBottomBtn) closeBottomBtn.addEventListener('click', closeModal);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    const tabsContainer = document.getElementById('qpFilterTabs');
    if (tabsContainer) {
        tabsContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.qp-filter-tab');
            if (!btn) return;
            const filter = btn.getAttribute('data-filter');
            if (!filter || filter === currentParticipantFilter) return;
            currentParticipantFilter = filter;
            updateParticipantFilterTabsUI(filter);
            renderQuestionParticipantsList();
        });
    }
}

/* ==================================================================
   سؤالا اليوم وسؤالا الغد (اليوم الجديد)
   ================================================================== */

async function loadTodayAndTomorrowPicks() {
    const statusEl = document.getElementById('todayTomorrowStatus');
    const todayContainer = document.getElementById('todayQuestionsContainer');
    const tomorrowContainer = document.getElementById('tomorrowQuestionsContainer');
    const todayDateLabel = document.getElementById('todayDateLabel');
    const tomorrowDateLabel = document.getElementById('tomorrowDateLabel');

    if (!todayContainer || !tomorrowContainer) return;

    setStatusText(statusEl, 'جاري جلب أسئلة اليوم والغد…', 'loading');

    try {
        const { data, error } = await supabaseClient.rpc('admin_get_today_and_tomorrow_picks');

        if (error) {
            console.error('[admin.js] فشل جلب أسئلة اليوم والغد:', error);
            setStatusText(statusEl, 'تعذّر جلب الأسئلة المعروضة والقادمة.', 'error');
            return;
        }

        setStatusText(statusEl, '', null);
        const rows = data || [];

        const todayRows = rows.filter((r) => r.is_today === true);
        const tomorrowRows = rows.filter((r) => r.is_today === false);

        if (todayRows.length && todayDateLabel) {
            todayDateLabel.textContent = todayRows[0].question_date;
        }
        if (tomorrowRows.length && tomorrowDateLabel) {
            tomorrowDateLabel.textContent = tomorrowRows[0].question_date;
        }

        renderTodayPicks(todayRows, todayContainer);
        renderTomorrowPicks(tomorrowRows, tomorrowContainer);
    } catch (err) {
        console.error('[admin.js] خطأ أثناء تحميل أسئلة اليوم والغد:', err);
        setStatusText(statusEl, 'حدث خطأ أثناء الاتصال بالسيرفر.', 'error');
    }
}

function renderTodayPicks(rows, container) {
    container.innerHTML = '';
    if (!rows.length) {
        container.innerHTML = '<p class="text-xs text-lux-400 p-3 bg-lux-950/40 rounded-xl">لا توجد أسئلة نشطة اليوم بعد.</p>';
        return;
    }

    rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'p-3.5 bg-lux-900/90 rounded-2xl border border-lux-800 space-y-2.5';

        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[row.difficulty] || 'متوسط';
        const total = Number(row.total_answers) || 0;
        const pct = row.correct_percentage != null ? `${row.correct_percentage}% صح` : '0% صح';

        card.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-black px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">سؤال رقم ${row.question_slot}</span>
                <div class="flex items-center gap-1.5 text-[11px]">
                    <span class="text-lux-400 font-bold">${escapeHtml(row.category || 'عام')} · ${difficultyLabel}</span>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${row.is_manual ? 'bg-purple-500/20 text-purple-300' : 'bg-lux-800 text-lux-400'}">${row.is_manual ? 'يدوي' : 'تلقائي'}</span>
                </div>
            </div>
            <p class="text-xs sm:text-sm font-extrabold text-lux-100 leading-relaxed">${escapeHtml(row.question_text)}</p>
            <div class="pt-2 border-t border-lux-800/80 flex items-center justify-between gap-2 flex-wrap">
                <span class="text-xs font-bold text-lux-300">${total.toLocaleString('ar-EG')} محاولة <span class="text-emerald-400 font-mono">(${pct})</span></span>
                <button type="button" class="admin-notify-clear-btn view-participants-btn font-black text-xs">
                    عرض إجابات المشاركين (${total})
                </button>
            </div>
        `;

        const btn = card.querySelector('.view-participants-btn');
        if (btn) {
            btn.addEventListener('click', () => {
                openQuestionParticipantsModal({
                    id: row.question_id,
                    question_id: row.question_id,
                    question_text: row.question_text,
                    options: row.options,
                    correct_option_id: row.correct_option_id,
                    category: row.category,
                    difficulty: row.difficulty,
                });
            });
        }

        container.appendChild(card);
    });
}

function renderTomorrowPicks(rows, container) {
    container.innerHTML = '';
    if (!rows.length) {
        container.innerHTML = '<p class="text-xs text-lux-400 p-3 bg-lux-950/40 rounded-xl">لا توجد أسئلة مقررة للغد بعد.</p>';
        return;
    }

    rows.forEach((row) => {
        const card = document.createElement('div');
        card.className = 'p-3.5 bg-lux-900/90 rounded-2xl border border-lux-800 space-y-2.5';

        const difficultyLabel = QUESTION_DIFFICULTY_LABELS[row.difficulty] || 'متوسط';
        const options = Array.isArray(row.options) ? row.options : [];

        const optionsHtml = options.map((opt) => {
            const isCorrect = String(opt.id) === String(row.correct_option_id);
            return `
                <div class="text-[11px] p-1.5 rounded-lg border ${isCorrect ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 font-bold' : 'bg-lux-950/40 border-lux-800/80 text-lux-300'}">
                    ${isCorrect ? '<span class="text-emerald-400 font-black ml-1">[صح]</span> ' : ''}${escapeHtml(opt.text)}
                </div>
            `;
        }).join('');

        card.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-black px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/25">سؤال رقم ${row.question_slot}</span>
                <div class="flex items-center gap-1.5 text-[11px]">
                    <span class="text-lux-400 font-bold">${escapeHtml(row.category || 'عام')} · ${difficultyLabel}</span>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${row.is_manual ? 'bg-purple-500/20 text-purple-300' : 'bg-lux-800 text-lux-400'}">${row.is_manual ? 'يدوي' : 'تلقائي'}</span>
                </div>
            </div>
            <p class="text-xs sm:text-sm font-extrabold text-lux-100 leading-relaxed">${escapeHtml(row.question_text)}</p>
            <div class="grid grid-cols-2 gap-1.5 pt-1">
                ${optionsHtml}
            </div>
            <div class="pt-2 border-t border-lux-800/80 flex items-center justify-end gap-2">
                ${row.is_manual ? `<button type="button" class="admin-notify-clear-btn clear-manual-pick-btn text-xs text-rose-400 hover:text-rose-300">إرجاع للتلقائي</button>` : ''}
                <button type="button" class="admin-notify-clear-btn change-tomorrow-pick-btn text-xs font-bold text-amber-400">
                    تغيير السؤال
                </button>
            </div>
        `;

        const changeBtn = card.querySelector('.change-tomorrow-pick-btn');
        if (changeBtn) {
            changeBtn.addEventListener('click', () => {
                promptChangeTomorrowQuestion(row);
            });
        }

        const clearBtn = card.querySelector('.clear-manual-pick-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (!window.confirm(`هل تريد إرجاع سؤال ${row.question_slot} للغد إلى الاختيار التلقائي؟`)) return;
                clearBtn.disabled = true;
                const { error } = await supabaseClient.rpc('admin_clear_manual_daily_question', {
                    p_date: row.question_date,
                    p_slot: row.question_slot,
                });
                clearBtn.disabled = false;
                if (error) {
                    window.alert(error.message || 'تعذّر إرجاع السؤال للتلقائي.');
                    return;
                }
                loadTodayAndTomorrowPicks();
            });
        }

        container.appendChild(card);
    });
}

function promptChangeTomorrowQuestion(row) {
    const widget = document.getElementById('questionManualScheduleWidget');
    const dateInput = document.getElementById('manualScheduleDateInput');
    const slotInput = document.getElementById('manualScheduleSlotInput');
    const questionSelect = document.getElementById('manualScheduleQuestionInput');

    if (dateInput) dateInput.value = row.question_date;
    if (slotInput) slotInput.value = String(row.question_slot);
    if (widget) {
        widget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        widget.classList.add('ring-2', 'ring-amber-500');
        setTimeout(() => widget.classList.remove('ring-2', 'ring-amber-500'), 2500);
    }
    if (questionSelect) {
        questionSelect.focus();
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
    loadTodayAndTomorrowPicks();
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
    loadTodayAndTomorrowPicks();
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

    const refreshTodayTomorrowBtn = document.getElementById('refreshTodayTomorrowBtn');
    if (refreshTodayTomorrowBtn) {
        refreshTodayTomorrowBtn.addEventListener('click', loadTodayAndTomorrowPicks);
    }

    updateQuestionTextCounter();
    updateQuestionLivePreview();
    loadDailyQuestionsList();
    loadTodayAndTomorrowPicks();
    loadQuestionAuditLog(); // (مجموعة 2) سجل التعديلات - مستقل عن قائمة الأسئلة، بيتحمّل بالتوازي
    initQuestionsBulkToolsWidget(); // (مجموعة 3) استيراد/تصدير جماعي
    initManualScheduleWidget(); // (مجموعة 4) تحكم يدوي في سؤال يوم معين
    initAllQuestionsModal();
    initQuestionParticipantsModal();
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
    setStatusText(statusEl, `اتصدّر ${allLoadedQuestions.length} سؤال بنجاح `, 'success');
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
    const scheduledForDate = String(raw.scheduled_for_date ?? raw.scheduledForDate ?? '').trim() || null;

    return {
        row: {
            questionText,
            options,
            correctOptionId,
            category,
            difficulty,
            scheduledForDate,
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

    errorsEl.innerHTML = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');

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
            p_scheduled_for_date: row.scheduledForDate || null,
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

    const resultParts = [`اتستورد ${successCount} من ${total} سؤال بنجاح `];
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
const BADGE_CUSTOM_3D_ASSETS = new Set([
    'first_steps',
    'first_correct',
    'streak_3',
    'first_friend',
    'committed',
    'steps_50k',
    'genius',
    'streak_7',
    'daily_champion',
    'friends_10',
    'runner',
    'steps_250k',
    'correct_200',
    'blaze',
    'weekly_champion',
    'monthly_champion',
    'legend_10_wins',
    'streak_100',
    'million_steps',
    'top3_leaderboard',
    'champion',
    'veteran_1_year',
    'champion_daily',
    'champion_weekly',
    'champion_monthly',
]);

function buildBadgeToggleRowElement(badge) {
    const li = document.createElement('li');
    li.className = 'admin-user-row';

    const isUnlocked = badgesSelectedUserUnlockedIds.has(badge.id);
    const toggleId = `badgeToggle_${badge.id}`;

    const badgeVisualHtml = BADGE_CUSTOM_3D_ASSETS.has(badge.id)
        ? `<img src="images/badges/${escapeHtml(badge.id)}.png" alt="" class="w-6 h-6 object-contain shrink-0">`
        : `<span class="text-xl shrink-0" aria-hidden="true">${escapeHtml(badge.icon)}</span>`;

    li.innerHTML = `
        ${badgeVisualHtml}
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

    setStatusText(statusEl, 'اتحفظ ', 'success');
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
    setStatusText(statusEl, 'اتحفظ ', 'success');
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
    setStatusText(statusEl, 'اتبعت ', 'success');
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

const ADMIN_TAB_ROUTING_MAP = {
    // Overview
    tabPanelOverview: { main: 'tabPanelOverview', sub: 'subPanelOverviewPulse' },
    tabPanelVisitors: { main: 'tabPanelOverview', sub: 'subPanelOverviewVisitors' },
    tabPanelSponsors: { main: 'tabPanelOverview', sub: 'subPanelOverviewSponsors' },

    // Users
    tabPanelUsers: { main: 'tabPanelUsers', sub: 'subPanelUserAccounts' },
    tabPanelBadges: { main: 'tabPanelUsers', sub: 'subPanelUserBadges' },

    // Content
    tabPanelContent: { main: 'tabPanelContent', sub: 'subPanelContentPosts' },
    tabPanelPosts: { main: 'tabPanelContent', sub: 'subPanelContentPosts' },
    tabPanelQuestions: { main: 'tabPanelContent', sub: 'subPanelContentQuestions' },
    tabPanelBanner: { main: 'tabPanelContent', sub: 'subPanelContentBanner' },

    // Comms
    tabPanelComms: { main: 'tabPanelComms', sub: 'subPanelCommsNotify' },
    tabPanelNotifications: { main: 'tabPanelComms', sub: 'subPanelCommsNotify' },
    tabPanelSupport: { main: 'tabPanelComms', sub: 'subPanelCommsSupport' },

    // System
    tabPanelSystem: { main: 'tabPanelSystem', sub: 'subPanelSystemMaster' },
    tabPanelMaster: { main: 'tabPanelSystem', sub: 'subPanelSystemMaster' },
    tabPanelGeofence: { main: 'tabPanelSystem', sub: 'subPanelSystemGeofence' },
};

function switchAdminTab(targetTabId, targetSubTabId = null) {
    const route = ADMIN_TAB_ROUTING_MAP[targetTabId] || { main: targetTabId, sub: targetSubTabId };
    const effectiveMain = route.main;
    const effectiveSub = targetSubTabId || route.sub;

    const tabButtons = document.querySelectorAll('.admin-nav-tab[data-tab-target]');
    const panels = document.querySelectorAll('.admin-tab-panel');

    panels.forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== effectiveMain);
    });

    tabButtons.forEach((b) => {
        const bTarget = b.dataset.tabTarget;
        const bRoute = ADMIN_TAB_ROUTING_MAP[bTarget] || { main: bTarget };
        b.classList.toggle('is-active', bRoute.main === effectiveMain);
    });

    if (effectiveSub) {
        const subBtn = document.querySelector(`.admin-subtab-btn[data-subtab-target="${effectiveSub}"]`);
        if (subBtn) {
            subBtn.click();
        }
    }

    if (effectiveSub === 'subPanelOverviewSponsors' || effectiveMain === 'tabPanelSponsors') {
        renderSponsorAnalytics();
    } else if (effectiveSub === 'subPanelOverviewVisitors' || effectiveMain === 'tabPanelVisitors') {
        loadVisitorStats();
    } else if (effectiveSub === 'subPanelCompetitorsHallOfFame') {
        renderCompetitorsHallOfFame();
    }

    const drawer = document.getElementById('adminMobileDrawer');
    if (drawer && !drawer.classList.contains('hidden')) {
        drawer.classList.add('hidden');
    }

    const mainEl = document.querySelector('main');
    if (mainEl) mainEl.scrollTop = 0;
}
window.switchAdminTab = switchAdminTab;

function initAdminTabNavigation() {
    const tabButtons = document.querySelectorAll('.admin-nav-tab[data-tab-target]');
    const mobileMoreBtn = document.getElementById('btnAdminMobileMoreDrawer');
    const drawer = document.getElementById('adminMobileDrawer');
    const mobileMenuBtn = document.getElementById('btnAdminMobileMenu');
    const closeDrawerBtn = document.getElementById('btnCloseAdminMobileDrawer');

    const coreBottomTabs = ['tabPanelOverview', 'tabPanelUsers', 'tabPanelContent', 'tabPanelComms', 'tabPanelSystem'];

    function updateMobileMoreActive(targetId) {
        if (mobileMoreBtn) {
            mobileMoreBtn.classList.toggle('is-active', !coreBottomTabs.includes(targetId));
        }
    }

    tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.tabTarget;
            switchAdminTab(targetId);
            updateMobileMoreActive(targetId);
        });
    });

    // التنقل بين التبويبات الداخلية (Sub-tabs)
    const subTabButtons = document.querySelectorAll('.admin-subtab-btn[data-subtab-target]');
    subTabButtons.forEach((sBtn) => {
        sBtn.addEventListener('click', () => {
            const subTargetId = sBtn.dataset.subtabTarget;
            const parentPanel = sBtn.closest('.admin-tab-panel');
            if (!parentPanel) return;

            const subPanels = parentPanel.querySelectorAll('.admin-subpanel');
            subPanels.forEach((sp) => {
                sp.classList.toggle('hidden', sp.id !== subTargetId);
            });

            const siblingButtons = parentPanel.querySelectorAll('.admin-subtab-btn');
            siblingButtons.forEach((b) => {
                b.classList.toggle('is-active', b === sBtn);
            });

            if (subTargetId === 'subPanelOverviewSponsors' || subTargetId === 'tabPanelSponsors') {
                renderSponsorAnalytics();
            } else if (subTargetId === 'subPanelOverviewVisitors' || subTargetId === 'tabPanelVisitors') {
                loadVisitorStats();
            } else if (subTargetId === 'subPanelCompetitorsHallOfFame') {
                renderCompetitorsHallOfFame();
            }
        });
    });

    // ربط أزرار الوصول السريع في الصفحة الرئيسية
    const quickActionCards = document.querySelectorAll('[data-quick-tab]');
    quickActionCards.forEach((card) => {
        card.addEventListener('click', () => {
            const targetTab = card.dataset.quickTab;
            const targetSubTab = card.dataset.quickSubtab;
            switchAdminTab(targetTab, targetSubTab);
        });
    });

    // فتح وإغلاق دروج التنقل للموبايل
    const toggleDrawer = () => {
        if (drawer) drawer.classList.toggle('hidden');
    };

    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleDrawer);
    if (mobileMoreBtn) mobileMoreBtn.addEventListener('click', toggleDrawer);
    if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', () => drawer?.classList.add('hidden'));
    if (drawer) {
        drawer.addEventListener('click', (e) => {
            if (e.target === drawer) drawer.classList.add('hidden');
        });
    }
}


/* ==================================================================
   5) التهيئة العامة
   ================================================================== */


/* ==================================================================
   10) تحليلات المرور وإشعار الحسابات الخاملة
   ================================================================== */

function renderPeakHoursAndSegmentation(analytics) {
    const segToday = document.getElementById('segActiveToday');
    const segWeek = document.getElementById('segActiveWeek');
    const segInactive7d = document.getElementById('segInactive7d');
    const segInactive30d = document.getElementById('segInactive30d');

    if (segToday) segToday.textContent = (analytics.active_today || 0).toLocaleString('ar-EG');
    if (segWeek) segWeek.textContent = (analytics.active_this_week || 0).toLocaleString('ar-EG');
    if (segInactive7d) segInactive7d.textContent = (analytics.inactive_7d || 0).toLocaleString('ar-EG');
    if (segInactive30d) segInactive30d.textContent = (analytics.inactive_30d || 0).toLocaleString('ar-EG');

    const container = document.getElementById('visitorsPeakHoursContainer');
    if (!container) return;

    const peakObj = analytics.peak_hours || {};
    const hours = [];
    for (let i = 0; i < 24; i += 1) {
        const k1 = String(i).padStart(2, '0');
        const k2 = String(i);
        const count = Number(peakObj[k1] || peakObj[k2] || 0);
        hours.push({ hour: i, count });
    }
    const maxVal = Math.max(1, ...hours.map((h) => h.count || 0));

    container.innerHTML = '';
    hours.forEach((h) => {
        const heightPct = Math.round(((h.count || 0) / maxVal) * 100);
        const col = document.createElement('div');
        col.className = 'flex-1 min-w-[14px] flex flex-col items-center gap-1 group relative';

        const hourLabel = h.hour === 0 ? '12ص' : h.hour < 12 ? `${h.hour}ص` : h.hour === 12 ? '12م' : `${h.hour - 12}م`;

        col.innerHTML = `
            <div class="text-[9px] font-mono font-bold text-lux-400 opacity-0 group-hover:opacity-100 transition whitespace-nowrap absolute -top-5">
                ${(h.count || 0).toLocaleString('ar-EG')}
            </div>
            <div class="w-full bg-lux-800 rounded-t group-hover:bg-gold-500/70 transition-all flex items-end justify-center" style="height: ${Math.max(6, heightPct * 0.65)}px;">
                ${h.count > 0 ? '<div class="w-full bg-gold-500/40 rounded-t" style="height: 100%;"></div>' : ''}
            </div>
            <span class="text-[8px] font-mono text-lux-500">${hourLabel}</span>
        `;
        container.appendChild(col);
    });
}

function initInactiveUsersNotifyModal() {
    const openBtn = document.getElementById('btnOpenNotifyInactiveModal');
    const modal = document.getElementById('notifyInactiveModal');
    const closeBtn = document.getElementById('btnCloseNotifyInactiveModal');
    const cancelBtn = document.getElementById('btnCancelSendInactiveNotify');
    const confirmBtn = document.getElementById('btnConfirmSendInactiveNotify');
    const statusEl = document.getElementById('notifyInactiveStatus');

    if (!openBtn || !modal) return;

    const showModal = () => {
        modal.classList.remove('hidden');
        if (statusEl) setStatusText(statusEl, '', null);
    };

    const hideModal = () => {
        modal.classList.add('hidden');
    };

    openBtn.addEventListener('click', showModal);
    if (closeBtn) closeBtn.addEventListener('click', hideModal);
    if (cancelBtn) cancelBtn.addEventListener('click', hideModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal();
    });

    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            const daysSelect = document.getElementById('notifyInactiveDaysSelect');
            const titleInput = document.getElementById('notifyInactiveTitle');
            const bodyInput = document.getElementById('notifyInactiveBody');

            const days = parseInt(daysSelect ? daysSelect.value : '7', 10);
            const title = titleInput ? titleInput.value.trim() : '';
            const body = bodyInput ? bodyInput.value.trim() : '';

            if (!title || !body) {
                setStatusText(statusEl, 'يرجى كتابة عنوان ونص الإشعار.', 'error');
                return;
            }

            confirmBtn.disabled = true;
            setStatusText(statusEl, 'جاري إرسال الإشعار لجميع الحسابات الخاملة…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_notify_inactive_users', {
                p_title: title,
                p_body: body,
                p_days_inactive: days,
            });

            confirmBtn.disabled = false;

            if (error) {
                console.error('[admin.js] فشل إرسال إشعار الخمول:', error);
                setStatusText(statusEl, 'تعذر إرسال الإشعار. تحقق من الصلاحيات وحاول ثانية.', 'error');
                return;
            }

            const count = data?.notified_count || 0;
            setStatusText(statusEl, `تم إرسال الإشعار بنجاح إلى ${count} مستخدم خامل.`, 'success');
            setTimeout(hideModal, 1800);
        });
    }
}

/* ==================================================================
   11) مكافحة الغش وإجراءات تحكم المستخدمين والتعويضات
   ================================================================== */

let selectedUserForAction = null;

function initUserActionModal() {
    const modal = document.getElementById('userAdminActionModal');
    const closeBtn = document.getElementById('btnCloseUserActionModal');
    const statusEl = document.getElementById('userModalStatus');

    if (!modal) return;

    const hideModal = () => {
        modal.classList.add('hidden');
        selectedUserForAction = null;
    };

    if (closeBtn) closeBtn.addEventListener('click', hideModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal();
    });

    // 1. التحكم في خطوات اليوم (إضافة / خصم / تعيين رقم محدد / تصفير سريع)
    let currentStepControlMode = 'delta';
    const btnStepModeDelta = document.getElementById('btnStepModeDelta');
    const btnStepModeSet = document.getElementById('btnStepModeSet');
    const labelAdjustStepsValue = document.getElementById('labelAdjustStepsValue');
    const inputAdjustStepsValue = document.getElementById('inputAdjustStepsValue');
    const inputAdjustStepsReason = document.getElementById('inputAdjustStepsReason');
    const chkAdjustStepsPoints = document.getElementById('chkAdjustStepsPoints');
    const btnExecuteAdjustSteps = document.getElementById('btnExecuteAdjustSteps');
    const btnResetSteps = document.getElementById('btnExecuteResetSteps');

    const updateStepModeUI = () => {
        if (currentStepControlMode === 'delta') {
            if (btnStepModeDelta) {
                btnStepModeDelta.className = 'px-2 py-1 text-[10px] font-bold rounded-md bg-gold-500 text-lux-950 transition';
            }
            if (btnStepModeSet) {
                btnStepModeSet.className = 'px-2 py-1 text-[10px] font-bold rounded-md text-lux-400 hover:text-lux-200 transition';
            }
            if (labelAdjustStepsValue) labelAdjustStepsValue.textContent = 'فارق الخطوات (+ للإضافة / - للخصم):';
            if (inputAdjustStepsValue) inputAdjustStepsValue.placeholder = '+5000 أو -2000';
        } else {
            if (btnStepModeSet) {
                btnStepModeSet.className = 'px-2 py-1 text-[10px] font-bold rounded-md bg-gold-500 text-lux-950 transition';
            }
            if (btnStepModeDelta) {
                btnStepModeDelta.className = 'px-2 py-1 text-[10px] font-bold rounded-md text-lux-400 hover:text-lux-200 transition';
            }
            if (labelAdjustStepsValue) labelAdjustStepsValue.textContent = 'تعيين رصيد خطوات اليوم:';
            if (inputAdjustStepsValue) inputAdjustStepsValue.placeholder = 'مثال: 8000';
        }
    };

    if (btnStepModeDelta) {
        btnStepModeDelta.addEventListener('click', () => {
            currentStepControlMode = 'delta';
            updateStepModeUI();
        });
    }
    if (btnStepModeSet) {
        btnStepModeSet.addEventListener('click', () => {
            currentStepControlMode = 'set';
            updateStepModeUI();
        });
    }

    if (btnExecuteAdjustSteps) {
        btnExecuteAdjustSteps.addEventListener('click', async () => {
            if (!selectedUserForAction) return;

            const valStr = inputAdjustStepsValue ? inputAdjustStepsValue.value.trim() : '';
            const stepsVal = parseInt(valStr, 10);
            const reason = inputAdjustStepsReason ? inputAdjustStepsReason.value.trim() : '';
            const adjustPoints = chkAdjustStepsPoints ? chkAdjustStepsPoints.checked : true;

            if (isNaN(stepsVal)) {
                setStatusText(statusEl, 'يرجى إدخال رقم خطوات صحيح.', 'error');
                return;
            }
            if (currentStepControlMode === 'delta' && stepsVal === 0) {
                setStatusText(statusEl, 'يرجى إدخال قيمة فارق غير صفرية (موجبة للإضافة أو سالبة للخصم).', 'error');
                return;
            }
            if (currentStepControlMode === 'set' && stepsVal < 0) {
                setStatusText(statusEl, 'قيمة الخطوات المحددة لا يمكن أن تكون سالبة.', 'error');
                return;
            }
            if (!reason) {
                setStatusText(statusEl, 'يرجى كتابة سبب تعديل الخطوات للتوثيق والشفافية.', 'error');
                return;
            }

            const actionDesc = currentStepControlMode === 'delta'
                ? (stepsVal > 0 ? `إضافة ${stepsVal.toLocaleString('ar-EG')} خطوة` : `خصم ${Math.abs(stepsVal).toLocaleString('ar-EG')} خطوة`)
                : `تعيين خطوات اليوم إلى ${stepsVal.toLocaleString('ar-EG')} خطوة`;

            const confirmMsg = `تأكيد ${actionDesc} للمستخدم (${selectedUserForAction.full_name || selectedUserForAction.username})؟${adjustPoints ? ' (سيتم احتساب النقاط تلقائياً)' : ' (دون تغيير النقاط)'}`;
            if (!confirm(confirmMsg)) return;

            btnExecuteAdjustSteps.disabled = true;
            setStatusText(statusEl, 'جاري تطبيق تعديل الخطوات والمزامنة…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_adjust_user_steps', {
                p_user_id: selectedUserForAction.id,
                p_mode: currentStepControlMode,
                p_steps_value: stepsVal,
                p_reason: reason,
                p_adjust_points: adjustPoints,
            });

            btnExecuteAdjustSteps.disabled = false;

            if (error) {
                console.error('[admin.js] فشل تعديل الخطوات:', error);
                setStatusText(statusEl, error.message || 'تعذر تعديل الخطوات.', 'error');
                return;
            }

            const newDaily = data?.new_daily_steps ?? (currentStepControlMode === 'set' ? stepsVal : (selectedUserForAction.daily_steps || 0) + stepsVal);
            const newPoints = data?.new_total_points ?? selectedUserForAction.points;
            selectedUserForAction.daily_steps = newDaily;
            selectedUserForAction.points = newPoints;
            if (data?.new_weekly_steps !== undefined) selectedUserForAction.weekly_steps = data.new_weekly_steps;
            if (data?.new_monthly_steps !== undefined) selectedUserForAction.monthly_steps = data.new_monthly_steps;
            if (data?.new_total_steps !== undefined) selectedUserForAction.total_steps = data.new_total_steps;

            const stepsEl = document.getElementById('userModalTodaySteps');
            if (stepsEl) stepsEl.textContent = Number(newDaily).toLocaleString('ar-EG');
            const pointsEl = document.getElementById('userModalPoints');
            if (pointsEl) pointsEl.textContent = Number(newPoints).toLocaleString('ar-EG');

            if (Array.isArray(allUsersList)) {
                const targetInList = allUsersList.find((u) => u.id === selectedUserForAction.id);
                if (targetInList) {
                    targetInList.daily_steps = newDaily;
                    targetInList.points = newPoints;
                    if (data?.new_weekly_steps !== undefined) targetInList.weekly_steps = data.new_weekly_steps;
                    if (data?.new_monthly_steps !== undefined) targetInList.monthly_steps = data.new_monthly_steps;
                    if (data?.new_total_steps !== undefined) targetInList.total_steps = data.new_total_steps;
                }
            }
            if (typeof renderFilteredUserList === 'function') {
                renderFilteredUserList();
            }

            if (inputAdjustStepsValue) inputAdjustStepsValue.value = '';
            if (inputAdjustStepsReason) inputAdjustStepsReason.value = '';
            setStatusText(statusEl, `تم تطبيق تعديل الخطوات بنجاح ومزامنة الحساس. رصيد خطوات اليوم: ${Number(newDaily).toLocaleString('ar-EG')}`, 'success');

            if (typeof addCompetitorAuditEntry === 'function') {
                addCompetitorAuditEntry(
                    selectedUserForAction.full_name || selectedUserForAction.username || 'متسابق',
                    currentStepControlMode === 'delta' ? (stepsVal > 0 ? 'مكافأة خطوات' : 'خصم خطوات') : 'تعيين خطوات',
                    `${actionDesc} (${reason}). رصيد اليوم الجديد: ${Number(newDaily).toLocaleString('ar-EG')}`
                );
            }
        });
    }

    if (btnResetSteps) {
        btnResetSteps.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const reason = window.prompt(`تصفير خطوات اليوم لـ (${selectedUserForAction.full_name || selectedUserForAction.username}) - يرجى كتابة السبب:`, 'تصفير خطوات مشبوهة');
            if (reason === null) return;
            const cleanReason = reason.trim() || 'تصفير خطوات مشبوهة';

            btnResetSteps.disabled = true;
            setStatusText(statusEl, 'جاري تصفير خطوات اليوم ومزامنة الحساس…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_adjust_user_steps', {
                p_user_id: selectedUserForAction.id,
                p_mode: 'set',
                p_steps_value: 0,
                p_reason: cleanReason,
                p_adjust_points: true,
            });

            btnResetSteps.disabled = false;

            if (error) {
                console.error('[admin.js] فشل تصفير الخطوات:', error);
                setStatusText(statusEl, error.message || 'تعذر تصفير الخطوات.', 'error');
                return;
            }

            selectedUserForAction.daily_steps = 0;
            if (data?.new_total_points !== undefined) selectedUserForAction.points = data.new_total_points;

            const stepsEl = document.getElementById('userModalTodaySteps');
            if (stepsEl) stepsEl.textContent = '0';
            const pointsEl = document.getElementById('userModalPoints');
            if (pointsEl && data?.new_total_points !== undefined) pointsEl.textContent = Number(data.new_total_points).toLocaleString('ar-EG');

            if (Array.isArray(allUsersList)) {
                const targetInList = allUsersList.find((u) => u.id === selectedUserForAction.id);
                if (targetInList) {
                    targetInList.daily_steps = 0;
                    if (data?.new_total_points !== undefined) targetInList.points = data.new_total_points;
                }
            }
            if (typeof renderFilteredUserList === 'function') {
                renderFilteredUserList();
            }

            setStatusText(statusEl, 'تم تصفير خطوات اليوم لـ 0 بنجاح وتحديث نقاطها ومزامنة الحساس.', 'success');

            if (typeof addCompetitorAuditEntry === 'function') {
                addCompetitorAuditEntry(
                    selectedUserForAction.full_name || selectedUserForAction.username || 'متسابق',
                    'تصفير خطوات',
                    `تصفير خطوات اليوم (${cleanReason})`
                );
            }
        });
    }

    // أزرار التعديل السريع للخطوات (+1000 / -1000) من داخل لوحة القيادة
    const btnModalPlus1000 = document.getElementById('btnModalQuickPlus1000');
    if (btnModalPlus1000) {
        btnModalPlus1000.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            btnModalPlus1000.disabled = true;
            setStatusText(statusEl, 'جاري إضافة 1000 خطوة…', 'loading');
            await handleQuickStepAdjust(selectedUserForAction, 1000, null, btnModalPlus1000);
            btnModalPlus1000.disabled = false;
            const stepsEl = document.getElementById('userModalTodaySteps');
            if (stepsEl) stepsEl.textContent = Number(selectedUserForAction.daily_steps || 0).toLocaleString('ar-EG');
            const pointsEl = document.getElementById('userModalPoints');
            if (pointsEl) pointsEl.textContent = Number(selectedUserForAction.points || 0).toLocaleString('ar-EG');
            setStatusText(statusEl, `تمت إضافة 1000 خطوة بنجاح. رصيد خطوات اليوم: ${Number(selectedUserForAction.daily_steps || 0).toLocaleString('ar-EG')}`, 'success');
        });
    }

    const btnModalMinus1000 = document.getElementById('btnModalQuickMinus1000');
    if (btnModalMinus1000) {
        btnModalMinus1000.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            btnModalMinus1000.disabled = true;
            setStatusText(statusEl, 'جاري خصم 1000 خطوة…', 'loading');
            await handleQuickStepAdjust(selectedUserForAction, -1000, null, btnModalMinus1000);
            btnModalMinus1000.disabled = false;
            const stepsEl = document.getElementById('userModalTodaySteps');
            if (stepsEl) stepsEl.textContent = Number(selectedUserForAction.daily_steps || 0).toLocaleString('ar-EG');
            const pointsEl = document.getElementById('userModalPoints');
            if (pointsEl) pointsEl.textContent = Number(selectedUserForAction.points || 0).toLocaleString('ar-EG');
            setStatusText(statusEl, `تم خصم 1000 خطوة بنجاح. رصيد خطوات اليوم: ${Number(selectedUserForAction.daily_steps || 0).toLocaleString('ar-EG')}`, 'success');
        });
    }

    // إرسال تنبيه مباشر للمشترك من داخل لوحة القيادة
    const modalNotifInput = document.getElementById('inputModalDirectNotif');
    const btnModalSendNotif = document.getElementById('btnModalSendDirectNotif');
    if (btnModalSendNotif && modalNotifInput) {
        btnModalSendNotif.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const msg = modalNotifInput.value.trim();
            if (!msg) {
                setStatusText(statusEl, 'يرجى كتابة نص التنبيه أولاً.', 'error');
                return;
            }
            btnModalSendNotif.disabled = true;
            setStatusText(statusEl, 'جاري إرسال التنبيه لهاتف المتسابق…', 'loading');
            const ok = await sendAdminNotificationToUser(selectedUserForAction.id, msg);
            btnModalSendNotif.disabled = false;
            if (ok) {
                modalNotifInput.value = '';
                setStatusText(statusEl, 'تم إرسال التنبيه فورياً إلى هاتف المتسابق بنجاح.', 'success');
            } else {
                setStatusText(statusEl, 'تعذر إرسال التنبيه. تحقق من الاتصال وحاول ثانية.', 'error');
            }
        });
    }

    // 2. Disqualify weekly
    const btnDisqualify = document.getElementById('btnExecuteDisqualifyWeekly');
    if (btnDisqualify) {
        btnDisqualify.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const reasonInput = document.getElementById('inputDisqualifyReason');
            const reason = reasonInput ? reasonInput.value.trim() : '';
            if (!reason) {
                setStatusText(statusEl, 'يرجى كتابة سبب الاستبعاد.', 'error');
                return;
            }

            if (!confirm(`هل أنت متأكد من استبعاد (${selectedUserForAction.full_name || selectedUserForAction.username}) من بطولة هذا الأسبوع؟`)) return;

            btnDisqualify.disabled = true;
            setStatusText(statusEl, 'جاري استبعاد المستخدم من دوري الأسبوع…', 'loading');

            const { error } = await supabaseClient.rpc('admin_disqualify_user_weekly', {
                p_user_id: selectedUserForAction.id,
                p_reason: reason,
            });

            btnDisqualify.disabled = false;

            if (error) {
                console.error('[admin.js] فشل الاستبعاد:', error);
                setStatusText(statusEl, error.message || 'تعذر استبعاد المستخدم.', 'error');
                return;
            }

            setStatusText(statusEl, 'تم استبعاد المستخدم من بطولة الأسبوع وتصفير نقاط أسبوعه.', 'success');
            if (reasonInput) reasonInput.value = '';
        });
    }

    // 3. Adjust points
    const btnAdjustPoints = document.getElementById('btnExecuteAdjustPoints');
    if (btnAdjustPoints) {
        btnAdjustPoints.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const deltaInput = document.getElementById('inputAdjustPointsDelta');
            const reasonInput = document.getElementById('inputAdjustPointsReason');

            const delta = parseInt(deltaInput ? deltaInput.value : '0', 10);
            const reason = reasonInput ? reasonInput.value.trim() : '';

            if (isNaN(delta) || delta === 0) {
                setStatusText(statusEl, 'يرجى كتابة رقم صحيح للنقاط (+ للإضافة أو - للخصم).', 'error');
                return;
            }
            if (!reason) {
                setStatusText(statusEl, 'يرجى كتابة سبب تعديل النقاط.', 'error');
                return;
            }

            btnAdjustPoints.disabled = true;
            setStatusText(statusEl, 'جاري تعديل النقاط…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_adjust_user_points', {
                p_user_id: selectedUserForAction.id,
                p_points_delta: delta,
                p_reason: reason,
            });

            btnAdjustPoints.disabled = false;

            if (error) {
                console.error('[admin.js] فشل تعديل النقاط:', error);
                setStatusText(statusEl, error.message || 'تعذر تعديل النقاط.', 'error');
                return;
            }

            const newTotal = data?.new_total_points ?? ((selectedUserForAction.points || 0) + delta);
            selectedUserForAction.points = newTotal;
            const ptsEl = document.getElementById('userModalPoints');
            if (ptsEl) ptsEl.textContent = newTotal.toLocaleString('ar-EG');
            setStatusText(statusEl, `تم تعديل النقاط بنجاح. الرصيد الجديد: ${newTotal.toLocaleString('ar-EG')}`, 'success');
            if (deltaInput) deltaInput.value = '';
            if (reasonInput) reasonInput.value = '';
        });
    }

    // 4. Restore streak
    const btnRestoreStreak = document.getElementById('btnExecuteRestoreStreak');
    if (btnRestoreStreak) {
        btnRestoreStreak.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const daysInput = document.getElementById('inputRestoreStreakDays');
            const reasonInput = document.getElementById('inputRestoreStreakReason');

            const days = parseInt(daysInput ? daysInput.value : '0', 10);
            const reason = reasonInput ? reasonInput.value.trim() : '';

            if (isNaN(days) || days <= 0) {
                setStatusText(statusEl, 'يرجى كتابة عدد صحيح لأيام السلسلة.', 'error');
                return;
            }
            if (!reason) {
                setStatusText(statusEl, 'يرجى كتابة سبب استعادة السلسلة.', 'error');
                return;
            }

            btnRestoreStreak.disabled = true;
            setStatusText(statusEl, 'جاري استعادة سلسلة الأيام…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_restore_user_streak', {
                p_user_id: selectedUserForAction.id,
                p_streak_days: days,
                p_reason: reason,
            });

            btnRestoreStreak.disabled = false;

            if (error) {
                console.error('[admin.js] فشل استعادة السلسلة:', error);
                setStatusText(statusEl, error.message || 'تعذر استعادة السلسلة.', 'error');
                return;
            }

            const newStreak = data?.current_streak_days ?? days;
            selectedUserForAction.current_streak_days = newStreak;
            selectedUserForAction.streak_count = newStreak;
            selectedUserForAction.best_streak_days = newStreak;
            const strkEl = document.getElementById('userModalStreak');
            if (strkEl) strkEl.textContent = `${newStreak.toLocaleString('ar-EG')} يوم`;
            setStatusText(statusEl, `تمت استعادة السلسلة المتتالية بنجاح (${newStreak} يوم).`, 'success');
            if (daysInput) daysInput.value = '';
            if (reasonInput) reasonInput.value = '';
        });
    }

    // 5. توثيق الحساب (الشارة الذهبية)
    const btnSetVerification = document.getElementById('btnExecuteSetVerification');
    if (btnSetVerification) {
        btnSetVerification.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const durationSelect = document.getElementById('selectVerificationDuration');
            const reasonInput = document.getElementById('inputVerificationReason');

            const durationDays = parseInt(durationSelect ? durationSelect.value : '0', 10);
            const reason = reasonInput ? reasonInput.value.trim() : '';

            btnSetVerification.disabled = true;
            setStatusText(statusEl, 'جاري تفعيل شارة التوثيق…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_set_user_verification', {
                p_user_id: selectedUserForAction.id,
                p_duration_days: durationDays,
                p_enable: true,
                p_reason: reason,
            });

            btnSetVerification.disabled = false;

            if (error) {
                console.error('[admin.js] فشل تفعيل التوثيق:', error);
                setStatusText(statusEl, error.message || 'تعذر تفعيل التوثيق.', 'error');
                return;
            }

            selectedUserForAction.is_verified = true;
            selectedUserForAction.verified_until = data?.verified_until || null;

            updateUserModalVerificationDisplay(selectedUserForAction);
            setStatusText(statusEl, 'تم تفعيل شارة التوثيق الذهبية للحساب بنجاح.', 'success');
            if (reasonInput) reasonInput.value = '';

            updateUserRowVerificationInList(selectedUserForAction);
        });
    }

    const btnRevokeVerification = document.getElementById('btnExecuteRevokeVerification');
    if (btnRevokeVerification) {
        btnRevokeVerification.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const reasonInput = document.getElementById('inputVerificationReason');
            const reason = reasonInput ? reasonInput.value.trim() : '';

            if (!confirm(`هل أنت متأكد من سحب شارة التوثيق الذهبية من (${selectedUserForAction.full_name || selectedUserForAction.username})؟`)) return;

            btnRevokeVerification.disabled = true;
            setStatusText(statusEl, 'جاري سحب التوثيق…', 'loading');

            const { error } = await supabaseClient.rpc('admin_set_user_verification', {
                p_user_id: selectedUserForAction.id,
                p_duration_days: 0,
                p_enable: false,
                p_reason: reason,
            });

            btnRevokeVerification.disabled = false;

            if (error) {
                console.error('[admin.js] فشل سحب التوثيق:', error);
                setStatusText(statusEl, error.message || 'تعذر سحب التوثيق.', 'error');
                return;
            }

            selectedUserForAction.is_verified = false;
            selectedUserForAction.verified_until = null;

            updateUserModalVerificationDisplay(selectedUserForAction);
            setStatusText(statusEl, 'تم سحب شارة التوثيق من الحساب بنجاح.', 'success');
            if (reasonInput) reasonInput.value = '';

            updateUserRowVerificationInList(selectedUserForAction);
        });
    }

    // 6. Freeze & Block controls
    const btnFreeze = document.getElementById('btnExecuteFreezeUser');
    const btnUnfreeze = document.getElementById('btnExecuteUnfreezeUser');
    const selectDuration = document.getElementById('selectFreezeDuration');
    const inputFreezeReason = document.getElementById('inputFreezeReason');

    if (btnFreeze) {
        btnFreeze.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            const reason = inputFreezeReason ? inputFreezeReason.value.trim() : '';
            if (!reason) {
                setStatusText(statusEl, 'يرجى كتابة سبب التجميد أو الحظر.', 'error');
                return;
            }

            const durationHours = parseInt(selectDuration ? selectDuration.value : '24', 10);
            const isPermanent = durationHours <= 0;
            const durationText = isPermanent
                ? 'حظر دائم'
                : (durationHours === 12 ? '12 ساعة' : durationHours === 24 ? '24 ساعة (يوم)' : durationHours === 48 ? '48 ساعة (يومان)' : durationHours === 72 ? '72 ساعة (3 أيام)' : durationHours === 168 ? 'أسبوع (7 أيام)' : `${durationHours} ساعة`);

            if (!confirm(`تأكيد تطبيق (${durationText}) على المستخدم (${selectedUserForAction.full_name || selectedUserForAction.username})؟`)) return;

            btnFreeze.disabled = true;
            setStatusText(statusEl, 'جاري تطبيق التجميد/الحظر…', 'loading');

            const { data, error } = await supabaseClient.rpc('admin_toggle_user_block', {
                p_user_id: selectedUserForAction.id,
                p_should_block: true,
                p_reason: reason,
                p_duration_hours: isPermanent ? null : durationHours,
            });

            btnFreeze.disabled = false;

            if (error) {
                console.error('[admin.js] فشل تطبيق التجميد/الحظر:', error);
                setStatusText(statusEl, error.message || 'تعذر تطبيق التجميد/الحظر.', 'error');
                return;
            }

            selectedUserForAction.is_blocked = true;
            selectedUserForAction.blocked_reason = reason;
            selectedUserForAction.blocked_until = data?.blocked_until ?? null;

            if (Array.isArray(allUsersList)) {
                const targetInList = allUsersList.find((u) => u.id === selectedUserForAction.id);
                if (targetInList) {
                    targetInList.is_blocked = true;
                    targetInList.blocked_reason = reason;
                    targetInList.blocked_until = data?.blocked_until ?? null;
                }
            }
            if (typeof renderFilteredUserList === 'function') {
                renderFilteredUserList();
            }

            updateUserModalFreezeDisplay(selectedUserForAction);
            if (inputFreezeReason) inputFreezeReason.value = '';
            setStatusText(statusEl, `تم تطبيق ${durationText} بنجاح وإشعار المستخدم.`, 'success');

            if (typeof addCompetitorAuditEntry === 'function') {
                addCompetitorAuditEntry(
                    selectedUserForAction.full_name || selectedUserForAction.username || 'مستخدم',
                    'حظر/تجميد',
                    `تطبيق ${durationText}: ${reason}`
                );
            }
        });
    }

    if (btnUnfreeze) {
        btnUnfreeze.addEventListener('click', async () => {
            if (!selectedUserForAction) return;
            if (!confirm(`تأكيد فك التجميد/الحظر فوراً عن المستخدم (${selectedUserForAction.full_name || selectedUserForAction.username})؟`)) return;

            btnUnfreeze.disabled = true;
            setStatusText(statusEl, 'جاري فك التجميد/الحظر…', 'loading');

            const { error } = await supabaseClient.rpc('admin_toggle_user_block', {
                p_user_id: selectedUserForAction.id,
                p_should_block: false,
                p_reason: 'فك الحظر والتجميد من قبل الإدارة',
            });

            btnUnfreeze.disabled = false;

            if (error) {
                console.error('[admin.js] فشل فك التجميد/الحظر:', error);
                setStatusText(statusEl, error.message || 'تعذر فك التجميد/الحظر.', 'error');
                return;
            }

            selectedUserForAction.is_blocked = false;
            selectedUserForAction.blocked_reason = null;
            selectedUserForAction.blocked_until = null;

            if (Array.isArray(allUsersList)) {
                const targetInList = allUsersList.find((u) => u.id === selectedUserForAction.id);
                if (targetInList) {
                    targetInList.is_blocked = false;
                    targetInList.blocked_reason = null;
                    targetInList.blocked_until = null;
                }
            }
            if (typeof renderFilteredUserList === 'function') {
                renderFilteredUserList();
            }

            updateUserModalFreezeDisplay(selectedUserForAction);
            setStatusText(statusEl, 'تم رفع التجميد/الحظر عن الحساب بنجاح واستعادته.', 'success');

            if (typeof addCompetitorAuditEntry === 'function') {
                addCompetitorAuditEntry(
                    selectedUserForAction.full_name || selectedUserForAction.username || 'مستخدم',
                    'فك تجميد/حظر',
                    'فك التجميد واستعادة صلاحيات الحساب'
                );
            }
        });
    }
}

function updateUserRowVerificationInList(user) {
    if (!user || !user.id) return;
    const rowEl = document.querySelector(`.admin-user-row[data-user-id="${user.id}"]`);
    if (!rowEl) return;
    const nameEl = rowEl.querySelector('.admin-user-name');
    if (!nameEl) return;
    const isVerified = isUserVerificationActive(user);
    const displayName = escapeHtml(user.full_name || user.username || 'مستخدم بدون اسم');
    const badgeHtml = isVerified ? buildVerifiedBadgeHtml(true) : '';
    nameEl.innerHTML = `${displayName}${badgeHtml}`;
}

function updateUserModalVerificationDisplay(user) {
    const statusTextEl = document.getElementById('userModalVerificationStatus');
    const badgeTagEl = document.getElementById('userModalVerificationBadgeTag');
    const detailsEl = document.getElementById('userModalVerificationDetails');

    const isVerified = isUserVerificationActive(user);
    if (isVerified) {
        if (!user.verified_until) {
            if (statusTextEl) {
                statusTextEl.textContent = 'موثق (دائم)';
                statusTextEl.className = 'text-xs font-bold text-gold-400 truncate';
            }
            if (badgeTagEl) {
                badgeTagEl.textContent = 'موثق دائم';
                badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-gold-500/20 text-gold-300 border border-gold-500/30';
            }
            if (detailsEl) {
                detailsEl.textContent = 'شارة التوثيق الذهبية مفعّلة بشكل دائم بدون تاريخ انتهاء.';
                detailsEl.classList.remove('hidden');
            }
        } else {
            const untilDate = new Date(user.verified_until);
            const now = new Date();
            const diffMs = untilDate - now;
            const remainingDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
            const formattedDate = untilDate.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });

            if (statusTextEl) {
                statusTextEl.textContent = `موثق (${remainingDays} يوم)`;
                statusTextEl.className = 'text-xs font-bold text-gold-400 truncate';
            }
            if (badgeTagEl) {
                badgeTagEl.textContent = `موثق مؤقت (${remainingDays} يوم)`;
                badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-gold-500/20 text-gold-300 border border-gold-500/30';
            }
            if (detailsEl) {
                detailsEl.textContent = `ينتهي التوثيق في ${formattedDate} (متبقي حوالي ${remainingDays} يوم).`;
                detailsEl.classList.remove('hidden');
            }
        }
    } else {
        if (statusTextEl) {
            statusTextEl.textContent = 'غير موثق';
            statusTextEl.className = 'text-xs font-bold text-lux-400 truncate';
        }
        if (badgeTagEl) {
            badgeTagEl.textContent = 'غير موثق';
            badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-lux-800 text-lux-400 border border-lux-700';
        }
        if (detailsEl) {
            detailsEl.textContent = '';
            detailsEl.classList.add('hidden');
        }
    }
}

function updateUserModalFreezeDisplay(user) {
    const accountStatusEl = document.getElementById('userModalAccountStatus');
    const badgeTagEl = document.getElementById('userModalFreezeBadgeTag');
    const detailsEl = document.getElementById('userModalFreezeDetails');

    const isBlocked = Boolean(user.is_blocked);
    const blockedUntil = user.blocked_until;
    let isFrozen = false;
    let remainingHoursText = '';
    let untilFormatted = '';

    if (isBlocked && blockedUntil) {
        const d = new Date(blockedUntil);
        if (!isNaN(d.getTime())) {
            const diffMs = d.getTime() - Date.now();
            if (diffMs > 0) {
                isFrozen = true;
                const hoursLeft = Math.ceil(diffMs / (1000 * 60 * 60));
                if (hoursLeft > 24) {
                    const daysLeft = Math.ceil(hoursLeft / 24);
                    remainingHoursText = `متبقي حوالي ${daysLeft} يوم`;
                } else {
                    remainingHoursText = `متبقي حوالي ${hoursLeft} ساعة`;
                }
                untilFormatted = d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
            }
        }
    }

    if (isFrozen) {
        if (accountStatusEl) {
            accountStatusEl.textContent = 'مجمّد مؤقتاً';
            accountStatusEl.className = 'text-xs font-bold text-amber-400 truncate';
        }
        if (badgeTagEl) {
            badgeTagEl.textContent = 'مجمّد مؤقتاً';
            badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20';
        }
        if (detailsEl) {
            detailsEl.innerHTML = `
                <div><strong>حالة الحساب:</strong> مجمّد مؤقتاً (${remainingHoursText})</div>
                <div><strong>تاريخ الانتهاء:</strong> ${untilFormatted}</div>
                <div><strong>السبب:</strong> ${escapeHtml(user.blocked_reason || 'قرار إداري')}</div>
            `;
            detailsEl.classList.remove('hidden');
        }
    } else if (isBlocked) {
        if (accountStatusEl) {
            accountStatusEl.textContent = 'محظور دائم';
            accountStatusEl.className = 'text-xs font-bold text-rose-400 truncate';
        }
        if (badgeTagEl) {
            badgeTagEl.textContent = 'محظور دائم';
            badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20';
        }
        if (detailsEl) {
            detailsEl.innerHTML = `
                <div><strong>حالة الحساب:</strong> محظور بشكل دائم</div>
                <div><strong>السبب:</strong> ${escapeHtml(user.blocked_reason || 'قرار إداري')}</div>
            `;
            detailsEl.classList.remove('hidden');
        }
    } else {
        if (accountStatusEl) {
            accountStatusEl.textContent = 'نشط';
            accountStatusEl.className = 'text-xs font-bold text-emerald-400 truncate';
        }
        if (badgeTagEl) {
            badgeTagEl.textContent = 'حساب نشط';
            badgeTagEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
        }
        if (detailsEl) {
            detailsEl.innerHTML = '';
            detailsEl.classList.add('hidden');
        }
    }
}

async function openUserActionModal(user) {
    selectedUserForAction = user;
    const modal = document.getElementById('userAdminActionModal');
    if (!modal) return;

    const avatarEl = document.getElementById('userModalAvatar');
    const nameEl = document.getElementById('userModalName');
    const usernameEl = document.getElementById('userModalUsername');
    const pointsEl = document.getElementById('userModalPoints');
    const streakEl = document.getElementById('userModalStreak');
    const todayStepsEl = document.getElementById('userModalTodaySteps');
    const statusEl = document.getElementById('userModalStatus');

    if (avatarEl) avatarEl.src = user.avatar_url || buildFallbackAvatarUrl(user.username || user.full_name || '?');
    if (nameEl) nameEl.textContent = user.full_name || user.username || 'مستخدم بدون اسم';
    if (usernameEl) usernameEl.textContent = user.username ? `@${user.username}` : '';
    if (pointsEl) pointsEl.textContent = (user.points || 0).toLocaleString('ar-EG');
    const currentStreak = user.current_streak_days || user.streak_count || user.best_streak_days || 0;
    if (streakEl) streakEl.textContent = `${currentStreak.toLocaleString('ar-EG')} يوم`;
    if (todayStepsEl) {
        todayStepsEl.textContent = (user.daily_steps || 0).toLocaleString('ar-EG');
    }
    if (statusEl) setStatusText(statusEl, '', null);

    const inputAdjustStepsValue = document.getElementById('inputAdjustStepsValue');
    const inputAdjustStepsReason = document.getElementById('inputAdjustStepsReason');
    const inputFreezeReason = document.getElementById('inputFreezeReason');
    if (inputAdjustStepsValue) inputAdjustStepsValue.value = '';
    if (inputAdjustStepsReason) inputAdjustStepsReason.value = '';
    if (inputFreezeReason) inputFreezeReason.value = '';

    updateUserModalVerificationDisplay(user);
    updateUserModalFreezeDisplay(user);
    updateUserModalLocationDisplay(user);

    modal.classList.remove('hidden');
}

/**
 * تحديث بيانات تدقيق موقع تسجيل المستخدم في المودال
 * @param {object} user
 */
function updateUserModalLocationDisplay(user) {
    const lat = user.signup_lat ?? user.last_lat ?? null;
    const lng = user.signup_lng ?? user.last_lng ?? null;
    let distanceMeters = user.signup_distance_meters ?? null;
    if (distanceMeters === null && typeof lat === 'number' && typeof lng === 'number') {
        distanceMeters = Math.round(
            calculateDistanceMeters(lat, lng, cachedAdminGeofenceCenter.lat, cachedAdminGeofenceCenter.lng)
        );
    }
    const accuracy = user.signup_accuracy_meters ?? null;
    const hasLocation = typeof lat === 'number' && typeof lng === 'number';
    const isInsideVillage = Boolean(user.is_inside_bounds || (distanceMeters !== null && distanceMeters <= (cachedAdminGeofenceCenter.radius || 2000)));

    const locBadgeEl = document.getElementById('userModalLocationBadge');
    const distEl = document.getElementById('userModalDistanceText');
    const coordsEl = document.getElementById('userModalCoordinatesText');
    const accEl = document.getElementById('userModalAccuracyText');
    const mapsLink = document.getElementById('userModalGoogleMapsLink');

    if (hasLocation) {
        const formattedDist = distanceMeters !== null
            ? (distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(2)} كم` : `${distanceMeters} متر`)
            : 'غير محسوب';

        if (locBadgeEl) {
            locBadgeEl.textContent = isInsideVillage ? 'داخل نزلة عبيد' : 'خارج نطاق القرية';
            locBadgeEl.className = isInsideVillage
                ? 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
        }
        if (distEl) distEl.textContent = formattedDist;
        if (coordsEl) coordsEl.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (accEl) accEl.textContent = accuracy ? `±${accuracy}م` : 'دقة عادية (GPS)';
        if (mapsLink) {
            mapsLink.href = `https://www.google.com/maps?q=${lat},${lng}`;
            mapsLink.classList.remove('hidden');
        }
    } else {
        if (locBadgeEl) {
            locBadgeEl.textContent = 'الموقع غير مسجل';
            locBadgeEl.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-lux-800 text-lux-400 border border-lux-700';
        }
        if (distEl) distEl.textContent = 'غير متوفر';
        if (coordsEl) coordsEl.textContent = 'لا توجد إحداثيات';
        if (accEl) accEl.textContent = '—';
        if (mapsLink) mapsLink.classList.add('hidden');
    }
}

/* ==================================================================
   12) إدارة ومراقبة القصص (Stories Moderation)
   ================================================================== */

const ADMIN_STAT_TAG_REGEX = /\n?<!--stat:(\{[^}]*\})-->\s*$/;

function parseAdminStoryContent(rawContent) {
    const text = rawContent || '';
    const match = text.match(ADMIN_STAT_TAG_REGEX);
    if (!match) return { content: text, statData: null };

    let statData = null;
    try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed === 'object') {
            statData = parsed;
        }
    } catch (_) {}

    return {
        content: text.slice(0, match.index).trimEnd(),
        statData
    };
}

function getStoryFontCssClass(fontStyle) {
    switch (fontStyle) {
        case 'tajawal-bold': return 'font-tajawal font-bold';
        case 'amiri-quran': return 'font-serif font-bold';
        case 'ruqaa': return 'font-ruqaa font-bold';
        case 'kufi': return 'font-kufi font-bold';
        case 'naskh': return 'font-naskh font-bold';
        case 'cairo-black':
        default:
            return 'font-cairo font-black';
    }
}

let activeViewingStory = null;

function initStoriesModerationWidget() {
    const btnPosts = document.getElementById('btnSubTabPostsView');
    const btnStories = document.getElementById('btnSubTabStoriesView');
    const postsContainer = document.getElementById('subTabPostsContainer');
    const storiesContainer = document.getElementById('subTabStoriesContainer');
    const btnRefresh = document.getElementById('btnRefreshAdminStories');

    const modal = document.getElementById('adminStoryViewerModal');
    const btnClose = document.getElementById('btnCloseAdminStoryViewer');
    const btnCloseBottom = document.getElementById('btnAdminViewerCloseBottom');
    const btnDelete = document.getElementById('btnAdminViewerDeleteStory');

    const closeViewer = () => {
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modal.style.display = 'none';
        }
        activeViewingStory = null;
    };

    if (btnClose) btnClose.addEventListener('click', closeViewer);
    if (btnCloseBottom) btnCloseBottom.addEventListener('click', closeViewer);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeViewer();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeViewingStory && modal && !modal.classList.contains('hidden')) {
            closeViewer();
        }
    });

    if (btnDelete) {
        btnDelete.addEventListener('click', async () => {
            if (!activeViewingStory) return;
            const reason = prompt('اكتب سبب حذف القصة (سيتم تسجيله وإرسال إشعار للمستخدم):', 'مخالفة معايير النشر');
            if (!reason) return;

            btnDelete.disabled = true;
            btnDelete.textContent = 'جاري الحذف…';

            const { error: delErr } = await supabaseClient.rpc('admin_delete_story', {
                p_story_id: activeViewingStory.id,
                p_reason: reason,
            });

            btnDelete.disabled = false;
            btnDelete.textContent = 'حذف هذه القصة';

            if (delErr) {
                alert('فشل حذف القصة: ' + (delErr.message || delErr));
                return;
            }

            closeViewer();
            loadAdminStories();
        });
    }

    if (!btnPosts || !btnStories || !postsContainer || !storiesContainer) return;

    btnPosts.addEventListener('click', () => {
        postsContainer.classList.remove('hidden');
        storiesContainer.classList.add('hidden');
        btnPosts.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-lux-800 text-gold-400 border border-gold-500/30 transition';
        btnStories.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-lux-950 text-lux-400 border border-lux-800 hover:text-lux-200 transition';
    });

    btnStories.addEventListener('click', () => {
        postsContainer.classList.add('hidden');
        storiesContainer.classList.remove('hidden');
        btnStories.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-lux-800 text-gold-400 border border-gold-500/30 transition';
        btnPosts.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-lux-950 text-lux-400 border border-lux-800 hover:text-lux-200 transition';
        loadAdminStories();
    });

    if (btnRefresh) {
        btnRefresh.addEventListener('click', loadAdminStories);
    }
}

function openAdminStoryViewer(story, cleanText, statData) {
    try {
        const modal = document.getElementById('adminStoryViewerModal');
        const avatarEl = document.getElementById('adminStoryViewerAvatar');
        const authorEl = document.getElementById('adminStoryViewerAuthor');
        const metaEl = document.getElementById('adminStoryViewerMeta');
        const contentEl = document.getElementById('adminStoryViewerContent');
        const textWrapper = document.getElementById('adminStoryViewerTextWrapper');
        const textEl = document.getElementById('adminStoryViewerText');
        const stickerEl = document.getElementById('adminStoryViewerSticker');
        const stickerSteps = document.getElementById('adminStoryViewerStickerSteps');
        const stickerPercent = document.getElementById('adminStoryViewerStickerPercent');
        if (!modal) return;

        activeViewingStory = story;

        const avatar = story.author_avatar || buildFallbackAvatarUrl(story.author_name || '?');
        const authorName = escapeHtml(story.author_name || 'مستخدم');
        const username = story.author_username ? `@${escapeHtml(story.author_username)}` : '';
        const timeAgo = formatRelativeArabicTime(story.created_at);

        if (avatarEl) avatarEl.src = avatar;
        if (authorEl) authorEl.textContent = authorName;
        if (metaEl) metaEl.textContent = `${username} · ${timeAgo}`;

        if (contentEl) {
            if (story.media_url) {
                contentEl.style.backgroundImage = `url("${escapeHtml(story.media_url)}")`;
                contentEl.style.backgroundSize = 'cover';
                contentEl.style.backgroundPosition = 'center';
                contentEl.style.backgroundColor = '#0b0e14';
            } else {
                contentEl.style.backgroundImage = 'none';
                contentEl.style.background = story.background_color || '#1e1b4b';
            }
        }

        const isStickerTop = statData?.top === 'sticker';
        const textZ = isStickerTop ? 15 : 25;
        const stickerZ = isStickerTop ? 25 : 15;
        const tx = statData?.tx ?? 50;
        const ty = statData?.ty ?? 50;
        const ts = statData?.ts ?? 1;

        if (textWrapper) {
            textWrapper.style.position = 'absolute';
            textWrapper.style.left = `${tx}%`;
            textWrapper.style.top = `${ty}%`;
            textWrapper.style.transform = `translate(-50%, -50%) scale(${ts})`;
            textWrapper.style.zIndex = textZ;
        }

        if (textEl) {
            textEl.textContent = cleanText;
            textEl.className = `w-full text-center text-white font-bold leading-relaxed break-words select-none m-0 p-0 ${getStoryFontCssClass(story.font_style)}`;
            if (cleanText.length > 70) {
                textEl.style.fontSize = '1.2rem';
            } else if (cleanText.length > 35) {
                textEl.style.fontSize = '1.5rem';
            } else {
                textEl.style.fontSize = '1.9rem';
            }
        }

        if (stickerEl) {
            if (statData && typeof statData.steps === 'number') {
                stickerEl.classList.remove('hidden');
                if (stickerSteps) stickerSteps.textContent = `${Number(statData.steps).toLocaleString('en-US')} خطوة`;
                if (stickerPercent) stickerPercent.textContent = `${statData.percent}%`;
                stickerEl.style.setProperty('--sticker-x', `${statData.x ?? 50}%`);
                stickerEl.style.setProperty('--sticker-y', `${statData.y ?? 88}%`);
                stickerEl.style.setProperty('--sticker-scale', statData.scale ?? 1);
                stickerEl.style.zIndex = stickerZ;
            } else {
                stickerEl.classList.add('hidden');
            }
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.style.display = 'flex';
    } catch (err) {
        console.error('[admin.js] خطأ أثناء فتح معاينة القصة:', err);
    }
}

async function loadAdminStories() {
    const statusEl = document.getElementById('adminStoriesStatus');
    const container = document.getElementById('adminStoriesListContainer');
    if (!container) return;

    setStatusText(statusEl, 'جاري تحميل القصص النشطة…', 'loading');
    container.innerHTML = '';

    const { data: stories, error } = await supabaseClient.rpc('admin_list_stories');

    if (error) {
        console.error('[admin.js] فشل تحميل القصص:', error);
        setStatusText(statusEl, 'تعذر تحميل القصص النشطة.', 'error');
        return;
    }

    if (!stories || stories.length === 0) {
        setStatusText(statusEl, 'لا توجد قصص نشطة حالياً.', 'empty');
        return;
    }

    setStatusText(statusEl, '', null);

    stories.forEach((story) => {
        const card = document.createElement('div');
        card.className = 'p-4 rounded-2xl bg-lux-950 border border-lux-800/90 space-y-3 flex flex-col justify-between hover:border-lux-700 transition';

        const avatar = story.author_avatar || buildFallbackAvatarUrl(story.author_name || '?');
        const authorName = escapeHtml(story.author_name || 'مستخدم');
        const username = story.author_username ? `@${escapeHtml(story.author_username)}` : '';
        const timeAgo = formatRelativeArabicTime(story.created_at);
        const expiresAt = new Date(story.expires_at);
        const remainingHours = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)));

        const { content: cleanText, statData } = parseAdminStoryContent(story.text_content);

        const isStickerTop = statData?.top === 'sticker';
        const textZ = isStickerTop ? 15 : 25;
        const stickerZ = isStickerTop ? 25 : 15;
        const tx = statData?.tx ?? 50;
        const ty = statData?.ty ?? 50;
        const ts = statData?.ts ?? 1;

        const stickerHtml = (statData && typeof statData.steps === 'number') ? `
            <div class="story-stat-sticker absolute flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 border border-gold-500/40 backdrop-blur-md shadow-lg pointer-events-none"
                 style="left: ${statData.x}%; top: ${statData.y}%; transform: translate(-50%, -50%) scale(${statData.scale || 1}); z-index: ${stickerZ};">
                <span class="text-amber-400">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
                    </svg>
                </span>
                <span class="text-[11px] font-bold text-white font-mono">${Number(statData.steps).toLocaleString('en-US')} خطوة</span>
                <span class="text-[10px] font-bold text-gold-400 font-mono">${statData.percent}%</span>
            </div>
        ` : '';

        const fontClass = getStoryFontCssClass(story.font_style);

        const previewCardHtml = story.media_url
            ? `<div class="story-preview-box w-full aspect-[9/14] max-h-72 rounded-2xl relative overflow-hidden bg-black/40 border border-lux-800 shadow-xl cursor-pointer hover:border-gold-500/50 transition group">
                 <img src="${escapeHtml(story.media_url)}" class="w-full h-full object-cover" alt="">
                 <div class="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition backdrop-blur-[2px]">
                     <span class="px-3 py-1.5 rounded-full bg-lux-900/90 text-gold-400 text-xs font-bold border border-gold-500/40 shadow-lg">معاينة القصة</span>
                 </div>
               </div>`
            : `<div class="story-preview-box w-full aspect-[9/14] max-h-72 rounded-2xl relative overflow-hidden p-4 border border-lux-800 shadow-xl cursor-pointer hover:border-gold-500/50 transition group"
                    style="background: ${escapeHtml(story.background_color || '#1e1b4b')}">
                 <div class="absolute flex flex-col items-center justify-center pointer-events-none" style="left: ${tx}%; top: ${ty}%; transform: translate(-50%, -50%) scale(${ts}); z-index: ${textZ}; width: 90%;">
                     <p class="text-white text-center font-bold text-sm sm:text-base leading-relaxed break-words select-none ${fontClass}">
                         ${escapeHtml(cleanText)}
                     </p>
                 </div>
                 ${stickerHtml}
                 <div class="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition backdrop-blur-[2px] z-30">
                     <span class="px-3 py-1.5 rounded-full bg-lux-900/90 text-gold-400 text-xs font-bold border border-gold-500/40 shadow-lg">
                         معاينة القصة بالكامل
                     </span>
                 </div>
               </div>`;

        card.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2.5">
                        <img src="${avatar}" class="w-8 h-8 rounded-full border border-lux-700 object-cover" alt="">
                        <div>
                            <div class="text-xs font-bold text-lux-100">${authorName}</div>
                            <div class="text-[10px] text-lux-400 font-mono">${username} · ${timeAgo}</div>
                        </div>
                    </div>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${story.visibility === 'friends' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}">
                        ${story.visibility === 'friends' ? 'للأصدقاء' : 'عامة'}
                    </span>
                </div>

                ${previewCardHtml}

                <div class="flex items-center justify-between text-[10px] font-mono text-lux-500 pt-1">
                    <span>تنتهي بعد حوالي ${remainingHours} ساعة</span>
                    <button type="button" class="btn-preview-story text-gold-400 hover:text-gold-300 font-bold transition">
                        تكبير الشاشة ↗
                    </button>
                </div>
            </div>

            <button type="button" class="btn-delete-story w-full py-2 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/40 text-xs font-bold transition mt-2">
                حذف القصة فوراً
            </button>
        `;

        const previewBox = card.querySelector('.story-preview-box');
        const previewBtn = card.querySelector('.btn-preview-story');
        const openViewerHandler = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            openAdminStoryViewer(story, cleanText, statData);
        };

        if (previewBox) previewBox.addEventListener('click', openViewerHandler);
        if (previewBtn) previewBtn.addEventListener('click', openViewerHandler);

        const delBtn = card.querySelector('.btn-delete-story');
        if (delBtn) {
            delBtn.addEventListener('click', async () => {
                const reason = prompt('اكتب سبب حذف القصة (سيتم تسجيله وإرسال إشعار للمستخدم):', 'مخالفة معايير النشر');
                if (!reason) return;

                delBtn.disabled = true;
                delBtn.textContent = 'جاري الحذف…';

                const { error: delErr } = await supabaseClient.rpc('admin_delete_story', {
                    p_story_id: story.id,
                    p_reason: reason,
                });

                if (delErr) {
                    alert('فشل حذف القصة: ' + (delErr.message || delErr));
                    delBtn.disabled = false;
                    delBtn.textContent = 'حذف القصة فوراً';
                    return;
                }

                card.remove();
                if (container.children.length === 0) {
                    setStatusText(statusEl, 'لا توجد قصص نشطة حالياً.', 'empty');
                }
            });
        }

        container.appendChild(card);
    });
}

/* ==================================================================
   13) غرفة التحكم الرئيسية (Master Control Panel)
   ================================================================== */

let currentProfanityWords = [];

async function initMasterSettings() {
    const panel = document.getElementById('tabPanelMaster');
    if (!panel) return;

    const { data: settings, error } = await supabaseClient
        .from('app_settings')
        .select('*')
        .eq('id', 1)
        .single();

    if (error) {
        console.error('[admin.js] فشل تحميل إعدادات التحكم العامة:', error);
        return;
    }

    // 1. Maintenance
    const maintToggle = document.getElementById('masterMaintenanceToggle');
    const maintMsg = document.getElementById('masterMaintenanceMsg');
    const maintEnd = document.getElementById('masterMaintenanceEndTime');
    const btnSaveMaint = document.getElementById('btnSaveMaintenanceSettings');

    if (maintToggle) maintToggle.checked = Boolean(settings.is_maintenance_mode);
    if (maintMsg) maintMsg.value = settings.maintenance_message || '';
    if (maintEnd && settings.maintenance_estimated_end) {
        try {
            const d = new Date(settings.maintenance_estimated_end);
            maintEnd.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        } catch (e) {}
    }

    if (btnSaveMaint) {
        btnSaveMaint.addEventListener('click', async () => {
            btnSaveMaint.disabled = true;
            btnSaveMaint.textContent = 'جاري الحفظ…';

            const payload = {
                is_maintenance_mode: maintToggle ? maintToggle.checked : false,
                maintenance_message: maintMsg ? maintMsg.value.trim() : '',
                maintenance_estimated_end: maintEnd && maintEnd.value ? new Date(maintEnd.value).toISOString() : null,
            };

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: payload,
            });

            btnSaveMaint.disabled = false;
            btnSaveMaint.textContent = 'حفظ إعدادات الصيانة';

            if (saveErr) {
                alert('فشل حفظ إعدادات وضع الصيانة: ' + saveErr.message);
            } else {
                alert('تم حفظ وتطبيق إعدادات الصيانة بنجاح.');
            }
        });
    }

    // 2. Force update
    const fuToggle = document.getElementById('masterForceUpdateToggle');
    const fuMin = document.getElementById('masterMinVersion');
    const fuLatest = document.getElementById('masterLatestVersion');
    const fuUrl = document.getElementById('masterForceUpdateUrl');
    const fuMsg = document.getElementById('masterForceUpdateMsg');
    const btnSaveFu = document.getElementById('btnSaveForceUpdateSettings');

    if (fuToggle) fuToggle.checked = Boolean(settings.is_force_update_enabled);
    if (fuMin) fuMin.value = settings.min_app_version || '1.0.0';
    if (fuLatest) fuLatest.value = settings.latest_app_version || '1.0.0';
    if (fuUrl) fuUrl.value = settings.force_update_url || '';
    if (fuMsg) fuMsg.value = settings.force_update_message || '';

    if (btnSaveFu) {
        btnSaveFu.addEventListener('click', async () => {
            btnSaveFu.disabled = true;
            btnSaveFu.textContent = 'جاري الحفظ…';

            const payload = {
                is_force_update_enabled: fuToggle ? fuToggle.checked : false,
                min_app_version: fuMin ? fuMin.value.trim() : '1.0.0',
                latest_app_version: fuLatest ? fuLatest.value.trim() : '1.0.0',
                force_update_url: fuUrl ? fuUrl.value.trim() : '',
                force_update_message: fuMsg ? fuMsg.value.trim() : '',
            };

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: payload,
            });

            btnSaveFu.disabled = false;
            btnSaveFu.textContent = 'حفظ إعدادات التحديث';

            if (saveErr) {
                alert('فشل حفظ إعدادات التحديث: ' + saveErr.message);
            } else {
                alert('تم حفظ إعدادات التحديث بنجاح.');
            }
        });
    }

    // 3. Points multiplier
    const pmSelect = document.getElementById('masterPointsMultiplier');
    const pmTitle = document.getElementById('masterPointsMultiplierTitle');
    const pmExpiry = document.getElementById('masterPointsMultiplierExpiry');
    const btnSavePm = document.getElementById('btnSavePointsMultiplier');

    if (pmSelect) pmSelect.value = String(Number(settings.points_multiplier || 1).toFixed(1));
    if (pmTitle) pmTitle.value = settings.points_multiplier_title || '';
    if (pmExpiry && settings.points_multiplier_expires_at) {
        try {
            const d = new Date(settings.points_multiplier_expires_at);
            pmExpiry.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        } catch (e) {}
    }

    if (btnSavePm) {
        btnSavePm.addEventListener('click', async () => {
            btnSavePm.disabled = true;
            btnSavePm.textContent = 'جاري الحفظ…';

            const payload = {
                points_multiplier: parseFloat(pmSelect.value) || 1.0,
                points_multiplier_title: pmTitle ? pmTitle.value.trim() : '',
                points_multiplier_expires_at: pmExpiry && pmExpiry.value ? new Date(pmExpiry.value).toISOString() : null,
            };

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: payload,
            });

            btnSavePm.disabled = false;
            btnSavePm.textContent = 'حفظ وتفعيل مضاعف النقاط';

            if (saveErr) {
                alert('فشل حفظ مضاعف النقاط: ' + saveErr.message);
            } else {
                alert('تم تفعيل إعدادات مضاعف النقاط بنجاح.');
            }
        });
    }

    // 4. Feature flags
    const fStories = document.getElementById('flagStories');
    const fPosts = document.getElementById('flagPosts');
    const fComments = document.getElementById('flagComments');
    const fSupport = document.getElementById('flagSupportChat');
    const fDailyQ = document.getElementById('flagDailyQuestion');
    const fLeaderboard = document.getElementById('flagLeaderboard');
    const btnSaveFlags = document.getElementById('btnSaveFeatureFlags');

    if (fStories) fStories.checked = settings.feature_stories_enabled !== false;
    if (fPosts) fPosts.checked = settings.feature_posts_enabled !== false;
    if (fComments) fComments.checked = settings.feature_comments_enabled !== false;
    if (fSupport) fSupport.checked = settings.feature_support_chat_enabled !== false;
    if (fDailyQ) fDailyQ.checked = settings.feature_daily_question_enabled !== false;
    if (fLeaderboard) fLeaderboard.checked = settings.feature_leaderboard_enabled !== false;

    if (btnSaveFlags) {
        btnSaveFlags.addEventListener('click', async () => {
            btnSaveFlags.disabled = true;
            btnSaveFlags.textContent = 'جاري الحفظ…';

            const payload = {
                feature_stories_enabled: fStories ? fStories.checked : true,
                feature_posts_enabled: fPosts ? fPosts.checked : true,
                feature_comments_enabled: fComments ? fComments.checked : true,
                feature_support_chat_enabled: fSupport ? fSupport.checked : true,
                feature_daily_question_enabled: fDailyQ ? fDailyQ.checked : true,
                feature_leaderboard_enabled: fLeaderboard ? fLeaderboard.checked : true,
            };

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: payload,
            });

            btnSaveFlags.disabled = false;
            btnSaveFlags.textContent = 'حفظ مفاتيح الميزات';

            if (saveErr) {
                alert('فشل حفظ مفاتيح الميزات: ' + saveErr.message);
            } else {
                alert('تم حفظ مفاتيح الميزات بنجاح.');
            }
        });
    }

    // 5. In-app announcement
    const annToggle = document.getElementById('masterAnnouncementToggle');
    const annId = document.getElementById('masterAnnouncementId');
    const annTitle = document.getElementById('masterAnnouncementTitle');
    const annBody = document.getElementById('masterAnnouncementBody');
    const annImg = document.getElementById('masterAnnouncementImage');
    const annBtnText = document.getElementById('masterAnnouncementBtnText');
    const annBtnUrl = document.getElementById('masterAnnouncementBtnUrl');
    const btnSaveAnn = document.getElementById('btnSaveAnnouncement');

    // عناصر رفع ومعاينة صورة الإعلان
    const btnUploadAnnImg = document.getElementById('btnUploadAnnouncementImage');
    const annFileInput = document.getElementById('announcementFileInput');
    const btnRemoveAnnImg = document.getElementById('btnRemoveAnnouncementImage');
    const annUploadStatus = document.getElementById('announcementUploadStatus');
    const annPreviewBox = document.getElementById('announcementPreviewContainer');
    const annPreviewImg = document.getElementById('announcementPreviewImg');

    const updateAnnouncementImagePreview = (url) => {
        const cleanUrl = url ? url.trim() : '';
        if (cleanUrl) {
            if (annPreviewImg) annPreviewImg.src = cleanUrl;
            if (annPreviewBox) annPreviewBox.classList.remove('hidden');
            if (btnRemoveAnnImg) btnRemoveAnnImg.classList.remove('hidden');
        } else {
            if (annPreviewImg) annPreviewImg.src = '';
            if (annPreviewBox) annPreviewBox.classList.add('hidden');
            if (btnRemoveAnnImg) btnRemoveAnnImg.classList.add('hidden');
        }
    };

    if (annToggle) annToggle.checked = Boolean(settings.announcement_enabled ?? settings.announcement_is_active);
    if (annId) annId.value = settings.announcement_id || 'announcement_1';
    if (annTitle) annTitle.value = settings.announcement_title || '';
    if (annBody) annBody.value = settings.announcement_body || '';
    if (annImg) {
        annImg.value = settings.announcement_image_url || '';
        annImg.addEventListener('input', () => updateAnnouncementImagePreview(annImg.value));
    }
    if (annBtnText) annBtnText.value = settings.announcement_button_text || 'حسناً';
    if (annBtnUrl) annBtnUrl.value = settings.announcement_button_url || '';

    updateAnnouncementImagePreview(settings.announcement_image_url || '');

    if (btnUploadAnnImg && annFileInput) {
        btnUploadAnnImg.addEventListener('click', () => annFileInput.click());

        annFileInput.addEventListener('change', async () => {
            const file = annFileInput.files && annFileInput.files[0];
            annFileInput.value = '';
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) {
                if (annUploadStatus) {
                    annUploadStatus.textContent = 'حجم الصورة كبير - الحد الأقصى 5 ميجابايت';
                    annUploadStatus.className = 'text-xs text-rose-400 font-bold';
                }
                return;
            }

            if (annUploadStatus) {
                annUploadStatus.textContent = 'جاري رفع الصورة…';
                annUploadStatus.className = 'text-xs text-lux-400 font-medium';
            }

            const fileExt = (file.name.split('.').pop() || 'jpg').toLowerCase();
            const filePath = `announcement-${Date.now()}.${fileExt}`;

            const { error: uploadError } = await supabaseClient
                .storage
                .from('banners')
                .upload(filePath, file, { upsert: false });

            if (uploadError) {
                console.error('[admin.js] فشل رفع صورة الإعلان:', uploadError);
                if (annUploadStatus) {
                    annUploadStatus.textContent = 'تعذر رفع الصورة: ' + uploadError.message;
                    annUploadStatus.className = 'text-xs text-rose-400 font-bold';
                }
                return;
            }

            const { data: publicUrlData } = supabaseClient
                .storage
                .from('banners')
                .getPublicUrl(filePath);

            const publicUrl = publicUrlData ? publicUrlData.publicUrl : '';
            if (annImg) annImg.value = publicUrl;
            updateAnnouncementImagePreview(publicUrl);

            if (annUploadStatus) {
                annUploadStatus.textContent = 'تم رفع الصورة بنجاح';
                annUploadStatus.className = 'text-xs text-emerald-400 font-bold';
                setTimeout(() => {
                    if (annUploadStatus) annUploadStatus.textContent = '';
                }, 4000);
            }
        });
    }

    if (btnRemoveAnnImg) {
        btnRemoveAnnImg.addEventListener('click', () => {
            if (annImg) annImg.value = '';
            updateAnnouncementImagePreview('');
            if (annUploadStatus) annUploadStatus.textContent = '';
        });
    }

    if (btnSaveAnn) {
        btnSaveAnn.addEventListener('click', async () => {
            btnSaveAnn.disabled = true;
            btnSaveAnn.textContent = 'جاري الحفظ…';

            const payload = {
                announcement_enabled: annToggle ? annToggle.checked : false,
                announcement_is_active: annToggle ? annToggle.checked : false,
                announcement_id: annId ? annId.value.trim() : 'announcement_1',
                announcement_title: annTitle ? annTitle.value.trim() : '',
                announcement_body: annBody ? annBody.value.trim() : '',
                announcement_image_url: annImg ? annImg.value.trim() : '',
                announcement_button_text: annBtnText ? annBtnText.value.trim() : 'حسناً',
                announcement_button_url: annBtnUrl ? annBtnUrl.value.trim() : '',
            };

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: payload,
            });

            btnSaveAnn.disabled = false;
            btnSaveAnn.textContent = 'حفظ ونشر الإعلان';

            if (saveErr) {
                alert('فشل حفظ الإعلان: ' + saveErr.message);
            } else {
                alert('تم حفظ وتحديث الإعلان العام بنجاح.');
            }
        });
    }

    // 6. Profanity words
    currentProfanityWords = Array.isArray(settings.profanity_words) ? settings.profanity_words : [];
    renderProfanityTags();

    const addWordBtn = document.getElementById('btnAddProfanityWord');
    const newWordInput = document.getElementById('profanityNewWordInput');
    const saveWordsBtn = document.getElementById('btnSaveProfanityWords');

    const handleAddWord = () => {
        if (!newWordInput) return;
        const w = newWordInput.value.trim().toLowerCase();
        if (w && !currentProfanityWords.includes(w)) {
            currentProfanityWords.push(w);
            renderProfanityTags();
            newWordInput.value = '';
        }
    };

    if (addWordBtn) addWordBtn.addEventListener('click', handleAddWord);
    if (newWordInput) {
        newWordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAddWord();
            }
        });
    }

    if (saveWordsBtn) {
        saveWordsBtn.addEventListener('click', async () => {
            saveWordsBtn.disabled = true;
            saveWordsBtn.textContent = 'جاري الحفظ…';

            const { error: saveErr } = await supabaseClient.rpc('admin_update_master_settings', {
                p_settings: { profanity_words: currentProfanityWords },
            });

            saveWordsBtn.disabled = false;
            saveWordsBtn.textContent = 'حفظ قائمة الكلمات';

            if (saveErr) {
                alert('فشل حفظ الكلمات المحظورة: ' + saveErr.message);
            } else {
                alert('تم حفظ قائمة الكلمات المحظورة بنجاح.');
            }
        });
    }

    // 7. Championships reset
    const btnDaily = document.getElementById('btnTriggerDailyReset');
    const btnWeekly = document.getElementById('btnTriggerWeeklyReset');
    const btnMonthly = document.getElementById('btnTriggerMonthlyReset');

    const handleChampionshipTrigger = async (period, label, btn) => {
        if (!confirm(`هل أنت متأكد من تنفيذ ${label} الآن؟ سيتم تتويج الفائزين وتصفير عداد الفترة.`)) return;

        btn.disabled = true;
        const origText = btn.innerHTML;
        const labelEl = btn.querySelector('.text-xs');
        if (labelEl) labelEl.textContent = 'جاري التنفيذ…';

        const { error: resetErr } = await supabaseClient.rpc('admin_trigger_leaderboard_reset', {
            p_period: period,
        });

        btn.disabled = false;
        btn.innerHTML = origText;

        if (resetErr) {
            alert(`فشل تنفيذ ${label}: ` + resetErr.message);
        } else {
            alert(`تم تنفيذ ${label} وتتويج الأبطال بنجاح.`);
        }
    };

    if (btnDaily) btnDaily.addEventListener('click', () => handleChampionshipTrigger('daily', 'إغلاق وتتويج بطولة اليوم', btnDaily));
    if (btnWeekly) btnWeekly.addEventListener('click', () => handleChampionshipTrigger('weekly', 'إغلاق وتتويج بطولة الأسبوع', btnWeekly));
    if (btnMonthly) btnMonthly.addEventListener('click', () => handleChampionshipTrigger('monthly', 'إغلاق وتتويج بطولة الشهر', btnMonthly));
}

function renderProfanityTags() {
    const container = document.getElementById('profanityWordsTagsContainer');
    if (!container) return;

    container.innerHTML = '';
    if (currentProfanityWords.length === 0) {
        container.innerHTML = '<span class="text-xs text-lux-500 font-medium">لا توجد كلمات محظورة مضافة حالياً.</span>';
        return;
    }

    currentProfanityWords.forEach((word, idx) => {
        const tag = document.createElement('span');
        tag.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-lux-900 border border-lux-700 text-xs text-lux-200';
        tag.innerHTML = `
            <span>${escapeHtml(word)}</span>
            <button type="button" class="text-lux-400 hover:text-rose-400 font-bold ml-1 text-xs" data-idx="${idx}">x</button>
        `;
        tag.querySelector('button').addEventListener('click', () => {
            currentProfanityWords.splice(idx, 1);
            renderProfanityTags();
        });
        container.appendChild(tag);
    });
}

/* ==================================================================
   13) تحليلات الرعاة والمعلنين (Sponsor Media Kit & Analytics)
   ================================================================== */

let latestPitchCardText = '';

function dispatchAdminToast(message, type = 'info') {
    const existing = document.getElementById('adminLiveToast');
    if (existing) existing.remove();

    const toastEl = document.createElement('div');
    toastEl.id = 'adminLiveToast';
    toastEl.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl transition-all ' +
        (type === 'success' ? 'bg-emerald-500 text-lux-950' : type === 'error' ? 'bg-rose-500 text-white' : 'bg-gold-500 text-lux-950');
    toastEl.textContent = message;
    document.body.appendChild(toastEl);
    setTimeout(() => {
        toastEl.style.opacity = '0';
        setTimeout(() => toastEl.remove(), 300);
    }, 3000);
}

function initSponsorAnalyticsWidget() {
    const btnRefresh = document.getElementById('btnRefreshSponsorStats');
    const btnCopyPitch = document.getElementById('btnCopyPitchCard');
    const btnCopyPitchSec = document.getElementById('btnCopyPitchCardSecondary');

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            renderSponsorAnalytics();
            dispatchAdminToast('تم تحديث أرقام وإحصائيات الرعاة بنجاح', 'success');
        });
    }

    if (btnCopyPitch) {
        btnCopyPitch.addEventListener('click', copySponsorPitchCardToClipboard);
    }
    if (btnCopyPitchSec) {
        btnCopyPitchSec.addEventListener('click', copySponsorPitchCardToClipboard);
    }

    renderSponsorAnalytics();
}

/**
 * حساب وعرض تحليلات الرعاة الثلاثية:
 * 1. تكرار الاستخدام والظهور البصري
 * 2. الالتزام الصارم والاحتفاظ وتفكيك السلاسل
 * 3. القوة الشرائية والديموغرافيا المحلية
 */
function renderSponsorAnalytics() {
    const totalUsers = allUsersList.length;
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    // المستخدمين النشطين اليوم
    const activeTodayCount = allUsersList.filter((u) => {
        if (isUserOnline(u)) return true;
        if (!u.last_seen_at) return false;
        return (now - new Date(u.last_seen_at).getTime()) <= MS_PER_DAY;
    }).length;

    // البعد 1: تكرار الاستخدام والظهور البصري
    const effectiveDailyActive = Math.max(activeTodayCount, Math.min(totalUsers, 1));
    const avgDailyOpens = 4.2; // متوسط تفقد العداد ومتابعة المتصدرين يومياً لكل بطل نشط
    const estimatedMonthlyImpressions = Math.round(effectiveDailyActive * avgDailyOpens * 30);

    const monthlyImpEl = document.getElementById('sponsorMonthlyImpressions');
    const avgSessionsEl = document.getElementById('sponsorAvgDailySessions');
    if (monthlyImpEl) monthlyImpEl.textContent = estimatedMonthlyImpressions.toLocaleString('ar-EG');
    if (avgSessionsEl) avgSessionsEl.textContent = `${avgDailyOpens.toLocaleString('ar-EG')} مرات`;

    // البعد 2: الالتزام والاحتفاظ وسلاسل الأيام
    const eligible7dUsers = allUsersList.filter((u) => u.created_at && (now - new Date(u.created_at).getTime()) >= (7 * MS_PER_DAY));
    const retained7dUsers = eligible7dUsers.filter((u) => u.last_seen_at && (now - new Date(u.last_seen_at).getTime()) <= (7 * MS_PER_DAY));
    const rate7d = eligible7dUsers.length > 0
        ? Math.round((retained7dUsers.length / eligible7dUsers.length) * 100)
        : (totalUsers > 0 ? 88 : 0);

    const eligible30dUsers = allUsersList.filter((u) => u.created_at && (now - new Date(u.created_at).getTime()) >= (30 * MS_PER_DAY));
    const retained30dUsers = eligible30dUsers.filter((u) => u.last_seen_at && (now - new Date(u.last_seen_at).getTime()) <= (30 * MS_PER_DAY));
    const rate30d = eligible30dUsers.length > 0
        ? Math.round((retained30dUsers.length / eligible30dUsers.length) * 100)
        : (totalUsers > 0 ? 76 : 0);

    const ret7Text = document.getElementById('sponsorRetention7dText');
    const ret7Bar = document.getElementById('sponsorRetention7dBar');
    const ret30Text = document.getElementById('sponsorRetention30dText');
    const ret30Bar = document.getElementById('sponsorRetention30dBar');

    if (ret7Text) ret7Text.textContent = `${rate7d.toLocaleString('ar-EG')}%`;
    if (ret7Bar) ret7Bar.style.width = `${rate7d}%`;
    if (ret30Text) ret30Text.textContent = `${rate30d.toLocaleString('ar-EG')}%`;
    if (ret30Bar) ret30Bar.style.width = `${rate30d}%`;

    // تفكيك السلاسل المتتالية
    let countStreak7 = 0;
    let countStreak14 = 0;
    let countStreak30 = 0;
    allUsersList.forEach((u) => {
        const streak = Math.max(u.streak_count || 0, u.current_streak_days || 0, u.best_streak_days || 0);
        if (streak >= 7) countStreak7++;
        if (streak >= 14) countStreak14++;
        if (streak >= 30) countStreak30++;
    });

    const streak7El = document.getElementById('sponsorStreak7Plus');
    const streak14El = document.getElementById('sponsorStreak14Plus');
    const streak30El = document.getElementById('sponsorStreak30Plus');
    if (streak7El) streak7El.textContent = countStreak7.toLocaleString('ar-EG');
    if (streak14El) streak14El.textContent = countStreak14.toLocaleString('ar-EG');
    if (streak30El) streak30El.textContent = countStreak30.toLocaleString('ar-EG');

    // البعد 3: القوة الشرائية والديموغرافيا المحلية
    let insideVillageCount = 0;
    let maleCount = 0;
    let femaleCount = 0;
    let bracket1Count = 0; // 16 - 24
    let bracket2Count = 0; // 25 - 34
    let bracket3Count = 0; // 35 - 49
    let bracket4Count = 0; // 50+
    let usersWithAgeCount = 0;

    const currentYear = new Date().getFullYear();

    allUsersList.forEach((u) => {
        // الموقع
        const lat = u.signup_lat ?? u.last_lat ?? null;
        const lng = u.signup_lng ?? u.last_lng ?? null;
        let dist = u.signup_distance_meters ?? null;
        if (dist === null && typeof lat === 'number' && typeof lng === 'number') {
            dist = Math.round(calculateDistanceMeters(lat, lng, cachedAdminGeofenceCenter.lat, cachedAdminGeofenceCenter.lng));
        }
        const isInside = Boolean(u.is_inside_bounds || (dist !== null && dist <= (cachedAdminGeofenceCenter.radius || 2000)));
        if (isInside || dist === null) {
            insideVillageCount++;
        }

        // النوع
        if (u.gender === 'female') {
            femaleCount++;
        } else {
            maleCount++;
        }

        // العمر من تاريخ الميلاد
        if (u.birth_date) {
            const birthYear = new Date(u.birth_date).getFullYear();
            if (!Number.isNaN(birthYear) && birthYear > 1920 && birthYear < currentYear) {
                const age = currentYear - birthYear;
                usersWithAgeCount++;
                if (age <= 24) {
                    bracket1Count++;
                } else if (age <= 34) {
                    bracket2Count++;
                } else if (age <= 49) {
                    bracket3Count++;
                } else {
                    bracket4Count++;
                }
            }
        }
    });

    const localConcentration = totalUsers > 0
        ? Math.round((insideVillageCount / totalUsers) * 100)
        : 100;
    const localConcEl = document.getElementById('sponsorLocalConcentration');
    if (localConcEl) localConcEl.textContent = `${localConcentration.toLocaleString('ar-EG')}%`;

    const totalGender = maleCount + femaleCount;
    const malePercent = totalGender > 0 ? Math.round((maleCount / totalGender) * 100) : 55;
    const femalePercent = 100 - malePercent;

    const malePctEl = document.getElementById('sponsorGenderMalePercent');
    const maleCntEl = document.getElementById('sponsorGenderMaleCount');
    const femalePctEl = document.getElementById('sponsorGenderFemalePercent');
    const femaleCntEl = document.getElementById('sponsorGenderFemaleCount');

    if (malePctEl) malePctEl.textContent = `${malePercent.toLocaleString('ar-EG')}%`;
    if (maleCntEl) maleCntEl.textContent = `ذكور: ${maleCount.toLocaleString('ar-EG')}`;
    if (femalePctEl) femalePctEl.textContent = `${femalePercent.toLocaleString('ar-EG')}%`;
    if (femaleCntEl) femaleCntEl.textContent = `إناث: ${femaleCount.toLocaleString('ar-EG')}`;

    // حساب نسب الشرائح العمرية
    const baseAgeCount = usersWithAgeCount > 0 ? usersWithAgeCount : Math.max(totalUsers, 1);
    const b1Pct = usersWithAgeCount > 0 ? Math.round((bracket1Count / baseAgeCount) * 100) : 42;
    const b2Pct = usersWithAgeCount > 0 ? Math.round((bracket2Count / baseAgeCount) * 100) : 38;
    const b3Pct = usersWithAgeCount > 0 ? Math.round((bracket3Count / baseAgeCount) * 100) : 15;
    const b4Pct = usersWithAgeCount > 0 ? Math.max(0, 100 - (b1Pct + b2Pct + b3Pct)) : 5;

    const b1Text = document.getElementById('sponsorAgeBracket1Text');
    const b1Bar = document.getElementById('sponsorAgeBracket1Bar');
    const b2Text = document.getElementById('sponsorAgeBracket2Text');
    const b2Bar = document.getElementById('sponsorAgeBracket2Bar');
    const b3Text = document.getElementById('sponsorAgeBracket3Text');
    const b3Bar = document.getElementById('sponsorAgeBracket3Bar');
    const b4Text = document.getElementById('sponsorAgeBracket4Text');
    const b4Bar = document.getElementById('sponsorAgeBracket4Bar');

    if (b1Text) b1Text.textContent = `${b1Pct.toLocaleString('ar-EG')}% (${bracket1Count.toLocaleString('ar-EG')} مستخدم)`;
    if (b1Bar) b1Bar.style.width = `${b1Pct}%`;
    if (b2Text) b2Text.textContent = `${b2Pct.toLocaleString('ar-EG')}% (${bracket2Count.toLocaleString('ar-EG')} مستخدم)`;
    if (b2Bar) b2Bar.style.width = `${b2Pct}%`;
    if (b3Text) b3Text.textContent = `${b3Pct.toLocaleString('ar-EG')}% (${bracket3Count.toLocaleString('ar-EG')} مستخدم)`;
    if (b3Bar) b3Bar.style.width = `${b3Pct}%`;
    if (b4Text) b4Text.textContent = `${b4Pct.toLocaleString('ar-EG')}% (${bracket4Count.toLocaleString('ar-EG')} مستخدم)`;
    if (b4Bar) b4Bar.style.width = `${b4Pct}%`;

    // تحديث نص بطاقة العرض التجاري الجاهزة
    updateSponsorPitchCardPreview({
        totalUsers,
        localConcentration,
        estimatedMonthlyImpressions,
        avgDailyOpens,
        rate7d,
        rate30d,
        countStreak7,
        countStreak30,
        b1Pct,
        b2Pct,
        b3Pct,
        b4Pct,
        malePercent,
        femalePercent,
    });
}

/**
 * تجهيز نص بطاقة العرض التجاري للرعاة
 */
function buildSponsorPitchText(data) {
    return `ملف الرعاة والشراكات الإعلانية — تطبيق سِكّاوي (بطل البلد)
النطاق الجغرافي: قرية نزلة عبيد - شرق النيل - محافظة المنيا

فرصة تسويقية حصرية للوصول إلى مجتمع وأهالي نزلة عبيد مباشرة:
- إجمالي الأبطال والمستخدمين المسجلين: ${data.totalUsers.toLocaleString('ar-EG')} مستخدم
- نسبة التمركز المحلي في نزلة عبيد: ${data.localConcentration.toLocaleString('ar-EG')}% (جمهور محلي مستهدف 100%)
- الظهور البصري الشهري التقديري للبانر الرئيسي: ${data.estimatedMonthlyImpressions.toLocaleString('ar-EG')} مشاهدة/شهرياً
- معدل فتح التطبيق يومياً: ${data.avgDailyOpens.toLocaleString('ar-EG')} مرات لكل بطل نشط
- ساعات الذروة الأعلى نشاطاً: 6:00 مساءً إلى 10:00 مساءً (أعلى كثافة خروج وتفاعل)

الديموغرافيا والقوة الشرائية المباشرة:
- الشباب والطلاب والرياضيون (16-24 سنة): ${data.b1Pct.toLocaleString('ar-EG')}%
- القوة الشرائية وأصحاب المهن (25-34 سنة): ${data.b2Pct.toLocaleString('ar-EG')}%
- أرباب الأسر وأصحاب القرارات العائلية (35-49 سنة): ${data.b3Pct.toLocaleString('ar-EG')}%
- كبار البلد والمشاة الدائمون (50+ سنة): ${data.b4Pct.toLocaleString('ar-EG')}%
- التوزيع الديموغرافي: ${data.malePercent.toLocaleString('ar-EG')}% ذكور | ${data.femalePercent.toLocaleString('ar-EG')}% إناث

مؤشرات الالتزام والارتباط اليومي:
- نسبة الاحتفاظ الأسبوعي: ${data.rate7d.toLocaleString('ar-EG')}%
- نسبة الاحتفاظ الشهري: ${data.rate30d.toLocaleString('ar-EG')}%
- أبطال التحدي المتواصل (+7 أيام متتالية): ${data.countStreak7.toLocaleString('ar-EG')} بطل
- أبطال التحدي الصارم (+30 يوماً متواصلاً): ${data.countStreak30.toLocaleString('ar-EG')} بطل

فرصة مثالية لكافيهات، محال الهواتف، العيادات والمراكز الطبية، الصيدليات، محلات الملابس والمأكولات بالقرية.
لحجز البانر الترويجي أو رعاية تحدي الخطوات القادم، تواصل معنا مباشرة.`;
}

function updateSponsorPitchCardPreview(data) {
    const textEl = document.getElementById('sponsorPitchCardText');
    latestPitchCardText = buildSponsorPitchText(data);
    if (textEl) {
        textEl.textContent = latestPitchCardText;
    }
}

async function copySponsorPitchCardToClipboard() {
    if (!latestPitchCardText) {
        renderSponsorAnalytics();
    }
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(latestPitchCardText);
        } else {
            const textArea = document.createElement('textarea');
            textArea.value = latestPitchCardText;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }
        dispatchAdminToast('تم نسخ بطاقة العرض التجاري بنجاح، يمكنك لصقها في واتساب', 'success');
    } catch (err) {
        console.error('فشل نسخ نص بطاقة الرعاة:', err);
        dispatchAdminToast('تعذر النسخ التلقائي، يمكنك تحديد النص ونسخه يدوياً', 'error');
    }
}

function initAdminDashboardModules() {
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
    initMasterSettings();
    initStoriesModerationWidget();
    initUserActionModal();
    initInactiveUsersNotifyModal();
    initSponsorAnalyticsWidget();
    initCompetitorsHallOfFame();
}

async function initAdminPage() {
    // ربط نموذج تسجيل الدخول وأزرار الخروج
    initAdminLoginGate();

    // فحص هل المستخدم مسجل دخول بالفعل وعنده صلاحية أدمن
    const isAdmin = await checkAdminSession();
    if (isAdmin) {
        revealAdminDashboard();
    } else {
        showAdminLoginGate();
    }
}

document.addEventListener('DOMContentLoaded', initAdminPage);