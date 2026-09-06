/* ==================================================================
   سِكّاوي | js/theme.js
   ------------------------------------------------------------------
   هذا الملف مسؤول بالكامل عن منطق تبديل المود الداكن/الفاتح
   (Dark / Light Mode). مسؤولياته:

   1) قراءة تفضيل المستخدم المحفوظ مسبقاً من localStorage وتطبيقه
      فور بداية التشغيل (المود الافتراضي لأول زيارة هو "الداكن")
   2) تبديل كلاس "dark" على عنصر <html> (اللي Tailwind بيعتمد عليه
      عبر إعداد darkMode: 'class' في index.html)
   3) حفظ أي تغيير جديد في localStorage عشان التفضيل يفضل شغال
      حتى بعد إغلاق المتصفح
   4) تحديث زرار التبديل نفسه (شكل المقبض + aria-checked) ولون
      شريط المتصفح (meta theme-color) عشان تجربة استخدام متكاملة
   5) مزامنة الحالة بين أكتر من تاب مفتوح لنفس الموقع في نفس الوقت

   ملاحظة: المود الافتراضي هو "الداكن" (Dark) دايماً في أول زيارة،
   وبيفضل كده لحد ما المستخدم يبدّل بنفسه من الزرار - من غير أي
   اعتماد على تفضيل نظام التشغيل (prefers-color-scheme)

   ------------------------------------------------------------------
   (تعطيل مؤقت - طلب صريح): الوضع النهاري لسه مش مكتمل الضبط بصرياً
   في كل الشاشات (كروت الإشعارات، منصّة التتويج..إلخ)، فتقرر تعطيله
   مؤقتاً واعتماد الوضع الداكن بس لحد ما يتم ضبط كل حاجة. زرار التبديل
   (#themeToggleBtn) اتشال خالص من index.html، فمفيش أي طريقة للمستخدم
   يبدّل بيها المود دلوقتي.

   بس ده لوحده مكنش كافي: أي مستخدم كان جرّب الوضع الفاتح قبل كده لسه
   عنده "sekkawy:theme" = "light" متخزّنة في localStorage جهازه، و
   getStoredTheme() كانت هترجّع القيمة دي وتفتحله التطبيق فاتح تلقائياً
   في أول تحميل - حتى من غير أي زرار يضغط عليه. عشان كده initTheme() تحت
   بقت مباشرة بتفرض DEFAULT_THEME (الداكن) دايماً وبتتجاهل getStoredTheme()
   خالص، بدل ما تقرا أي قيمة قديمة محفوظة.

   باقي الدوال (toggleTheme / watchCrossTabChanges / getStoredTheme)
   اتسابت زي ما هي بالظبط من غير حذف - مش بتتنادى من initTheme() تاني،
   لكن سايبينها عشان لو حبينا نرجّع الميزة تاني في المستقبل، نرجّع بس
   نداءاتها جوه initTheme() من غير ما نعيد كتابة أي منطق من الصفر.
   ------------------------------------------------------------------ */

const STORAGE_KEY = 'sekkawy:theme';
const DARK = 'dark';
const LIGHT = 'light';
const DEFAULT_THEME = DARK; // المود الافتراضي داكن دايماً لأول مستخدم

/** لون شريط المتصفح العلوي (Meta Theme Color) المناسب لكل مود */
const THEME_COLOR = {
    [DARK]: '#0B0D12',
    [LIGHT]: '#F7F4EC',
};

/* ------------------------------------------------------------------
   1) القراءة والحفظ في localStorage
   ------------------------------------------------------------------ */

/** قراءة التفضيل المحفوظ (لو موجود وقيمته صحيحة) وإلا يرجّع null */
function getStoredTheme() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored === DARK || stored === LIGHT ? stored : null;
    } catch (err) {
        // فشل الوصول لـ localStorage (زي وضع التصفح الخفي المقيّد) - بنتجاهل بهدوء
        return null;
    }
}

/** حفظ التفضيل الجديد بعد كل تبديل */
function storeTheme(theme) {
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
        // نفس الحالة أعلاه - مفيش داعي نوقف تنفيذ التطبيق بسبب ده
    }
}

/* ------------------------------------------------------------------
   2) تطبيق المود على الواجهة
   ------------------------------------------------------------------ */

/** تحديث لون شريط عنوان المتصفح ليتماشى مع المود الحالي */
function updateMetaThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

/** تحديث شكل زرار التبديل نفسه (المقبض + حالة إمكانية الوصول) */
function updateToggleButtonUI(theme) {
    const btn = document.getElementById('themeToggleBtn');
    const thumb = document.getElementById('themeToggleThumb');
    if (!btn || !thumb) return;

    const isLight = theme === LIGHT;
    btn.classList.toggle('is-light', isLight);
    // "checked" هنا بمعنى المود الداكن (الحالة الافتراضية/الأساسية للزرار)
    btn.setAttribute('aria-checked', String(!isLight));
    thumb.textContent = isLight ? '☀️' : '🌙';
}

/** تطبيق المود فعلياً: كلاس "dark" على <html> + توابعه في الواجهة */
function applyTheme(theme) {
    document.documentElement.classList.toggle(DARK, theme === DARK);
    document.documentElement.setAttribute('data-theme', theme);
    updateMetaThemeColor(theme);
    updateToggleButtonUI(theme);
}

/* ------------------------------------------------------------------
   3) التبديل والمزامنة
   (معطّلة مؤقتاً - مش بتتنادى من initTheme() تحت، شوف الملحوظة أعلى
   الملف. متسابة زي ما هي بالظبط عشان سهولة الرجوع)
   ------------------------------------------------------------------ */

/** تبديل المود الحالي (تُستدعى عند الضغط على زرار التبديل) */
function toggleTheme() {
    const current = document.documentElement.classList.contains(DARK) ? DARK : LIGHT;
    const next = current === DARK ? LIGHT : DARK;

    applyTheme(next);
    storeTheme(next);
}

/** مزامنة المود تلقائياً بين أكتر من تاب/نافذة مفتوحين لنفس الموقع */
function watchCrossTabChanges() {
    window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY || !event.newValue) return;
        applyTheme(event.newValue === LIGHT ? LIGHT : DARK);
    });
}

/* ------------------------------------------------------------------
   4) نقطة الدخول
   ------------------------------------------------------------------ */

/**
 * تُستدعى مرة واحدة من js/app.js عند بداية تشغيل التطبيق.
 * (تعطيل مؤقت): بتفرض DEFAULT_THEME (الداكن) دايماً من غير ما تقرا
 * getStoredTheme() خالص - عشان أي تفضيل "light" قديم متخزّن من قبل
 * التعطيل ميرجعش يشتغل تلقائياً. مفيش ربط لزرار تبديل ولا مراقبة
 * لتغييرات تابات تانية دلوقتي (الزرار نفسه اتشال من index.html أصلاً).
 */
export function initTheme() {
    applyTheme(DEFAULT_THEME);
}