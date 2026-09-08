/* ==================================================================
   سِكّاوي | js/support-chat.js
   ------------------------------------------------------------------
   المرحلة 8: رسائل الدعم لأكونتك الشخصي. نظام منفصل تماماً عن مودال
   "الدعم الفني للمغتربين" القديم (#supportModal / support-modal.js) -
   ده مش بيتلمس خالص من الملف ده.

   (تعديل) #supportChatModal بقى شاشة مستقلة تغطي الشاشة بالكامل (مش
   نافذة منبثقة/بوب أب فوق المحتوى) - شوف التعديل المقابل في index.html
   وstyle.css. بيتلبس 3 أشكال حسب هوية المستخدم الحالي (مقارنة بـ
   ADMIN_USER_ID تحت):
     - مستخدم عادي: بيفتحه بس من زرار "إرسال رسالة" في بروفايل الأدمن
       العام (شوف renderPublicProfileSupportButton في profiles.js) -
       بيشوف محادثته هو مع الأدمن على طول، من غير أي قائمة محادثات.
     - الأدمن (من صندوق الرسائل): بيفتحه من الزرار العائم
       #supportInboxFab - بيشوف قائمة كل المحادثات الأول، وبالضغط على
       واحدة يتنقل لمحادثتها.
     - الأدمن (يبدأ هو محادثة جديدة): بيفتحه من زرار "إرسال رسالة" اللي
       بيظهر على أي بروفايل عام غيره هو (openSupportChatAsAdminWithUser)
       - بيفتح شات مباشر مع صاحب البروفايل ده على طول، حتى لو مفيش
       رسايل بينهم لسه.

   (تعديل) مزامنة لحظية كاملة عن طريق Supabase Realtime - أي رسالة
   جديدة (من أي ناحية) بتظهر في المحادثة المفتوحة، وقائمة محادثات
   الأدمن + شارة العداد بتتحدث فوراً من غير أي ريفريش يدوي (شوف قسم
   11ب تحت).

   نفس فلسفة notifications.js في التعامل مع هوية المستخدم (أحداث
   'auth:login'/'auth:signed-out' بدل استيراد مباشر)، ونفس نظام
   modal-history.js (pushModalState/closeModal) لدعم زرار الرجوع
   بالموبايل.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { pushModalState, closeModal } from './modal-history.js';
// نقطة "أونلاين الآن" فوق صورة الطرف التاني في الشات - مقيّدة (نفسي/
// صديق مقبول/أدمن بس) شوف الشرح الكامل في js/presence.js. استيراد
// مسموح لأن presence.js ملف مستقل ومفيش فيه أي استيراد من support-chat.js
// (عكس profiles.js اللي ممنوع نستورد منه هنا - شوف تعليق أول الملف)
import { presenceDotHtml, loadAndApplyPresence } from './presence.js';
// (تعديل) عشان الضغط على هوية الطرف التاني في الهيدر (صورة + اسم) يوصّل
// لبروفايله العام - نفس الدالة اللي بتفتح بروفايل أي مستخدم من لوحة
// الصدارة (شوف setPeerHeader تحت). لازم يكون openPublicProfile مُصدّرة
// من profiles.js وبتاخد userId - لو الاسم أو التوقيع مختلف عندك هناك
// عدّل الاستدعاء في setPeerHeader بس.
import { openPublicProfile } from './profiles.js';

/* ------------------------------------------------------------------
   1) حالة الموديول
   ------------------------------------------------------------------ */

/**
 * معرّف حساب الأدمن الوحيد في التطبيق - نفس القيمة المستخدمة في
 * profiles.js (ADMIN_USER_ID) بالظبط. لازم الاتنين يفضلوا متطابقين -
 * لو غيّرت واحد غيّر التاني معاه.
 */
const ADMIN_USER_ID = '1d8feb21-c37f-4b27-a028-a668078dbbb5';

/** المستخدم الحالي (شكل user بتاع Supabase Auth) - null لو مفيش تسجيل دخول */
let currentUser = null;

/** true لو المستخدم الحالي هو الأدمن نفسه */
let isCurrentUserAdmin = false;

/** الوضع الحالي جوه المودال: 'user_thread' (مستخدم عادي بيكلم الأدمن)، 'admin_list' (قائمة المحادثات)، أو 'admin_thread' (الأدمن فاتح محادثة معينة) */
let currentViewMode = 'user_thread';

/** معرّف صاحب المحادثة المعروضة حالياً (نفسه لو مستخدم عادي، أو المستخدم المختار لو الأدمن جوه محادثة) - null لو مفيش محادثة مفتوحة بعد */
let activeConversationUserId = null;

/** نسخة محلية من رسايل المحادثة المفتوحة حالياً، الأقدم أولاً (زي ما بتتعرض) */
let activeConversationMessages = [];

/** true أثناء إرسال رسالة (منع الضغط المزدوج على زرار الإرسال) */
let isSending = false;

/**
 * (تعديل) صورة بروفايل احتياطية - نفس أفاتار "الشخص المجهول" (سيلويت
 * دائرة+كتفين) المستخدم فعلياً في أغلب التطبيق (بودكاست المتصدرين
 * ونافذة الإشعارات في index.html)، بدل رابط placehold.co القديم اللي
 * كان بيطلع علامات استفهام لأنه مش بيعرض نص عربي صح.
 */
const FALLBACK_AVATAR = "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20100%20100%27%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2750%27%20r%3D%2750%27%20fill%3D%27%2314171F%27%2F%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2738%27%20r%3D%2716%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%2F%3E%3Cpath%20d%3D%27M20%2084c0-18%2013.5-30%2030-30s30%2012%2030%2030%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E";

/**
 * (تعديل) قناة Realtime بتاعة المحادثة المفتوحة حالياً - بتتشترك فيها
 * وقت فتح أي ثريد (مستخدم عادي أو أدمن) عشان أي رسالة جديدة (من أي
 * ناحية) تتضاف فوراً من غير ريفريش أو إعادة فتح. بتتقفل/تتغيّر مع أي
 * تغيير في activeConversationUserId (شوف subscribeToActiveConversation/
 * unsubscribeFromActiveConversation تحت).
 */
let activeConversationChannel = null;

/**
 * (جديد) نقط "بيكتب…" الحية - بتتبعت وتتستقبل عن طريق Realtime Broadcast
 * على نفس activeConversationChannel فوق (منفصلة تماماً عن رسايل الداتابيز
 * نفسها - إشارة لحظية بس، من غير ما تتسجل في support_messages خالص).
 */

/** آخر حالة "بيكتب" بعتناها فعلاً للطرف التاني - عشان منبعتش نفس الحالة كذا مرة على الفاضي مع كل حرف */
let lastSentTypingState = false;

/** تايمر بيبعت "بطل يكتب" تلقائياً لو المستخدم سكت عن الكتابة شوية من غير ما يبعت أو يمسح الكلام (شوف handleTypingInput تحت) */
let typingStopTimer = null;

/** تايمر إخفاء مؤشر "بيكتب…" عندي احتياطاً - لو إشارة "بطل يكتب" بتاعة الطرف التاني ضاعت (قفل نت مفاجئ مثلاً) بيتشال المؤشر لوحده بعد فترة معقولة */
let typingIndicatorAutoHideTimer = null;

/**
 * (تعديل) الفعل الحالي لزرار الهيدر الموحّد (#btnCloseSupportChat) - إما
 * closeModal (يقفل الشاشة كلها) أو showConversationsList (يرجع لقائمة
 * محادثات الأدمن). بيتغيّر مع setHeaderExitMode() تحت بدل ما يبقى فيه
 * زرارين منفصلين ليهم نفس الهدف عملياً (رجوع/خروج) وبيلخبطوا.
 */
let headerExitAction = () => closeModal();

/**
 * (تعديل) قناة Realtime عامة خاصة بالأدمن بس - مشتركة طول ما هو مسجل
 * دخول (مش بس وقت فتح المودال)، بتتابع أي رسالة جديدة من أي مستخدم
 * عشان تحدّث شارة العداد على الزرار العائم فوراً، وتحدّث قائمة/ثريد
 * المحادثات لو المودال مفتوح وقتها. دي منفصلة عن activeConversationChannel
 * فوق عمداً (نطاقها أوسع من محادثة واحدة بس).
 */
let adminGlobalChannel = null;

/**
 * (جديد) قناة Realtime عامة لأي مستخدم عادي (مش الأدمن) - مشتركة طول ما
 * هو مسجل دخول، بتتابع رسايل الأدمن الجديدة الموجّهة لمحادثته هو بس
 * (sender_id = هو نفسه)، عشان تتعلّم "استلمها" (delivered_at) أول ما
 * توصله حتى لو شات الدعم مقفول أصلاً - مقابلة لـ adminGlobalChannel فوق
 * بس من ناحية المستخدم العادي، ونطاقها أضيق (محادثته هو بس مش الجدول كله).
 */
let userInboxChannel = null;

/** آخر Timeout بتاع الضغطة المطولة على فقاعة رسالة (شوف bindMessageLongPress تحت) - بيتلغي لو المستخدم رفع صباعه بدري أو حرّك */
let longPressTimer = null;


/* ------------------------------------------------------------------
   2) نقطة الدخول العامة
   ------------------------------------------------------------------ */

/** تُستدعى مرة واحدة من app.js (initApp) زي باقي دوال initXxxUI */
export function initSupportChat() {
    bindStaticListeners();

    document.addEventListener('auth:login', (event) => {
        handleUserSignedIn(event.detail.user);
    });

    document.addEventListener('auth:signed-out', () => {
        handleUserSignedOut();
    });
}

/**
 * تُفتح من زرار "إرسال رسالة" في بروفايل الأدمن العام (profiles.js) -
 * مخصصة للمستخدم العادي بس (مش الأدمن نفسه، ومش لو مفيش تسجيل دخول)
 */
export async function openSupportChatWithAdmin() {
    if (!currentUser || isCurrentUserAdmin) return;

    currentViewMode = 'user_thread';
    activeConversationUserId = currentUser.id;

    showModal();
    setPeerHeader(ADMIN_USER_ID);
    setHeaderExitMode('close');
    showThreadView();
    setThreadLoading();

    await loadAndRenderConversation(currentUser.id);
    await markAdminMessagesAsReadForMe();
    subscribeToActiveConversation(currentUser.id);
}

/**
 * (تعديل) بتفتح شات مباشر بين الأدمن وأي مستخدم تاني، حتى لو مفيش
 * أي رسايل اتبعتت لسه بينهم (يعني الأدمن هو اللي بيبدأ المحادثة) -
 * مستخدمة من زرار "إرسال رسالة" اللي بيظهر للأدمن على أي بروفايل عام
 * غير بروفايله هو (شوف renderPublicProfileSupportButton في profiles.js).
 * زرار الرجوع بيظهر عشان الأدمن يقدر يرجع لقائمة كل المحادثات لو حب.
 * @param {string} targetUserId
 */
export async function openSupportChatAsAdminWithUser(targetUserId) {
    if (!isCurrentUserAdmin || !targetUserId) return;

    currentViewMode = 'admin_thread';
    activeConversationUserId = targetUserId;

    showModal();
    setPeerHeader(targetUserId);
    setHeaderExitMode('back');
    showThreadView();
    setThreadLoading();

    await loadAndRenderConversation(targetUserId);
    await supabaseClient.rpc('admin_mark_support_conversation_read', { p_user_id: targetUserId });
    await supabaseClient.rpc('admin_mark_conversation_delivered_and_read', { p_user_id: targetUserId });
    refreshAdminUnreadBadge();
    subscribeToActiveConversation(targetUserId);
}

/** يستخرج معرّف الأدمن الحالي - مستخدمة من profiles.js عشان تقرر تعرض زرار "إرسال رسالة" ولا لأ */
export function getSupportAdminUserId() {
    return ADMIN_USER_ID;
}


/* ------------------------------------------------------------------
   3) هوية المستخدم الحالي
   ------------------------------------------------------------------ */

function handleUserSignedIn(user) {
    currentUser = user;
    isCurrentUserAdmin = Boolean(user && user.id === ADMIN_USER_ID);

    const fabBtn = document.getElementById('supportInboxFab');
    if (fabBtn) fabBtn.classList.toggle('hidden', !isCurrentUserAdmin);

    if (isCurrentUserAdmin) {
        refreshAdminUnreadBadge();
        subscribeAdminGlobalChannel();
        // (جديد) بمجرد ما الأدمن يفتح التطبيق وعنده نت، أي رسالة مستخدم
        // اتبعتت وهو أوفلاين تتعلّم "استلمها" فوراً - مش لازم ياخد باله
        // إنه فاتح ثريد صاحبها بالظبط. الاشتراك في subscribeAdminGlobalChannel
        // فوق بيغطي أي رسالة جديدة بعد كده وهو أونلاين، والسطر ده بيغطي
        // اللي اتبعت قبل ما يفتح التطبيق.
        markAllPendingMessagesDeliveredAsAdmin();
    } else {
        // (جديد) نفس الفكرة من ناحية المستخدم العادي - مش لازم شات الدعم
        // يكون مفتوح عشان رسالة الأدمن تتعلّم "استلمها"، لا في اللحظة اللي
        // بتوصله فيها وهو أونلاين (subscribeUserInboxChannel)، ولا حتى لو
        // كانت اتبعتت أصلاً قبل ما يفتح التطبيق (السطر التاني تحت)
        subscribeUserInboxChannel();
        markPendingAdminMessagesDeliveredForMe();
    }
}

function handleUserSignedOut() {
    currentUser = null;
    isCurrentUserAdmin = false;
    activeConversationUserId = null;
    activeConversationMessages = [];

    const fabBtn = document.getElementById('supportInboxFab');
    if (fabBtn) fabBtn.classList.add('hidden');

    unsubscribeFromActiveConversation();
    unsubscribeAdminGlobalChannel();
    unsubscribeUserInboxChannel();

    hideModal();
}


/* ------------------------------------------------------------------
   4) ربط الأحداث الثابتة (زرار الإغلاق، الرجوع، الإرسال، الزرار العائم)
   ------------------------------------------------------------------ */

function bindStaticListeners() {
    // (تعديل) زرار واحد بس دلوقتي (btnCloseSupportChat) بيعمل مهمتين حسب
    // السياق - رجوع لقائمة المحادثات، أو إغلاق الشاشة بالكامل. الفعل
    // الفعلي بيتحدد من setHeaderExitMode() في كل مكان كان بينادي على
    // toggleBackButton() قديماً، ومتخزّن في headerExitAction تحت.
    const closeBtn = document.getElementById('btnCloseSupportChat');
    if (closeBtn) closeBtn.addEventListener('click', () => headerExitAction());

    const sendBtn = document.getElementById('supportChatSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', handleSendClick);

    const inputEl = document.getElementById('supportChatInput');
    if (inputEl) {
        // Enter بيبعت، Shift+Enter بيعمل سطر جديد - نفس التوقع المعتاد
        // في أي شات؛ منعتمدش على submit فورم لأنه مفيش form هنا أصلاً
        inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSendClick();
            }
        });

        // (جديد) أي كتابة فعلية (مش بس Enter) بتبعت إشارة "بيكتب…" لحظية
        // للطرف التاني - شوف handleTypingInput تحت
        inputEl.addEventListener('input', handleTypingInput);
    }

    const fabBtn = document.getElementById('supportInboxFab');
    if (fabBtn) fabBtn.addEventListener('click', openAdminInbox);

    // (تعديل) بعد ما بقت شاشة مستقلة تغطي التطبيق بالكامل (مش نافذة
    // منبثقة فوق خلفية شفافة)، مفيش "برّه اللوحة" تقدر تضغط عليه أصلاً -
    // الإغلاق بقى بس عن طريق زرار ✕ أو زرار الرجوع في الموبايل

    // (جديد) الضغط المطوّل على أي رسالة "بتاعتي أنا" (.support-msg-own)
    // بيفتح كارت معلومات الاستلام/المشاهدة - شوف bindMessageLongPress تحت
    bindMessageLongPress();
}

/**
 * (جديد) الضغط المطوّل (500ms) على فقاعة رسالة بعتّها أنا - بيفتح كارت
 * معلومات "اترسلت/استلمها/شافها" بتوقيتها (شوف showMessageInfoPopover).
 * event delegation على #supportChatMessagesList مرة واحدة بس (الحاوية
 * نفسها ثابتة في الـ DOM، بس اللي بيتغيّر جواها هو innerHTML مع كل
 * renderConversationMessages)، فمفيش داعي نعيد الربط مع كل رسم.
 */
function bindMessageLongPress() {
    const messagesEl = document.getElementById('supportChatMessagesList');
    if (!messagesEl) return;

    const LONG_PRESS_MS = 500;

    const start = (event) => {
        const bubble = event.target.closest('.support-msg-own');
        if (!bubble) return;

        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
            showMessageInfoPopover(bubble.dataset.messageId);
        }, LONG_PRESS_MS);
    };

    const cancel = () => clearTimeout(longPressTimer);

    messagesEl.addEventListener('touchstart', start, { passive: true });
    messagesEl.addEventListener('touchend', cancel);
    messagesEl.addEventListener('touchmove', cancel);
    messagesEl.addEventListener('touchcancel', cancel);
    // (دعم الديسكتوب) نفس فكرة الضغطة المطولة بالماوس - مفيدة وقت التجربة
    // على المتصفح، مش بس الموبايل
    messagesEl.addEventListener('mousedown', start);
    messagesEl.addEventListener('mouseup', cancel);
    messagesEl.addEventListener('mouseleave', cancel);
}

/**
 * (جديد) كارت معلومات رسالة واحدة - بيتفتح بالضغطة المطولة، وبيوريك
 * توقيت الإرسال دايماً، وتوقيت الاستلام والمشاهدة لو حصلوا (أو رسالة
 * "لسه" لو لأ). بيتبني ديناميكياً ويتحط في نص الشاشة فوق كل حاجة، وبيقفل
 * بالضغط على أي حتة برّه الكارت أو زرار ✕ بتاعه.
 * @param {string} messageId
 */
function showMessageInfoPopover(messageId) {
    const msg = activeConversationMessages.find((m) => m.id === messageId);
    if (!msg) return;

    hideMessageInfoPopover();

    const rows = [
        { label: 'اترسلت', time: msg.created_at, done: true },
        { label: 'استلمها', time: msg.delivered_at, done: Boolean(msg.delivered_at || msg.read_at) },
        { label: 'شافها', time: msg.read_at, done: Boolean(msg.read_at) },
    ];

    const rowsHtml = rows.map((row) => `
        <div class="flex items-center justify-between gap-3 py-2 ${row.done ? '' : 'opacity-40'}">
            <span class="text-sm font-bold text-lux-100">${row.label}</span>
            <span class="text-xs font-medium text-lux-400">${row.done ? formatFullDateTimeArabicLocal(row.time) : 'لسه لأ'}</span>
        </div>
    `).join('<div class="h-px bg-lux-800"></div>');

    const overlay = document.createElement('div');
    overlay.id = 'supportMsgInfoOverlay';
    overlay.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-6';
    overlay.innerHTML = `
        <div class="w-full max-w-xs bg-lux-900 border border-gold-500/15 rounded-2xl p-4 shadow-2xl" role="dialog" aria-label="معلومات الرسالة">
            <div class="flex items-center justify-between mb-1">
                <h3 class="text-sm font-extrabold text-lux-50">معلومات الرسالة</h3>
                <button type="button" id="supportMsgInfoCloseBtn" aria-label="إغلاق"
                        class="w-7 h-7 flex items-center justify-center rounded-full text-lux-400 hover:text-lux-100 hover:bg-lux-800/70 transition-colors">✕</button>
            </div>
            <div class="divide-y-0">${rowsHtml}</div>
            <button type="button" id="supportMsgInfoDeleteBtn"
                    class="mt-3 w-full py-2 rounded-xl text-xs font-extrabold text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 transition-colors">
                حذف الرسالة
            </button>
        </div>
    `;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) hideMessageInfoPopover();
    });

    document.body.appendChild(overlay);
    document.getElementById('supportMsgInfoCloseBtn')?.addEventListener('click', hideMessageInfoPopover);

    // (جديد) زرار "حذف الرسالة" - بيقفل كارت المعلومات ده ويفتح كارت
    // تأكيد منفصل (showDeleteConfirmDialog تحت) بدل ما يحذف على طول،
    // عشان محدش يحذف رسالة بالغلط من ضغطة واحدة
    document.getElementById('supportMsgInfoDeleteBtn')?.addEventListener('click', () => {
        hideMessageInfoPopover();
        showDeleteConfirmDialog(messageId);
    });
}

function hideMessageInfoPopover() {
    document.getElementById('supportMsgInfoOverlay')?.remove();
}

/**
 * (جديد) كارت تأكيد حذف رسالة - بنفس هوية باقي كروت الشات (bg-lux-900 +
 * حدود gold-500 خفيفة)، بيتفتح من زرار "حذف الرسالة" في كارت المعلومات
 * فوق. زرار "حذف" بيتعطّل وقت الطلب نفسه (منع ضغط مزدوج) وبيرجع لحالته
 * لو فشل الحذف عشان المستخدم يقدر يحاول تاني، وبيقفل الكارت لوحده لو نجح.
 * @param {string} messageId
 */
function showDeleteConfirmDialog(messageId) {
    hideDeleteConfirmDialog();

    const overlay = document.createElement('div');
    overlay.id = 'supportMsgDeleteConfirmOverlay';
    overlay.className = 'fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-6';
    overlay.innerHTML = `
        <div class="w-full max-w-xs bg-lux-900 border border-gold-500/15 rounded-2xl p-4 shadow-2xl" role="alertdialog" aria-label="تأكيد حذف الرسالة">
            <h3 class="text-sm font-extrabold text-lux-50 mb-1.5">حذف الرسالة؟</h3>
            <p class="text-xs font-medium text-lux-400 leading-relaxed mb-4">هتتحذف نهائياً من المحادثة عند الطرفين، ومفيش رجوع فيها بعد كده.</p>
            <div class="flex items-center gap-2">
                <button type="button" id="supportMsgDeleteCancelBtn"
                        class="flex-1 py-2 rounded-xl text-xs font-extrabold text-lux-100 bg-lux-800 hover:bg-lux-800/70 transition-colors">إلغاء</button>
                <button type="button" id="supportMsgDeleteConfirmBtn"
                        class="flex-1 py-2 rounded-xl text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-500 transition-colors">حذف</button>
            </div>
        </div>
    `;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) hideDeleteConfirmDialog();
    });

    document.body.appendChild(overlay);
    document.getElementById('supportMsgDeleteCancelBtn')?.addEventListener('click', hideDeleteConfirmDialog);

    const confirmBtn = document.getElementById('supportMsgDeleteConfirmBtn');
    confirmBtn?.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'جاري الحذف…';

        const success = await performDeleteMessage(messageId);

        if (!success) {
            // (جديد) فشل الحذف (مشكلة نت/سيرفر مثلاً) - نرجّع الزرار لحالته
            // الأصلية عشان المستخدم يقدر يحاول تاني من غير ما يقفل الكارت
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'حاول تاني';
            return;
        }

        hideDeleteConfirmDialog();
    });
}

function hideDeleteConfirmDialog() {
    document.getElementById('supportMsgDeleteConfirmOverlay')?.remove();
}

/**
 * (جديد) حذف رسالة فعلياً من support_messages - RLS المفروض تسمح بس
 * لصاحب الرسالة (sender_id = auth.uid() بتاعه) إنه يحذف رسالته، فمفيش
 * داعي نتحقق من isMine تاني هنا (لو حد حاول يحذف رسالة مش بتاعته، قاعدة
 * البيانات هترفض العملية من نفسها). لو نجح الحذف، بنشيلها من النسخة
 * المحلية (activeConversationMessages) ونعيد الرسم على طول - الطرف
 * التاني هيشوفها بتتشال لوحدها لحظياً عن طريق DELETE listener في
 * subscribeToActiveConversation تحت.
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
async function performDeleteMessage(messageId) {
    const { error } = await supabaseClient
        .from('support_messages')
        .delete()
        .eq('id', messageId);

    if (error) {
        console.error('[support-chat.js] فشل حذف الرسالة:', error);
        return false;
    }

    activeConversationMessages = activeConversationMessages.filter((m) => m.id !== messageId);
    renderConversationMessages();
    return true;
}

/** توقيت كامل (تاريخ + ساعة) لكارت معلومات الرسالة - أدق من formatClockTimeArabicLocal اللي بيورّي الساعة بس */
function formatFullDateTimeArabicLocal(isoDateString) {
    if (!isoDateString) return '';

    return new Date(isoDateString).toLocaleString('ar-EG', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        numberingSystem: 'latn',
    });
}

/** فتح صندوق الرسائل من الزرار العائم - الأدمن بس (الزرار أصلاً مخفي لغيره، ده احتياط إضافي) */
function openAdminInbox() {
    if (!isCurrentUserAdmin) return;

    unsubscribeFromActiveConversation();

    currentViewMode = 'admin_list';
    activeConversationUserId = null;

    showModal();
    clearPeerHeader();
    setTitle('صندوق رسائل الدعم');
    setHeaderExitMode('close');
    showListView();
    loadAndRenderConversationsList();
}


/* ------------------------------------------------------------------
   5) فتح/قفل المودال (نفس نمط hideAvatarLightbox في profiles.js)
   ------------------------------------------------------------------ */

function showModal() {
    const modalEl = document.getElementById('supportChatModal');
    if (!modalEl) return;

    modalEl.classList.remove('hidden');
    modalEl.classList.add('flex');

    pushModalState(hideSupportChatModal);
}

/** الإخفاء الخام فقط - استخدم closeModal() من أي مكان تاني عشان يتزامن مع تاريخ المتصفح */
function hideSupportChatModal() {
    hideMessageInfoPopover();
    hideDeleteConfirmDialog();

    const modalEl = document.getElementById('supportChatModal');
    if (modalEl) {
        modalEl.classList.add('hidden');
        modalEl.classList.remove('flex');
    }

    // (تعديل) قفلنا الشاشة، فمفيش داعي نفضل مشتركين في قناة محادثة
    // بعينها - قناة الأدمن العامة (adminGlobalChannel) بتفضل شغالة
    // لوحدها عشان شارة العداد تفضل محدّثة حتى والمودال مقفول
    unsubscribeFromActiveConversation();

    activeConversationUserId = null;
    activeConversationMessages = [];
}

function hideModal() {
    const modalEl = document.getElementById('supportChatModal');
    if (modalEl && !modalEl.classList.contains('hidden')) {
        closeModal();
    }
}


/* ------------------------------------------------------------------
   6) التبديل بين "قائمة المحادثات" و"محادثة واحدة" (الأدمن بس بيستخدم الاتنين)
   ------------------------------------------------------------------ */

function showListView() {
    document.getElementById('supportChatListView')?.classList.remove('hidden');
    document.getElementById('supportChatThreadView')?.classList.add('hidden');
    document.getElementById('supportChatEmptyState')?.classList.add('hidden');
}

function showThreadView() {
    document.getElementById('supportChatListView')?.classList.add('hidden');
    document.getElementById('supportChatThreadView')?.classList.remove('hidden');
    document.getElementById('supportChatThreadView')?.classList.add('flex');
    document.getElementById('supportChatEmptyState')?.classList.add('hidden');
}

function setTitle(text) {
    const titleEl = document.getElementById('supportChatTitle');
    if (titleEl) titleEl.textContent = text;
}

/**
 * (تعديل) بتظبط شكل وفعل زرار الهيدر الموحّد (#btnCloseSupportChat) حسب
 * الشاشة الحالية - محل toggleBackButton/closeBtn المنفصلين قديماً:
 *   - 'back'  → سهم "→"، بيرجع لقائمة محادثات الأدمن (showConversationsList)
 *   - 'close' → علامة "✕"، بيقفل شات الدعم بالكامل (closeModal)
 * @param {'back'|'close'} mode
 */
function setHeaderExitMode(mode) {
    const btn = document.getElementById('btnCloseSupportChat');
    if (!btn) return;

    if (mode === 'back') {
        btn.textContent = '→';
        btn.setAttribute('aria-label', 'رجوع لقائمة المحادثات');
        headerExitAction = showConversationsList;
    } else {
        btn.textContent = '✕';
        btn.setAttribute('aria-label', 'إغلاق');
        headerExitAction = () => closeModal();
    }
}

/**
 * (تعديل) بتعرض هوية الطرف التاني في الثريد المفتوح دلوقتي (صورة +
 * اسمه) بدل عنوان #supportChatTitle الثابت، وبتخليها قابلة للضغط عشان
 * تقفل شات الدعم وتوصّل لبروفايله العام - سواء المستخدم العادي بيكلم
 * الأدمن، أو الأدمن فاتح محادثة مستخدم معين (مفيش فرق في المنطق، بس
 * peerId بيتغيّر حسب مين فاتح المودال).
 * @param {string} peerId - معرّف صاحب الصورة/الاسم المطلوب عرضهم
 */
async function setPeerHeader(peerId) {
    const peerBtn = document.getElementById('supportChatPeerBtn');
    const avatarEl = document.getElementById('supportChatPeerAvatar');
    const nameEl = document.getElementById('supportChatPeerName');
    const titleEl = document.getElementById('supportChatTitle');
    const presenceEl = document.getElementById('supportChatPeerPresenceDot');
    if (!peerBtn || !avatarEl || !nameEl) return;

    // نعرض هوية الطرف التاني بدل العنوان الثابت على طول، مع صورة/اسم
    // احتياطيين لحد ما يوصل رد Supabase تحت
    titleEl?.classList.add('hidden');
    peerBtn.classList.remove('hidden');
    peerBtn.classList.add('flex');
    avatarEl.src = FALLBACK_AVATAR;
    nameEl.textContent = '...';

    // نقطة الأونلاين بتتفعّل/تتخفي حسب صلاحية الرؤية الفعلية على السيرفر
    // (شوف js/presence.js) - مش بس تجميل واجهة
    if (presenceEl) {
        presenceEl.setAttribute('data-presence-avatar', peerId);
        loadAndApplyPresence([peerId]);
    }

    peerBtn.onclick = () => {
        // (تصحيح نهائي) اللي كان بيحصل: closeModal() بتعمل history.back()
        // فعلي (خطوة رجوع حقيقية في تاريخ المتصفح)، وده بيتعارض مع
        // replaceModalState اللي جوه openPublicProfile({replaceHistory:true})
        // واللي بتعمل history.replaceState() (استبدال الخطوة الحالية من
        // غير أي رجوع). لما الاتنين بيحصلوا مع بعض، أحياناً بيلغوا بعض
        // (عند الأدمن - كان فيه خطوات تاريخ زيادة تحته فامتصت المشكلة)،
        // وأحياناً بيمسحوا خطوة الأساس بتاعة التطبيق نفسه (عند مستخدم عادي
        // لسه في أول خطوة) - وده اللي كان بيطلّع المستخدم برّه المتصفح
        // خالص لما يدوس رجوع بعدها.
        //
        // الحل الصح: منستخدمش closeModal() هنا خالص - بننده على
        // hideSupportChatModal() مباشرة (الإخفاء الخام بس، من غير أي لمس
        // لتاريخ المتصفح - شوف تعليقها فوق)، وبنسيب replaceModalState جوه
        // openPublicProfile هي اللي تستبدل خطوة شات الدعم بخطوة صفحة
        // البروفايل في عملية واحدة نضيفة - بالظبط الحالة اللي
        // replaceHistory:true اتعمِلت عشانها أصلاً (شوف تعليقها في profiles.js).
        hideSupportChatModal();
        openPublicProfile(peerId, { replaceHistory: true });
    };

    // (تصحيح) profiles نفسها متاحة بس لصاحبها (RLS بيسمح بقراءة صفك انت
    // بس - نفس اللي بيخلي fetchPublicProfileRow في profiles.js يستخدم
    // public_profiles بدلها لأي بروفايل غير بروفايلي أنا). كنا بنقرا من
    // profiles غلط هنا فكان دايماً بيرجع صفر صفوف لأي peerId غير المستخدم
    // الحالي نفسه (ده اللي كان بيخلي الاسم يفضل "مستخدم" والصورة افتراضية
    // مهما ظبط صاحب الحساب بروفايله). maybeSingle بدل single عشان محدش
    // يطلع Exception لو فعلاً مفيش صف (بدل PGRST116).
    const { data, error } = await supabaseClient
        .from('public_profiles')
        .select('full_name, avatar_url')
        .eq('id', peerId)
        .maybeSingle();

    if (error) {
        console.error('[support-chat.js] فشل تحميل بيانات الطرف التاني في المحادثة:', error);
        nameEl.textContent = 'مستخدم';
        return;
    }

    nameEl.textContent = data?.full_name || 'مستخدم';
    avatarEl.src = data?.avatar_url || FALLBACK_AVATAR;
}

/** رجوع لعرض العنوان الثابت #supportChatTitle بدل هوية الطرف التاني - مستخدمة في وضع "قائمة المحادثات" اللي مفيش فيه طرف واحد بعينه */
function clearPeerHeader() {
    const peerBtn = document.getElementById('supportChatPeerBtn');
    if (peerBtn) {
        peerBtn.classList.add('hidden');
        peerBtn.classList.remove('flex');
        peerBtn.onclick = null;
    }
    document.getElementById('supportChatTitle')?.classList.remove('hidden');
}

/** رجوع الأدمن من محادثة مفتوحة لقائمة كل المحادثات تاني (زرار الهيدر الموحّد #btnCloseSupportChat في وضع 'back') */
function showConversationsList() {
    if (!isCurrentUserAdmin) return;

    unsubscribeFromActiveConversation();

    currentViewMode = 'admin_list';
    activeConversationUserId = null;

    clearPeerHeader();
    setTitle('صندوق رسائل الدعم');
    setHeaderExitMode('close');
    showListView();
    loadAndRenderConversationsList();
}


/* ------------------------------------------------------------------
   7) قائمة المحادثات (الأدمن)
   ------------------------------------------------------------------ */

async function loadAndRenderConversationsList() {
    const listEl = document.getElementById('supportChatListView');
    if (!listEl) return;

    listEl.innerHTML = `<p class="text-center text-xs text-lux-500 font-bold py-6">جاري التحميل…</p>`;

    const { data, error } = await supabaseClient.rpc('admin_list_support_conversations');

    if (error) {
        console.error('[support-chat.js] فشل تحميل قائمة المحادثات:', error);
        listEl.innerHTML = `<p class="text-center text-xs text-rose-400 font-bold py-6">تعذّر تحميل المحادثات. حاول تاني.</p>`;
        return;
    }

    if (!data || data.length === 0) {
        listEl.innerHTML = '';
        document.getElementById('supportChatEmptyState')?.classList.remove('hidden');
        return;
    }

    listEl.innerHTML = '';
    data.forEach((conversation) => listEl.appendChild(buildConversationRow(conversation)));
    loadAndApplyPresence(data.map((conversation) => conversation.user_id));
}

function buildConversationRow(conversation) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'w-full flex items-center gap-3 p-2.5 rounded-2xl hover:bg-lux-800/50 transition-colors text-right';

    const avatarUrl = conversation.avatar_url || FALLBACK_AVATAR;
    const unreadCount = Number(conversation.unread_count || 0);
    const lastMessagePrefix = conversation.last_message_from_admin ? 'انت: ' : '';

    row.innerHTML = `
        <span class="relative inline-block shrink-0">
            <img src="${avatarUrl}" alt="" loading="lazy"
                 onerror="this.onerror=null;this.src='${FALLBACK_AVATAR}'"
                 class="w-11 h-11 rounded-full object-cover shrink-0">
            ${presenceDotHtml(conversation.user_id)}
        </span>
        <div class="min-w-0 flex-1 text-right">
            <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-extrabold text-lux-50 truncate">${escapeHtmlLocal(conversation.full_name || 'مستخدم')}</span>
                <span class="text-[10px] text-lux-500 font-bold shrink-0">${formatRelativeTimeArabicLocal(conversation.last_message_at)}</span>
            </div>
            <p class="text-xs text-lux-400 font-medium truncate mt-0.5">${escapeHtmlLocal(lastMessagePrefix + (conversation.last_message || ''))}</p>
        </div>
        ${unreadCount > 0
            ? `<span class="shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-gold-500 text-lux-950 text-[10px] font-black">${unreadCount}</span>`
            : ''}
    `;

    row.addEventListener('click', () => openConversationAsAdmin(conversation.user_id));
    return row;
}

async function openConversationAsAdmin(userId) {
    currentViewMode = 'admin_thread';
    activeConversationUserId = userId;

    setPeerHeader(userId);
    setHeaderExitMode('back');
    showThreadView();
    setThreadLoading();

    await loadAndRenderConversation(userId);
    await supabaseClient.rpc('admin_mark_support_conversation_read', { p_user_id: userId });
    await supabaseClient.rpc('admin_mark_conversation_delivered_and_read', { p_user_id: userId });
    refreshAdminUnreadBadge();
    subscribeToActiveConversation(userId);
}


/* ------------------------------------------------------------------
   8) عرض محادثة واحدة (مشتركة بين المستخدم العادي والأدمن)
   ------------------------------------------------------------------ */

function setThreadLoading() {
    const messagesEl = document.getElementById('supportChatMessagesList');
    if (messagesEl) messagesEl.innerHTML = `<p class="text-center text-xs text-lux-500 font-bold py-6">جاري التحميل…</p>`;
}

async function loadAndRenderConversation(userId) {
    const { data, error } = await supabaseClient
        .from('support_messages')
        .select('id, is_from_admin, content, created_at, delivered_at, read_at')
        .eq('sender_id', userId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('[support-chat.js] فشل تحميل المحادثة:', error);
        const messagesEl = document.getElementById('supportChatMessagesList');
        if (messagesEl) messagesEl.innerHTML = `<p class="text-center text-xs text-rose-400 font-bold py-6">تعذّر تحميل الرسايل. حاول تاني.</p>`;
        return;
    }

    activeConversationMessages = data || [];
    renderConversationMessages();
}

function renderConversationMessages() {
    const messagesEl = document.getElementById('supportChatMessagesList');
    if (!messagesEl) return;

    if (activeConversationMessages.length === 0) {
        messagesEl.innerHTML = '';
        document.getElementById('supportChatEmptyState')?.classList.remove('hidden');
        return;
    }

    document.getElementById('supportChatEmptyState')?.classList.add('hidden');

    // (تعديل) فاصل تاريخ زي واتساب قبل أول رسالة في كل يوم مختلف
    // ("اليوم"/"أمس"/اسم اليوم لو الأسبوع ده/التاريخ الكامل لو أقدم -
    // شوف buildDateSeparatorHtml تحت). lastDateKey بيتقارن بتاريخ اليوم
    // المحلي بس (من غير وقت) عشان يمسك تغيّر اليوم بالظبط.
    let lastDateKey = null;
    let html = '';

    activeConversationMessages.forEach((msg) => {
        const msgDate = new Date(msg.created_at);
        const dateKey = msgDate.toDateString();

        if (dateKey !== lastDateKey) {
            html += buildDateSeparatorHtml(msgDate);
            lastDateKey = dateKey;
        }

        html += buildMessageBubbleHtml(msg);
    });

    messagesEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * فاصل تاريخ في نص الشات، زي واتساب بالظبط - شكله كابسولة صغيرة في
 * النص بين رسايل يوم وتاني.
 * @param {Date} date
 */
function buildDateSeparatorHtml(date) {
    return `
        <div class="flex items-center justify-center py-1">
            <span class="text-[11px] font-bold text-lux-400 bg-lux-800/70 px-3 py-1 rounded-full">${escapeHtmlLocal(formatDateSeparatorArabicLocal(date))}</span>
        </div>
    `;
}

/**
 * (تعديل) فقاعة رسالة واحدة - بقت المحاذاة نسبية لكل حد فاتح الشات بدل
 * ما تكون ثابتة حسب is_from_admin: رسايلي أنا (اللي بعتها) بتتحاذى يمين
 * (دهبية)، ورسايل الطرف التاني بتتحاذى شمال (رمادية) - لأي مستخدم كان،
 * أدمن أو عادي، نفس فلسفة أي شات عادي (واتساب مثلاً). isMine تحت هي
 * الفيصل دلوقتي، مش is_from_admin مباشرة.
 * @param {{id: string, is_from_admin: boolean, content: string, created_at: string, delivered_at?: string, read_at?: string}} msg
 */
function buildMessageBubbleHtml(msg) {
    // (جديد) الرسالة دي بتاعتي أنا (اللي بعتها) لو is_from_admin بتاعها
    // مطابق لهويتي الحالية - هي دلوقتي كمان الفيصل في المحاذاة/اللون
    // (شوف تعليق الدالة فوق)، مش بس الشارات والضغطة المطولة
    const isMine = Boolean(msg.is_from_admin) === isCurrentUserAdmin;

    const bubbleAlignClass = isMine ? 'items-end' : 'items-start';
    const bubbleColorClass = isMine
        ? 'bg-gold-500 text-lux-950'
        : 'bg-lux-800 text-lux-50';

    return `
        <div class="flex flex-col ${bubbleAlignClass}">
            <div class="max-w-[80%] rounded-2xl px-3.5 py-2 text-sm font-medium leading-relaxed whitespace-pre-wrap break-words ${bubbleColorClass} ${isMine ? 'support-msg-own cursor-pointer select-none' : ''}"
                 ${isMine ? `data-message-id="${msg.id}"` : ''}>${escapeHtmlLocal(msg.content)}</div>
            <span class="flex items-center gap-1 text-[10px] text-lux-500 font-bold mt-1 px-1">
                <span>${formatClockTimeArabicLocal(msg.created_at)}</span>
                ${isMine ? buildTicksHtml(msg) : ''}
            </span>
        </div>
    `;
}

/**
 * (جديد) شارة الاستلام/المشاهدة زي واتساب بالظبط - ✓ واحدة رمادية
 * "اترسلت"، ✓✓ رمادية "استلمها الطرف التاني"، ✓✓ دهبية "شافها". بتتحسب
 * من delivered_at/read_at جايين من قاعدة البيانات (شوف الدالة
 * markMessageDeliveredIfNeeded تحت لتفاصيل امتى بيتحطوا).
 * @param {{delivered_at?: string, read_at?: string}} msg
 */
function buildTicksHtml(msg) {
    const isRead = Boolean(msg.read_at);
    const isDelivered = Boolean(msg.delivered_at) || isRead;
    const colorClass = isRead ? 'text-gold-400' : 'text-lux-500';

    // ✓ واحدة بس (اترسلت ولسه معدتش تستلم)
    if (!isDelivered) {
        return `
            <svg viewBox="0 0 16 12" class="w-3.5 h-3 shrink-0 ${colorClass}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 6.5 5 10.5 15 1.5"></path>
            </svg>
        `;
    }

    // ✓✓ (استلمها = رمادي، شافها = دهبي)
    return `
        <svg viewBox="0 0 20 12" class="w-4 h-3 shrink-0 ${colorClass}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 6.5 5 10.5 12 2.5"></path>
            <path d="M8 6.5 12 10.5 19 1.5"></path>
        </svg>
    `;
}


/* ------------------------------------------------------------------
   8ب) مؤشر "بيكتب…" الحي (Realtime Broadcast - شوف قسم 11ب تحت للاشتراك)
   ------------------------------------------------------------------ */

/** أد إيه أسكت من غير كتابة قبل ما نبعت "بطل يكتب" تلقائياً للطرف التاني */
const TYPING_STOP_DELAY_MS = 2500;

/** أقصى مدة يفضل فيها مؤشر "بيكتب…" ظاهر عندي من غير ما تجيني إشارة "بطل يكتب" - أمان زيادة بس */
const TYPING_INDICATOR_AUTO_HIDE_MS = 6000;

/**
 * بتتنادى مع كل حرف بيتكتب فعلياً في textarea الرسالة (input event، مش
 * keydown - عشان تمسك اللصق واللمس بالموبايل برضه مش بس ضغط الأزرار).
 * بتبعت "بيكتب" على طول لو مبعتناهاش قبل كده، وبتعيد ضبط تايمر "بطل
 * يكتب" التلقائي مع كل حرف جديد.
 */
function handleTypingInput() {
    if (!activeConversationChannel || !activeConversationUserId) return;

    const inputEl = document.getElementById('supportChatInput');
    const hasContent = Boolean(inputEl && inputEl.value.trim());

    clearTimeout(typingStopTimer);

    if (!hasContent) {
        // مسح الخانة بالكامل = زي ما يكون بطل يكتب على طول، من غير ما ننتظر التايمر
        sendTypingState(false);
        return;
    }

    sendTypingState(true);
    typingStopTimer = setTimeout(() => sendTypingState(false), TYPING_STOP_DELAY_MS);
}

/**
 * بتبعت إشارة Broadcast لحظية على activeConversationChannel بحالة الكتابة
 * الحالية - isAdmin جوه الـ payload عشان الطرف المستقبل يقدر يتأكد إنها
 * مش راجعة منه هو نفسه (شوف فلتر broadcast في subscribeToActiveConversation).
 * @param {boolean} isTyping
 */
function sendTypingState(isTyping) {
    if (!activeConversationChannel) return;
    if (lastSentTypingState === isTyping) return; // منبعتش نفس الحالة تاني على الفاضي

    lastSentTypingState = isTyping;
    activeConversationChannel.send({
        type: 'broadcast',
        event: 'typing',
        payload: { isTyping, isAdmin: isCurrentUserAdmin },
    });
}

/**
 * (تعديل) فقاعة "بيكتب…" (3 نقط بترقص - شوف .support-typing-dots في
 * style.css) بتتضاف في آخر قائمة الرسايل. هي دايماً بتمثل الطرف التاني
 * (مش أنا)، فبقت بتتحاذى شمال بلون رمادي ثابت لأي حد فاتح الشات - نفس
 * فلسفة محاذاة الرسايل النسبية الجديدة في buildMessageBubbleHtml فوق.
 */
function showTypingIndicator() {
    const messagesEl = document.getElementById('supportChatMessagesList');
    if (!messagesEl) return;

    clearTimeout(typingIndicatorAutoHideTimer);
    typingIndicatorAutoHideTimer = setTimeout(hideTypingIndicator, TYPING_INDICATOR_AUTO_HIDE_MS);

    if (document.getElementById('supportChatTypingBubble')) return; // ظاهرة أصلاً

    document.getElementById('supportChatEmptyState')?.classList.add('hidden');

    messagesEl.insertAdjacentHTML('beforeend', `
        <div id="supportChatTypingBubble" class="flex flex-col items-start">
            <div class="rounded-2xl px-3.5 py-2.5 bg-lux-800 text-lux-50">
                <span class="support-typing-dots"><span></span><span></span><span></span></span>
            </div>
        </div>
    `);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** بتشيل فقاعة "بيكتب…" لو ظاهرة - آمنة تتنادى أكتر من مرة أو لو أصلاً مش ظاهرة */
function hideTypingIndicator() {
    clearTimeout(typingIndicatorAutoHideTimer);
    document.getElementById('supportChatTypingBubble')?.remove();
}


/* ------------------------------------------------------------------
   9) إرسال رسالة جديدة
   ------------------------------------------------------------------ */

async function handleSendClick() {
    if (isSending || !currentUser || !activeConversationUserId) return;

    const inputEl = document.getElementById('supportChatInput');
    if (!inputEl) return;

    const content = inputEl.value.trim();
    if (!content) return;

    // (جديد) هبعت الرسالة فعلياً دلوقتي، فمفيش داعي إشارة "بيكتب…" تفضل
    // شغالة عند الطرف التاني - يقفلها على طول من غير ما ينتظر تايمر السكوت
    clearTimeout(typingStopTimer);
    sendTypingState(false);

    isSending = true;
    const sendBtn = document.getElementById('supportChatSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    // is_from_admin: لو الأدمن هو اللي فاتح المودال دلوقتي، الرسالة دي
    // رد منه (حتى لو كان جوه محادثة نفسه - شوف تعليق خطوة 40 في
    // sql/phase-8-support-messages.sql). لو مستخدم عادي، دايماً false.
    const { error } = await supabaseClient
        .from('support_messages')
        .insert({
            sender_id: activeConversationUserId,
            is_from_admin: isCurrentUserAdmin,
            content,
        });

    isSending = false;
    if (sendBtn) sendBtn.disabled = false;

    if (error) {
        console.error('[support-chat.js] فشل إرسال الرسالة:', error);
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تعذّر إرسال الرسالة. حاول تاني.', type: 'error' },
        }));
        return;
    }

    inputEl.value = '';
    await loadAndRenderConversation(activeConversationUserId);

    // لو الأدمن هو اللي رد، شارة عدد الرسايل غير المقروءة (عنده هو) ماتتأثرش -
    // هي أصلاً عن رسايل المستخدمين اللي لسه مردود عليهاش. مفيش داعي نحدّثها هنا
}


/* ------------------------------------------------------------------
   10) تعليم رسايل الأدمن كمقروءة من ناحية المستخدم العادي
   ------------------------------------------------------------------ */

async function markAdminMessagesAsReadForMe() {
    if (!currentUser) return;

    const nowIso = new Date().toISOString();

    // "شافها": هي فعلياً بتفتح شات الدعم وشايفة رسالة الأدمن على الشاشة
    const { error } = await supabaseClient
        .from('support_messages')
        .update({ is_read: true, read_at: nowIso })
        .eq('sender_id', currentUser.id)
        .eq('is_from_admin', true)
        .eq('is_read', false);

    if (error) {
        console.error('[support-chat.js] فشل تعليم رسايل الأدمن كمقروءة:', error);
    }

    // (جديد) "استلمها": احتياط لأي رسالة وصلت وهي أوفلاين فعدّت
    // subscribeUserInboxChannel من غير ما تتحط delivered_at، وبعدين
    // فتحت الشات مباشرة قبل ما تلحق تتظبط - مادام بتشوفها دلوقتي فهي
    // بالتأكيد "استلمتها" في نفس اللحظة كحد أدنى
    const { error: deliveredError } = await supabaseClient
        .from('support_messages')
        .update({ delivered_at: nowIso })
        .eq('sender_id', currentUser.id)
        .eq('is_from_admin', true)
        .is('delivered_at', null);

    if (deliveredError) {
        console.error('[support-chat.js] فشل تعليم رسايل الأدمن كمستلمة:', deliveredError);
    }
}

/**
 * (جديد) "استلمها" - بتتحط أول ما رسالة الأدمن توصل لجهاز المستخدم
 * العادي، سواء شات الدعم مفتوح أو لأ (بيتنادى من userInboxChannel/
 * subscribeToActiveConversation تحت). ما بتلمسش is_read/read_at خالص -
 * دول بس وقت ما فعلاً يشوف الرسالة (markAdminMessagesAsReadForMe).
 * @param {string} messageId
 */
async function markMessageDeliveredDirect(messageId) {
    const { error } = await supabaseClient
        .from('support_messages')
        .update({ delivered_at: new Date().toISOString() })
        .eq('id', messageId)
        .is('delivered_at', null);

    if (error) {
        console.error('[support-chat.js] فشل تعليم رسالة كمستلمة:', error);
    }
}

/**
 * (جديد) بتتنادى مرة واحدة بس لحظة تسجيل الدخول (مستخدم عادي) - بتعلّم
 * أي رسالة أدمن كانت اتبعتت وهو أوفلاين "استلمها" فوراً بمجرد ما التطبيق
 * فتح وعنده نت، من غير ما ينتظر يفتح شات الدعم أو تجيله رسالة جديدة
 * لحظياً. مختلفة عن markAdminMessagesAsReadForMe (دي بتحصل بس وقت
 * ما يفتح الثريد فعلاً ويشوف الرسايل - مش نفس لحظة الاتصال بالنت).
 */
async function markPendingAdminMessagesDeliveredForMe() {
    if (!currentUser) return;

    const { error } = await supabaseClient
        .from('support_messages')
        .update({ delivered_at: new Date().toISOString() })
        .eq('sender_id', currentUser.id)
        .eq('is_from_admin', true)
        .is('delivered_at', null);

    if (error) {
        console.error('[support-chat.js] فشل تعليم رسايل الأدمن المعلّقة كمستلمة:', error);
    }
}

/**
 * (جديد) نفس فكرة markPendingAdminMessagesDeliveredForMe بس من ناحية
 * الأدمن - بتتنادى لحظة تسجيل دخوله، وبتكنس كل رسايل المستخدمين المعلّقة
 * (من أي محادثة) وتعلّمها "استلمها" على طول، من غير ما ينتظر رسالة جديدة
 * تجيله لحظياً بعد كده. محتاجة RPC (لا Realtime ولا JS بيقدر يعمل تحديث
 * جماعي على صفوف مش هو صاحبها من غير SECURITY DEFINER).
 */
async function markAllPendingMessagesDeliveredAsAdmin() {
    const { error } = await supabaseClient.rpc('admin_mark_all_pending_messages_delivered');

    if (error) {
        console.error('[support-chat.js] فشل تعليم الرسايل المعلّقة كمستلمة (أدمن):', error);
    }
}


/* ------------------------------------------------------------------
   11) شارة عدد الرسايل غير المقروءة على الزرار العائم (الأدمن)
   ------------------------------------------------------------------ */

async function refreshAdminUnreadBadge() {
    if (!isCurrentUserAdmin) return;

    const { data, error } = await supabaseClient.rpc('admin_count_unread_support_messages');
    if (error) {
        console.error('[support-chat.js] فشل تحميل عدد الرسايل غير المقروءة:', error);
        return;
    }

    const badgeEl = document.getElementById('supportInboxUnreadBadge');
    const countEl = document.getElementById('supportInboxUnreadCount');
    const count = Number(data || 0);

    if (countEl) countEl.textContent = String(count);
    if (badgeEl) badgeEl.classList.toggle('hidden', count === 0);
}


/* ------------------------------------------------------------------
   11ب) مزامنة لحظية (Realtime) - من غير أي ريفريش يدوي
   ------------------------------------------------------------------ */

/**
 * (تعديل) اشتراك في قناة Realtime خاصة بمحادثة واحدة بعينها (رسايل
 * userId دي بس، مستخدم عادي أو أدمن جوه ثريد). أي INSERT جديد على
 * support_messages بنفس sender_id بيعيد تحميل ورسم المحادثة فوراً
 * (وبيعلّمها مقروءة تلقائياً حسب مين فاتح الشاشة دلوقتي)، من غير ما
 * ننتظر ضغطة زرار أو ريفريش.
 * @param {string} userId
 */
function subscribeToActiveConversation(userId) {
    unsubscribeFromActiveConversation();

    activeConversationChannel = supabaseClient
        // (جديد) broadcast.self: false عشان إشارة "بيكتب" اللي بابعتها أنا
        // ما ترجعليش تاني - مش محتاجها أصلاً، هي للطرف التاني بس
        .channel(`support_messages_thread_${userId}`, { config: { broadcast: { self: false } } })
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'support_messages',
            filter: `sender_id=eq.${userId}`,
        }, async (payload) => {
            // لو الرسالة الجديدة دي فعلاً أنا اللي بعتها من نفس الجهاز
            // (وصلتنا كإشعار Realtime برضه)، مفيش داعي نعمل حاجة زيادة -
            // العرض المحلي اتحدّث أصلاً فور الإرسال في handleSendClick
            if (activeConversationMessages.some((m) => m.id === payload.new.id)) return;

            await loadAndRenderConversation(userId);

            // لو الرسالة الجديدة من الأدمن ومستخدم عادي فاتح شاته دلوقتي،
            // نعلّمها مقروءة على طول بما إنه شايفها فعلاً على الشاشة
            if (payload.new.is_from_admin && !isCurrentUserAdmin) {
                await markAdminMessagesAsReadForMe();
            }

            // لو الأدمن فاتح ثريد المستخدم ده بالظبط، رسالة المستخدم
            // الجديدة تتعلّم مقروءة على طول برضه (نفس منطق فتح المحادثة)
            if (isCurrentUserAdmin && !payload.new.is_from_admin) {
                await supabaseClient.rpc('admin_mark_support_conversation_read', { p_user_id: userId });
                await supabaseClient.rpc('admin_mark_conversation_delivered_and_read', { p_user_id: userId });
                refreshAdminUnreadBadge();
            }
        })
        // (جديد) UPDATE بيحصل لما الطرف التاني يعلّم رسالتي أنا "استلمها"/
        // "شافها" (delivered_at/read_at) - محتاجين نعيد الرسم عشان الشارة
        // (✓/✓✓) تتحدّث لحظياً وأنا لسه فاتح نفس المحادثة، من غير أي منطق
        // "تعليم كمقروء" هنا (ده بس تحديث عرض، مش رسالة جديدة)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'support_messages',
            filter: `sender_id=eq.${userId}`,
        }, async () => {
            await loadAndRenderConversation(userId);
        })
        // (جديد) حذف رسالة (من عندي أو من عند الطرف التاني، أي جهاز) -
        // بنشيلها من النسخة المحلية بس من غير إعادة تحميل كاملة (أسرع، ومفيش
        // داعي رحلة تانية للسيرفر). من غير فلتر sender_id عمداً: بايلود
        // DELETE بيرجّع عمود الـ id بس افتراضياً (REPLICA IDENTITY الافتراضية)،
        // مش باقي الأعمدة زي sender_id اللي الفلتر محتاجه، فكنا هنفوّت
        // الإشارة لو حطينا الفلتر. المطابقة بـ id هنا كافية وآمنة لأن القناة
        // دي أصلاً مشترَكة بس وقت فتح ثريد المحادثة ده بالذات.
        .on('postgres_changes', {
            event: 'DELETE',
            schema: 'public',
            table: 'support_messages',
        }, (payload) => {
            const deletedId = payload.old?.id;
            if (!deletedId) return;
            if (!activeConversationMessages.some((m) => m.id === deletedId)) return;

            activeConversationMessages = activeConversationMessages.filter((m) => m.id !== deletedId);
            renderConversationMessages();
        })
        // (جديد) إشارة "بيكتب…" اللحظية بتاعة الطرف التاني - Broadcast بس،
        // مالهاش أي علاقة بجدول support_messages (شوف sendTypingState فوق).
        // فلتر payload.isAdmin !== isCurrentUserAdmin احتياط إضافي (فوق
        // broadcast.self: false) عشان محدش يشوف مؤشر كتابته هو بالغلط.
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
            if (!payload || payload.isAdmin === isCurrentUserAdmin) return;

            if (payload.isTyping) {
                showTypingIndicator();
            } else {
                hideTypingIndicator();
            }
        })
        .subscribe((status) => {
            console.log('[support-chat.js] حالة اشتراك Realtime (محادثة):', status);
        });
}

/** إلغاء الاشتراك في قناة المحادثة المفتوحة حالياً (لو موجودة) - آمن يتنادى أكتر من مرة */
function unsubscribeFromActiveConversation() {
    if (activeConversationChannel) {
        supabaseClient.removeChannel(activeConversationChannel);
        activeConversationChannel = null;
    }

    // (جديد) تنضيف حالة "بيكتب" مع قفل المحادثة - مفيش قناة أصلاً نبعت
    // عليها بعد كده، ومفيش داعي مؤشر الطرف التاني يفضل ظاهر بعد ما قفلنا
    clearTimeout(typingStopTimer);
    lastSentTypingState = false;
    hideTypingIndicator();
}

/**
 * (تعديل) اشتراك عام للأدمن بس - شغال طول ما هو مسجّل دخول (مش بس وقت
 * فتح صندوق الرسائل)، عشان شارة العداد الحمراء على الزرار العائم
 * تفضل محدّثة لحظياً فور ما أي مستخدم يبعت رسالة، سواء كان الأدمن
 * فاتح التطبيق العادي أو لوحة التحكم أو حتى المودال مقفول تماماً.
 * لو قائمة المحادثات هي المعروضة دلوقتي، بنعيد رسمها كمان عشان
 * المحادثة الجديدة/المرتبة تظهر فوراً من غير ريفريش.
 */
function subscribeAdminGlobalChannel() {
    if (adminGlobalChannel) return;

    adminGlobalChannel = supabaseClient
        .channel('support_messages_admin_global')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'support_messages',
        }, (payload) => {
            refreshAdminUnreadBadge();

            if (currentViewMode === 'admin_list') {
                loadAndRenderConversationsList();
            }

            // (جديد) "استلمها" - الأدمن داخل التطبيق أصلاً (القناة دي شغالة
            // طول ما هو مسجّل دخول) فأي رسالة مستخدم جديدة بتوصله على طول،
            // حتى لو مفتوح على محادثة تانية أو مقفول شات الدعم كله. الرسالة
            // دي مش رسالة الأدمن نفسه فمحتاجة RPC (admin_mark_message_delivered)
            // لأنه مش صاحب الصف (sender_id بتاعها هو المستخدم، مش الأدمن).
            if (!payload.new.is_from_admin) {
                supabaseClient.rpc('admin_mark_message_delivered', { p_message_id: payload.new.id })
                    .then(({ error }) => {
                        if (error) console.error('[support-chat.js] فشل تعليم رسالة كمستلمة (أدمن):', error);
                    });
            }
        })
        .subscribe((status) => {
            console.log('[support-chat.js] حالة اشتراك Realtime (عام/أدمن):', status);
        });
}

/** إلغاء اشتراك قناة الأدمن العامة (وقت تسجيل الخروج) */
function unsubscribeAdminGlobalChannel() {
    if (adminGlobalChannel) {
        supabaseClient.removeChannel(adminGlobalChannel);
        adminGlobalChannel = null;
    }
}

/**
 * (جديد) اشتراك عام لأي مستخدم عادي بس - شغال طول ما هو مسجّل دخول
 * (مش بس وقت فتح شات الدعم)، عشان رسالة الأدمن الجديدة تتعلّم "استلمها"
 * (delivered_at) فور وصولها حتى لو الشات مقفول أصلاً - مقابلة تماماً
 * لـ subscribeAdminGlobalChannel فوق بس من ناحية المستخدم العادي.
 * ما بتعملش أي حاجة لو الرسالة الجديدة هي رسالة المستخدم نفسه (بيبعتها
 * هو أصلاً عارف إنها اترسلت - مفيش داعي "استلام" لرسالة نفسه).
 */
function subscribeUserInboxChannel() {
    if (userInboxChannel || !currentUser) return;

    userInboxChannel = supabaseClient
        .channel(`support_messages_user_inbox_${currentUser.id}`)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'support_messages',
            filter: `sender_id=eq.${currentUser.id}`,
        }, (payload) => {
            if (payload.new.is_from_admin) {
                markMessageDeliveredDirect(payload.new.id);
            }
        })
        .subscribe((status) => {
            console.log('[support-chat.js] حالة اشتراك Realtime (صندوق وارد المستخدم):', status);
        });
}

/** إلغاء اشتراك صندوق وارد المستخدم العادي (وقت تسجيل الخروج) */
function unsubscribeUserInboxChannel() {
    if (userInboxChannel) {
        supabaseClient.removeChannel(userInboxChannel);
        userInboxChannel = null;
    }
}


/* ------------------------------------------------------------------
   12) أدوات مساعدة محلية (مكرّرة عمداً من notifications.js/leaderboard.js
       بدل ما نستوردها - نفس فلسفة الملفات التانية في تجنّب أي استيراد
       بس عشان دالة مساعدة صغيرة واحدة)
   ------------------------------------------------------------------ */

function escapeHtmlLocal(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/**
 * (تعديل) نص فاصل التاريخ زي واتساب: "اليوم" / "أمس" / اسم اليوم لو
 * جوه آخر أسبوع / التاريخ الكامل لو أقدم من كده (مع السنة لو مختلفة
 * عن السنة الحالية). المقارنة بتاريخ اليوم المحلي بس (بداية اليوم)
 * عشان "أمس" تبقى ثابتة طول اليوم مهما كان وقت الرسالة.
 * @param {Date} date
 */
function formatDateSeparatorArabicLocal(date) {
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOfDay(new Date());
    const target = startOfDay(date);
    const diffDays = Math.round((today - target) / 86400000);

    if (diffDays === 0) return 'اليوم';
    if (diffDays === 1) return 'أمس';
    if (diffDays > 1 && diffDays < 7) return date.toLocaleDateString('ar-EG', { weekday: 'long' });

    return date.toLocaleDateString('ar-EG', {
        day: 'numeric',
        month: 'long',
        year: target.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
        numberingSystem: 'latn',
    });
}

/**
 * (تعديل) وقت الرسالة الفعلي (الساعة والدقيقة) - ده اللي بيتحط تحت كل
 * فقاعة رسالة دلوقتي بدل النص النسبي ("أمس"/"منذ ٣ ساعات"..إلخ)، لأن
 * اليوم نفسه بقى معروض مرة واحدة بس في فاصل التاريخ في نص الشات
 * (formatDateSeparatorArabicLocal فوق) - مفيش داعي يتكرر تحت كل رسالة.
 * @param {string} isoDateString
 */
function formatClockTimeArabicLocal(isoDateString) {
    if (!isoDateString) return '';

    return new Date(isoDateString).toLocaleTimeString('ar-EG', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        numberingSystem: 'latn',
    });
}

function formatRelativeTimeArabicLocal(isoDateString) {
    if (!isoDateString) return '';

    const createdAt = new Date(isoDateString);
    const diffSeconds = Math.floor((Date.now() - createdAt.getTime()) / 1000);

    if (diffSeconds < 60) return 'الآن';

    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `منذ ${diffMinutes} ${diffMinutes === 1 ? 'دقيقة' : 'دقائق'}`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `منذ ${diffHours} ${diffHours === 1 ? 'ساعة' : 'ساعات'}`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'أمس';
    if (diffDays < 7) return `منذ ${diffDays} أيام`;

    return createdAt.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}