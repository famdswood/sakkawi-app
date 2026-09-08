/* ==================================================================
   سِكّاوي | js/stories.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: عرض شريط الستوريز أعلى الشاشة الرئيسية،
   وفتح مودال المشاهدة (زي استوريز إنستجرام) مع التقدّم التلقائي
   والتنقل بالنقر يمين/شمال، وتسجيل التفاعلات البسيطة (لايك مثلاً).

   ------------------------------------------------------------------
   (المرحلة الثالثة - الجزء الثاني) تفاعل القلب البرمجي + تسجيل المشاهدات:
   ------------------------------------------------------------------
   إضافتين هنا فوق اللي كان موجود في الجزء الأول:

   1) اللايك (زرار #storyHeartBtn الموجود بالفعل في index.html): بالضغط
      عليه بنعمل تبديل (toggle) لحالة الإعجاب محلياً فوراً (Optimistic UI)
      مع أنيميشن نبضة/توهج (كلاس .pulse + .liked المعرّفين في style.css)،
      وبعدين بنستدعي mark_story_viewed(story_id, is_liked) في الباك إند.
      لو الطلب فشل، بنرجّع الحالة زي ما كانت ونعرض رسالة خطأ.

   2) تسجيل المشاهدة تلقائياً في الباك إند: بعد ما الاستوري تتفتح وتفضل
      ظاهرة على الشاشة أكتر من VIEW_MARK_DELAY_MS (ثانيتين)، بنستدعي
      mark_story_viewed(story_id) من غير باراميتر is_liked خالص، عشان
      الدالة في الباك إند تسجّل "مشاهدة" بس من غير ما تلمس حالة اللايك
      السابقة (بنفترض إن is_liked معرّف كـ default null في تعريف الدالة
      نفسها في Supabase - لو مش كده عندك، عدّل استدعاء الدالة تحت في
      reportStoryViewToBackend). المؤقت ده بيتلغي فوراً لو المستخدم قفل
      المودال أو نقل لاستوري تانية قبل ما الثانيتين يخلصوا، عشان مانسجلش
      "مشاهدة" لاستوري المستخدم بس مر عليها مرور الكرام.

      ملحوظة: التلوين الرمادي لإطار الاستوري في الشريط الرئيسي (الجزء
      التاني من المطلوب) كان بالفعل بيحصل "فور" فتح الاستوري من الجزء
      الأول (renderCurrentStory بيستدعي markStoryAsViewed + renderStoriesBar
      فوراً) - ده تسجيل محلي (localStorage) بس عشان الواجهة تستجيب
      لحظياً، منفصل عن استدعاء الباك إند اللي بعد الثانيتين فوق.

   ------------------------------------------------------------------
   (المرحلة الثالثة - الجزء الأول) شريط الاستوريات الحقيقي + مشغل الـ 10 ثواني:
   ------------------------------------------------------------------
   استبدلنا الـ Mock Data القديمة بجلب حقيقي من Supabase عن طريق دالة
   RPC اسمها get_active_text_stories() (المفروض معرّفة عندك كـ Postgres
   Function في المشروع، وترجّع الاستوريات النشطة/غير المنتهية مع بيانات
   صاحبها). كل حقول الصف اللي بترجع من الدالة دي متعرّفة في مكان واحد بس
   تحت: دالة mapRpcRowToStory() - لو أسماء الأعمدة عندك مختلفة عن
   المفترض هنا (user_name/full_name/display_name، avatar_url، إلخ)
   غيّرها هناك بس.

   مدة عرض كل استوري بقت 10 ثواني بالظبط (STORY_DURATION_MS)، وشريط
   التقدم بقى شغال بـ requestAnimationFrame بدل CSS transition عادي،
   عشان نقدر نوقفه/نكمله بدقة وقت الضغطة المطولة (long press) - تفاصيل
   ذلك في playCurrentStoryProgress/pauseStoryProgress/resumeStoryProgress
   تحت.

   حالة "المشاهَدة" (viewed) بتتخزن محلياً في localStorage (مش في
   الباك إند لسه) عشان تفضل محفوظة حتى لو المستخدم عمل Refresh للصفحة،
   من غير ما نحتاج جدول/عمود جديد دلوقتي. راجع getViewedStoryIds/
   markStoryAsViewed تحت.

   ------------------------------------------------------------------
   (المرحلة الثانية) إنشاء ونشر استوري نصية جديدة:
   ------------------------------------------------------------------
   ده الجزء المسؤول عن مودال "استوري جديدة" (#createStoryModal في
   index.html): المعاينة الحية، اختيار الخلفية والخط، والنشر الفعلي في
   جدول text_stories على Supabase. استوري المستخدم نفسه بعد النشر
   بتتحقن فوراً في storiesData المحلية عشان الشريط يتحدث فوراً من غير
   ما ننتظر إعادة الجلب من السيرفر.

   ملحوظة مهمة عن أسماء أعمدة جدول text_stories: الأسماء تحت (content،
   bg_color، font_style) هي الأسماء الفعلية اللي اتأكدنا منها من Table
   Editor في Supabase. لو غيّرتها في السكيما، غيّرها في مكان واحد بس:
   داخل دالة publishStory() تحت، في الـ object اللي بيتبعت لـ .insert().
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { getCurrentUser } from './auth.js';
import { openPublicProfile, DEFAULT_AVATAR_URI } from './profiles.js';
import { pushModalState, closeModal } from './modal-history.js';
// (جديد - كاش الأوفلاين) شوف js/offline-cache.js للتفاصيل الكاملة
import { fetchWithCache, setCached } from './offline-cache.js';
// (المرحلة 4-أ) ملصق الإنجاز الحي (Live Stat Sticker) - بنقرأ عدد خطوات
// اليوم الفعلية من sensors.js عشان نعرضها كبادج فوق المعاينة الحية
// لإنشاء الاستوري (شوف bindCreateStoryModalEvents تحت)
import { getStepsCount } from './sensors.js';

/** مدة عرض كل ستوري بالميلي ثانية قبل الانتقال التلقائي للتالية (10 ثواني) */
const STORY_DURATION_MS = 10000;

/** الحد الأدنى لمدة الضغط (بالميلي ثانية) عشان تتحسب "ضغطة مطولة" وتوقف المؤقت */
const LONG_PRESS_THRESHOLD_MS = 220;

/** مدة بقاء الاستوري مفتوحة قبل ما نسجّل "مشاهدة" فعلية في الباك إند (ثانيتين) */
const VIEW_MARK_DELAY_MS = 2000;

/** مدة أنيميشن نبضة القلب بالميلي ثانية - لازم تتطابق مع مدة heartPulse في style.css (0.55s) */
const HEART_PULSE_DURATION_MS = 550;

/** مفتاح تخزين قائمة معرّفات الاستوريات اللي المستخدم شافها بالفعل (localStorage) */
const VIEWED_STORIES_STORAGE_KEY = 'ta7t-el-balad-viewed-stories';

/** أقصى عدد من معرّفات الاستوريات "المشاهَدة" بنحتفظ بيها في localStorage -
 *  فوق العدد ده، بنشيل الأقدم عشان الـ Storage ما يفضلش يكبر لغير حدود
 *  مع الوقت (كل استوري بتتشاف بتضيف معرّف جديد، والاستوريهات القديمة
 *  بتنتهي صلاحيتها أصلاً فمفيش داعي نفضل محتفظين بمعرّفاتها للأبد) */
const MAX_VIEWED_STORIES_STORED = 100;

/** كل قد إيه (بالميلي ثانية) بنعيد جلب الاستوريات تلقائياً في الخلفية
 *  عشان نتخلص من أي استوري انتهت صلاحيتها لو المستخدم فاتح التطبيق
 *  لفترة طويلة من غير ما يعمل Refresh للصفحة (5 دقائق) */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** الحد الأقصى لعدد حروف نص الاستوري */
const STORY_MAX_CHARS = 120;

/** خيارات لون/تدرج خلفية الاستوري (قيم CSS جاهزة للتطبيق مباشرة) -
 *  بُدّلت بالكامل لباليتة رياضية تنافسية عالية التباين تناسب ثيم
 *  Dark Luxury (بدل الألوان الباستيل/العشوائية القديمة). كل خيار
 *  تدرج CSS متوافق تماماً مع عمود bg_color في Supabase زي ما هو -
 *  بيتخزن كـ string عادي زي أي قيمة سابقة، من غير أي تغيير في شكل
 *  التخزين أو النوع */
const STORY_BG_OPTIONS = [
    { id: 'carbon', value: 'linear-gradient(135deg, #0b0d12, #1e2430)' },
    { id: 'gold',   value: 'linear-gradient(135deg, #F2D77E, #B8942A)' },
    { id: 'volt',   value: 'linear-gradient(135deg, #10b981, #047857)' },
    { id: 'orange', value: 'linear-gradient(135deg, #f97316, #c2410c)' },
    { id: 'teal',   value: 'linear-gradient(135deg, #14b8a6, #0f766e)' },
    { id: 'crimson',value: 'linear-gradient(135deg, #ef4444, #991b1b)' },
    { id: 'cyber',  value: 'linear-gradient(135deg, #06b6d4, #0e7490)' },
];

/** خط الاستوري بقى ثابت (كايرو الأساسي بس) بدل ما كان فيه 4 خيارات -
 *  المصفوفة فضلت بعنصر واحد بس (مش اتشالت خالص) عشان باقي الكود اللي
 *  بيقرا createStoryState.selectedFont.cssClass يفضل شغال من غير تعديل */
const STORY_FONT_OPTIONS = [
    { id: 'cairo-black', label: 'كايرو', cssClass: 'font-cairo font-black' },
];

/** خيارات مدة عرض الاستوري قبل ما تنتهي تلقائياً (بالساعات) -
 *  اتقلصت لخيارين بس (دورة يومية تنافسية بتتصفر بالليل، فـ 6 و48
 *  ساعة كانوا مشتتين وملهمش لازمة) */
const STORY_DURATION_OPTIONS = [
    { id: '24h', hours: 24, label: '24 ساعة' },
    { id: '12h', hours: 12, label: '12 ساعة' },
];

/** خيارات خصوصية الاستوري - مين يقدر يشوفها */
const STORY_VISIBILITY_OPTIONS = [
    { id: 'public',  label: 'الكل' },
    { id: 'friends', label: 'الأصدقاء بس' },
];

/** الموضع/المقاس الافتراضي لملصق الإنجاز الحي جوه معاينة الإنشاء (نسبة %
 *  من عرض/ارتفاع #storyPreviewArea بيحدد مركز الكبسولة x/y، وscale معامل
 *  تكبير/تصغير) - بيحاكي تقريبًا المكان الثابت القديم (تحت النص، في
 *  النص أفقيًا) قبل ما يبقى المستخدم قادر يسحبه/يكبّره بحرية (شوف
 *  bindStickerDragAndResize تحت). ratio: نسبة عرض/ارتفاع افتراضية
 *  (fallback) لصندوق المعاينة وقت الإنشاء - مستخدمة بس لو استوري قديمة
 *  اتنشرت قبل إضافة تصحيح اختلاف الأبعاد (راجع positionRenderedSticker) */
const DEFAULT_STICKER_POSITION = { x: 50, y: 88, scale: 1, ratio: 9 / 16 };

/** أقل/أكبر معامل تكبير مسموح بيه لملصق الإنجاز الحي وقت الـ Pinch */
const STICKER_MIN_SCALE = 0.6;
const STICKER_MAX_SCALE = 2.2;

/** الحالة المؤقتة لفورم إنشاء الاستوري الحالية (تُصفَّر بعد كل نشر) */
const createStoryState = {
    selectedBg: STORY_BG_OPTIONS[0],
    selectedFont: STORY_FONT_OPTIONS[0],
    selectedDuration: STORY_DURATION_OPTIONS[0], // 24 ساعة كافتراضي
    selectedVisibility: STORY_VISIBILITY_OPTIONS[0], // الكل كافتراضي
    isPublishing: false,
    // (المرحلة 4-أ) هل ملصق الإنجاز الحي (خطوات اليوم + النسبة) مفعّل
    // ومضاف للمعاينة الحالية ولا لأ - بيتحدث من زرار #btnToggleStatSticker
    includeStats: false,
    // موضع/مقاس ملصق الإنجاز الحي الحالي جوه المعاينة - بيتحدث لحظيًا
    // من bindStickerDragAndResize وقت السحب/الـ Pinch، وبيتبعت مع بيانات
    // الملصق وقت النشر (شوف publishStory) عشان يتحفظ نفس المكان بالظبط
    // في مشغل المشاهدة الفعلي كمان
    stickerPosition: { ...DEFAULT_STICKER_POSITION },
};

/** هدف عدد الخطوات اليومي المستخدم لحساب نسبة الوصول في ملصق الإنجاز الحي */
const DAILY_STEPS_GOAL = 10000;

/** الأفاتار الافتراضي المستخدم لو المستخدم مالوش صورة بروفايل محفوظة -
 *  نفس أيقونة "مفيش صورة" الموحدة المستخدمة في كل مكان تاني بالمشروع
 *  (DEFAULT_AVATAR_URI المُصدّرة من js/profiles.js: دايرة رمادية فاتحة +
 *  شخص) - مش SVG منفصل بألوان ذهبي/أسود زي الأول، عشان هوية الأفاتار
 *  الافتراضي تبقى واحدة موحدة في كل الاستوريز والليدربورد والبروفايل سوا،
 *  وكمان بيتعرض دايمًا صح من غير أي طلب شبكة زي ما كان قبل كده بالظبط */
const DEFAULT_STORY_AVATAR = DEFAULT_AVATAR_URI;

/** بيانات الستوريز الحقيقية (بتتملى من get_active_text_stories() - راجع fetchActiveStories) */
let storiesData = [];

let currentStoryIndex = 0;

/** مؤشرات (indices) ستوريز نفس الشخص المفتوح حاليًا بس داخل storiesData -
 *  دي اللي بتتحكم في شريط التقدّم فوق والتنقل جوه المودال، عشان كل شخص
 *  يبقى معزول تمامًا عن ستوريز أي حد تاني (راجع openStory/goToNextStory) */
let currentGroupStoryIndices = [];

/** موضع الستوري الحالية جوه currentGroupStoryIndices (0 = أول ستوري للشخص ده) */
let currentGroupPosition = 0;

/** معرّف المستخدم الحالي المسجّل دخوله - بنملاه مرة واحدة في initStoriesUI،
 *  ومستخدم عشان نعرف هل صاحب الاستوري المفتوحة هو نفسه ولا لأ (عشان نظهر/نخفي
 *  زرار "مين شافها") */
let currentUserId = null;

/** صورة وبيانات المستخدم الحالي المسجّل دخوله - بنملاهم مع currentUserId
 *  بالظبط (نفس اللحظة، من نفس المصدر: initStoriesUI + auth:login/
 *  auth:signed-out)، ومستخدمين في زر "هويتي" الجديد في storiesBar
 *  (راجع renderStoriesBar) عشان نعرض صورة المستخدم نفسه بدل دائرة
 *  "أضف قصة" الفارغة القديمة. بيفضلوا null لو زائر (Guest) أو لسه
 *  الجلسة ما اتحققتش، ووقتها renderStoriesBar بيقع تلقائيًا على
 *  DEFAULT_STORY_AVATAR */
let currentUserAvatar = null;
let currentUserName = null;

/** معرّف مؤقت الـ setInterval الخاص بإعادة الجلب التلقائية في الخلفية
 *  (راجع AUTO_REFRESH_INTERVAL_MS) - بنحتفظ بيه عشان نقدر نمسحه لو
 *  initStoriesUI اتنادت أكتر من مرة، فمنعملش أكتر من مؤقت شغال مع بعض */
let autoRefreshTimerId = null;

/** نسخة قناة Supabase Realtime الحالية المشترك فيها في تحديثات جدول
 *  text_stories (راجع bindStoriesRealtimeSubscription تحت) - null لو
 *  مفيش قناة شغالة دلوقتي، بنحتفظ بيها عشان نلغي الاشتراك القديم قبل
 *  ما نعمل واحد جديد لو initStoriesUI اتنادت أكتر من مرة بالغلط */
let storiesRealtimeChannel = null;

/** true لو وصلنا تحديث Realtime (استوري جديدة اتنشرت من حد تاني) وإحنا
 *  مودال مشاهدة الستوريز مفتوح فعلاً دلوقتي - بنأجّل تنفيذ إعادة الجلب
 *  الفعلية لحد ما المستخدم يقفل المودال (راجع closeStory)، عشان منلخبطش
 *  storiesData/currentGroupStoryIndices وهو لسه بيتفرج على استوري مفتوحة */
let hasPendingStoriesRefreshFromRealtime = false;

/** true بمجرد ما نربط كل أحداث DOM الخاصة بمودال مشاهدة الستوريز ومودال
 *  إنشاء استوري جديدة مرة واحدة، عشان منربطهاش تاني كل ما initStoriesUI
 *  تتنادى (بعد أي تسجيل دخول جديد بحساب مختلف من غير Refresh للصفحة
 *  مثلاً - نفس السبب الموثّق في editProfileEventsBound جوه profiles.js
 *  بالظبط). المشكلة اللي كانت بتحصل من غير الـ flag ده: كل الأزرار (نشر
 *  استوري، لايك، حذف، تنقل..إلخ) كانت بتتراكم عليها أكتر من event
 *  listener، فضغطة واحدة كانت بتنفّذ الفعل أكتر من مرة (زي 3 طلبات نشر
 *  متطابقة اتبعتوا مرة واحدة وضربوا بعض بخطأ 409 Conflict) */
let storiesUiEventsBound = false;

/* ------------------------------------------------------------------
   حالة تقدّم المؤقت (Progress) بالـ requestAnimationFrame
   بدل setTimeout/CSS transition عادي، عشان نقدر نوقف/نكمل بدقة لحظة
   الضغطة المطولة (long press) من غير ما نفقد مكان التقدم الحالي
   ------------------------------------------------------------------ */
let progressAnimationFrameId = null;
let storyProgressStartTime = 0;
let storyProgressPausedElapsedMs = 0;
let isStoryProgressPaused = false;

/* ------------------------------------------------------------------
   حالة الضغطة المطولة (Long Press) - بتتابع على مستوى الكارت كله
   (storyViewerCard) بغض النظر عن العنصر الفرعي اللي اتضغط بالظبط
   ------------------------------------------------------------------ */
let longPressTimer = null;
let isLongPressActive = false;

/** مؤقت تسجيل "المشاهدة" في الباك إند بعد مرور VIEW_MARK_DELAY_MS على فتح الاستوري الحالية */
let viewMarkTimer = null;

/** مؤقت إزالة كلاس .pulse من زرار القلب بعد انتهاء أنيميشن النبضة */
let heartPulseTimer = null;

/**
 * إرجاع مصفوفة الستوريز الحالية (يُستخدم مبدئياً من app.js عند الحاجة)
 */
export function getStories() {
    return storiesData;
}

/**
 * إرجاع مجموعة (Set) معرّفات الاستوريات اللي المستخدم شافها بالفعل،
 * مقروءة من localStorage. بترجع Set فاضي لو مفيش حاجة محفوظة أو لو
 * حصل أي خطأ في القراءة (مساحة تخزين ممتلئة، JSON تالف..إلخ)
 * @returns {Set<string>}
 */
function getViewedStoryIds() {
    try {
        const raw = window.localStorage.getItem(VIEWED_STORIES_STORAGE_KEY);
        return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (err) {
        console.error('تعذر قراءة قائمة الاستوريات المشاهَدة محلياً:', err);
        return new Set();
    }
}

/**
 * هل الاستوري دي اتشافت قبل كده من نفس الجهاز؟
 * @param {string} storyId
 * @returns {boolean}
 */
function isStoryViewed(storyId) {
    return getViewedStoryIds().has(storyId);
}

/**
 * تسجيل استوري معينة كـ"مشاهَدة" في localStorage عشان تفضل محفوظة
 * حتى لو المستخدم عمل Refresh للصفحة. بنحدّ القائمة بآخر
 * MAX_VIEWED_STORIES_STORED معرّف بس (راجع pruneViewedStoryIds) عشان
 * الـ localStorage ما يمتليش مع الوقت
 * @param {string} storyId
 */
function markStoryAsViewed(storyId) {
    const viewedIds = getViewedStoryIds();
    viewedIds.delete(storyId); // نشيلها لو موجودة الأول عشان تتحط في الآخر (الأحدث)
    viewedIds.add(storyId);

    const prunedIds = pruneViewedStoryIds(viewedIds);

    try {
        window.localStorage.setItem(VIEWED_STORIES_STORAGE_KEY, JSON.stringify(prunedIds));
    } catch (err) {
        console.error('تعذر حفظ حالة مشاهدة الاستوري محلياً:', err);
    }
}

/**
 * تنضيف قائمة معرّفات الاستوريات "المشاهَدة" بحيث تفضل محتفظة بآخر
 * MAX_VIEWED_STORIES_STORED معرّف بس (الأحدث)، وبتشيل الأقدم لو القائمة
 * كبرت عن الحد ده. بما إن Set في جافاسكريبت بتحافظ على ترتيب الإدخال
 * (insertion order)، فأول عناصرها هي الأقدم وآخرها هي الأحدث.
 * @param {Set<string>} viewedIds
 * @returns {Array<string>} مصفوفة المعرّفات بعد التنضيف، جاهزة للتخزين
 */
function pruneViewedStoryIds(viewedIds) {
    const idsArray = [...viewedIds];
    if (idsArray.length <= MAX_VIEWED_STORIES_STORED) return idsArray;

    // بنحتفظ بآخر MAX_VIEWED_STORIES_STORED عنصر بس (الأحدث)، ونشيل الأقدم
    return idsArray.slice(idsArray.length - MAX_VIEWED_STORIES_STORED);
}

/**
 * إرجاع كلاسات CSS الخاصة بشكل خط معيّن حسب معرّفه (font_style)،
 * مع رجوع لأول خيار افتراضي لو المعرّف مش موجود ضمن STORY_FONT_OPTIONS
 * @param {string} fontId
 * @returns {string}
 */
function getFontClassById(fontId) {
    const font = STORY_FONT_OPTIONS.find((option) => option.id === fontId);
    return font ? font.cssClass : STORY_FONT_OPTIONS[0].cssClass;
}

/**
 * تحويل صف واحد راجع من get_active_text_stories() لشكل كائن الستوري
 * المستخدم داخلياً في كل الملف ده (storiesData). مكان واحد بس لو
 * أسماء الأعمدة عندك مختلفة (راجع ملاحظة أعلى الملف)
 * @param {Object} row
 * @returns {Object}
 */

/* ------------------------------------------------------------------
   (المرحلة 4-ب) ملصق الإنجاز الحي - النشر الفعلي وعرضه في المشغل:
   ------------------------------------------------------------------
   عشان منحتاجش أي عمود جديد في جدول text_stories، بيانات الملصق
   (عدد الخطوات + نسبة الإنجاز) بتتضمّن كوسم برمجي "مخفي" في آخر سطر
   من حقل content نفسه وقت النشر، بالشكل ده بالظبط:
       <!--stat:{"steps":6420,"percent":64}-->
   ده تعليق HTML عادي (<!-- -->) - فحتى لو حد قرا content كنص خام (مثلاً
   في إشعار أو معاينة مكان تاني)، الوسم مش هيتعرض كنص ظاهر لأي حد
   (تعليقات HTML بيتجاهلها المتصفح تلقائيًا لو النص اتحط جوه innerHTML).
   بنستخرجه ونشيله من النص هنا (parseStatTagFromContent) قبل ما نعرض
   الاستوري في أي مكان، عشان storiesData.content يفضل دايمًا "نظيف"
   (النص المكتوب بس، من غير أي أثر للوسم) - راجع buildStatTag/
   parseStatTagFromContent تحت، واستخدامهم في publishStory/mapRpcRowToStory */

/** الشكل الثابت لوسم بيانات الملصق - سطر جديد اختياري + التعليق نفسه
 *  في آخر النص بالظبط (\s*$ عشان نلقط أي مسافات/أسطر فاضية زيادة بعده) */
const STAT_TAG_REGEX = /\n?<!--stat:(\{[^}]*\})-->\s*$/;

/**
 * بناء الوسم البرمجي اللي بيتلزّق في آخر content وقت النشر لو المستخدم
 * فعّل ملصق الإنجاز الحي (createStoryState.includeStats) - راجع
 * publishStory تحت لمكان الاستخدام. x/y/scale (موضع/مقاس الكبسولة اللي
 * المستخدم حدده بالسحب/الـ Pinch) وar (نسبة عرض/ارتفاع صندوق المعاينة
 * وقت النشر) بيتحطوا جوه نفس الوسم عشان يتحفظوا ويتطبقوا تاني بالظبط
 * في مشغل المشاهدة الفعلي حتى لو نسبة شاشة العرض مختلفة (شوف
 * positionRenderedSticker/renderCurrentStory)
 * @param {{steps: number, percent: number, x: number, y: number, scale: number, ar: number}} statData
 * @returns {string}
 */
function buildStatTag(statData) {
    return `\n<!--stat:${JSON.stringify(statData)}-->`;
}

/**
 * فحص نص content الخام (الراجع من قاعدة البيانات أو من optimistic insert)،
 * واستخراج وسم بيانات ملصق الإنجاز الحي منه لو موجود. بترجع النص "نظيف"
 * (من غير الوسم) + بيانات الملصق منفصلة كـ object، أو statData: null لو
 * مفيش وسم أصلاً (يعني استوري نصية عادية) - وده افتراضياً هو الغالب.
 * لو الـ JSON جوه الوسم بايظ لأي سبب (تلاعب يدوي، قطع في النص..إلخ)،
 * بنتجاهل الوسم بهدوء بدل ما نكسر عرض الاستوري كلها.
 * x/y/scale/ar (موضع/مقاس الكبسولة ونسبة عرض/ارتفاع صندوق المعاينة وقت
 * النشر) بيرجعوا بقيمة افتراضية (DEFAULT_STICKER_POSITION) لو مش موجودين
 * جوه الوسم (استوريهات اتنشرت قبل ميزة السحب/التكبير)
 * @param {string} rawContent
 * @returns {{content: string, statData: ({steps: number, percent: number, x: number, y: number, scale: number, ar: number}|null)}}
 */
function parseStatTagFromContent(rawContent) {
    const text = rawContent || '';
    const match = text.match(STAT_TAG_REGEX);
    if (!match) return { content: text, statData: null };

    let statData = null;
    try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed.steps === 'number' && typeof parsed.percent === 'number') {
            statData = {
                steps: parsed.steps,
                percent: parsed.percent,
                x: typeof parsed.x === 'number' ? parsed.x : DEFAULT_STICKER_POSITION.x,
                y: typeof parsed.y === 'number' ? parsed.y : DEFAULT_STICKER_POSITION.y,
                scale: typeof parsed.scale === 'number' ? parsed.scale : DEFAULT_STICKER_POSITION.scale,
                ar: typeof parsed.ar === 'number' ? parsed.ar : DEFAULT_STICKER_POSITION.ratio,
            };
        }
    } catch (err) {
        // JSON بايظ - نتجاهله ونعامل الاستوري كأنها عادية من غير ملصق
        statData = null;
    }

    // بنقص الوسم من آخر النص فقط (match.index هو بداية الوسم)، ونشيل أي
    // مسافات/أسطر فاضية زيادة فضلت في الآخر بعد القص
    return { content: text.slice(0, match.index).trimEnd(), statData };
}

function mapRpcRowToStory(row) {
    // ملحوظة: عمود المعرّف الراجع من get_active_text_stories() اسمه
    // story_id مش id (اتأكدنا منه من نتيجة استعلام مباشر على الدالة في
    // Supabase) - ده كان بيسبب رجوع mark_story_viewed/get_story_viewers
    // بـ404 لأن الباراميتر p_story_id كان بيتبعت بقيمة undefined.
    // بنحسبه مرة واحدة هنا في متغيّر ونستخدمه في كل حتة تحت (بما فيها
    // فحص isStoryViewed) - قبل كده كان فحص "متشافت قبل كده؟" بيتعمل على
    // row.id (اللي دايمًا undefined) بدل الـ ID الصح، فكان دايمًا بيرجع
    // false حتى لو الاستوري متسجّلة كمشاهدة في localStorage فعلاً. ده
    // كان سبب اختفاء الفريم الرمادي بمجرد ما تعمل Refresh للصفحة.
    const storyId = row.story_id || row.id;
    return {
        id: storyId,
        userId: row.user_id,
        userName: row.full_name || row.user_name || row.display_name || row.username || 'مستخدم سِكّاوي',
        // ملحوظة: عمود الصورة الراجع من get_active_text_stories() اسمه
        // user_avatar مش avatar_url ولا avatar (اتأكدنا منه بنفس طريقة
        // التأكد من story_id فوق) - ده كان بيخلي كل الاستوريز تظهر
        // بالأفاتار الاحتياطي الرمادي (الشخص الذهبي) حتى لو المستخدم
        // فعلاً رافع صورة بروفايل حقيقية، لأن avatar_url كانت دايمًا
        // undefined في الصف الراجع من الدالة دي
        avatar: row.user_avatar || row.avatar_url || row.avatar || DEFAULT_STORY_AVATAR,
        // (المرحلة 4-ب) استخراج بيانات ملصق الإنجاز الحي (لو موجودة) من
        // آخر سطر في content الخام، وتنظيف النص من الوسم البرمجي - راجع
        // parseStatTagFromContent فوق. statData بتفضل null لأي استوري
        // عادية (الغالبية) من غير أي تغيير في سلوكها
        ...(() => {
            const { content, statData } = parseStatTagFromContent(row.content);
            return { content, statData };
        })(),
        background: row.bg_color || row.background || STORY_BG_OPTIONS[0].value,
        fontClass: getFontClassById(row.font_style),
        createdAt: row.created_at || null,
        viewed: isStoryViewed(storyId),
        // حالة اللايك الحالية للمستخدم على الاستوري دي - لو get_active_text_stories()
        // بترجّع عمود بيعكس ده (liked/is_liked/user_liked)، بنقرأه هنا مباشرة عشان
        // القلب يفتح في حالته الصح من أول ما الاستوري تتفتح. لو الدالة عندك مش
        // بترجّع الحالة دي أصلاً، هيفضل false افتراضياً (يعني القلب يبدأ فاضي)
        liked: Boolean(row.liked ?? row.is_liked ?? row.user_liked ?? false),
        // Session-only: بنستخدمه عشان منكررش استدعاء mark_story_viewed() للباك إند
        // أكتر من مرة لنفس الاستوري في نفس جلسة التصفح دي (مش محفوظ في localStorage)
        viewedOnBackend: false,
        // قائمة مين شاف الاستوري دي (بتتملى بس لو المستخدم الحالي هو صاحبها -
        // راجع loadStoryViewersIfOwner) + هل اتحمّلت قبل كده ولا لأ
        viewers: [],
        viewCount: 0,
        viewersLoaded: false,
    };
}

/**
 * جلب الاستوريات النشطة (غير المنتهية) من Supabase عن طريق دالة RPC
 * get_active_text_stories()، وتحويلها لشكل storiesData الداخلي.
 *
 * (تعديل - كاش الأوفلاين): بترجع null صراحة عند فشل الجلب، بدل []
 * زي الأول، عشان الكود اللي بينادّيها (initStoriesUI/refreshStories
 * تحت) يقدر يفرّق بين "الطلب فشل - سيب المعروض الحالي/المخزّن زي ما
 * هو" و"الطلب نجح ورجع فعلاً إن مفيش استوريز نشطة دلوقتي" (نتيجة []
 * حقيقية). قبل التعديل ده، أي فشل شبكة (مثلاً وقت قطع النت) كان بيتحط
 * بنفس شكل "مفيش استوريز" فيمسح أي استوريز كانت متعرضة قبل كده.
 * @returns {Promise<Array<Object>|null>}
 */
async function fetchActiveStories() {
    const { data, error } = await supabaseClient.rpc('get_active_text_stories');

    if (error) {
        console.error('خطأ في جلب الاستوريات النشطة:', error.message);
        return null;
    }

    const stories = (data || []).map(mapRpcRowToStory);
    await enrichStoriesWithFreshProfileData(stories);
    return stories;
}

/**
 * تحديث اسم وصورة أصحاب الاستوريهات بأحدث بيانات موجودة فعلياً في جدول
 * profiles (الاسم الأول + الأخير، وصورة البروفايل الحقيقية)، بدل
 * الاعتماد على user_name/user_avatar الراجعين من get_active_text_stories()
 * - لاحظنا إنهم مش دايمًا متزامنين مع أحدث بيانات البروفايل (مثلاً:
 * استوري قديمة بتظهر بالاسم الأول والأخير والصورة صح، واستوري جديدة
 * لنفس الشخص بتظهر باليوزرنيم من غير صورة) لأن الدالة في الباك إند
 * غالبًا بتاخد نسخة من الاسم/الصورة وقت إنشاء الاستوري بدل ما تجيبها
 * لايف من profiles. بنعمل استعلام واحد بس لكل أصحاب الاستوريهات
 * الظاهرين (مش استعلام لكل استوري لوحدها) عشان الأداء يفضل كويس.
 * @param {Array<Object>} stories
 */
async function enrichStoriesWithFreshProfileData(stories) {
    const uniqueUserIds = [...new Set(stories.map((story) => story.userId).filter(Boolean))];
    if (uniqueUserIds.length === 0) return;

    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('id, full_name, first_name, last_name, avatar_url')
            .in('id', uniqueUserIds);
        if (error) throw error;

        const profileById = new Map((data || []).map((profile) => [profile.id, profile]));
        stories.forEach((story) => {
            const profile = profileById.get(story.userId);
            if (!profile) return;

            const freshName = profile.full_name
                || [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
            if (freshName) story.userName = freshName;
            if (profile.avatar_url) story.avatar = profile.avatar_url;
        });
    } catch (err) {
        // خطأ صامت هنا عمداً - لو الاستعلام ده فشل، الاستوريهات لسه هتتعرض
        // بالبيانات الراجعة من get_active_text_stories() زي ما هي (مش أسوأ
        // من قبل التعديل ده)، مفيش داعي نمنع الاستوريهات من الظهور خالص
        console.error('تعذر تحديث بيانات أصحاب الاستوريهات من profiles:', err.message);
    }
}

/**
 * إعادة جلب الاستوريات النشطة من الباك إند وتحديث شريط الستوريز.
 * مُصدَّرة عشان أي ملف تاني (زي بعد نشر استوري جديدة، أو Pull-to-refresh
 * مستقبلاً) يقدر يطلب تحديث الشريط من غير Reload كامل للصفحة.
 *
 * (تعديل - كاش الأوفلاين): الدالة دي عمداً **مش** بتعرض الكاش المحفوظ
 * الأول زي fetchWithCache العادية - لأنها بتتنادى في حالات فيها
 * storiesData أصلاً معروضة وأحدث من أي نسخة كاش قديمة (بعد نشر استوري
 * جديدة، من Realtime، أو من مؤقت الـ 5 دقايق التلقائي)، فلو عرضنا
 * الكاش الأول كان هيرجّع الشاشة لبيانات أقدم للحظة قبل ما يستبدلها
 * تاني - "قفزة بصرية" للخلف وقدام من غير أي داعي. بدل كده: بنجيب من
 * الشبكة مباشرة، ولو نجح بنحدّث الكاش يدوياً (setCached) عشان يفضل
 * محدّث لأي فتح تاني للتطبيق لاحقاً. لو فشل (مفيش نت)، بنسيب
 * storiesData المعروضة حالياً زي ما هي تماماً - بدون مسح وبدون رسالة
 * خطأ مزعجة (خصوصاً إن الدالة دي بتتنادى تلقائياً كل 5 دقايق، فرسالة
 * خطأ كل مرة النت مقطوع هتبقى مزعجة أوي).
 */
export async function refreshStories() {
    const stories = await fetchActiveStories();
    if (stories === null) {
        console.warn('[stories.js] فشل تحديث الاستوريات (غالباً مفيش نت) - سيب المعروض الحالي زي ما هو');
        return;
    }

    storiesData = stories;
    renderStoriesBar();
    await setCached('cached_stories', stories);
}

/**
 * نفس refreshStories بالظبط، لكن بحماية إضافية: لو مودال مشاهدة
 * الستوريز مفتوح دلوقتي، منعملش إعادة جلب فعلية على طول (كانت هتغيّر
 * مصفوفة storiesData اللي المودال شغّال بيها حالياً بمؤشرات
 * currentStoryIndex/currentGroupStoryIndices القديمة، فيبقى ممكن
 * الاستوري اللي بتتعرض تتلخبط أو التنقل بالتالي/السابق يودّي لاستوري
 * غلط). بدل كده بنسجّل إن فيه تحديث معلّق (hasPendingStoriesRefreshFromRealtime)
 * وبننفذه فعلياً أول ما المستخدم يقفل المودال (راجع closeStory تحت).
 */
async function refreshStoriesRespectingOpenViewer() {
    const modal = document.getElementById('storyViewerModal');
    const isViewerOpen = modal && !modal.classList.contains('hidden');

    if (isViewerOpen) {
        hasPendingStoriesRefreshFromRealtime = true;
        return;
    }

    await refreshStories();
}

/**
 * الاشتراك في تحديثات Supabase Realtime الحية على جدول text_stories
 * (نشر استوري جديدة/حذف استوري) عشان شريط الستوريز يتحدّث فوراً من غير
 * ما المستخدم يحتاج يعمل Refresh للصفحة يدوياً. بنستخدم refreshStories
 * الكاملة (إعادة استدعاء get_active_text_stories نفسها) بدل محاولة دمج
 * الصف الخام الراجع من Realtime يدوياً في storiesData، لأن صف
 * text_stories الخام من Realtime مالوش نفس أعمدة الصف الراجع من الدالة
 * (زي full_name/avatar_url بتوع صاحب الاستوري - دول جايين من JOIN جوه
 * الدالة نفسها ومش موجودين في الصف الخام)، فإعادة الجلب الكاملة أبسط
 * وأضمن من محاولة تخمين/جلب البيانات الناقصة يدوياً في كل مرة.
 * بنحمي نفسنا من تكرار الاشتراك (لو initStoriesUI اتنادت أكتر من مرة)
 * بإلغاء أي قناة قديمة أول حاجة.
 */
function bindStoriesRealtimeSubscription() {
    if (storiesRealtimeChannel) {
        supabaseClient.removeChannel(storiesRealtimeChannel);
        storiesRealtimeChannel = null;
    }

    storiesRealtimeChannel = supabaseClient
        .channel('text_stories-live-changes')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'text_stories' },
            () => {
                refreshStoriesRespectingOpenViewer();
            },
        )
        .subscribe();
}

/**
 * تنسيق وقت النشر بصيغة نسبية بالعربي (زي "منذ ساعتين")
 * @param {string|null} isoDateString
 * @returns {string}
 */
function formatRelativeTimeArabic(isoDateString) {
    if (!isoDateString) return '';

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(isoDateString).getTime()) / 1000));

    if (elapsedSeconds < 60) return 'الآن';

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) {
        if (elapsedMinutes === 1) return 'منذ دقيقة';
        if (elapsedMinutes === 2) return 'منذ دقيقتين';
        return elapsedMinutes <= 10 ? `منذ ${elapsedMinutes} دقايق` : `منذ ${elapsedMinutes} دقيقة`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        if (elapsedHours === 1) return 'منذ ساعة';
        if (elapsedHours === 2) return 'منذ ساعتين';
        return elapsedHours <= 10 ? `منذ ${elapsedHours} ساعات` : `منذ ${elapsedHours} ساعة`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    if (elapsedDays === 1) return 'منذ يوم';
    if (elapsedDays === 2) return 'منذ يومين';
    return elapsedDays <= 10 ? `منذ ${elapsedDays} أيام` : `منذ ${elapsedDays} يوم`;
}

/**
 * إرجاع كل مؤشرات (indices) الستوريز بتاعت شخص معيّن داخل storiesData،
 * مرتّبة من الأقدم للأحدث (زي إنستجرام بالظبط: بتبدأ بأقدم ستوري لسه
 * موجودة، وكل "تالي" بيوديك لستوري أحدث، لحد ما توصل لأحدث ستوري عنده
 * وهي دايمًا آخر واحدة - مفيش حاجة بعدها - و"السابق" بيرجّعك للأقدم).
 * بنرتّب صريحًا حسب createdAt هنا بدل ما نعتمد على ترتيب الصفوف الراجعة
 * من get_active_text_stories() في الباك إند، لأن الترتيب ده كان بييجي
 * بالأحدث الأول وده كان بيعكس تجربة التنقل المطلوبة بالكامل.
 * @param {string} userId
 * @returns {Array<number>}
 */
function getUserStoryIndices(userId) {
    const indices = [];
    storiesData.forEach((story, idx) => {
        if (story.userId === userId) indices.push(idx);
    });

    indices.sort((idxA, idxB) => {
        const tsA = storiesData[idxA].createdAt ? new Date(storiesData[idxA].createdAt).getTime() : 0;
        const tsB = storiesData[idxB].createdAt ? new Date(storiesData[idxB].createdAt).getTime() : 0;
        return tsA - tsB;
    });

    return indices;
}

/**
 * رسم شريط دوائر الستوريز أعلى الشاشة الرئيسية
 * تُستدعى مرة عند تحميل التطبيق، ومرة كل ما تتغير بيانات الستوريز
 */
export function renderStoriesBar() {
    const bar = document.getElementById('storiesBar');
    if (!bar) return;

    // بنجمع الستوريز حسب صاحبها - دايرة واحدة بس لكل شخص حتى لو نزّل أكتر
    // من ستوري (زي إنستجرام بالظبط)، عشان شريط التقدّم جوه المودال بعد كده
    // يبقى خاص بستوريز الشخص ده بس (راجع openStory). بنفتح أول ستوري لسه
    // مشاهدتش لو موجودة، وإلا أول ستوري عنده على الإطلاق
    const seenUserIds = new Set();
    const groupedStories = [];
    storiesData.forEach((story) => {
        if (seenUserIds.has(story.userId)) return;
        seenUserIds.add(story.userId);

        const userIndices = getUserStoryIndices(story.userId);
        const firstUnviewedIndex = userIndices.find((idx) => !storiesData[idx].viewed);

        // أحدث وقت نشر بين كل استوريز الشخص ده - بنستخدمه بعد شوية عشان
        // نرتّب الدوائر من الأحدث للأقدم بشكل مضمون، من غير ما نعتمد بس
        // على ترتيب الصفوف الراجعة من الباك إند
        const latestCreatedAtMs = Math.max(
            ...userIndices.map((idx) => {
                const ts = storiesData[idx].createdAt ? new Date(storiesData[idx].createdAt).getTime() : 0;
                return Number.isNaN(ts) ? 0 : ts;
            }),
        );

        groupedStories.push({
            userId: story.userId,
            openIndex: firstUnviewedIndex !== undefined ? firstUnviewedIndex : userIndices[0],
            allViewed: userIndices.every((idx) => storiesData[idx].viewed),
            userName: story.userName,
            avatar: story.avatar,
            latestCreatedAtMs,
        });
    });

    // ترتيب الدوائر من الأحدث للأقدم بشكل صريح (بدل الاعتماد على ترتيب
    // الباك إند بس) عشان نضمن إن الأحدث دايمًا الأقرب لزر "هويتي"
    groupedStories.sort((a, b) => b.latestCreatedAtMs - a.latestCreatedAtMs);

    // بنفصل مجموعة استوريز المستخدم الحالي (لو عنده استوري نشطة) عن
    // باقي الأبطال تمامًا - مش هتتعرض كدائرة عادية في القائمة تحت،
    // لأنها هتندمج جوه زر "هويتي" نفسه (الحاوية اللي فيها صورته + بادج
    // الـ + العائم) بدل ما تتكرر مرتين في الشريط
    const ownGroupIndex = groupedStories.findIndex((group) => group.userId === currentUserId);
    const ownGroup = ownGroupIndex !== -1 ? groupedStories.splice(ownGroupIndex, 1)[0] : null;

    // --------------------------------------------------------------
    // زر "هويتي" (يحل محل دائرة "أضف قصة" الفارغة القديمة): بيعرض صورة
    // المستخدم الحالي الشخصية (avatar_url) لو مسجل دخول وعنده صورة،
    // وإلا الأفاتار الافتراضي DEFAULT_STORY_AVATAR (سواء زائر أو
    // مسجل من غير صورة). لو عنده استوري نشطة بالفعل في storiesData
    // (ownGroup موجودة)، الدائرة بتاخد الإطار المتدرج اللامع تلقائيًا
    // (نفس كلاس .story-avatar الأساسي) والضغط على صورته بيفتح استورياته
    // هو مباشرة؛ غير كده كلاس .no-active-story بيحوّل الإطار لشكل بسيط
    // والضغط على الصورة بيفتح مودال إنشاء استوري جديدة على طول.
    // بادج الـ (+) الصغير في الركن السفلي بيفتح مودال الإنشاء دايمًا
    // في الحالتين، بغض النظر عن وجود استوري نشطة من عدمه
    // --------------------------------------------------------------
    const hasOwnActiveStory = Boolean(ownGroup);
    const myAvatarSrc = (ownGroup && ownGroup.avatar) || currentUserAvatar || DEFAULT_STORY_AVATAR;
    const myUserName = (ownGroup && ownGroup.userName) || currentUserName || 'أنا';

    const myStoryButton = `
        <div class="story-avatar my-story-avatar ${hasOwnActiveStory ? '' : 'no-active-story'}"
             role="group" aria-label="${hasOwnActiveStory ? `استوريك يا ${myUserName}` : 'أضف قصة جديدة'}">
            <button id="btnMyStoryAvatar" type="button" class="my-story-avatar-img"
                    aria-label="${hasOwnActiveStory ? 'مشاهدة استوريك' : 'أضف قصة جديدة'}"
                    ${hasOwnActiveStory ? `data-story-index="${ownGroup.openIndex}"` : ''}>
                <img src="${myAvatarSrc}" alt="${myUserName}"
                     onerror="this.src='${DEFAULT_STORY_AVATAR}'">
            </button>
            <button id="btnOpenCreateStory" type="button" class="my-story-add-badge" aria-label="أضف قصة جديدة">
                <span aria-hidden="true"></span>
            </button>
        </div>
    `;

    const storyButtons = groupedStories.map((group) => `
        <button class="story-avatar ${group.allViewed ? 'viewed' : ''}" data-story-index="${group.openIndex}" aria-label="ستوري ${group.userName}">
            <img src="${group.avatar}" alt="${group.userName}"
                 onerror="this.src='${DEFAULT_STORY_AVATAR}'">
        </button>
    `).join('');

    bar.innerHTML = myStoryButton + storyButtons;

    // ربط زرار صورة المستخدم نفسه: لو عنده استوري نشطة بيفتحها
    // (openStory)، ولو مفيش بيفتح مودال إنشاء استوري جديدة مباشرة
    const myAvatarBtn = document.getElementById('btnMyStoryAvatar');
    if (myAvatarBtn) {
        myAvatarBtn.addEventListener('click', () => {
            if (hasOwnActiveStory) {
                openStory(Number(myAvatarBtn.dataset.storyIndex));
            } else {
                openCreateStoryModal();
            }
        });
    }

    // ربط بادج الـ (+) الصغير دايمًا بفتح مودال إنشاء استوري جديدة -
    // event.stopPropagation() هنا يمنع أي تداخل مع حدث زرار الصورة
    // اللي البادج عائم فوقه بصريًا (خصوصًا وقت وجود استوري نشطة، عشان
    // ضغطة الـ + متفتحش استوري المستخدم بالغلط بدل مودال الإنشاء)
    const openCreateBtn = document.getElementById('btnOpenCreateStory');
    if (openCreateBtn) {
        openCreateBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            openCreateStoryModal();
        });
    }

    // ربط حدث الضغط على كل دائرة ستوري لباقي الأبطال (ما عدا زر هويتي) لفتح المودال
    bar.querySelectorAll('.story-avatar:not(.my-story-avatar)').forEach((btn) => {
        btn.addEventListener('click', () => openStory(Number(btn.dataset.storyIndex)));
    });
}

/**
 * رسم أشرطة التقدّم أعلى المودال - شريط واحد بس لكل ستوري بتاعة نفس
 * الشخص المفتوح حاليًا (currentGroupStoryIndices)، مش كل الستوريز في
 * التطبيق، عشان التقسيمة متتلخبطش بين أشخاص مختلفين
 */
function renderProgressBars() {
    const container = document.getElementById('storyProgressBars');
    if (!container) return;

    container.innerHTML = currentGroupStoryIndices.map((_, position) => `
        <div class="story-progress-bar" data-index="${position}">
            <span style="width: ${position < currentGroupPosition ? '100%' : '0%'}"></span>
        </div>
    `).join('');
}

/**
 * إرجاع عنصر شريط التقدّم (span الداخلي) الخاص بالستوري الحالية جوه
 * مجموعة الشخص المفتوح حاليًا
 * @returns {HTMLElement|null}
 */
function getActiveProgressBarSpan() {
    const bars = document.querySelectorAll('#storyProgressBars .story-progress-bar > span');
    return bars[currentGroupPosition] || null;
}

/**
 * تشغيل انيميشن التقدّم للستوري الحالية من الصفر عن طريق requestAnimationFrame
 * (بدل CSS transition عادي)، والانتقال التلقائي للستوري التالية بعد
 * مرور مدة STORY_DURATION_MS بالظبط (10 ثواني)
 */
function playCurrentStoryProgress() {
    cancelAnimationFrame(progressAnimationFrameId);
    storyProgressPausedElapsedMs = 0;
    isStoryProgressPaused = false;

    const activeBar = getActiveProgressBarSpan();
    if (activeBar) activeBar.style.width = '0%';

    storyProgressStartTime = performance.now();
    progressAnimationFrameId = requestAnimationFrame(stepStoryProgress);
}

/**
 * خطوة واحدة من انيميشن التقدّم (تتكرر عبر requestAnimationFrame).
 * بتحسب النسبة المئوية اللي مرت من المدة الكلية بدقة، وبتنتقل تلقائياً
 * للستوري التالية أول ما توصل 100%
 * @param {number} now - الطابع الزمني الحالي من requestAnimationFrame
 */
function stepStoryProgress(now) {
    if (isStoryProgressPaused) return; // متوقفة مؤقتاً (ضغطة مطولة) - منستناش فريم جديد لحد الاستئناف

    const activeBar = getActiveProgressBarSpan();
    const elapsedMs = storyProgressPausedElapsedMs + (now - storyProgressStartTime);
    const percent = Math.min(100, (elapsedMs / STORY_DURATION_MS) * 100);

    if (activeBar) activeBar.style.width = `${percent}%`;

    if (elapsedMs >= STORY_DURATION_MS) {
        goToNextStory();
        return;
    }

    progressAnimationFrameId = requestAnimationFrame(stepStoryProgress);
}

/**
 * إيقاف مؤقت الستوري الحالية مؤقتاً (وقت الضغطة المطولة)، مع حفظ
 * مقدار الوقت اللي مر فعلاً عشان الاستئناف يكمل من نفس النقطة بالظبط
 */
function pauseStoryProgress() {
    if (isStoryProgressPaused) return;
    isStoryProgressPaused = true;
    storyProgressPausedElapsedMs += performance.now() - storyProgressStartTime;
    cancelAnimationFrame(progressAnimationFrameId);
}

/**
 * استئناف مؤقت الستوري الحالية بعد رفع الضغطة المطولة، من نفس النقطة
 * اللي اتوقف عندها بالظبط (من غير ما يرجّع الشريط لـ 0%)
 */
function resumeStoryProgress() {
    if (!isStoryProgressPaused) return;
    isStoryProgressPaused = false;
    storyProgressStartTime = performance.now();
    progressAnimationFrameId = requestAnimationFrame(stepStoryProgress);
}

/**
 * مزامنة شكل زرار القلب (#storyHeartBtn) مع حالة اللايك الحالية للستوري
 * المعروضة، مع تشغيل أنيميشن النبضة اختيارياً (وقت الضغط فعلياً، مش وقت
 * مجرد عرض ستوري جديدة كانت متعجبة من الأول)
 * @param {boolean} isLiked
 * @param {boolean} withPulse - شغّل أنيميشن النبضة/التوهج ولا لأ
 */
function updateHeartButtonUI(isLiked, withPulse) {
    const heartBtn = document.getElementById('storyHeartBtn');
    if (!heartBtn) return;

    heartBtn.classList.toggle('liked', isLiked);
    heartBtn.classList.remove('pulse');

    if (withPulse) {
        // إعادة تشغيل الأنيميشن حتى لو كانت شغالة بالفعل (ضغطات سريعة متتالية):
        // بنجبر المتصفح يعمل reflow قبل ما نضيف الكلاس تاني
        void heartBtn.offsetWidth;
        heartBtn.classList.add('pulse');
        clearTimeout(heartPulseTimer);
        heartPulseTimer = setTimeout(() => heartBtn.classList.remove('pulse'), HEART_PULSE_DURATION_MS);
    }
}

/**
 * تسجيل "مشاهدة" الستوري الحالية في الباك إند (من غير ما نغيّر حالة
 * اللايك) - بتتنفذ مرة واحدة بس لكل ستوري في الجلسة الحالية (viewedOnBackend)
 * @param {Object} story
 */
async function reportStoryViewToBackend(story) {
    if (!story || story.viewedOnBackend) return;

    // صاحب الاستوري ماينفعش يتسجّل كمشاهد لاستوريه هو - قائمة "مين شافها"
    // لازم تفضل للناس التانية بس. ده كان الباگ اللي بيخلي صاحب الاستوري
    // يلاقي نفسه ظاهر في قايمة المشاهدين بمجرد ما يفتح استوريه بعد نزلها
    const isOwnStory = Boolean(currentUserId) && story.userId === currentUserId;
    if (isOwnStory) {
        story.viewedOnBackend = true; // منعرفش نحاول تاني، مفيش داعي أصلاً
        return;
    }

    try {
        // ملحوظة: مبعتّش p_liked خالص هنا عن قصد، عشان الدالة في الباك إند
        // تسجّل "مشاهدة" بس من غير ما تلمس حالة اللايك السابقة - اتأكدنا إن
        // p_liked معرّف بـ DEFAULT NULL في تعريف mark_story_viewed نفسها في
        // Supabase (وجسم الدالة بيعمل coalesce(p_liked, has_liked القديمة)
        // عشان القيمة القديمة تفضل زي ما هي لو p_liked جه null).
        // مهم: أسماء الباراميترات هنا لازم تتطابق حرفياً مع تعريف الدالة في
        // Supabase (p_story_id مش story_id) وإلا الاستدعاء هيفشل بالكامل.
        const { error } = await supabaseClient.rpc('mark_story_viewed', { p_story_id: story.id });
        if (error) throw error;
        story.viewedOnBackend = true;
    } catch (err) {
        // خطأ صامت هنا عمداً (بدون toast) - تسجيل المشاهدة عملية خلفية
        // مفيش داعي نزعج بيها المستخدم لو فشلت، هتتحاول تاني لما يفتح الاستوري تاني
        console.error('تعذر تسجيل مشاهدة الاستوري في السيرفر:', err.message);
    }
}

/**
 * تبديل حالة اللايك على الستوري الحالية المعروضة في المودال: تحديث
 * الواجهة فوراً (Optimistic UI) + أنيميشن النبضة، ثم إرسال الحالة
 * الجديدة لـ mark_story_viewed(story_id, is_liked) في الباك إند.
 * بترجّع الحالة زي ما كانت لو الطلب فشل.
 */
async function toggleStoryLike() {
    const story = storiesData[currentStoryIndex];
    if (!story) return;

    // (إصلاح) الدالة دي كانت بتتأكد بس إن المستخدم مش صاحب الاستوري
    // (isOwnStory) وبعدين تكمل مباشرة - لو currentUserId كان null أصلاً
    // (زائر حقيقي) isOwnStory كانت بترجع false تلقائيًا (زي أي حد تاني
    // مش صاحب الاستوري)، فمفيش حاجة كانت بتمنع الزائر من عمل لايك فعلي!
    // ونفس النمط المستخدم في handleStepsIncrease (js/app.js) لازم هنا
    // كمان: window.isGuestMode بقى معتمد حصريًا على وجود حساب/تسجيل
    // دخول فعلي (مش على الموقع الجغرافي - راجع نهاية geofence.js)،
    // فالفحص ده بيغطي أي حد مش داخل بحساب شخصي، بغض النظر عن مكانه
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تعمل لايك', type: 'info' },
        }));
        return;
    }

    // حماية إضافية: صاحب الاستوري مايقدرش يعمل لايك لاستوريه هو (الزرار
    // أصلاً بيبقى مخفي عنده - راجع updateHeartButtonVisibility - بس بنتأكد
    // هنا كمان تحسباً لأي استدعاء مباشر للدالة دي)
    const isOwnStory = Boolean(currentUserId) && story.userId === currentUserId;
    if (isOwnStory) return;

    const newLikedState = !story.liked;
    story.liked = newLikedState;
    story.viewedOnBackend = true; // اللايك نفسه بيثبت إن المستخدم شاف الاستوري فعلاً
    updateHeartButtonUI(newLikedState, /* withPulse */ true);

    try {
        // أسماء الباراميترات هنا لازم تتطابق حرفياً مع تعريف الدالة في
        // Supabase (p_story_id / p_liked) وإلا الاستدعاء هيفشل بالكامل
        const { error } = await supabaseClient.rpc('mark_story_viewed', {
            p_story_id: story.id,
            p_liked: newLikedState,
        });
        if (error) throw error;
    } catch (err) {
        // فشل الطلب: نرجّع الحالة والواجهة زي ما كانوا قبل الضغطة
        story.liked = !newLikedState;
        updateHeartButtonUI(story.liked, /* withPulse */ false);
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تعذر تسجيل الإعجاب، حاول تاني', type: 'error' },
        }));
        return;
    }

    // إشعار "story_reaction" لصاحب الاستوري - بس لما يكون فعلاً لايك
    // جديد (newLikedState === true)، مش لما يشيل اللايك (إلغاء إعجاب
    // مش "تفاعل" يستاهل إشعار). isOwnStory اتأكد منه فوق بالفعل (بيرجع
    // بدري لو صاحب الاستوري هو نفسه)، فمفيش داعي نكرر نفس الفحص هنا
    // تاني. بنعمل try/catch منفصل عن نداء mark_story_viewed فوق عمداً:
    // لو الإشعار فشل لأي سبب، مفروض ميأثرش على حالة اللايك نفسه اللي
    // نجح فعلاً - الإشعار مجرد تنبيه إضافي مش جزء أساسي من العملية.
    if (newLikedState) {
        try {
            // بنستورد sendNotification هنا محلياً (Dynamic Import) بدل
            // import ثابت أعلى الملف، لأن notifications.js بتستورد
            // getStories/openStory من هنا (stories.js) أصلاً - فـ import
            // ثابت في الاتجاهين كان هيعمل Circular Import حقيقي بين
            // الملفين (نفس مبدأ acceptFriendRequest/unlockBadge في
            // profiles.js)
            const currentUser = await getCurrentUser();

            // بنجيب اسم وصورة المُعجب الحقيقيين من جدول profiles (مش من
            // user_metadata بتاع Supabase Auth) - avatar_url مش متخزنة
            // في user_metadata أصلاً (شوف صف profiles وقت التسجيل في
            // auth.js)، فالاعتماد عليها هنا كان بيرجع دايمًا undefined
            // وده اللي كان بيخلي صورة المُعجب متظهرش في جرس الإشعارات
            let likerName = currentUser?.user_metadata?.full_name
                || currentUser?.user_metadata?.username
                || 'مستخدم';
            let likerAvatarUrl = null;

            if (currentUser?.id) {
                const { data: likerProfile } = await supabaseClient
                    .from('profiles')
                    .select('full_name, avatar_url')
                    .eq('id', currentUser.id)
                    .maybeSingle();

                if (likerProfile?.full_name) likerName = likerProfile.full_name;
                likerAvatarUrl = likerProfile?.avatar_url || null;
            }

            const { sendNotification } = await import('./notifications.js');
            await sendNotification({
                userId: story.userId,
                type: 'story_reaction',
                title: 'تفاعل جديد على الاستوري',
                message: `${likerName} تفاعل مع الاستوري بتاعك`,
                data: {
                    story_id: story.id,
                    sender_id: currentUser?.id || null,
                    sender_avatar_url: likerAvatarUrl,
                },
            });
        } catch (notifyErr) {
            console.error('خطأ غير متوقع أثناء إرسال إشعار التفاعل على الاستوري:', notifyErr);
        }
    }
}

/**
 * إظهار/إخفاء زرار القلب (#storyHeartBtn): بيتخفي بس لو صاحب الاستوري
 * المعروضة هو المستخدم الحالي المسجّل دخوله (مايقدرش يعمل لايك لنفسه)،
 * وبيظهر عادي لأي استوري تانية مش بتاعته
 * @param {Object} story
 */
function updateHeartButtonVisibility(story) {
    const heartBtn = document.getElementById('storyHeartBtn');
    if (!heartBtn) return;

    const isOwnStory = Boolean(currentUserId) && story && story.userId === currentUserId;
    heartBtn.classList.toggle('hidden', isOwnStory);
}

/**
 * إظهار/إخفاء زرار حذف الاستوري (#storyDeleteBtn): بيظهر بس لو صاحب
 * الاستوري المعروضة هو المستخدم الحالي المسجّل دخوله (نفس أسلوب
 * updateStoryViewersButtonUI بالظبط)
 * @param {Object} story
 */
function updateDeleteStoryButtonUI(story) {
    const btn = document.getElementById('storyDeleteBtn');
    if (!btn) return;

    const isOwner = Boolean(currentUserId) && story && story.userId === currentUserId;
    btn.classList.toggle('hidden', !isOwner);
}

/**
 * حذف الاستوري الحالية المعروضة نهائياً - بس لو المستخدم صاحبها فعلاً.
 * (تعديل) بقى بيفتح مودال تأكيد داخلي بهوية التطبيق (#storyDeleteConfirmModal
 * - نفس فلسفة #logoutConfirmModal بالظبط) بدل window.confirm() الافتراضي
 * من المتصفح. الحذف الفعلي اتنقل لدالة منفصلة (performDeleteCurrentStory
 * تحت)، بتتنادى بس لو المستخدم ضغط "حذف" فعلاً جوه المودال (شوف الربط
 * في initStoriesUI: btnConfirmDeleteStory)
 */
async function deleteCurrentStory() {
    const story = storiesData[currentStoryIndex];
    if (!story || !currentUserId || story.userId !== currentUserId) return;

    // (جديد) حتى لو المستخدم صاحب الاستوري فعلاً (currentUserId متطابق)،
    // ممكن يكون واقع دلوقتي في وضع الزائر (معاهوش حساب/مش مسجل دخول
    // فعليًا) - في الحالة دي بردو مينفعش يحذف، زي أي عملية حساسة تانية
    if (window.isGuestMode) {
        return;
    }

    openDeleteStoryConfirmModal();
}

/** الإخفاء الخام لمودال تأكيد حذف الاستوري فقط - استخدم closeDeleteStoryConfirmModal
 *  تحت. بنستأنف مؤقت التقدّم هنا دايمًا (سواء المستخدم ألغى، أو أكّد
 *  وخلص الحذف فعلاً) - نفس فلسفة hideStoryViewersModal بالظبط: لو
 *  الاستوري اتمسحت فعلاً، renderCurrentStory/closeStory هيتكفلوا بحالة
 *  المؤقت الصح بعد كده على أي حال */
function hideDeleteStoryConfirmModal() {
    const modal = document.getElementById('storyDeleteConfirmModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    resumeStoryProgress();
}

/**
 * إغلاق مودال تأكيد حذف الاستوري - الدالة العامة اللي زرار "إلغاء"
 * والضغط برّه المودال لازم ينادوا عليها بدل hideDeleteStoryConfirmModal
 */
function closeDeleteStoryConfirmModal() {
    closeModal();
}

/**
 * فتح مودال تأكيد حذف الاستوري: بيوقف مؤقت تقدّم الاستوري الحالية
 * (زي أي مودال فرعي تاني جوه مشغل المشاهدة، مثل مودال "مين شافها")
 * ويسجّل حالة جديدة في الـ History (History API) عشان زرار رجوع
 * المتصفح/الموبايل يقفله بشكل طبيعي بدل ما يقفل مشغل المشاهدة كله
 */
function openDeleteStoryConfirmModal() {
    const modal = document.getElementById('storyDeleteConfirmModal');
    if (!modal) return;

    pauseStoryProgress();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    pushModalState(hideDeleteStoryConfirmModal);
}

/**
 * الحذف الفعلي للاستوري الحالية المعروضة (بعد تأكيد المستخدم من
 * #storyDeleteConfirmModal) - بس لو هو صاحبها فعلاً. الحذف بيعتمد على
 * صلاحية RLS الموجودة أصلاً (text_stories_delete_own: user_id = auth.uid())،
 * فمفيش داعي لأي RPC أو تعديل في الباك إند خالص. بعد النجاح: بنشيلها
 * من storiesData محلياً فوراً، ونقفل مودال المشاهدة أو ننتقل للاستوري
 * اللي بعدها لو صاحبها عنده أكتر من استوري نشطة
 */
async function performDeleteCurrentStory() {
    const story = storiesData[currentStoryIndex];
    if (!story || !currentUserId || story.userId !== currentUserId) return;

    try {
        const { error } = await supabaseClient.from('text_stories').delete().eq('id', story.id);
        if (error) throw error;

        // شيل الاستوري من الشريط المحلي، وأعد حساب مجموعة استوريهات نفس
        // الشخص من الصفر على المصفوفة الجديدة (بدل ما نحاول نعدّل الفهارس
        // القديمة يدوياً - كانت هتبقى غلط تمامًا بعد ما المصفوفة تتغيّر).
        // بنستخدم getUserStoryIndices نفسها (مش حساب يدوي) عشان الترتيب
        // يفضل من الأقدم للأحدث زي باقي أماكن التنقل بالظبط
        const ownerId = story.userId;
        storiesData = storiesData.filter((item) => item.id !== story.id);
        currentGroupStoryIndices = getUserStoryIndices(ownerId);

        if (currentGroupStoryIndices.length === 0) {
            closeStory();
        } else {
            currentGroupPosition = Math.min(currentGroupPosition, currentGroupStoryIndices.length - 1);
            currentStoryIndex = currentGroupStoryIndices[currentGroupPosition];
            renderCurrentStory();
        }

        renderStoriesBar();
    } catch (err) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'تعذر حذف الاستوري، حاول تاني', type: 'error' } }));
        console.error('تعذر حذف الاستوري:', err.message);
    }
}

/**
 * تحديث شكل زرار "مين شاف الاستوري" (#storyViewersBtn): بيظهر بس لو
 * صاحب الاستوري المعروضة هو المستخدم الحالي المسجّل دخوله، وبيعرض
 * عدد المشاهدات المحمّل (لو اتحمّل، وإلا 0 مؤقتاً لحد ما loadStoryViewersIfOwner يخلص)
 * @param {Object} story
 */
function updateStoryViewersButtonUI(story) {
    const btn = document.getElementById('storyViewersBtn');
    const countEl = document.getElementById('storyViewersCount');
    if (!btn) return;

    const isOwner = Boolean(currentUserId) && story && story.userId === currentUserId;
    btn.classList.toggle('hidden', !isOwner);
    btn.classList.toggle('flex', isOwner);
    if (countEl) countEl.textContent = story ? String(story.viewCount || 0) : '0';
}

/**
 * جلب قائمة "مين شاف الاستوري" + حالة اللايك بتاعت كل واحد فيهم من
 * get_story_viewers(story_id) - بس لو المستخدم الحالي هو صاحب الاستوري
 * دي فعلاً (الباك إند برضه بيرفض الطلب لو مش صاحبها، كحماية إضافية).
 * بتحدّث عدد المشاهدات على الزرار أول ما تخلص.
 * @param {Object} story
 */
async function loadStoryViewersIfOwner(story) {
    if (!story || !currentUserId || story.userId !== currentUserId) return;

    try {
        const { data, error } = await supabaseClient.rpc('get_story_viewers', { p_story_id: story.id });
        if (error) throw error;

        story.viewers = data || [];
        story.viewCount = story.viewers.length;
        story.viewersLoaded = true;

        // نحدّث الزرار بس لو لسه نفس الاستوري دي المعروضة (المستخدم ممكن
        // يكون اتنقل لاستوري تانية لحد ما الطلب يخلص)
        if (storiesData[currentStoryIndex] === story) {
            updateStoryViewersButtonUI(story);
        }
    } catch (err) {
        console.error('تعذر تحميل قائمة مشاهدي الاستوري:', err.message);
    }
}

/**
 * رسم قائمة المشاهدين جوه storyViewersModal: كل صف بيعرض صورة المستخدم
 * واسمه ووقت المشاهدة، مع قلب "مليان" لو عمل لايك أو "فاضي" لو لسه ما عملش
 * @param {Array<Object>} viewers - راجعة من get_story_viewers
 */
function renderStoryViewersList(viewers) {
    const container = document.getElementById('storyViewersList');
    const modalCount = document.getElementById('storyViewersModalCount');
    if (modalCount) modalCount.textContent = String(viewers.length);
    if (!container) return;

    if (viewers.length === 0) {
        container.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">محدش شاف الاستوري لسه</p>`;
        return;
    }

    // كل صف بقى زرار (مش div عادي) عشان الضغط على أي مشاهد - عمل لايك
    // أو لأ، مش فرق - يفتح بروفايله العام (openPublicProfile)، بالظبط
    // نفس فلسفة storyOwnerProfileBtn في renderCurrentStory تحت.
    // data-viewer-id بدل ما نربط onclick هنا في innerHTML عشان نتجنب أي
    // مشاكل تسريب الـ id/الاسم جوه HTML خام (escaping) - البيانات نفسها
    // بتتقرا من مصفوفة viewers الأصلية في الـ event handler تحت
    container.innerHTML = viewers.map((viewer, index) => `
        <button type="button" class="story-viewer-row w-full text-right bg-lux-800 p-2.5 rounded-2xl flex items-center justify-between hover:bg-lux-700/70 transition-colors" data-viewer-index="${index}" aria-label="بروفايل ${viewer.full_name || 'بطل'}">
            <div class="flex items-center gap-2.5">
                <img src="${viewer.avatar_url || DEFAULT_STORY_AVATAR}" alt="${viewer.full_name || 'بطل'}"
                     class="w-9 h-9 rounded-full object-cover border border-gold-500/20"
                     onerror="this.src='${DEFAULT_STORY_AVATAR}'">
                <div class="flex flex-col">
                    <span class="text-xs font-extrabold text-lux-100">${viewer.full_name || 'بطل'}</span>
                    ${viewer.username ? `<span class="text-[10px] text-lux-500 font-medium">@${viewer.username}</span>` : ''}
                </div>
            </div>
            ${viewer.liked ? `<span class="text-rose-400" aria-label="عمل لايك"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-6.7-4.35-9.3-8.1C1 10.2 1.6 6.9 4.3 5.3c2.2-1.3 4.9-.7 6.4 1.2l1.3 1.6 1.3-1.6c1.5-1.9 4.2-2.5 6.4-1.2 2.7 1.6 3.3 4.9 1.6 7.6C18.7 16.65 12 21 12 21Z"/></svg></span>` : ''}
        </button>
    `).join('');

    // نربط حدث الضغط بعد ما الـ innerHTML يتحط، بدل onclick جوه الـ HTML
    // مباشرة، عشان نقدر نستخدم دالة عادية (مش لازم تبقى معرّفة على window)
    container.querySelectorAll('.story-viewer-row').forEach((row) => {
        row.addEventListener('click', () => {
            const viewer = viewers[Number(row.dataset.viewerIndex)];
            const viewerUserId = viewer?.id || viewer?.viewer_id || viewer?.user_id || viewer?.profile_id;
            if (viewerUserId) {
                openStoryViewerProfile(viewerUserId);
            } else {
                // مفيش أي حقل من دول جوّه الصف الراجع من get_story_viewers -
                // يبقى اسم عمود الـ id في الدالة نفسها في Supabase مختلف عن
                // كل التسميات المتوقعة دي. اطبع الصف كامل هنا عشان تعرف
                // اسم الحقل الفعلي من الـ Console وتبعتهولي، بدل ما الزرار
                // يفضل مش بيعمل حاجة من غير أي تفسير
                console.error('تعذر تحديد معرّف المشاهد - الحقول المتاحة في الصف:', viewer);
            }
        });
    });
}

/**
 * فتح البروفايل العام لمشاهد اتضغط عليه جوه مودال "مين شاف الاستوري"
 * (storyViewersModal) - المودال ده متداخل فوق مودال مشاهدة الاستوري
 * (storyViewerModal) نفسه، فلازم نقفل الاتنين (إخفاء خام، من غير
 * history.back المتزامن - نفس سبب استخدام hideStoryViewerModal بدل
 * closeStory جوه storyOwnerProfileBtn تحت) قبل ما نفتح صفحة البروفايل
 * @param {string} viewerId
 */
function openStoryViewerProfile(viewerId) {
    hideStoryViewersModal();
    hideStoryViewerModal();
    openPublicProfile(viewerId, { replaceHistory: true });
}

/**
 * فتح مودال "مين شاف الاستوري" للستوري الحالية المعروضة (بس لو المستخدم
 * صاحبها) - بيوقف مؤقت التقدّم زي الضغطة المطولة بالظبط عشان الاستوري ماتفوتش
 * وهو بيقرا القائمة، وبيعرض القائمة المحمّلة مسبقاً لو موجودة أو يجيبها دلوقتي
 */
async function openStoryViewersModal() {
    const story = storiesData[currentStoryIndex];
    if (!story || !currentUserId || story.userId !== currentUserId) return;

    pauseStoryProgress();

    const modal = document.getElementById('storyViewersModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    // تسجيل خطوة في تاريخ المتصفح - المودال ده بيتفتح فوق storyViewerModal
    // نفسه (مودال متداخل)، فزرار الرجوع هيقفل مودال "مين شاف" ده الأول
    // بس، ويرجّع المستخدم لمودال الاستوري الأساسي لسه مفتوح تحته
    pushModalState(hideStoryViewersModal);

    if (story.viewersLoaded) {
        renderStoryViewersList(story.viewers);
    } else {
        const container = document.getElementById('storyViewersList');
        if (container) container.innerHTML = `<p class="text-xs text-lux-500 font-medium text-center py-3">بنجيب القائمة...</p>`;
        await loadStoryViewersIfOwner(story);
        renderStoryViewersList(story.viewers);
    }
}

/** الإخفاء الخام لمودال "مين شاف الاستوري" فقط - استخدم closeStoryViewersModal تحت */
function hideStoryViewersModal() {
    const modal = document.getElementById('storyViewersModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    resumeStoryProgress();
}

/**
 * إغلاق مودال "مين شاف الاستوري" - الدالة العامة اللي زرار الإغلاق
 * والضغط برّه المودال لازم ينادوا عليها بدل hideStoryViewersModal
 */
function closeStoryViewersModal() {
    closeModal();
}

/**
 * عرض محتوى وهيدر الستوري الحالية داخل المودال
 */
function renderCurrentStory() {
    const story = storiesData[currentStoryIndex];
    const header = document.getElementById('storyHeader');
    const content = document.getElementById('storyContent');

    if (header) {
        // اسم/صورة صاحب الستوري بقوا زرار (مش div عادي) عشان الضغط عليهم
        // يفتح مودال بروفايله العام (openPublicProfile) - نفس فلسفة زرار
        // القلب/مين شافها تحت بالظبط: لازم نوقف الـ event bubbling عشان
        // الضغطة ماتتفسرش كمان كتنقل بين الاستوريز (رغم إن storyHeader
        // فوق منطقتي التنقل أصلاً بفضل z-20 > z-10، بس الوقف صريح أضمن)
        header.innerHTML = `
            <button type="button" id="storyOwnerProfileBtn" class="flex items-center gap-2 text-right" aria-label="بروفايل ${story.userName}">
                <img src="${story.avatar}" class="w-8 h-8 rounded-full object-cover border border-white/40" alt="${story.userName}"
                     onerror="this.src='${DEFAULT_STORY_AVATAR}'">
                <div class="flex flex-col leading-tight">
                    <span class="text-white text-xs font-extrabold">${story.userName}</span>
                    <span class="text-white/60 text-[10px] font-bold">${formatRelativeTimeArabic(story.createdAt)}</span>
                </div>
            </button>
        `;

        const ownerProfileBtn = document.getElementById('storyOwnerProfileBtn');
        if (ownerProfileBtn) {
            ownerProfileBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                // لازم نقفل مودال الاستوري الأول قبل فتح البروفايل العام،
                // لأن #storyViewerModal مودال fixed inset-0 (z-[55]) بيغطي
                // الشاشة كلها فوق #tab-public-profile - من غير القفل ده
                // البروفايل كان بيتفعّل فعلاً في الخلفية بس منظهرش للمستخدم
                // غير لما يقفل الاستوري بنفسه (ده بالظبط اللي كان بيحصل)
                //
                // ملحوظة (History API): هنا بالذات بننادي hideStoryViewerModal
                // مباشرة (مش closeStory) وبنمرر replaceHistory:true تحت،
                // عشان إحنا "بنستبدل" مودال الاستوري بصفحة البروفايل مش
                // بنقفله عادي - لو استخدمنا closeStory() (اللي بينادي
                // history.back() غير متزامن) وبعدها على طول openPublicProfile
                // (اللي بيعمل pushState) هيحصل Race Condition بين الاتنين.
                // شوف تعليق replaceModalState في js/modal-history.js
                hideStoryViewerModal();
                openPublicProfile(story.userId, { replaceHistory: true });
            });
            ownerProfileBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
            ownerProfileBtn.addEventListener('pointerup', (event) => event.stopPropagation());
        }
    }

    if (content) {
        content.style.background = story.background;

        // (المرحلة 4-ب) لو الاستوري دي معاها بيانات ملصق إنجاز حي
        // (story.statData - شوف mapRpcRowToStory/publishStory)، بنرسم
        // نفس كبسولة المعاينة الحية بالظبط (كلاسات .story-stat-sticker*
        // المعرّفة في style.css - نفس الكلاسات المستخدمة في #storyPreviewSticker
        // وقت الإنشاء، فالشكل متطابق تلقائيًا من غير أي CSS مكرر).
        // (تعديل) موضع/مقاس الكبسولة بقى بيتطبق بعد الإدراج في الـ DOM
        // مباشرة عن طريق positionRenderedSticker تحت (مش كـ style مضمّن
        // هنا)، عشان يقدر يصحح اختلاف نسبة عرض/ارتفاع شاشة العرض الفعلية
        // عن صندوق المعاينة وقت الإنشاء - راجع تعليق الدالة دي لتفاصيل
        // المشكلة والحل. استوري عادية من غير ملصق (statData=null) هتفضل
        // تتعرض بالظبط زي ما كانت من غير أي تغيير - مفيش HTML إضافي بيتحقن خالص
        const statStickerHtml = story.statData
            ? `<div class="story-stat-sticker" aria-hidden="true">
                    <span class="story-stat-sticker-icon">🔥</span>
                    <span class="story-stat-sticker-steps">${story.statData.steps.toLocaleString('en-US')} خطوة</span>
                    <span class="story-stat-sticker-percent">${story.statData.percent}%</span>
               </div>`
            : '';

        content.innerHTML = `<p class="text-white text-lg px-8 ${story.fontClass || 'font-cairo font-black'} text-center">${story.content}</p>${statStickerHtml}`;

        if (story.statData) {
            positionRenderedSticker(content, content.querySelector('.story-stat-sticker'), story.statData);
        }
    }

    // نسجّل المشاهدة (محلياً + في الواجهة) مرة واحدة بس أول ما الاستوري تتفتح فعلياً
    // ده تسجيل محلي فوري (localStorage) عشان إطار الاستوري في الشريط الرئيسي
    // يتلوّن رمادي على طول - منفصل عن استدعاء الباك إند اللي بعد الثانيتين تحت
    if (!story.viewed) {
        story.viewed = true;
        markStoryAsViewed(story.id);
        renderStoriesBar();
    }

    // مزامنة شكل زرار القلب مع حالة اللايك الحالية للستوري دي (من غير أنيميشن
    // نبضة - النبضة بس وقت الضغط الفعلي من toggleStoryLike)
    updateHeartButtonUI(story.liked, /* withPulse */ false);

    // إخفاء زرار القلب لو المستخدم الحالي هو صاحب الاستوري دي (مايقدرش
    // يعمل لايك لنفسه) - بيظهر عادي لأي استوري تانية مش بتاعته
    updateHeartButtonVisibility(story);

    // إظهار/إخفاء زرار "مين شافها" حسب هل المستخدم الحالي هو صاحب الاستوري
    // دي، وجلب قائمة المشاهدين + عددهم في الخلفية لو كانت ملكه فعلاً
    updateStoryViewersButtonUI(story);
    loadStoryViewersIfOwner(story);

    // إظهار/إخفاء زرار حذف الاستوري بنفس منطق زرار "مين شافها" بالظبط
    updateDeleteStoryButtonUI(story);

    // تسجيل "مشاهدة" فعلية في الباك إند لو الاستوري فضلت مفتوحة أكتر من
    // VIEW_MARK_DELAY_MS (ثانيتين) - بيتلغي فوراً لو المستخدم نقل لاستوري
    // تانية أو قفل المودال قبل ما الوقت ده يخلص (شوف closeStory/goToNextStory)
    clearTimeout(viewMarkTimer);
    viewMarkTimer = setTimeout(() => reportStoryViewToBackend(story), VIEW_MARK_DELAY_MS);

    renderProgressBars();
    playCurrentStoryProgress();
}

/**
 * فتح مودال مشاهدة الستوريز بدءاً من ستوري معينة - بيحدد مجموعة
 * (currentGroupStoryIndices) ستوريز نفس صاحب الستوري دي بس، عشان
 * التنقل والتقسيمة يفضلوا محصورين في ستوريز الشخص ده لوحده
 * @param {number} index - ترتيب الستوري المطلوب فتحها
 */
export function openStory(index) {
    if (index < 0 || index >= storiesData.length) return;

    const story = storiesData[index];
    currentGroupStoryIndices = getUserStoryIndices(story.userId);
    currentGroupPosition = Math.max(0, currentGroupStoryIndices.indexOf(index));
    currentStoryIndex = currentGroupStoryIndices[currentGroupPosition];

    const modal = document.getElementById('storyViewerModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    renderCurrentStory();
    document.dispatchEvent(new CustomEvent('stories:opened', { detail: { storyId: storiesData[currentStoryIndex].id } }));

    // تسجيل خطوة في تاريخ المتصفح عشان زرار رجوع الموبايل يقفل مودال
    // الاستوري بس (بدل ما يخرج المستخدم بره الصفحة) - شوف js/modal-history.js
    pushModalState(hideStoryViewerModal);
}

/**
 * الإخفاء "الخام" لمودال مشاهدة الستوريز فقط (إيقاف المؤقتات وإخفاء
 * الـ DOM) - من غير أي منطق History API جواها. متتنادَاش مباشرة من
 * أي مكان تاني في الملف؛ استخدم closeStory() تحت بدل منها دايماً،
 * إلا في حالة استثنائية واحدة (الانتقال المباشر لبروفايل صاحب
 * الاستوري - شوف renderCurrentStory تحت وتعليق replaceModalState).
 */
function hideStoryViewerModal() {
    cancelAnimationFrame(progressAnimationFrameId);
    isStoryProgressPaused = false;
    clearTimeout(longPressTimer);
    isLongPressActive = false;
    clearTimeout(viewMarkTimer);
    const modal = document.getElementById('storyViewerModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    document.dispatchEvent(new CustomEvent('stories:closed'));

    // لو وصل تحديث Realtime (استوري جديدة من حد تاني) وإحنا كنا لسه
    // بنتفرج، نفّذه دلوقتي بعد ما قفلنا المودال فعلاً (شوف تعليق
    // refreshStoriesRespectingOpenViewer فوق)
    if (hasPendingStoriesRefreshFromRealtime) {
        hasPendingStoriesRefreshFromRealtime = false;
        refreshStories();
    }
}

/**
 * إغلاق مودال مشاهدة الستوريز - الدالة العامة اللي كل زرار/حدث إغلاق
 * في الملف ده لازم ينادي عليها (X، الضغط برّه المودال، حذف آخر
 * استوري..إلخ) بدل ما ينادي hideStoryViewerModal مباشرة. بتستهلك خطوة
 * تاريخ المتصفح اللي كنا ضفناها في openStory عن طريق history.back()
 * (شوف js/modal-history.js) - وده اللي بيقفل المودال فعلياً.
 */
export function closeStory() {
    closeModal();
}

/**
 * الانتقال للستوري التالية بتاعة نفس الشخص، أو إغلاق المودال لو كانت
 * آخر ستوري عنده - عمداً منقلش تلقائي لستوريز شخص تاني، عشان كل شخص
 * يفضل معزول تمامًا عن اللي بعده
 */
export function goToNextStory() {
    if (currentGroupPosition < currentGroupStoryIndices.length - 1) {
        currentGroupPosition += 1;
        currentStoryIndex = currentGroupStoryIndices[currentGroupPosition];
        renderCurrentStory();
    } else {
        closeStory();
    }
}

/**
 * الرجوع للستوري السابقة بتاعة نفس الشخص (لو موجودة) - بردو من غير ما
 * نطلع لستوريز شخص تاني
 */
export function goToPreviousStory() {
    if (currentGroupPosition > 0) {
        currentGroupPosition -= 1;
        currentStoryIndex = currentGroupStoryIndices[currentGroupPosition];
        renderCurrentStory();
    }
}

/**
 * ربط أزرار التنقل والإغلاق داخل مودال الستوريز بالمنطق الخاص بيها
 * تُستدعى مرة واحدة من app.js عند بداية تشغيل التطبيق
 */
export async function initStoriesUI() {
    // بنجيب هوية المستخدم الحالي هنا كـ"قيمة أولية سريعة" بس - مش مصدر
    // وحيد للحقيقة. initStoriesUI() بتتنادى من app.js *قبل*
    // checkExistingSession() (اللي بتتكفل بالتحقق الفعلي من الجلسة مع
    // Supabase)، فلو نادينا getCurrentUser() هنا واعتمدنا عليها بس، كانت
    // بترجع null غالباً لأن نظام المصادقة لسه مايكونش خلّص، وcurrentUserId
    // كان بيفضل null للأبد (مفيش حد بيحدّثها تاني) - وده اللي كان بيسبب
    // ظهور زرار القلب بدل زرار "عدد المشاهدات" على استوري المستخدم نفسه.
    // المصدر الحقيقي دلوقتي هو مستمعي auth:login/auth:signed-out تحت،
    // بنفس الأسلوب اللي profiles.js بيستخدمه مع currentAuthUser.
    // (إصلاح دفاعي): لو getCurrentUser() فشلت لأي سبب غير متوقع (زي باج
    // Auth session missing! القديم في auth.js لو حد رجّعه بالغلط)،
    // كنا بنوقف initStoriesUI() بالكامل هنا - يعني مستمعي auth:login/
    // auth:signed-out تحت (وجلب الاستوريات وعرضها) ما كانوش بيتسجلوا
    // خالص لأي زائر بدون حساب. دلوقتي بنمسك أي فشل هنا ونكمل بـ null
    // (نفس سلوك الزائر العادي)، عشان initStoriesUI() تفضل تكمّل باقي
    // مسؤولياتها مهما حصل لخطوة "القيمة الأولية السريعة" دي بالذات
    // (إصلاح - باج حقيقي): avatar_url و full_name الحقيقيين مش متخزنين في
    // user_metadata بتاع Supabase Auth أصلاً - دول متخزنين في جدول profiles
    // بس (شوف signUpWithUsername في auth.js: بتتحفظ بـ .from('profiles').upsert
    // مش في options.data وقت auth.signUp). فالاعتماد على
    // user.user_metadata?.avatar_url كان بيرجع undefined دايمًا، ومعاه
    // renderStoriesBar كانت بتقع على DEFAULT_STORY_AVATAR دايمًا حتى لو
    // المستخدم فعلاً عنده صورة بروفايل حقيقية محفوظة - وده بالظبط اللي كان
    // بيمنع صورة المستخدم من الظهور في زر "هويتي". نفس الباج اتصلّح قبل كده
    // في نفس الملف لحالة "مين عمل لايك" (شوف تعليق likerAvatarUrl فوق) -
    // هنا بنطبّق نفس الحل: جلب صريح من جدول profiles بـ id المستخدم
    let user = null;
    try {
        user = await getCurrentUser();
    } catch (err) {
        console.error('تعذر جلب المستخدم الحالي في initStoriesUI:', err.message);
    }
    currentUserId = user ? user.id : null;
    currentUserAvatar = null;
    currentUserName = user
        ? (user.user_metadata?.full_name || user.user_metadata?.username || null)
        : null;

    if (user?.id) {
        try {
            const { data: myProfile } = await supabaseClient
                .from('profiles')
                .select('full_name, avatar_url')
                .eq('id', user.id)
                .maybeSingle();

            if (myProfile?.avatar_url) currentUserAvatar = myProfile.avatar_url;
            if (myProfile?.full_name) currentUserName = myProfile.full_name;
        } catch (err) {
            console.error('تعذر جلب بروفايل المستخدم الحالي (avatar_url/full_name) في initStoriesUI:', err.message);
        }
    }

    document.addEventListener('auth:login', async (event) => {
        const loggedInUser = event.detail?.user || null;
        currentUserId = loggedInUser?.id || null;
        currentUserAvatar = null;
        currentUserName = loggedInUser?.user_metadata?.full_name
            || loggedInUser?.user_metadata?.username || null;

        // نفس الإصلاح فوق بالظبط: نجيب avatar_url/full_name الحقيقيين من
        // جدول profiles بعد تسجيل الدخول، مش من user_metadata اللي فاضية
        // منهم دايمًا
        if (loggedInUser?.id) {
            try {
                const { data: myProfile } = await supabaseClient
                    .from('profiles')
                    .select('full_name, avatar_url')
                    .eq('id', loggedInUser.id)
                    .maybeSingle();

                if (myProfile?.avatar_url) currentUserAvatar = myProfile.avatar_url;
                if (myProfile?.full_name) currentUserName = myProfile.full_name;
            } catch (err) {
                console.error('تعذر جلب بروفايل المستخدم بعد تسجيل الدخول (avatar_url/full_name):', err.message);
            }
        }

        // لو فيه استوري مفتوحة دلوقتي وقت ما الهوية اتحدثت، حدّث شكل
        // الأزرار (القلب/المشاهدات/الحذف) على طول من غير ما نستنى تنقل
        // المستخدم لاستوري تانية
        const openStory = storiesData[currentStoryIndex];
        if (openStory) {
            updateHeartButtonVisibility(openStory);
            updateDeleteStoryButtonUI(openStory);
            updateStoryViewersButtonUI(openStory);
        }

        // تحديث زر "هويتي" في الشريط فورًا بصورة المستخدم الجديدة بمجرد
        // تسجيل الدخول (بدل ما يفضل عارض الأفاتار الافتراضي لحد أي تحديث تاني)
        renderStoriesBar();
    });

    document.addEventListener('auth:signed-out', () => {
        currentUserId = null;
        currentUserAvatar = null;
        currentUserName = null;
        renderStoriesBar();
    });

    // (تعديل - كاش الأوفلاين): هنا (أول فتح للتطبيق) هو المكان الصح
    // لعرض النسخة المخزّنة محلياً فوراً (لو موجودة) قبل ما رد الشبكة
    // يوصل - بعكس refreshStories() فوق، هنا مفيش أي storiesData
    // معروضة أصلاً قبل كده، فمفيش خطر "قفزة بصرية للخلف".
    await fetchWithCache('cached_stories', fetchActiveStories, (stories) => {
        storiesData = stories;
        renderStoriesBar();
    });

    // إعادة جلب الاستوريات تلقائياً كل AUTO_REFRESH_INTERVAL_MS (5 دقايق)
    // في الخلفية، عشان نتخلص من أي استوري انتهت صلاحيتها لو المستخدم
    // فاتح التطبيق لفترة طويلة من غير Refresh للصفحة. بنتأكد الأول إن
    // مفيش مؤقت شغال بالفعل (لو initStoriesUI اتنادت أكتر من مرة بالغلط)
    // عشان منعملش أكتر من setInterval واحد شغال في نفس الوقت
    if (autoRefreshTimerId !== null) {
        clearInterval(autoRefreshTimerId);
    }
    autoRefreshTimerId = setInterval(() => {
        refreshStories();
    }, AUTO_REFRESH_INTERVAL_MS);

    // اشتراك Realtime عشان أي استوري جديدة تتضاف (أو تتحذف) تظهر في
    // الشريط فوراً لحظيًا من غير ما نستنى دورة الـ 5 دقايق التلقائية
    // فوق أو Refresh يدوي للصفحة (راجع تعليق bindStoriesRealtimeSubscription)
    bindStoriesRealtimeSubscription();

    // كل ربط أحداث الـ DOM تحت ده (تنقل/إغلاق/لايك/حذف/مين شافها/مودال
    // الإنشاء) لازم يحصل مرة واحدة بس على مدار عمر الصفحة - محمي بـ
    // storiesUiEventsBound فوق (راجع تعليقها لتفاصيل المشكلة اللي كانت
    // بتحصل من غيره: تكرار الأفعال بعدد مرات استدعاء initStoriesUI)
    if (storiesUiEventsBound) return;
    storiesUiEventsBound = true;

    // ملحوظة: أسماء العناصر الفعلية في index.html هي storyRightZone/
    // storyLeftZone (خصائص فيزيائية ثابتة - يمين وشمال فعليين على
    // الشاشة، بغض النظر عن أي حاجة تانية). بناءً على طلب المستخدم،
    // اتجاه التنقل اتقلب عمداً هنا: الضغط على يمين الشاشة = الرجوع
    // للاستوري السابقة، والضغط على شمالها = الانتقال للتالية (بدل
    // العكس اللي كان قبل كده) - عشان يماشي اتجاه القراءة/التصفح العربي
    // (يمين لشمال) اللي المستخدم توقعه
    const nextZone = document.getElementById('storyLeftZone');  // شمال = التالية
    const prevZone = document.getElementById('storyRightZone'); // يمين = السابقة
    const closeBtn = document.getElementById('storyCloseBtn');
    const viewerCard = document.getElementById('storyViewerCard');
    const modal = document.getElementById('storyViewerModal');
    const heartBtn = document.getElementById('storyHeartBtn');

    // ضغطة عادية (تاب) على منطقة يمين/شمال بتنقل بين الاستوريات - إلا
    // لو كانت النقلة دي في الحقيقة نهاية ضغطة مطولة (هنتجاهلها هنا لأنها
    // كانت بالفعل قامت بالإيقاف/الاستئناف عن طريق pointerdown/up تحت)
    if (nextZone) {
        nextZone.addEventListener('click', () => {
            if (isLongPressActive) { isLongPressActive = false; return; }
            goToNextStory();
        });
    }
    if (prevZone) {
        prevZone.addEventListener('click', () => {
            if (isLongPressActive) { isLongPressActive = false; return; }
            goToPreviousStory();
        });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeStory);

    // زرار القلب فوق منطقتي التنقل (يمين/شمال) بصرياً (z-30 > z-10 في
    // index.html)، لكن لازم نوقف الـ event bubbling صراحةً عشان الضغطة
    // عليه ماتتفسرش كمان كـ"تاب" على منطقة التنقل تحته (هيتنقل/هيقفل
    // المودال غلط لو نسينا الـ stopPropagation دي)
    if (heartBtn) {
        heartBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleStoryLike();
        });
        // منع الضغط على القلب (حتى لو استمر شوية) من إنه يتفسر كـ"ضغطة
        // مطولة" على الكارت ويوقف مؤقت التقدّم - القلب له سلوك مستقل تماماً
        heartBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
        heartBtn.addEventListener('pointerup', (event) => event.stopPropagation());
    }

    // زرار "مين شاف الاستوري" (بيظهر لصاحب الاستوري بس) - نفس فلسفة زرار
    // القلب: لازم نوقف الـ event bubbling عشان الضغطة ماتتفسرش كتنقل/ضغطة
    // مطولة على الكارت اللي تحته
    const viewersBtn = document.getElementById('storyViewersBtn');
    if (viewersBtn) {
        viewersBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            openStoryViewersModal();
        });
        viewersBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
        viewersBtn.addEventListener('pointerup', (event) => event.stopPropagation());
    }

    // زرار حذف الاستوري (بيظهر لصاحب الاستوري بس) - نفس فلسفة زرار "مين
    // شاف الاستوري" بالظبط: لازم نوقف الـ event bubbling عشان الضغطة
    // ماتتفسرش كتنقل/إغلاق للمودال
    const deleteBtn = document.getElementById('storyDeleteBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteCurrentStory();
        });
        deleteBtn.addEventListener('pointerdown', (event) => event.stopPropagation());
        deleteBtn.addEventListener('pointerup', (event) => event.stopPropagation());
    }

    // إغلاق مودال "مين شاف الاستوري": زرار الإغلاق، أو الضغط برّه الكارت
    const viewersModal = document.getElementById('storyViewersModal');
    const closeViewersBtn = document.getElementById('btnCloseStoryViewers');
    if (closeViewersBtn) closeViewersBtn.addEventListener('click', closeStoryViewersModal);
    if (viewersModal) {
        viewersModal.addEventListener('click', (event) => {
            if (event.target === viewersModal) closeStoryViewersModal();
        });
    }

    // مودال تأكيد حذف الاستوري (#storyDeleteConfirmModal) - بديل داخل
    // التطبيق بهوية ألوانه لـ window.confirm() الافتراضي من المتصفح
    // (نفس فلسفة #logoutConfirmModal بالظبط: زرار "إلغاء" وزرار الضغط
    // برّه الكارت بيقفلوا المودال بس، وزرار "حذف" بيقفله وبعدين ينفّذ
    // الحذف الفعلي - راجع deleteCurrentStory/performDeleteCurrentStory فوق)
    const deleteConfirmModal = document.getElementById('storyDeleteConfirmModal');
    const cancelDeleteBtn = document.getElementById('btnCancelDeleteStory');
    const confirmDeleteBtn = document.getElementById('btnConfirmDeleteStory');
    if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', closeDeleteStoryConfirmModal);
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            closeDeleteStoryConfirmModal();
            performDeleteCurrentStory();
        });
    }
    if (deleteConfirmModal) {
        deleteConfirmModal.addEventListener('click', (event) => {
            if (event.target === deleteConfirmModal) closeDeleteStoryConfirmModal();
        });
    }

    // الضغطة المطولة: بتتراقب على مستوى الكارت كله (storyViewerCard)
    // بغض النظر عن العنصر الفرعي اللي اتضغط (منطقة تنقل، محتوى..إلخ)
    // بفضل الـ event bubbling، زي ما هو موضّح في تعليق الـ HTML الأصلي
    if (viewerCard) {
        viewerCard.addEventListener('pointerdown', handleStoryPointerDown);
        viewerCard.addEventListener('pointerup', handleStoryPointerUp);
        viewerCard.addEventListener('pointerleave', handleStoryPointerCancel);
        viewerCard.addEventListener('pointercancel', handleStoryPointerCancel);
    }

    // الضغط على الخلفية المظلمة نفسها (بره منطقة العرض) بيقفل المودال
    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeStory();
        });
    }

    // (تعديل) إعادة حساب موضع ملصق الإنجاز الحي عند أي تغيير في أبعاد
    // الشاشة (تدوير الموبايل، تغيير حجم نافذة المتصفح..إلخ) لحد ما مشغل
    // المشاهدة مفتوح فعلاً ومعروض عليه استوري معاها ملصق - عشان الملصق
    // يفضل في مكانه النسبي الصح مع أي تغيير في نسبة عرض/ارتفاع الشاشة
    // (راجع positionRenderedSticker لتفاصيل ليه ده مهم أصلاً)
    window.addEventListener('resize', () => {
        if (!modal || modal.classList.contains('hidden')) return;
        const currentStory = storiesData[currentStoryIndex];
        if (!currentStory || !currentStory.statData) return;
        const storyContentEl = document.getElementById('storyContent');
        if (!storyContentEl) return;
        positionRenderedSticker(
            storyContentEl,
            storyContentEl.querySelector('.story-stat-sticker'),
            currentStory.statData,
        );
    });

    // تهيئة مودال إنشاء الاستوري (المرحلة الثانية)
    bindCreateStoryModalEvents();
}

/**
 * بداية الضغطة (pointerdown) على كارت الستوري: بندي مهلة
 * LONG_PRESS_THRESHOLD_MS قبل ما نعتبرها ضغطة مطولة فعلاً وتوقف المؤقت
 * (عشان تاب عادي سريع للتنقل مايتوقفش عن طريق الغلط)
 */
function handleStoryPointerDown() {
    isLongPressActive = false;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
        isLongPressActive = true;
        pauseStoryProgress();
    }, LONG_PRESS_THRESHOLD_MS);
}

/**
 * رفع الضغطة (pointerup): لو كانت وصلت فعلاً لحالة "ضغطة مطولة"،
 * بنستأنف المؤقت من نفس النقطة. لو لسه ماوصلتش (تاب سريع)، بنلغي
 * المهلة من غير أي تأثير على المؤقت أصلاً
 */
function handleStoryPointerUp() {
    clearTimeout(longPressTimer);
    if (isLongPressActive) {
        resumeStoryProgress();
    }
}

/**
 * خروج المؤشر من الكارت أو إلغاء الضغطة (pointerleave/pointercancel) -
 * نفس منطق الرفع العادي، عشان مانسيبش المؤقت واقف لو المستخدم سحب
 * إصبعه بره الكارت من غير ما يرفعها فعلياً
 */
function handleStoryPointerCancel() {
    clearTimeout(longPressTimer);
    if (isLongPressActive) {
        resumeStoryProgress();
    }
    isLongPressActive = false;
}

/* ==================================================================
   (المرحلة الثانية) منطق مودال إنشاء الاستوري
   ================================================================== */

/**
 * رسم أزرار اختيار الخلفية والخط جوه مودال الإنشاء
 * تُستدعى مرة واحدة بس من bindCreateStoryModalEvents (المحتوى ثابت،
 * فمفيش داعي نعيد رسمه في كل فتح للمودال)
 */
function renderCreateStoryOptionButtons() {
    const bgContainer = document.getElementById('storyBgOptions');
    const durationContainer = document.getElementById('storyDurationOptions');
    if (!bgContainer) return;

    // --- أزرار الخلفية ---
    bgContainer.innerHTML = STORY_BG_OPTIONS.map((bg) => `
        <button type="button" class="story-bg-swatch ${bg.id === createStoryState.selectedBg.id ? 'selected' : ''}"
                data-bg-id="${bg.id}" style="background: ${bg.value};" aria-label="خلفية ${bg.id}"></button>
    `).join('');

    bgContainer.querySelectorAll('.story-bg-swatch').forEach((btn) => {
        btn.addEventListener('click', () => {
            const bg = STORY_BG_OPTIONS.find((option) => option.id === btn.dataset.bgId);
            if (!bg) return;
            createStoryState.selectedBg = bg;
            bgContainer.querySelectorAll('.story-bg-swatch').forEach((el) => el.classList.remove('selected'));
            btn.classList.add('selected');
            updateLivePreview();
        });
    });

    // ملحوظة: قسم اختيار "شكل الخط" اتشال من هنا ومن index.html - الخط
    // بقى ثابت (كايرو الأساسي بس، أول عنصر في STORY_FONT_OPTIONS) بناءً
    // على طلب المستخدم، فمفيش داعي لعرض خيارات مفيش غيرها أصلاً

    // --- أزرار مدة العرض ---
    if (durationContainer) {
        durationContainer.innerHTML = STORY_DURATION_OPTIONS.map((duration) => `
            <button type="button"
                    class="story-duration-btn ${duration.id === createStoryState.selectedDuration.id ? 'selected' : ''} text-xs font-bold text-lux-300 bg-lux-800 border border-gold-500/15 rounded-xl px-3 py-1.5"
                    data-duration-id="${duration.id}">
                ${duration.label}
            </button>
        `).join('');

        durationContainer.querySelectorAll('.story-duration-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const duration = STORY_DURATION_OPTIONS.find((option) => option.id === btn.dataset.durationId);
                if (!duration) return;
                createStoryState.selectedDuration = duration;
                durationContainer.querySelectorAll('.story-duration-btn').forEach((el) => el.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });
    }

    // ملحوظة: قسم اختيار "محاذاة النص" اتشال بالكامل من هنا ومن index.html
    // بناءً على طلب المستخدم - النص بقى دايمًا في النص (.text-center)
    // في المعاينة الحية (updateLivePreview) وفي مشغل المشاهدة الفعلي

    // --- أزرار الخصوصية ---
    const visibilityContainer = document.getElementById('storyVisibilityOptions');
    if (visibilityContainer) {
        visibilityContainer.innerHTML = STORY_VISIBILITY_OPTIONS.map((visibility) => `
            <button type="button"
                    class="story-visibility-btn ${visibility.id === createStoryState.selectedVisibility.id ? 'selected' : ''} text-xs font-bold text-lux-300 bg-lux-800 border border-gold-500/15 rounded-xl px-3 py-1.5"
                    data-visibility-id="${visibility.id}">
                ${visibility.label}
            </button>
        `).join('');

        visibilityContainer.querySelectorAll('.story-visibility-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const visibility = STORY_VISIBILITY_OPTIONS.find((option) => option.id === btn.dataset.visibilityId);
                if (!visibility) return;
                createStoryState.selectedVisibility = visibility;
                visibilityContainer.querySelectorAll('.story-visibility-btn').forEach((el) => el.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });
    }
}

/**
 * تحديث منطقة المعاينة الحية (الخلفية + الخط + النص) لحظياً مع أي تغيير
 */
function updateLivePreview() {
    const previewArea = document.getElementById('storyPreviewArea');
    const previewText = document.getElementById('storyPreviewText');
    const textarea = document.getElementById('createStoryTextarea');
    if (!previewArea || !previewText || !textarea) return;

    previewArea.style.background = createStoryState.selectedBg.value;

    // تصفير كلاسات الخط القديمة قبل تطبيق الخط الجديد
    STORY_FONT_OPTIONS.forEach((font) => {
        font.cssClass.split(' ').forEach((cls) => previewText.classList.remove(cls));
    });
    createStoryState.selectedFont.cssClass.split(' ').forEach((cls) => previewText.classList.add(cls));

    // (تعديل) محاذاة النص اتلغت بالكامل - previewText معاه كلاس
    // text-center ثابت في index.html أصلاً، فمفيش داعي لأي منطق هنا

    const typedText = textarea.value.trim();
    previewText.textContent = typedText.length > 0 ? typedText : 'اكتب استوريك هنا...';
}

/**
 * تطبيق موضع/مقاس ملصق الإنجاز الحي الحالي (createStoryState.stickerPosition)
 * على عنصر الكبسولة كمتغيرات CSS مخصصة (--sticker-x/-y/-scale - راجع تعريف
 * .story-stat-sticker في style.css) - مستخدمة في المعاينة الحية وقت
 * الإنشاء (bindStickerDragAndResize/updateStatStickerPreview/resetCreateStoryForm)
 * @param {HTMLElement} stickerEl
 * @param {{x: number, y: number, scale: number}} position
 */
function applyStickerTransform(stickerEl, position) {
    if (!stickerEl) return;
    stickerEl.style.setProperty('--sticker-x', `${position.x}%`);
    stickerEl.style.setProperty('--sticker-y', `${position.y}%`);
    stickerEl.style.setProperty('--sticker-scale', position.scale);
}

/**
 * إرجاع نسبة عرض/ارتفاع (width / height) لعنصر معيّن (مثلاً #storyPreviewArea)
 * - بترجع نسبة .story-stat-sticker الافتراضية (DEFAULT_STICKER_POSITION.ratio)
 * لو العنصر مش موجود أو أبعاده لسه صفر (مثلاً قبل ما يترسم على الشاشة)
 * @param {HTMLElement} el
 * @returns {number}
 */
function measureAspectRatio(el) {
    if (!el || !el.clientWidth || !el.clientHeight) return DEFAULT_STICKER_POSITION.ratio;
    return el.clientWidth / el.clientHeight;
}

/**
 * حساب ووضع موضع/مقاس ملصق الإنجاز الحي (--sticker-x/-y بالبكسل +
 * --sticker-scale) جوه حاوية العرض الفعلية وقت المشاهدة (#storyContent).
 *
 * ليه محتاجين الدالة دي أصلاً: صندوق المعاينة وقت الإنشاء (#storyPreviewArea)
 * بيبقى بنسبة عرض/ارتفاع معيّنة (بتتأثر بـ max-height الشاشة وقت الإنشاء)،
 * لكن مشغل المشاهدة الفعلي (#storyContent) بياخد الشاشة بالكامل وممكن
 * تبقى نسبته مختلفة تمامًا (خصوصًا لو اختلف حجم/اتجاه الشاشة بين لحظة
 * الإنشاء ولحظة المشاهدة). لو استخدمنا نفس نسبة x%/y% على طول بين
 * الاتنين من غير تصحيح، الملصق كان بيبان في مكان مختلف عن اللي المستخدم
 * فعليًا حدده وقت الضبط - ده بالظبط سبب مشكلة "الملصق بيتحرك بعد النشر".
 *
 * الحل: statData.ar بتحفظ نسبة عرض/ارتفاع صندوق المعاينة وقت النشر (شوف
 * publishStory)، وهنا بنحسب أكبر مستطيل بنفس النسبة دي بيتلم بالكامل جوه
 * حاوية العرض الفعلية (نفس منطق CSS "object-fit: contain" تمامًا)، وبعدين
 * بنحط الملصق بنسبته x%/y% الأصلية *جوه المستطيل ده* مش جوه الحاوية كلها
 * - فيبقى نفس المكان النسبي بالظبط بغض النظر عن اختلاف نسبة الحاوية
 * @param {HTMLElement} containerEl - #storyContent
 * @param {HTMLElement} stickerEl
 * @param {{x: number, y: number, scale: number, ar: number}} statData
 */
function positionRenderedSticker(containerEl, stickerEl, statData) {
    if (!containerEl || !stickerEl || !statData) return;
    const containerWidth = containerEl.clientWidth;
    const containerHeight = containerEl.clientHeight;
    if (!containerWidth || !containerHeight) return;

    const targetRatio = statData.ar || DEFAULT_STICKER_POSITION.ratio;
    const containerRatio = containerWidth / containerHeight;

    // نفس منطق "object-fit: contain": لو الحاوية الفعلية أعرض نسبيًا من
    // صندوق المعاينة الأصلي، الارتفاع هو القيد (والعكس صحيح)
    let contentWidth;
    let contentHeight;
    if (containerRatio > targetRatio) {
        contentHeight = containerHeight;
        contentWidth = contentHeight * targetRatio;
    } else {
        contentWidth = containerWidth;
        contentHeight = contentWidth / targetRatio;
    }
    const offsetX = (containerWidth - contentWidth) / 2;
    const offsetY = (containerHeight - contentHeight) / 2;

    const pxX = offsetX + (statData.x / 100) * contentWidth;
    const pxY = offsetY + (statData.y / 100) * contentHeight;

    stickerEl.style.setProperty('--sticker-x', `${pxX}px`);
    stickerEl.style.setProperty('--sticker-y', `${pxY}px`);
    stickerEl.style.setProperty('--sticker-scale', statData.scale || DEFAULT_STICKER_POSITION.scale);
}

/**
 * تحديث ظهور/محتوى كبسولة "ملصق الإنجاز الحي" (#storyPreviewSticker) في
 * المعاينة الحية بناءً على createStoryState.includeStats - بتُستدعى من
 * زرار #btnToggleStatSticker (شوف bindCreateStoryModalEvents) وكمان من
 * resetCreateStoryForm عشان تتأكد إن الملصق يتخفي عند التصفير
 */
function updateStatStickerPreview() {
    const sticker = document.getElementById('storyPreviewSticker');
    const stepsLabel = document.getElementById('storyPreviewStickerSteps');
    const percentLabel = document.getElementById('storyPreviewStickerPercent');
    const toggleBtn = document.getElementById('btnToggleStatSticker');
    if (!sticker || !stepsLabel || !percentLabel) return;

    if (!createStoryState.includeStats) {
        sticker.classList.add('hidden');
        if (toggleBtn) toggleBtn.classList.remove('is-active');
        return;
    }

    // خطوات اليوم الفعلية من sensors.js + نسبة الوصول لهدف الـ 10,000 خطوة
    // (مقفولة عند 100% حتى لو المستخدم عدّى الهدف - عشان الملصق يفضل منطقي)
    const todaySteps = getStepsCount();
    const progressPercent = Math.min(100, Math.round((todaySteps / DAILY_STEPS_GOAL) * 100));

    stepsLabel.textContent = `${todaySteps.toLocaleString('en-US')} خطوة`;
    percentLabel.textContent = `${progressPercent}%`;

    sticker.classList.remove('hidden');
    if (toggleBtn) toggleBtn.classList.add('is-active');
    // بنطبّق آخر موضع/مقاس محفوظ (createStoryState.stickerPosition) - سواء
    // كان لسه الافتراضي أو المستخدم سحب/كبّر الكبسولة قبل كده في نفس الجلسة
    applyStickerTransform(sticker, createStoryState.stickerPosition);
}

/**
 * تحديث عداد الحروف المتبقية تحت خانة الكتابة
 */
function updateCharCount() {
    const textarea = document.getElementById('createStoryTextarea');
    const counter = document.getElementById('createStoryCharCount');
    if (!textarea || !counter) return;
    counter.textContent = `${textarea.value.length} / ${STORY_MAX_CHARS}`;
}

/**
 * إعادة تصفير فورم الإنشاء لحالته الافتراضية (بعد النشر أو الإلغاء)
 */
function resetCreateStoryForm() {
    const textarea = document.getElementById('createStoryTextarea');
    if (textarea) textarea.value = '';

    createStoryState.selectedBg = STORY_BG_OPTIONS[0];
    createStoryState.selectedFont = STORY_FONT_OPTIONS[0];
    createStoryState.selectedDuration = STORY_DURATION_OPTIONS[0]; // نرجع لـ 24 ساعة كافتراضي
    createStoryState.selectedVisibility = STORY_VISIBILITY_OPTIONS[0]; // نرجع لـ "الكل" كافتراضي

    // (المرحلة 4-أ) تصفير حالة ملصق الإنجاز الحي + إخفاؤه من المعاينة
    // وإلغاء تنشيط زراره - بيحصل عند كل نشر أو إلغاء (فتح مودال جديد)
    createStoryState.includeStats = false;
    // (تعديل) تصفير موضع/مقاس الكبسولة اللي المستخدم سحبها/كبّرها كمان،
    // عشان أي استوري جديدة تبدأ من نفس المكان الافتراضي دايمًا
    createStoryState.stickerPosition = { ...DEFAULT_STICKER_POSITION };
    updateStatStickerPreview();

    updateCharCount();
    renderCreateStoryOptionButtons();
    updateLivePreview();
}

/**
 * فتح مودال إنشاء استوري جديدة
 */
function openCreateStoryModal() {
    const modal = document.getElementById('createStoryModal');
    if (!modal) return;

    resetCreateStoryForm();
    modal.classList.remove('hidden');

    pushModalState(hideCreateStoryModal);
}

/** الإخفاء الخام لمودال إنشاء الاستوري فقط - استخدم closeCreateStoryModal تحت */
function hideCreateStoryModal() {
    const modal = document.getElementById('createStoryModal');
    if (modal) modal.classList.add('hidden');
}

/**
 * إغلاق مودال إنشاء الاستوري (من غير ما ينشر حاجة) - الدالة العامة
 * اللي زرار X وزرار إلغاء والضغط برّه المودال والنشر الناجح كلهم
 * لازم ينادوا عليها بدل hideCreateStoryModal مباشرة
 */
function closeCreateStoryModal() {
    closeModal();
}

/**
 * نشر الاستوري الحالية في جدول text_stories على Supabase، وتحديث
 * الواجهة فوراً لحظة النجاح.
 */
async function publishStory() {
    if (createStoryState.isPublishing) return; // منع الضغط المتكرر أثناء الرفع

    // (جديد) getCurrentUser() تحت بتتأكد بس إن فيه جلسة Supabase صحيحة -
    // ده مش كافي لوحده، لأن الفحص الصريح لـ window.isGuestMode هو اللي
    // بيحدد فعليًا هل المستخدم داخل بحساب شخصي حقيقي ولا لسه في وضع
    // الزائر (زي بعد تسجيل خروج أو تصفح كزائر من غير حساب)
    if (window.isGuestMode) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'سجّل دخول الأول عشان تقدر تنشر استوري' },
        }));
        return;
    }

    const textarea = document.getElementById('createStoryTextarea');
    const content = textarea ? textarea.value.trim() : '';

    if (content.length === 0) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'اكتب نص الاستوري الأول' } }));
        return;
    }

    const currentUser = await getCurrentUser();
    if (!currentUser) {
        return;
    }

    // (المرحلة 4-ب) لو ملصق الإنجاز الحي مفعّل (createStoryState.includeStats)،
    // بنحسب بيانات الملصق دلوقتي بالظبط (نفس حساب updateStatStickerPreview
    // بالظبط: خطوات النهاردة الفعلية + نسبة الوصول لهدف DAILY_STEPS_GOAL)
    // عشان الرقم اللي بيتنشر يكون هو نفسه اللي المستخدم شافه في المعاينة
    // لحظة الضغط على "نشر"، مش رقم اتحسب قبل كده وبقى قديم. (تعديل) بنضيف
    // موضع/مقاس الكبسولة الحالي (createStoryState.stickerPosition) + نسبة
    // عرض/ارتفاع صندوق المعاينة (ar) وقت النشر بالظبط - محتاجينها عشان
    // نقدر نصحح اختلاف شكل الشاشة بين صندوق المعاينة (وقت الإنشاء) ومشغل
    // المشاهدة الفعلي (بياخد الشاشة بالكامل) وقت العرض، وإلا الملصق كان
    // بيبان في مكان مختلف عن اللي المستخدم حدده بالظبط (راجع
    // positionRenderedSticker لتفاصيل المشكلة والحل)
    // (مقرّبين لرقم عشري واحد/اتنين/تلاتة بس عشان الوسم يفضل صغير)
    let statPayload = null;
    if (createStoryState.includeStats) {
        const todaySteps = getStepsCount();
        const progressPercent = Math.min(100, Math.round((todaySteps / DAILY_STEPS_GOAL) * 100));
        const previewArea = document.getElementById('storyPreviewArea');
        statPayload = {
            steps: todaySteps,
            percent: progressPercent,
            x: Math.round(createStoryState.stickerPosition.x * 10) / 10,
            y: Math.round(createStoryState.stickerPosition.y * 10) / 10,
            scale: Math.round(createStoryState.stickerPosition.scale * 100) / 100,
            ar: Math.round(measureAspectRatio(previewArea) * 1000) / 1000,
        };
    }

    // النص اللي فعليًا بيتخزن في عمود content: نفس نص المستخدم + وسم
    // بيانات الملصق (لو موجود) في آخره - راجع buildStatTag فوق. النص
    // النضيف (content) بيفضل زي ما هو من غير أي تعديل عشان نستخدمه في
    // الحقن المحلي (Optimistic UI) تحت
    const contentToStore = statPayload ? content + buildStatTag(statPayload) : content;

    setPublishLoadingState(true);

    try {
        // أسماء أعمدة جدول text_stories الفعلية (اتأكدنا منها من Table Editor
        // في Supabase): id, user_id, content, bg_color, font_style,
        // created_at, expires_at. العمود كان اسمه bg_color مش background
        // زي ما كان مفترض قبل كده، وده اللي كان بيسبب خطأ الـ 400
        // (PGRST204: Could not find the 'background' column).
        // expires_at موجود في الجدول برضه، وبقى محسوب حسب المدة اللي
        // المستخدم اختارها من STORY_DURATION_OPTIONS (بدل ما كانت 24
        // ساعة ثابتة دايمًا). visibility عمود جديد (شوف story_settings_upgrade.sql)
        // لخصوصية الاستوري. (تعديل) عمود text_align بقى مش بيتبعت خالص -
        // محاذاة النص اتلغت بالكامل بناءً على طلب المستخدم.
        // content هنا هو contentToStore (النص + وسم الملصق لو موجود) -
        // مفيش عمود جديد في الجدول، الوسم جوه نفس حقل content الحالي
        const { data, error } = await supabaseClient
            .from('text_stories')
            .insert({
                user_id: currentUser.id,
                content: contentToStore,
                bg_color: createStoryState.selectedBg.value,
                font_style: createStoryState.selectedFont.id,
                visibility: createStoryState.selectedVisibility.id,
                expires_at: new Date(Date.now() + createStoryState.selectedDuration.hours * 60 * 60 * 1000).toISOString(),
            })
            .select()
            .single();

        if (error) throw error;

        // حقن الاستوري المنشورة فوراً في أول الشريط المحلي (Optimistic UI)
        // عشان المستخدم يشوف استوريه في التو واللحظة من غير انتظار API قراءة
        // ملحوظة: خاصية "background" هنا اسم داخلي بنستخدمه في storiesData
        // المحلية بس (تقرأه renderCurrentStory/updateLivePreview) - مالوش
        // علاقة باسم عمود قاعدة البيانات bg_color، فمفيش داعي نغيّره
        storiesData.unshift({
            id: data?.id || `story_${Date.now()}`,
            userId: currentUser.id,
            // (إصلاح - نفس باج avatar_url/user_metadata الموثّق فوق في
            // initStoriesUI): currentUserAvatar/currentUserName هنا اتجابوا
            // فعليًا من جدول profiles، فهما المصدر الصح - مش user_metadata
            // اللي مبتحتفظش بـ avatar_url أصلاً
            userName: currentUserName || currentUser.user_metadata?.full_name
                || currentUser.user_metadata?.username || 'أنا',
            avatar: currentUserAvatar || DEFAULT_STORY_AVATAR,
            // content هنا النص النضيف (من غير وسم الملصق) - نفس ما هيرجع
            // من mapRpcRowToStory بعد أي إعادة جلب لاحقة، عشان الاستوري
            // متتغيرش شكلها فجأة أول ما تُقرأ من السيرفر تاني
            content,
            // (المرحلة 4-ب) بيانات ملصق الإنجاز الحي كخاصية مباشرة على
            // كائن الاستوري - null لو includeStats كان متوقف (استوري
            // عادية)، بالظبط زي شكل الخاصية الراجعة من mapRpcRowToStory
            // (بما فيها x/y/scale الموضع/المقاس اللي المستخدم حدده)
            statData: statPayload,
            background: createStoryState.selectedBg.value,
            fontClass: createStoryState.selectedFont.cssClass,
            createdAt: data?.created_at || new Date().toISOString(),
            viewed: false,
        });

        document.dispatchEvent(new CustomEvent('stories:published', { detail: { story: data } }));

        closeCreateStoryModal();
        resetCreateStoryForm();
        renderStoriesBar();
    } catch (err) {
        document.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'حصل خطأ أثناء نشر الاستوري، جرب تاني' } }));
    } finally {
        setPublishLoadingState(false);
    }
}

/**
 * تبديل حالة التحميل (Loading) على زرار "نشر الاستوري": بيعطّل الزرار
 * ويظهر الـ Spinner عشان يمنع أي ضغط مزدوج أثناء الرفع
 * @param {boolean} isLoading
 */
function setPublishLoadingState(isLoading) {
    createStoryState.isPublishing = isLoading;

    const publishBtn = document.getElementById('btnPublishStory');
    const spinner = document.getElementById('publishStoryLoadingSpinner');
    const label = document.getElementById('publishStoryBtnLabel');
    if (!publishBtn || !spinner || !label) return;

    publishBtn.disabled = isLoading;
    spinner.classList.toggle('hidden', !isLoading);
    label.textContent = isLoading ? 'جاري النشر...' : 'نشر الاستوري';
}

/**
 * ربط سحب/تكبير ملصق الإنجاز الحي (#storyPreviewSticker) جوه منطقة
 * المعاينة الحية (#storyPreviewArea) وقت الإنشاء - بإصبع واحد بيتحرك
 * (drag) لأي مكان، وبإصبعين بيتكبّر/يتصغّر (pinch-to-zoom). المكان
 * الحالي واتجاهات التكبير بيتخزنوا في createStoryState.stickerPosition
 * (نسبة % من عرض/ارتفاع المعاينة + معامل تكبير)، وده اللي بيتبعت لاحقًا
 * مع بيانات الملصق وقت النشر (شوف publishStory) عشان يتحفظ نفس المكان
 * بالظبط في مشغل المشاهدة الفعلي (renderCurrentStory).
 *
 * مبنية على Pointer Events بس (شغالة للماوس واللمس بالإصبع مع بعض من
 * غير الحاجة لـ touchstart/touchmove منفصلين): كل إصبع بياخد pointerId
 * مستقل، فبنتتبعهم في activePointers Map. إصبع واحد نشط = سحب، إصبعين =
 * حساب نسبة تغيّر المسافة بينهم وتطبيقها كمعامل تكبير جديد.
 * setPointerCapture بيضمن إن move/up بتاعة نفس الإصبع تكمل توصل للكبسولة
 * حتى لو الإصبع خرج بره حدودها بصريًا وهو لسه ماسك (سحب طبيعي وسلس).
 * بتتنادى مرة واحدة بس من bindCreateStoryModalEvents (زي باقي دوال
 * الربط التانية في المودال ده)
 */
function bindStickerDragAndResize() {
    const sticker = document.getElementById('storyPreviewSticker');
    const area = document.getElementById('storyPreviewArea');
    if (!sticker || !area) return;

    /** pointerId -> {x, y} بإحداثيات الشاشة (clientX/clientY) لكل إصبع/مؤشر ماسك حاليًا */
    const activePointers = new Map();
    let pinchStartDistance = null;
    let pinchStartScale = 1;

    const clampPercent = (value) => Math.min(96, Math.max(4, value));

    function positionFromClientPoint(clientX, clientY) {
        const rect = area.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
            x: clampPercent(((clientX - rect.left) / rect.width) * 100),
            y: clampPercent(((clientY - rect.top) / rect.height) * 100),
        };
    }

    const distanceBetween = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);

    sticker.addEventListener('pointerdown', (event) => {
        sticker.setPointerCapture(event.pointerId);
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (activePointers.size === 2) {
            const [p1, p2] = [...activePointers.values()];
            pinchStartDistance = distanceBetween(p1, p2);
            pinchStartScale = createStoryState.stickerPosition.scale;
        }
        event.preventDefault();
    });

    sticker.addEventListener('pointermove', (event) => {
        if (!activePointers.has(event.pointerId)) return;
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (activePointers.size === 1) {
            // سحب بإصبع واحد: مركز الكبسولة بيتبع مكان الإصبع/الماوس مباشرة
            const point = positionFromClientPoint(event.clientX, event.clientY);
            if (!point) return;
            createStoryState.stickerPosition.x = point.x;
            createStoryState.stickerPosition.y = point.y;
            applyStickerTransform(sticker, createStoryState.stickerPosition);
        } else if (activePointers.size === 2 && pinchStartDistance) {
            // Pinch بإصبعين: نسبة تغيّر المسافة بين الإصبعين بتتضرب في
            // المقاس اللي كان مسجل لحظة بداية الـ Pinch، ومحصورة بين
            // STICKER_MIN_SCALE و STICKER_MAX_SCALE عشان الكبسولة متختفيش
            // ولا تكبر أكتر من حجم الاستوري نفسه
            const [p1, p2] = [...activePointers.values()];
            const newDistance = distanceBetween(p1, p2);
            const ratio = newDistance / pinchStartDistance;
            createStoryState.stickerPosition.scale = Math.min(
                STICKER_MAX_SCALE,
                Math.max(STICKER_MIN_SCALE, pinchStartScale * ratio),
            );
            applyStickerTransform(sticker, createStoryState.stickerPosition);
        }
        event.preventDefault();
    });

    function releasePointer(event) {
        activePointers.delete(event.pointerId);
        // لو رجعنا لإصبع واحد أو أقل، لازم نصفّر بداية الـ Pinch عشان لو
        // المستخدم ضم إصبع جديد تاني، الحساب يبدأ من الصفر مش من قيمة قديمة
        if (activePointers.size < 2) pinchStartDistance = null;
    }
    sticker.addEventListener('pointerup', releasePointer);
    sticker.addEventListener('pointercancel', releasePointer);
}

/**
 * ربط كل عناصر مودال إنشاء الاستوري بمنطقها (تُستدعى مرة واحدة بس من initStoriesUI)
 */
function bindCreateStoryModalEvents() {
    const modal = document.getElementById('createStoryModal');
    const textarea = document.getElementById('createStoryTextarea');
    const closeBtn = document.getElementById('btnCloseCreateStory');
    const cancelBtn = document.getElementById('btnCancelCreateStory');
    const publishBtn = document.getElementById('btnPublishStory');
    const statStickerBtn = document.getElementById('btnToggleStatSticker');

    renderCreateStoryOptionButtons();
    bindStickerDragAndResize();

    if (textarea) {
        textarea.addEventListener('input', () => {
            updateCharCount();
            updateLivePreview();
        });
    }

    // (المرحلة 4-أ) زرار "إضافة إنجازي اليوم 🔥" - Toggle بسيط بيقلب
    // createStoryState.includeStats ويسيب updateStatStickerPreview تتكفل
    // بجلب خطوات اليوم الفعلية وعرضها/إخفائها في المعاينة الحية
    if (statStickerBtn) {
        statStickerBtn.addEventListener('click', () => {
            createStoryState.includeStats = !createStoryState.includeStats;
            updateStatStickerPreview();
        });
    }

    if (closeBtn) closeBtn.addEventListener('click', closeCreateStoryModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeCreateStoryModal);
    if (publishBtn) publishBtn.addEventListener('click', publishStory);

    // الضغط على الخلفية المظلمة نفسها (بره الكارت) بيقفل المودال، بنفس
    // فلسفة باقي المودالز في المشروع (logoutConfirmModal، إلخ)
    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeCreateStoryModal();
        });
    }
}