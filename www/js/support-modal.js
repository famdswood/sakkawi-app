/* ==================================================================
   سِكّاوي | js/support-modal.js
   ------------------------------------------------------------------
   المرحلة الثالثة (الجزء 2): إدارة مودال "الدعم الفني للمغتربين"
   (#supportModal) - الفتح، الإغلاق، وكل السلوكيات المرتبطة بيه.

   بيتفتح المودال لما زائر (isGuestMode = true) يضغط على زرار
   #guestBannerSupportBtn في شريط تنبيه الزوار (js/guest-banner.js -
   المرحلة الثالثة الجزء 1). في الجزء 1، الزرار ده كان بيفتح رابط
   واتساب مباشرة (window.open) - دلوقتي بعد تحميل السكريبت ده، بيتغيّر
   سلوكه عشان يفتح المودال ده بدلاً من كده (شوف hijackGuestBannerSupportBtn
   تحت)، والمودال نفسه هو اللي بيحتوي على زراير واتساب/تليجرام المباشرة.

   (تحديث): بقى type="module" (بدل سكريبت عادي مستقل) عشان يتكامل مع
   js/modal-history.js (pushModalState/closeModal) - زي أي مودال تاني
   في التطبيق - فزرار رجوع الموبايل/السحب من حافة الشاشة بقى بيقفل
   المودال ده بس (بدل ما يخرج من التطبيق أو يرجع لصفحة قبله بالغلط).
   ================================================================== */

import { pushModalState, closeModal } from './modal-history.js';

// مدة حركة الإغلاق بالمللي ثانية - لازم تتطابق مع transition-duration
// بتاعة .support-modal-card / .support-modal-backdrop في css/style.css
// (0.3s) عشان نعرف نستنى الحركة تخلص قبل ما نضيف كلاس "hidden"
// (اللي بيشيل المودال من الـ DOM flow فورًا من غير أي حركة خروج)
const SUPPORT_MODAL_CLOSE_ANIM_MS = 300;

// بنحتفظ بمرجع العنصر اللي كان عليه الـ focus قبل فتح المودال، عشان
// نرجّع الـ focus له تاني بعد الإغلاق (ممارسة أساسية لإمكانية الوصول
// عند التعامل مع أي Dialog/Modal)
let supportModalLastFocusedElement = null;

// تايمر إخفاء المودال بعد حركة الإغلاق - بنحتفظ بمرجعه عشان نقدر
// نلغيه لو المستخدم فتح المودال تاني بسرعة قبل ما التايمر القديم يخلص
let supportModalHideTimeoutId = null;

function getSupportModalElements() {
    return {
        modal: document.getElementById('supportModal'),
        card: document.getElementById('supportModalCard'),
        backdrop: document.getElementById('supportModalBackdrop'),
        closeBtn: document.getElementById('supportModalCloseBtn'),
    };
}

function openSupportModal() {
    const { modal } = getSupportModalElements();
    if (!modal) return;

    // لو كان في تايمر إخفاء شغّال من محاولة إغلاق سابقة (نادر، بس
    // ممكن يحصل لو المستخدم ضغط فتح/قفل بسرعة جدًا)، نلغيه عشان
    // ميقفلش المودال اللي إحنا دلوقتي بنفتحه من تحتنا
    if (supportModalHideTimeoutId) {
        window.clearTimeout(supportModalHideTimeoutId);
        supportModalHideTimeoutId = null;
    }

    // حفظ العنصر النشط حالياً عشان نرجّعله الـ focus بعد الإغلاق
    supportModalLastFocusedElement = document.activeElement;

    // شيل "hidden" (display:none) الأول عشان العنصر يبقى موجود في
    // الـ DOM flow، بعدين نضيف "is-open" في نفس الإطار (frame) اللي
    // بعده عشان الـ transition (Scale/Fade) يشتغل فعلاً من غير ما
    // يقفز فجأة لحالته النهائية من غير حركة
    modal.classList.remove('hidden');

    // إعادة تدفق بسيطة (Reflow) قبل إضافة "is-open" - نفس الأسلوب
    // المتبع في notifications.js لمودال #notificationsModal، عشان
    // نضمن إن المتصفح سجّل الحالة الابتدائية (opacity:0, scale:0.92)
    // قبل ما نبدأ الانتقال للحالة النهائية
    void modal.offsetWidth;

    modal.classList.add('is-open');

    // قفل تمرير الصفحة اللي وراء المودال وقت ما يكون مفتوح
    document.body.style.overflow = 'hidden';

    // تسجيل مستمع مفتاح ESC (بيتشال تلقائياً في closeSupportModal)
    document.addEventListener('keydown', handleSupportModalKeydown);

    // نقل الـ focus لزرار الإغلاق كبداية منطقية للتنقل بلوحة المفاتيح
    // جوه المودال (تأخير بسيط لحد ما حركة الدخول تبدأ)
    window.setTimeout(() => {
        const { closeBtn } = getSupportModalElements();
        if (closeBtn) closeBtn.focus();
    }, 50);

    // تسجيل خطوة جديدة في تاريخ المتصفح - عشان زرار رجوع الموبايل/
    // السحب من حافة الشاشة يقفل المودال ده بس (عن طريق hideSupportModal
    // الخام تحت) بدل ما يخرج من التطبيق أو يرجع لصفحة قبله بالغلط
    pushModalState(hideSupportModal);
}

/**
 * الإخفاء الخام لمودال الدعم فقط - بيتسجل مع pushModalState فوق
 * ويتنادى تلقائيًا سواء المستخدم قفل المودال بزرار X/الخلفية/ESC (عن
 * طريق closeSupportModal تحت) أو بزرار رجوع الموبايل مباشرة. استخدم
 * closeSupportModal() من أي مكان تاني عشان يتزامن مع تاريخ المتصفح.
 */
function hideSupportModal() {
    const { modal } = getSupportModalElements();
    if (!modal || !modal.classList.contains('is-open')) return;

    // شيل "is-open" فورًا عشان حركة الخروج (Scale/Fade عكسي) تبدأ
    modal.classList.remove('is-open');

    // إعادة تفعيل تمرير الصفحة
    document.body.style.overflow = '';

    // إلغاء تسجيل مستمع مفتاح ESC لحد ما المودال يتفتح تاني
    document.removeEventListener('keydown', handleSupportModalKeydown);

    // نستنى حركة الخروج تخلص (SUPPORT_MODAL_CLOSE_ANIM_MS) قبل ما
    // نضيف "hidden" فعليًا، عشان المودال يفضل مرئي أثناء حركة اختفائه
    // بدل ما يختفي فجأة في نص الحركة
    supportModalHideTimeoutId = window.setTimeout(() => {
        modal.classList.add('hidden');
        supportModalHideTimeoutId = null;
    }, SUPPORT_MODAL_CLOSE_ANIM_MS);

    // إرجاع الـ focus للعنصر اللي كان نشط قبل فتح المودال (زرار الدعم
    // في شريط الزوار غالبًا)
    if (supportModalLastFocusedElement && typeof supportModalLastFocusedElement.focus === 'function') {
        supportModalLastFocusedElement.focus();
    }
    supportModalLastFocusedElement = null;
}

/**
 * الإغلاق العام لمودال الدعم - الدالة اللي زرار X، الضغط على الخلفية،
 * ومفتاح ESC لازم ينادوا عليها بدل hideSupportModal مباشرة، عشان
 * تستهلك خطوة تاريخ المتصفح اللي اتضافت وقت الفتح (pushModalState فوق)
 * وبالتالي يفضل زرار رجوع الموبايل متزامن مع اللي المستخدم شايفه على الشاشة
 */
function closeSupportModal() {
    const { modal } = getSupportModalElements();
    if (!modal || !modal.classList.contains('is-open')) return;
    closeModal();
}

function handleSupportModalBackdropClick(event) {
    // بنتأكد إن الضغطة كانت على الخلفية نفسها بالظبط (مش على أي
    // عنصر جوه الكارت اتحركت الضغطة لبره منه بالخطأ أثناء drag مثلاً)
    if (event.target && event.target.id === 'supportModalBackdrop') {
        closeSupportModal();
    }
}

function handleSupportModalKeydown(event) {
    if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        closeSupportModal();
    }
}

function initSupportModal() {
    const { modal, backdrop, closeBtn } = getSupportModalElements();
    if (!modal) return;

    if (closeBtn) {
        closeBtn.addEventListener('click', closeSupportModal);
    }
    if (backdrop) {
        backdrop.addEventListener('click', handleSupportModalBackdropClick);
    }

    // ملاحظة: زراير واتساب/تليجرام جوه المودال (#supportModalWhatsappBtn
    // و #supportModalTelegramBtn) هي روابط <a> عادية بـ target="_blank"،
    // فمش محتاجة أي JS إضافي عشان تفتح - المتصفح بيتصرف فيها لوحده.
    // مش بنقفل المودال تلقائيًا عند الضغط عليها عشان المستخدم يقدر
    // يرجع يختار القناة التانية بسهولة لو حب.
}

// بنعرّض openSupportModal على window عشان js/guest-banner.js (المرحلة
// الثالثة - الجزء 1) يقدر ينادي عليها مباشرة من handleGuestBannerSupportClick
// بدل ما يفتح رابط واتساب مباشرة زي ما كان بيعمل قبل كده. الطريقة دي
// (تعريض دالة على window بدل التلاعب في ترتيب الـ event listeners على
// نفس الزرار) أنضف وأضمن من إننا نعتمد على ترتيب تحميل السكريبتات
window.openSupportModal = openSupportModal;

document.addEventListener('DOMContentLoaded', initSupportModal);