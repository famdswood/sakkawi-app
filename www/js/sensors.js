/* ==================================================================
   سِكّاوي | js/sensors.js
   ------------------------------------------------------------------
   (قرار منتج) الاعتماد بقى 100% على حساس الخطوات الأصلي بالموبايل
   (TYPE_STEP_COUNTER عبر StepCounterForegroundService.java + StepCounterPlugin) -
   نفس الحساس اللي Google Fit وتطبيقات اللياقة التانية بتقرا منه. اتشال
   نهائياً أي "بديل" تاني (كان فيه هنا قبل كده خوارزمية Peak Detection
   على حساس التسارع الخام عبر devicemotion، تقريبية وبتدّي أرقام مختلفة
   عن Fit) - عشان نختصر أي مصدر تاني ممكن يسبب تضارب/تضاعف في العدد،
   ونضمن إن أي رقم ظاهر في التطبيق مطابق لنفس مصدر تطبيقات الموبايل
   الفعلية بالظبط.

   المسؤولية الوحيدة لهذا الملف دلوقتي:
   1) إدارة حالة "خطوات اليوم" محليًا في localStorage (Auto Save، فحص
      يوم جديد/Daily Reset) - راجع loadPersistedDailyState() تحت.
   2) مزامنة الرقم ده مع StepCounterPlugin الأصلي (الجسر لـ
      StepCounterForegroundService.java) طول ما التطبيق شغّال جوه
      Capacitor - راجع syncFromNativeStepCounter() تحت.
   3) دمج (Reconcile) الرقم المحلي مع رقم Supabase لو المستخدم فتح
      التطبيق من جهاز جديد بنفس الحساب - راجع reconcileWithServerSteps().

   التطبيق ده دايمًا شغّال جوه Capacitor (APK حقيقي) - مفيش نسخة
   PWA/متصفح بتعتمد على الملف ده في الإنتاج، فمفيش داعي لأي مسار بديل
   هنا أصلاً.
   ================================================================== */

/**
 * مفتاح التخزين في localStorage. معزول لكل مستخدم على حدة لمنع تسريب
 * الخطوات أو الأرشيف أو الأرقام القياسية بين الحسابات على نفس الجهاز:
 * - مستخدم مسجل: saa_baladi_step_tracker_v2_user_<userId>
 * - زائر: saa_baladi_step_tracker_v2_guest
 */
const STORAGE_KEY_PREFIX = 'saa_baladi_step_tracker_v2_';

function getStorageKey(userId) {
    return userId ? `${STORAGE_KEY_PREFIX}user_${userId}` : `${STORAGE_KEY_PREFIX}guest`;
}

/* ------------------------------------------------------------------
   حالة التطبيق الداخلية (State) - مفيش داعي تتعدل يدوياً
   ------------------------------------------------------------------ */
const ACTIVE_USER_ID_STORAGE_KEY = 'saa_baladi_active_user_id';

let stepCount = 0;
let currentDayKey = null;        // تاريخ اليوم الحالي (YYYY-MM-DD) اللي العداد بيتحسب عليه
let stepsHistory = {};           // أرشيف خطوات الأيام السابقة { 'YYYY-MM-DD': steps }
let currentOwnerUserId = null;   // معرف المستخدم الحالي
try {
    currentOwnerUserId = localStorage.getItem(ACTIVE_USER_ID_STORAGE_KEY) || null;
} catch (_) {}
let lastNativeStepsSeen = 0;     // آخر قراءة لحساس الجهاز لهذا المستخدم لمنع تسريب خطوات الحسابات الأخرى
let resetNativeBaselineOnNextSync = false; // علم إعادة ضبط الأساس عند تبديل الحساب

/**
 * إرجاع تاريخ اليوم الحالي بصيغة YYYY-MM-DD بالتوقيت المحلي للجهاز
 * (مش UTC، عشان مايحصلش فرق ساعات قرب منتصف الليل)
 */
function getTodayKey() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * حفظ الحالة الحالية (تاريخ اليوم + عدد خطواته + أرشيف الأيام
 * السابقة) في localStorage للحساب النشط الحالي فقط.
 */
function persistDailyState() {
    try {
        const key = getStorageKey(currentOwnerUserId);
        localStorage.setItem(key, JSON.stringify({
            date: currentDayKey,
            steps: stepCount,
            history: stepsHistory,
            ownerUserId: currentOwnerUserId,
            lastNative: lastNativeStepsSeen
        }));
        if (currentOwnerUserId) {
            localStorage.setItem(ACTIVE_USER_ID_STORAGE_KEY, currentOwnerUserId);
        } else {
            localStorage.removeItem(ACTIVE_USER_ID_STORAGE_KEY);
        }
    } catch (err) {
        console.warn('[sensors.js] تعذر حفظ خطوات اليوم في localStorage:', err);
    }
}

/**
 * تُستدعى عند بدء التشغيل وعند تبديل الحساب: تقرأ حالة الحساب الحالي
 * من مفتاحه المعزول وتقرر إحنا مكملين على نفس اليوم ولا لازم نفتح يوم جديد.
 */
function loadPersistedDailyState() {
    const todayKey = getTodayKey();
    let saved = null;

    try {
        const key = getStorageKey(currentOwnerUserId);
        const raw = localStorage.getItem(key);
        if (raw) saved = JSON.parse(raw);
    } catch (err) {
        console.warn('[sensors.js] تعذر قراءة بيانات الخطوات المحفوظة:', err);
    }

    if (!saved || typeof saved !== 'object') {
        currentDayKey = todayKey;
        stepCount = 0;
        stepsHistory = {};
        lastNativeStepsSeen = 0;
        persistDailyState();
        return;
    }

    stepsHistory = saved.history && typeof saved.history === 'object' ? saved.history : {};
    lastNativeStepsSeen = Number(saved.lastNative) || 0;

    if (saved.date === todayKey) {
        currentDayKey = todayKey;
        stepCount = Number(saved.steps) || 0;
    } else {
        if (saved.date) {
            stepsHistory[saved.date] = Number(saved.steps) || 0;
        }
        currentDayKey = todayKey;
        stepCount = 0;
        lastNativeStepsSeen = 0;
    }

    persistDailyState();
}

/**
 * فحص دفاعي مهم: لو التطبيق فاضل فاتح عدّى منتصف الليل، أو تم استئنافه بعد
 * منتصف الليل، نتأكد إننا لسه في نفس اليوم المحفوظ، وإلا بنأرشف خطوات اليوم
 * السابق، ونصفّر العداد، ونحفظ الحالة محلياً، ونطلق حدث 'sensors:day-reset'
 * لـ app.js عشان يصفّر العداد في الواجهة فوراً.
 */
export function ensureStillSameDay() {
    const todayKey = getTodayKey();
    if (todayKey !== currentDayKey) {
        const previousDay = currentDayKey;
        if (currentDayKey) {
            stepsHistory[currentDayKey] = stepCount;
        }
        currentDayKey = todayKey;
        stepCount = 0;
        lastNativeStepsSeen = 0;
        persistDailyState();
        document.dispatchEvent(new CustomEvent('sensors:day-reset', {
            detail: { date: todayKey, previousDay }
        }));
        return true;
    }
    return false;
}

/**
 * إرجاع أرشيف خطوات الأيام السابقة { 'YYYY-MM-DD': steps }
 * (اليوم الحالي مش موجود فيه لحد ما يخلص ويتأرشف)
 */
export function getStepsHistory() {
    return { ...stepsHistory };
}

/**
 * تنبيه المستخدم بمشكلة في مصدر الخطوات الأصلي (إذن الـ Activity
 * Recognition اترفض، أو تعذر التواصل مع الـ Plugin الأصلي..إلخ).
 * بيبعت الرسالة بطريقتين:
 * 1) CustomEvent 'sensors:warning' - عشان لو التطبيق عايز يعرضها
 *    بشكل مخصص (Toast/Modal) بدل الـ alert الافتراضي.
 * 2) alert() مباشر - كضمان إن المستخدم شايف التنبيه فوراً حتى لو
 *    مفيش حد مستني على الحدث لسه.
 * @param {string} message - نص التنبيه بالعربي
 * @param {string} reason - كود مختصر لسبب المشكلة (للاستخدام البرمجي)
 */
function notifySensorUnavailable(message, reason) {
    console.warn(`[sensors.js] ${reason}: ${message}`);
    document.dispatchEvent(new CustomEvent('sensors:warning', {
        detail: { message, reason }
    }));
    if (typeof window.alert === 'function') {
        window.alert(message);
    }
}

/**
 * إرجاع عدد الخطوات الحالي المسجّل في هذه الجلسة
 */
export function getStepsCount() {
    return stepCount;
}

/**
 * (إصلاح - باج حقيقي) دمج عدد خطوات اليوم القادم من صف البروفايل في
 * Supabase (عمود daily_steps) مع العداد المحلي هنا. الهدف: لو المستخدم
 * سجّل خطوات النهاردة من جهاز/متصفح تاني بنفس الحساب، وبعدين فتح
 * التطبيق من جهاز جديد (localStorage فاضي هنا)، العداد يبدأ من نفس
 * تقدمه الحقيقي بدل ما يبدأ من صفر.
 * بتتنادى من profiles.js أول ما بيانات البروفايل توصل بعد تسجيل
 * الدخول (loadAndRenderRealProfile).
 * بنـ"دمج" (ناخد الأكبر بين الاتنين) بدل الاستبدال المباشر، عشان لو
 * كان المستخدم مشى شوية على *نفس* الجهاز ده قبل ما بيانات البروفايل
 * توصل من الشبكة (اللي ممكن تاخد ثانية أو اتنين)، الخطوات دي متتفقدش.
 * مهم: الدالة دي بتبعت حدث مختلف تماماً ('sensors:steps-resynced')
 * مش 'sensors:steps-update' العادي بتاع الحساس الحقيقي - عشان
 * profiles.js ميفهمهاش غلط كـ"خطوات جديدة" ويحاول يبعتها تاني لـ
 * Supabase (ده كان هيسبب تضاعف حقيقي في total_steps/points في كل مرة
 * يتفتح فيها جهاز جديد لنفس الحساب - الخطوات دي أصلاً مصدرها Supabase
 * نفسه، مش حركة جديدة لسه متسجلتش).
 * @param {number} serverDailySteps - قيمة daily_steps من صف البروفايل
 */
export function forceResetDailySteps() {
    stepCount = 0;
    lastNativeStepsSeen = 0;
    resetNativeBaselineOnNextSync = true;
    persistDailyState();

    document.dispatchEvent(new CustomEvent('sensors:steps-resynced', {
        detail: { steps: 0, date: currentDayKey, forced: true }
    }));
}

document.addEventListener('sensors:force-reset', () => {
    forceResetDailySteps();
});

export function reconcileWithServerSteps(serverDailySteps, isForcedReset = false) {
    if (typeof serverDailySteps !== 'number' || !Number.isFinite(serverDailySteps)) return;
    if (isForcedReset) {
        forceResetDailySteps();
        return;
    }
    if (serverDailySteps <= stepCount) return; // العداد المحلي أصلاً مساوي أو أكبر - مفيش داعي نعمل حاجة

    stepCount = serverDailySteps;
    persistDailyState();

    document.dispatchEvent(new CustomEvent('sensors:steps-resynced', {
        detail: { steps: stepCount, date: currentDayKey }
    }));
}

/**
 * (جديد) نفس فكرة reconcileWithServerSteps بالظبط بس للرقم القياسي
 * (best_daily_steps من صف البروفايل) مش لخطوات اليوم الحالي. الرقم
 * القياسي المحلي هنا (أرشيف stepsHistory) بتاع الجهاز ده بس، لكن
 * السيرفر عنده أعلى رقم وصله المستخدم من *كل* أجهزته - فبنجيب الأكبر
 * بين الاتنين وبنبعت حدث منفصل 'sensors:best-steps-resynced' عشان
 * app.js يحدّث عرض "رقمك القياسي" بيه.
 * (بتتنادى من profiles.js في نفس مكان reconcileWithServerSteps، بعد
 * ما syncActiveUser تتأكد أول إن الحساب صح ومفيش تسريب من حساب سابق)
 * @param {number} serverBestSteps - قيمة best_daily_steps من صف البروفايل
 */
export function reconcileServerBestSteps(serverBestSteps) {
    const safeServer = (typeof serverBestSteps === 'number' && Number.isFinite(serverBestSteps))
        ? Math.max(0, serverBestSteps)
        : 0;

    const localBest = Object.values(stepsHistory).reduce(
        (max, value) => Math.max(max, Number(value) || 0),
        0
    );
    const combinedBest = Math.max(localBest, safeServer);

    document.dispatchEvent(new CustomEvent('sensors:best-steps-resynced', {
        detail: { bestSteps: combinedBest }
    }));
}

/**
 * تصفير عداد الخطوات يدوياً (مثلاً زرار "إعادة ضبط" لو احتجته لاحقاً)
 * بيصفّر ويحفظ الحالة فوراً في localStorage - من غير ما يأرشف اليوم
 * الحالي (ده تصفير صريح مش Daily Reset تلقائي)
 */
export function resetSteps() {
    stepCount = 0;
    persistDailyState();
}

/**
 * بتتنادى بمجرد ما نعرف مين المستخدم الحالي (بعد تسجيل دخول، أو null بعد خروج/وضع زائر).
 * كل حساب معزول تماماً بمفتاح تخزين منفصل وbaseline حساس مستقل، مما يمنع تسريب
 * أي خطوات أو تاريخ أو أرقام قياسية بين الحسابات على نفس الجهاز.
 * @param {string|null} userId
 */
export function syncActiveUser(userId) {
    const normalizedId = userId || null;
    if (currentOwnerUserId === normalizedId) return;

    // حفظ حالة المستخدم السابق قبل التبديل
    const previousUserId = currentOwnerUserId;
    persistDailyState();

    currentOwnerUserId = normalizedId;
    loadPersistedDailyState();

    // مهم جدا: لا نفعّل resetNativeBaselineOnNextSync إلا إذا كان تبديلا حقيقيا بين حسابين مختلفين أثناء التشغيل
    // أما في أول فتح للتطبيق أو عند استرجاع الجلسة لنفس المستخدم، فلا نلغي الخطوات المقطوعة أثناء إغلاق التطبيق!
    const isActualAccountSwitch = previousUserId !== null && previousUserId !== normalizedId;
    if (isActualAccountSwitch) {
        resetNativeBaselineOnNextSync = true;
    } else {
        resetNativeBaselineOnNextSync = false;
    }

    // إشعار فوري للواجهة بالخطوات الحالية لهذا المستخدم
    document.dispatchEvent(new CustomEvent('sensors:steps-update', {
        detail: { steps: stepCount, delta: 0, date: currentDayKey, source: 'account-switch' }
    }));
}

/* ==================================================================
   Auto Start
   ------------------------------------------------------------------
   بمجرد ما الملف ده يتحمّل (import)، بنقرا/بنهيّئ حالة اليوم من
   localStorage بس (Daily Reset Check) - مفيش أي "تشغيل تتبّع" هنا
   خالص. مصدر الخطوات الوحيد هو الحساس الأصلي عبر
   syncFromNativeStepCounter() تحت، اللي بتتنادى تلقائيًا من أحداث
   دورة حياة الصفحة (DOMContentLoaded/visibilitychange..إلخ) في آخر
   الملف - مش من هنا.
   ================================================================== */
function autoInit() {
    loadPersistedDailyState();
}

/* ==================================================================
   [جديد] تكامل مع StepCounter Plugin الأصلي (تتبّع الخلفية الحقيقي)
   ------------------------------------------------------------------
   بيشتغل بس جوه تطبيق Capacitor الحقيقي (مش في المتصفح وقت التطوير).
   بيدمج عدد الخطوات اللي اتسجل من الحساس الأصلي في الخلفية مع نفس
   نظام localStorage (STORAGE_KEY) اللي باقي التطبيق بيقرا منه، عشان
   الليدربورد ومزامنة Supabase يشتغلوا زي ما هما بالظبط من غير تعديل.
   ================================================================== */

/**
 * بيسأل الـ Plugin الأصلي "كام خطوة اتسجلت من الحساس الحقيقي؟"، وبيدمج
 * الرقم ده مع الحالة المحلية (stepCount) لو الرقم الجديد أكبر (الحساس
 * الأصلي هو المصدر الأدق دايمًا وقت التشغيل جوه APK حقيقي).
 */
// (إصلاح - باج Race Condition حقيقي خطير) الدالة دي بتتنادى من 4 أماكن
// مختلفة (DOMContentLoaded، geofence:guest-mode-change، visibilitychange،
// والبولينج الدوري كل 4 ثواني) - ومحتواها فيه كذا await (requestPermissions،
// startTracking، getStepsToday). لو نداءين اتصادفوا قريبين من بعض (وارد
// جدًا وقت فتح التطبيق لأول مرة، خصوصًا لحساب جديد لسه بيتسجل)، النداء
// التاني كان بيبدأ *قبل* ما الأول يخلص ويحدّث stepCount - فالاتنين
// بيشوفوا نفس القيمة القديمة، وبيحسبوا نفس الـ delta، وبيبعتوا حدث
// 'sensors:steps-update' مرتين بنفس الرقم = مضاعفة حقيقية للخطوات (زي
// ما لاحظنا بالظبط: 49 خطوة حقيقية بقت 98 من غير أي حركة إضافية).
// الحل: قفل بسيط - لو فيه نداء شغّال بالفعل، أي نداء جديد يرفض فورًا
// (مش هيضيع حاجة، البولينج الدوري أو أي حدث تاني هيعيد المحاولة بعد
// شوية على أي حال)
let isSyncingFromNative = false;

export async function syncFromNativeStepCounter() {
    ensureStillSameDay();
    if (!window.Capacitor?.isNativePlatform?.()) return;
    if (isSyncingFromNative) return; // فيه مزامنة شغّالة بالفعل - نرفض عشان نمنع التضاعف
    isSyncingFromNative = true;

    // (ملاحظة): العداد المحلي يعمل للأعضاء وللزوار على السواء لاحتساب
    // الخطوات الحقيقية من الحساس على الجهاز محلياً في الوقت الفعلي.

    try {
        const { StepCounter } = Capacitor.Plugins;

        // نتأكد الإذن متاخد الأول (على أندرويد 10+ لازم إذن صريح)
        const permResult = await StepCounter.requestPermissions();
        if (!permResult?.granted) {
            notifySensorUnavailable(
                'تم رفض إذن التعرف على النشاط (Activity Recognition). محتاج توافق عليه عشان عداد الخطوات يشتغل حتى والتطبيق مقفول.',
                'native-permission-denied'
            );
            return;
        }

        // نشغّل الخدمة الأمامية (لو شغّالة أصلاً، النداء ده آمن ومفيهوش أي تأثير)
        await StepCounter.startTracking();

        // [جديد] نتأكد إن التطبيق مستثنى من "توفير البطارية" - لو
        // لأ، بنبعت تنبيه للواجهة (مش alert مباشر زي notifySensorUnavailable
        // عشان ده مش خطأ فوري بيمنع العداد من الشغل دلوقتي، لكنه سبب
        // شائع جدًا إن أجهزة شاومي/هواوي/أوبو..إلخ توقف الخدمة بعد شوية
        // في الخلفية - فبنسيب app.js يقرر يعرضه إزاي (بانر/زرار بدل
        // ما نقاطع المستخدم بـ alert كل مرة يفتح فيها التطبيق)
        checkBatteryOptimizationStatus();

        // [جديد] نتأكد كمان هل الجهاز ده من الشركات المعروفة بتقييد
        // Autostart بشدة (شاومي/هواوي/أوبو/فيفو..إلخ) - ده تقييد أخطر
        // من توفير البطارية العادي لأنه بيقفل الـ Foreground Service
        // بتاعنا تمامًا حتى لو مستثنى من توفير البطارية أصلاً
        checkAutostartStatus();

        // نجيب عدد خطوات اليوم من الحساس الأصلي
        const { steps: nativeSteps, date: nativeDate } = await StepCounter.getStepsToday();

        ensureStillSameDay();

        // نحتسب الخطوات اليومية المأخوذة من الحساس الأصلي
        if (nativeDate === currentDayKey && typeof nativeSteps === 'number' && Number.isFinite(nativeSteps)) {
            if (resetNativeBaselineOnNextSync) {
                // تبديل صريح بين حسابين مختلفين أثناء التشغيل - يبدأ الحساب الجديد بعدّ الخطوات من هذه النقطة
                lastNativeStepsSeen = nativeSteps;
                resetNativeBaselineOnNextSync = false;
                persistDailyState();
            } else if (nativeSteps < lastNativeStepsSeen) {
                // إعادة تشغيل الجهاز أو إعادة تعيين التاريخ
                lastNativeStepsSeen = nativeSteps;
                persistDailyState();
            } else {
                // الحالة الطبيعية: حساب جديد، فتح بعد مشوار في الخلفية، أو حركة لحظية
                let delta = 0;
                if (lastNativeStepsSeen > 0 && nativeSteps >= lastNativeStepsSeen) {
                    delta = nativeSteps - lastNativeStepsSeen;
                } else if (lastNativeStepsSeen <= 0) {
                    // أول قراءة على هذا الحساب أو بعد فتح التطبيق
                    delta = Math.max(0, nativeSteps - stepCount);
                }

                lastNativeStepsSeen = nativeSteps;

                // تحديث رصيد الخطوات: نتأكد أن stepCount يعكس على الأقل خطوات الحساس الأصلي لليوم
                const newStepCount = Math.max(stepCount + delta, nativeSteps);
                const stepCountChanged = newStepCount !== stepCount;
                stepCount = newStepCount;

                persistDailyState();

                if (stepCountChanged || delta > 0) {
                    document.dispatchEvent(new CustomEvent('sensors:steps-update', {
                        detail: { steps: stepCount, delta: Math.max(delta, 0), date: currentDayKey, source: 'native' }
                    }));
                }
            }
        }
    } catch (err) {
        console.warn('[sensors.js] تعذر المزامنة مع StepCounter الأصلي:', err);
    } finally {
        // (إصلاح - باج Race Condition) لازم نفك القفل دايمًا هنا - سواء
        // نجحت المزامنة، فشلت، أو اترفضت مبكرًا (return جوه الـ try زي
        // حالة رفض الإذن) - عشان أي نداء جديد بعد كده (من البولينج أو
        // أي حدث تاني) يقدر يشتغل عادي
        isSyncingFromNative = false;
    }
}

/**
 * [جديد] بيسأل الـ Plugin الأصلي هل التطبيق مستثنى من "توفير البطارية"
 * ولا لأ، وبيبعت حدث 'sensors:battery-optimization-needed' للواجهة لو
 * لأ (عشان تعرض بانر/زرار مثلاً في صفحة الإعدادات - شوف
 * requestBatteryOptimizationExemption تحت للزرار الفعلي اللي بيستدعيه
 * المستخدم). ده مهم خصوصًا على أجهزة شاومي/هواوي/أوبو/فيفو اللي بتقفل
 * الـ Foreground Service بعد شوية في الخلفية لو التطبيق مش مستثنى، حتى
 * لو الـ Boot Receiver شغّله صح من الأول (شوف نقاش "هل التعديل ده
 * هيتناسب مع كل أجهزة أندرويد؟" في المحادثة).
 * ما بتعملش حاجة على المتصفح/iOS (مفيش المفهوم ده أصلاً غير أندرويد).
 * @returns {Promise<boolean|null>} true/false لو أندرويد ورد بنجاح، null لو مش قابل للتطبيق (مش أندرويد أو الـ API فشل)
 */
export async function checkBatteryOptimizationStatus() {
    if (!window.Capacitor?.isNativePlatform?.()) return null;

    try {
        const { StepCounter } = Capacitor.Plugins;
        const { ignoring } = await StepCounter.isIgnoringBatteryOptimizations();

        if (ignoring === false) {
            document.dispatchEvent(new CustomEvent('sensors:battery-optimization-needed', {
                detail: {
                    message: 'عشان عداد الخطوات يفضل شغّال بدقة والتطبيق مقفول، لازم تستثنيه من "توفير البطارية" في إعدادات جهازك.'
                }
            }));

            // طلب استثناء توفير البطارية تلقائيًا لأول مرة لضمان استمرار عمل الخدمة في الخلفية والجيب
            const PROMPT_KEY = 'sakkawi_battery_opt_prompted_v2';
            if (!localStorage.getItem(PROMPT_KEY)) {
                localStorage.setItem(PROMPT_KEY, '1');
                try {
                    await StepCounter.requestIgnoreBatteryOptimizations();
                } catch (_) {}
            }
        }

        return ignoring;
    } catch (err) {
        console.warn('[sensors.js] تعذر التحقق من حالة توفير البطارية:', err);
        return null;
    }
}

/**
 * [جديد] بتتنادى من زرار في الواجهة (مثلاً في صفحة "إعدادات الحساب")
 * بعد ما المستخدم يشوف تنبيه 'sensors:battery-optimization-needed' -
 * بتفتح نافذة موافقة أندرويد الرسمية لاستثناء التطبيق من توفير
 * البطارية. لازم تتنادى من داخل إيماءة مستخدم حقيقية (ضغطة زرار) زي
 * أي نافذة نظام تانية، مش تلقائيًا من غير تفاعل المستخدم.
 * @returns {Promise<{requested: boolean, reason?: string}>}
 */
export async function requestBatteryOptimizationExemption() {
    if (!window.Capacitor?.isNativePlatform?.()) {
        return { requested: false, reason: 'not-native-platform' };
    }

    try {
        const { StepCounter } = Capacitor.Plugins;
        return await StepCounter.requestIgnoreBatteryOptimizations();
    } catch (err) {
        console.warn('[sensors.js] تعذر فتح نافذة استثناء توفير البطارية:', err);
        return { requested: false, reason: 'plugin-call-failed' };
    }
}

/**
 * [جديد] بيسأل الـ Plugin الأصلي هل الجهاز من الشركات المعروفة بتقييد
 * "Autostart" بشدة (شاومي/هواوي/هونر/أوبو/ريلمي/فيفو/ميزو..إلخ)، وبيبعت
 * حدث 'sensors:autostart-needed' للواجهة لو أيوه (عشان تعرض بانر/زرار
 * في صفحة الإعدادات - شوف requestAutostartPermission تحت للزرار الفعلي).
 * على عكس checkBatteryOptimizationStatus، مفيش API رسمي نتأكد بيه إن
 * المستخدم فعّل الخيار فعلاً - فبنعتمد بس على "الشركة دي معروفة إنها
 * بتقيّد" كإشارة، والبانر بيفضل ظاهر (المستخدم يقدر يقفله بنفسه لو
 * حابب، أو نضيف "متعرضهاش تاني" لاحقًا لو حبينا).
 * ما بتعملش حاجة على المتصفح/iOS ولا على أجهزة أندرويد "القياسية"
 * (Pixel/Android One/سامسونج) اللي مفيهاش المفهوم ده أصلاً.
 * @returns {Promise<{manufacturer: string, restrictive: boolean}|null>}
 */
export async function checkAutostartStatus() {
    if (!window.Capacitor?.isNativePlatform?.()) return null;

    try {
        const { StepCounter } = Capacitor.Plugins;
        const { manufacturer, restrictive } = await StepCounter.getManufacturerInfo();

        if (restrictive) {
            document.dispatchEvent(new CustomEvent('sensors:autostart-needed', {
                detail: {
                    manufacturer,
                    message: `جهازك (${manufacturer}) بيوقف تطبيقات كتير في الخلفية إلا لو فعّلت "التشغيل التلقائي" (Autostart) ليها يدويًا - عشان عداد الخطوات يفضل شغّال ودقيق زي Fit حتى والتطبيق مقفول.`
                }
            }));
        }

        return { manufacturer, restrictive };
    } catch (err) {
        console.warn('[sensors.js] تعذر التحقق من حالة Autostart:', err);
        return null;
    }
}

/**
 * [جديد] بتتنادى من زرار في الواجهة (صفحة "إعدادات الحساب") بعد ما
 * المستخدم يشوف تنبيه 'sensors:autostart-needed' - بتحاول تفتح شاشة
 * "Autostart" الخاصة بالشركة المصنّعة مباشرة، أو شاشة تفاصيل التطبيق
 * العامة لو الشاشة المخصصة مش موجودة/معروفة. لازم تتنادى من داخل
 * إيماءة مستخدم حقيقية (ضغطة زرار) زي أي Intent تاني بيفتح شاشة نظام.
 * @returns {Promise<{opened: boolean, method?: string, manufacturer?: string, reason?: string}>}
 */
export async function requestAutostartPermission() {
    if (!window.Capacitor?.isNativePlatform?.()) {
        return { opened: false, reason: 'not-native-platform' };
    }

    try {
        const { StepCounter } = Capacitor.Plugins;
        return await StepCounter.openAutostartSettings();
    } catch (err) {
        console.warn('[sensors.js] تعذر فتح شاشة إعدادات Autostart:', err);
        return { opened: false, reason: 'plugin-call-failed' };
    }
}

// مزامنة فورية أول ما التطبيق يفتح
document.addEventListener('DOMContentLoaded', syncFromNativeStepCounter);

// (إصلاح - باج Race Condition، مكمّل للحاجز الجديد فوق في
// syncFromNativeStepCounter): بما إن أول نداء من DOMContentLoaded فوق
// ممكن يترفض دلوقتي لو isGuestModeResolved لسه false (الحسم الحقيقي
// لسه ماوصلش)، محتاجين مصدر تاني يعيد المحاولة *فورًا* لحظة ما الحسم
// يخلّص فعليًا - بدل ما نستنى البولينج العادي (NATIVE_SYNC_INTERVAL_MS
// = 4 ثواني) اللي كان هيغطي الموضوع بره لكن بتأخير محسوس لعضو حقيقي
// بيفتح التطبيق. geofence.js بيطلق 'geofence:guest-mode-change' مباشرة
// جوه applyGuestModeRestrictions - يعني نفس اللحظة اللي isGuestModeResolved
// بتتحول فيها لـtrue بالظبط. لو النتيجة "مش زائر" (عضو حقيقي)، نعيد
// نداء المزامنة فورًا فتشتغل الخدمة الأصلية من غير أي تأخير محسوس.
document.addEventListener('geofence:guest-mode-change', () => {
    syncFromNativeStepCounter();
});

// ومزامنة تانية كل ما التطبيق يرجع للمقدمة (المستخدم فتح التطبيق تاني
// بعد ما كان في الخلفية أو مقفول) - عشان يلحق أي خطوات اتسجلت وهو غايب
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        ensureStillSameDay();
        syncFromNativeStepCounter();
        startNativeSyncPolling();
    } else {
        stopNativeSyncPolling();
    }
});

/**
 * [جديد] بولينج دوري (كل NATIVE_SYNC_INTERVAL_MS) لمزامنة عدد الخطوات
 * من الحساس الأصلي طول ما الصفحة "ظاهرة" (visible) والتطبيق شغّال
 * جوه Capacitor - عشان الرقم المعروض في الواجهة يتحدّث لايف أثناء
 * المشي والتطبيق مفتوح، مش بس عند فتح/رجوع التطبيق. بيوقف نفسه
 * أوتوماتيك لما الصفحة تروح للخلفية (شوف visibilitychange فوق) عشان
 * مايعملش نداءات فاضية للـ Plugin وهو مش لازم.
 * ما بتعملش حاجة على المتصفح/PWA العادي (مفيش Capacitor) لأن
 * syncFromNativeStepCounter() نفسها بترجع فورًا في الحالة دي أصلاً.
 */
const NATIVE_SYNC_INTERVAL_MS = 1000;
let nativeSyncIntervalId = null;

function startNativeSyncPolling() {
    if (nativeSyncIntervalId !== null) return; // شغّال أصلاً
    if (!window.Capacitor?.isNativePlatform?.()) return;

    nativeSyncIntervalId = setInterval(syncFromNativeStepCounter, NATIVE_SYNC_INTERVAL_MS);
}

function stopNativeSyncPolling() {
    if (nativeSyncIntervalId === null) return;
    clearInterval(nativeSyncIntervalId);
    nativeSyncIntervalId = null;
}

if (typeof window !== 'undefined') {
    window.syncFromNativeStepCounter = syncFromNativeStepCounter;
}

if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    startNativeSyncPolling();
}

autoInit();