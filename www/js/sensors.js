/* ==================================================================
   سِكّاوي | js/sensors.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: قراءة حساس الحركة (Accelerometer)
   من الموبايل وتحويلها لعدد خطوات دقيق.

   ⚠️ ملاحظة مهمة (بعد التعديل الأول):
   اتشال نهائياً "وضع المحاكاة الاحتياطي" اللي كان بيولّد خطوات
   عشوائية بـ setInterval لما الحساس مش متاح أو الإذن اترفض. ده كان
   بيخلي العداد يعدّ لوحده حتى والموبايل واقف ساكن على الترابيزة.

   دلوقتي الاعتماد بقى صارم 100% على حدث devicemotion الحقيقي:
   - لو الحساس مش مدعوم، أو الإذن اترفض، أو الصفحة مش شغالة على
     HTTPS (Secure Context) - هيتبعت تنبيه واضح للمستخدم والعداد
     هيفضل واقف على قيمته الحالية (متتصفرش تلقائي) وحالة التتبع
     هتبقى "متوقفة" (isTracking = false) لحد ما نلاقي حساس حقيقي.
   - العداد مش هيزيد إلا لو فعلاً وصلت قراءة حركة حقيقية عدّت
     خوارزمية الـ Peak Detection تحت.

   ⚠️ ملاحظة مهمة (بعد التعديل الثاني):
   اتشالت فكرة "بداية/نهاية الجلسة" تماماً. الملف دلوقتي:
   - بيشغّل التتبع تلقائياً لوحده أول ما الصفحة تفتح (Auto Start)،
     من غير أي زرار أو تدخل من المستخدم (شوف autoInit() في آخر الملف).
   - بيحفظ إجمالي خطوات اليوم في localStorage مع كل خطوة بتتسجل
     (Auto Save & Sync) عشان لو المستخدم قفل التاب أو عمل Refresh
     العداد يرجع من نفس النقطة.
   - بيعمل فحص "يوم جديد" (Daily Reset) عند التحميل: لو التاريخ
     المحفوظ هو نفسه النهاردة بيكمل على نفس العداد، ولو يوم قديم
     بيأرشف خطوات اليوم اللي فات في History ويصفّر العداد لليوم
     الجديد. راجع loadPersistedDailyState() تحت.
   - الدوال startStepTracking/stopStepTracking/toggleStepTracking
     لسه موجودة ومصدّرة (مفيدة للتحكم البرمجي أو التوقف المؤقت لو
     الصفحة راحت للخلفية مثلاً)، لكن مفيش أي UI/زرار مربوط بيها
     دلوقتي - التشغيل بقى تلقائي بالكامل من autoInit().

   خوارزمية عد الخطوات (Calibrated Peak Detection):
   بدل ما نعتمد على "فرق" القراءتين المتتاليتين (delta) - وهو اللي كان
   بيخلي أي اهتزاز خفيف لليد يتحسب كخطوات وهمية - بقينا نعتمد على:

   1) Low-Pass Filter (فلتر تنعيم أسّي - EMA):
      بيشيل الاهتزازات السريعة والـ Noise من قراءات الحساس الخام،
      وبيسيب بس الحركة "البطيئة نسبياً" الفعلية للجسم أثناء المشي.

   2) Dynamic Amplitude Threshold + Hysteresis:
      بدل ما نقارن الفرق بحد صغير، بنقارن "قيمة" التسارع المُنعّم
      نفسها بحد أعلى (STEP_THRESHOLD_HIGH) قريب من قوة اصطدام القدم
      الحقيقية بالأرض أثناء المشي (~12.5–13 م/ث²)، وحد أدنى منفصل
      (STEP_THRESHOLD_LOW) لازم نرجع تحته الأول قبل ما نسمح باحتساب
      قمة (Peak) جديدة. الفجوة دي (Hysteresis) هي اللي بتمنع احتساب
      نفس الصعود/الهبوط أكتر من مرة في نفس الحركة.

   3) Cooldown / Deadtime:
      بعد ما نحتسب خطوة، بنرفض أي خطوة جديدة قبل ما يعدي STEP_COOLDOWN_MS
      (الحد الأقصى الفسيولوجي الطبيعي للمشي/الجري السريع هو حوالي
      3 خطوات/ثانية تقريباً، يعني مفيش داعي نقبل خطوة كل أقل من ~320ms).

   دي مش دقة 100% (لسه أفضل من دلتا بسيطة لكن مش بديل عن Pedometer
   API مخصص لو الجهاز بيدعمه)، لكنها بتقلل بشكل كبير جداً من الخطوات
   الوهمية الناتجة عن اهتزاز اليد أو تحريك الموبايل من غير مشي فعلي.
   ================================================================== */

/* ------------------------------------------------------------------
   ⚙️ منطقة الضبط السريع (Sensitivity Tuning)
   دي أهم المتغيرات اللي ممكن تحتاج تلعب فيها بعد التجربة الفعلية على
   جهاز حقيقي. مفيش داعي تلمس أي حاجة تانية في الملف عشان تظبط الحساسية.
   ------------------------------------------------------------------ */

/**
 * قيمة الجاذبية الأرضية التقريبية (م/ث²) - بنستخدمها كقيمة بداية
 * للفلتر عشان أول قراءة توصل ماتتفسرش غلط كخطوة
 */
const GRAVITY = 9.81;

/**
 * الحد الأعلى (م/ث²) اللي القراءة "المُنعّمة" لازم تتخطاه عشان تتحسب
 * كقمة/خطوة محتملة. القيمة دي بتمثل قوة اصطدام القدم بالأرض الفعلية
 * أثناء المشي، مش مجرد اهتزاز اليد.
 * موصى بيه: من 12.5 إلى 13.0 - القيمة الحالية 12.8 (وسط آمن)
 * - زوّدها لو لسه بيحسب اهتزازات خفيفة كخطوات (الجهاز حساس زيادة)
 * - قلّلها لو مبقاش بيحسب مشي عادي/بطيء (الجهاز بقى متبلّد)
 */
const STEP_THRESHOLD_HIGH = 12.8;

/**
 * الحد الأدنى (م/ث²) اللي لازم القراءة "المُنعّمة" ترجع تحته الأول
 * قبل ما نسمح باحتساب قمة جديدة (Hysteresis Band). الفرق بينه وبين
 * STEP_THRESHOLD_HIGH هو اللي بيمنع احتساب نفس القمة مرتين.
 * موصى بيه: أصغر من STEP_THRESHOLD_HIGH بحوالي 1.0 إلى 2.0
 */
const STEP_THRESHOLD_LOW = STEP_THRESHOLD_HIGH - 1.5; // = 11.3

/**
 * أقل فاصل زمني (ميلي ثانية) بين خطوتين متتاليتين محسوبتين فعلياً
 * (Cooldown / Deadtime). الحد الأدنى المطلوب 320ms (أقصى سرعة مشي/جري
 * طبيعية ~3 خطوات/ثانية). القيمة الحالية 350ms لهامش أمان إضافي بسيط.
 */
const STEP_COOLDOWN_MS = 350;

/**
 * معامل فلتر التنعيم الأسّي (Low-Pass Filter Alpha) - بين 0 و 1:
 * - قيمة صغيرة (مثلاً 0.1) = تنعيم أقوى واستجابة أبطأ (ثبات أعلى،
 *   بيشيل نويز أكتر لكن ممكن يفوّت خطوات سريعة جداً)
 * - قيمة كبيرة (مثلاً 0.4) = تنعيم أضعف واستجابة أسرع (حساسية أعلى
 *   لكن ممكن يسيب شوية نويز يعدّي)
 * القيمة الحالية 0.15 متوازنة لمعظم الحالات
 */
const LOW_PASS_ALPHA = 0.15;

/**
 * مفتاح التخزين في localStorage. بيحتوي على JSON بالشكل:
 * { date: 'YYYY-MM-DD', steps: <عدد خطوات اليوم الحالي>,
 *   history: { 'YYYY-MM-DD': <خطوات اليوم ده>, ... } }
 */
const STORAGE_KEY = 'saa_baladi_step_tracker_v1';

/* ------------------------------------------------------------------
   حالة التطبيق الداخلية (State) - مفيش داعي تتعدل يدوياً
   ------------------------------------------------------------------ */
let stepCount = 0;
let isTracking = false;
let lastStepTimestamp = 0;
let filteredMagnitude = GRAVITY; // بنبدأ بقيمة الجاذبية عشان مفيش قفزة وهمية في أول قراءة
let awaitingPeakReset = false;   // true = إحنا فوق الحد الأعلى وبنستنى نرجع تحت الحد الأدنى
let currentDayKey = null;        // تاريخ اليوم الحالي (YYYY-MM-DD) اللي العداد بيتحسب عليه
let stepsHistory = {};           // أرشيف خطوات الأيام السابقة { 'YYYY-MM-DD': steps }

// (إصلاح - باج حقيقي) آخر user id اتسجلت الحالة المحلية (localStorage)
// باسمه - null يعني "زائر" أو مفيش حساب لسه. بنستخدمه عشان نكتشف
// "تبديل حساب على نفس الجهاز" ونصفّر العداد المحلي وقتها، بدل ما نسيب
// بيانات حساب سابق تتسرب لحساب جديد (شوف syncActiveUser تحت)
let currentOwnerUserId = null;

/**
 * طلب إذن الوصول لحساسات الحركة (مطلوب إجباريًا في iOS 13+)
 * على أندرويد ومعظم المتصفحات التانية الإذن بيتاخد تلقائي بدون هذا الطلب
 * @returns {Promise<boolean>} true لو الإذن اتوافق عليه
 */
export async function requestMotionPermission() {
    const DeviceMotionEventTyped = window.DeviceMotionEvent;

    // بعض المتصفحات (خصوصاً Safari على iOS) بتطلب استئذان صريح من المستخدم
    if (DeviceMotionEventTyped && typeof DeviceMotionEventTyped.requestPermission === 'function') {
        try {
            const permission = await DeviceMotionEventTyped.requestPermission();
            return permission === 'granted';
        } catch (err) {
            console.warn('تم رفض إذن حساس الحركة:', err);
            return false;
        }
    }

    // المتصفحات اللي مش محتاجة استئذان صريح (تعتبر متاحة افتراضياً)
    return 'DeviceMotionEvent' in window;
}

/**
 * حساب حجم متجه التسارع الكلي (Magnitude) من محاوره الثلاثة
 */
function calculateMagnitude(accel) {
    const x = accel.x || 0;
    const y = accel.y || 0;
    const z = accel.z || 0;
    return Math.sqrt(x * x + y * y + z * z);
}

/**
 * الاستجابة لكل قراءة جديدة من حساس الحركة وتطبيق خوارزمية عد الخطوات
 * المُعايرة (Low-Pass Filter + Hysteresis Threshold + Cooldown)
 */
function handleMotionEvent(event) {
    const accel = event.accelerationIncludingGravity;
    if (!accel) return;

    const rawMagnitude = calculateMagnitude(accel);

    // (1) Low-Pass Filter: تنعيم القراءة الخام عشان نشيل الاهتزازات
    // السريعة والـ Noise، ونسيب بس نمط الحركة الفعلي البطيء نسبياً
    filteredMagnitude = LOW_PASS_ALPHA * rawMagnitude + (1 - LOW_PASS_ALPHA) * filteredMagnitude;

    // (2) + (4) Dynamic Threshold مع Hysteresis: منع احتساب نفس
    // القمة (صعود وهبوط) أكتر من مرة داخل نفس الحركة/الـ Frame
    if (!awaitingPeakReset && filteredMagnitude >= STEP_THRESHOLD_HIGH) {
        awaitingPeakReset = true; // قفلنا الاحتساب لحد ما القراءة ترجع تحت الحد الأدنى

        // (3) Cooldown / Deadtime: رفض أي خطوة أسرع فسيولوجياً من الطبيعي
        const now = Date.now();
        if (now - lastStepTimestamp >= STEP_COOLDOWN_MS) {
            lastStepTimestamp = now;
            registerSteps(1);
        }
    } else if (awaitingPeakReset && filteredMagnitude <= STEP_THRESHOLD_LOW) {
        // القراءة رجعت تحت الحد الأدنى - بقينا جاهزين لالتقاط قمة جديدة
        awaitingPeakReset = false;
    }
}

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
 * السابقة) في localStorage. بتتنفذ مع كل خطوة جديدة (Auto Save).
 */
function persistDailyState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            date: currentDayKey,
            steps: stepCount,
            history: stepsHistory,
            ownerUserId: currentOwnerUserId   // (إصلاح - باج حقيقي) صاحب الحالة المحلية دي
        }));
    } catch (err) {
        // ممكن يفشل لو localStorage ممتلئ أو محظور (وضع تصفح خفي مثلاً)
        console.warn('[sensors.js] تعذر حفظ خطوات اليوم في localStorage:', err);
    }
}

/**
 * تُستدعى مرة واحدة عند تحميل الملف (من autoInit): بتقرأ آخر حالة
 * محفوظة في localStorage وتقرر إحنا مكملين على نفس اليوم ولا لازم
 * نفتح يوم جديد (Daily Reset Check):
 * - لو مفيش بيانات محفوظة أصلاً -> نبدأ يوم جديد بعداد صفر.
 * - لو التاريخ المحفوظ = النهاردة -> نسترجع العداد ونكمل عليه.
 * - لو التاريخ المحفوظ يوم قديم -> نأرشف خطواته في History ونصفّر
 *   العداد لليوم الجديد.
 */
function loadPersistedDailyState() {
    const todayKey = getTodayKey();
    let saved = null;

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch (err) {
        console.warn('[sensors.js] تعذر قراءة بيانات الخطوات المحفوظة (هنبدأ من صفر):', err);
    }

    if (!saved || typeof saved !== 'object') {
        // أول تشغيل للتطبيق على الإطلاق - مفيش أي بيانات سابقة
        currentDayKey = todayKey;
        stepCount = 0;
        stepsHistory = {};
        persistDailyState();
        return;
    }

    stepsHistory = saved.history && typeof saved.history === 'object' ? saved.history : {};
    currentOwnerUserId = saved.ownerUserId ?? null; // (إصلاح - باج حقيقي)

    if (saved.date === todayKey) {
        // نفس تاريخ اليوم - نكمل على العداد المحفوظ زي ما هو
        currentDayKey = todayKey;
        stepCount = Number(saved.steps) || 0;
    } else {
        // يوم جديد: أرشفة خطوات اليوم اللي فات (لو موجود) وتصفير العداد
        if (saved.date) {
            stepsHistory[saved.date] = Number(saved.steps) || 0;
        }
        currentDayKey = todayKey;
        stepCount = 0;
    }

    persistDailyState();
}

/**
 * فحص دفاعي بسيط: لو التطبيق فاضل فاتح عدّاء منتصف الليل، أي خطوة
 * جديدة بتتسجل بتتأكد الأول إننا لسه في نفس اليوم المحفوظ، وإلا
 * بتعمل نفس أرشفة/تصفير الـ Daily Reset قبل ما تضيف الخطوة الجديدة.
 */
function ensureStillSameDay() {
    const todayKey = getTodayKey();
    if (todayKey !== currentDayKey) {
        if (currentDayKey) {
            stepsHistory[currentDayKey] = stepCount;
        }
        currentDayKey = todayKey;
        stepCount = 0;
    }
}

/**
 * زيادة عداد الخطوات (بواسطة الحساس الحقيقي فقط، أو نداء يدوي صريح
 * من simulateSteps للتطوير)، حفظها تلقائياً في localStorage (Auto
 * Save & Sync)، وبث الحدث للتطبيق
 * @param {number} amount - عدد الخطوات المُضافة
 */
function registerSteps(amount) {
    ensureStillSameDay();
    stepCount += amount;
    persistDailyState();
    document.dispatchEvent(new CustomEvent('sensors:steps-update', {
        detail: { steps: stepCount, delta: amount, date: currentDayKey }
    }));
}

/**
 * إرجاع أرشيف خطوات الأيام السابقة { 'YYYY-MM-DD': steps }
 * (اليوم الحالي مش موجود فيه لحد ما يخلص ويتأرشف)
 */
export function getStepsHistory() {
    return { ...stepsHistory };
}

/** فحص توافر أي واجهة حساس حركة على الجهاز/المتصفح الحالي */
export function isMotionSupported() {
    return 'DeviceMotionEvent' in window || 'Accelerometer' in window;
}

/** هل التتبع الحقيقي بالحساس شغّال دلوقتي؟ */
export function isTrackingActive() {
    return isTracking;
}

/** بث حالة التتبع (تشغيل/إيقاف) لباقي التطبيق */
function broadcastTrackingChange(active) {
    document.dispatchEvent(new CustomEvent('sensors:tracking-changed', {
        detail: { active }
    }));
}

/**
 * تنبيه المستخدم إن الحساس مش شغّال (مش متاح / الإذن اترفض / محتاج
 * HTTPS) بدل ما نسكت ونرجع لتوليد خطوات وهمية.
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
 * بدء تتبّع الخطوات الحقيقي عبر حساس الحركة بالموبايل فقط.
 * بتتنده تلقائياً من autoInit() أول ما الصفحة تفتح - مفيش زرار UI
 * مربوط بيها دلوقتي. لو الحساس مش متاح، أو الصفحة مش شغالة على
 * HTTPS، أو المستخدم رفض الإذن - بيتبعت تنبيه واضح والعداد بيفضل
 * واقف (مفيش أي توليد تلقائي للخطوات إطلاقاً).
 * @returns {Promise<boolean>} true لو التتبع الحقيقي اشتغل فعلاً
 */
export async function startStepTracking() {
    if (isTracking) return true;

    // (أ) لازم Secure Context (HTTPS) - المتصفحات الحديثة بتمنع الوصول
    // لحساسات الحركة على أي أصل غير آمن (http عادي بدون شهادة SSL)
    if (!window.isSecureContext) {
        notifySensorUnavailable(
            'تتبّع الخطوات بيحتاج فتح الموقع عبر HTTPS. المتصفح بيمنع الوصول لحساس الحركة على اتصال غير آمن (HTTP).',
            'insecure-context'
        );
        isTracking = false;
        broadcastTrackingChange(false);
        return false;
    }

    // (ب) لازم يكون فيه واجهة حساس حركة أصلاً على الجهاز/المتصفح
    if (!isMotionSupported()) {
        notifySensorUnavailable(
            'حساس الحركة (Accelerometer) مش مدعوم على المتصفح أو الجهاز ده، فمش هينفع نعد الخطوات تلقائياً.',
            'unsupported'
        );
        isTracking = false;
        broadcastTrackingChange(false);
        return false;
    }

    // (ج) طلب الإذن (مطلوب إجباريًا في iOS 13+)
    const granted = await requestMotionPermission();
    if (!granted) {
        notifySensorUnavailable(
            'تم رفض إذن الوصول لحساس الحركة. لازم توافق على الإذن عشان العداد يشتغل بالحساس الحقيقي.',
            'permission-denied'
        );
        isTracking = false;
        broadcastTrackingChange(false);
        return false;
    }

    // إعادة ضبط حالة الفلتر عشان أول قراءة حقيقية ماتتفسرش غلط كخطوة
    filteredMagnitude = GRAVITY;
    awaitingPeakReset = false;

    window.addEventListener('devicemotion', handleMotionEvent);
    isTracking = true;
    broadcastTrackingChange(true);
    return true;
}

/**
 * إيقاف تتبّع الخطوات الحقيقي (إزالة مستمع devicemotion).
 * مفيش زرار UI بيندهها دلوقتي (اتشالت فكرة "أوقف الجلسة") - لسه
 * مصدّرة للاستخدام البرمجي لو احتجت توقف مؤقت (مثلاً لما الصفحة
 * تروح للخلفية عبر visibilitychange).
 */
export function stopStepTracking() {
    window.removeEventListener('devicemotion', handleMotionEvent);
    isTracking = false;
    broadcastTrackingChange(false);
}

/**
 * تبديل حالة التتبع: تشغيل لو واقف، إيقاف لو شغّال
 * (الدالة المستخدمة مباشرة من زرار "تفعيل التتبع المباشر" في الهيدر)
 * @returns {Promise<{active: boolean}>}
 */
export async function toggleStepTracking() {
    if (isTracking) {
        stopStepTracking();
        return { active: false };
    }

    const started = await startStepTracking();
    return { active: started };
}

/**
 * إضافة خطوات يدوياً - للاستخدام في التطوير/الاختبار على الديسكتوب
 * فقط عن طريق نداء صريح من الكود (زرار تجربة مثلاً)، مفيش أي نداء
 * تلقائي أو دوري لها من داخل الملف ده.
 * @param {number} amount - عدد الخطوات المُضافة يدوياً
 */
export function simulateSteps(amount = 500) {
    registerSteps(amount);
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
 * ⚠️ مهم: الدالة دي بتبعت حدث مختلف تماماً ('sensors:steps-resynced')
 * مش 'sensors:steps-update' العادي بتاع الحساس الحقيقي - عشان
 * profiles.js ميفهمهاش غلط كـ"خطوات جديدة" ويحاول يبعتها تاني لـ
 * Supabase (ده كان هيسبب تضاعف حقيقي في total_steps/points في كل مرة
 * يتفتح فيها جهاز جديد لنفس الحساب - الخطوات دي أصلاً مصدرها Supabase
 * نفسه، مش حركة جديدة لسه متسجلتش).
 * @param {number} serverDailySteps - قيمة daily_steps من صف البروفايل
 */
export function reconcileWithServerSteps(serverDailySteps) {
    if (typeof serverDailySteps !== 'number' || !Number.isFinite(serverDailySteps)) return;
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
    if (typeof serverBestSteps !== 'number' || !Number.isFinite(serverBestSteps)) return;

    const localBest = Object.values(stepsHistory).reduce(
        (max, value) => Math.max(max, Number(value) || 0),
        0
    );
    const combinedBest = Math.max(localBest, serverBestSteps);

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
    filteredMagnitude = GRAVITY;
    awaitingPeakReset = false;
    persistDailyState();
}

/**
 * (إصلاح - باج حقيقي) بتتنادى من profiles.js بمجرد ما نعرف مين المستخدم
 * الحالي فعليًا (بعد تسجيل دخول، أو null بعد تسجيل خروج/وضع زائر).
 * لو المستخدم مختلف عن آخر واحد كانت الحالة المحلية دي باسمه، بنصفّر
 * العداد المحلي بالكامل (زي جهاز جديد تمامًا) قبل ما نسيب
 * reconcileWithServerSteps تجيب رقمه الصحيح من Supabase - عشان نمنع
 * تسريب خطوات حساب سابق لحساب جديد على نفس الجهاز (اللي كان بيحصل قبل
 * الإصلاح ده لأن "ماخدناش غير الأكبر" في reconcileWithServerSteps كانت
 * بتحسب رقم الحساب القديم كـ"تقدم أعلى" غلط بدل ما تعرف إنه حساب مختلف
 * خالص).
 * (إصلاح تاني - باج حقيقي): كنا بنصفّر stepCount بس وننسى stepsHistory
 * (أرشيف الأيام السابقة اللي "رقمك القياسي" في app.js بيتحسب منه عن
 * طريق getStepsHistory/getPreviousBestSteps) - فده كان فاضل تابع
 * للجهاز مش للحساب، فحساب جديد لسه معملش خطوة كان بيشوف "رقم قياسي"
 * حساب سابق على نفس الجهاز. دلوقتي بنصفّرها هي كمان مع أي تبديل حساب
 * فعلي (بنسيبها زي ما هي بس لو نفس الحساب، شوف الشرط فوق).
 * @param {string|null} userId
 */
export function syncActiveUser(userId) {
    const normalizedId = userId || null;
    if (currentOwnerUserId === normalizedId) return; // نفس المستخدم، مفيش داعي نعمل حاجة

    currentOwnerUserId = normalizedId;
    stepCount = 0;
    stepsHistory = {};
    filteredMagnitude = GRAVITY;
    awaitingPeakReset = false;
    persistDailyState();
}

/* ==================================================================
   🚀 Auto Start
   ------------------------------------------------------------------
   بمجرد ما الملف ده يتحمّل (import)، بننفذ تلقائياً:
   1) قراءة/تهيئة حالة اليوم من localStorage (Daily Reset Check).
   2) تشغيل تتبّع الخطوات الحقيقي مباشرة - من غير أي زرار أو تدخل
      من المستخدم. لو الصفحة لسه بتحمّل (document.readyState ===
      'loading') بننتظر DOMContentLoaded الأول عشان نضمن إن أي UI
      مستني الحدث sensors:tracking-changed يكون جاهز يستقبله.
   ================================================================== */
function autoInit() {
    loadPersistedDailyState();

    const kickoff = () => {
        startStepTracking();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', kickoff);
    } else {
        kickoff();
    }
}

/* ==================================================================
   🔗 [جديد] تكامل مع StepCounter Plugin الأصلي (تتبّع الخلفية الحقيقي)
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
async function syncFromNativeStepCounter() {
    if (!window.Capacitor?.isNativePlatform?.()) return;

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

        // نجيب عدد خطوات اليوم من الحساس الأصلي
        const { steps: nativeSteps, date: nativeDate } = await StepCounter.getStepsToday();

        ensureStillSameDay();

        // ندمج بس لو الرقم الأصلي أكبر من المحفوظ محليًا (الحساس
        // الأصلي بيفضل شغّال في الخلفية، يعني ممكن يكون سبقنا بخطوات
        // حصلت والتطبيق كان مقفول)
        if (nativeDate === currentDayKey && nativeSteps > stepCount) {
            const delta = nativeSteps - stepCount;
            stepCount = nativeSteps;
            persistDailyState();
            document.dispatchEvent(new CustomEvent('sensors:steps-update', {
                detail: { steps: stepCount, delta, date: currentDayKey, source: 'native' }
            }));
        }
    } catch (err) {
        console.warn('[sensors.js] تعذر المزامنة مع StepCounter الأصلي:', err);
    }
}

// مزامنة فورية أول ما التطبيق يفتح
document.addEventListener('DOMContentLoaded', syncFromNativeStepCounter);

// ومزامنة تانية كل ما التطبيق يرجع للمقدمة (المستخدم فتح التطبيق تاني
// بعد ما كان في الخلفية أو مقفول) - عشان يلحق أي خطوات اتسجلت وهو غايب
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        syncFromNativeStepCounter();
    }
});

autoInit();