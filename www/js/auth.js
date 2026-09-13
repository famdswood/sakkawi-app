/* ==================================================================
   سِكّاوي | js/auth.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: كل حاجة خاصة بتسجيل الدخول والخروج
   بنظام محلي مخصص (Username & Password) مبني فوق Supabase Auth،
   إدارة موديل تسجيل الدخول (authModal)، متابعة حالة الجلسة (Session)
   أول ما التطبيق يفتح، والتحقق هل المستخدم عنده بروفايل محفوظ في
   جدول profiles ولا لأ (عشان نعرف نفتحله موديل "إعداد البطل لأول
   مرة" ولا نوديه على التطبيق على طول).

   ملاحظة عن آلية اسم المستخدم: Supabase Auth الافتراضي متبني على
   إيميل + باسورد، ومفيش عنده مفهوم "username" جاهز. عشان نوفّر
   تجربة قائمة بالكامل على اسم المستخدم من غير ما نغيّر إعدادات
   Supabase، بنولّد "إيميل وهمي" داخلي من اسم المستخدم بالشكل
   username@batal.com (دالة usernameToInternalEmail تحت)، وبنخزن
   اسم المستخدم الحقيقي كمان في user_metadata (الحقل "username")
   عشان أي كود تاني يقدر يقرأه من غير ما يفكّك الإيميل. تفرّد
   الإيميل ده في auth.users بيضمن تفرّد اسم المستخدم تلقائياً.

   الأحداث (Custom Events) اللي بيطلقها الملف ده عشان باقي ملفات
   التطبيق (زي app.js) تسمعها وتتصرف عليها:

     - "auth:signed-in"   -> بترمي { user, session, hasProfile }
                              لما تسجيل الدخول ينجح (أول مرة أو أي مرة).
     - "auth:signed-out"  -> بترمي {} لما المستخدم يعمل تسجيل خروج.
     - "app:toast"        -> بترمي { message, type } لعرض إشعار خفيف
                              (النوع: 'success' | 'error' | 'info').

   تحديث (نظام "موافقة الجهاز الآخر"): محاولة الدخول من جهاز تاني والحساب
   شغال بالفعل مبقاش بيترفض على طول (ولا فيه "دخول قسري" بديل خالص -
   قرار أمان صريح). بدل كده بيتبعت طلب موافقة فعلي (جدول
   login_approval_requests) للجهاز الماسك للجلسة الحالية عبر Realtime،
   وده لازم يوافق أو يرفض خلال LOGIN_APPROVAL_TIMEOUT_MS، وإلا الطلب
   ينتهي ومحدش يقدر يدخل. شوف قسم "موافقة تسجيل الدخول من جهاز تاني"
   تحت لتفاصيل الآلية الكاملة.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { pushModalState, closeModal } from './modal-history.js';
import { showAuthGate } from './onboarding.js';
import { checkLocationForSignup, getUserCoordinates, fetchGeofenceSettings, calculateDistanceMeters } from './geofence.js';
import { DEFAULT_AVATAR_URI } from './profiles.js';

/** يحدّد حالياً الفورم شغال في وضع دخول ولا تسجيل حساب جديد */
let currentAuthMode = 'signin'; // 'signin' | 'signup'

/**
 * هل موقع المستخدم الحالي جوه نطاق نزلة عبيد المسموح بيه للتسجيل؟
 *
 * (تحديث - اختيار 2 لفصل وضع الزائر عن الحساب الشخصي): بعد ما بطّلنا
 * ربط "وضع الزائر" (window.isGuestMode) بأي فحص جغرافي - بقى معتمد
 * حصريًا على حالة تسجيل الدخول (شوف applyGuestModeRestrictions في
 * app.js) - القيمة دي (isGuestAreaAllowed) بقت مفهوم مستقل تمامًا:
 * مش عن "وضع الزائر"، لكن عن سؤال مختلف وأضيق: هل المستخدم اللي واقف
 * دلوقتي قدام فورم "تسجيل الدخول" (لسه معندهوش حساب) موجود جغرافيًا
 * جوه نطاق نزلة عبيد المسموح بيه للتسجيل، عشان نعرف نظهرله رابط "سجّل
 * دلوقتي" ولا نخفيه؟ الفحص الوحيد اللي بيحدد القيمة دي هو
 * ensureGuestAreaCheckedForToggle() تحت (بتنادي checkLocationForSignup()
 * من geofence.js - قراءة فقط، من غير userId ومن غير أي كتابة في قاعدة
 * البيانات)، بيتنادى أول ما فورم تسجيل الدخول يتفتح وهو في وضع "دخول"
 * (مش "تسجيل"). null = لسه معندناش نتيجة، وبتتعامل "آمن افتراضيًا"
 * (Fail-safe) زي false تمامًا: الرابط مخفي طول ما مفيش تأكيد إيجابي
 * صريح (true بالظبط).
 * @type {boolean|null}
 */
let isGuestAreaAllowed = null;

/** true طول ما فحص الموقع الخاص بـ ensureGuestAreaCheckedForToggle() شغال
 *  فعليًا حاليًا - بنستخدمه عشان مانبدأش أكتر من فحص متوازي لو المستخدم
 *  بدّل بين وضع الدخول/التسجيل بسرعة قبل ما أول فحص يخلّص */
let isCheckingGuestAreaForToggle = false;

/**
 * نفس قيمة storageKey المستخدمة في supabase-config.js عند إنشاء العميل.
 * لازم القيمتين يفضلوا متطابقين، وإلا restoreSession() مش هتلاقي حاجة
 * في localStorage حتى لو فيه جلسة محفوظة فعلاً.
 *
 * (إصلاح - باج حقيقي خطير "تضاعف الخطوات مع كل فتح تطبيق"): القيمة دي
 * كانت 'ta7t-el-balad-auth-session' - اسم قديم للمشروع من قبل ما يتسمى
 * "سِكّاوي"، وبعد التغيير اتحدّث storageKey في supabase-config.js لـ
 * 'sekkawy-auth-session' من غير ما القيمة هنا تتحدّث معاها. النتيجة:
 * restoreSession() (وhasAnyStoredSessionHint()) كانت بتقرا دايمًا من
 * مفتاح localStorage فاضي تمامًا - محدش بيكتب فيه خالص، لأن Supabase
 * نفسها بتحفظ الجلسة الحقيقية تحت 'sekkawy-auth-session' - فكانت
 * بترجع null بشكل مضمون 100% في كل فتحة تطبيق، مش بشكل متقطّع. وده
 * كان بيخلي app.js ينادي initProfileUI(null) دايمًا عند بداية التطبيق
 * (يعتبرها "مفيش حساب خالص")، واللي بدورها بتصفّر عداد الخطوات المحلي
 * في sensors.js (syncActiveUser(null)) وتحفظ الصفر فورًا - فمزامنة
 * الحساس الأصلي (اللي مالهاش دعوة بحالة الـ auth) كانت بتلاقي "خطوات
 * النهاردة" الحقيقية أكبر من الصفر ده وتعتبرها كلها جديدة، وتبعتها
 * زيادة فوق اللي اتبعت خلاص من قبل - تضاعف حقيقي مع كل فتح/قفل.
 */
const AUTH_STORAGE_KEY = 'sekkawy-auth-session';

/**
 * مفتاح localStorage اللي بنحفظ بيه "قرار" المستخدم إنه يكمّل كزائر
 * (بدون حساب) بشكل مستمر عبر أي Refresh لاحق - بعكس isGuestMode على
 * window اللي بيتصفّر تلقائيًا مع كل تحميل جديد للصفحة.
 *
 * ليه محتاجينه: checkExistingSession() (تحت) كانت بتفتح showAuthGate()
 * تلقائيًا في أي مرة مفيش فيها Session محفوظة - وهو نفسه حال الزائر
 * دايمًا (هو مالوش حساب أصلاً). يعني قبل الفلاج ده، أي Refresh وإنت
 * متصفح كزائر كان بيرجّعك لصفحة تسجيل الدخول تاني من غير أي سبب واضح،
 * حتى لو وضع الزائر نفسه كان شغال صح تحتها. الفلاج ده بيخلي
 * checkExistingSession() تعرف تفرّق بين "زائر بقرار واعي" و"محدش لسه
 * اختار حاجة" - وتسيبه في وضع الزائر بدل ما ترجعه لصفحة التسجيل قسرًا.
 *
 * بيتصفّر (clearGuestModeActive) بس لما تسجيل دخول/حساب حقيقي ينجح
 * فعليًا (شوف handleSignedInSession تحت) - يعني المستخدم هو اللي بيقرر
 * يطلع من وضع الزائر بإرادته (زرار "إنشاء حساب/تسجيل الدخول" في شريط
 * تنبيه الزوار - شوف js/guest-banner.js)، مش أي Refresh عشوائي.
 */
const GUEST_MODE_STORAGE_KEY = 'sakkawy-guest-mode-active';

/**
 * هل المستخدم مختار يكمّل كزائر بشكل مستمر (عبر أي Refresh لاحق)؟
 * @returns {boolean}
 */
export function isGuestModeActive() {
    try {
        return window.localStorage.getItem(GUEST_MODE_STORAGE_KEY) === '1';
    } catch (err) {
        // فشل الوصول لـ localStorage (خصوصية متصفح، وضع تصفح خفي..إلخ) -
        // بنتعامل معاه كـ "لأ" بأمان بدل ما نكسر باقي منطق الجلسة
        return false;
    }
}

/** تسجيل قرار المستخدم إنه يكمّل كزائر - بيتنادى فور الضغط على "تصفح كزائر" */
export function markGuestModeActive() {
    try {
        window.localStorage.setItem(GUEST_MODE_STORAGE_KEY, '1');
    } catch (err) {
        // تجاهل بهدوء - أسوأ سيناريو: الزائر هيتسأل تاني بعد Refresh
    }
}

/** مسح قرار وضع الزائر - بيتنادى فور نجاح تسجيل دخول/حساب حقيقي */
export function clearGuestModeActive() {
    try {
        window.localStorage.removeItem(GUEST_MODE_STORAGE_KEY);
    } catch (err) {
        // تجاهل بهدوء
    }
}

/**
 * النطاق الوهمي المستخدم لبناء إيميل داخلي من اسم المستخدم.
 * ملاحظة مهمة: كان مستخدم قبل كده "batal.local"، بس Supabase Auth
 * بيرفض بعض الـ TLDs الغير قياسية (زي .local) وقت التحقق من صيغة
 * الإيميل، وده كان بيسبب خطأ 400 (Bad Request) عند أي Signup.
 * "batal.com" ده TLD قياسي معروف فبيعدي من الفاليديشن بتاع Supabase
 * عادي، حتى لو الدومين مش شغال فعلياً (Supabase مش بيبعت إيميل تأكيد
 * فعلي هنا أصلاً - هو مجرد معرّف فريد داخلي).
 */
const INTERNAL_EMAIL_DOMAIN = 'batal.com';

/** قاعدة صحة اسم المستخدم: حروف إنجليزية/أرقام/underscore فقط، من 3 لـ20 حرف */
const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;

// (إصلاح أمني) قيود رفع صورة البروفايل - نفس القيم المطبّقة على مستوى
// باكت "avatars" في Supabase Storage (file_size_limit/allowed_mime_types)،
// موجودة هنا كمان عشان المستخدم ياخد رسالة خطأ عربية واضحة فورًا بدل ما
// يستنى رفض عام من السيرفر. الحماية الحقيقية اللي مينفعش يتحايل عليها
// هي قيود الباكت نفسها - دي بس تحسين لتجربة الاستخدام
const ALLOWED_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_AVATAR_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 ميجابايت

/**
 * تحقق من نوع وحجم ملف صورة البروفايل قبل أي محاولة رفع لـ Supabase
 * Storage - بترمي Error برسالة عربية واضحة لو الملف مش صورة مدعومة أو
 * حجمه أكبر من المسموح، عشان الفورم يقدر يعرضها فورًا (شوف
 * uploadSignupAvatarFile تحت وuploadEditAvatarFile في profiles.js).
 * @param {File|Blob} file
 */
export function validateAvatarFile(file) {
    if (!ALLOWED_AVATAR_MIME_TYPES.includes(file.type)) {
        throw new Error('نوع الصورة غير مدعوم - لازم تكون JPG أو PNG أو WEBP');
    }
    if (file.size > MAX_AVATAR_FILE_SIZE_BYTES) {
        throw new Error('حجم الصورة كبير جدًا - الحد الأقصى 5 ميجابايت');
    }
}

/* (تحديث): شيلنا أفاتارات placehold.co المنفصلة حسب النوع (ذكر/أنثى) اللي
   كانت هنا - كانت بترجع صورة بخلفية ملونة لكن بعلامة استفهام "؟" بدل
   الرمز (ولد/بنت) لمشكلة في عرض الرموز عند placehold.co، فكانت بتتخزن
   كـ avatar_url حقيقية للمستخدم في قاعدة البيانات (مش مجرد fallback مؤقت)
   وتفضل ظاهرة كده في كل مكان (الليدربورد، البروفايل العام..إلخ) لحد ما
   يرفع صورة حقيقية. دلوقتي بنستخدم نفس أيقونة "مفيش صورة" الموحدة
   (DEFAULT_AVATAR_URI المستوردة من js/profiles.js) لكل مستخدم مرفعش صورة،
   بغض النظر عن النوع، عشان تبقى هوية واحدة موحدة في كل المشروع */

// رقم واتساب فريق الدعم الفني - بيُستخدم من زرار "نسيت كلمة السر؟" في
// فورم تسجيل الدخول (شوف handleForgotPasswordClick تحت)
const FORGOT_PASSWORD_SUPPORT_WHATSAPP_URL = 'https://wa.me/201207737965';

/** ملف الصورة الأصلي اللي اختاره المستخدم وقت التسجيل (قبل القص) */
let uploadedSignupAvatarFile = null;

/**
 * الصورة بعد القص (Blob) الناتجة من Cropper.js لما المستخدم يضغط
 * "تأكيد القص". دي اللي بتتبعت فعلياً لـ Supabase Storage لو موجودة،
 * وإلا بنرجع لملف الصورة الأصلي (uploadedSignupAvatarFile) كـ fallback.
 * @type {Blob|null}
 */
let croppedAvatarBlob = null;

/** نسخة Cropper.js الحالية الشغالة على صورة المودال (لو المودال مفتوح) */
let avatarCropperInstance = null;

/** النوع المختار حالياً في فورم التسجيل ('male' | 'female' | null) */
let selectedSignupGender = null;

/**
 * true أثناء تنفيذ signUpWithUsername فقط. بنستخدمها في
 * handleSignedInSession عشان نمنع حالة السباق (Race Condition):
 * onAuthStateChange ممكن يطلق SIGNED_IN بمجرد ما Supabase تحفظ الجلسة
 * جوه signUp()، يعني قبل ما نكون خلّصنا حفظ صف البروفايل الكامل. لو
 * سبنا ده يحصل عادي، هيتفحص hasProfile=false غلط ويفتح موديل "إعداد
 * البطل لأول مرة" رغم إننا جمعنا كل البيانات بالفعل في فورم التسجيل.
 */
let isCustomSignUpInProgress = false;

/**
 * true فقط أثناء الـ signOut المحلي الدفاعي جوه handleSignedInSession
 * لما checkSingleSessionSlotBeforeSignIn يرفض الدخول (الحساب مقفول على
 * جهاز تاني). بنستخدمها في listenToAuthStateChanges عشان نمنع تكرار
 * سبب باگ "الشاشة الفاضية" (شوف تعليق showAuthModal فوق عن الغرض من
 * إبقاء المودال مدموج): signOut({scope:'local'}) هنا بيطلق حدث
 * SIGNED_OUT فوراً، ولو سبناه يتعامل عادي هيتنادى showAuthGate() اللي
 * بيحط "hidden" على #onbAuthFormDock نفسه (حاوية المودال المدموج) عشان
 * يرجّع المستخدم لشاشة "اختيار دخول/تسجيل" بدل صفحة الفورم - وده صحيح
 * تماماً في حالة تسجيل خروج حقيقي، لكن هنا هو بالظبط اللي كان بيسيب
 * المودال (بعد ما handleSignedInSession يرجّعه ظاهر برسالة الخطأ) عالق
 * جوه حاوية أب (#onbAuthFormDock) لسه مخفية - يعني المودال "مش hidden"
 * حسب الكلاس بتاعه هو، لكن مش ظاهر فعلياً على الشاشة برضه. لما الفلاج
 * ده true، showAuthGate() بيتأجل تماماً ونسيب handleSignedInSession
 * يتحكم في الواجهة بنفسه (يورّي رسالة الخطأ في مكان الفورم زي ما هو).
 */
let isHandlingSessionConflictRejection = false;

/**
 * نسخة مخزّنة داخلياً (In-Memory Cache) من المستخدم الحالي، بتتحدث
 * تلقائياً عند تسجيل الدخول والخروج، عشان أي كود يحتاج قراءة سريعة
 * ومتزامنة (Sync) لهوية المستخدم من غير ما يستنى رد من الشبكة.
 * @type {import('@supabase/supabase-js').User | null}
 */
let currentUser = null;

/**
 * قناة Supabase Realtime المشتركة عليها حالياً في تغييرات صف profiles
 * بتاع المستخدم الحالي (بنستخدمها عشان نعرف لحظياً لو حد سجّل دخول
 * بنفس الحساب من جهاز/متصفح تاني - شوف "الجلسة الواحدة" تحت). null
 * لو مفيش مستخدم مسجل دخول دلوقتي أو لسه ملغيناها وقت تسجيل الخروج.
 * @type {import('@supabase/supabase-js').RealtimeChannel | null}
 */
let profileSessionRealtimeChannel = null;

/**
 * إظهار موديل تسجيل الدخول
 * بتتأكد إن المودال ظاهر فعلياً 100% (مش بس بتشيل كلاس hidden)، عشان
 * لو فيه أي كلاس CSS تاني أو style قديم متعارض بيمنعه يظهر، أو لو
 * عناصر تانية في الصفحة (زي التطبيق نفسه) طالعة فوقه بسبب z-index.
 *
 * ملحوظة (History API - modal-history.js): authModal ده بالذات
 * عمداً *مش* مسجّل في نظام pushModalState/closeModal، لأنه بوابة
 * دخول إجبارية (مفيهوش زرار X ولا ضغط برّه بيقفله - hideAuthModal
 * بتتنادى بس بعد نجاح تسجيل الدخول فعلياً). لو سجّلناه، زرار رجوع
 * الموبايل كان هيقدر "يقفله" ويسيب المستخدم شايف التطبيق من غير ما
 * يكون مسجل دخول أصلاً - وده سلوك مش مقصود. مودال قص الصورة
 * (avatarCropModal) اللي بيتفتح جواه هو بس اللي مسجّل، لأنه مودال
 * فرعي حقيقي وقابل للإلغاء برجوع المستخدم لفورم التسجيل.
 */
/**
 * الحاوية "الأصلية" لعنصر #authModal (خارج شاشات الترحيب) - بنرجّعه
 * لها تلقائياً في hideAuthModal() لو كان اتنقل مؤقتاً جوه سلايد
 * الترحيب الأخيرة (شوف dockTarget تحت).
 * @returns {HTMLElement|null}
 */
function getAuthModalHomeContainer() {
    return document.getElementById('auth-modal-container');
}

/**
 * @param {'signin'|'signup'} [mode] - وضع مبدئي اختياري لفتح المودال بيه
 * (مثلاً من زرار "إنشاء حساب جديد" في شاشات الترحيب). لو متبعتش، المودال
 * بيفتح بآخر وضع كان عليه (currentAuthMode) زي السلوك الأصلي بالظبط.
 * @param {{dockTarget?: HTMLElement}} [options] - لو اتبعت dockTarget،
 * بننقل نفس عنصر #authModal الحقيقي (بأحداثه وحالته زي ما هي، من غير
 * ما نحقن أو ننسخ حاجة) جوه الحاوية دي ونشيّله وضع "مودال منبثق" لوضع
 * "مدموج" - ده اللي js/onboarding.js بيستخدمه عشان فورم التسجيل/الدخول
 * يبان جزء طبيعي من آخر سلايد ترحيب بدل ما يفتح كنافذة منفصلة فوقها.
 * من غير options، المودال بيرجع/يفضل في شكله الافتراضي: مودال منبثق
 * فوق كل حاجة، في مكانه الأصلي (#auth-modal-container).
 */
/**
 * (إصلاح - باج حقيقي): آخر عنصر "دوك" حقيقي اتدمج فيه #authModal بنجاح
 * (زي #onbAuthFormSlot بتاع initOnboarding() أو showAuthGate()). بنستخدمه
 * في showAuthModal() تحت عشان أي إعادة فتح للمودال من غير dockTarget
 * صريح (زي رفض تسجيل الدخول بسبب جلسة نشطة على جهاز تاني) ترجّعه لنفس
 * المكان المدموج (خلفية ملوّنة/Blur زي صفحة الـ7 سلايدات) بدل ما تفتح
 * "صفحة تانية" منبثقة بخلفية سودة (authModalPopup, z-index 9999) - ده
 * بالظبط الوضع القديم اللي كان بيسبب ظهور صفحة دخول تانية منفصلة عن
 * صفحة الـ7 سلايدات، وكان بيحصل لو المودال اتفتح في لحظة مكانش فيها
 * مدموج بالفعل جوه حتة تانية
 */
let lastKnownDockTarget = null;

export function showAuthModal(mode, options = {}) {
    const modal = document.getElementById('authModal');
    if (!modal) {
        console.error('عنصر authModal مش موجود في الصفحة - مينفعش نعرض واجهة تسجيل الدخول');
        return;
    }

    if ((mode === 'signup' || mode === 'signin') && mode !== currentAuthMode) {
        toggleAuthMode();
    }

    const dockTarget = options.dockTarget || null;

    if (dockTarget) {
        // وضع "مدموج" جوه سلايد الترحيب الأخيرة - بننقل نفس العنصر
        // فعلياً (appendChild بينقل مش بينسخ) عشان كل الأحداث المربوطة
        // عليه (submit، رفع الصورة، اختيار النوع..إلخ) تفضل شغالة زي
        // ما هي من غير أي تكرار في الـ DOM أو الـ Listeners
        dockTarget.appendChild(modal);
        modal.classList.remove('authModalPopup');
        modal.classList.add('authModalEmbedded');
        modal.style.removeProperty('z-index');
        // (إصلاح): نسجّل آخر دوك حقيقي اتدمج فيه، عشان أي إعادة فتح
        // لاحقة من غير dockTarget صريح (شوف lastKnownDockTarget فوق)
        // ترجع نفس المكان ده بدل الوضع المنبثق الأسود
        lastKnownDockTarget = dockTarget;
    } else if (!modal.classList.contains('authModalEmbedded')) {
        // (إصلاح - باج حقيقي): بدل ما نرجع فورًا للوضع المنبثق الأسود
        // (authModalPopup) - وده "الصفحة التانية" اللي المفروض متبقاش
        // موجودة خالص - بنجرب الأول نرجّع المودال لآخر دوك حقيقي اتدمج
        // فيه (lastKnownDockTarget)، طالما لسه موجود فعليًا في الصفحة.
        // كده أي إعادة فتح (زي رفض تسجيل الدخول بسبب جلسة نشطة على جهاز
        // تاني) بترجع لنفس صفحة الـ7 سلايدات الملونة دايماً، مش لصفحة
        // منفصلة بخلفية سودة
        if (lastKnownDockTarget && document.body.contains(lastKnownDockTarget)) {
            lastKnownDockTarget.appendChild(modal);
            modal.classList.remove('authModalPopup');
            modal.classList.add('authModalEmbedded');
            modal.style.removeProperty('z-index');
            return;
        }

        // نُدي أخير جداً (نظريًا مش المفروض يتنفّذ أبداً في الاستخدام
        // العادي للتطبيق - مفيش أي مكان بينادي showAuthModal() قبل ما
        // يكون فيه دوك معروف بالفعل) - بنسيبه بوب أب كحماية بس عشان
        // المودال يفضل شغال بدل ما يختفي تمامًا لو حصل ظرف غير متوقع
        const home = getAuthModalHomeContainer();
        if (home && modal.parentElement !== home) home.appendChild(modal);
        modal.classList.remove('authModalEmbedded');
        modal.classList.add('authModalPopup');
        modal.style.zIndex = '9999';
    }

    modal.classList.remove('hidden');
    // تأمين إضافي: نلغي أي "display: none" ثابت جاي من inline style قديم
    modal.style.removeProperty('display');

    // نتأكد إن معاينة صورة البروفايل ظاهرة بشكل سليم فور فتح المودال
    // (مش لازم ننتظر toggleAuthMode أو اختيار النوع عشان تظهر أول مرة)
    syncSignupAvatarPreview();

    // نفس الفكرة لرابط "سجّل دلوقتي" - نحدّث ظهوره فور فتح المودال مش
    // بس لما المستخدم يضغط toggleAuthMode بنفسه (شوف updateAuthToggleVisibility)
    if (isGuestAreaAllowed !== true) {
        ensureGuestAreaCheckedForToggle({ force: true });
    } else {
        updateAuthToggleVisibility();
    }
}

/**
 * إخفاء موديل تسجيل الدخول. لو كان مدموج جوه سلايد الترحيب الأخيرة
 * (authModalEmbedded)، بيرجّعه تلقائياً لمكانه الأصلي وشكله الافتراضي
 * كمودال منبثق - جاهز لأي استخدام لاحق (تسجيل خروج مثلاً) من غير ما
 * يفضل "عالق" جوه سلايد ترحيب ممكن تكون اتقفلت بالفعل. ده بيغطي كمان
 * حالة "المستخدم ضغط رجوع" جوه الترحيب قبل ما يكمل تسجيل الدخول.
 */
export function hideAuthModal() {
    const modal = document.getElementById('authModal');
    if (!modal) return;

    modal.classList.add('hidden');

    if (modal.classList.contains('authModalEmbedded')) {
        const home = getAuthModalHomeContainer();
        if (home) home.appendChild(modal);
        modal.classList.remove('authModalEmbedded');
        modal.classList.add('authModalPopup');
        modal.style.removeProperty('z-index');
    }
}

/**
 * بتخفي/تظهر رابط "لسه معندكش حساب؟ سجّل دلوقتي" (تبديل لوضع التسجيل)
 * حسب حالة الموقع الجغرافي الحالية - مش دايماً ظاهر زي قبل كده.
 *
 * السبب: إنشاء حساب جديد ممنوع أصلاً لأي حد برّه نطاق نزلة عبيد (إلا
 * مغترب اتواصل مع الدعم واستثنيناه يدويًا) - ده فعلاً متطبّق كحارس فعلي
 * قبل التسجيل (evaluateSignupLocationGate في onboarding.js)، لكن لو
 * الرابط ده فاضل ظاهر برضه لزائر برّه النطاق وهو واقف في فورم "تسجيل
 * الدخول"، بيبان له إنه يقدر "يعمل حساب" برغم إنه هيترفض بعد الضغط -
 * تجربة استخدام مربكة ومضللة.
 *
 * (تحديث - اختيار 2): المنطق معتمد على isGuestAreaAllowed بس - وده
 * دلوقتي مفهوم مستقل تمامًا عن window.isGuestMode (اللي بقى بيعبّر عن
 * حالة تسجيل الدخول مش عن الموقع الجغرافي، شوف تعليق isGuestAreaAllowed
 * فوق). الرابط يفضل مخفي طول ما مفيش تأكيد إيجابي صريح إن الموقع
 * الحالي جوه النطاق المسموح (isGuestAreaAllowed === true بالظبط) -
 * "آمن افتراضيًا" (Fail-safe) لأي حالة تانية (null أو false).
 */
function updateAuthToggleVisibility() {
    const toggleLabelEl = document.getElementById('authToggleLabel');
    const toggleBtnEl = document.getElementById('btnToggleAuthMode');
    if (!toggleLabelEl && !toggleBtnEl) return;

    const shouldHide = currentAuthMode === 'signin' && isGuestAreaAllowed !== true;

    if (toggleLabelEl) toggleLabelEl.classList.toggle('hidden', shouldHide);
    if (toggleBtnEl) toggleBtnEl.classList.toggle('hidden', shouldHide);

    // لسه معندناش أي تأكيد (لا إيجاب ولا سلب) عن الموقع، وإحنا في وضع
    // "تسجيل الدخول" (الحالة اللي فيها اللينك أصلاً مهم يظهر أو يتخفي)؟
    // نشغّل فحص فعلي دلوقتي بدل ما نسيب isGuestAreaAllowed عالقة null
    // للأبد لزائر لسه مسجلش دخول (شوف ensureGuestAreaCheckedForToggle تحت)
    if (currentAuthMode === 'signin' && isGuestAreaAllowed === null) {
        ensureGuestAreaCheckedForToggle();
    }
}

/**
 * بتشغّل فحص موقع فعلي "قراءة فقط" (نفس اللي onboarding.js بيستخدمه
 * كبوابة قبل زرار "إنشاء حساب جديد" - checkLocationForSignup من
 * geofence.js، من غير userId ومن غير أي كتابة في قاعدة البيانات) عشان
 * نحدد isGuestAreaAllowed لأي زائر لسه مسجلش دخول وفاتح فورم "تسجيل
 * الدخول". هذا هو المصدر الوحيد لقيمة isGuestAreaAllowed دلوقتي - مفيش
 * أي مصدر تاني (تسجيل الدخول مبقاش بيعمل أي فحص جغرافي خالص، شوف
 * اختيار 2 في app.js).
 *
 * تدعم معامل force: true لإعادة المحاولة (مثلاً إذا كان الـ GPS مغلقاً
 * في المرة الأولى ثم قام المستخدم بتشغيله عند إعادة فتح الشاشة).
 */
async function ensureGuestAreaCheckedForToggle(options = {}) {
    const { force = false } = options;
    if (isCheckingGuestAreaForToggle) return;
    if (!force && isGuestAreaAllowed !== null) return;

    isCheckingGuestAreaForToggle = true;
    try {
        const { isInsideBounds } = await checkLocationForSignup();
        isGuestAreaAllowed = Boolean(isInsideBounds);
    } catch (error) {
        // فشل تحديد الموقع (رفض إذن، Timeout، GPS مش متاح..إلخ) - نفس
        // فلسفة Fail-safe المستخدمة في evaluateSignupLocationGate
        // (onboarding.js) وinitGeofencingGuard (geofence.js): منقدرش
        // نأكد إن الزائر جوه النطاق، فبنخفي اللينك احترازيًا
        console.warn('تعذّر تحديد الموقع لإظهار رابط "سجّل دلوقتي":', error?.message);
        isGuestAreaAllowed = false;
    } finally {
        isCheckingGuestAreaForToggle = false;
        updateAuthToggleVisibility();
    }
}

/**
 * تبديل شكل الفورم بين "تسجيل دخول" و"إنشاء حساب جديد"
 */
function toggleAuthMode() {
    currentAuthMode = currentAuthMode === 'signin' ? 'signup' : 'signin';

    const submitTextEl = document.getElementById('btnEmailAuthSubmitText');
    const toggleLabelEl = document.getElementById('authToggleLabel');
    const toggleBtnEl = document.getElementById('btnToggleAuthMode');
    const subtitleEl = document.getElementById('authModalSubtitle');
    // فيه حاويتين بتتحكم فيهم مع بعض في نفس الوقت: الاسم الأول/التاني
    // (فوق اسم المستخدم) وباقي الحقول الإضافية (تحت كلمة المرور).
    // اسم المستخدم وكلمة المرور نفسهم فضلوا دايماً ظاهرين برة الاتنين
    // عشان يشتغلوا في وضعي الدخول والتسجيل مع بعض.
    const nameFieldsEl = document.getElementById('signupNameFields');
    const extraFieldsEl = document.getElementById('signupExtraFields');
    // رابط "نسيت كلمة السر؟" - له معنى في وضع "تسجيل الدخول" بس، فبنخفيه
    // في وضع "إنشاء حساب جديد" (مفيش باسورد لسه أصلاً وقتها)
    const forgotPasswordRowEl = document.getElementById('forgotPasswordRow');

    if (currentAuthMode === 'signup') {
        if (submitTextEl) submitTextEl.textContent = 'إنشاء حساب';
        if (toggleLabelEl) toggleLabelEl.textContent = 'عندك حساب بالفعل؟';
        if (toggleBtnEl) toggleBtnEl.textContent = 'سجّل دخولك';
        if (subtitleEl) subtitleEl.textContent = 'انضم لسِكّاوي وابدأ التحدي';
        if (nameFieldsEl) nameFieldsEl.classList.remove('hidden');
        if (extraFieldsEl) extraFieldsEl.classList.remove('hidden');
        if (forgotPasswordRowEl) forgotPasswordRowEl.classList.add('hidden');
        resetSignupExtraFields();
    } else {
        if (submitTextEl) submitTextEl.textContent = 'تسجيل الدخول';
        if (toggleLabelEl) toggleLabelEl.textContent = 'لسه معندكش حساب؟';
        if (toggleBtnEl) toggleBtnEl.textContent = 'سجّل دلوقتي';
        if (subtitleEl) subtitleEl.textContent = 'سجّل دخولك وابدأ رحلتك للبطولة';
        if (nameFieldsEl) nameFieldsEl.classList.add('hidden');
        if (extraFieldsEl) extraFieldsEl.classList.add('hidden');
        if (forgotPasswordRowEl) forgotPasswordRowEl.classList.remove('hidden');
    }

    updateAuthToggleVisibility();
    hideAuthError();
}

/**
 * هاندلر زرار "نسيت كلمة السر؟" - التطبيق مفيهوش نظام استرجاع باسورد
 * تلقائي (زي إيميل إعادة تعيين)، فبنوجّه المستخدم لفريق الدعم الفني
 * على واتساب يدوياً. بدل ما كنا بنستخدم window.confirm() الافتراضي
 * بتاع المتصفح (شكله غريب عن هوية التطبيق)، دلوقتي بنفتح مودال تأكيد
 * من نفس تصميم التطبيق (#forgotPasswordConfirmModal - شوف index.html،
 * نفس نمط #logoutConfirmModal / #dqWarningModal بالظبط) قبل ما نفتح
 * واتساب فعلياً، عشان المستخدم مايتفاجئش بتاب جديد بيتفتح من غير سبب واضح.
 */
function openForgotPasswordConfirmModal() {
    const modal = document.getElementById('forgotPasswordConfirmModal');
    if (!modal) {
        // Fallback نادر: لو المودال مش موجود جوه الصفحة لأي سبب، نرجع
        // للسلوك القديم عشان الزرار يفضل شغال دايماً بدل ما يتعطل كليةً
        window.open(FORGOT_PASSWORD_SUPPORT_WHATSAPP_URL, '_blank', 'noopener,noreferrer');
        return;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeForgotPasswordConfirmModal() {
    const modal = document.getElementById('forgotPasswordConfirmModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function handleForgotPasswordClick() {
    openForgotPasswordConfirmModal();
}

/**
 * ربط أزرار مودال تأكيد "نسيت كلمة السر؟" (الإلغاء، التأكيد، الضغط على
 * الخلفية) - نفس منطق bindLogoutButton بتاع js/profiles.js بالظبط.
 * بتتنادى مرة واحدة من bindAuthModalEvents وقت تحميل الصفحة.
 */
function bindForgotPasswordConfirmModal() {
    const modal = document.getElementById('forgotPasswordConfirmModal');
    const cancelBtn = document.getElementById('forgotPasswordCancelBtn');
    const confirmBtn = document.getElementById('forgotPasswordConfirmBtn');
    if (!modal) return;

    if (cancelBtn) {
        cancelBtn.addEventListener('click', closeForgotPasswordConfirmModal);
    }
    // الضغط برّه الكارت (على الخلفية المعتمة) بيقفل المودال زي أي مودال
    // تأكيد تاني في التطبيق - بنتأكد إن الضغطة على الخلفية نفسها بس
    // (event.target === modal) مش على أي عنصر جواها
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeForgotPasswordConfirmModal();
    });
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            closeForgotPasswordConfirmModal();
            window.open(FORGOT_PASSWORD_SUPPORT_WHATSAPP_URL, '_blank', 'noopener,noreferrer');
        });
    }
}

/**
 * إرجاع الأفاتار الافتراضي الموحّد (مفيش تفرقة حسب النوع دلوقتي - راجع
 * ملحوظة "تحديث" فوق) - سايبين اسم الدالة ومعاملها زي ما هي عشان كل
 * أماكن استخدامها (تحت) تفضل شغالة من غير أي تعديل تاني
 * @param {string} gender - 'male' | 'female' (مش بيأثر على الناتج حاليًا، متسيب للتوافق فقط)
 * @returns {string}
 */
function getDefaultAvatarForGender(gender) {
    return DEFAULT_AVATAR_URI;
}

/**
 * تحديث الصورة المعروضة أعلى فورم التسجيل (Preview)
 * @param {string} imageUrl
 */
function updateSignupAvatarPreview(imageUrl) {
    const previewEl = document.getElementById('signupAvatarPreview');
    if (previewEl) previewEl.src = imageUrl;
}

/**
 * تضمن إن معاينة صورة البروفايل (signupAvatarPreview) دايماً عندها
 * صورة صحيحة معروضة، بترتيب الأولوية التالي:
 *   1) الصورة اللي قصّها المستخدم (croppedAvatarBlob) لو موجودة
 *   2) ملف الصورة الأصلي اللي رفعه (uploadedSignupAvatarFile) لو موجود
 *   3) الأفاتار الافتراضي حسب النوع المختار (لو محدد نوع)
 *   4) الأفاتار الافتراضي للذكر كقيمة احتياطية أخيرة
 * بتتنادى من showAuthModal() عشان تضمن ظهور المعاينة بسلاسة من أول
 * ما المودال يفتح، مش بس بعد toggleAuthMode أو اختيار النوع يدوياً.
 */
function syncSignupAvatarPreview() {
    if (croppedAvatarBlob) {
        updateSignupAvatarPreview(URL.createObjectURL(croppedAvatarBlob));
        return;
    }

    if (uploadedSignupAvatarFile) {
        updateSignupAvatarPreview(URL.createObjectURL(uploadedSignupAvatarFile));
        return;
    }

    updateSignupAvatarPreview(getDefaultAvatarForGender(selectedSignupGender));
}

/**
 * تحديد النوع المختار في فورم التسجيل، وتحديث شكل الزرارين + معاينة
 * الأفاتار الافتراضي (لو المستخدم لسه مرفعش صورة بنفسه)
 * @param {'male'|'female'} gender
 */
function selectSignupGender(gender) {
    selectedSignupGender = gender;

    const genderHiddenInput = document.getElementById('signupGenderInput');
    if (genderHiddenInput) genderHiddenInput.value = gender;

    const maleBtn = document.getElementById('btnGenderMale');
    const femaleBtn = document.getElementById('btnGenderFemale');

    [maleBtn, femaleBtn].forEach((btn) => {
        if (!btn) return;
        const isSelected = btn.dataset.gender === gender;
        // وضع "مُحدَّد": خلفية ذهبية صريحة + توهج، عشان الفرق يبقى واضح
        // بصرياً على أول نظرة (مش مجرد شفافية خفيفة زي قبل كده)
        btn.classList.toggle('bg-gold-500', isSelected);
        btn.classList.toggle('border-gold-500', isSelected);
        btn.classList.toggle('text-lux-950', isSelected);
        btn.classList.toggle('shadow-glow-amber', isSelected);
        // وضع "غير مُحدَّد": نرجّعه لشكله الافتراضي بالظبط
        btn.classList.toggle('bg-lux-800', !isSelected);
        btn.classList.toggle('border-gold-500/15', !isSelected);
        btn.classList.toggle('text-lux-300', !isSelected);
    });

    // بتتنادى مباشرة عند اختيار النوع (مش بس وقت فتح المودال) عشان
    // المعاينة تتحدث فوراً - لو المستخدم رفع صورة بنفسه فعلاً،
    // syncSignupAvatarPreview هتفضّلها تلقائياً على الأفاتار الافتراضي
    syncSignupAvatarPreview();
}



/**
 * ربط أحداث الحقول الإضافية في فورم التسجيل (رفع الصورة + اختيار النوع)
 * تُستدعى مرة واحدة من bindAuthModalEvents
 */
function bindSignupExtraFieldsEvents() {
    const uploadBtn = document.getElementById('btnSignupUploadAvatar');
    const fileInput = document.getElementById('signupAvatarFileInput');
    const avatarPreviewEl = document.getElementById('signupAvatarPreview');
    const maleBtn = document.getElementById('btnGenderMale');
    const femaleBtn = document.getElementById('btnGenderFemale');
    const btnConfirmCrop = document.getElementById('btnConfirmCrop');
    const btnCancelCrop = document.getElementById('btnCancelCrop');

    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
    }

    // الضغط على صورة المعاينة نفسها بيفتح نفس نافذة اختيار الملف (زي
    // زرار "رفع صورة" بالظبط)، عشان المستخدم يقدر يعدّل/يغيّر الصورة
    // اللي مختارها بالفعل من غير ما يدور على الزرار الصغير جنبها.
    if (avatarPreviewEl && fileInput) {
        avatarPreviewEl.addEventListener('click', () => fileInput.click());
    }

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                dispatchToast('من فضلك اختار ملف صورة صحيح', 'error');
                fileInput.value = '';
                return;
            }

            uploadedSignupAvatarFile = file;
            // بدل ما نحط الصورة في المعاينة على طول، بنفتح مودال القص
            // الدائري الأول عشان المستخدم يضبط حدود الصورة قبل ما تتأكد
            openAvatarCropModal(file);
        });
    }

    if (btnConfirmCrop) btnConfirmCrop.addEventListener('click', confirmAvatarCrop);
    if (btnCancelCrop) btnCancelCrop.addEventListener('click', () => closeAvatarCropModal());

    if (maleBtn) maleBtn.addEventListener('click', () => selectSignupGender('male'));
    if (femaleBtn) femaleBtn.addEventListener('click', () => selectSignupGender('female'));
}

/**
 * فتح مودال قص صورة البروفايل، وتشغيل Cropper.js على الصورة اللي
 * المستخدم اختارها، بإطار دائري متناسق (Aspect Ratio 1:1)
 * @param {File} file
 */
function openAvatarCropModal(file) {
    const modal = document.getElementById('avatarCropModal');
    const cropImage = document.getElementById('avatarCropperImage');

    if (!modal || !cropImage || typeof Cropper === 'undefined') {
        // لو المكتبة مش متحملة لأي سبب، منسيبش المستخدم من غير معاينة
        // على الأقل - بنستخدم الصورة زي ما هي من غير قص
        updateSignupAvatarPreview(URL.createObjectURL(file));
        return;
    }

    cropImage.src = URL.createObjectURL(file);

    modal.classList.remove('hidden');

    pushModalState(hideAvatarCropModal);

    // Cropper.js محتاج الصورة تكون معمولها render فعلياً في الـ DOM
    // قبل ما نبنيه عليها، فبنستنى فريم واحد (requestAnimationFrame)
    window.requestAnimationFrame(() => {
        if (avatarCropperInstance) {
            avatarCropperInstance.destroy();
            avatarCropperInstance = null;
        }

        avatarCropperInstance = new Cropper(cropImage, {
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
 * الإخفاء الخام لمودال قص الصورة وتنظيف نسخة Cropper.js الحالية (لو
 * موجودة) فقط - استخدم closeAvatarCropModal تحت. الدالة دي بالذات
 * (الخام) هي اللي لازم تتنادى من resetSignupExtraFields (تصفير فورم
 * التسجيل) كـ "تنضيف احتياطي"، مش closeAvatarCropModal، عشان مانستهلكش
 * خطوة تاريخ متصفح غلط لو مودال القص أصلاً مكانش فاتح وقتها
 */
function hideAvatarCropModal() {
    const modal = document.getElementById('avatarCropModal');
    const cropImage = document.getElementById('avatarCropperImage');

    if (avatarCropperInstance) {
        avatarCropperInstance.destroy();
        avatarCropperInstance = null;
    }

    if (cropImage && cropImage.src) {
        URL.revokeObjectURL(cropImage.src);
        cropImage.src = '';
    }

    if (modal) modal.classList.add('hidden');
}

/**
 * إغلاق مودال قص الصورة - الدالة العامة اللي زرار الإلغاء وتأكيد القص
 * لازم ينادوا عليها بدل hideAvatarCropModal مباشرة
 */
function closeAvatarCropModal() {
    closeModal();
}

/**
 * تأكيد القص: بتاخد المنطقة المحددة من Cropper.js، تحولها لـ Blob،
 * تستخدمها كمعاينة للصورة، وتقفل المودال. الـ Blob ده هو اللي هيتبعت
 * فعلياً لـ Supabase Storage وقت إنشاء الحساب (شوف extraProfileData
 * في bindAuthModalEvents تحت).
 */
function confirmAvatarCrop() {
    if (!avatarCropperInstance) {
        closeAvatarCropModal();
        return;
    }

    const canvas = avatarCropperInstance.getCroppedCanvas({
        width: 400,
        height: 400,
        imageSmoothingQuality: 'high',
    });

    if (!canvas) {
        dispatchToast('تعذّر قص الصورة، جرّب تاني', 'error');
        closeAvatarCropModal();
        return;
    }

    canvas.toBlob((blob) => {
        if (!blob) {
            dispatchToast('تعذّر قص الصورة، جرّب تاني', 'error');
            closeAvatarCropModal();
            return;
        }

        croppedAvatarBlob = blob;
        updateSignupAvatarPreview(URL.createObjectURL(blob));
        closeAvatarCropModal();
    }, 'image/jpeg', 0.92);
}

/**
 * إعادة تصفير كل الحقول الإضافية في فورم التسجيل، بتتنادى كل مرة
 * الفورم يتفتح في وضع "إنشاء حساب جديد"
 */
function resetSignupExtraFields() {
    const firstNameInput = document.getElementById('signupFirstNameInput');
    const lastNameInput = document.getElementById('signupLastNameInput');
    const birthDateInput = document.getElementById('signupBirthDateInput');
    const phoneInput = document.getElementById('signupPhoneInput');
    const genderHiddenInput = document.getElementById('signupGenderInput');
    const fileInput = document.getElementById('signupAvatarFileInput');
    const maleBtn = document.getElementById('btnGenderMale');
    const femaleBtn = document.getElementById('btnGenderFemale');

    if (firstNameInput) firstNameInput.value = '';
    if (lastNameInput) lastNameInput.value = '';
    if (birthDateInput) birthDateInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (genderHiddenInput) genderHiddenInput.value = '';
    if (fileInput) fileInput.value = '';

    selectedSignupGender = null;
    uploadedSignupAvatarFile = null;
    croppedAvatarBlob = null;

    [maleBtn, femaleBtn].forEach((btn) => {
        if (!btn) return;
        btn.classList.remove('bg-gold-500', 'border-gold-500', 'text-lux-950', 'shadow-glow-amber');
        btn.classList.add('bg-lux-800', 'border-gold-500/15', 'text-lux-300');
    });

    const passwordConfirmInput = document.getElementById('authPasswordConfirmInput');
    if (passwordConfirmInput) passwordConfirmInput.value = '';

    // إعادة ضبط حقول كلمات المرور إلى وضع الإخفاء الافتراضي
    ['authPasswordInput', 'authPasswordConfirmInput'].forEach((id) => {
        const input = document.getElementById(id);
        if (input) input.type = 'password';
    });
    ['btnToggleAuthPassword', 'btnToggleAuthConfirmPassword'].forEach((btnId) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        const openIcon = btn.querySelector('.eye-open');
        const closedIcon = btn.querySelector('.eye-closed');
        if (openIcon) openIcon.classList.remove('hidden');
        if (closedIcon) closedIcon.classList.add('hidden');
    });

    updateSignupAvatarPreview(DEFAULT_AVATAR_URI);
    // تنضيف احتياطي مباشر (بدون المرور بـ closeModal/history.back) -
    // شوف تعليق hideAvatarCropModal فوق ليه هنا بالذات لازم الخام
    hideAvatarCropModal();
}

/**
 * عرض رسالة خطأ داخل موديل تسجيل الدخول
 * @param {string} message
 */
function showAuthError(message) {
    const errorEl = document.getElementById('authErrorText');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

/** إخفاء رسالة الخطأ داخل موديل تسجيل الدخول (لو ظاهرة) */
function hideAuthError() {
    const errorEl = document.getElementById('authErrorText');
    if (errorEl) errorEl.classList.add('hidden');
}

/**
 * التحكم في ظهور مؤشر التحميل (Spinner) جوه زرار الفورم أثناء الاتصال بالسيرفر
 * @param {boolean} isLoading
 */
function setAuthFormLoading(isLoading) {
    const submitBtn = document.getElementById('btnEmailAuthSubmit');
    const spinner = document.getElementById('authLoadingSpinner');
    const submitText = document.getElementById('btnEmailAuthSubmitText');

    if (submitBtn) submitBtn.disabled = isLoading;
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
    if (submitText) submitText.classList.toggle('opacity-60', isLoading);
}

/**
 * التحقق من صحة شكل اسم المستخدم قبل أي اتصال بالسيرفر
 * @param {string} username
 * @returns {boolean}
 */
function isValidUsername(username) {
    return USERNAME_REGEX.test(username);
}

/**
 * تحويل اسم المستخدم لإيميل داخلي وهمي يفهمه Supabase Auth
 * (بيتم توحيد الحالة لحروف صغيرة عشان التفرّد يبقى غير حساس لحالة الأحرف)
 * @param {string} username
 * @returns {string}
 */
function usernameToInternalEmail(username) {
    return `${username.trim().toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`;
}

/**
 * التحقق من صحة الحقول الإضافية في فورم التسجيل قبل أي اتصال بالسيرفر
 * @param {{firstName: string, lastName: string, birthDate: string, gender: string}} extraProfileData
 */
function validateSignupExtraFields({ firstName, lastName, birthDate, gender }) {
    if (!firstName) throw new Error('من فضلك اكتب الاسم الأول');
    if (!lastName) throw new Error('من فضلك اكتب الاسم الثاني');
    if (!birthDate) throw new Error('من فضلك اختار تاريخ الميلاد');

    const birthDateObj = new Date(birthDate);
    if (Number.isNaN(birthDateObj.getTime()) || birthDateObj > new Date()) {
        throw new Error('تاريخ الميلاد مش صحيح');
    }

    if (gender !== 'male' && gender !== 'female') {
        throw new Error('من فضلك اختار النوع');
    }
}

/**
 * رفع صورة البروفايل اللي اختارها المستخدم وقت التسجيل لباكت "avatars"
 * في Supabase Storage، وإرجاع الرابط العام (Public URL) بتاعها
 * @param {string} userId
 * @param {File} file
 * @returns {Promise<string>}
 */
async function uploadSignupAvatarFile(userId, file) {
    validateAvatarFile(file); // (إصلاح أمني) شوف تعريفها فوق

    // الصورة ممكن توصلنا كـ File (لها name فيه امتداد) أو كـ Blob ناتج
    // من قص Cropper.js (مفهوش name خالص) - بنغطي الحالتين هنا
    const fileExtension = (file.name && file.name.includes('.'))
        ? file.name.split('.').pop()
        : (file.type && file.type.includes('/') ? file.type.split('/').pop() : 'jpg');

    const filePath = `${userId}/avatar-${Date.now()}.${fileExtension}`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('avatars')
        .upload(filePath, file, { upsert: true, contentType: file.type || 'image/jpeg' });

    if (uploadError) {
        throw new Error(uploadError.message);
    }

    const { data } = supabaseClient.storage.from('avatars').getPublicUrl(filePath);
    return data.publicUrl;
}

/**
 * تسجيل حساب جديد باسم المستخدم وكلمة المرور، مع حفظ بروفايل كامل
 * (الاسم الأول والتاني، تاريخ الميلاد، النوع، رقم التليفون، وصورة
 * البروفايل) في جدول profiles على طول - من غير ما يحتاج المستخدم
 * يعدي على موديل "إعداد البطل لأول مرة" تاني.
 * @param {string} username
 * @param {string} password
 * @param {{firstName: string, lastName: string, birthDate: string, gender: string, phone: string, avatarFile: File|null}} extraProfileData
 */
async function signUpWithUsername(username, password, extraProfileData) {
    if (!isValidUsername(username)) {
        throw new Error('اسم المستخدم لازم يكون حروف إنجليزية وأرقام و "_" بس، من 3 لـ20 حرف');
    }

    if (!password || password.length < 6) {
        throw new Error('كلمة المرور لازم تكون 6 حروف/أرقام على الأقل');
    }

    validateSignupExtraFields(extraProfileData);

    const internalEmail = usernameToInternalEmail(username);

    // بنرفع العلم ده قبل أي حاجة عشان لو Supabase طلقت SIGNED_IN فوراً
    // جوه signUp()، handleSignedInSession متعملش الفحص التلقائي للبروفايل
    // (شوف تعليق isCustomSignUpInProgress فوق للتفاصيل).
    isCustomSignUpInProgress = true;

    try {
        const fullName = `${extraProfileData.firstName} ${extraProfileData.lastName}`.trim();

        // التقاط موقع التسجيل وحساب المسافة عن مركز نزلة عبيد
        let signupLocationData = null;
        try {
            const rawCoords = await getUserCoordinates();
            if (rawCoords && typeof rawCoords.latitude === 'number') {
                const zoneSettings = await fetchGeofenceSettings();
                const distMeters = Math.round(
                    calculateDistanceMeters(
                        rawCoords.latitude,
                        rawCoords.longitude,
                        zoneSettings.centerLatitude,
                        zoneSettings.centerLongitude
                    )
                );
                signupLocationData = {
                    latitude: rawCoords.latitude,
                    longitude: rawCoords.longitude,
                    accuracyMeters: Math.round(rawCoords.accuracyMeters || 0),
                    distanceMeters: distMeters,
                };
            }
        } catch (locErr) {
            console.warn('تعذر التقاط إحداثيات التسجيل بدقة:', locErr.message);
        }

        const authDataPayload = {
            username: username.trim(),
            first_name: extraProfileData.firstName,
            last_name: extraProfileData.lastName,
            full_name: fullName,
        };
        if (signupLocationData) {
            authDataPayload.signup_lat = signupLocationData.latitude;
            authDataPayload.signup_lng = signupLocationData.longitude;
            authDataPayload.signup_distance_meters = signupLocationData.distanceMeters;
            authDataPayload.signup_accuracy_meters = signupLocationData.accuracyMeters;
        }

        const { data, error } = await supabaseClient.auth.signUp({
            email: internalEmail,
            password,
            options: {
                data: authDataPayload,
            },
        });

        if (error) {
            // طباعة تفاصيل خطأ Supabase كاملة في الكونسول عشان نقدر نشخّص
            // مشاكل زي 400 Bad Request بسهولة (صيغة الإيميل، سياسات
            // الباسورد، قيود الدومين، إلخ) بدل ما نشوف بس رسالة عامة
            // في الـ UI. بنطبع الحقول المهمة منفصلة (سهلة القراءة في
            // الكونسول)، وكمان الـ error object الخام كامل (لو فيه
            // تفاصيل إضافية زي error.cause أو خصائص مش متوقعة).
            console.error(
                '[Supabase signUp] فشل تسجيل حساب جديد - message:', error.message,
                '| status:', error.status,
                '| code:', error.code || error.name || 'unknown',
            );
            console.error('[Supabase signUp] internalEmail المستخدم:', internalEmail);
            console.error('[Supabase signUp] الـ error object الخام بالكامل:', error);

            throw new Error(translateAuthError(error));
        }

        const newUser = data.user;

        if (!newUser) {
            throw new Error('اتسجل حسابك، بس محتاجين تأكيد إضافي قبل ما نكمل - كلّم الدعم الفني');
        }

        // تجهيز رابط صورة البروفايل: صورة رفعها المستخدم، أو أفاتار
        // افتراضي حسب النوع لو مرفعش حاجة (أو لو فشل الرفع لأي سبب)
        let avatarUrl = getDefaultAvatarForGender(extraProfileData.gender);

        if (extraProfileData.avatarFile) {
            try {
                avatarUrl = await uploadSignupAvatarFile(newUser.id, extraProfileData.avatarFile);
            } catch (uploadErr) {
                console.error('فشل رفع صورة البروفايل وقت التسجيل، هنستخدم الأفاتار الافتراضي:', uploadErr.message);
                dispatchToast('تعذّر رفع الصورة، اتحطلك أفاتار افتراضي بدالها', 'info');
            }
        }

        const baseProfilePayload = {
            id: newUser.id,
            username: username.trim(),
            full_name: fullName,
            first_name: extraProfileData.firstName,
            last_name: extraProfileData.lastName,
            birth_date: extraProfileData.birthDate,
            gender: extraProfileData.gender,
            phone: extraProfileData.phone || null,
            avatar_url: avatarUrl,
            last_lat: signupLocationData ? signupLocationData.latitude : null,
            last_lng: signupLocationData ? signupLocationData.longitude : null,
        };

        // محاولة الحفظ مع أعمدة موقع التسجيل أولاً، مع تراجع آمن في حال عدم وجود الأعمدة
        let insertError = null;
        if (signupLocationData) {
            const extendedPayload = {
                ...baseProfilePayload,
                signup_lat: signupLocationData.latitude,
                signup_lng: signupLocationData.longitude,
                signup_distance_meters: signupLocationData.distanceMeters,
                signup_accuracy_meters: signupLocationData.accuracyMeters,
            };
            const res = await supabaseClient
                .from('profiles')
                .upsert(extendedPayload, { onConflict: 'id' });
            if (res.error && (res.error.code === '42703' || res.error.message?.includes('signup_'))) {
                const fallbackRes = await supabaseClient
                    .from('profiles')
                    .upsert(baseProfilePayload, { onConflict: 'id' });
                insertError = fallbackRes.error;
            } else {
                insertError = res.error;
            }
        } else {
            const res = await supabaseClient
                .from('profiles')
                .upsert(baseProfilePayload, { onConflict: 'id' });
            insertError = res.error;
        }

        if (insertError) {
            console.error('خطأ في حفظ بروفايل المستخدم بعد التسجيل:', insertError.message);
            // بنضيف رسالة Supabase الخام في الخطأ المرمي عشان تبان في
            // الـ Toast مباشرة (زي مشكلة RLS Policy مثلاً) من غير ما
            // نحتاج نفتح الـ Console كل مرة نشخّص فيها مشكلة حفظ
            throw new Error(`اتسجل حسابك، بس حصلت مشكلة في حفظ البيانات (${insertError.message}) - كلّم الدعم الفني`);
        }

        // تحقق فعلي وحيد من الموقع الجغرافي على مستوى السيرفر (الدالة
        // نفسها بتحسب المسافة، مش بتصدّق بوليان جاي من العميل) - ده اللي
        // بيكتب is_inside_bounds الحقيقي في صف البروفايل. تم وضعه بعد نجاح
        // حفظ البروفايل (upsert) لضمان وجود صف المستخدم في جدول profiles.
        // checkLocationForSignup في onboarding.js كانت بس بوابة UI قبل ما
        // نوصل هنا أصلاً (تمنع زرار "إنشاء حساب" يظهر)، مش كتابة فعلية.
        //
        // فشل تحديد الموقع هنا (رفض إذن GPS، Timeout..إلخ) ما بيوقفش
        // التسجيل نفسه - بس بيسيب is_inside_bounds على الافتراضي false
        // (Fail-safe)، والمستخدم يقدر يعيد المحاولة لاحقًا أو يتواصل مع
        // الدعم لو مغترب مستثنى (is_verified_override).
        try {
            const signupCoordinates = await getUserCoordinates();
            const { error: locationRpcError } = await supabaseClient.rpc('verify_signup_location', {
                p_lat: signupCoordinates.latitude,
                p_lng: signupCoordinates.longitude,
            });

            if (locationRpcError) {
                console.warn('فشل استدعاء verify_signup_location وقت التسجيل:', locationRpcError.message);
            }
        } catch (locationError) {
            console.warn('تعذّر تحديد موقع المستخدم وقت التسجيل (RPC verify_signup_location):', locationError.message);
        }

        currentUser = newUser;

        // بنطلق الأحداث يدوياً هنا (بعد ما اتأكدنا إن البروفايل اتحفظ
        // فعلاً) عشان باقي التطبيق (زي app.js) يعدي على طول لصفحة
        // البروفايل والداشبورد من غير ما يفتح موديل الإعداد تاني.
        if (data.session) {
            // حساب جديد اتسجل دلوقتي فعلياً - نكسب مقعد الجلسة النشطة
            // الوحيد لصالح الجهاز ده على طول (نفس منطق تسجيل الدخول
            // العادي، شوف "الجلسة الواحدة" فوق handleSignedInSession)
            await claimSingleSession(newUser.id);
            bindProfileSessionRealtimeSubscription(newUser.id);

            document.dispatchEvent(new CustomEvent('auth:signed-in', {
                detail: { user: newUser, session: data.session, hasProfile: true },
            }));
            document.dispatchEvent(new CustomEvent('auth:login', {
                detail: { user: newUser, session: data.session, hasProfile: true },
            }));
        }

        return data;
    } finally {
        isCustomSignUpInProgress = false;
    }
}

/**
 * تسجيل الدخول باسم المستخدم وكلمة المرور لحساب موجود بالفعل
 * @param {string} username
 * @param {string} password
 */
async function signInWithUsername(username, password) {
    if (!username || !isValidUsername(username) || !password) {
        throw new Error('اسم المستخدم أو كلمة المرور غلط');
    }

    const internalEmail = usernameToInternalEmail(username);

    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: internalEmail,
        password,
    });

    if (error) {
        throw new Error(translateAuthError(error));
    }

    return data;
}

/**
 * تحويل رسائل خطأ Supabase الإنجليزية لرسائل عربية مفهومة للمستخدم
 * @param {{message: string, status?: number}} error
 */
function translateAuthError(error) {
    const rawMessage = (error && error.message) || '';
    const status = error && error.status;

    if (rawMessage.includes('Invalid login credentials')) {
        return 'اسم المستخدم أو كلمة المرور غلط';
    }
    if (rawMessage.includes('User already registered')) {
        return 'اسم المستخدم ده متسجل بحساب قبل كده';
    }
    if (rawMessage.includes('Password should be at least')) {
        return 'كلمة المرور لازم تكون 6 حروف/أرقام على الأقل';
    }
    if (rawMessage.includes('Unable to validate email') || rawMessage.includes('Email address') && rawMessage.includes('invalid')) {
        return 'اسم المستخدم مش بصيغة صحيحة، جرّب اسم مستخدم تاني';
    }
    if (rawMessage.includes('rate limit') || status === 429) {
        return 'محاولات كتير في وقت قصير، استنى شوية وجرّب تاني';
    }
    if (rawMessage.includes('Signups not allowed') || rawMessage.includes('signup is disabled')) {
        return 'التسجيل بحساب جديد متوقف مؤقتاً - كلّم الدعم الفني';
    }
    if (rawMessage.includes('email address') && rawMessage.includes('domain')) {
        // بعض مشاريع Supabase بتفعّل قيد "Allowed Email Domains" في
        // إعدادات الـ Auth، وده بيرفض أي دومين مش موجود في القائمة
        // البيضاء بتاعتهم - حتى لو الصيغة نفسها صحيحة قياسياً
        return 'حصلت مشكلة في إعدادات التسجيل (قيد على الدومين المستخدم) - كلّم الدعم الفني';
    }

    // لو الخطأ من نوع 400 (Bad Request) ومعرفناش نصنّفه في حالة معروفة
    // فوق، نوريله رسالة توضح إن فيه مشكلة في بيانات التسجيل بدل رسالة
    // عامة جداً، عشان يقدر يبلّغ الدعم الفني بتفاصيل أوضح لو استمرت.
    // بنضيف كمان الرسالة الخام من Supabase نفسها (لو موجودة) عشان
    // تبان في الـ Toast/UI مباشرة من غير ما يحتاج يفتح الكونسول أصلاً
    if (status === 400) {
        const rawSuffix = rawMessage ? ` (${rawMessage})` : '';
        return `البيانات المُدخلة فيها مشكلة (Bad Request)${rawSuffix} - جرّب تتأكد من اسم المستخدم وكلمة المرور، ولو استمرت المشكلة كلّم الدعم الفني`;
    }

    // أي حالة تانية غير متوقعة: بنوري رقم الحالة (لو موجود) ورسالة
    // Supabase الخام كمان، عشان المستخدم/الدعم الفني يقدروا يشخّصوا
    // المشكلة بسرعة من غير ما يفتحوا أدوات المطور بنفسهم
    if (rawMessage) {
        return `حصل خطأ${status ? ` (${status})` : ''}: ${rawMessage}`;
    }

    return 'حصل خطأ، جرّب تاني';
}

/**
 * تسجيل الخروج من الحساب الحالي
 */
export async function signOut() {
    unbindProfileSessionRealtimeSubscription();
    unbindIncomingLoginApprovalSubscription();
    stopSingleSessionHeartbeat();

    // بنفضّي مقعد الجلسة النشطة (لو إحنا ماسكينه) قبل الـ signOut نفسها،
    // عشان لو حد عايز يدخل من جهاز تاني بعد كده يقدر - وإلا كان الحساب
    // هيفضل "مقفول" على بصمة الجهاز ده للأبد حتى بعد ما صاحبه سجّل
    // خروج بنفسه فعلاً (شوف تعليق "الجلسة الواحدة" فوق)
    if (currentUser) {
        await releaseSingleSessionClaim(currentUser.id);
    }

    // نفس ملحوظة forceSignOutDueToOtherSession: scope: 'local' هنا عشان
    // تسجيل الخروج اليدوي من جهاز واحد ميمسحش جلسة أي جهاز تاني مسجل
    // بنفس الحساب (لو موجود) - مسؤولية "طرد الجهاز التاني" دي بالكامل
    // على نظام "الجلسة الواحدة" (active_session_id + Realtime) فوق، مش
    // على scope الافتراضي بتاع Supabase.
    await supabaseClient.auth.signOut({ scope: 'local' });
    currentUser = null;

    // احتياط إضافي: نتأكد إن فلاج "استمرار وضع الزائر" مش فاضل محفوظ من
    // جلسة زائر قديمة قبل ما يسجّل هذا الحساب دخوله أصلاً - عشان تسجيل
    // الخروج يودّي دايمًا لصفحة اختيار الدخول/التسجيل العادية (showAuthGate
    // تحت)، مش لوضع الزائر المستمر
    clearGuestModeActive();

    document.dispatchEvent(new CustomEvent('auth:signed-out', { detail: {} }));
    dispatchToast('تم تسجيل الخروج بنجاح', 'success');

    // بدل ما نفتح authModal كمودال منبثق فوق التطبيق (Blur خلفه)، بنودّي
    // المستخدم لنفس صفحة اختيار الدخول/التسجيل الكاملة اللي شافها أول
    // مرة (شوف showAuthGate في js/onboarding.js)
    showAuthGate();
}

/**
 * ترجع بيانات المستخدم الحالي فعلياً من Supabase (مش من الكاش المحلي)،
 * عن طريق التحقق المباشر مع سيرفر Supabase. الفرق بينها وبين
 * restoreSession(): الدالة دي async وبتضمن إن التوكن لسه صالح، بينما
 * restoreSession() sync وبترجع نسخة "متفائلة" (Optimistic) بسرعة من
 * localStorage من غير ما تتأكد من السيرفر.
 * @returns {Promise<import('@supabase/supabase-js').User | null>}
 */
export async function getCurrentUser() {
    try {
        const { data, error } = await supabaseClient.auth.getUser();

        if (error) {
            console.error('خطأ في جلب المستخدم الحالي:', error.message);
            return null;
        }

        currentUser = data.user;
        return data.user;
    } catch (err) {
        // (إصلاح - باج حقيقي): على عكس ما كان متوقّع، supabaseClient.auth.getUser()
        // بترمي استثناء حقيقي (AuthSessionMissingError) لو مفيش جلسة نشطة خالص
        // - بدل ما ترجع { data: null, error } عادي زي getSession() - فالسطر
        // فوق (await ...getUser()) كان بيفشل ويرمي *قبل* ما يوصل لسطر
        // "if (error)" أصلاً، فمفيش حد كان بيمسك الاستثناء ده. النتيجة: أي
        // مستخدم زائر (بدون جلسة) كان بيكسر أي كود بينادي getCurrentUser()
        // (زي initStoriesUI في js/stories.js) باستثناء غير ممسوك (Uncaught
        // in promise) في الـ Console، حتى لو الحالة دي طبيعية 100% لزائر
        // مالوش حساب أصلاً - مش خطأ فعلي محتاج نوقف عنده
        console.error('خطأ في جلب المستخدم الحالي:', err.message);
        return null;
    }
}

/**
 * تُستدعى مرة واحدة sync (من غير await) في بداية تشغيل التطبيق من
 * app.js، عشان تدي واجهة المستخدم قيمة أولية سريعة لهوية المستخدم
 * (لو موجودة) قبل ما فحص الجلسة الفعلي مع سيرفر Supabase يخلص.
 *
 * بتقرأ مباشرة من localStorage (بنفس storageKey المستخدم في
 * supabase-config.js عند إنشاء العميل)، لأن الفحص الحقيقي والمضمون
 * (checkExistingSession + onAuthStateChange) بيشتغل بشكل async ومستقل،
 * وهو اللي بيطلق حدث "auth:login" لاحقاً بمجرد ما يتأكد من صحة الجلسة.
 * @returns {import('@supabase/supabase-js').User | null}
 */
export function restoreSession() {
    if (currentUser) return currentUser;

    try {
        const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        // شكل التخزين بيختلف حسب نسخة supabase-js (وممكن يتغيّر مع أي
        // ترقية مستقبلية للمكتبة من غير ما حد يلاحظ) - قبل كده كنا
        // بنغطي بس شكلين معروفين (parsed.user / parsed.currentSession.user)،
        // ولو الشكل الفعلي المحفوظ يختلف عنهم شوية (زي parsed.session.user
        // في بعض إصدارات supabase-js v2)، كانت الدالة بترجع null غلط رغم
        // إن فيه جلسة صحيحة فعلاً محفوظة - وده بالظبط كان بيسبب "فلاش"
        // ظهور حالة زائر/مش مسجل دخول للحظة عند كل Refresh لحد ما الفحص
        // الحقيقي (checkExistingSession) يلحق يأكد الجلسة من السيرفر.
        // (إصلاح): بدل التخمين بأسماء حقول محددة بس، بندوّر جوه الكائن
        // كله (مستوى أو اتنين) عن أول حقل اسمه "user" ومعاه id فعلي -
        // تغطية أشمل لأي شكل تخزين حالي أو مستقبلي قريب منه.
        const candidateUsers = [
            parsed?.user,
            parsed?.currentSession?.user,
            parsed?.session?.user,
            parsed?.data?.session?.user,
        ];
        const cachedUser = candidateUsers.find((candidate) => candidate && candidate.id) || null;

        if (cachedUser) currentUser = cachedUser;
        return cachedUser;
    } catch (err) {
        console.error('تعذر قراءة الجلسة المحفوظة محلياً:', err);
        return null;
    }
}

/**
 * بيرجّع true لو `restoreSession()` عندها فرصة حقيقية ترجع مستخدم فعلي
 * (يعني فيه صف خام في localStorage أصلاً، حتى لو شكله مش من الأشكال
 * المعروفة جوه restoreSession). بتتستخدم في app.js عشان تفرّق بين
 * "زائر حقيقي مالوش أي جلسة خالص" و"فيه جلسة محفوظة بس القراءة
 * المتفائلة السريعة معرفتش توصفها"، عشان الحالة التانية متتعاملش وكأنها
 * زائر فورًا (وتتسبب في فلاش شريط الزائر) - بل تستنى الفحص الحقيقي مع
 * السيرفر (checkExistingSession) يأكد الحالة الفعلية.
 * @returns {boolean}
 */
export function hasAnyStoredSessionHint() {
    try {
        return Boolean(window.localStorage.getItem(AUTH_STORAGE_KEY));
    } catch (err) {
        return false;
    }
}

/**
 * التحقق هل عند المستخدم صف محفوظ بالفعل في جدول profiles
 * (بيستخدم في تحديد هل نفتحله موديل "إعداد البطل لأول مرة" ولا لأ)
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function checkIfProfileExists(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('خطأ في التحقق من البروفايل:', error.message);
        return false;
    }

    return Boolean(data);
}

/* ------------------------------------------------------------------
   حظر الحسابات (المرحلة 2) - is_blocked/blocked_reason على profiles
   بيتحدّثوا بس عن طريق admin_toggle_user_block (شوف admin.js وsql/
   phase-2-blocking.sql)، لكن الفحص هنا بيقرا صف المستخدم الحالي بس
   (auth.uid() = id) وده مسموح في RLS العادية بدون احتياج RPC خاصة،
   بنفس منطق checkIfProfileExists فوق بالظبط.
   ------------------------------------------------------------------ */

/**
 * تتحقق هل حساب معيّن محظور دلوقتي، وترجع سبب الحظر لو موجود.
 * لو حصل خطأ شبكة/اتصال، بترجع null (فشل الفحص) بدل ما تمنع دخول
 * مستخدم شرعي بالغلط بسبب مشكلة اتصال مؤقتة - نفس فلسفة "فشل آمن"
 * (fail-open) المستخدمة في باقي فحوصات الجلسة هنا
 * @param {string} userId
 * @returns {Promise<{isBlocked: boolean, reason: string|null}|null>}
 */
async function checkIfUserIsBlocked(userId) {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('is_blocked, blocked_reason')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('خطأ في التحقق من حالة حظر الحساب:', error.message);
        return null;
    }

    if (!data) return null;

    return { isBlocked: Boolean(data.is_blocked), reason: data.blocked_reason || null };
}

/**
 * بترفض جلسة مستخدم محظور - بتسجّل خروجه محلياً فوراً (قبل ما يوصل
 * لأي شاشة جوه التطبيق) وتوريله رسالة واضحة بسبب الحظر لو متوفر.
 * scope: 'local' بنفس منطق forceSignOutDueToOtherSession تحت - عشان
 * منلغيش الـ refresh token على مستوى السيرفر لأي سبب غير مقصود هنا
 * @param {string|null} reason
 */
async function rejectSignedInSessionDueToBlock(reason) {
    const message = reason
        ? `حسابك موقوف مؤقتاً: ${reason}`
        : 'حسابك موقوف مؤقتاً، تواصل مع الدعم الفني لمزيد من التفاصيل';

    dispatchToast(message, 'error');
    await supabaseClient.auth.signOut({ scope: 'local' });
    currentUser = null;
    document.dispatchEvent(new CustomEvent('auth:signed-out', { detail: {} }));
    showAuthGate();
}

/* ------------------------------------------------------------------
   الجلسة الواحدة (Single Active Session) - بيمنع نفس الحساب إنه يشتغل
   مسجّل دخول من جهازين/متصفحين (أو حتى Incognito) في نفس الوقت. السياسة
   هنا: "أول جهاز بيفضل شغال" (مش آخر واحد) - يعني لو الحساب مسجل دخول
   بالفعل من جهاز، أي محاولة تسجيل دخول من جهاز تاني بترفض على طول
   والجهاز الأول مايتأثرش خالص. الفكرة:

     1) كل جهاز/متصفح ليه "بصمة" عشوائية ثابتة (deviceSessionId) بنولّدها
        مرة واحدة ونخزنها في localStorage بتاعه (getOrCreateDeviceSessionId).
        تابين مفتوحين في نفس المتصفح بيشاركوا نفس الـ localStorage، يعني
        بيتحسبوا "نفس الجهاز" عمداً - مش هيطردوا بعض.

     2) عمود active_session_id في جدول profiles بيحتفظ ببصمة الجهاز اللي
        "ماسك" الحساب دلوقتي (لو موجود). عند أي تسجيل دخول فعلي جديد
        (SIGNED_IN)، بنتحقق الأول (checkSingleSessionSlotBeforeSignIn):
        لو العمود ده فاضي أو بيحمل بصمة نفس الجهاز، بنكمل عادي ونكسب
        المقعد (claimSingleSession). لو بيحمل بصمة جهاز تاني، بنرفض
        الدخول من هنا فوراً (نعمل signOut محلي بس لهذا الجهاز) ونوضح
        للمستخدم إن الحساب شغال من جهاز تاني بالفعل - من غير ما نلمس
        جلسة الجهاز الأول خالص.

     3) كل جهاز كسب المقعد بيفضل مشترك (Realtime) في تحديثات صف
        profiles بتاعه بالظبط - دي بقت الآلية الوحيدة اللي بتطرد الجهاز
        الحالي فعلياً لو جهاز تاني كسب المقعد (forceSignOutDueToOtherSession)،
        وده بيحصل بس *لحظياً* وهو فاتح التطبيق فعلاً وقت ما ده يحصل، مع
        توست واضح يوضح السبب.

     4) لو التطبيق اتقفل وفتح تاني (INITIAL_SESSION)، **مفيش أي تحقق
        إضافي بيحصل خالص** - الجلسة المحفوظة بتتقبل زي ما هي من غير ما
        نقارن بصمة الجهاز بأي حاجة في القاعدة. اتشالت عمداً (كانت في
        دالة verifyThisDeviceStillActive) لأنها كانت بتعمل تسجيل خروج
        *صامت* (من غير أي رسالة) لو بصمة الجهاز المحفوظة محلياً اتغيّرت
        لأي سبب (متصفح بيمسح localStorage تلقائياً، PWA وبراوزر عادي
        بالتبادل..إلخ) - حتى لو محدش تاني فعلاً دخل الحساب. ده كان بيظهر
        للمستخدم كـ"تسجيل خروج تلقائي غريب" كل ما يفتح التطبيق بعد فترة.

     5) لما المستخدم يعمل تسجيل خروج يدوي من نفس الجهاز الماسك للمقعد
        (signOut)، بنفضّي العمود (releaseSingleSessionClaim) عشان
        المقعد يبقى متاح لأي جهاز تاني يدخل بعد كده - وإلا كان الحساب
        هيفضل "مقفول" على الجهاز القديم للأبد حتى بعد ما صاحبه يعمل
        خروج بنفسه.

     6) المشكلة الباقية بعد كل اللي فوق: لو جهاز ماسك المقعد اتقفل (تاب
        اتقفل، متصفح خفي اتمسح..إلخ) من غير ما signOut() تتنفذ خالص،
        المقعد بيفضل "عالق" على بصمة جهاز مبقاش موجود للأبد - ومحدش
        (حتى صاحب الحساب نفسه من جهاز جديد) يقدر يدخل تاني. اتحل
        بطريقتين مكمّلين لبعض:

        أ) نبضة حياة (Heartbeat): كل جهاز ماسك المقعد بيحدّث عمود
           active_session_updated_at كل HEARTBEAT_INTERVAL_MS (شوف
           startSingleSessionHeartbeat) طول ما التطبيق فاتح عنده. لو
           جهاز تاني حاول يدخل ولقى إن آخر نبضة أقدم من
           STALE_SESSION_THRESHOLD_MS، بيعتبر المقعد "عالق" فعلياً
           وبيسمح بالدخول العادي من غير أي تدخل يدوي (شوف الفرع الأخير
           في checkSingleSessionSlotBeforeSignIn) - ده بيحل حالة
           المتصفح الخفي المتقفل تلقائياً بعد أقصى STALE_SESSION_THRESHOLD_MS.

        ب) موافقة الجهاز الآخر (Login Approval): لو المقعد لسه "حي"
           (نبضة حديثة) ومش عالق، مبقاش فيه أي "دخول قسري" بديل خالص -
           قرار أمان صريح. بدل كده، الجهاز الطالب بيبعت طلب موافقة فعلي
           (جدول login_approval_requests - شوف sql/002_login_approval_requests.sql)
           والجهاز الماسك للجلسة الحالية (لو فاتح التطبيق فعلاً وقتها)
           بيستقبله لحظياً عبر Realtime (bindIncomingLoginApprovalSubscription)
           ويشوف مودال "فيه حد بيحاول يدخل حسابك من جهاز تاني - يوافق
           ولا يرفض؟". لو وافق، الجهاز الطالب يكمل دخوله عادي (نفس مسار
           claimSingleSession) وهيطرد الجهاز الأول لحظياً بنفس آلية
           Realtime العادية (بند 3 فوق) بمجرد ما يكسب المقعد. لو رفض، أو
           لو محدش رد خلال LOGIN_APPROVAL_TIMEOUT_MS (90 ثانية)، الطلب
           بيتقفل والدخول بيترفض نهائياً - حتى لو الشخص اللي بيحاول يدخل
           هو فعلاً صاحب الحساب الحقيقي وعارف الباسورد صح. شوف
           handleSessionConflictViaApproval تحت للتفاصيل الكاملة.

   ملحوظة مهمة: العمودين دول لازم يتضافوا يدوياً في قاعدة البيانات أول مرة:
       alter table public.profiles add column if not exists
           active_session_id uuid;
       alter table public.profiles add column if not exists
           active_session_updated_at timestamptz;
   وتتأكد إن سياسة RLS بتسمح للمستخدم يعدّل صف نفسه (UPDATE) - لو
   التطبيق أصلاً بيعدّل بيانات البروفايل (تعديل الاسم مثلاً) من غير
   مشاكل، السياسة دي غالباً موجودة بالفعل.
   ------------------------------------------------------------------ */

/** المفتاح المستخدم لتخزين بصمة الجهاز الحالي في localStorage */
const DEVICE_SESSION_STORAGE_KEY = 'ta7t-el-balad-device-session-id';

/** كل قد إيه بنحدّث نبضة الحياة (active_session_updated_at) للجهاز الماسك للمقعد */
const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3 دقايق

/**
 * أقصى مدة بدون نبضة قبل ما نعتبر مقعد جهاز تاني "عالق" (Stale) ونسمح
 * بالدخول العادي من غيره من غير حاجة لزرار الدخول القسري. لازم تكون
 * أكبر بوضوح من HEARTBEAT_INTERVAL_MS عشان تتحمل تقطيع شبكة عادي أو
 * تاب في الخلفية من غير ما نعتبر جهاز شغال فعلاً "عالق" غلط
 */
const STALE_SESSION_THRESHOLD_MS = 10 * 60 * 1000; // 10 دقايق

/** الـ interval id بتاع نبضة الحياة الحالية (لو فيه مستخدم مسجل دخول دلوقتي) */
let heartbeatIntervalId = null;

/**
 * أقصى مدة بننتظر فيها رد (موافقة/رفض) من الجهاز الماسك للجلسة الحالية
 * على طلب دخول جهاز جديد - قرار أمان صريح: لو المهلة خلصت من غير رد،
 * الطلب بيتقفل نهائياً ومفيش أي "دخول قسري" بديل خالص (لا حتى لصاحب
 * الحساب نفسه) - لازم الجهاز الأول يكون فاتح التطبيق فعلياً عشان يوافق.
 */
const LOGIN_APPROVAL_TIMEOUT_MS = 90 * 1000; // 90 ثانية

/** الـ id بتاع طلب الموافقة الحالي اللي الجهاز ده مستني رد عليه (لو موجود) */
let pendingApprovalRequestId = null;

/** قناة Realtime اللي الجهاز الطالب للدخول بيتابع بيها رد على طلبه */
let outgoingApprovalRealtimeChannel = null;

/** الـ timeout id بتاع مهلة انتظار رد الجهاز الأول (شوف LOGIN_APPROVAL_TIMEOUT_MS) */
let approvalTimeoutId = null;

/**
 * قناة Realtime اللي الجهاز الماسك للجلسة الحالية بيتابع بيها أي طلب
 * دخول جديد جاي من جهاز تاني بنفس الحساب (شوف
 * bindIncomingLoginApprovalSubscription تحت)
 */
let incomingApprovalRealtimeChannel = null;

/**
 * بترجع بصمة الجهاز/المتصفح الحالي، وتولّد وحدة جديدة وتخزنها لو
 * ده أول مرة (أو لو localStorage اتمسح). بتفضل ثابتة بعد كده لحد ما
 * حد يمسح بيانات المتصفح يدوياً.
 * @returns {string}
 */
function getOrCreateDeviceSessionId() {
    try {
        let id = window.localStorage.getItem(DEVICE_SESSION_STORAGE_KEY);
        if (!id) {
            id = (window.crypto && typeof window.crypto.randomUUID === 'function')
                ? window.crypto.randomUUID()
                : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            window.localStorage.setItem(DEVICE_SESSION_STORAGE_KEY, id);
        }
        return id;
    } catch (err) {
        // لو localStorage مش متاح لأي سبب (وضع تصفح خاص محظور فيه مثلاً)،
        // بنرجع بصمة مؤقتة لحظة التشغيل عشان الميزة متكسرش الدخول كله
        console.error('تعذر قراءة/تخزين بصمة الجهاز:', err);
        return `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
}

/**
 * "بتكسب" مقعد الجلسة النشطة الوحيد للحساب لصالح الجهاز الحالي، عن
 * طريق كتابة بصمته في profiles.active_session_id. بتتنادى بس عند
 * تسجيل دخول/تسجيل حساب فعلي جديد (مش عند استرجاع جلسة محفوظة).
 * @param {string} userId
 */
async function claimSingleSession(userId) {
    const deviceSessionId = getOrCreateDeviceSessionId();

    const { error } = await supabaseClient
        .from('profiles')
        .update({
            active_session_id: deviceSessionId,
            // بنسجل توقيت الكسب نفسه كأول نبضة حياة - عشان لو الجهاز
            // اتقفل فوراً بعد الدخول من غير أي نبضة تانية، لسه فيه توقيت
            // نقيس منه الـ Stale Threshold (شوف startSingleSessionHeartbeat)
            active_session_updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

    if (error) {
        // فشل الكتابة (مشكلة شبكة/RLS مثلاً) مينفعش يمنع تسجيل الدخول
        // نفسه - بس بنطبع الخطأ عشان يبان وقت التشخيص
        console.error('تعذر تسجيل الجهاز الحالي كجلسة نشطة وحيدة:', error.message);
    }
}

/**
 * بدء "نبضة الحياة" الدورية للجهاز الحالي طول ما فيه مستخدم مسجل دخول
 * عنده - بتحدّث active_session_updated_at كل HEARTBEAT_INTERVAL_MS
 * عشان أي جهاز تاني يحاول يدخل بعدين يعرف إن المقعد ده "لسه حي" ومش
 * عالق. بتلغي أي نبضة سابقة الأول (لو اتنادت أكتر من مرة) عشان
 * مانفضلش شغالين بأكتر من interval في نفس الوقت.
 * @param {string} userId
 */
function startSingleSessionHeartbeat(userId) {
    stopSingleSessionHeartbeat();
    heartbeatIntervalId = window.setInterval(() => {
        updateSingleSessionHeartbeatTimestamp(userId);
    }, HEARTBEAT_INTERVAL_MS);
}

/** إيقاف نبضة الحياة الحالية (لو شغالة) - بتتنادى عند أي تسجيل خروج (يدوي أو إجباري) */
function stopSingleSessionHeartbeat() {
    if (heartbeatIntervalId) {
        window.clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
    }
}

/**
 * تحديث توقيت نبضة الحياة لصف المستخدم - بس لو الجهاز الحالي لسه فعلاً
 * صاحب المقعد (شرط .eq('active_session_id', deviceSessionId))، عشان
 * لو جهاز تاني كسب المقعد بالفعل (زي حالة الطرد اللحظي) ولأي سبب
 * الـ interval بتاع الجهاز القديم لسه شغال، ميجددش بالغلط توقيت مقعد
 * بقى ملك جهاز تاني
 * @param {string} userId
 */
async function updateSingleSessionHeartbeatTimestamp(userId) {
    const deviceSessionId = getOrCreateDeviceSessionId();

    const { error } = await supabaseClient
        .from('profiles')
        .update({ active_session_updated_at: new Date().toISOString() })
        .eq('id', userId)
        .eq('active_session_id', deviceSessionId);

    if (error) {
        console.error('تعذر تحديث نبضة الجلسة النشطة:', error.message);
    }
}

/**
 * بتفضّي مقعد الجلسة النشطة (active_session_id = null) عشان أي جهاز
 * تاني يقدر يدخل بعد كده براحته. بتتنادى بس لما المستخدم يعمل تسجيل
 * خروج يدوي (signOut) من نفس الجهاز الماسك للمقعد - لو متعمليناهاش،
 * الحساب كان هيفضل "مقفول" على بصمة الجهاز القديم للأبد حتى لو
 * صاحبه سجّل خروج بنفسه فعلاً، ومحدش هيقدر يدخل من جهاز تاني تاني.
 * @param {string} userId
 */
async function releaseSingleSessionClaim(userId) {
    const { error } = await supabaseClient
        .from('profiles')
        .update({ active_session_id: null })
        .eq('id', userId);

    if (error) {
        console.error('تعذر تحرير مقعد الجلسة النشطة:', error.message);
    }
}

/**
 * بتتحقق - *قبل* ما نكسب مقعد الجلسة النشطة فعلياً - هل مسموح للجهاز
 * الحالي يدخل ولا الحساب "مقفول" بالفعل على جهاز تاني (سياسة "أول
 * جهاز بيفضل شغال"). بتتنادى بس عند تسجيل دخول فعلي جديد (SIGNED_IN)،
 * قبل claimSingleSession مباشرة.
 * @param {string} userId
 * @returns {Promise<boolean>} true لو مسموح نكمل ونكسب المقعد (فاضي
 * أصلاً، أو ده نفس الجهاز الماسك له بالفعل، أو تعذر التأكد بسبب خطأ
 * شبكة - بنفضّل نسمح بدل ما نرفض غلط)
 */
async function checkSingleSessionSlotBeforeSignIn(userId) {
    const deviceSessionId = getOrCreateDeviceSessionId();

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('active_session_id, active_session_updated_at')
        .eq('id', userId)
        .maybeSingle();

    if (error) {
        console.error('تعذر التحقق من مقعد الجلسة النشطة قبل الدخول:', error.message);
        return true;
    }

    if (!data || !data.active_session_id) return true;
    if (data.active_session_id === deviceSessionId) return true;

    // المقعد ماسكه جهاز تاني - لو مفيش نبضة مسجلة أصلاً، نعتبره عالق ونسمح بالدخول
    // عشان الحساب ما يفضلش مقفول للأبد لو توقيت النبضة مكنش مسجل
    if (!data.active_session_updated_at) return true;

    // قبل ما نرفض، نتأكد هل لسه "حي" فعلاً (نبضة حديثة) ولا عالق
    const lastHeartbeatAt = new Date(data.active_session_updated_at).getTime();
    if (Number.isFinite(lastHeartbeatAt) && Date.now() - lastHeartbeatAt > STALE_SESSION_THRESHOLD_MS) {
        return true;
    }

    return false;
}

/**
 * كانت بتتحقق - عند استرجاع جلسة محفوظة قديمة (INITIAL_SESSION) - إن
 * الجهاز الحالي لسه هو صاحب المقعد النشط، وبتعمل تسجيل خروج صامت (من
 * غير أي رسالة توضيح) لو بصمة الجهاز اتغيّرت لأي سبب (زي متصفح بيمسح
 * localStorage تلقائياً، أو استخدام PWA وبراوزر عادي بالتبادل على نفس
 * الجهاز). ده كان بيسبب "تسجيل خروج تلقائي" مزعج ومحيّر للمستخدم لما
 * يفتح التطبيق تاني بعد فترة، رغم إنه هو نفسه لسه مسجل دخول فعلياً من
 * غير حد تاني ياخد مكانه - اتشالت بناءً على طلب صريح.
 *
 * الحماية الأساسية دلوقتي بقت بس: (1) checkSingleSessionSlotBeforeSignIn
 * بيمنع أي تسجيل دخول *فعلي* جديد من جهاز تاني طول ما الحساب مقفول على
 * جهاز حالي، و(2) bindProfileSessionRealtimeSubscription اللي بتطرد
 * الجهاز الحالي *لحظياً* (مع رسالة واضحة) بس لو حد تاني بجد سجّل دخول
 * وهو فاتح التطبيق فعلياً وقتها - مش مجرد إعادة فتح عادية.
 */

/**
 * الاشتراك في تحديثات Realtime الحية على صف profiles بتاع المستخدم
 * الحالي بس، عشان نكتشف فوراً لو جهاز تاني سجّل دخول بنفس الحساب
 * وطرد جلستنا الحالية. بنلغي أي اشتراك قديم الأول (لو اتنادت أكتر
 * من مرة) عشان مانفضلش مشتركين مرتين.
 * @param {string} userId
 */
function bindProfileSessionRealtimeSubscription(userId) {
    unbindProfileSessionRealtimeSubscription();

    profileSessionRealtimeChannel = supabaseClient
        .channel(`profile-session-${userId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'profiles',
                filter: `id=eq.${userId}`,
            },
            (payload) => {
                try {
                    // (المرحلة 2) لو الأدمن حظر الحساب ده دلوقتي وهو شغال
                    // بالفعل على الجهاز ده، بنطرده فوراً - قبل حتى فحص
                    // active_session_id تحت، عشان الحظر ياخد أولوية
                    if (payload.new && payload.new.is_blocked) {
                        const reason = payload.new.blocked_reason;
                        dispatchToast(
                            reason ? `حسابك موقوف مؤقتاً: ${reason}` : 'حسابك موقوف مؤقتاً، تواصل مع الدعم الفني',
                            'error',
                        );
                        forceSignOutDueToOtherSession();
                        return;
                    }

                    const deviceSessionId = getOrCreateDeviceSessionId();
                    const newActiveSessionId = payload.new && payload.new.active_session_id;

                    if (newActiveSessionId && newActiveSessionId !== deviceSessionId) {
                        dispatchToast('تم تسجيل الدخول بحسابك من جهاز تاني، اتسجل خروجك من هنا', 'info');
                        forceSignOutDueToOtherSession();
                    }
                } catch (err) {
                    console.error('خطأ أثناء معالجة تحديث الجلسة النشطة لحظياً:', err);
                }
            },
        )
        .subscribe((status, err) => {
            if (err) {
                console.error('خطأ في اشتراك Realtime بتاع الجلسة النشطة:', err.message || err);
            }
        });
}

/** إلغاء الاشتراك الحالي في تحديثات الجلسة النشطة (لو موجود) */
function unbindProfileSessionRealtimeSubscription() {
    if (profileSessionRealtimeChannel) {
        supabaseClient.removeChannel(profileSessionRealtimeChannel);
        profileSessionRealtimeChannel = null;
    }
}

/**
 * تسجيل خروج إجباري لسبب مش المستخدم نفسه اللي طلبه - إما جهاز تاني
 * سجّل دخول بنفس الحساب، أو (المرحلة 2) الأدمن حظر الحساب وهو شغال
 * بالفعل (شوف bindProfileSessionRealtimeSubscription فوق للحالتين).
 * الرسالة المناسبة للسبب بتتبعت كـ toast قبل ما الدالة دي تتنادى.
 */
async function forceSignOutDueToOtherSession() {
    unbindProfileSessionRealtimeSubscription();
    unbindIncomingLoginApprovalSubscription();
    stopSingleSessionHeartbeat();
    // مهم جداً: scope: 'local' هنا عشان نمسح جلسة الجهاز الخاسر (ده) بس.
    // من غيرها، Supabase بتستخدم scope: 'global' افتراضياً واللي بتلغي
    // الـ refresh token بتاع الحساب بالكامل على السيرفر لكل الأجهزة -
    // يعني كانت بتطرد الجهاز "الفايز" (اللي لسه بصمته مسجلة في
    // active_session_id) هو كمان أول ما يحاول يجدد التوكن بتاعه (زي عند
    // أي Refresh للصفحة)، وده بالظبط اللي كان بيسيب الحساب "مش متسجل ف
    // أي مكان" بعد فترة قصيرة من نجاح تسجيل الدخول من الجهاز التاني.
    await supabaseClient.auth.signOut({ scope: 'local' });
    currentUser = null;
    document.dispatchEvent(new CustomEvent('auth:signed-out', { detail: {} }));
    // بدل ما نفتح authModal كمودال منبثق فوق التطبيق (Blur خلفه)، بنودّي
    // المستخدم لنفس صفحة اختيار الدخول/التسجيل الكاملة اللي شافها أول
    // مرة (نفس منطق signOut() العادية - شوف showAuthGate في js/onboarding.js)
    showAuthGate();
}

/**
 * تُستدعى مرة واحدة لما نتأكد إن فيه مستخدم مسجّل دخول (Session موجودة).
 * بتتحقق من وجود بروفايل، وبتطلق حدث "auth:signed-in" بكل التفاصيل
 * عشان باقي التطبيق (app.js) يقرر يفتح موديل الإعداد الأول ولا يكمل
 * على طول لصفحة البروفايل والداشبورد.
 * @param {import('@supabase/supabase-js').Session} session
 * @param {string} [event] - نوع الحدث اللي جاي من onAuthStateChange
 * ('SIGNED_IN' لتسجيل دخول فعلي جديد، أو 'INITIAL_SESSION' لاسترجاع
 * جلسة محفوظة من زيارة سابقة) - بيحدد سلوك "الجلسة الواحدة" تحت (شوف
 * checkSingleSessionSlotBeforeSignIn، بتتنادى بس مع SIGNED_IN)
 */
async function handleSignedInSession(session, event) {
    const user = session.user;

    if (event === 'SIGNED_IN') {
        // سياسة "أول جهاز بيفضل شغال": لو فيه جهاز تاني ماسك المقعد
        // بالفعل، منكملش دخول على طول من هنا - قبل ما نلمس المودال أو
        // currentUser أو نكسب أي حاجة - ونسيب الجهاز الأول من غير أي
        // تأثير عليه خالص لحد ما يوافق فعلياً (شوف
        // handleSessionConflictViaApproval تحت)
        const allowedToSignIn = await checkSingleSessionSlotBeforeSignIn(user.id);
        if (!allowedToSignIn) {
            await handleSessionConflictViaApproval(user, session);
            return;
        }
    }

    await finalizeSignedInSession(user, session, event);
}

/**
 * الجزء المشترك اللي بيتنفذ بعد ما نتأكد إن الجهاز ده مسموحله يكسب/يفضل
 * ماسك الجلسة - سواء جاي من مسار الدخول العادي (مفيش تعارض أصلاً، أو
 * INITIAL_SESSION) أو من مسار موافقة الجهاز الآخر بعد ما يوافق فعلياً
 * (شوف completeApprovedSignIn تحت).
 * @param {import('@supabase/supabase-js').User} user
 * @param {import('@supabase/supabase-js').Session} session
 * @param {string} event
 */
async function finalizeSignedInSession(user, session, event) {
    // فحص الحظر أول حاجة، قبل ما نمنح أي وصول فعلي (مودال/بروفايل/
    // heartbeat..إلخ) - بيغطي الحالتين مع بعض: تسجيل دخول جديد
    // (SIGNED_IN) واسترجاع جلسة قديمة محفوظة (INITIAL_SESSION)، لأن
    // الدالة دي هي نقطة الالتقاء الوحيدة للحالتين
    const blockStatus = await checkIfUserIsBlocked(user.id);
    if (blockStatus && blockStatus.isBlocked) {
        await rejectSignedInSessionDueToBlock(blockStatus.reason);
        return;
    }

    hideAuthModal();
    hideAuthApprovalWaitingState();
    currentUser = user;

    // (إصلاح - باج حقيقي): أي دخول/تسجيل حقيقي ينجح لازم يمسح فلاج
    // "استمرار وضع الزائر" (شوف تعليق GUEST_MODE_STORAGE_KEY فوق) -
    // وإلا لو مستخدم دخل كزائر قبل كده في نفس المتصفح وبعدين سجّل حساب
    // فعلي، أي Refresh لاحق ممكن يفضّل يعامله كزائر غلط حتى بعد نجاح
    // تسجيل الدخول، لأن الفلاج القديم لسه محفوظ في localStorage
    clearGuestModeActive();

    if (event === 'SIGNED_IN') {
        // كسب مقعد الجلسة النشطة الوحيد لصالح الجهاز ده - مأمون دلوقتي
        // لأن الفحص فوق ضمن إنه إما فاضي أصلاً، ماسكه نفس الجهاز ده،
        // عالق (Stale)، أو إن الجهاز الأول وافق صراحةً على الطلب
        await claimSingleSession(user.id);
    }

    // نبضة الحياة لازم تشتغل مهما كان نوع الحدث (SIGNED_IN أو
    // INITIAL_SESSION) طول ما فيه مستخدم مسجل دخول فعلياً على الجهاز ده
    startSingleSessionHeartbeat(user.id);

    bindProfileSessionRealtimeSubscription(user.id);
    // اشتراك جديد: عشان الجهاز ده (بصفته الماسك الحالي للجلسة) يستقبل
    // أي طلب دخول جديد من جهاز تاني بنفس الحساب ويقدر يوافق/يرفض عليه
    bindIncomingLoginApprovalSubscription(user.id);

    const hasProfile = await checkIfProfileExists(user.id);

    document.dispatchEvent(new CustomEvent('auth:signed-in', {
        detail: { user, session, hasProfile },
    }));

    // app.js بيستمع لحدث "auth:login" (مش "auth:signed-in") عشان يحدّث
    // شاشة البروفايل بعد الدخول - بنطلقه كمان هنا عشان الملفين يتوافقوا
    // من غير ما نلغي "auth:signed-in" اللي ملفات تانية (زي profiles.js)
    // ممكن تكون مستمعة له.
    document.dispatchEvent(new CustomEvent('auth:login', {
        detail: { user, session, hasProfile },
    }));
}

/* ==================================================================
   موافقة تسجيل الدخول من جهاز تاني (Login Approval)
   ------------------------------------------------------------------
   بتتنادى بس لما checkSingleSessionSlotBeforeSignIn يرفض (المقعد ماسكه
   جهاز تاني و"حي" فعلاً). الجهاز ده (الطالب) لسه معاه Session صحيحة من
   Supabase Auth في اللحظة دي (الباسورد اتقبل بالفعل) - فمنعملوش
   signOut فوراً؛ بنسيبه مسجل دخول فعلياً في الخلفية طول ما مستني رد،
   عشان يقدر يستخدم Realtime أصلاً (auth.uid() لازم يكون موجود عشان
   الـ RLS تسمح له يعمل insert/select على login_approval_requests).
   ================================================================== */

/**
 * إنشاء صف طلب موافقة جديد في login_approval_requests
 * @param {string} userId
 * @param {string} deviceSessionId
 * @returns {Promise<string|null>} id الطلب، أو null لو فشل الإنشاء
 */
async function createLoginApprovalRequest(userId, deviceSessionId) {
    // إنهاء أي طلبات موافقة سابقة معلقة لنفس المستخدم قبل إنشاء طلب جديد
    try {
        await supabaseClient
            .from('login_approval_requests')
            .update({ status: 'expired', responded_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('status', 'pending');
    } catch (cleanupErr) {
        console.warn('تعذر تنظيف طلبات الموافقة السابقة:', cleanupErr?.message);
    }

    const { data, error } = await supabaseClient
        .from('login_approval_requests')
        .insert({ user_id: userId, requesting_device_id: deviceSessionId, status: 'pending' })
        .select('id')
        .single();

    if (error) {
        console.error('تعذر إنشاء طلب الموافقة على تسجيل الدخول:', error.message);
        return null;
    }

    return data.id;
}

/**
 * تفتح (أو تعيد فتح) قناة `login-approval-outgoing-*` اللي الجهاز الطالب
 * بيتابع بيها رد الجهاز الأول على طلب معين. اتفصلت في دالة مستقلة عشان
 * تتنادى تاني من نفس مكان الاشتراك الأول (handleSessionConflictViaApproval)
 * لو القناة اتقفلت لأي سبب أثناء فترة الانتظار (شوف تعليق "إصلاح - باج
 * حقيقي" تحت) - من غير ما نكرر نفس الكود مرتين.
 * @param {import('@supabase/supabase-js').User} user
 * @param {import('@supabase/supabase-js').Session} session
 * @param {string} requestId
 */
function subscribeOutgoingLoginApprovalChannel(user, session, requestId) {
    if (outgoingApprovalRealtimeChannel) {
        supabaseClient.removeChannel(outgoingApprovalRealtimeChannel);
    }
    outgoingApprovalRealtimeChannel = supabaseClient
        .channel(`login-approval-outgoing-${requestId}`)
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'login_approval_requests',
                filter: `id=eq.${requestId}`,
            },
            (payload) => {
                const status = payload.new && payload.new.status;
                if (status === 'approved') {
                    clearApprovalWaitState();
                    completeApprovedSignIn(user, session);
                } else if (status === 'rejected') {
                    clearApprovalWaitState();
                    rejectApprovalWait('تم رفض محاولة الدخول من الجهاز اللي عليه الحساب دلوقتي');
                }
            },
        )
        .subscribe((status, err) => {
            if (err) {
                console.error('خطأ في اشتراك متابعة طلب الموافقة:', err.message || err);
            }

            // لو القناة اتقفلت/فشلت أثناء فترة الانتظار (٩٠ ثانية) - بسبب
            // انقطاع شبكة أو إعادة اتصال WebSocket داخلية بتاعة Supabase -
            // الجهاز الطالب ممكن يفوّته رد الموافقة/الرفض ويستنى لحد ما
            // المهلة تخلص من غير داعي، حتى لو التاني رد فعلاً في نفس
            // اللحظة. بنحاول نعيد فتحها طول ما لسه مستنيين رد نفس الطلب ده
            // بالظبط (يعني مفيش تايم آوت حصل ولا المستخدم لغى الانتظار في
            // الأثناء)، ونوضح للمستخدم إن فيه إعادة محاولة اتصال شغالة.
            if (
                (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
                && pendingApprovalRequestId === requestId
            ) {
                showApprovalReconnectingHint();
                window.setTimeout(() => {
                    if (pendingApprovalRequestId === requestId) {
                        subscribeOutgoingLoginApprovalChannel(user, session, requestId);
                    }
                }, 3000);
            } else if (status === 'SUBSCRIBED') {
                hideApprovalReconnectingHint();
            }
        });
}

/**
 * بداية مسار "استنى موافقة الجهاز التاني" - بتتنادى بدل الرفض المباشر
 * القديم. بتنشئ الطلب، تعرض شاشة الانتظار جوه authModal، وتشترك في
 * Realtime لمتابعة رد الجهاز الأول، مع مهلة أقصاها LOGIN_APPROVAL_TIMEOUT_MS.
 * @param {import('@supabase/supabase-js').User} user
 * @param {import('@supabase/supabase-js').Session} session
 */
async function handleSessionConflictViaApproval(user, session) {
    const deviceSessionId = getOrCreateDeviceSessionId();
    const requestId = await createLoginApprovalRequest(user.id, deviceSessionId);

    if (!requestId) {
        // فشل إنشاء الطلب نفسه (شبكة/RLS) - منسيبش المستخدم مستني للأبد
        // من غير أي تفسير، بنرفض بوضوح ونسيبه يحاول تاني
        await rejectApprovalWait('تعذر إرسال طلب الموافقة، تأكد من الاتصال وجرب تاني');
        return;
    }

    pendingApprovalRequestId = requestId;
    showAuthApprovalWaitingState();

    subscribeOutgoingLoginApprovalChannel(user, session, requestId);

    approvalTimeoutId = window.setTimeout(() => {
        // بنحدّث الصف لـ expired بشكل Best-effort (شرط .eq('status','pending')
        // عشان لو رد وصل في نفس اللحظة بالظبط منكتبش فوق رد حقيقي) - مش
        // لازم ننتظر نتيجتها قبل ما نكمل رفض الدخول على الجهاز ده
        supabaseClient
            .from('login_approval_requests')
            .update({ status: 'expired', responded_at: new Date().toISOString() })
            .eq('id', requestId)
            .eq('status', 'pending')
            .then(({ error }) => {
                if (error) console.error('تعذر تحديث حالة انتهاء مهلة طلب الموافقة:', error.message);
            });

        clearApprovalWaitState();
        rejectApprovalWait('محدش رد على طلب الدخول خلال المهلة - جرب تاني لما يكون الجهاز التاني فاتح التطبيق');
    }, LOGIN_APPROVAL_TIMEOUT_MS);
}

/** تنظيف حالة الانتظار (الـ timeout والاشتراك) من غير ما تلمس الواجهة أو الجلسة */
function clearApprovalWaitState() {
    if (approvalTimeoutId) {
        window.clearTimeout(approvalTimeoutId);
        approvalTimeoutId = null;
    }
    if (outgoingApprovalRealtimeChannel) {
        supabaseClient.removeChannel(outgoingApprovalRealtimeChannel);
        outgoingApprovalRealtimeChannel = null;
    }
    pendingApprovalRequestId = null;
}

/**
 * رفض/إلغاء محاولة الدخول الحالية بعد فشل/رفض/انتهاء مهلة طلب الموافقة
 * (أو ضغط المستخدم "إلغاء" بنفسه - شوف cancelApprovalWait تحت). بتعمل
 * تسجيل خروج محلي لأن الجهاز ده معاه Session صحيحة من وقت ما الباسورد
 * اتقبل (شوف تعليق قسم "موافقة تسجيل الدخول" فوق).
 * @param {string|null} message - null لو المستخدم هو اللي لغى بنفسه (مفيش رسالة خطأ)
 */
async function rejectApprovalWait(message) {
    isHandlingSessionConflictRejection = true;
    try {
        await supabaseClient.auth.signOut({ scope: 'local' });
        currentUser = null;
        hideAuthApprovalWaitingState();
        if (message) {
            showAuthError(message);
            dispatchToast(message, 'error');
        }
        showAuthModal();
    } finally {
        isHandlingSessionConflictRejection = false;
    }
}

/** بتتنادى لما المستخدم يضغط "إلغاء" بنفسه وهو مستني رد (شوف bindAuthModalEvents) */
async function cancelApprovalWait() {
    clearApprovalWaitState();
    await rejectApprovalWait(null);
}

/**
 * الجهاز الأول وافق فعلياً على الطلب - بنكمل مسار الدخول العادي بالظبط
 * (كسب المقعد، نبضة الحياة، الاشتراكات، إطلاق الأحداث) من غير ما نمر
 * تاني على checkSingleSessionSlotBeforeSignIn (اتوافق عليه صراحةً)
 * @param {import('@supabase/supabase-js').User} user
 * @param {import('@supabase/supabase-js').Session} session
 */
async function completeApprovedSignIn(user, session) {
    await finalizeSignedInSession(user, session, 'SIGNED_IN');
}

/** إظهار شاشة "بنستنى موافقة الجهاز التاني" جوه authModal بدل الفورم */
function showAuthApprovalWaitingState() {
    hideAuthError();
    document.getElementById('emailAuthForm')?.classList.add('hidden');
    document.getElementById('authApprovalWaitingView')?.classList.remove('hidden');
}

/** إخفاء شاشة الانتظار ورجوع الفورم لظهوره الطبيعي - آمنة تتنادى حتى لو مكانتش ظاهرة */
function hideAuthApprovalWaitingState() {
    document.getElementById('emailAuthForm')?.classList.remove('hidden');
    document.getElementById('authApprovalWaitingView')?.classList.add('hidden');
    hideApprovalReconnectingHint();
}

/**
 * إظهار سطر صغير جوه شاشة الانتظار يوضح إن الاتصال انقطع لحظياً وبيحاول
 * يرجع تاني - بدل ما المستخدم يفضل شايف نفس شاشة الانتظار الثابتة من
 * غير أي تفسير لو الشبكة اترجرجت. عنصر `#authApprovalReconnectingHint`
 * لازم يتضاف جوه `#authApprovalWaitingView` في index.html (شوف
 * subscribeOutgoingLoginApprovalChannel فوق و bindIncomingLoginApprovalSubscription
 * تحت - نفس الدالة مستخدمة من الاتنين).
 */
function showApprovalReconnectingHint() {
    document.getElementById('authApprovalReconnectingHint')?.classList.remove('hidden');
}

/** إخفاء سطر "بيحاول يعيد الاتصال" (لو ظاهر) - آمنة تتنادى حتى لو مكانش ظاهر */
function hideApprovalReconnectingHint() {
    document.getElementById('authApprovalReconnectingHint')?.classList.add('hidden');
}

/**
 * الاشتراك في تحديثات Realtime عشان الجهاز الحالي (الماسك للجلسة) يعرف
 * فوراً لو جهاز تاني بعت طلب دخول جديد بنفس الحساب، ويعرض له مودال
 * الموافقة/الرفض (showIncomingLoginApprovalModal)
 * @param {string} userId
 */
function bindIncomingLoginApprovalSubscription(userId) {
    unbindIncomingLoginApprovalSubscription();
    const deviceSessionId = getOrCreateDeviceSessionId();

    incomingApprovalRealtimeChannel = supabaseClient
        .channel(`login-approval-incoming-${userId}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'login_approval_requests',
                filter: `user_id=eq.${userId}`,
            },
            (payload) => {
                const request = payload.new;
                if (!request || request.status !== 'pending') return;
                // احتياط: لو بطريقة ما الطلب جاي من نفس بصمة الجهاز ده،
                // متجاهلينه (مش المفروض يحصل عمليًا أصلاً)
                if (request.requesting_device_id === deviceSessionId) return;
                showIncomingLoginApprovalModal(request);
            },
        )
        .subscribe((status, err) => {
            if (err) {
                console.error('خطأ في اشتراك طلبات الدخول الواردة:', err.message || err);
            }

            // القناة لو اتقفلت (CLOSED) أو حصل فيها خطأ (CHANNEL_ERROR/
            // TIMED_OUT) - سواء لانقطاع شبكة، أو إعادة اتصال الـ WebSocket
            // الداخلية بتاعة Supabase - بتفضل واقفة للأبد من غير ما حد
            // يحاول يفتحها تاني، فأي طلب دخول جديد بعد كده مايوصلش خالص
            // للجهاز الماسك للجلسة، من غير أي رسالة خطأ واضحة تلفت النظر.
            // هنا بنجدول إعادة محاولة فتحها تاني بعد فترة قصيرة، طول ما
            // المستخدم لسه مسجل دخول فعلاً على الجهاز ده (لو عمل تسجيل
            // خروج، currentUser بيبقى null ومفيش داعي نعيد المحاولة أصلاً).
            if (
                (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
                && currentUser
            ) {
                scheduleIncomingLoginApprovalResubscribe(userId);
            }
        });
}

/** الـ timeout id بتاع محاولة إعادة فتح قناة طلبات الدخول الواردة (لو مجدولة) */
let incomingApprovalResubscribeTimeoutId = null;

/**
 * تجدول إعادة محاولة فتح قناة `login-approval-incoming-*` بعد فترة قصيرة،
 * لو اتقفلت لأي سبب (شوف تعليق "إصلاح - باج حقيقي" فوق في
 * bindIncomingLoginApprovalSubscription). بتتجاهل النداء لو فيه محاولة
 * مجدولة بالفعل عشان منعملش أكتر من setTimeout في نفس الوقت.
 * @param {string} userId
 */
function scheduleIncomingLoginApprovalResubscribe(userId) {
    if (incomingApprovalResubscribeTimeoutId) return;
    incomingApprovalResubscribeTimeoutId = window.setTimeout(() => {
        incomingApprovalResubscribeTimeoutId = null;
        if (currentUser) {
            bindIncomingLoginApprovalSubscription(userId);
        }
    }, 3000);
}

/** إلغاء اشتراك طلبات الدخول الواردة (لو موجود)، وأي محاولة إعادة اتصال مجدولة */
function unbindIncomingLoginApprovalSubscription() {
    if (incomingApprovalResubscribeTimeoutId) {
        window.clearTimeout(incomingApprovalResubscribeTimeoutId);
        incomingApprovalResubscribeTimeoutId = null;
    }
    if (incomingApprovalRealtimeChannel) {
        supabaseClient.removeChannel(incomingApprovalRealtimeChannel);
        incomingApprovalRealtimeChannel = null;
    }
}

/**
 * عرض مودال "فيه حد بيحاول يدخل حسابك من جهاز تاني" على الجهاز الماسك
 * للجلسة الحالية - بيتفتح فوق أي حاجة تانية شغال فيها المستخدم وقتها
 * (مش بس جوه authModal، لأن ده أصلاً مسجل دخول ومستخدم التطبيق عادي)
 * @param {{id: string}} request
 */
function showIncomingLoginApprovalModal(request) {
    const modal = document.getElementById('loginApprovalIncomingModal');
    if (!modal) return;

    modal.dataset.requestId = request.id;
    modal.classList.remove('hidden');
    pushModalState(hideIncomingLoginApprovalModal);
}

/** الإخفاء الخام لمودال طلب الدخول الوارد - استخدم closeModal() بدل ما تناديها مباشرة لو ممكن */
function hideIncomingLoginApprovalModal() {
    const modal = document.getElementById('loginApprovalIncomingModal');
    if (!modal) return;
    modal.classList.add('hidden');
    delete modal.dataset.requestId;
}

/**
 * ترسل رد الجهاز الحالي (موافقة/رفض) على طلب الدخول الوارد الظاهر حالياً
 * @param {'approved'|'rejected'} decision
 */
async function respondToIncomingLoginApproval(decision) {
    const modal = document.getElementById('loginApprovalIncomingModal');
    const requestId = modal?.dataset.requestId;
    if (!requestId) return;

    const { error } = await supabaseClient
        .from('login_approval_requests')
        .update({ status: decision, responded_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'pending'); // احتياط: منكتبش فوق رد سابق أو حالة expired

    if (error) {
        console.error('تعذر تسجيل رد الموافقة على تسجيل الدخول:', error.message);
        dispatchToast('حصلت مشكلة في إرسال ردك، جرب تاني', 'error');
        return;
    }

    closeModal();

    if (decision === 'approved') {
        // مفيش داعي لأي فعل تاني هنا - الجهاز التاني هيكسب المقعد بنفسه
        // (claimSingleSession) وده هيطرد الجهاز ده لحظياً بنفس آلية
        // bindProfileSessionRealtimeSubscription العادية خلال ثواني
        dispatchToast('تمام، الجهاز التاني هيكمل دخوله دلوقتي', 'info');
    } else {
        dispatchToast('تم رفض محاولة الدخول من الجهاز التاني', 'success');
    }
}

/**
 * ربط مستمع تغيّر حالة المصادقة (Auth State Listener). ده قلب نظام
 * الجلسات: بيشتغل تلقائياً أول ما الصفحة تفتح (لو فيه جلسة محفوظة)،
 * وكمان بعد كل تسجيل دخول أو خروج.
 */
function listenToAuthStateChanges() {
    supabaseClient.auth.onAuthStateChange((event, session) => {
        // 'INITIAL_SESSION' بيتطلق مرة واحدة أول ما Supabase تخلّص قراءة
        // أي جلسة محفوظة من localStorage عند فتح التطبيق (سواء لقت جلسة
        // ولا لأ). 'SIGNED_IN' بيتطلق بعد كده بس مع تسجيل دخول فعلي جديد.
        // كنا بنتعامل مع 'SIGNED_IN' بس، فلو المستخدم فاتح جلسة محفوظة
        // من قبل (يعني مسجل دخول أصلاً)، الكود مايتنفذش خالص: currentUser
        // فاضل null، 'auth:login' ما بيتطلقش، وnotifications.js (وأي كود
        // تاني مستني هوية المستخدم) بيفضل شايف "مش مسجل دخول" غلط رغم إن
        // فيه جلسة صحيحة فعلاً محفوظة - وده كان سبب ظهور "سجّل دخولك
        // الأول" في لوحة الإشعارات رغم إن المستخدم مسجل دخول بالفعل.
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
            handleSignedInSession(session, event);
        }

        if (event === 'SIGNED_OUT') {
            unbindProfileSessionRealtimeSubscription();
            unbindIncomingLoginApprovalSubscription();
            stopSingleSessionHeartbeat();

            // استثناء مهم: لو الـ SIGNED_OUT ده جاي من الـ signOut المحلي
            // الدفاعي جوه handleSignedInSession (رفض الدخول لوجود جلسة
            // نشطة على جهاز تاني)، مانناديش showAuthGate() خالص - هي
            // بتحط "hidden" على #onbAuthFormDock (حاوية المودال المدموج
            // الأب) عشان ترجّع المستخدم لشاشة الاختيار، وده كان بيسيب
            // المودال (بعد ما handleSignedInSession يرجّعه ظاهر برسالة
            // الخطأ) عالق جوه حاوية مخفية = شاشة فاضية من غير فورم ولا
            // رسالة (شوف تعليق isHandlingSessionConflictRejection فوق).
            // handleSignedInSession بيتكفل بواجهته بنفسه في الحالة دي.
            if (isHandlingSessionConflictRejection) return;

            // بدل ما نفتح authModal كمودال منبثق، بنودّي المستخدم لصفحة
            // اختيار الدخول/التسجيل الكاملة (شوف showAuthGate تحت) - لو
            // signOut() هي اللي طلقت الحدث ده، هتكون نادت showAuthGate()
            // بنفسها بالفعل والحارس onb-gate-active جوها هيمنع أي تكرار
            showAuthGate();
        }
    });
}

/**
 * التحقق من وجود جلسة محفوظة أول ما التطبيق يفتح (Session Persistence).
 * لو موجودة، هتتبع مباشرة من خلال onAuthStateChange (اللي بيطلق
 * INITIAL_SESSION/SIGNED_IN تلقائياً)، ولو مش موجودة، بنعرض صفحة
 * اختيار الدخول/التسجيل الكاملة (showAuthGate) بدل أي مودال منبثق.
 */
export async function checkExistingSession() {
    try {
        const { data, error } = await supabaseClient.auth.getSession();

        if (error) {
            console.error('خطأ في قراءة الجلسة الحالية:', error.message);
            dispatchConfirmedSignedOut();
            showAuthGate();
            return;
        }

        if (!data.session) {
            // (إصلاح - باج "فلاش فتحة الزائر لمستخدم مسجل دخول فعليًا"):
            // هنا هي أول لحظة "مؤكدة" فعليًا (من سيرفر/تخزين Supabase
            // نفسه، مش من قراءة متفائلة) إن مفيش جلسة خالص - فبنطلق
            // dispatchConfirmedSignedOut() هنا بالتحديد (مش في initApp()
            // بشكل فوري زي قبل كده) عشان app.js يقدر يطبّق قيود وضع
            // الزائر (applyGuestModeRestrictions(false) + شريط الزائر)
            // بس لما نتأكد فعلاً، مش بناءً على restoreSession() المتفائلة
            // اللي ممكن ترجع null للحظة حتى لو فيه جلسة حقيقية شغالة
            // (شوف تعليق restoreSession فوق) - وده بالظبط كان بيسبب ظهور
            // شريط "بتتصفح كزائر"/قفل ميزات العضوية للحظة عند كل Refresh
            // لمستخدم مسجل دخول، قبل ما auth:login الحقيقي يرجّع كل حاجة
            // لوضعها الصح.
            dispatchConfirmedSignedOut();

            // (إصلاح - باج حقيقي): "مفيش Session محفوظة" هو نفسه حال
            // الزائر دايمًا (هو مالوش حساب أصلاً) - فقبل الاستثناء ده،
            // checkExistingSession() كانت بتفتح showAuthGate() في كل مرة
            // (بما فيها أي Refresh) حتى لو المستخدم كان قرر بوعي إنه
            // يكمّل كزائر من قبل، فيرجع يتقفل على صفحة التسجيل من غير
            // أي سبب واضح رغم إن وضع الزائر نفسه (window.isGuestMode)
            // كان بيتفعّل صح تحتها. لو المستخدم مسجّل قراره ده فعلاً
            // (isGuestModeActive - شوف تعليقها فوق)، نسيبه في وضع الزائر
            // ومنرجعوش لصفحة الدخول قسرًا - مستمع auth:confirmed-signed-out
            // في js/app.js هو اللي هيفعّل وضع الزائر بصريًا (الشريط
            // + القيود) زي ما بيحصل في أي تحميل تاني
            if (isGuestModeActive()) {
                return;
            }

            // بدل ما نفتح authModal كمودال منبثق فوق خلفية معتّمة (كان ده
            // سبب ظهور "صفحة دخول" منفصلة الشكل عن باقي التطبيق) - بنودّي
            // أي مستخدم من غير جلسة محفوظة لنفس صفحة اختيار الدخول/التسجيل
            // الكاملة اللي بتظهر بعد الـ 7 سلايدات (شوف showAuthGate في
            // js/onboarding.js)
            showAuthGate();
        }
        // في حالة وجود session فعلاً، onAuthStateChange هيتكفل بيها
        // ويطلق handleSignedInSession تلقائياً (اللي بيخفي المودال).
    } catch (err) {
        // أي خطأ غير متوقع (مشكلة شبكة، supabaseClient مش متظبط..إلخ)
        // مينفعش يمنع ظهور واجهة تسجيل الدخول - أهم حاجة المستخدم
        // يشوف طريقة يدخل بيها بدل ما يفضل التطبيق واقف على الفاضي.
        console.error('خطأ غير متوقع أثناء التحقق من الجلسة:', err);
        dispatchConfirmedSignedOut();
        showAuthGate();
    }
}

/**
 * إشعار عام (Custom Event) بيتطلق مرة واحدة بس لما نتأكد فعليًا (من
 * checkExistingSession أعلاه - يعني من تعامل حقيقي مع Supabase، مش من
 * قراءة متفائلة سريعة) إن مفيش جلسة مستخدم خالص. js/app.js بيسمعه عشان
 * يطبّق قيود وضع الزائر (applyGuestModeRestrictions(false)) بس في
 * اللحظة دي - مش فورًا وقت initApp() بناءً على restoreSession() -
 * عشان مستخدم مسجل دخول فعليًا ميشوفش شريط/قيود "زائر" تفلاش للحظة
 * قبل ما تتصحح (شوف تعليق checkExistingSession فوق للتفاصيل الكاملة).
 */
function dispatchConfirmedSignedOut() {
    document.dispatchEvent(new CustomEvent('auth:confirmed-signed-out', { detail: {} }));
}



/**
 * إرسال إشعار (Toast) خفيف للمستخدم عن طريق حدث عام يقدر أي ملف
 * في التطبيق يطلقه (زي profiles.js اللي بيستخدم نفس النمط ده).
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
export function dispatchToast(message, type = 'info') {
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { message, type } }));
}

/**
 * كانت بترسم وتعرض Toast واحد داخل toastContainer وتخفيه تلقائياً بعد
 * 3 ثواني - اتلغت بالكامل بناءً على طلب صريح (كانت مشتتة جداً، وكمان
 * كانت بتظهر مرتين لكل رسالة أصلاً بسبب تكرار الرسم مع showToast() في
 * app.js على نفس حدث 'app:toast'). سايبين الدالة والـ export بتاع
 * dispatchToast() موجودين (كـ no-op) عمداً بدل ما نمسح كل نداء لهم من
 * المشروع كله (أكتر من 30 مكان) - عشان أي كود موجود يفضل شغال زي ما
 * هو من غير أي تعديل تاني ولا أي خطأ، بس من غير ما يظهر أي حاجة فعليًا
 * على الشاشة.
 */
function renderToast() {
    // تعمداً مفيش أي كود هنا - شوف التعليق فوق
}

/**
 * ربط مستمع عام لحدث "app:toast" عشان أي ملف في التطبيق (بما فيهم
 * profiles.js نفسه) يقدر يعرض توست بدون ما يعرف تفاصيل الرسم.
 */
function listenToToastEvents() {
    document.addEventListener('app:toast', (event) => {
        renderToast(event.detail);
    });
}

/**
 * ربط كل عناصر تحكم موديل تسجيل الدخول (الأزرار والفورم)
 */
function bindAuthModalEvents() {
    const emailForm = document.getElementById('emailAuthForm');
    const toggleBtn = document.getElementById('btnToggleAuthMode');
    const forgotPasswordBtn = document.getElementById('btnForgotPassword');
    const cancelApprovalBtn = document.getElementById('btnCancelApprovalWait');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleAuthMode);
    }

    if (forgotPasswordBtn) {
        forgotPasswordBtn.addEventListener('click', handleForgotPasswordClick);
    }
    bindForgotPasswordConfirmModal();

    if (cancelApprovalBtn) {
        cancelApprovalBtn.addEventListener('click', cancelApprovalWait);
    }

    // زر إظهار/إخفاء كلمة المرور في فورم الدخول والتسجيل
    function bindPasswordVisibility(btnId, inputId) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (!btn || !input) return;

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            const openIcon = btn.querySelector('.eye-open');
            const closedIcon = btn.querySelector('.eye-closed');
            if (openIcon) openIcon.classList.toggle('hidden', isPassword);
            if (closedIcon) closedIcon.classList.toggle('hidden', !isPassword);
        });
    }

    bindPasswordVisibility('btnToggleAuthPassword', 'authPasswordInput');
    bindPasswordVisibility('btnToggleAuthConfirmPassword', 'authPasswordConfirmInput');

    if (emailForm) {
        emailForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            hideAuthError();

            const username = document.getElementById('authUsernameInput').value.trim();
            const password = document.getElementById('authPasswordInput').value;

            if (!username) {
                showAuthError('من فضلك اكتب اسم المستخدم');
                return;
            }
            if (!password) {
                showAuthError('من فضلك اكتب كلمة المرور');
                return;
            }
            if (currentAuthMode === 'signup') {
                if (password.length < 6) {
                    showAuthError('كلمة المرور لازم تكون 6 حروف/أرقام على الأقل');
                    return;
                }
                const confirmPassword = document.getElementById('authPasswordConfirmInput')?.value;
                if (!confirmPassword) {
                    showAuthError('من فضلك أكد كلمة المرور');
                    return;
                }
                if (password !== confirmPassword) {
                    showAuthError('كلمتا المرور غير متطابقتين، يرجى التأكد');
                    return;
                }
            }

            setAuthFormLoading(true);

            try {
                if (currentAuthMode === 'signup') {
                    // بنجمع كل الحقول الإضافية هنا في كائن واحد قبل ما نبعتها
                    // لـ signUpWithUsername - ده اللي كان ناقص قبل كده وسبب
                    // خطأ إنشاء الحساب (كانت بتتبعت من غير الحقول الإضافية خالص)
                    const extraProfileData = {
                        firstName: document.getElementById('signupFirstNameInput').value.trim(),
                        lastName: document.getElementById('signupLastNameInput').value.trim(),
                        birthDate: document.getElementById('signupBirthDateInput').value,
                        gender: selectedSignupGender,
                        phone: document.getElementById('signupPhoneInput').value.trim(),
                        avatarFile: croppedAvatarBlob || uploadedSignupAvatarFile,
                    };

                    // تحقق من الحقول الإضافية المطلوبة قبل الإرسال - لو أي
                    // حقل ناقص، لازم نوقف العملية ونوضح السبب للمستخدم عبر
                    // showAuthError() بدل ما نسيب signUpWithUsername يفشل
                    // بصمت أو برسالة خطأ مش واضحة من السيرفر
                    if (!extraProfileData.firstName) {
                        showAuthError('من فضلك اكتب الاسم الأول');
                        return;
                    }
                    if (!extraProfileData.lastName) {
                        showAuthError('من فضلك اكتب الاسم الثاني');
                        return;
                    }
                    if (!extraProfileData.birthDate) {
                        showAuthError('من فضلك اختار تاريخ ميلادك');
                        return;
                    }
                    if (!extraProfileData.gender) {
                        showAuthError('من فضلك اختار النوع');
                        return;
                    }

                    await signUpWithUsername(username, password, extraProfileData);
                } else {
                    await signInWithUsername(username, password);
                }
                // onAuthStateChange هو اللي هيتكفل بإخفاء الموديل والانتقال
                // للخطوة الجاية بعد نجاح العملية (أو بعرض شاشة انتظار
                // الموافقة لو فيه تعارض جلسة - شوف handleSignedInSession)
            } catch (error) {
                showAuthError(error.message);
                dispatchToast(error.message, 'error');
            } finally {
                setAuthFormLoading(false);
            }
        });
    }
}

/**
 * ربط كل مستمعي فورم الدخول/التسجيل (submit، تبديل الوضع، رفع
 * الصورة واختيار النوع، الـ Toasts، وتغيّرات حالة المصادقة) من غير
 * ما نفحص أو نفتح المودال فعلياً بعد. لازم تتنادى *قبل* ما شاشات
 * الترحيب تظهر (مش بعدها زي قبل كده)، عشان لو المستخدم اختار
 * "إنشاء حساب"/"تسجيل الدخول" من آخر سلايد وفورم #authModal اتدمج
 * جوه السلايد، الأحداث دي تكون شغالة على طول من غير ما يحتاج يستنى.
 * checkExistingSession() (اللي بتفتح المودال فعلياً لو مفيش جلسة)
 * مقصودة عمداً *برّة* الدالة دي - js/app.js بينادّيها بعد ما شاشات
 * الترحيب تخلّص، عشان مانفتحش مودال دخول تاني فوق شاشة ترحيب لسه
 * ظاهرة لمستخدم أول مرة.
 */
export function bindAuthEventListeners() {
    bindAuthModalEvents();
    bindSignupExtraFieldsEvents();
    bindLoginApprovalModalEvents();
    listenToToastEvents();
    listenToAuthStateChanges();
}

/**
 * ربط زراري "موافقة"/"رفض" جوه مودال طلب الدخول الوارد
 * (#loginApprovalIncomingModal) - المودال ده منفصل عن authModal تماماً
 * لأنه بيظهر لمستخدم مسجل دخول بالفعل وبيستخدم التطبيق عادي
 */
function bindLoginApprovalModalEvents() {
    const approveBtn = document.getElementById('btnApproveIncomingLogin');
    const rejectBtn = document.getElementById('btnRejectIncomingLogin');

    if (approveBtn) {
        approveBtn.addEventListener('click', () => respondToIncomingLoginApproval('approved'));
    }
    if (rejectBtn) {
        rejectBtn.addEventListener('click', () => respondToIncomingLoginApproval('rejected'));
    }
}

/**
 * نقطة الدخول الرئيسية "الكاملة" لنظام المصادقة (ربط الأحداث + فحص
 * الجلسة الحالية فوراً). فضلت موجودة للتوافق لأي استخدام مستقبلي
 * مش مرتبط بشاشات الترحيب؛ js/app.js دلوقتي بيستخدم
 * bindAuthEventListeners() و checkExistingSession() منفصلين (شوف
 * تعليق bindAuthEventListeners فوق للسبب).
 */
export function initAuthUI() {
    bindAuthEventListeners();
    checkExistingSession();
}