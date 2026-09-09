/* ==================================================================
   سِكّاوي | js/app.js
   ------------------------------------------------------------------
   هذا هو "الملف الرئيسي" ونقطة الدخول الوحيدة للتطبيق (المُحمّل من
   index.html عبر <script type="module">). مسؤولياته:

   1) الاحتفاظ بحالة التطبيق العامة المحلية فقط (الخطوات..إلخ)
   2) إدارة التنقل بين الشاشات (Tabs) والملاحة السفلية
   3) بنبلّغ عن أي نشاط (خطوات) لـ js/profiles.js عبر أحداث مخصصة
      (steps:progress) عشان يحفظه في Supabase.
      (ملحوظة: تحدي الذكاء اليومي القديم بسؤالين ثابتين - ديني +
      معلومات عامة - اتشال نهائياً من هنا. التحدي اليومي الوحيد دلوقتي
      هو "السؤال اليومي" المُدار من js/daily-question.js)
   4) أدوات واجهة مشتركة (Toast، الصوت، الكونفيتي) وإتاحتها لباقي
      الوحدات عبر أحداث مخصصة (Custom Events) بدل الاستيراد المباشر،
      عشان نتجنب الاعتماد الدائري بين الملفات (Circular Imports)
   5) استدعاء دوال التهيئة (init) بتاعة كل وحدة (auth, sensors,
      geofence, stories, profiles) عند بداية تشغيل التطبيق

   ملحوظة مهمة (المرحلة 6): app.js مبقاش بيدير أي نقاط أو ليدربورد
   محلياً خالص. js/profiles.js هو المصدر الوحيد للحقيقة (Single Source
   of Truth) لكل ما يخص النقاط والليدربورد - جلباً وتحديثاً وعرضاً،
   مباشرة من/على Supabase، عشان نمنع أي Race Condition بين نسختين.
   ================================================================== */

import { restoreSession, bindAuthEventListeners, checkExistingSession, getCurrentUser } from './auth.js';
import { getStepsCount, getStepsHistory, syncActiveUser, requestBatteryOptimizationExemption, requestAutostartPermission } from './sensors.js';
import { applyGuestModeRestrictions } from './geofence.js';
import { initStoriesUI } from './stories.js';
import { initProfileUI } from './profiles.js';
import { initTheme } from './theme.js';
import { initNotificationsUI } from './notifications.js';
// (المرحلة 5 - خطة الإشعارات الخارجية): تسجيل الجهاز لاستقبال Push
// Notifications حقيقية (FCM) - initPushNotifications() بتتنادى بنفس
// فلسفة باقي initXxxUI، وبتستمع لـ auth:login/auth:signed-out بنفسها
import { initPushNotifications } from './push.js';
// (المرحلة 8) رسائل الدعم لأكونتك الشخصي - مودال منفصل تماماً، بنفس
// فلسفة initNotificationsUI (تهيئة مودال مستقل عن محتوى الصفحة الرئيسية)
import { initSupportChat } from './support-chat.js';
// (إصلاح باج "شريط ترتيبي ثابت في كل مكان") - شوف switchTab() تحت
import { refreshActiveLeaderboard } from './leaderboard.js';
import { initOnboarding, showAuthGate } from './onboarding.js';
import { initDailyQuestionCard } from './daily-question.js';
// (المرحلة 5): منشورات "سِكّاوي" (فيسبوك-ستايل) - initPostsUI() بتجيب
// المنشورات وترسمها وتفتح اشتراك Realtime، بنفس نمط initStoriesUI()
// بالظبط. شوف تعليق نهاية js/posts.js لتفاصيل ليه مفيش <script> منفصل
// ليه في index.html
import { initPostsUI } from './posts.js';
import { supabaseClient } from './supabase-config.js';
// (خطة الأوفلاين - القسم 5) مراقبة رجوع النت + إطلاق حدث app:online
// عالمي لأي ملف محتاج يعرف - شوف initApp() تحت
import { initNetworkStatusWatcher } from './network-status.js';

/* ------------------------------------------------------------------
   0) نظام مراحل الخطوات (بدل هدف ثابت 10,000)
   ------------------------------------------------------------------
   بدل ما نحط هدف واحد كبير (10,000) من أول الصبح وده كان بيحبط اللي
   لسه بادئ، بنقسمه لمراحل متتالية بتقرب شوية شوية من 10,000. كل ما
   المستخدم يعدي مرحلة، الهدف اللي بعدها يظهر تلقائياً (زي أي لعبة
   فيها Levels)، وده بيدّي إحساس بإنجاز متكرر بدل انتظار طويل.
   المراحل بتتصفر يومياً (زي ما كانت الخطوات بتتصفر) - كل يوم جديد
   المستخدم بيرجع يبدأ من المرحلة الأولى (500) تاني.
   ================================================================== */
// (تعديل) اتوسّعت من 7 مراحل (لحد 10,000) لـ12 مرحلة (لحد 30,000) بناءً
// على طلب صريح - المراحل الأولى (لحد 10,000) اتسابت زي ما هي بالظبط
// عشان نفس التقدم/الاستخدام الحالي للمستخدمين يفضل متسق، والمراحل
// الجديدة بعدها فجواتها بتكبر أكتر (2500 ثم 5000) لأنها بقت تمثل مجهود
// استثنائي (30,000 خطوة ≈ نص ماراثون تقريبًا) مش استخدام يومي عادي -
// لسه تحت HARD_DAILY_STEPS_CAP (50,000) بمساحة كويسة
const STAGE_MILESTONES = [500, 1000, 2000, 3500, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000];

/** عدد الخطوات المطلوبة لاكتساب نقطة واحدة (كل 200 خطوة = نقطة) -
 *  مستخدم في مكانين: appState.earnedFromSteps (تقدير العرض الفوري)
 *  و handleStepsIncrease (حساب النقاط الفعلية المُرسلة لـ profiles.js) */
const STEPS_PER_POINT = 200;

/** (جديد) سقف أمان مطلق لعدد الخطوات المسجّلة في اليوم - ده مش سقف
 *  تحفيزي زي STAGE_MILESTONES (اللي بتقف عند 10,000 بصرياً بس)، ده حد
 *  أقصى فعلي للتسجيل نفسه. الهدف منه حماية الليدربورد من أي رقم ضخم
 *  غلط يوصل دفعة واحدة (خطأ حساس حركة أو محاولة تلاعب/Spoofing) - رقم
 *  عالي جداً عمداً عشان محدش حقيقي (حتى رياضي محترف) هيقرب منه في يوم
 *  واحد فعلياً، فمش هيأثر على أي استخدام طبيعي خالص */
const HARD_DAILY_STEPS_CAP = 50000;

/** بيرجع فهرس أول مرحلة لسه المستخدم مخطاهاش، بناءً على عدد خطواته الحالي */
function getStageIndexForSteps(steps) {
    const idx = STAGE_MILESTONES.findIndex((milestone) => steps < milestone);
    return idx === -1 ? STAGE_MILESTONES.length - 1 : idx;
}

/* ------------------------------------------------------------------
   0.1) (اتشال) كان هنا توست "امبارح وصلت لـ X خطوة!" بيتعرض مرة واحدة
   كل يوم عند فتح التطبيق - اتشال بالكامل بناءً على طلب صريح، فمعاه
   اتشالت الدوال المساعدة (getDateKey/getTodayDateKey/getYesterdayDateKey)
   ومفتاح localStorage الخاصين بيه لأنهم كانوا لغرض الميزة دي بس ومالهاش
   استخدام تاني في باقي الملف.
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   0.2) الرقم القياسي الشخصي - أعلى عدد خطوات وصله المستخدم في يوم واحد
   على الإطلاق. بنحسبه من أرشيف sensors.js (getStepsHistory، بيرجع كل
   الأيام الفايتة عدا النهاردة) - مفيش نسخة تانية من البيانات هنا برضه.
   ------------------------------------------------------------------ */

/** أعلى رقم خطوات محقق في يوم كامل قبل النهاردة (0 لو مفيش تاريخ محفوظ لسه) */
function getPreviousBestSteps() {
    const history = getStepsHistory();
    const values = Object.values(history);
    return values.length ? Math.max(...values) : 0;
}

/* ------------------------------------------------------------------
   1) حالة التطبيق العامة
   ------------------------------------------------------------------ */
const appState = {
    // ملحوظة: مفيش appState.points هنا خالص - النقاط بقت مُدارة بالكامل
    // من js/profiles.js (قراءةً وكتابةً من/على Supabase مباشرة) عشان
    // نمنع أي Race Condition بين نسخة محلية هنا ونسخة profiles.js.
    // لو محتاج تعرض النقاط في مكان جديد، استخدم updateProfileStats()
    // بتاعة profiles.js، ومتضفش عداد تاني هنا.
    //
    // (المرحلة 7): اتشال الرقم الثابت الوهمي (كان 6420) نهائياً. دلوقتي
    // بنبدأ بالقيمة الحقيقية المتراكمة فعلياً من حساس الحركة لليوم
    // الحالي (js/sensors.js -> getStepsCount()، بيتقرا من localStorage
    // ومتزامن مع حدث devicemotion الحقيقي)، مش رقم مُختلق. بما إن
    // sensors.js بيتحمّل (import) ويشغّل autoInit() بشكل متزامن (Sync)
    // قبل السطر ده، getStepsCount() بترجع القيمة الصح من أول لحظة.
    steps: getStepsCount(),
    // بدل هدف ثابت 10,000، بنحسب فهرس أول مرحلة لسه المستخدم مخطاهاش
    // (شوف STAGE_MILESTONES فوق) - كل ما يعدي مرحلة، الفهرس ده بيزيد.
    stageIndex: getStageIndexForSteps(getStepsCount()),
    // تقدير تقريبي للنقاط المكتسبة من الخطوات النهاردة (لعرض فوري في
    // الواجهة بس، بنفس معادلة handleStepsIncrease: كل STEPS_PER_POINT
    // خطوة = نقطة). الرقم الحقيقي المُعتمد رسمياً دايماً هو profiles.points
    // في Supabase واللي بتعرضه updateProfileStats بتاعة profiles.js.
    earnedFromSteps: Math.floor(getStepsCount() / STEPS_PER_POINT),
    // أعلى خطوات وصلها المستخدم في يوم كامل قبل النهاردة (0 لو أول يوم استخدام)
    previousBestSteps: getPreviousBestSteps(),
    // (إصلاح - نفس فئة باج توست "أهلاً بيك"/الأوسمة المتكررة): true لو
    // المستخدم كسر رقمه القياسي بالفعل النهاردة - كانت متبدئة بـ false
    // ثابتة بدون أي فحص للحالة الحالية، عكس reachedDailyGoalToday/
    // hitHardCapToday تحت اللي بيتفحصوا صح من قيمة appState.steps
    // الحالية وقت التحميل. يعني لو المستخدم كسر رقمه القياسي النهاردة
    // بالفعل، وعمل Refresh للصفحة، المتغيّر ده كان بيرجع false غلط،
    // فأول خطوة تجيله بعد الـ Refresh كانت بتطلع توست "ده رقمك القياسي
    // الجديد!" + كونفيتي تاني من غير أي داعي (نفس منطق الرقم بالظبط
    // اتكرر). دلوقتي بنفحص الحالة الفعلية زي باقي الأعلام تمامًا.
    recordBrokenToday: getPreviousBestSteps() > 0 && getStepsCount() > getPreviousBestSteps(),
    // (جديد) true بمجرد ما يوصل/يعدّي هدف الـ10,000 خطوة النهاردة - بيمنع
    // تكرار توست "وصلت لهدف العشرة آلاف" مع كل خطوة زيادة بعد كده (لأن
    // العداد بقى بيكمل بعد الهدف ده دلوقتي بدل ما يقف عنده)
    reachedDailyGoalToday: getStepsCount() >= STAGE_MILESTONES[STAGE_MILESTONES.length - 1],
    // (جديد) true بمجرد ما يوصل لسقف الأمان اليومي (50,000) - بيمنع تكرار
    // توست "وصلت للسقف" مع كل محاولة تسجيل زيادة بعد كده في نفس اليوم
    hitHardCapToday: getStepsCount() >= HARD_DAILY_STEPS_CAP,
};

/* ------------------------------------------------------------------
   2) التنقل بين الشاشات (Tabs)
   ------------------------------------------------------------------ */
function switchTab(tabId, { fromPopState = false } = {}) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));

    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) targetTab.classList.add('active');

    // (إصلاح باج "شريط ترتيبي (مركزك الحالي) ثابت وظاهر في أي تبويب
    // أروحله"): #selfRankBar عنصر position:fixed (شوف .self-rank-bar
    // في css/leaderboard-championships.css) بيتفعّل بشرط واحد بس في
    // js/leaderboard.js: "ترتيبك بره أول 10 في البطولة النشطة" - مفيش
    // أي علاقة بينه وبين أي تبويب مفتوح دلوقتي، فكان بيفضل عالق فوق أي
    // تبويب تاني (البروفايل/الرئيسية) بعد أول ظهور ليه في تبويب الترتيب
    // - لأن مفيش حاجة كانت بتقفله تاني غير رسمة ليدربورد جديدة.
    // الحل: بنتأكد إن العنصر ده موجود فعلياً *جوه* التبويب المستهدف
    // (targetTab.contains) بدل ما نفترض اسم تبويب معيّن بالإيد - لو
    // مش جواه، بنقفله فورًا. ولو *هو* جواه (يعني داخلين تبويب الترتيب)،
    // بنعيد جلب/رسم بيانات الفترة النشطة حالياً عشان الشريط (وكل
    // أرقام الليدربورد) تفضل حديثة كل مرة تدخل التبويب، وتظهر بس لو
    // ترتيبك فعلاً معدّي أول 10 في البطولة دي بالذات.
    const selfRankBar = document.getElementById('selfRankBar');
    if (targetTab && selfRankBar && targetTab.contains(selfRankBar)) {
        refreshActiveLeaderboard();
    } else if (selfRankBar) {
        selfRankBar.classList.add('hidden');
    }

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.remove('text-gold-400', 'bg-gold-400/10');
        btn.classList.add('text-lux-500');
    });

    const activeBtn = document.getElementById(`nav-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.remove('text-lux-500');
        activeBtn.classList.add('text-gold-400', 'bg-gold-400/10');
    }

    // [تعديل - إصلاح تجاوب APK]: تسجيل التبويب الحالي في تاريخ المتصفح
    // (History API) - عشان لما التطبيق يتقفل جوه WebView كـ APK، زرار
    // الرجوع الفعلي في أندرويد (اللي أغلب أدوات تحويل الموقع لـ APK
    // بتربطه بـ webview.goBack() تلقائياً) يرجّع لتبويب "الرئيسية" بدل
    // ما يقفل التطبيق فجأة وهو لسه في "الترتيب" أو "بروفايلي" مثلاً.
    // ملحوظة: ده بيغطي التبويبات التلاتة الرئيسية بس هنا - الصفحات
    // الفرعية (الأوسمة، الإعدادات، الاستوريز..إلخ) ليها آلية عرض
    // منفصلة ومحتاجة تغطية زرار الرجوع بشكل مستقل لاحقاً.
    if (!fromPopState) {
        history.pushState({ sakkawyTab: tabId }, '', `#${tabId}`);
    }
}

// الاستماع لزرار "الرجوع" (يدوي من المتصفح، أو الفعلي من أندرويد جوه
// WebView تطبيق الـ APK) - بيرجّع للتبويب المحفوظ في الحالة، أو
// "الرئيسية" كافتراضي لو مفيش حالة محفوظة أصلاً (أول فتحة للتطبيق)
window.addEventListener('popstate', (event) => {
    // (إصلاح - باج حقيقي) لو الـ popstate ده سببه إغلاق مودال (مسجّل من
    // js/modal-history.js بعلامة appModal: true في الـ state)، مش شغلنا
    // هنا خالص - سيبها لمستمع popstate بتاع modal-history.js يتعامل
    // معاه لوحده. من غير التحقق ده، كنا بنقرا event.state?.sakkawyTab
    // (اللي مش موجودة في state المودالات أصلاً) فبترجع undefined
    // وبنفتكرها 'home' افتراضيًا، فبنبدّل التبويب بالغلط فوق أي مودال/
    // صفحة فرعية مفتوحة (زي إعدادات الحساب) في نفس اللحظة اللي
    // modal-history.js بتقفل مودال داخلي (زي قص الصورة) بس - وده كان
    // سبب باج "تأكيد قص الصورة بيطلعني برّه صفحة الإعدادات بالكامل"
    if (event.state?.appModal) return;

    const tabId = event.state?.sakkawyTab || 'home';
    switchTab(tabId, { fromPopState: true });
});

function initTabNavigation() {
    document.querySelectorAll('.nav-btn[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
}

/**
 * جسر تنقّل عام بين التابات لأي وحدة تانية عايزة توديك تاب معين (زي
 * notifications.js لما تفتح إشعار "فتحت وسام جديد" وعايزة توديك لتبويب
 * بروفايلي فين دولاب الأوسمة) - بنستخدم حدث مخصص 'app:switch-tab' بدل
 * ما أي ملف يستورد switchTab من app.js مباشرة، بنفس فلسفة app:toast/
 * app:sound (تجنب Circular Imports مع app.js، شوف تعليق notifications.js).
 * الحدث بياخد { tabId, scrollToId? } - scrollToId اختياري لو محتاجين
 * كمان نمرر لقسم معيّن جوه التاب بعد ما يتفعّل.
 */
function initCrossModuleTabNavigation() {
    document.addEventListener('app:switch-tab', (event) => {
        const { tabId, scrollToId } = event.detail || {};
        if (!tabId) return;

        switchTab(tabId);

        if (scrollToId) {
            // بنستنى فريم واحد عشان التاب الجديد يبقى ظاهر فعلياً
            // (display/active class) قبل ما نحسب موضع السكرول بتاعه
            requestAnimationFrame(() => {
                document.getElementById(scrollToId)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    });
}

/**
 * ربط زرار هوية المستخدم في الهيدر العلوي (#headerProfileLink - بيلف
 * صورة الأفتار + الاسم + اللقب سوا) عشان الضغط عليه يودّي المستخدم
 * لتبويب "بروفايلي" مباشرة. بيستخدم نفس دالة switchTab('profile') اللي
 * بيستخدمها زرار "بروفايلي" في شريط التنقل السفلي، فسلوك التنقل موحّد
 * ومفيش تكرار لمنطق تفعيل/تعطيل التابات في أكتر من مكان.
 */
function initHeaderProfileLink() {
    const headerProfileBtn = document.getElementById('headerProfileLink');
    if (headerProfileBtn) {
        headerProfileBtn.addEventListener('click', () => switchTab('profile'));
    }
}

/* ------------------------------------------------------------------
   3) عداد الخطوات
   ------------------------------------------------------------------ */

/** الهدف الحالي = مرحلة appState.stageIndex من STAGE_MILESTONES */
function getCurrentStageTarget() {
    return STAGE_MILESTONES[appState.stageIndex];
}

/**
 * (جديد) بيبني عناصر نقط مؤشر المراحل مرة واحدة بس عند بداية التطبيق -
 * عدد النقط = عدد STAGE_MILESTONES (7 حاليًا). بعد كده updateStageIndicatorUI
 * هي بس اللي بتغيّر كلاس كل نقطة حسب تقدم المستخدم، من غير أي إعادة بناء
 * لعناصر الـDOM (أرخص وأبسط في الأداء).
 */
function renderStageDotsSkeleton() {
    const container = document.getElementById('stageDotsRow');
    if (!container || container.childElementCount > 0) return; // إتبنت قبل كده (initStepsCounter ممكن تتنادى أكتر من مرة نظريًا)

    STAGE_MILESTONES.forEach((_, index) => {
        const dot = document.createElement('span');
        dot.className = 'stage-dot';
        dot.dataset.stageIndex = String(index);
        container.appendChild(dot);
    });
}

/**
 * (جديد) بتحدّث نص "المرحلة X من 7" وحالة كل نقطة (completed/current/
 * upcoming) بناءً على appState.steps الحالي - بتتنادى من جوه
 * updateStepsUI() مع كل تحديث عادي للعداد (حساس حركة أو مزامنة صامتة
 * من جهاز تاني على السواء). بنحسب حالة كل نقطة من appState.steps
 * مباشرة (مش من stageIndex بس) عشان آخر مرحلة (10,000) تتلوّن "مكتملة"
 * فعليًا لما توصلها، بدل ما تفضل عالقة في حالة "نبض" للأبد.
 */
function updateStageIndicatorUI() {
    const stageLabelEl = document.getElementById('stageLabel');
    const totalStages = STAGE_MILESTONES.length;

    if (stageLabelEl) {
        // Math.min عشان لو المستخدم عدّى آخر مرحلة، يفضل عارض "٧ من ٧"
        // (مش رقم ٨ وهمي مالوش مرحلة فعلية تقابله)
        const displayedStageNumber = Math.min(appState.stageIndex + 1, totalStages);
        stageLabelEl.textContent = `المرحلة ${displayedStageNumber} من ${totalStages}`;
    }

    const dots = document.querySelectorAll('#stageDotsRow .stage-dot');
    dots.forEach((dot) => {
        const dotIndex = Number(dot.dataset.stageIndex);
        const milestone = STAGE_MILESTONES[dotIndex];
        dot.classList.remove('stage-dot--completed', 'stage-dot--current');

        if (appState.steps >= milestone) {
            dot.classList.add('stage-dot--completed');
        } else if (dotIndex === appState.stageIndex) {
            dot.classList.add('stage-dot--current');
        }
        // dotIndex أكبر من appState.stageIndex ولسه ماوصلش milestone بتاعه:
        // بتفضل بدون أي كلاس زيادة (upcoming، الشكل الافتراضي بس)
    });
}

/**
 * (جديد) نبضة احتفالية لحظية على نقطة المرحلة اللي اتخطاها المستخدم
 * للتو (نص ثانية بس، شوف .stage-dot--celebrate في style.css) - بديل
 * بصري خفيف عن توست "خلصت المرحلة..." اللي اتشال بناءً على طلب صريح
 * قبل كده، عشان يفضل حس بالإنجاز موجود من غير ما يقاطع المستخدم بنص.
 * @param {number} stageIndex - فهرس المرحلة اللي اتخطاها للتو
 */
function triggerStageDotCelebration(stageIndex) {
    const dot = document.querySelector(`#stageDotsRow .stage-dot[data-stage-index="${stageIndex}"]`);
    if (!dot) return;

    dot.classList.remove('stage-dot--celebrate');
    // إجبار المتصفح يعيد حساب الـ Style قبل ما نضيف الكلاس تاني (Reflow
    // Trick) - عشان لو المستخدم عدّى مرحلتين قريبين من بعض، الأنيميشن
    // تقدر تتكرر على نفس النقطة من غير ما المتصفح "يوفّرها" لإنه شايف
    // نفس الكلاس مضاف أصلاً
    void dot.offsetWidth;
    dot.classList.add('stage-dot--celebrate');
}

function updateStepsUI() {
    const stepCountEl = document.getElementById('stepCount');
    const stepTargetLabelEl = document.getElementById('stepTargetLabel');
    const progressBar = document.getElementById('stepProgressBar');
    const personalBestEl = document.getElementById('personalBestLabel');

    const currentTarget = getCurrentStageTarget();

    if (stepCountEl) stepCountEl.textContent = appState.steps.toLocaleString();
    if (stepTargetLabelEl) stepTargetLabelEl.textContent = `${currentTarget.toLocaleString()} خطوة`;

    const percentage = Math.min(100, (appState.steps / currentTarget) * 100);
    if (progressBar) progressBar.style.width = `${percentage}%`;

    updateStageIndicatorUI();

    // بنعرض الرقم القياسي بس لو فيه تاريخ استخدام فعلي (يوم سابق واحد
    // على الأقل)، عشان مانعرضش "الرقم القياسي: 0" في أول يوم استخدام
    if (personalBestEl) {
        const displayedBest = Math.max(appState.previousBestSteps, appState.steps);
        if (appState.previousBestSteps > 0 || appState.recordBrokenToday) {
            personalBestEl.textContent = `رقمك القياسي: ${displayedBest.toLocaleString()} خطوة`;
            personalBestEl.classList.remove('hidden');
        } else {
            personalBestEl.classList.add('hidden');
        }
    }
}

/** الاستجابة لأي زيادة في الخطوات (سواء جاية من زر المحاكاة أو حساس حقيقي) */
function handleStepsIncrease(delta) {
    // منع احتساب أي خطوات/نقاط فعليًا في وضع الزائر (مفيش حساب شخصي
    // داخل بيه المستخدم - window.isGuestMode بيتحدد في geofence.js عبر
    // applyGuestModeRestrictions، حسب حالة تسجيل الدخول بس، مش حسب
    // الموقع الجغرافي - شوف اختيار 2 في initSharedUIBridge/initApp).
    // ملحوظة: ده طبقة UX بس، الإلزام الحقيقي لازم يبقى على مستوى
    // Supabase (RLS/SECURITY DEFINER) زي ما موضح في geofence.js.
    if (window.isGuestMode) return;

    // (جديد) وصلنا لسقف الأمان اليومي بالفعل - مفيش أي تسجيل إضافي خالص
    // (ده سقف أمان مش سقف تحفيزي، محدش حقيقي هيوصله في الاستخدام الطبيعي)
    if (appState.steps >= HARD_DAILY_STEPS_CAP) return;

    const finalTarget = STAGE_MILESTONES[STAGE_MILESTONES.length - 1];
    const wasAtFinalStage = appState.stageIndex === STAGE_MILESTONES.length - 1;
    const currentTarget = getCurrentStageTarget();

    // (جديد) العداد بقى بيكمل بعد هدف الـ10,000 (بدل ما يقف عنده زي
    // قبل كده) لحد سقف الأمان بس (50,000) - مراحل STAGE_MILESTONES نفسها
    // (الشريط البصري) بتفضل واقفة عند آخر مرحلة زي ما هي، لكن العداد
    // الحقيقي والنقاط يكملوا يتحسبوا وراها لحد السقف
    const addedSteps = Math.min(delta, HARD_DAILY_STEPS_CAP - appState.steps);
    const stepsBeforeUpdate = appState.steps;

    appState.steps += addedSteps;

    // بنحسب النقاط بمقارنة "عدد النقاط الكامل المفروض يبقى موجود لحد
    // دلوقتي" (floor(steps / STEPS_PER_POINT)) قبل وبعد الزيادة دي -
    // بدل ما نقرّب كل زيادة صغيرة لوحدها (Math.round(addedSteps / 200)،
    // اللي ممكن يضيّع خطوات فعلية لو الزيادات بتوصل صغيرة ومتكررة (زي
    // حساس حركة بيبعت كل خطوة لوحدها - كل زيادة 1 خطوة كانت هتتقرب لصفر
    // نقطة كل مرة وتضيع الترقيم كله عملياً). الطريقة دي (فرق التقسيم
    // الصحيح) بتضمن مفيش أي نقطة تتفقد أو تتزود غلط مهما كان حجم/عدد
    // الاستدعاءات - وبتفضل شغالة بعد الـ10,000 كمان بنفس الدقة تماماً
    const earnedPoints = Math.floor(appState.steps / STEPS_PER_POINT) - Math.floor(stepsBeforeUpdate / STEPS_PER_POINT);
    appState.earnedFromSteps += earnedPoints;

    // بيحفظ خطوات اليوم مع كل خطوة أصلاً في sensors.js (persistDailyState)
    // - مفيش داعي أي نسخة تانية هنا، شوف getStepsHistory() فوق

    // هل عدّى مرحلة (أو أكتر من مرحلة دفعة واحدة)؟ بس لو لسه مش واصل
    // لآخر مرحلة أصلاً - لو وصلها بالفعل، الفهرس بيفضل ثابت عندها ومفيش
    // داعي نعيد حسابه مع كل خطوة زيادة بعد كده (وإلا هيتكرر توست "خلصت
    // المرحلة" مع كل خطوة، غلط)
    const justCompletedStage = !wasAtFinalStage && appState.steps >= currentTarget;
    if (justCompletedStage) {
        // (جديد) بنلقط فهرس المرحلة اللي اتخطيناها للتو *قبل* ما نحدّث
        // appState.stageIndex للمرحلة الجاية - عشان نعرف نحط الاحتفال
        // البصري على النقطة الصح (شوف triggerStageDotCelebration)
        const completedStageIndex = appState.stageIndex;
        appState.stageIndex = getStageIndexForSteps(appState.steps);
        triggerStageDotCelebration(completedStageIndex);
    }

    // (تعديل) حساب "تنبيه قربت من المرحلة الجاية" (shouldNudgeNearStage/
    // remainingInStage/nearNudgeShownStageIndex) اتشال بالكامل من هنا -
    // كان الغرض الوحيد منه توست "قربت! باقيلك X خطوة..." اللي اتشال
    // بناءً على طلب صريح، فمعاه اتشال الحساب والمتغيرات المرتبطة بيه
    // (appState.nearNudgeShownStageIndex وNEAR_STAGE_STEPS_THRESHOLD)
    // عشان منسيبش كود ميت

    // كسر الرقم القياسي الشخصي - مرة واحدة بس في اليوم، وبس لو فيه رقم
    // قياسي حقيقي أصلاً من يوم سابق (مش أول يوم استخدام)
    const justBrokeRecord = !appState.recordBrokenToday
        && appState.previousBestSteps > 0
        && appState.steps > appState.previousBestSteps;
    if (justBrokeRecord) {
        appState.recordBrokenToday = true;
    }

    // (جديد) "وصلت لهدف العشرة آلاف" - مرة واحدة بس في اليوم (أول لحظة
    // يوصل/يعدّي فيها الهدف)، مش مع كل خطوة بعد كده
    const justReachedFinalTarget = !appState.reachedDailyGoalToday && appState.steps >= finalTarget;
    if (justReachedFinalTarget) {
        appState.reachedDailyGoalToday = true;
    }

    // (جديد) وصل لسقف الأمان اليومي دلوقتي بالظبط (أول مرة) - توست
    // إعلامي مرة واحدة بس، بعد كده handleStepsIncrease هترجع فوراً من
    // أول سطر في الدالة من غير أي توست تاني
    const justHitHardCap = !appState.hitHardCapToday && appState.steps >= HARD_DAILY_STEPS_CAP;
    if (justHitHardCap) {
        appState.hitHardCapToday = true;
    }

    updateStepsUI();
    playSound('step');

    // بنبلّغ js/profiles.js بالتقدم الحقيقي ده عن طريق حدث مخصص (بدل
    // استيراد مباشر) عشان يحفظه في Supabase (total_steps/daily_steps/
    // points) ويحسب الستريك - نفس فلسفة الأحداث المستخدمة في باقي
    // التطبيق (app:toast، geofence:guest-mode-change..إلخ)
    document.dispatchEvent(new CustomEvent('steps:progress', {
        detail: { addedSteps, pointsEarned: earnedPoints },
    }));

    // ترتيب أولوية الرسايل: كسر رقم قياسي > سقف الأمان > هدف اليوم
    // النهائي > مرحلة جديدة (كونفيتي بس من غير توست - شوف الملحوظة تحت)
    // - عشان ميحصلش زحمة توستات فوق بعض
    if (justBrokeRecord) {
        showToast(`ده رقمك القياسي الجديد! أعلى خطوات وصلتها في يوم واحد!`);
        triggerConfetti();
    } else if (justHitHardCap) {
        showToast(`جامد أوي! وصلت لأقصى حد تسجيل يومي (${HARD_DAILY_STEPS_CAP.toLocaleString()} خطوة)!`);
        triggerConfetti();
    } else if (justReachedFinalTarget) {
        // (إصلاح) كان النص هنا ثابت "10,000" وده كان بيبقى غلط دلوقتي
        // بعد ما آخر مرحلة بقت 30,000 (أو أي رقم تاني يتغيّر بعد كده) -
        // بنستخدم finalTarget نفسه (آخر قيمة في STAGE_MILESTONES) عشان
        // النص يفضل صح مهما اتغيّرت المراحل من غير ما نستنى ننسى نعدّله هنا كمان
        showToast(`الله ينور! وصلت لهدف الـ ${finalTarget.toLocaleString()} خطوة النهاردة!`);
        triggerConfetti();
    } else if (justCompletedStage) {
        // (تعديل) توست "جامد! خلصت المرحلة..." اتشال بناءً على طلب صريح -
        // سايبين الكونفيتي لوحدها كاحتفال بصري خفيف بخلاص المرحلة من غير
        // نص يقاطع المستخدم في كل مرحلة يعديها
        triggerConfetti();
    }
    // (تعديل) الرسائل دي اتشالت بالكامل بناءً على طلب صريح:
    //   - "عاش! أضفت X خطوة وقرّبت من الهدف!" (كانت بتتكرر مع كل خطوة تقريباً)
    //   - "قربت! باقيلك X خطوة بس للمرحلة الجاية!" (shouldNudgeNearStage)
    //   - "تجاوزت الهدف! ضفت X خطوة زيادة، كمّل كده!" (wasAtFinalStage)
    // باقي الحالات فوق (رقم قياسي/سقف يومي/هدف نهائي/مرحلة جديدة) لسه
    // شغالة عادي لأنها بتمثل إنجاز فعلي واضح مش أي تحديث عادي.
}

/**
 * (إصلاح - باج حقيقي) الاستجابة لمزامنة "صامتة" لعدد خطوات اليوم قادمة
 * من صف البروفايل في Supabase (daily_steps عبر reconcileWithServerSteps
 * في sensors.js) - مش من حساس حركة حقيقي. بتحصل مرة واحدة عند تحميل
 * البروفايل (بعد تسجيل الدخول من أي جهاز)، عشان لو المستخدم سجّل
 * خطوات النهاردة من جهاز تاني، العداد هنا يبدأ من نفس تقدمه الحقيقي
 * بدل ما يبدأ من صفر.
 * ⚠️ بعكس handleStepsIncrease، الدالة دي *مبتبعتش* حدث 'steps:progress'
 * عن قصد - الخطوات دي أصلاً محفوظة في Supabase (هي مصدرها الأساسي)،
 * فلو بعتناها تاني كـ"جديدة" لـ profiles.js كانت هتتضاف فوق نفسها في
 * total_steps/points (تضاعف حقيقي) في كل مرة يتفتح فيها جهاز جديد.
 * الدالة دي بس بتزبط *العرض المحلي* (appState) والأعلام المرتبطة بيه
 * (رقم قياسي/هدف اليوم/سقف الأمان) عشان تفضل متسقة مع الرقم الجديد.
 */
// (إصلاح - باج حقيقي) اتشال شرط "newSteps <= appState.steps" اللي كان
// بيرفض أي resync أقل من الرقم الظاهر - ده كان صح وقت افتراض إن
// المستخدم نفسه بيتنقل بين أجهزته بس (فمينفعش يتراجع للخلف)، لكن بعد
// إصلاح تبديل الحسابات (syncActiveUser في sensors.js)، resync ممكن
// دلوقتي "ينزل" الرقم فعلاً (حساب تاني له تقدم أقل على نفس الجهاز)،
// فلازم دايمًا نصدّق الرقم الجاي من السيرفر كامل - مش بس لو كان أكبر
function applySilentStepsResync(newSteps) {
    if (typeof newSteps !== 'number' || newSteps === appState.steps) return;

    appState.steps = newSteps;
    appState.stageIndex = getStageIndexForSteps(appState.steps);
    appState.earnedFromSteps = Math.floor(appState.steps / STEPS_PER_POINT);

    // بنعيد حساب الأعلام دي بالكامل من الصفر (مش بس "نفعّلها")، عشان لو
    // الرقم الجديد نزل (حساب تاني بتقدم أقل)، مينفعش تفضل الأعلام شايلة
    // true من الحساب القديم غلط
    const finalTarget = STAGE_MILESTONES[STAGE_MILESTONES.length - 1];
    appState.recordBrokenToday = appState.previousBestSteps > 0 && appState.steps > appState.previousBestSteps;
    appState.reachedDailyGoalToday = appState.steps >= finalTarget;
    appState.hitHardCapToday = appState.steps >= HARD_DAILY_STEPS_CAP;

    updateStepsUI();
}

/**
 * (إصلاح - باج حقيقي): لما المستخدم يدخل/يترجّع لوضع الزائر (سواء بعد
 * تسجيل خروج فعلي من حساب كان شغال بيه، أو بالضغط على "تصفح كزائر")،
 * كان عداد الخطوات الظاهر في الواجهة (appState.steps + عنصر #stepCount)
 * بيفضل شايل آخر رقم كان ظاهر لصاحب الحساب اللي خرج - بس متعتّم بصريًا
 * (كلاس guest-locked من setStepsCounterMutedVisual في geofence.js) - مش
 * بيترجع لصفر فعليًا. السبب: applyGuestModeRestrictions بتعتّم العنصر
 * بصريًا بس، وsyncActiveUser(null) (اللي بيصفّر العداد الداخلي في
 * sensors.js) بتتنادى في بعض المسارات بس (initProfileUI(null))، وفي كل
 * الحالتين محدش كان بيرجع يحدّث appState.steps نفسها أو يعيد رسم
 * updateStepsUI() بعد التصفير - فالرقم القديم فضل عالق على الشاشة.
 *
 * الحل: كل مرة يتأكد فيها إننا في وضع الزائر فعليًا (حدث
 * 'geofence:guest-mode-change' بـ isGuestMode = true من geofence.js)،
 * بنصفّر العداد المحلي في sensors.js (syncActiveUser(null) - نفس تصفير
 * تبديل الحساب تمامًا، مأمون حتى لو اتنادت أكتر من مرة لنفس الحالة)
 * وبعدين بنصفّر appState.steps وكل الأعلام المرتبطة بيه هنا في app.js
 * ونعيد رسم الواجهة فورًا - عشان الزائر يشوف صفر حقيقي دايمًا، مش رقم
 * حساب سابق متعتّم بس.
 */
function resetStepsUIForGuestMode() {
    syncActiveUser(null);

    appState.steps = 0;
    appState.stageIndex = getStageIndexForSteps(0);
    appState.earnedFromSteps = 0;
    appState.previousBestSteps = 0;
    appState.recordBrokenToday = false;
    appState.reachedDailyGoalToday = false;
    appState.hitHardCapToday = false;

    updateStepsUI();
}

function initStepsCounter() {
    renderStageDotsSkeleton(); // (جديد) بناء نقط المراحل مرة واحدة بس
    updateStepsUI();

    // الاستماع لأي خطوات جاية لايف من js/sensors.js (حساس الحركة الحقيقي فقط)
    document.addEventListener('sensors:steps-update', (event) => {
        handleStepsIncrease(event.detail.delta);
    });

    // (إصلاح - باج حقيقي) الاستماع لمزامنة العداد مع daily_steps القادمة
    // من Supabase وقت تحميل البروفايل - شوف applySilentStepsResync فوق
    document.addEventListener('sensors:steps-resynced', (event) => {
        applySilentStepsResync(event.detail.steps);
    });
}

/* ------------------------------------------------------------------
   4) التحدي اليومي (الأسئلة)
   ------------------------------------------------------------------
   تحدي الذكاء اليومي القديم (سؤال ديني + سؤال معلومات عامة، كارتي
   q1-card/q2-card في index.html، وأزرار quiz-btn) اتشال نهائياً من
   هنا - بقى عندنا تحدي يومي واحد بس هو "السؤال اليومي" المُدار بالكامل
   من js/daily-question.js (initDailyQuestionCard() في initApp تحت).
   ------------------------------------------------------------------ */


/* ------------------------------------------------------------------
   5) أدوات واجهة مشتركة (Toast / صوت / كونفيتي)
   ملحوظة: لوحة الصدارة (الفلترة، الجلب، والعرض) بقت مقسّمة بين
   js/leaderboard.js (initChampionshipTabs / refreshActiveLeaderboard -
   الجلب والرسم الفعلي من get_leaderboard) وjs/profiles.js
   (initLeaderboardUI - نقطة الدخول اللي بتتنادى من initApp، وخانة
   البحث) - متضفش أي منطق ليدربورد هنا تاني.
   تُستخدم داخلياً هنا، وبتتاح لباقي الوحدات عبر حدث 'app:toast'
   عشان نتجنب استيراد app.js من جوه auth.js أو stories.js..إلخ
   ------------------------------------------------------------------ */
/**
 * (إصلاح - باج حقيقي): كانت الدالة دي no-op عمدًا (شوف تاريخ التعليق
 * القديم تحت) عشان الرسالة كانت بتترسم مرتين - مرة هنا، ومرة تانية في
 * renderToast() بتاعة auth.js، وكلاهما مسجّل مستمع على نفس حدث
 * 'app:toast'. الحل الصح مكانش تعطيل التوست بالكامل، كان لازم يبقى
 * فيه *مصدر واحد بس* يرسم فعليًا. دلوقتي الدالة دي هي المصدر الوحيد
 * (renderToast() في auth.js فضلت no-op عمدًا - متتلمسش تاني ولا
 * ترجّعها تشتغل، عشان منرجعش لمشكلة الرسم المزدوج القديمة).
 *
 * الاستخدام زي الأول بالظبط: حدث عام 'app:toast' من أي ملف في
 * التطبيق (geofence.js، profiles.js، auth.js..إلخ) - مفيش أي تغيير
 * مطلوب في أي مكان تاني غير الملف ده.
 *
 * @param {string} message
 */
function showToast(message) {
    if (!message) return;

    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.className = [
        'pointer-events-auto w-full rounded-2xl px-4 py-3',
        'text-xs font-bold text-center leading-relaxed',
        'bg-lux-900/95 text-lux-50 border border-gold-500/20',
        'shadow-soft-card backdrop-blur-md',
        'opacity-0 -translate-y-2 transition-all duration-300 ease-out',
    ].join(' ');
    toast.textContent = message;

    container.appendChild(toast);

    // فريم إضافي قبل شيل opacity-0 عشان الـ transition يشتغل فعليًا
    // (نفس تقنية onb-auth-page-visible في onboarding.js)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            toast.classList.remove('opacity-0', '-translate-y-2');
        });
    });

    const TOAST_VISIBLE_MS = 3000;
    const TOAST_FADE_MS = 300;

    window.setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        window.setTimeout(() => toast.remove(), TOAST_FADE_MS);
    }, TOAST_VISIBLE_MS);
}

/**
 * كانت بتشغّل نغمات قصيرة عبر Web Audio API لكل الحالات (صح/غلط/خطوة/
 * إشعار) - اتلغت كلها بناءً على طلب صريح، وبعدين رجّعنا نغمة الإشعار
 * بس ('notify') بناءً على طلب تاني، عشان المستخدم يتنبّه لما إشعار
 * جديد يوصله. باقي الحالات (correct/wrong/step) لسه no-op زي ما هي.
 * @param {string} type
 */
function playSound(type) {
    if (type !== 'notify') return;

    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;

        // نغمة إشعار قصيرة وهادئة (نغمتين متصاعدتين) - تُستخدم من
        // js/notifications.js لما إشعار جديد يوصل لحظياً عبر Realtime
        osc.type = 'sine';
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.setValueAtTime(880, now + 0.09);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.28);
    } catch (err) {
        // فشل تشغيل الصوت (مثلاً المتصفح مانع التشغيل التلقائي) - نتجاهله بهدوء
    }
}

/** انفجار كونفيتي احتفالي بسيط عبر Canvas بدون أي مكتبات خارجية */
function triggerConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const pieces = [];
    const colors = ['#D4AF37', '#14b8a6', '#F2D77E', '#fb7185', '#10b981'];

    for (let i = 0; i < 70; i++) {
        pieces.push({
            x: canvas.width / 2,
            y: canvas.height / 2,
            vx: (Math.random() - 0.5) * 12,
            vy: (Math.random() - 0.7) * 14,
            size: Math.random() * 8 + 4,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 10,
        });
    }

    let opacity = 1;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pieces.forEach((p) => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.3; // الجاذبية
            p.rotation += p.rotSpeed;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = opacity;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
        });

        opacity -= 0.015;
        if (opacity > 0) {
            requestAnimationFrame(animate);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    animate();
}

/* ------------------------------------------------------------------
   المرحلة 1: تتبع الزوار والمستخدمين النشطين
   ------------------------------------------------------------------
   جزءين منفصلين:
     أ) تسجيل الزيارة نفسها في visitor_sessions - مرة واحدة لكل جهاز
        لكل يوم (upsert بـ ignoreDuplicates بدل تحديث، عشان الـ RLS
        محتاجة صلاحية INSERT بس - شوف sql/phase-1-visitors.sql).
     ب) نبضة حياة (heartbeat) بسيطة لـ last_seen_at/is_online على
        profiles - بس للمستخدمين المسجلين (الزوار العابرين مالهمش صف
        في profiles أصلاً). ده نظام منفصل تماماً عن نبضة "الجلسة
        الواحدة" (HEARTBEAT_INTERVAL_MS) الموجودة في auth.js - تلك
        بتتحقق مين ماسك مقعد الجهاز، ودي بس بتقول للأدمن "المستخدم ده
        فاتح التطبيق دلوقتي فعلاً ولا لأ".
   ------------------------------------------------------------------ */

/** المفتاح المستخدم لتخزين بصمة جهاز/زيارة ثابتة في localStorage - نفس
 *  فلسفة GUEST_MODE_STORAGE_KEY/DEVICE_SESSION_STORAGE_KEY في auth.js،
 *  بس بمفتاح منفصل عشان الغرض مختلف (عدّ الزوار، مش الجلسة الواحدة) */
const VISITOR_SESSION_STORAGE_KEY = 'sakkawy-visitor-session-id';

/** كل قد إيه بنحدّث last_seen_at/is_online للمستخدم المسجل دخول دلوقتي */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // دقيقتين

/** الـ interval id بتاع نبضة الحضور الحالية (لو فيه مستخدم مسجل دخول) */
let presenceHeartbeatIntervalId = null;

/** الـ id بتاع المستخدم المسجل دخول دلوقتي على الجهاز ده (null لو زائر/مفيش حد) */
let presenceCurrentUserId = null;

/**
 * بترجع بصمة الزيارة الثابتة للجهاز الحالي، وتولّد وحدة جديدة وتخزنها
 * لو ده أول مرة - بنفس أسلوب getOrCreateDeviceSessionId في auth.js
 * @returns {string}
 */
function getOrCreateVisitorSessionId() {
    try {
        let id = window.localStorage.getItem(VISITOR_SESSION_STORAGE_KEY);
        if (!id) {
            id = (window.crypto && typeof window.crypto.randomUUID === 'function')
                ? window.crypto.randomUUID()
                : `visit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            window.localStorage.setItem(VISITOR_SESSION_STORAGE_KEY, id);
        }
        return id;
    } catch (err) {
        // لو localStorage مش متاح (تصفح خاص محظور فيه مثلاً)، بنرجع بصمة
        // مؤقتة لحظة التشغيل عشان الميزة متكسرش باقي التطبيق
        console.error('تعذر قراءة/تخزين بصمة الزيارة:', err);
        return `visit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

/**
 * تسجّل زيارة اليوم للجهاز الحالي في visitor_sessions - upsert بـ
 * ignoreDuplicates عشان محتاجين صلاحية INSERT بس (مش UPDATE) تحت RLS،
 * فمفيش تعارض لو الجدول فيه صف اليوم ده بالفعل لنفس الجهاز
 * @param {string|null} userId - id المستخدم لو مسجل دخول، أو null لو زائر عابر
 */
async function registerVisitorSession(userId) {
    const sessionId = getOrCreateVisitorSessionId();

    const { error } = await supabaseClient
        .from('visitor_sessions')
        .upsert(
            { session_id: sessionId, user_id: userId || null },
            { onConflict: 'session_id,visit_date', ignoreDuplicates: true }
        );

    if (error) {
        // فشل تسجيل الزيارة مش لازم يوقف أو يأثر على تجربة المستخدم
        // خالص - مجرد إحصائية للأدمن، فبنكتفي بتسجيلها في الكونسول
        console.error('تعذر تسجيل الزيارة في visitor_sessions:', error.message);
    }
}

/**
 * تحدّث last_seen_at/is_online لصف المستخدم الحالي - تحديث مباشر
 * (مش RPC) لأن العمودين دول مش من ضمن الأعمدة المحمية في
 * prevent_unauthorized_profile_field_updates (شوف sql/phase-1-visitors.sql)
 * @param {string} userId
 */
async function updatePresenceHeartbeat(userId) {
    const { error } = await supabaseClient
        .from('profiles')
        .update({ last_seen_at: new Date().toISOString(), is_online: true })
        .eq('id', userId);

    if (error) {
        console.error('تعذر تحديث نبضة الحضور:', error.message);
    }
}

/**
 * تبدأ نبضة الحضور الدورية لمستخدم مسجل دخول - نبضة فورية أول مرة،
 * وبعدين كل PRESENCE_HEARTBEAT_INTERVAL_MS بس لو التاب في المقدمة
 * (document.visibilityState === 'visible')، عشان منستهلكش طلبات شبكة
 * وهو التاب في الخلفية أو مقفول
 * @param {string} userId
 */
function startPresenceHeartbeat(userId) {
    stopPresenceHeartbeat();
    presenceCurrentUserId = userId;
    updatePresenceHeartbeat(userId);

    presenceHeartbeatIntervalId = window.setInterval(() => {
        if (document.visibilityState === 'visible') {
            updatePresenceHeartbeat(userId);
        }
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
}

/** توقف نبضة الحضور الحالية (لو شغالة) - بتتنادى عند تسجيل الخروج */
function stopPresenceHeartbeat() {
    if (presenceHeartbeatIntervalId) {
        window.clearInterval(presenceHeartbeatIntervalId);
        presenceHeartbeatIntervalId = null;
    }
}

/**
 * تحاول تعلّم is_online = false لصف المستخدم - محاولة أفضل جهد (Best
 * Effort) بس، لأن beforeunload مش مضمون تماماً (خصوصاً على الموبايل).
 * لو محصلتش (تاب اتقفل فجأة)، الحماية الاحتياطية هي فحص حداثة
 * last_seen_at في admin.js (شوف ONLINE_FRESHNESS_THRESHOLD_MS) بدل ما
 * نعتمد على is_online لوحده
 * @param {string} userId
 */
function markUserOffline(userId) {
    supabaseClient
        .from('profiles')
        .update({ is_online: false })
        .eq('id', userId)
        .then(({ error }) => {
            if (error) console.error('تعذر تحديث حالة عدم الاتصال:', error.message);
        });
}

/**
 * تربط استماع visibilitychange (تحديث فوري لما المستخدم يرجع للتاب
 * بعد ما كان في الخلفية) - نبضة الـ interval الدورية نفسها متكفلة
 * بالتحديثات وهو فاتح التاب باستمرار
 */
function initVisitorPresenceTracking() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && presenceCurrentUserId) {
            updatePresenceHeartbeat(presenceCurrentUserId);
        }
    });

    window.addEventListener('beforeunload', () => {
        if (presenceCurrentUserId) {
            markUserOffline(presenceCurrentUserId);
        }
    });
}

/** ربط باقي الوحدات (auth, geofence, profiles) بأدوات الواجهة المشتركة عبر الأحداث */
function initSharedUIBridge() {
    document.addEventListener('app:toast', (event) => showToast(event.detail.message));
    document.addEventListener('app:sound', (event) => playSound(event.detail.type));

    // (تعديل) مستمع 'profiles:badge-unlocked' (توست "مبروك! فتحت وسام..."
    // + كونفيتي) اتشال بالكامل بناءً على طلب صريح - فتح الوسام أصلاً بيوصل
    // كإشعار حقيقي دائم في جرس الإشعارات (نوع achievement_unlocked، شوف
    // notifications.js) فمفيش داعي لتوست إضافي فوقي بيكرر نفس الخبر لحظياً.
    // الحدث 'profiles:badge-unlocked' نفسه لسه بيتبعت من profiles.js (مفيدة
    // لإعادة رسم شبكة الأوسمة في الواجهة لو محتاجين)، بس مفيش حد بيسمعه
    // هنا في app.js تاني لعرض أي توست/كونفيتي.

    // ملحوظة (إصلاح): كان في هنا قبل كده مستمع لحدث 'geofence:status-change'
    // (حدث مش موجود أصلاً - اسمه غلط وسبب كوده إن التوست ده متعملش أبداً).
    // الحدث الحقيقي اللي js/geofence.js بيطلقه فعلياً اسمه
    // 'geofence:guest-mode-change' (تفاصيله: { isGuestMode, isAllowed })،
    // وهو بالفعل بيطلق توست خاص بيه بنص أوضح (شوف applyGuestModeRestrictions
    // في geofence.js) في كل مرة تتغيّر فيها الحالة فعلياً - فمفيش داعي
    // لمستمع مكرر هنا تاني، فاتشال بالكامل بدل ما يتصلح لحدث مكرر.

    // ملاحظة مهمة: initProfileUI (في js/profiles.js) بقت هي المسؤولة
    // بالكامل عن جلب وعرض الإحصائيات الحقيقية (total_steps, الاسم،
    // الصورة..إلخ) من جدول profiles على Supabase. متنادوش على
    // updateProfileStats هنا بأرقام تانية (زي appState.steps أو أرقام
    // ثابتة) عشان كده مش هيسبب Race Condition بيكتب فوق البيانات
    // الحقيقية بمجرد ما توصل من الشبكة.
    // (تحديث - اختيار 2 لفصل وضع الزائر عن الحساب الشخصي): بطّلنا
    // نهائيًا ربط وضع الزائر/القيود بأي فحص جغرافي (GPS) بعد تسجيل
    // الدخول. الفحص الجغرافي (GPS + استدعاء Supabase) بقى مقصور على
    // حالة واحدة بس: قبل إنشاء حساب جديد (checkLocationForSignup في
    // js/geofence.js، بيتنادى من js/onboarding.js وjs/auth.js). بعد
    // كده، "وضع الزائر" بقى معتمد حصريًا على: هل المستخدم داخل بحساب
    // شخصي فعلي ولا لأ - مش على مكانه الجغرافي.
    //
    // لما مستخدم يضغط "تصفح كزائر" من بوابة الدخول (زي بعد تسجيل
    // الخروج أو من آخر سلايد ترحيب)، بنطبّق قيود وضع الزائر مباشرة
    // (isAllowed = false) من غير أي طلب GPS خالص.
    document.addEventListener('app:enter-guest-browsing', () => {
        applyGuestModeRestrictions(false);

        // زائر عابر (مالوش صف في profiles) - نسجّل الزيارة بس، من غير
        // أي نبضة حضور (heartbeat) لأنه مفيش last_seen_at/is_online
        // نحدّثهم أصلاً لزائر من غير حساب
        registerVisitorSession(null);
    });

    // (إصلاح - باج حقيقي): لغاية دلوقتي مكانش فيه أي مستمع لحدث
    // 'auth:signed-out' هنا خالص. يعني لما مستخدم كان مسجل دخول (وقاعد
    // شايف بروفايله الحقيقي + ستوريهاته + كل عناصر التحكم الفعلية اللي
    // initProfileUI(user) رسمتها وقت auth:login) يعمل تسجيل خروج فعلي،
    // ولا حاجة كانت بتمسح أو تعيد تصفير الـ DOM بتاع البروفايل/الستوريز
    // ده. applyGuestModeRestrictions(isGuestMode=true) وحدها بتقفل بس
    // العناصر الموسومة data-requires-membership (زرارين السؤال اليومي
    // حاليًا) - مش بتشيل أو تصفّر أي بيانات حساب سابق فعليًا معروضة على
    // الشاشة. فلو المستخدم بعد كده دخل "تصفح كزائر"، كان لسه شايف نفس
    // البروفايل القديم وقادر يتفاعل مع عناصره (تعديل بروفايل، ستوري..)
    // لأنها فضلت زي ما هي من غير أي Reset - مش لأن فيه Session حقيقية
    // لسه شغالة (auth.js فعليًا بتعمل signOut حقيقي وتصفّر currentUser).
    // الإصلاح: أول ما 'auth:signed-out' يتطلق، نصفّر واجهة البروفايل
    // فورًا (initProfileUI(null) بنفس النمط المستخدم وقت initApp لمستخدم
    // من غير جلسة) ونتأكد إن قيود وضع الزائر مفعّلة فورًا كمان.
    document.addEventListener('auth:signed-out', () => {
        initProfileUI(null);
        applyGuestModeRestrictions(false);

        // وقف نبضة الحضور وتعليم المستخدم "أوفلاين" فورًا - قبل ما
        // presenceCurrentUserId يتصفّر، وإلا مش هنعرف نعدّل صف مين
        if (presenceCurrentUserId) {
            markUserOffline(presenceCurrentUserId);
        }
        stopPresenceHeartbeat();
        presenceCurrentUserId = null;
    });

    // (المرحلة 1) auth:signed-in بتتطلق من auth.js في الحالتين: تسجيل
    // دخول فعلي جديد (SIGNED_IN) *و* استرجاع جلسة محفوظة من زيارة
    // سابقة (INITIAL_SESSION) - وده بالظبط اللي محتاجينه هنا: كل مرة
    // مستخدم مسجل يفتح التطبيق، تتسجل زيارة (upsert يوم واحد بيتجاهل
    // التكرار لو الجهاز فتح التطبيق أكتر من مرة في نفس اليوم) وتبدأ
    // نبضة الحضور. مش بنستخدم 'auth:login' هنا (رغم إنه بيتطلق في نفس
    // اللحظة تقريباً) عشان نفصل منطق "الزيارة/الحضور" عن منطق "تحديث
    // واجهة البروفايل" اللي auth:login مخصص له أصلاً تحت
    document.addEventListener('auth:signed-in', (event) => {
        const user = event.detail && event.detail.user;
        if (user && user.id) {
            registerVisitorSession(user.id);
            startPresenceHeartbeat(user.id);
        }
    });

    document.addEventListener('auth:login', (event) => {
        initProfileUI(event.detail.user);

        // (تحديث - اختيار 2): تسجيل الدخول بحساب شخصي = وصول كامل
        // فورًا، من جوه نطاق نزلة عبيد أو برّه، من غير أي فحص GPS أو
        // طلب إذن موقع خالص. الهدف الوحيد لكونه "داخل بحساب" إنه يقدر
        // يعمل كل حاجة: يحل الأسئلة، خطواته تتحسب، يتحكم في حسابه، يضيف
        // أصدقاء، يوصله إشعارات، يعمل ستوري ويتفاعل مع ستوريهات الناس.
        if (event.detail.user && event.detail.user.id) {
            applyGuestModeRestrictions(true);
        }
    });

    // (إصلاح - باج "فلاش وضع الزائر لمستخدم مسجل دخول"): ده المصدر
    // الوحيد الآمن لتفعيل قيود وضع الزائر (شريط "بتتصفح كزائر" + قفل
    // ميزات العضوية) لما مفيش حساب. js/auth.js بيطلق الحدث ده مرة واحدة
    // بس بعد ما يتأكد فعليًا من Supabase (مش من قراءة متفائلة سريعة)
    // إن مفيش جلسة خالص - شوف dispatchConfirmedSignedOut/checkExistingSession
    // في js/auth.js. قبل الإصلاح ده، initApp() كانت بتطبّق وضع الزائر
    // فورًا بناءً على restoreSession() (قراءة متفائلة من localStorage)،
    // واللي ممكن ترجع null للحظة حتى لو فيه جلسة حقيقية شغالة فعلاً -
    // فمستخدم مسجل دخول كان بيشوف شريط الزائر يفلاش لحظة عند كل Refresh
    // قبل ما auth:login يرجّع كل حاجة لوضعها الصح.
    document.addEventListener('auth:confirmed-signed-out', () => {
        applyGuestModeRestrictions(false);
    });

    // (إصلاح - باج حقيقي) شوف تعليق resetStepsUIForGuestMode فوق: مصدر
    // واحد موثوق لتصفير عداد الخطوات المعروض فعليًا (مش بس تعتيمه
    // بصريًا) في كل مرة نتأكد فيها إننا دخلنا/رجعنا لوضع الزائر -
    // بيغطي كل المسارات (تسجيل خروج، الضغط على "تصفح كزائر"..إلخ) من
    // غير ما نكرر نفس منطق التصفير في كل مسار لوحده.
    document.addEventListener('geofence:guest-mode-change', (event) => {
        if (event.detail && event.detail.isGuestMode) {
            resetStepsUIForGuestMode();
        }
    });
}

/* ------------------------------------------------------------------
   6) نقطة انطلاق التطبيق
   ------------------------------------------------------------------ */
function initApp() {
    // (خطة الأوفلاين - القسم 5) أول سطر تقريباً بنفس منطق initTheme()
    // تحت - بس بيسجّل مستمع 'online' على window ويطلق حدث 'app:online'
    // مخصّص على document كل ما النت يرجع، عشان أي ملف تاني (لو حب
    // يستخدمها لاحقاً) يقدر يسمعه من غير ما يكرر addEventListener بنفسه
    initNetworkStatusWatcher();

    // بتتنادى الأول عشان تطبّق تفضيل المستخدم (داكن/فاتح) بأسرع وقت ممكن
    // وتقلل احتمال ظهور "ومضة" لونية قبل ما باقي الواجهة تتظبط. بتتنادى
    // حتى لو شاشات الترحيب هتظهر بعدها، عشان خلفية الصفحة اللي وراء
    // الـ Overlay تبقى صحيحة من أول لحظة
    initTheme();

    // (تصحيح مهم): bindAuthEventListeners() لازم تتنادى *قبل* initOnboarding()
    // مباشرة، مش بعد ما شاشات الترحيب تخلّص. ده اللي بيربط submit handler
    // فورم #authModal (وباقي أحداث المصادقة) - وفورم الدخول/التسجيل ده
    // نفسه هو اللي بيظهر جوه "صفحة الدخول" الكاملة في آخر سلايد ترحيب
    // (شوف js/onboarding.js: revealAuthForm). قبل التصحيح ده كانت
    // bindAuthEventListeners() بتتنادى بس *جوه* initOnboarding().then()
    // (عن طريق initAuthUI() القديمة) - يعني بعد ما شاشة الترحيب تخلّص
    // خالص - فأول مرة مستخدم يضغط "إنشاء حساب"/"تسجيل الدخول" من آخر
    // سلايد ويدوس على زرار التأكيد، الفورم مكانش عليه أي submit listener
    // شغال خالص، فالمتصفح كان بيعمل Native Form Submit عادي (إعادة تحميل
    // كاملة للصفحة من غير أي طلب فعلي لـ Supabase) بدل ما يتنفذ كود
    // signUpWithUsername/signInWithUsername - وده بالظبط سبب رجوع
    // المستخدم لأول سلايد وطلب التسجيل من جديد: markOnboardingSeen()
    // في finish() (js/onboarding.js) محصلش خالص قبل الـ Reload، فـ
    // hasSeenOnboarding() طلعت false تاني وأعادت عرض الشاشات من الأول.
    bindAuthEventListeners();

    // شاشات الترحيب (Onboarding) - أول مرة بس (js/onboarding.js بيتحكم
    // في ده عن طريق localStorage). باقي تهيئة التطبيق اتأجلت لحد ما
    // المستخدم يخلّص منها أو يتخطاها، عشان لو اختار "إنشاء حساب" أو
    // "تسجيل دخول" من آخر سلايد، نقدر نفتح authModal الحقيقي (كمودال
    // منبثق عادي) بعد كده لو لزم الأمر
    // (المرحلة 1) بترتبط مرة واحدة بس عند إقلاع التطبيق - مستقلة عن
    // initSharedUIBridge لأنها مش بتستمع لأي حدث من أحداث auth/geofence
    // المخصصة، بس لـ visibilitychange/beforeunload الخام من المتصفح
    initVisitorPresenceTracking();

    initOnboarding().then((authIntent) => {
        initSharedUIBridge();
        initTabNavigation();
        initCrossModuleTabNavigation();
        initHeaderProfileLink();
        initStepsCounter();
        initDailyQuestionCard();
        initStoriesUI();

        // (المرحلة 5): منشورات "سِكّاوي" - بعد initStoriesUI() مباشرة
        // بنفس المنطق (قسم عرض محتوى في تبويب الرئيسية)، وقبل
        // initNotificationsUI() اللي هي تهيئة مودال منفصل تماماً عن
        // محتوى الصفحة الرئيسية
        initPostsUI();

        initNotificationsUI();

        // (المرحلة 5 - خطة الإشعارات الخارجية) بعد initNotificationsUI()
        // مباشرة - نفس فلسفة "موديول مستقل بيتهيأ مرة واحدة، بيستمع
        // لأحداث auth بنفسه" المستخدمة فعلاً هنا وفي initSupportChat تحت
        initPushNotifications();

        // (المرحلة 8) بعد initNotificationsUI() مباشرة - نفس منطق
        // "مودال مستقل، بيتهيأ مرة واحدة، بيستمع لأحداث auth بنفسه"
        initSupportChat();

        // checkExistingSession() (اللي بتفتح authModal كمودال منبثق فعلياً
        // لو مفيش جلسة محفوظة) لازم تتنادى *بعد* ما شاشة الترحيب تخلّص -
        // مش قبلها - عشان منفتحش مودال دخول قديم فوق شاشة ترحيب لسه ظاهرة
        // لمستخدم أول مرة. bindAuthEventListeners() (اللي بتربط
        // الـ Listeners بس من غير ما تفتح أي مودال) هي اللي لازم تتنادى
        // بدري فوق قبل initOnboarding() مباشرة.
        //
        // (إصلاح - باج حقيقي): لو authIntent === 'guest-browse'، المستخدم
        // اختار بوعي إنه يكمّل من غير حساب - "مفيش جلسة محفوظة" هنا مش
        // معناه نسيان تسجيل الدخول، ده القرار نفسه. قبل الإصلاح ده،
        // checkExistingSession() كانت بتتنادى من غير أي استثناء، فبمجرد
        // ما شاشة الترحيب تقفل (finish('guest-browse') في onboarding.js)،
        // كانت بتفتح authModal فورًا فوق واجهة التطبيق (لأن فعلاً مفيش
        // جلسة محفوظة لزائر مالوش حساب أصلاً) - فيبان للمستخدم إنه "اتقفل"
        // على صفحة التسجيل من غير أي سبب واضح، رغم إن وضع الزائر كان بيتفعّل
        // فعليًا وراها (window.isGuestMode + الشريط) لحد ما يعمل Refresh
        // (وقتها hasSeenOnboarding() بترجع true فالمسار ده مبيتنفذش تاني).
        // نفس الاستثناء المطبّق تحت على showAuthGate() لازم يتطبّق هنا كمان.
        if (authIntent !== 'guest-browse') {
            checkExistingSession();
        }

        // ملحوظة: initProfileUI (في js/profiles.js) هي المسؤولة بالكامل عن
        // عرض النقاط (updateProfileStats) وتهيئة لوحة الصدارة
        // (initLeaderboardUI) بمجرد ما توصل بيانات Supabase الحقيقية -
        // متنادوش على أي دالة نقاط/ليدربورد محلية هنا تاني.
        const currentUser = restoreSession();
        initProfileUI(currentUser);

        // لو المستخدم اختار "إنشاء حساب" أو "تسجيل دخول" من آخر سلايد في
        // شاشات الترحيب، افتح صفحة اختيار الدخول/التسجيل الكاملة (مش
        // مودال منبثق) بالوضع المناسب - إلا لو طلعنا كان عنده جلسة
        // محفوظة فعلاً (currentUser)، ففي الحالة دي مفيش داعي نعرضها
        // لمستخدم داخل بالفعل. عملياً ده مسار احتياطي نادر جداً (لو
        // authIntent رجعت، معناها تسجيل الدخول نجح بالفعل جوه الترحيب
        // وcurrentUser المفروض يبقى متظبط أصلاً في اللحظة دي)
        //
        // (إصلاح - باج حقيقي): 'guest-browse' كانت بتقع في نفس الشرط ده
        // برضه لأن currentUser فعلاً null (المستخدم اختار يتصفح من غير
        // حساب أصلاً، مش إنه فشل يسجل دخول). يعني كل مرة حد يضغط "تصفح
        // كزائر"، الشرط ده كان بيرجّعه فورًا لـ showAuthGate() تاني -
        // نفس صفحة التسجيل اللي هو لسه طالع منها - وكأنه اتقفل عليها.
        // ده بالظبط اللي وصفه تعليق onboarding.js (finish('guest-browse'))
        // كـ "حالة خاصة لازم app.js يتعامل معاها ومايفتحش showAuthGate()
        // تاني بعدها" - لكن الاستثناء ده متعملش هنا فعليًا قبل كده.
        if (authIntent && authIntent !== 'guest-browse' && !currentUser) {
            showAuthGate();
        }

        // (تحديث - اختيار 2) تحديد وضع الزائر عند فتح التطبيق: بقى
        // بيعتمد بس على "هل فيه جلسة مستخدم حقيقية محفوظة (currentUser)
        // ولا لأ" - من غير أي فحص جغرافي أو طلب إذن GPS خالص. مفيش
        // حساب شخصي => وضع الزائر (متابعة بس، بدون تحكم). فيه حساب
        // شخصي => وصول كامل فورًا بغض النظر عن مكانه الجغرافي.
        //
        // (إصلاح - باج "فلاش وضع الزائر"): لو restoreSession() لقت
        // مستخدم فعلاً (currentUser truthy)، بنطبّق وصول كامل فورًا -
        // مأمون 100%، ولو غلط لأي سبب هيتصحح على طول لما auth:login
        // الحقيقي يتطلق. لكن لو currentUser فضلت null، مبقيناش بنطبّق
        // قيود وضع الزائر هنا فورًا زي قبل كده - لأن null هنا ممكن
        // تعني "زائر فعلي" أو ممكن تعني "فيه جلسة حقيقية بس القراءة
        // المتفائلة السريعة لسه معرفتش توصفها" (شوف تعليق restoreSession
        // في js/auth.js)، ومفيش فرق نقدر نبينه دلوقتي في اللحظة دي.
        // بدل ما نخمّن ونعرض شريط "بتتصفح كزائر" واللي ممكن يتبين غلط
        // بعد جزء من الثانية، بنسيب القرار لحدث تأكيد حقيقي واحد بس:
        // إما auth:login (فيه حساب فعلاً) أو auth:confirmed-signed-out
        // (اتأكد فعليًا من Supabase إنه مفيش جلسة) - الاتنين متسجلين في
        // initSharedUIBridge فوق وهيطبّقوا الحالة الصح أول ما توصل،
        // من غير ما المستخدم يشوف أي حالة وسط غلط في الأثناء.
        if (currentUser) {
            applyGuestModeRestrictions(true);
        }
    });
}

/* ==================================================================
   🔋 [جديد] بانر "استثناء توفير البطارية" (صفحة إعدادات الحساب)
   ------------------------------------------------------------------
   js/sensors.js بيبعت 'sensors:battery-optimization-needed' لو
   الـ Plugin الأصلي اكتشف إن التطبيق مش مستثنى من توفير البطارية على
   أندرويد (شوف checkBatteryOptimizationStatus). هنا بس بنتحكم في
   إظهار/إخفاء البانر وربط الزرار بطلب الاستثناء الفعلي - مفيش أي
   منطق تاني هنا، كل التفاصيل جوه sensors.js/StepCounterPlugin.java.
   ================================================================== */
document.addEventListener('sensors:battery-optimization-needed', () => {
    const banner = document.getElementById('batteryOptimizationBanner');
    if (banner) banner.classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', () => {
    const btnRequestBatteryExemption = document.getElementById('btnRequestBatteryExemption');
    if (!btnRequestBatteryExemption) return;

    btnRequestBatteryExemption.addEventListener('click', async () => {
        btnRequestBatteryExemption.disabled = true;
        try {
            await requestBatteryOptimizationExemption();
            // النافذة اللي فتحناها بتاعة النظام - مش هنعرف رد المستخدم
            // فورًا. لما يرجع للتطبيق (visibilitychange) sensors.js
            // هيتأكد تاني من الحالة الفعلية عن طريق
            // syncFromNativeStepCounter -> checkBatteryOptimizationStatus،
            // ولو بقى مستثنى فعلاً الحدث مش هيتبعت تاني والبانر هيفضل
            // ظاهر لحد ما نضيف منطق إخفاء تلقائي لو حبينا لاحقًا.
        } finally {
            btnRequestBatteryExemption.disabled = false;
        }
    });
});

/* ==================================================================
   🚀 [جديد] بانر "التشغيل التلقائي" (Autostart) - صفحة إعدادات الحساب
   ------------------------------------------------------------------
   نفس فلسفة بانر توفير البطارية فوق بالظبط: js/sensors.js بيبعت
   'sensors:autostart-needed' لو الجهاز من الشركات المعروفة بتقييد
   Autostart بشدة (شاومي/هواوي/أوبو/فيفو..إلخ). هنا بس بنتحكم في
   إظهار البانر (مع اسم الشركة فعليًا من detail.manufacturer) وربط
   الزرار بفتح شاشة الإعدادات المناسبة. مفيش منطق إخفاء تلقائي هنا
   عمدًا (زي البانر التاني بالظبط) لأنه مفيش API رسمي نتأكد بيه إن
   المستخدم فعّل الخيار فعلاً بعد ما يرجع من الشاشة.
   ================================================================== */
document.addEventListener('sensors:autostart-needed', (event) => {
    const banner = document.getElementById('autostartBanner');
    if (!banner) return;

    const manufacturer = event.detail?.manufacturer;
    const manufacturerLabel = document.getElementById('autostartManufacturerLabel');
    if (manufacturerLabel && manufacturer) {
        manufacturerLabel.textContent = manufacturer;
    }

    banner.classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', () => {
    const btnRequestAutostart = document.getElementById('btnRequestAutostart');
    if (!btnRequestAutostart) return;

    btnRequestAutostart.addEventListener('click', async () => {
        btnRequestAutostart.disabled = true;
        try {
            await requestAutostartPermission();
            // زي بانر توفير البطارية بالظبط: مفيش رد فوري نتأكد بيه
            // إن المستخدم فعّل الخيار، فالبانر بيفضل ظاهر لحد ما
            // المستخدم يقفله بنفسه أو نضيف منطق إخفاء تلقائي لاحقًا
        } finally {
            btnRequestAutostart.disabled = false;
        }
    });
});

document.addEventListener('DOMContentLoaded', initApp);