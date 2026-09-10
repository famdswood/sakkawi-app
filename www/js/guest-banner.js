/* ==================================================================
   سِكّاوي | js/guest-banner.js
   ------------------------------------------------------------------
   المرحلة الثالثة (الجزء 1): التحكم في إظهار/إخفاء شريط تنبيه الزوار
   بناءً على قيمة isGuestMode.

   ملاحظة: isGuestMode متوقّع إنها تتحدد فعلياً في المرحلة الجاية بعد
   ربط geofence.js بدالة check_and_update_user_location في السوبابيز
   (شوف نهاية 001_geofencing_setup.sql). دلوقتي بنعرضها هنا كمتغير
   عام بسيط عشان الواجهة تكون جاهزة للربط.

   تحديث (المرحلة الثالثة - الجزء 2): زرار الدعم بقى بيفتح مودال
   "الدعم الفني للمغتربين" (#supportModal - شوف js/support-modal.js)
   بدل ما كان بيفتح رابط واتساب مباشرة في تاب جديد.
   ================================================================== */

import { showAuthGate } from './onboarding.js';
export { showAuthGate };

// حالة الزائر الحالية - هيتم تحديثها لاحقاً من geofence.js بعد استدعاء
// supabaseClient.rpc('check_and_update_user_location', ...)
window.isGuestMode = window.isGuestMode || false;

// (إصلاح - باج Race Condition حقيقي، اكتشاف لاحق): isGuestMode فوق
// قيمتها الابتدائية "متفائلة" (false = عضو كامل الصلاحيات) لحد ما
// applyGuestModeRestrictions() في geofence.js تحسم القيمة الحقيقية
// بعد تأكيد Async من auth.js (auth:login / auth:confirmed-signed-out).
// المشكلة: من وجهة نظر أي كود بره الملف ده، مفيش فرق بين "زائر لسه
// مالوش تأكيد" و"عضو حقيقي متأكد منه" - الاتنين بيشوفوا isGuestMode
// = false بالظبط. ده كان بيسيب نافذة صغيرة (لحد ما الحسم الحقيقي
// يوصل) بيعدّي فيها أي فحص بسيط زي "if (window.isGuestMode) return;"
// حتى لزائر حقيقي.
//
// الحل: علم مستقل تمامًا بيجاوب على سؤال مختلف: "هل applyGuestModeRestrictions
// اتنفذت فعليًا مرة واحدة على الأقل ولا لسه؟" - مش تغيير القيمة
// الافتراضية لـisGuestMode نفسها (ده كان هيرجّع مشكلة فلاش الشريط
// للعضو الحقيقي). أي كود حساس (زي حاجز syncFromNativeStepCounter في
// js/sensors.js) لازم يتأكد من العلم ده = true الأول قبل ما يعتمد على
// قيمة isGuestMode خالص. بيتحول لـtrue مرة واحدة بس، جوه
// applyGuestModeRestrictions نفسها (شوف geofence.js)، ومبيرجعش false
// تاني أبداً بعد كده طول عمر الصفحة.
window.isGuestModeResolved = window.isGuestModeResolved || false;

// رابط احتياطي (Fallback) لو لأي سبب js/support-modal.js مش متحمّل
// (مثلاً خطأ في الشبكة) - في الحالة الطبيعية، الزرار بيفتح المودال
// مباشرة وميستخدمش الرابط ده أصلاً
const GUEST_SUPPORT_CONTACT_URL = 'https://wa.me/201207737965';

function updateGuestBannerSpacerHeight() {
    const banner = document.getElementById('guestModeBanner');
    const spacer = document.getElementById('guestBannerSpacer');
    if (!banner || !spacer) return;

    if (banner.classList.contains('is-visible')) {
        // بناخد الارتفاع الفعلي للشريط بعد ما يترندر عشان نديه للـ spacer
        const height = banner.getBoundingClientRect().height;
        spacer.style.height = `${height}px`;
    } else {
        spacer.style.height = '0px';
    }
}

function showGuestBanner() {
    const banner = document.getElementById('guestModeBanner');
    if (!banner) return;

    banner.classList.add('is-visible');
    // بنستنى الحركة تخلص (0.5s زي الـ CSS) قبل ما نظبط ارتفاع الـ spacer
    // بشكل نهائي، مع تحديث مبدئي فوري عشان الإحساس يبقى سريع
    updateGuestBannerSpacerHeight();
    window.setTimeout(updateGuestBannerSpacerHeight, 500);
}

function hideGuestBanner() {
    const banner = document.getElementById('guestModeBanner');
    if (!banner) return;

    banner.classList.remove('is-visible');
    updateGuestBannerSpacerHeight();
}

function handleGuestBannerLoginClick() {
    // (تحديث): بعد إضافة "تصفح كزائر" لأهل نزلة عبيد كمان (مش بس
    // الغرباء اللي اترفض تسجيلهم)، بقى ممكن الزائر يكون فعلاً من أهل
    // البلد ولسه ملوش حساب - فمينفعش نجبره على "تسجيل الدخول" بس زي
    // الأول. دلوقتي بنفتح شاشة الاختيار الكاملة (showAuthGate() من غير
    // باراميتر) وتسيبه يختار "إنشاء حساب" أو "تسجيل الدخول" بنفسه.
    // الأمان متأثرش خالص: لو هو فعلاً غريب عن البلد وضغط "إنشاء حساب"،
    // evaluateSignupLocationGate (onboarding.js) هيرفضه بنفس الطريقة
    // القديمة بالظبط وقت الضغط الفعلي - الفحص ده بيحصل هناك مش هنا.
    showAuthGate();
}

function handleGuestBannerSupportClick() {
    // الحالة الطبيعية: فتح مودال "الدعم الفني للمغتربين" (#supportModal)
    // اللي بيشرح خطوات التفعيل وبيحتوي على زرار واتساب المباشر
    // (شوف js/support-modal.js - المرحلة الثالثة الجزء 2)
    if (typeof window.openSupportModal === 'function') {
        window.openSupportModal();
        return;
    }

    // Fallback نادر: لو js/support-modal.js مش متحمّل لأي سبب، نرجع
    // للسلوك القديم (فتح واتساب مباشرة في تاب جديد) عشان الزرار يفضل
    // شغال دايماً بدل ما يتعطل كليةً
    window.open(GUEST_SUPPORT_CONTACT_URL, '_blank', 'noopener,noreferrer');
}

function handleGuestBannerCloseClick() {
    // إخفاء الشريط للجلسة الحالية فقط (من غير ما نغيّر isGuestMode
    // نفسها - لو المستخدم عمل Refresh، الشريط هيظهر تاني لو لسه زائر)
    hideGuestBanner();
}

function initGuestBanner() {
    const loginBtn = document.getElementById('guestBannerLoginBtn');
    const supportBtn = document.getElementById('guestBannerSupportBtn');
    const closeBtn = document.getElementById('guestBannerCloseBtn');

    if (loginBtn) {
        loginBtn.addEventListener('click', handleGuestBannerLoginClick);
    }
    if (supportBtn) {
        supportBtn.addEventListener('click', handleGuestBannerSupportClick);
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', handleGuestBannerCloseClick);
    }

    // إعادة ضبط ارتفاع الـ spacer لو حجم الشاشة اتغيّر (مثلاً تدوير
    // الموبايل) والشريط ظاهر وقتها
    window.addEventListener('resize', () => {
        if (document.getElementById('guestModeBanner')?.classList.contains('is-visible')) {
            updateGuestBannerSpacerHeight();
        }
    });

    // الإظهار المبدئي بناءً على القيمة الحالية لـ isGuestMode وقت تحميل
    // الصفحة (قيمة "متفائلة" مؤقتة قبل ما الفحص الجغرافي الفعلي يخلّص -
    // شوف المستمع تحت لتحديثها ديناميكياً بمجرد ما geofence.js يرد فعليًا)
    if (window.isGuestMode) {
        showGuestBanner();
    } else {
        hideGuestBanner();
    }

    // (إصلاح): كان الشريط بيتحدد بس مرة واحدة هنا فوق وقت DOMContentLoaded،
    // ومبيسمعش لحدث 'geofence:guest-mode-change' اللي geofence.js بيطلقه
    // فعليًا من applyGuestModeRestrictions() لما الفحص الجغرافي (GPS +
    // استدعاء check_and_update_user_location في Supabase) يخلّص لاحقًا
    // بشكل Async. يعني حتى لو الفحص اشتغل صح وحدد إن المستخدم برّه النطاق،
    // الشريط مكانش بيظهر أبدًا لأنه شاف القيمة الأولية (false غالبًا) بدري
    // قوي وسكت. المستمع ده بيخلي الشريط يستجيب فورًا لأي تحديث حقيقي لاحق،
    // سواء بعد أول فحص عند فتح التطبيق أو بعد أي retryGeofenceVerification
    // يدوي (زرار "حاول التحقق من موقعي تاني" لو موجود).
    document.addEventListener('geofence:guest-mode-change', (event) => {
        if (event.detail?.isGuestMode) {
            showGuestBanner();
        } else {
            hideGuestBanner();
        }
    });
}

document.addEventListener('DOMContentLoaded', initGuestBanner);