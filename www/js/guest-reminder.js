/* ==================================================================
   سِكّاوي | js/guest-reminder.js
   ------------------------------------------------------------------
   مودال دوري بيفكّر أي زائر (سواء غريب لسه ما سجّلش دخول، أو أصلاً
   من أهل نزلة عبيد بيجرّب التطبيق قبل ما يعمل حساب - شوف onboarding.js
   لتفاصيل زرار "تصفح كزائر" في شاشة الاختيار الأساسية) إنه يسجّل
   دخول/يعمل حساب، بعد فترة تصفح معينة وبتكرار محدود عشان ميبقاش مزعج.

   المنطق: بنعدّ وقت "تصفح فعلي" بس (الزائر فاتح التاب وشغال فعلاً -
   مش وقت التاب في الخلفية أو الموبايل مقفول)، ولما يوصل لحد أدنى معين
   بنعرض المودال، وبعدين بيتكرر تاني بعد فترة أطول طول ما لسه زائر.

   (تحديث): المودال بقى متكامل مع js/modal-history.js (pushModalState/
   closeModal) - زي أي مودال تاني في التطبيق - فزرار رجوع الموبايل/
   السحب من حافة الشاشة بقى بيقفل المودال ده بس (بدل ما يخرج من
   التطبيق أو يرجع لصفحة قبله بالغلط).
   ================================================================== */

import { showAuthGate } from './onboarding.js';
import { pushModalState, closeModal } from './modal-history.js';

/* ==================================================================
   1) إعدادات التوقيت - سهل تتغيّر من هنا لوحدها من غير ما تلمس باقي
      منطق الملف
   ------------------------------------------------------------------ */

// أول ظهور للمودال: بعد كام مللي ثانية "تصفح فعلي" (تاب مفتوح وشغال)
// من أول ما الزائر يدخل وضع الزائر. 3 دقايق - المحتوى نفسه بسيط
// (أسئلة، لوحة صدارة، أكونتات، استوريهات) والزائر أصلاً ممنوع من حل
// الأسئلة، فمفيش خطر إن التنبيه يقاطعه وسط حاجة تفاعلية فعلاً
const FIRST_REMINDER_DELAY_MS = 3 * 60 * 1000;

// بعد أول ظهور، كل قد إيه يتكرر تاني طول ما لسه في وضع الزائر ومقفلش
// حساب. أطول شوية من الأول (5 دقايق بدل 3) عشان التكرار النشط (Active
// Interruption - مودال لازم يتقفل بإيد الزائر) ميبقاش مزعج مع الوقت،
// حتى لو أول تذكير بدري ومناسب
const REPEAT_INTERVAL_MS = 5 * 60 * 1000;

// كل قد إيه بنفحص/نعدّ الوقت (Tick) - 15 ثانية دقة كافية جداً لغرض
// تذكير، ومفيش داعي لدقة أعلى (زي ثانية بثانية) تستهلك بطارية بلاش
const TICK_INTERVAL_MS = 15 * 1000;

// مفتاح localStorage لحفظ تقدّم العدّاد عبر أي Refresh (نفس فلسفة
// GUEST_MODE_STORAGE_KEY في auth.js بالظبط) - من غيره، أي Refresh
// للصفحة كان بيصفّر accumulatedActiveMs ويرجّع العدّاد م الأول، فالزائر
// اللي بيعمل Refresh بشكل عادي أثناء التصفح ممكن يفضل ساعات ومياخدش
// التذكير خالص لأنه مبيوصلش لعتبة الظهور بشكل متواصل
const REMINDER_STATE_STORAGE_KEY = 'sakkawy-guest-reminder-state';


/* ==================================================================
   2) حالة داخلية بسيطة (متزامنة مع localStorage - شوف قسم 2ب تحت)
   ------------------------------------------------------------------ */

// إجمالي وقت التصفح الفعلي المتراكم (بالمللي ثانية) من آخر مرة اتصفّر
// فيها العداد (يعني من أول ما دخل وضع الزائر، أو من آخر مرة اتقفل
// فيها المودال وعدّينا لمرحلة الانتظار الجاية)
let accumulatedActiveMs = 0;

// الحد اللي لما accumulatedActiveMs يوصله، نعرض المودال. بيتحدّث لقيمة
// أكبر (REPEAT_INTERVAL_MS إضافية) بعد كل ظهور
let nextThresholdMs = FIRST_REMINDER_DELAY_MS;

// معرّف الـ setInterval الحالي (لو null يبقى العداد مش شغال دلوقتي -
// إما لأن المستخدم مش زائر، أو المودال ظاهر بالفعل)
let tickIntervalId = null;

// true لو المودال ظاهر فعليًا دلوقتي - بنوقف العد أثناء ما هو ظاهر
// (مفيش داعي نعدّ وقت وهو أصلاً شايف رسالة التذكير)
let isModalCurrentlyOpen = false;


/* ==================================================================
   2ب) حفظ/استرجاع حالة العدّاد من localStorage
   ------------------------------------------------------------------
   بنحفظ accumulatedActiveMs وnextThresholdMs مع بعض في مفتاح واحد،
   عشان لو المستخدم عمل Refresh للصفحة وهو لسه زائر، العدّاد يكمّل من
   حيث ما وقف بدل ما يرجع صفر (نفس مشكلة كانت موجودة قبل كده). زي ما
   هو متبع في باقي الملف مع localStorage (GUEST_MODE_STORAGE_KEY في
   auth.js)، أي فشل في الوصول لـ localStorage (خصوصية متصفح، وضع تصفح
   خفي..إلخ) بنتعامل معاه بهدوء من غير ما نكسر باقي منطق التذكير -
   أسوأ سيناريو وقتها: العدّاد يرجع لسلوكه القديم (يتصفّر مع الـ Refresh).
   ------------------------------------------------------------------ */

function loadPersistedReminderState() {
    try {
        const raw = window.localStorage.getItem(REMINDER_STATE_STORAGE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw);

        // تحقق بسيط من شكل البيانات قبل ما نثق فيها (لو اتلخبطت لأي
        // سبب، بنتجاهلها ونبدأ من القيم الافتراضية بدل ما نكسر العدّاد)
        if (
            typeof parsed?.accumulatedActiveMs === 'number' &&
            typeof parsed?.nextThresholdMs === 'number' &&
            parsed.accumulatedActiveMs >= 0 &&
            parsed.nextThresholdMs > 0
        ) {
            accumulatedActiveMs = parsed.accumulatedActiveMs;
            nextThresholdMs = parsed.nextThresholdMs;
        }
    } catch (err) {
        // تجاهل بهدوء - العدّاد هيبدأ من القيم الافتراضية عادي
    }
}

function savePersistedReminderState() {
    try {
        window.localStorage.setItem(
            REMINDER_STATE_STORAGE_KEY,
            JSON.stringify({ accumulatedActiveMs, nextThresholdMs })
        );
    } catch (err) {
        // تجاهل بهدوء - أسوأ سيناريو: العدّاد يتصفّر مع أي Refresh لاحق
        // (نرجع لنفس السلوك القديم بدل ما نكسر حاجة)
    }
}

function clearPersistedReminderState() {
    try {
        window.localStorage.removeItem(REMINDER_STATE_STORAGE_KEY);
    } catch (err) {
        // تجاهل بهدوء
    }
}


/* ==================================================================
   3) دوال مساعدة صغيرة
   ------------------------------------------------------------------ */

/**
 * هل التاب ده مفتوح وشغال فعليًا دلوقتي (مش في الخلفية، مش الموبايل
 * مقفول)؟ بنعتمد على Page Visibility API القياسية.
 */
function isTabActuallyVisible() {
    return document.visibilityState === 'visible';
}

/**
 * هل فيه مودال/شاشة تانية أهم مفتوحة دلوقتي المفروض نستنى لحد ما
 * تتقفل قبل ما نزاحمها بمودال التذكير؟ (فورم الدخول نفسه، مودال الدعم
 * للمغتربين، شاشة الترحيب لو لسه ظاهرة لأي سبب). بنفحص غياب كلاس
 * "hidden" - نفس الطريقة المستخدمة في باقي التطبيق
 */
function isAnyBlockingUIOpen() {
    const selectors = ['#authModal', '#supportModal', '#onboardingOverlay'];
    return selectors.some((selector) => {
        const el = document.querySelector(selector);
        return el && !el.classList.contains('hidden');
    });
}

function getGuestReminderElements() {
    return {
        modal: document.getElementById('guestReminderModal'),
        backdrop: document.getElementById('guestReminderModalBackdrop'),
        closeBtn: document.getElementById('guestReminderModalCloseBtn'),
        ctaBtn: document.getElementById('guestReminderModalCtaBtn'),
        dismissBtn: document.getElementById('guestReminderModalDismissBtn'),
    };
}


/* ==================================================================
   4) إظهار/إخفاء المودال
   ------------------------------------------------------------------ */

function openGuestReminderModal() {
    const { modal } = getGuestReminderElements();
    if (!modal) return;

    isModalCurrentlyOpen = true;
    modal.classList.remove('hidden');

    // إيقاف العدّاد أثناء ما المودال ظاهر - هيتشغّل تاني لما يتقفل
    // (شوف hideGuestReminderModal تحت)
    stopTicking();

    // تسجيل خطوة جديدة في تاريخ المتصفح - عشان زرار رجوع الموبايل/
    // السحب من حافة الشاشة يقفل المودال ده بس (عن طريق hideGuestReminderModal
    // الخام تحت) بدل ما يخرج من التطبيق أو يرجع لصفحة قبله بالغلط
    pushModalState(hideGuestReminderModal);
}

/**
 * الإخفاء الخام لمودال التذكير فقط - بيتسجل مع pushModalState فوق
 * ويتنادى تلقائيًا سواء المستخدم قفل المودال بزرار X/تجاهل/الخلفية/CTA
 * (عن طريق closeGuestReminderModal تحت) أو بزرار رجوع الموبايل مباشرة.
 * استخدم closeGuestReminderModal() من أي مكان تاني عشان يتزامن مع
 * تاريخ المتصفح.
 */
function hideGuestReminderModal() {
    const { modal } = getGuestReminderElements();
    if (!modal) return;

    isModalCurrentlyOpen = false;
    modal.classList.add('hidden');

    // بعد الإغلاق (بأي طريقة - إغلاق، تجاهل، تسجيل دخول ناجح، أو زرار
    // رجوع الموبايل)، لو لسه زائر فعلاً، نجهّز العتبة الجاية ونرجّع
    // العدّاد يشتغل
    nextThresholdMs = accumulatedActiveMs + REPEAT_INTERVAL_MS;
    savePersistedReminderState();
    startTickingIfNeeded();
}

/**
 * الإغلاق العام لمودال التذكير - الدالة اللي زرار X، تجاهل، الضغط على
 * الخلفية، وزرار الـ CTA لازم ينادوا عليها بدل hideGuestReminderModal
 * مباشرة، عشان تستهلك خطوة تاريخ المتصفح اللي اتضافت وقت الفتح
 * (pushModalState فوق) وبالتالي يفضل زرار رجوع الموبايل متزامن مع
 * اللي المستخدم شايفه على الشاشة
 */
function closeGuestReminderModal() {
    const { modal } = getGuestReminderElements();
    if (!modal || modal.classList.contains('hidden')) return;
    closeModal();
}


/* ==================================================================
   5) منطق العدّاد (Tick)
   ------------------------------------------------------------------ */

function handleTick() {
    // لو خرج من وضع الزائر أثناء ما العدّاد شغال (سجّل دخول من مكان
    // تاني في التطبيق مثلاً)، بنوقف كل حاجة فورًا - الحدث
    // 'geofence:guest-mode-change' هيتكفّل بالتصفير أصلاً، بس ده حماية
    // إضافية لو الـ Tick اتنفّذ في نفس اللحظة قبل ما الحدث يوصل
    if (!window.isGuestMode) {
        stopTicking();
        return;
    }

    // بنعدّ الوقت بس لو التاب فعلاً ظاهر وشغال (مش في الخلفية) والمودال
    // مش ظاهر أصلاً دلوقتي
    if (!isTabActuallyVisible() || isModalCurrentlyOpen) {
        return;
    }

    accumulatedActiveMs += TICK_INTERVAL_MS;

    // بنحفظ بعد كل Tick فعلي (كل 15 ثانية بالظبط) عشان لو الزائر عمل
    // Refresh في أي لحظة، أطول حاجة يضيعها هي آخر 15 ثانية بس مش كل
    // التقدّم اللي عمله من أول ما دخل وضع الزائر
    savePersistedReminderState();

    if (accumulatedActiveMs < nextThresholdMs) {
        return;
    }

    // وصلنا للعتبة - لو فيه مودال/شاشة تانية أهم مفتوحة دلوقتي، نأجّل
    // (مش نتجاهل) لحد الـ Tick الجاي من غير ما نستهلك العتبة، عشان
    // المودال يظهر أول فرصة تتفضى فيها الشاشة بدل ما يضيع الدور خالص
    if (isAnyBlockingUIOpen()) {
        return;
    }

    openGuestReminderModal();
}

function startTickingIfNeeded() {
    if (tickIntervalId !== null) return; // شغال بالفعل
    if (!window.isGuestMode) return;
    if (isModalCurrentlyOpen) return;

    // نحاول نسترجع أي تقدّم محفوظ من قبل (مثلاً قبل آخر Refresh) قبل ما
    // نبدأ العدّاد، عشان نكمّل من حيث ما وقفنا بدل ما نبدأ من صفر تاني.
    // لو مفيش حاجة محفوظة، الدالة مبتغيّرش القيم الافتراضية الحالية
    loadPersistedReminderState();

    tickIntervalId = window.setInterval(handleTick, TICK_INTERVAL_MS);
}

function stopTicking() {
    if (tickIntervalId === null) return;
    window.clearInterval(tickIntervalId);
    tickIntervalId = null;
}

/** تصفير كامل - بتتنادى لما المستخدم يطلع من وضع الزائر (سجّل حساب/دخول
 *  فعليًا)، عشان لو دخل وضع الزائر تاني يوم من الأيام (بعد تسجيل خروج
 *  مثلاً)، العدّاد يبدأ من الصفر تاني مش يكمّل من فين ما وقف */
function resetGuestReminderState() {
    accumulatedActiveMs = 0;
    nextThresholdMs = FIRST_REMINDER_DELAY_MS;
    stopTicking();
    // (ملحوظة) بننادي هنا الدالة الخام (hideGuestReminderModal) مباشرة
    // مش closeGuestReminderModal() - الحالة دي تصفير قسري بسبب خروج
    // المستخدم من وضع الزائر تمامًا (سجّل حساب/دخول)، مش إغلاق عادي
    // بإيد المستخدم، فمفيش داعي (ولا آمان) نمر على history.back() هنا.
    // لو المودال كان مفتوح فعلاً في اللحظة النادرة دي، خطوة تاريخ
    // المتصفح المرتبطة بيه (اللي اتضافت وقت الفتح) هتفضل معلّقة لحد ما
    // ضغطة "رجوع" غير مرتبطة جاية تستهلكها بهدوء - أثر جانبي بسيط جداً
    // ومقبول في الحالة النادرة دي بس.
    //
    // ملحوظة: hideGuestReminderModal() بتحفظ عتبة جديدة في localStorage
    // كجزء من منطقها العادي (شوف تعليقها فوق) - فلازم clearPersistedReminderState()
    // تتنادى بعدها هنا مش قبلها، عشان تكون هي الكلمة الأخيرة وتمسح أي
    // حاجة اتكتبت لسه، بدل ما نمسح وبعدين نرجّع نكتب حاجة تاني بالغلط
    hideGuestReminderModal();
    clearPersistedReminderState();
}


/* ==================================================================
   6) التهيئة + ربط الأحداث
   ------------------------------------------------------------------ */

function initGuestReminder() {
    const { closeBtn, backdrop, ctaBtn, dismissBtn } = getGuestReminderElements();

    if (closeBtn) closeBtn.addEventListener('click', closeGuestReminderModal);
    if (backdrop) backdrop.addEventListener('click', closeGuestReminderModal);
    if (dismissBtn) dismissBtn.addEventListener('click', closeGuestReminderModal);

    if (ctaBtn) {
        ctaBtn.addEventListener('click', () => {
            closeGuestReminderModal();
            // نفس تعديل guest-banner.js بالظبط: شاشة اختيار كاملة
            // (إنشاء حساب / تسجيل دخول)، من غير ما نفترض هو مين
            showAuthGate();
        });
    }

    // بداية/إيقاف العدّاد حسب حالة وضع الزائر الفعلية - نفس الحدث اللي
    // geofence.js بيطلقه من applyGuestModeRestrictions() لأي تغيير
    document.addEventListener('geofence:guest-mode-change', (event) => {
        if (event.detail?.isGuestMode) {
            startTickingIfNeeded();
        } else {
            resetGuestReminderState();
        }
    });

    // لو التاب رجع يبان بعد ما كان في الخلفية، مفيش داعي لحاجة إضافية
    // هنا فعليًا - أول Tick جاي هيكتشف isTabActuallyVisible() = true
    // تلقائيًا ويكمّل العد عادي. الاستماع لـ visibilitychange مش لازم
    // إلا لو حبينا دقة أعلى من TICK_INTERVAL_MS، ومش محتاجينها هنا.

    // الحالة الابتدائية وقت تحميل الصفحة: لو الزائر أصلاً في وضع الزائر
    // من قبل (Refresh مثلاً، أو دخل وضع الزائر قبل ما الملف ده يتحمّل)،
    // نبدأ العدّاد على طول من غير ما نستنى أول تغيير فعلي للحالة
    if (window.isGuestMode) {
        startTickingIfNeeded();
    }
}

document.addEventListener('DOMContentLoaded', initGuestReminder);