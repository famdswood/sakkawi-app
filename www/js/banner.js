/* ==================================================================
   سِكّاوي | js/banner.js
   ------------------------------------------------------------------
   (المرحلة 4) البانر العلوي في الصفحة الرئيسية - #homeBanner في
   index.html. مسؤول عن:

     1) قراءة الصف الوحيد من home_banner (id = 1) عند فتح التطبيق -
        قراءة مباشرة (SELECT عام، شوف sql/phase-4-banner.sql)، مفيش
        داعي RPC هنا لأننا بس بنقرا مش بنعدّل.
     2) الاشتراك في Realtime على نفس الجدول عشان أي حفظ من admin.js
        (admin_update_home_banner) يوصل للمستخدم فوراً من غير Refresh.
     3) إظهار/إخفاء #homeBanner وتحديث الصورة/النص بناءً على القيم.

   ES Module مستقل بيسجّل نفسه على DOMContentLoaded (بنفس نمط
   js/guest-banner.js وjs/guest-reminder.js بالظبط) - مش محتاج يتنادى
   من app.js، ومفيش أي اعتماد بينه وبين باقي وحدات التطبيق.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
// (جديد - كاش الأوفلاين) شوف js/offline-cache.js للتفاصيل الكاملة
import { fetchWithCache } from './offline-cache.js';

/** اشتراك Realtime الحالي (لو شغال) - محفوظ عشان نقدر نلغيه لو الصفحة اتقفلت */
let bannerRealtimeChannel = null;

// [تعديل] القيم الافتراضية لو الصف مفيهوش image_position / overlay_opacity /
// text_color لسه (مثلاً صف قديم اتعمل قبل إضافة الأعمدة دي) - نفس القيم
// الافتراضية المستخدمة في js/admin.js بالظبط عشان المعاينة والواقع يتطابقوا
const BANNER_DEFAULT_POSITION = '50% 50%';
const BANNER_DEFAULT_OVERLAY_OPACITY = 40; // 0-100
const BANNER_DEFAULT_TEXT_COLOR = '#ffffff';

/**
 * ترسم/تحدّث #homeBanner بناءً على صف home_banner. بتخفي البانر
 * بالكامل لو مفيش صف، أو is_active = false، أو مفيش صورة ولا نص
 * أصلاً (عشان منسيبش بانر فاضي ظاهر لأي مستخدم)
 * @param {{ image_url: string|null, banner_text: string|null, is_active: boolean,
 *            image_position: string|null, overlay_opacity: number|null,
 *            text_color: string|null }|null} row
 */
function renderHomeBanner(row) {
    const bannerEl = document.getElementById('homeBanner');
    if (!bannerEl) return;

    const imageEl = document.getElementById('homeBannerImage');
    const overlayEl = bannerEl.querySelector('.home-banner-overlay');
    const textEl = document.getElementById('homeBannerText');

    const hasImage = Boolean(row && row.image_url);
    const hasText = Boolean(row && row.banner_text);
    const shouldShow = Boolean(row && row.is_active && (hasImage || hasText));

    if (!shouldShow) {
        bannerEl.classList.add('hidden');
        return;
    }

    if (imageEl) {
        if (hasImage) {
            imageEl.src = row.image_url;
            imageEl.classList.remove('hidden');
            // [تعديل] الجزء الظاهر من الصورة - القيمة جاية من الأدمن
            // (object-position جاهزة، شوف admin.html/#bannerPositionGrid)
            imageEl.style.objectPosition = row.image_position || BANNER_DEFAULT_POSITION;
        } else {
            imageEl.removeAttribute('src');
            imageEl.classList.add('hidden');
        }
    }

    // [تعديل] ظلام الصورة - طبقة تعتيم شفافيتها بتتحدد من الأدمن، ومعندهاش
    // معنى غير مع وجود صورة فعلاً (بانر النص بس بياخد خلفية متدرجة بدل كده)
    if (overlayEl) {
        const overlayOpacity = hasImage
            ? ((row.overlay_opacity ?? BANNER_DEFAULT_OVERLAY_OPACITY) / 100)
            : 0;
        overlayEl.style.backgroundColor = `rgba(0, 0, 0, ${overlayOpacity})`;
    }

    if (textEl) {
        textEl.textContent = row.banner_text || '';
        // [تعديل] لون النص - بيتحدد من الأدمن بدل اللون الثابت في style.css
        textEl.style.color = row.text_color || BANNER_DEFAULT_TEXT_COLOR;
    }

    // بانر نص بس (من غير صورة) بياخد خلفية متدرجة بدل الصورة الفاضية
    // - شوف .home-banner.is-text-only في style.css
    bannerEl.classList.toggle('is-text-only', !hasImage);
    bannerEl.classList.remove('hidden');
}

/**
 * بتجيب الصف الخام من home_banner من Supabase فقط (من غير رسم) - بترجع
 * null فقط لو حصل خطأ فعلي (مشكلة شبكة/سيرفر)، وبترجع { row: data }
 * (حتى لو data نفسها null، يعني "مفيش بانر فعلاً") في حالة النجاح - عشان
 * fetchWithCache تقدر تفرّق بين "الطلب فشل، سيب المعروض زي ما هو" و
 * "الطلب نجح ورجع إن مفيش بانر، اخفيه فعلاً واحفظ الحالة دي في الكاش"
 * @returns {Promise<{row: object|null}|null>}
 */
async function fetchHomeBannerRow() {
    const { data, error } = await supabaseClient
        .from('home_banner')
        // [تعديل] لازم نجيب الأعمدة الجديدة هنا برضه، وإلا أول Refresh
        // للصفحة (قبل أي حدث Realtime) هيعرض القيم الافتراضية بدل
        // القيم المحفوظة فعلاً في القاعدة
        .select('image_url, banner_text, is_active, image_position, overlay_opacity, text_color')
        .eq('id', 1)
        .maybeSingle();

    if (error) {
        // فشل القراءة (مثلاً مشكلة شبكة مؤقتة) - بنرجع null صراحة عشان
        // fetchWithCache تعرف إن ده فشل حقيقي، مش "مفيش بانر فعلاً"
        console.error('[banner.js] فشل تحميل البانر:', error.message || error);
        return null;
    }

    return { row: data };
}

/**
 * (جديد - كاش الأوفلاين) بتجيب الصف الحالي من home_banner وترسمه -
 * بتعرض النسخة المخزّنة محلياً فوراً (لو موجودة) قبل ما رد الشبكة
 * يوصل، وتحدّث الكاش تلقائياً بعد كل قراءة ناجحة. بتتنادى مرة عند فتح
 * التطبيق.
 */
async function loadHomeBannerOnce() {
    await fetchWithCache('cached_home_banner', fetchHomeBannerRow, ({ row }) => {
        renderHomeBanner(row);
    });
}

/**
 * تشترك في تحديثات Realtime الحية على home_banner (صف واحد بس، فأي
 * حدث UPDATE هو التحديث اللي محتاجينه - INSERT مستبعد عملياً لأن
 * الصف اتعمله insert مرة واحدة في الميجريشن نفسها، بس بنسمعه احتياطياً)
 */
function bindHomeBannerRealtimeSubscription() {
    unbindHomeBannerRealtimeSubscription();

    bannerRealtimeChannel = supabaseClient
        .channel('home-banner-live')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'home_banner' },
            (payload) => renderHomeBanner(payload.new),
        )
        .subscribe((status, err) => {
            if (err) {
                console.error('[banner.js] خطأ في اشتراك Realtime بتاع البانر:', err.message || err);
            }
        });
}

/** تلغي اشتراك Realtime الحالي (لو شغال) - خط دفاع من اشتراك مكرر لو الدالة اتنادت أكتر من مرة */
function unbindHomeBannerRealtimeSubscription() {
    if (bannerRealtimeChannel) {
        supabaseClient.removeChannel(bannerRealtimeChannel);
        bannerRealtimeChannel = null;
    }
}

/** نقطة الدخول - بتتنادى تلقائياً عند DOMContentLoaded */
function initHomeBanner() {
    loadHomeBannerOnce();
    bindHomeBannerRealtimeSubscription();
}

document.addEventListener('DOMContentLoaded', initHomeBanner);