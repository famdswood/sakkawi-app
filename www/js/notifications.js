/* ==================================================================
   سِكّاوي | js/notifications.js
   ------------------------------------------------------------------
   المرحلة الثالثة من نظام الإشعارات: منطق الـ JavaScript الكامل
   للوحة الإشعارات (#notificationsModal) اللي شكلها وHTML/CSS بتاعها
   اتعملوا في المرحلة الثانية. الملف ده مسؤول عن:

     1) فتح/قفل المودال + التبديل بين تبويبي "الكل" و"غير المقروء"
     2) جلب صفوف جدول public.notifications الخاصة بالمستخدم الحالي
        من Supabase، واستنساخ #notificationCardTemplate لكل صف
     3) الاشتراك في Supabase Realtime عشان أي إشعار جديد يوصل فوراً
        من غير Refresh (بالإضافة لصوت + انيميشن خفيفة على الجرس)
     4) تحديث حالة القراءة (فردي/الكل) في قاعدة البيانات محلياً وفوراً

   بيعتمد على نفس فلسفة باقي ملفات المشروع (auth.js / profiles.js /
   stories.js):
     - supabaseClient مستورد من supabase-config.js (Single Source)
     - التواصل مع باقي الوحدات عبر Custom Events بس ('app:toast',
       'app:sound') عشان نتجنب أي Circular Imports مع app.js
     - معرفة هوية المستخدم الحالي عبر حدثي 'auth:login' (بيتطلق من
       auth.js فور ما جلسة صحيحة تتأكد - أول تشغيل أو بعد تسجيل دخول)
       و'auth:signed-out' (بعد تسجيل خروج) بدل استيراد getCurrentUser
       مباشرة، عشان الترتيب يفضل صحيح مهما كان توقيت تحميل الموديولز

   الاستثناء الوحيد: أزرار "قبول/رفض" طلب الصداقة داخل كارت إشعار من
   نوع friend_request بتستورد acceptFriendRequest/rejectFriendRequest
   جاهزين من profiles.js بدل ما تكرر نفس منطق تحديث/حذف صف friends هنا
   تاني (profiles.js هو مصدر الحقيقة الوحيد لكل حاجة خاصة بالأصدقاء،
   وهو بالفعل بيعمل reload لقائمة الأصدقاء والطلبات الواردة بنفسه بعد
   كل عملية، فمفيش داعي نكرر منطق التحديث هنا).

   ملحوظة عن شكل عمود data (jsonb) المتوقع لكل نوع إشعار (اتفاق ضمني
   بين أي كود بينشئ صف في notifications وبين الملف ده اللي بيقرأه):
     - friend_request:   { request_id: '<uuid صف friends>', sender_id }
     - achievement:       { badge_id: '...' } (مش مستخدم في العرض حالياً)
     - system_broadcast:  {} (مفيش حاجة إضافية مطلوبة)
     - comment_reply:     { post_id, comment_id: '<id الكومنت الأساسي
       اللي اترد عليه>', reply_id: '<id صف الرد نفسه>', sender_id,
       sender_avatar_url } - بتتبعت من handleCommentSubmit في posts.js
       لما حد يرد على كومنت حد تاني (مش على منشوره - رد على كومنت
       بالظبط)، ومش بتتبعت لو المستخدم رد على كومنت نفسه
     - comment_like:      { post_id, comment_id, sender_id,
       sender_avatar_url } - بتتبعت من handleCommentLikeToggle في
       posts.js لما حد يعمل لايك (مش إلغاء لايك) على كومنت حد تاني،
       ومش بتتبعت لو المستخدم عمل لايك لكومنت نفسه
   لو صف friend_request جاله من غير data.request_id لأي سبب، بنخفي
   أزرار قبول/رفض بتاعته تلقائياً (شوف renderNotificationCard) عشان
   منسيبش زرار مكسور يرمي خطأ لو المستخدم ضغط عليه.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { acceptFriendRequest, rejectFriendRequest, openPublicProfile } from './profiles.js';
import { getStories, openStory } from './stories.js';
// (تعديل - المرحلة 8) استيراد دوال فتح شات الدعم عشان الضغط على إشعار
// 'admin_reply' (رد الأدمن على مستخدم عادي) أو 'support_message' (رسالة
// مستخدم جديدة توصل للأدمن) يودّي مباشرة لنفس المحادثة بدل ما الإشعار
// يفضل بلا أي فعل عند الضغط عليه
import { openSupportChatWithAdmin, openSupportChatAsAdminWithUser } from './support-chat.js';
import { pushModalState, closeModal, hasOpenModal } from './modal-history.js';

/* ------------------------------------------------------------------
   1) حالة الموديول (Module State)
   ------------------------------------------------------------------ */

/** المستخدم الحالي (نفس شكل user بتاع Supabase Auth) - null لو مفيش تسجيل دخول */
let currentUser = null;

/** نسخة محلية (Cache) من كل صفوف notifications الخاصة بالمستخدم، الأحدث أولاً */
let notificationsCache = [];

/** التبويب الحالي: 'all' (الكل) أو 'unread' (غير المقروء) */
let currentFilter = 'all';

/** قناة Supabase Realtime الحالية (لو موجودة) - عشان نقدر نلغيها بأمان */
let realtimeChannel = null;

/** true لو أول جلب لإشعارات المستخدم الحالي حصل بالفعل (لمنع تكرار بلا داعي) */
let hasFetchedOnce = false;

/** true بمجرد ما نربط أحداث الـ UI الثابتة (الجرس، الإغلاق، التبويبات) مرة واحدة بس */
let hasBoundStaticListeners = false;

/** مؤقّت إخفاء المودال بعد انتهاء انتقال الإغلاق - محفوظ عشان نقدر نلغيه لو المستخدم فتح/قفل بسرعة */
let closeModalTimeoutId = null;

/** مؤقّت إزالة كلاس نبضة الجرس (animate-bounce) - محفوظ بنفس فلسفة closeModalTimeoutId عشان لو أكتر من إشعار وصل بسرعة ورا بعض منسيبش أكتر من مؤقّت شغال في نفس الوقت */
let bellAnimationTimeoutId = null;

/**
 * (تعديل) أيقونة الأوسمة/الإنجازات (achievement/achievement_unlocked) -
 * ميدالية SVG بسيطة بتدرّج ذهبي (نفس ألوان --gold-300/500/600 في
 * style.css)، بدل الدايرة الفاضية اللي كانت عايشة على NOTIFICATION_ICONS
 * الفاضي فوق. مفيهاش أي id عشان تتحقن أكتر من مرة في نفس الصفحة
 * (كذا إشعار وسام في نفس القائمة) من غير أي تعارض IDs.
 */
const ACHIEVEMENT_BADGE_SVG = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="notif-badge-icon" aria-hidden="true">
        <path d="M9 13.5 L6.5 21 L12 18 L9 13.5 Z" fill="#B8942A"/>
        <path d="M15 13.5 L17.5 21 L12 18 L15 13.5 Z" fill="#D4AF37"/>
        <circle cx="12" cy="9" r="7" fill="#D4AF37" stroke="#B8942A" stroke-width="1"/>
        <circle cx="12" cy="9" r="5.4" fill="#F2D77E"/>
        <path d="M12 5.6 L12.82 7.87 L15.23 7.95 L13.33 9.43 L14 11.75 L12 10.4 L10 11.75 L10.67 9.43 L8.77 7.95 L11.18 7.87 Z" fill="#B8942A"/>
    </svg>
`;

/** الأيقونة المعروضة في دايرة كل نوع إشعار (رسوم SVG نظيفة بدون أي إيموجي بما يتوافق مع هوية سِكّاوي) */
const NOTIFICATION_ICONS = {
    friend_request: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-emerald-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
        </svg>
    `,
    friend_accept: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-emerald-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>
        </svg>
    `,
    achievement: ACHIEVEMENT_BADGE_SVG,
    achievement_unlocked: ACHIEVEMENT_BADGE_SVG,
    system_broadcast: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-sky-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
    `,
    story_reaction: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-rose-400 fill-rose-500 stroke-current" stroke-width="1.5">
            <path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>
        </svg>
    `,
    leaderboard_pass: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-amber-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15"/>
        </svg>
    `,
    comment_reply: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-amber-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
    `,
    comment_like: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-rose-400 fill-rose-500 stroke-current" stroke-width="1.5">
            <path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>
        </svg>
    `,
    daily_question_forfeited: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-amber-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
        </svg>
    `,
    championship_won: `
        <svg viewBox="0 0 24 24" class="w-4 h-4 text-yellow-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 4h16v5a8 8 0 0 1-16 0V4zM12 17v4M8 21h8"/>
        </svg>
    `,
};

/**
 * (تعديل) صورة بروفايل احتياطية لإشعارات فيها "مُرسل" (طلب صداقة/قبول
 * صداقة/تخطي في الترتيب/تفاعل استوري) لو data.sender_avatar_url مش
 * موجودة (صف قديم اتعمل قبل إضافة الحقل، أو المرسل نفسه مالوش صورة
 * بروفايل) - نفس أفاتار "الشخص المجهول" (سيلويت دائرة+كتفين) المستخدم
 * فعلياً في باقي التطبيق (بودكاست المتصدرين وشات الدعم)، بدل رابط
 * placehold.co القديم اللي كان بيطلع علامات استفهام لأنه مش بيعرض نص
 * عربي صح.
 */
const FALLBACK_SENDER_AVATAR = "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20100%20100%27%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2750%27%20r%3D%2750%27%20fill%3D%27%2314171F%27%2F%3E%3Ccircle%20cx%3D%2750%27%20cy%3D%2738%27%20r%3D%2716%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%2F%3E%3Cpath%20d%3D%27M20%2084c0-18%2013.5-30%2030-30s30%2012%2030%2030%27%20fill%3D%27none%27%20stroke%3D%27%239A96A0%27%20stroke-width%3D%277%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E";

/** مدة انتقال إغلاق المودال بالمللي ثانية - لازم تفضل متسقة مع transform 0.34s في CSS (شوف .notif-panel) */
const MODAL_CLOSE_TRANSITION_MS = 340;

/** أقصى عدد إشعارات محفوظة للمستخدم الواحد - نفس الرقم المضبوط في
 * trigger الاحتفاظ على مستوى قاعدة البيانات (public.enforce_notifications_limit)
 * اللي هو المصدر الحقيقي للحد (بيحذف الأقدم فعلياً من الجدول). الرقم
 * هنا بنستخدمه بس عشان نعمل trim فوري للكاش المحلي لما إشعار جديد
 * يوصل لحظياً عبر Realtime، من غير ما نستنى Refresh أو Fetch جديد */
const NOTIFICATIONS_MAX_COUNT = 10;

/**
 * Selector شامل لأي زرار "فتح لوحة الإشعارات" ممكن يكون موجود في
 * الصفحة. الـ id الأساسي المتفق عليه فعلياً في index.html هو
 * "#notificationBellBtn"، لكن سايبين الـ selector مرن (بيشمل كمان
 * "#notification-btn" و ".notification-btn-trigger" و
 * "[data-notif-trigger]") عشان لو فيه أكتر من جرس إشعارات في أكتر من
 * مكان بالتطبيق (أو لو حد استخدم تسمية مختلفة بالغلط)، الكود يفضل
 * شغال من غير ما نحتاج نرجع نعدّله تاني في كل مرة
 */
const BELL_TRIGGER_SELECTOR = [
    '#notificationBellBtn',
    '#notification-btn',
    '.notification-btn-trigger',
    '[data-notif-trigger]',
].join(', ');

/** كل الـ ids المحتملة لعنصر مودال الإشعارات نفسه - نفس فلسفة BELL_TRIGGER_SELECTOR فوق */
const NOTIFICATIONS_MODAL_IDS = ['notificationsModal', 'notification-modal'];

/** نصوص الـ Empty State حسب السبب: مستخدم مش مسجل دخول، أو مسجل بس مفيش إشعارات */
const EMPTY_STATE_MESSAGES = {
    notLoggedIn: {
        title: 'سجّل دخولك الأول',
        subtitle: 'عشان تقدر تشوف إشعاراتك هنا',
    },
    noNotifications: {
        title: 'مفيش إشعارات جديدة',
        subtitle: 'هنبلغك أول ما يحصل حاجة جديدة تخصك',
    },
};


/* ------------------------------------------------------------------
   إرسال إشعار مركزي - sendNotification()
   ------------------------------------------------------------------
   نقطة الإدراج الوحيدة والمركزية لأي صف جديد في جدول public.notifications
   من أي مكان في المشروع (بدل ما كل ملف يكرر نفس كود supabaseClient
   .from('notifications').insert(...) بنفسه زي ما كان حاصل في
   sendFriendRequest بتاعة profiles.js). أي ميزة جديدة عايزة تبعت
   إشعار (قبول صداقة، تفاعل/رد على ستوري، فتح وسام، تخطي حد في
   الليدربورد...إلخ) المفروض تستورد الدالة دي وتستخدمها بدل ما تكتب
   INSERT خام بنفسها، عشان أي تعديل مستقبلي (مثلاً: توحيد شكل رسائل
   الخطأ، أو إضافة تحقق إضافي قبل الإدراج) يتم في مكان واحد بس.

   ملحوظة عن الأنواع المسموحة (type): لازم تتطابق مع القيم الموجودة
   فعلياً في CHECK constraint بتاع عمود type في قاعدة البيانات
   (public.notifications_type_check) - لو النوع مش موجود جواه، الإدراج
   هيفشل ويوصف الخطأ في console.error بدل ما يفشل بصمت.
*/

/**
 * إنشاء صف إشعار جديد لمستخدم معيّن في جدول public.notifications.
 * الدالة دي "Fire and forget" بمعنى إنها مش المفروض توقف أي عملية
 * أساسية تانية لو فشلت (نفس فلسفة إنشاء إشعار طلب الصداقة في
 * sendFriendRequest بتاعة profiles.js) - المُستدعي هو اللي بيقرر لو
 * عايز يستنى نتيجتها (await) أو يسيبها تشتغل في الخلفية.
 *
 * @param {object} params
 * @param {string} params.userId - معرّف المستخدم المستقبِل للإشعار (user_id)
 * @param {string} params.type - نوع الإشعار، لازم يتطابق مع القيم المسموحة
 *   في notifications_type_check (مثلاً: 'friend_request', 'friend_accept',
 *   'story_reaction', 'achievement_unlocked', 'comment_reply',
 *   'comment_like', 'leaderboard_pass', 'system_broadcast'). ملحوظة: 'admin_message'
 *   مش من المفروض تتبعت من هنا خالص - محمية بـ trigger في القاعدة
 *   (protect_notifications_admin_type) ومسموحة بس من دوال الأدمن
 *   admin_send_notification/admin_broadcast_notification (شوف
 *   sql/phase-3-notifications.sql)
 * @param {string} params.title - عنوان الإشعار المعروض في الكارت
 * @param {string} params.message - نص/تفاصيل الإشعار المعروض تحت العنوان
 * @param {object} [params.data] - أي بيانات إضافية خاصة بنوع الإشعار
 *   (jsonb) - مثلاً sender_id/request_id لطلبات الصداقة، story_id
 *   لتفاعلات الستوري...إلخ. القيمة الافتراضية كائن فاضي لو مش محتاج
 *   بيانات إضافية (زي system_broadcast)
 * @returns {Promise<boolean>} true لو الإدراج نجح، false لو فشل
 */
export async function sendNotification({ userId, type, title, message, data = {} }) {
    if (!userId || !type || !title || !message) {
        console.error(
            '[notifications.js] sendNotification(): بيانات ناقصة - userId/type/title/message كلهم مطلوبين.',
            { userId, type, title, message },
        );
        return false;
    }

    try {
        const { error } = await supabaseClient
            .from('notifications')
            .insert({
                user_id: userId,
                type,
                title,
                message,
                data,
                is_read: false,
            });

        if (error) {
            console.error('[notifications.js] خطأ في إرسال الإشعار:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        // احتياطي: أي استثناء غير متوقع (مشكلة شبكة مثلاً) بنمسكه هنا
        // برضه عشان مايفضلش Promise مرفوض من غير معالجة يكسر باقي
        // العملية اللي استدعت الدالة
        console.error('[notifications.js] استثناء غير متوقع أثناء إرسال الإشعار:', err);
        return false;
    }
}

const DISMISSED_STORAGE_PREFIX = 'sekkawy_dismissed_notif_ids_';

/**
 * الحصول على معرفات الإشعارات المحذوفة محلياً للمستخدم الحالي لمنع ظهورها مجدداً
 * @returns {Set<string>}
 */
function getDismissedNotificationIds() {
    if (!currentUser?.id) return new Set();
    try {
        const raw = localStorage.getItem(`${DISMISSED_STORAGE_PREFIX}${currentUser.id}`);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (e) {
        return new Set();
    }
}

/**
 * حفظ معرفات إشعارات تم حذفها أو مشاهدتها في التخزين المحلي الدائم
 * @param {string|number|(string|number)[]} ids
 */
function recordDismissedNotificationIds(ids) {
    if (!currentUser?.id) return;
    const rawList = Array.isArray(ids) ? ids : [ids];
    const cleanList = rawList.filter((id) => id !== null && id !== undefined).map(String);
    if (cleanList.length === 0) return;

    try {
        const existing = getDismissedNotificationIds();
        cleanList.forEach((id) => existing.add(id));
        // الحد الأقصى للمعرفات المحفوظة لمنع تضخم localStorage (أحدث 500 معرف)
        const arr = Array.from(existing).slice(-500);
        localStorage.setItem(`${DISMISSED_STORAGE_PREFIX}${currentUser.id}`, JSON.stringify(arr));
    } catch (e) {
        console.warn('[notifications.js] تعذر حفظ معرفات الإشعارات المحذوفة في localStorage:', e);
    }
}

/**
 * إزالة إشعار أو أكثر من الذاكرة المحلية (notificationsCache) والواجهة فوراً.
 * تُستدعى محلياً أو عبر حدث 'app:notification-dismiss' عندما يتم قبول/إلغاء
 * فعل من أي مكان آخر بالتطبيق (مثل قبول صداقة من البروفايل أو شاشة الطلبات).
 *
 * @param {object} matcher
 * @param {string} [matcher.type] - نوع الإشعار (مثل 'friend_request', 'comment_like', 'story_reaction')
 * @param {string} [matcher.requestId] - معرف الطلب (data.request_id)
 * @param {string} [matcher.storyId] - معرف الاستوري (data.story_id)
 * @param {string} [matcher.commentId] - معرف التعليق (data.comment_id)
 * @param {string} [matcher.senderId] - معرف المرسل (data.sender_id)
 * @param {string} [matcher.notifId] - معرف الإشعار نفسه (notification.id)
 */
export function dismissNotificationLocally(matcher = {}) {
    if (!matcher || typeof matcher !== 'object') return;

    const { type, requestId, storyId, commentId, senderId, notifId } = matcher;

    const matches = (n) => {
        if (notifId && String(n.id) === String(notifId)) return true;
        if (type && n.type !== type) return false;

        const data = n.data || {};
        if (requestId && String(data.request_id) === String(requestId)) return true;
        if (storyId && String(data.story_id) === String(storyId)) {
            if (senderId && String(data.sender_id) !== String(senderId)) return false;
            return true;
        }
        if (commentId && String(data.comment_id) === String(commentId)) {
            if (senderId && String(data.sender_id) !== String(senderId)) return false;
            return true;
        }
        if (senderId && !requestId && !storyId && !commentId && String(data.sender_id) === String(senderId)) {
            return true;
        }
        if (type && !requestId && !storyId && !commentId && !senderId && !notifId) {
            return true;
        }
        return false;
    };

    const removedItems = notificationsCache.filter(matches);
    if (removedItems.length === 0) return;

    recordDismissedNotificationIds(removedItems.map((n) => n.id));

    notificationsCache = notificationsCache.filter((n) => !matches(n));
    updateUnreadBadges();

    // إزالة الكروت من الـ DOM مع أنيميشن ناعم
    removedItems.forEach((item) => {
        const card = document.querySelector(`.notif-card[data-notif-id="${item.id}"]`);
        if (card) {
            card.classList.add('is-removing');
            setTimeout(() => card.remove(), 350);
        }
    });

    if (notificationsCache.length === 0) {
        const emptyState = document.getElementById('notificationsEmptyState');
        if (emptyState) {
            emptyState.classList.remove('hidden');
            emptyState.classList.add('flex');
        }
    }
}

/**
 * حذف إشعار نهائياً من قاعدة البيانات (Supabase) ومن الذاكرة والواجهة معاً
 * @param {object} matcher
 */
export async function purgeNotificationRecord(matcher = {}) {
    if (matcher.notifId) {
        recordDismissedNotificationIds(matcher.notifId);
    }
    dismissNotificationLocally(matcher);

    if (!currentUser) return;

    try {
        let query = supabaseClient.from('notifications').delete().eq('user_id', currentUser.id);

        if (matcher.notifId) {
            query = query.eq('id', matcher.notifId);
        } else if (matcher.type) {
            query = query.eq('type', matcher.type);
            if (matcher.requestId) {
                query = query.filter('data->>request_id', 'eq', String(matcher.requestId));
            }
            if (matcher.storyId) {
                query = query.filter('data->>story_id', 'eq', String(matcher.storyId));
            }
            if (matcher.commentId) {
                query = query.filter('data->>comment_id', 'eq', String(matcher.commentId));
            }
            if (matcher.senderId) {
                query = query.filter('data->>sender_id', 'eq', String(matcher.senderId));
            }
        }

        const { error } = await query;
        if (error) {
            console.error('[notifications.js] خطأ أثناء حذف الإشعار من الداتابيز:', error.message);
        }
    } catch (err) {
        console.error('[notifications.js] استثناء أثناء purgeNotificationRecord:', err);
    }
}


/* ------------------------------------------------------------------
   2) نقطة الدخول العامة - initNotificationsUI()
   ------------------------------------------------------------------ */

/**
 * نقطة التهيئة الوحيدة للملف ده - تُستدعى مرة واحدة من app.js (initApp)
 * زي باقي دوال initXxxUI. بتربط كل مستمعات الـ UI الثابتة، وبتسجّل
 * مستمعين لحالة تسجيل الدخول/الخروج عشان تجيب/تنضّف بيانات الإشعارات
 * تلقائياً مع كل تغيير في هوية المستخدم.
 */
export function initNotificationsUI() {
    console.log('[notifications.js] initNotificationsUI() اتنادت.');
    bindStaticListeners();

    // 'auth:login' بتتطلق من auth.js في حالتين: أول تشغيل للتطبيق لو
    // فيه جلسة محفوظة صحيحة، أو فور نجاح تسجيل دخول/تسجيل حساب جديد.
    // في الحالتين بنعتبرها "لحظة معرفة هوية المستخدم" ونبدأ منها.
    document.addEventListener('auth:login', (event) => {
        handleUserSignedIn(event.detail.user);
    });

    document.addEventListener('auth:signed-out', () => {
        handleUserSignedOut();
    });
}

/**
 * بيرجع عنصر مودال الإشعارات نفسه، بتجربة كل الـ ids المحتملة في
 * NOTIFICATIONS_MODAL_IDS بالترتيب - شوف تعليق الـ selector فوق لسبب
 * وجود أكتر من احتمال
 * @returns {HTMLElement|null}
 */
function getNotificationsModalEl() {
    for (const id of NOTIFICATIONS_MODAL_IDS) {
        const el = document.getElementById(id);
        if (el) return el;
    }
    return null;
}

/**
 * تحديث نص الـ Empty State (العنوان + الوصف الفرعي) حسب السبب - بدون
 * أي كلاسات جديدة، بس بتحديث نص أول/آخر <p> جوه #notificationsEmptyState
 * @param {'notLoggedIn'|'noNotifications'} kind
 */
function setEmptyStateMessage(kind) {
    const emptyState = document.getElementById('notificationsEmptyState');
    if (!emptyState) return;

    const paragraphs = emptyState.querySelectorAll('p');
    const titleEl = paragraphs[0];
    const subtitleEl = paragraphs[1];
    const messages = EMPTY_STATE_MESSAGES[kind] || EMPTY_STATE_MESSAGES.noNotifications;

    if (titleEl) titleEl.textContent = messages.title;
    if (subtitleEl) subtitleEl.textContent = messages.subtitle;
}

/**
 * ربط كل مستمعات الـ UI اللي مش محتاجة تسجيل دخول (فتح/قفل المودال،
 * التبويبات، زرار تحديد الكل كمقروء). محمية بعلم hasBoundStaticListeners
 * عشان نضمن إنها تتربط مرة واحدة بس حتى لو initNotificationsUI اتنادت
 * أكتر من مرة بالغلط.
 */
function bindStaticListeners() {
    if (hasBoundStaticListeners) return;
    hasBoundStaticListeners = true;

    const modal = getNotificationsModalEl();
    const closeBtn = document.getElementById('btnCloseNotifications');
    const markAllReadBtn = document.getElementById('btnMarkAllRead');
    const tabAllBtn = document.getElementById('notifTabAll');
    const tabUnreadBtn = document.getElementById('notifTabUnread');
    const listContainer = document.getElementById('notificationsList');

    // بنربط *كل* الأزرار اللي بتطابق BELL_TRIGGER_SELECTOR (مش عنصر
    // واحد بس) عشان لو فيه أكتر من جرس إشعارات في الصفحة كلهم يشتغلوا.
    // لو مفيش ولا زرار واحد اتلقى، بنسجّل تحذير واضح في الـ Console
    // عشان أي حد بيدبج المشكلة يعرف على طول إن السبب هو عدم تطابق الـ
    // selector مع الـ HTML الفعلي، مش خطأ في منطق الفتح نفسه
    const bellTriggers = document.querySelectorAll(BELL_TRIGGER_SELECTOR);
    if (bellTriggers.length === 0) {
        console.warn(
            '[notifications.js] مفيش أي زرار "جرس إشعارات" اتلقى في الصفحة. '
            + `الكود بيدوّر على العناصر دي: ${BELL_TRIGGER_SELECTOR} — `
            + 'تأكد إن الزرار الفعلي في index.html عنده نفس الـ id/كلاس، '
            + 'أو ضيف data-notif-trigger عليه.',
        );
    }
    bellTriggers.forEach((btn) => btn.addEventListener('click', openNotificationsModal));

    if (!modal) {
        console.warn(
            '[notifications.js] مفيش عنصر مودال إشعارات اتلقى في الصفحة. '
            + `الكود بيدوّر على id من دول: ${NOTIFICATIONS_MODAL_IDS.join(', ')}.`,
        );
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeNotificationsModal);
    }

    // النقر على الخلفية الضبابية نفسها (مش على اللوحة اللي جواها) بيقفل
    // المودال - بنتأكد إن الضغطة كانت على العنصر الجذري نفسه (event.target
    // === event.currentTarget) عشان نقر داخل اللوحة (.notif-panel) ميقفلش
    // المودال بالغلط
    if (modal) {
        modal.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) {
                closeNotificationsModal();
            }
        });
    }

    if (markAllReadBtn) {
        // Guard بسيط ضد الضغط المتكرر بسرعة (Double Click) لحد ما الطلب
        // الحالي يخلص - عشان منبعتش أكتر من UPDATE مكرر لنفس الصفوف
        markAllReadBtn.addEventListener('click', async () => {
            if (markAllReadBtn.disabled) return;

            markAllReadBtn.disabled = true;
            markAllReadBtn.classList.add('opacity-50', 'pointer-events-none');
            try {
                await markAllNotificationsAsRead();
            } finally {
                markAllReadBtn.disabled = false;
                markAllReadBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        });
    }

    if (tabAllBtn) {
        tabAllBtn.addEventListener('click', () => setActiveFilter('all'));
    }
    if (tabUnreadBtn) {
        tabUnreadBtn.addEventListener('click', () => setActiveFilter('unread'));
    }

    // تفويض حدث واحد (Event Delegation) على الـ Container كله بدل ما
    // نربط listener مستقل على كل كارت لوحده - أبسط وأداؤه أفضل خصوصاً
    // إن الكروت بتتضاف/تتشال ديناميكياً طول الوقت
    if (listContainer) {
        listContainer.addEventListener('click', handleNotificationsListClick);

        // سحب لليمين للحذف (Swipe-to-delete) - نفس فلسفة تفويض حدث
        // الكليك فوق: مستمعات واحدة بس على الـ Container كله بدل ما
        // نربط كل كارت لوحده (شوف قسم 8.1: handleNotifCardPointerDown/
        // Move/Up تحت). pointercancel بنعالجه بنفس دالة pointerup عشان
        // لو اللمسة اتلغت لأي سبب برّاني (مكالمة واردة، تنبيه نظام)
        // الكارت يرجع مكانه بأمان بدل ما يفضل معلّق نص سحبة
        listContainer.addEventListener('pointerdown', handleNotifCardPointerDown);
        listContainer.addEventListener('pointermove', handleNotifCardPointerMove);
        listContainer.addEventListener('pointerup', handleNotifCardPointerUp);
        listContainer.addEventListener('pointercancel', handleNotifCardPointerUp);
    }

    // الاستماع لحدث تفريغ الإشعار من أي مكان في التطبيق (قبول صداقة، إلغاء لايك، إلخ)
    window.addEventListener('app:notification-dismiss', (event) => {
        if (event.detail) {
            purgeNotificationRecord(event.detail);
        }
    });
}


/* ------------------------------------------------------------------
   3) دخول/خروج المستخدم
   ------------------------------------------------------------------ */

/**
 * تُستدعى مع كل حدث 'auth:login' - بتحدّث المستخدم الحالي، تجيب
 * إشعاراته، وتفتح اشتراك Realtime جديد ليه
 * @param {import('@supabase/supabase-js').User} user
 */
async function handleUserSignedIn(user) {
    if (!user) return;

    // لو نفس المستخدم بالظبط اللي كان مسجل بالفعل (مثلاً auth:login
    // اتطلقت أكتر من مرة لنفس الجلسة)، مفيش داعي نعيد الجلب والاشتراك
    // من الصفر تاني
    if (currentUser && currentUser.id === user.id && realtimeChannel) return;

    currentUser = user;
    hasFetchedOnce = false;

    await fetchAndRenderNotifications();
    bindNotificationsRealtimeSubscription();
}

/** تُستدعى مع 'auth:signed-out' - بتنضّف كل حاجة خاصة بالمستخدم اللي خرج */
function handleUserSignedOut() {
    currentUser = null;
    notificationsCache = [];
    hasFetchedOnce = false;

    if (realtimeChannel) {
        supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }

    if (bellAnimationTimeoutId) {
        clearTimeout(bellAnimationTimeoutId);
        bellAnimationTimeoutId = null;
        document.getElementById('notificationBellBtn')?.classList.remove('bell-shake');
    }

    closeNotificationsModal();
    setEmptyStateMessage('notLoggedIn');
    renderNotificationsList();
    updateUnreadBadges();
}


/* ------------------------------------------------------------------
   4) فتح/قفل المودال
   ------------------------------------------------------------------ */

/**
 * فتح لوحة الإشعارات - بتعرض المودال فوراً وتسجله في تاريخ المتصفح
 * لربطه بزرار رجوع الموبايل (الهاردوير). لا نقوم بتمييز الكل كمقروء تلقائياً
 * فور الفتح للحفاظ على عمل تبويب "غير المقروء" وكروت الإشعارات الجديدة.
 */
export async function openNotificationsModal() {
    const modal = getNotificationsModalEl();
    if (!modal) {
        console.warn('[notifications.js] تعذّر فتح لوحة الإشعارات: عنصر المودال مش موجود في الصفحة.');
        return;
    }

    // تسجيل المودال في تاريخ المتصفح لربطه بزرار رجوع الموبايل (الهاردوير)
    pushModalState(hideNotificationsModal);

    // لو كان فيه مؤقّت إخفاء (hidden) شغال من محاولة قفل سابقة سريعة، بنلغيه
    if (closeModalTimeoutId) {
        clearTimeout(closeModalTimeoutId);
        closeModalTimeoutId = null;
    }

    modal.classList.remove('hidden');

    // Reflow بسيط إجباري قبل إضافة "is-open" عشان الـ transition يشتغل فعلاً
    void modal.offsetWidth;
    modal.classList.add('is-open');

    // إخفاء نقطة شارة الجرس في الهيدر أثناء وجود المستخدم داخل اللوحة
    const headerBadge = document.getElementById('headerNotificationBadge');
    if (headerBadge) {
        headerBadge.classList.add('hidden');
    }

    if (!currentUser) {
        setEmptyStateMessage('notLoggedIn');
        renderNotificationsList();
        return;
    }

    setEmptyStateMessage('noNotifications');

    if (!hasFetchedOnce) {
        await fetchAndRenderNotifications();
    }
}

/** الإخفاء الفعلي (الخام) للوحة الإشعارات - يُستدعى عبر closeModal() أو عند الضغط على زرار الرجوع */
export function hideNotificationsModal() {
    const modal = getNotificationsModalEl();
    if (!modal || modal.classList.contains('hidden')) return;

    modal.classList.remove('is-open');

    // تحديث شارات الإشعارات غير المقروءة بعد إغلاق اللوحة
    updateUnreadBadges();

    if (closeModalTimeoutId) clearTimeout(closeModalTimeoutId);
    closeModalTimeoutId = setTimeout(() => {
        modal.classList.add('hidden');
        closeModalTimeoutId = null;
    }, MODAL_CLOSE_TRANSITION_MS);
}

/** قفل لوحة الإشعارات متزامنًا مع تاريخ المتصفح وزرار رجوع الموبايل */
export function closeNotificationsModal() {
    const modal = getNotificationsModalEl();
    if (!modal || modal.classList.contains('hidden')) return;

    if (hasOpenModal()) {
        closeModal();
    } else {
        hideNotificationsModal();
    }
}


/* ------------------------------------------------------------------
   5) التبويبات (الكل / غير المقروء)
   ------------------------------------------------------------------ */

/**
 * تبديل التبويب النشط وإعادة تطبيق الفلترة على القائمة الحالية من
 * غير أي طلب جديد لـ Supabase (كله محلي من notificationsCache)
 * @param {'all'|'unread'} filter
 */
function setActiveFilter(filter) {
    currentFilter = filter;

    const tabAllBtn = document.getElementById('notifTabAll');
    const tabUnreadBtn = document.getElementById('notifTabUnread');

    if (tabAllBtn) tabAllBtn.classList.toggle('is-active', filter === 'all');
    if (tabUnreadBtn) tabUnreadBtn.classList.toggle('is-active', filter === 'unread');

    renderNotificationsList();
}


/* ------------------------------------------------------------------
   6) جلب الإشعارات من Supabase
   ------------------------------------------------------------------ */

/**
 * يجيب كل صفوف notifications الخاصة بالمستخدم الحالي من الأحدث
 * للأقدم، يخزّنها في notificationsCache، ويعيد رسم القائمة والشارات
 */
async function fetchAndRenderNotifications() {
    if (!currentUser) return;

    let data = null;
    let error = null;
    try {
        ({ data, error } = await supabaseClient
            .from('notifications')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false })
            .limit(NOTIFICATIONS_MAX_COUNT));
    } catch (err) {
        // احتياطي: لو فشل الاتصال نفسه (مثلاً المستخدم Offline) رمى استثناء
        // بدل ما يرجّع {error} عادي زي باقي حالات Supabase - بنمسكه هنا
        // عشان الصفحة متتجمدش بـ Promise مرفوض من غير معالجة
        error = err;
    }

    if (error) {
        console.error('خطأ في جلب الإشعارات:', error.message || error);
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تعذّر تحميل الإشعارات، حاول تاني', type: 'error' },
        }));
        return;
    }

    const serverNotifications = data || [];
    const dismissedIds = getDismissedNotificationIds();

    // فلترة أي إشعارات قام المستخدم بحذفها/مشاهدتها مسبقاً لضمان عدم عودتها إطلاقاً عند إعادة فتح التطبيق
    notificationsCache = serverNotifications.filter((n) => !dismissedIds.has(String(n.id)));

    // في الخلفية: محاولة تنظيف وحذف هذه الإشعارات من Supabase لضمان مزامنة السيرفر
    const lingeringDismissed = serverNotifications
        .filter((n) => dismissedIds.has(String(n.id)))
        .map((n) => n.id);

    if (lingeringDismissed.length > 0) {
        supabaseClient
            .from('notifications')
            .delete()
            .eq('user_id', currentUser.id)
            .in('id', lingeringDismissed)
            .then(({ error: delErr }) => {
                if (delErr) {
                    console.warn('[notifications.js] تنظيف الإشعارات المحذوفة مسبقاً في السيرفر:', delErr.message);
                }
            })
            .catch(() => {});
    }

    // 🧠 فحص ذاتي ذكي وتنظيف تلقائي (Self-Healing / Auto-Purge):
    // فحص إشعارات طلبات الصداقة المعلقة للتأكد من أنها ما زالت صالحة ولم تُقبل أو تُلغى في الخلفية
    const pendingFriendNotifs = notificationsCache.filter((n) => n.type === 'friend_request' && n.data?.request_id);
    if (pendingFriendNotifs.length > 0) {
        const requestIds = pendingFriendNotifs.map((n) => n.data.request_id);
        try {
            const { data: activeFriends } = await supabaseClient
                .from('friends')
                .select('id, status')
                .in('id', requestIds);

            const validPendingIds = new Set(
                (activeFriends || [])
                    .filter((f) => f.status === 'pending')
                    .map((f) => String(f.id))
            );

            const deadNotifs = pendingFriendNotifs.filter(
                (n) => !validPendingIds.has(String(n.data.request_id))
            );

            if (deadNotifs.length > 0) {
                const deadIds = deadNotifs.map((n) => n.id);
                notificationsCache = notificationsCache.filter((n) => !deadIds.includes(n.id));
                supabaseClient
                    .from('notifications')
                    .delete()
                    .in('id', deadIds)
                    .then(() => {});
            }
        } catch (sweepErr) {
            console.warn('[notifications.js] فحص التحقق الذاتي للطلبات المعلقة:', sweepErr);
        }
    }

    hasFetchedOnce = true;

    renderNotificationsList();
    updateUnreadBadges();
}


/* ------------------------------------------------------------------
   7) الرسم (Render) - القائمة + الشارات
   ------------------------------------------------------------------ */

/**
 * يمسح #notificationsList بالكامل (كل .notif-card - بما فيهم أمثلة
 * التصميم الثابتة المرحلة التانية لو لسه موجودة) ويعيد بناءها من
 * notificationsCache حسب currentFilter، عبر استنساخ
 * #notificationCardTemplate لكل صف
 */
function renderNotificationsList() {
    const listContainer = document.getElementById('notificationsList');
    const emptyState = document.getElementById('notificationsEmptyState');
    if (!listContainer) return;

    // بنشيل كل كروت الإشعارات الحالية بس (مش الـ Empty State نفسه، عشان
    // هو عنصر ثابت واحد بنتحكم في ظهوره/اختفاؤه بكلاس منفصل تحت)
    listContainer.querySelectorAll('.notif-card').forEach((card) => card.remove());

    const visibleNotifications = currentFilter === 'unread'
        ? notificationsCache.filter((n) => !n.is_read)
        : notificationsCache;

    visibleNotifications.forEach((notification) => {
        const card = buildNotificationCard(notification);
        if (card) listContainer.appendChild(card);
    });

    // Empty State بيظهر لو مفيش أي كروت متعرضة فعلياً في الفلتر الحالي
    // (سواء مفيش إشعارات خالص، أو كلها مقروءة وفاتح تبويب "غير المقروء")
    if (emptyState) {
        emptyState.classList.toggle('hidden', visibleNotifications.length > 0);
        emptyState.classList.toggle('flex', visibleNotifications.length === 0);
    }
}

/**
 * يستنسخ #notificationCardTemplate ويملأه ببيانات صف إشعار واحد
 * @param {object} notification - صف من جدول public.notifications
 * @returns {HTMLElement|null}
 */
function buildNotificationCard(notification) {
    const template = document.getElementById('notificationCardTemplate');
    if (!template) return null;

    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector('.notif-card');
    if (!card) return null;

    card.dataset.notifId = notification.id;
    card.dataset.notifType = notification.type;
    card.classList.toggle('is-unread', !notification.is_read);

    // معرّف مُرسل طلب الصداقة (أو صاحب البروفايل اللي قبل طلبك) - مخزّن
    // هنا على مستوى الكارت نفسه (مش بس جوه أزرار قبول/رفض) عشان نقدر
    // نفتح بروفايله العام لو المستخدم ضغط على صورته/اسمه أو على الكارت
    // كله (حسب النوع - شوف الفرع الخاص بكل نوع في
    // handleNotificationsListClick تحت)
    if (
        (notification.type === 'friend_request' || notification.type === 'friend_accept')
        && notification.data && notification.data.sender_id
    ) {
        card.dataset.senderId = notification.data.sender_id;
    }

    // (تعديل - المرحلة 8) إشعار "support_message" بيوصل للأدمن لما
    // مستخدم عادي يبعت رسالة جديدة في شات الدعم - محتاجين sender_id
    // بتاعه عشان نقدر نفتح شاته هو بالظبط لما الأدمن يضغط على الإشعار
    // (شوف openSupportChatAsAdminWithUser في handleNotificationsListClick تحت)
    if (
        notification.type === 'support_message'
        && notification.data && notification.data.sender_id
    ) {
        card.dataset.senderId = notification.data.sender_id;
    }

    // معرّف الستوري المرتبطة بإشعار تفاعل على ستوري - محتاجينه عشان
    // نقدر نفتح الستوري بالظبط اللي حصل عليها التفاعل لما المستخدم
    // يضغط على الإشعار (شوف openStoryById تحت)
    if (
        notification.type === 'story_reaction'
        && notification.data && notification.data.story_id
    ) {
        card.dataset.storyId = notification.data.story_id;
    }

    // معرّف المنشور (+ الكومنت الأساسي المرتبط) لإشعارات الرد/اللايك على
    // كومنت - محتاجينهم عشان نقدر نوصل بالظبط لنفس المنشور ونفتح قسم
    // الكومنتات على الكومنت المقصود لما المستخدم يضغط على الإشعار (شوف
    // openPostReplyById تحت - نفس دالة التنقل لكل الاثنين)
    if (
        (notification.type === 'comment_reply' || notification.type === 'comment_like')
        && notification.data && notification.data.post_id
    ) {
        card.dataset.postId = notification.data.post_id;
        if (notification.data.comment_id) card.dataset.commentId = notification.data.comment_id;
    }

    const iconWrapEl = card.querySelector('.notif-icon-wrap');
    const iconEl = card.querySelector('.notif-icon');

    // أنواع الإشعارات اللي ليها "مُرسل" حقيقي (حد تاني عمل حاجة) وبنعرض
    // صورة بروفايله بدل الإيموجي العام - لو نوع جديد اتضاف بنفس الفكرة
    // (مُرسل ليه صورة)، لازم يتضاف هنا وبيبعت sender_avatar_url في الـ
    // data وقت الإرسال (sendNotification) عشان الصورة تظهر فعلاً
    const AVATAR_NOTIFICATION_TYPES = ['friend_request', 'friend_accept', 'leaderboard_pass', 'story_reaction', 'comment_reply', 'comment_like'];

    // (تعديل) أنواع الأوسمة/الإنجازات - بتاخد ميدالية SVG (ACHIEVEMENT_BADGE_SVG
    // فوق) بدل الدايرة الفاضية اللي كانت شكلها مش حلو
    const BADGE_NOTIFICATION_TYPES = ['achievement', 'achievement_unlocked'];

    if (AVATAR_NOTIFICATION_TYPES.includes(notification.type)) {
        // بدل الإيموجي العام، بنعرض صورة بروفايل صاحب الطلب/اللي تخطاك/
        // اللي قبل طلبك/اللي تفاعل مع الاستوري بتاعك الفعلية (متخزّنة في
        // data.sender_avatar_url وقت إنشاء الإشعار - شوف sendFriendRequest/
        // acceptFriendRequest/notifyLeaderboardPassIfNeeded في profiles.js
        // وtoggleStoryLike في stories.js)، مع صورة احتياطية لو مش موجودة
        const senderAvatarUrl = (notification.data && notification.data.sender_avatar_url)
            || FALLBACK_SENDER_AVATAR;

        if (iconWrapEl) {
            iconWrapEl.innerHTML = `<img src="${senderAvatarUrl}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_SENDER_AVATAR}'" class="notif-avatar-img">`;
        }
    } else if (BADGE_NOTIFICATION_TYPES.includes(notification.type)) {
        if (iconWrapEl) iconWrapEl.innerHTML = ACHIEVEMENT_BADGE_SVG;
    } else if (
        iconEl
        // (تعديل - المرحلة 8) admin_reply (رد الأدمن) وsupport_message
        // (رسالة مستخدم جديدة للأدمن) بنفس معاملة admin_message - كارت
        // نصي بالكامل من غير دايرة/أيقونة (شوف .notif-card[data-notif-type]
        // في css/style.css)
        && !['admin_message', 'admin_reply', 'support_message'].includes(notification.type)
    ) {
        iconEl.innerHTML = NOTIFICATION_ICONS[notification.type] || '';
    }

    const titleEl = card.querySelector('.notif-title');
    if (titleEl) titleEl.textContent = notification.title;

    const messageEl = card.querySelector('.notif-message');
    if (messageEl) messageEl.textContent = notification.message;

    const timeEl = card.querySelector('.notif-time');
    if (timeEl) timeEl.textContent = formatRelativeTimeArabic(notification.created_at);

    // أزرار قبول/رفض طلب الصداقة: CSS بتظهرهم تلقائياً لو data-notif-type
    // = "friend_request"، لكن بنحتاج فعلياً معرّف صف friends
    // (notification.data.request_id) عشان الزرارين يعرفوا يشتغلوا على
    // أنهي طلب. لو مش موجود لأي سبب (صف قديم اتعمل قبل ما نضيف الحقل
    // مثلاً)، بنخفي أزرار الفعل ونسيب الكارت للعرض بس عشان منسيبش
    // زرار مكسور
    const requestId = notification.data && notification.data.request_id;
    const acceptBtn = card.querySelector('.notif-action-accept');
    const rejectBtn = card.querySelector('.notif-action-reject');

    if (notification.type === 'friend_request' && requestId) {
        if (acceptBtn) acceptBtn.dataset.requestId = requestId;
        if (rejectBtn) rejectBtn.dataset.requestId = requestId;
    } else {
        const actionsWrap = card.querySelector('.notif-actions');
        if (actionsWrap) actionsWrap.style.display = 'none';
    }

    return card;
}

/**
 * يحسب عدد الإشعارات غير المقروءة ويحدّث كل الشارات المرتبطة بيه:
 * شارة الجرس في الهيدر (#headerNotificationBadge) وشارة تبويب "غير
 * المقروء" (#notifUnreadTabCount)
 */
function updateUnreadBadges() {
    const unreadCount = notificationsCache.filter((n) => !n.is_read).length;

    const headerBadge = document.getElementById('headerNotificationBadge');
    const headerCount = document.getElementById('headerNotificationCount');
    const tabCount = document.getElementById('notifUnreadTabCount');

    if (headerCount) headerCount.textContent = unreadCount > 99 ? '99+' : String(unreadCount);

    const modal = getNotificationsModalEl();
    const isModalOpen = modal && modal.classList.contains('is-open');

    // إذا كانت لوحة الإشعارات مفتوحة حالياً، نخفي شارة الجرس في الهيدر
    if (headerBadge) {
        if (isModalOpen || unreadCount === 0) {
            headerBadge.classList.add('hidden');
        } else {
            headerBadge.classList.remove('hidden');
        }
    }

    if (tabCount) {
        tabCount.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        tabCount.classList.toggle('hidden', unreadCount === 0);
    }
}


/* ------------------------------------------------------------------
   7.5) منطق "فين نروح" الموحّد (Deep Linking) - Phase 6 من الخطة
   ------------------------------------------------------------------
   نفس منطق الـ switch اللي كان قبل كده جوه handleNotificationsListClick
   بالظبط، لكن بياخد type/data بدل ما ياخدهم من dataset كارت في الـ DOM
   مباشرة، وبيرجع { action: fn } أو null بدل ما ينفّذ التنقّل مباشرة -
   عشان كل مستدعي (كليك في المودال هنا في handleNotificationsListClick،
   أو تاب على Push Notification في push.js وقت التطبيق مقفول/بالخلفية)
   يقرر بنفسه هل يقفل مودال / يشيل كارت من الـ DOM... إلخ قبل ما ينادي
   action() فعليًا - بالشكل ده أي نوع إشعار جديد يتضاف مستقبلًا، التعديل
   بيحصل مكان واحد بس.
   ------------------------------------------------------------------ */

/**
 * @param {string} type - نوع الإشعار (notification.type / notifType)
 * @param {object} data - نفس بيانات عمود `data` (jsonb) بتاعة صف
 *   الإشعار: زي { sender_id, story_id, post_id, comment_id, ... }
 * @returns {{ action: () => void } | null} - null لو النوع مش معروف
 *   أو البيانات اللازمة للتنقّل ناقصة (المستدعي في الحالة دي المفروض
 *   يكتفي بعمل markNotificationAsRead بس)
 */
export function resolveNotificationNavigation(type, data) {
    data = data || {};

    switch (type) {
        case 'friend_request':
            // طلب صداقة وارد - نفتح البروفايل العام للمُرسل أو لوحة الإشعارات
            if (data.sender_id) {
                return { action: () => openPublicProfile(data.sender_id, { replaceHistory: true }) };
            }
            return { action: () => openNotificationsModal() };

        case 'friend_accept':
            // حد قبل طلب صداقتك - بنفتح بروفايله العام مباشرة (نفس
            // فلسفة فتح البروفايل من أي مكان تاني في المشروع)
            if (!data.sender_id) return null;
            return { action: () => openPublicProfile(data.sender_id, { replaceHistory: true }) };

        case 'story_reaction':
            // حد تفاعل مع ستوري بتاعتك - بنفتح نفس الستوري دي بالظبط
            // لو لسه متاحة (لو مش متاحة، openStoryById بتعرض توست بنفسها)
            if (!data.story_id) return null;
            return { action: () => openStoryById(data.story_id) };

        case 'achievement':
        case 'achievement_unlocked':
            // فتحت وسام جديد - بنودّيك لتبويب بروفايلي عشان تشوفه في
            // دولاب الأوسمة
            return { action: () => navigateToAchievementsSection() };

        case 'leaderboard_pass':
            // حد تخطاك في الترتيب - بنودّيك لتبويب "الترتيب" مباشرة
            return { action: () => navigateToLeaderboardSection() };

        case 'comment_reply':
        case 'comment_like':
            // حد رد على كومنت بتاعك أو عمل لايك عليه - بنودّيك لتبويب
            // المنشورات ونفتح قسم الكومنتات بتاعة نفس المنشور على
            // الكومنت بالظبط (لو لسه موجود)
            if (!data.post_id) return null;
            return { action: () => openPostReplyById(data.post_id, data.comment_id) };

        case 'admin_reply':
            // الأدمن رد عليك في شات الدعم - بنفتحلك نفس شاتك معاه على طول
            return { action: () => openSupportChatWithAdmin() };

        case 'support_message':
            // مستخدم بعت رسالة جديدة في شات الدعم - النوع ده بيوصل
            // للأدمن بس، وبيفتحله شاته هو بالظبط مع المستخدم ده
            if (!data.sender_id) return null;
            return { action: () => openSupportChatAsAdminWithUser(data.sender_id) };

        default:
            return null;
    }
}

/* ------------------------------------------------------------------
   8) تفويض النقر داخل القائمة (كارت فردي / أزرار قبول-رفض)
   ------------------------------------------------------------------ */

/**
 * مستمع واحد على #notificationsList (Event Delegation) بيتعامل مع
 * كل الضغطات جواه: زرار قبول، زرار رفض، أو أي نقر تاني على الكارت
 * نفسه (بيعتبره "فتح/قراءة" الإشعار)
 * @param {MouseEvent} event
 */
function handleNotificationsListClick(event) {
    const acceptBtn = event.target.closest('.notif-action-accept');
    const rejectBtn = event.target.closest('.notif-action-reject');
    const card = event.target.closest('.notif-card');

    // Guard ضد الضغط المتكرر (Double Click): لو الكارت ده أصلاً وسط
    // معالجة طلب قبول/رفض سابق (card.dataset.processing)، بنتجاهل أي
    // ضغطة جديدة عليه تماماً - الزرارين نفسهم بيتعطّلوا (disabled) في
    // handleFriendRequestAction، فده طبقة حماية إضافية بس (مثلاً لو
    // حدث تكراري اتطلق من قبل ما التعطيل يتطبق فعلياً على الـ DOM)
    if ((acceptBtn || rejectBtn) && card && card.dataset.processing === 'true') {
        return;
    }

    if (acceptBtn) {
        event.stopPropagation();
        handleFriendRequestAction(card, acceptBtn.dataset.requestId, 'accept');
        return;
    }

    if (rejectBtn) {
        event.stopPropagation();
        handleFriendRequestAction(card, rejectBtn.dataset.requestId, 'reject');
        return;
    }

    if (!card) return;

    // friend_request: منطقة الضغط محصورة عمداً في الصورة/الاسم بس (مش
    // الكارت كله)، عشان زرار "قبول/رفض" ومنطقة الرسالة/الوقت تفضل
    // بتعمل markNotificationAsRead العادي من غير ما تفتح البروفايل
    // بالغلط وهو لسه بيقرر يقبل ولا يرفض
    if (card.dataset.notifType === 'friend_request') {
        const profileTrigger = event.target.closest('.notif-icon-wrap, .notif-title');
        if (profileTrigger && card.dataset.senderId) {
            markNotificationAsRead(card.dataset.notifId);
            closeNotificationsModal();
            openPublicProfile(card.dataset.senderId, { replaceHistory: true });
            return;
        }

        if (card.dataset.notifId) markNotificationAsRead(card.dataset.notifId);
        return;
    }

    // باقي الأنواع: مفيش زرارين قبول/رفض هنا، فالضغط في أي مكان في
    // الكارت (مش منطقة محصورة زي friend_request) بيعتبر "فتح" الإشعار.
    // لو الضغطة أدّت فعلياً لتنقّل لمكان الإشعار (فتح بروفايل/ستوري/
    // بوست/شات..إلخ)، بنحذف الكارت نهائياً بدل ما نكتفي بتعليمه مقروء -
    // عشان الإشعار ما يفضلش عالق في اللوحة من غير داعي بعد ما المستخدم
    // شافه فعلاً وراح لمكانه (نفس منطق الحذف المستخدم أصلاً في قبول/رفض
    // طلبات الصداقة). لو مفيش تنقّل حصل فعلاً (مثلاً البيانات ناقصة)
    // بنكتفي بتعليمه مقروء زي الأول.
    // (تعديل - Phase 6) بدل الـ switch اللي كان هنا بالظبط، بنستخدم
    // دلوقتي resolveNotificationNavigation الموحّدة (شوف قسم 7.5 فوق) -
    // نفس بيانات dataset الكارت بنبنيها كـ object زي شكل عمود `data`
    // بتاع صف الإشعار، ونمررها هي والنوع للدالة. لو رجّعت action فعلي
    // (يعني فيه تنقّل ممكن يحصل)، بنعمل نفس اللي كان بيحصل قبل كده:
    // نقفل المودال، ننفّذ التنقّل، ونحذف الكارت. لو رجّعت null (نوع مش
    // معروف أو بيانات ناقصة)، نكتفي بتعليم الإشعار مقروء زي الأول
    const navigation = resolveNotificationNavigation(card.dataset.notifType, {
        sender_id: card.dataset.senderId,
        story_id: card.dataset.storyId,
        post_id: card.dataset.postId,
        comment_id: card.dataset.commentId,
    });

    if (navigation && navigation.action) {
        closeNotificationsModal();
        navigation.action();
        removeNotificationCard(card);
    } else if (card.dataset.notifId) {
        markNotificationAsRead(card.dataset.notifId);
        // النقر على الإشعار يعتبر مشاهدة له وتتم إزالته من القائمة بسلاسة
        removeNotificationCard(card);
    }
}

/* ------------------------------------------------------------------
   8.1) السحب لليمين للحذف (Swipe-to-delete)
   ------------------------------------------------------------------
   بيسمح للمستخدم يمسح إشعار بسحبه لليمين (زي أي تطبيق موبايل عادي)
   بدل ما يفضل الحذف اليدوي متاح بس داخلياً بعد قبول/رفض طلب صداقة.
   بيستخدم Pointer Events (بتوحّد Touch/Mouse/Pen في واجهة واحدة) مع
   Event Delegation على #notificationsList (نفس فلسفة
   handleNotificationsListClick فوق) - فمحتاجينش نربط listener منفصل
   على كل كارت بيتضاف/يتشال ديناميكياً.
   ------------------------------------------------------------------ */

/** أقل مسافة حركة (بكسل) قبل ما نقدر نقرر إن ده سحب أفقي فعلي مش سكرول رأسي عادي للقائمة أو مجرد لمسة/نقرة */
const SWIPE_DECISION_THRESHOLD_PX = 10;

/** النسبة من عرض الكارت اللي لو المستخدم سحب أكتر منها، بيتحذف الإشعار تلقائياً عند رفع إصبعه */
const SWIPE_DELETE_RATIO = 0.38;

/** حالة السحب الحالي - إشعار واحد بس ممكن يتسحب في نفس اللحظة، null لو مفيش سحب شغال دلوقتي */
let activeSwipe = null;

/**
 * بداية أي لمسة/ضغطة جوه #notificationsList - بنسجّل بس نقطة البداية
 * ومرجع الكارت، من غير ما نقرر لسه إن ده سحب أو نقر عادي أو سكرول
 * (القرار ده بيحصل تدريجياً أول ما فيه حركة كفاية في handleNotifCardPointerMove)
 * @param {PointerEvent} event
 */
function handleNotifCardPointerDown(event) {
    // بنرفض كليك يمين/نص بالماوس بس (مالوش تأثير على اللمس/القلم، دول
    // مبيبعتوش button مغاير هنا أصلاً)
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const card = event.target.closest('.notif-card');
    if (!card) return;

    // منسمحش بسحب كارت لسه بيتعالج (قبول/رفض طلب صداقة شغال عليه
    // فعلياً)، أو لو الضغطة كانت على زرار قبول/رفض نفسه - سيبها تشتغل
    // عادي كنقرة من غير أي تعارض مع منطق السحب
    if (card.dataset.processing === 'true') return;
    if (event.target.closest('.notif-action-btn')) return;

    const inner = card.querySelector('.notif-card-inner');
    if (!inner) return;

    activeSwipe = {
        pointerId: event.pointerId,
        card,
        inner,
        startX: event.clientX,
        startY: event.clientY,
        dx: 0,
        // null = لسه ما اتحددش الاتجاه الغالب، true/false بعد ما نتعدى SWIPE_DECISION_THRESHOLD_PX
        isHorizontal: null,
    };
}

/**
 * كل حركة للإصبع/الماوس بعد pointerdown - أول ما الحركة تتعدى الحد
 * الأدنى، بنقرر لو الاتجاه الغالب أفقي (سحب فعلي، فبنمنع سكرول الصفحة
 * الافتراضي ونحرّك محتوى الكارت مع الإصبع) أو رأسي (سكرول عادي
 * للقائمة، فبنسيب المتصفح يتصرف عادي ومنكملش تتبع الكارت ده خالص)
 * @param {PointerEvent} event
 */
function handleNotifCardPointerMove(event) {
    if (!activeSwipe || event.pointerId !== activeSwipe.pointerId) return;

    const deltaX = event.clientX - activeSwipe.startX;
    const deltaY = event.clientY - activeSwipe.startY;

    if (activeSwipe.isHorizontal === null) {
        if (Math.abs(deltaX) < SWIPE_DECISION_THRESHOLD_PX && Math.abs(deltaY) < SWIPE_DECISION_THRESHOLD_PX) {
            return; // لسه الحركة صغيرة جداً، منقدرش نقرر الاتجاه بثقة
        }
        activeSwipe.isHorizontal = Math.abs(deltaX) > Math.abs(deltaY);
        if (activeSwipe.isHorizontal) {
            activeSwipe.inner.classList.add('is-dragging');
            const bg = activeSwipe.card.querySelector('.notif-swipe-bg');
            if (bg) bg.classList.add('is-dragging');
        } else {
            activeSwipe = null; // سكرول رأسي عادي - بنلغي تتبعنا للكارت ده تماماً
            return;
        }
    }

    if (!activeSwipe.isHorizontal) return;

    // بنمنع سلوك المتصفح الافتراضي (سكرول/الرجوع للخلف بالسحب) بس لما
    // نكون متأكدين فعلاً إن ده سحب أفقي مقصود من المستخدم
    event.preventDefault();

    // المطلوب: سحب لليمين بس = حذف. أي سحب لليسار بنعامله بمقاومة قوية
    // (10% بس من المسافة الفعلية) بدل ما نمنعه تماماً، عشان يفضل حاسس
    // إنه بيسحب بس واضح بصرياً إن الاتجاه ده مالوش تأثير حقيقي
    const draggedX = deltaX > 0 ? deltaX : deltaX * 0.1;

    activeSwipe.dx = draggedX;
    activeSwipe.inner.style.transform = `translateX(${draggedX}px)`;

    const bg = activeSwipe.card.querySelector('.notif-swipe-bg');
    if (bg) {
        // عرض خلفية "حذف" بيتبع مسافة السحب بالظبط (مش طبقة كاملة
        // العرض ظاهرة طول الوقت) - بكده مش ظاهرة خالص لو مفيش سحب فعلي
        const deleteThreshold = activeSwipe.card.offsetWidth * SWIPE_DELETE_RATIO;
        bg.style.width = `${Math.max(0, draggedX)}px`;
        bg.classList.toggle('is-armed', draggedX >= deleteThreshold);
    }
}

/**
 * رفع الإصبع/الماوس (أو إلغاء اللمسة لأي سبب - مكالمة واردة أثناء
 * السحب مثلاً) - بتقرر النتيجة النهائية: لو المستخدم سحب لليمين أكتر
 * من SWIPE_DELETE_RATIO من عرض الكارت، بيتحذف الإشعار فوراً (بنفس
 * removeNotificationCard المستخدمة أصلاً بعد قبول/رفض طلب صداقة - نفس
 * منطق الحذف والـ Collapse بالظبط، من غير أي تكرار). غير كده، الكارت
 * بيرجع لمكانه الطبيعي بانيميشن ناعمة
 * @param {PointerEvent} event
 */
function handleNotifCardPointerUp(event) {
    if (!activeSwipe || event.pointerId !== activeSwipe.pointerId) return;

    const swipe = activeSwipe;
    activeSwipe = null;

    if (!swipe.isHorizontal) return; // كان سكرول رأسي أو نقرة عادية - سيبها تتعامل عادي

    swipe.inner.classList.remove('is-dragging');

    // الكارت اتسحب فعلاً (مش مجرد نقرة) - بنمنع حدث click التالي اللي
    // المتصفح بيطلقه تلقائياً بعد pointerup، عشان منفتحش الإشعار أو
    // نعلّمه مقروء بالغلط فوق فعل السحب (حذف أو رجوع لمكانه)
    suppressNextClick(swipe.card);

    const bg = swipe.card.querySelector('.notif-swipe-bg');
    const deleteThreshold = swipe.card.offsetWidth * SWIPE_DELETE_RATIO;
    const shouldDelete = swipe.dx >= deleteThreshold;

    if (shouldDelete) {
        // بنكمل الحركة لخارج الكارت بالكامل لإحساس بصري إن الإشعار
        // "طار"، وبعدها مباشرة بنستدعي removeNotificationCard (هي اللي
        // بتعمل الـ Collapse + الحذف الفعلي من قاعدة البيانات ومن
        // notificationsCache - نفس الدالة بالظبط المستخدمة في
        // handleFriendRequestAction فوق)
        swipe.inner.style.transition = 'transform 0.2s ease-in';
        swipe.inner.style.transform = `translateX(${swipe.card.offsetWidth}px)`;
        if (bg) {
            bg.classList.remove('is-dragging');
            bg.style.width = `${swipe.card.offsetWidth}px`;
        }
        setTimeout(() => removeNotificationCard(swipe.card), 160);
        return;
    }

    // تحت الحد المطلوب - بيرجع مكانه بانيميشن مطاطية خفيفة (نفس
    // الـ transition الافتراضية بتاعة .notif-card-inner في CSS، بس
    // بنتأكد منها هنا صراحة لأن is-dragging كان لغاها شوية فوق)
    swipe.inner.style.transition = '';
    swipe.inner.style.transform = 'translateX(0)';

    if (bg) {
        bg.classList.remove('is-dragging', 'is-armed');
        bg.style.width = '0px';
    }
}

/**
 * بتمنع أول حدث click جاي على الكارت ده بس - المتصفح بيطلق click تلقائي
 * بعد pointerup حتى لو كانت الضغطة سحب طويل ملوش علاقة بالنقر العادي،
 * فلازم نوقفه يدوياً (Capture Phase قبل ما يوصل لـ handleNotificationsListClick)
 * عشان منفتحش/منعلّمش الإشعار مقروء بالغلط فور ما المستخدم يسحبه
 * @param {HTMLElement} card
 */
function suppressNextClick(card) {
    const suppress = (clickEvent) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
    };
    card.addEventListener('click', suppress, { capture: true, once: true });
    // احتياطي: لو حدث click لأي سبب مجاش خالص (الكارت اتشال من الـ DOM
    // قبل كده مثلاً)، بنشيل الـ listener بعد نص ثانية عشان منسيبوش
    // معلّق من غير داعي
    setTimeout(() => card.removeEventListener('click', suppress, { capture: true }), 500);
}


/**
 * يفتح مودال مشاهدة الستوريز على استوري معينة بمعرّفها
 * (notification.data.story_id) - openStory() بتاعة stories.js بتاخد
 * *ترتيب* (index) مش معرّف (id) مباشرة، فبندوّر عليها الأول في
 * getStories() الحالية. لو الاستوري خلصت مدتها أو اتحذفت (مش موجودة
 * النهاردة)، بنعرض توست واضح بدل ما نفشل بصمت
 * @param {string} storyId
 */
function openStoryById(storyId) {
    const stories = getStories();
    const index = stories.findIndex((s) => String(s.id) === String(storyId));

    if (index === -1) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'الاستوري ده لم يعد متاحاً', type: 'info' },
        }));
        return;
    }

    openStory(index);
}

/**
 * الانتقال لتبويب "بروفايلي" (اللي فيه دولاب الأوسمة والشارات) بعد فتح
 * إشعار "فتحت وسام جديد" - بنستخدم حدث مخصص 'app:switch-tab' بدل ما
 * نستورد switchTab من app.js مباشرة (نفس فلسفة app:toast/app:sound
 * الموصوفة أعلى الملف، عشان نتجنب Circular Import: app.js هو أصلاً
 * اللي بيستورد initNotificationsUI من هنا). app.js هو المسؤول عن
 * الاستماع للحدث ده وتفعيل التاب فعلياً + التمرير لقسم الأوسمة
 * (#badgesGrid) بعد ما يبقى ظاهر
 */
function navigateToAchievementsSection() {
    document.dispatchEvent(new CustomEvent('app:switch-tab', {
        detail: { tabId: 'profile', scrollToId: 'badgesGrid' },
    }));
}

/**
 * الانتقال لتبويب "الترتيب" (لوحة الصدارة) بعد فتح إشعار "حد تخطاك في
 * الترتيب" - بنفس فلسفة navigateToAchievementsSection فوق (حدث مخصص
 * 'app:switch-tab' بدل استيراد switchTab مباشرة من app.js)
 */
function navigateToLeaderboardSection() {
    document.dispatchEvent(new CustomEvent('app:switch-tab', {
        detail: { tabId: 'leaderboard' },
    }));
}

/**
 * فتح المنشور اللي حصل فيه رد/لايك على كومنت بتاعك، وقسم الكومنتات
 * بتاعه على الكومنت المقصود بالظبط. المنشورات مش عندها section/id ثابت
 * زي بروفايلي (badgesGrid) عشان نستخدم scrollToId بتاعة 'app:switch-tab'
 * العادية، فبنبعت حدث تاني مخصص ليها بس ('posts:open-comment') بعد
 * التبديل للتاب - نفس فلسفة app:switch-tab/app:toast (تجنب استيراد دوال
 * posts.js هنا مباشرة، عشان منعملش Circular Import: posts.js أصلاً
 * بيستورد sendNotification من الملف ده عشان يبعت الإشعارين دول من
 * الأساس - شوف handleCommentSubmit/handleCommentLikeToggle في
 * posts.js). posts.js هو المسؤول عن الاستماع للحدث ده وفتح قسم
 * الكومنتات + التمرير + تظليل الكومنت لحظياً لو لسه موجود؛ لو المنشور
 * أو الكومنت اتحذف، posts.js نفسه بيعرض توست واضح بدل ما يفشل بصمت
 * (نفس فلسفة openStoryById فوق)
 * @param {string} postId
 * @param {string|undefined} commentId
 */
function openPostReplyById(postId, commentId) {
    document.dispatchEvent(new CustomEvent('app:switch-tab', {
        detail: { tabId: 'home' },
    }));
    document.dispatchEvent(new CustomEvent('posts:open-comment', {
        detail: { postId, commentId },
    }));
}

/** مدة عرض رسالة التأكيد ("تم قبول الطلب" مثلاً) جوه الكارت قبل ما يتشال بانيميشن الإزالة المعتادة (is-removing) */
const FRIEND_ACTION_CONFIRM_DISPLAY_MS = 900;

/**
 * قبول/رفض طلب صداقة من داخل كارت إشعار - بيستخدم الدوال الجاهزة من
 * profiles.js (هي المسؤولة عن تحديث/حذف صف friends وعمل reload لقائمة
 * الأصدقاء). محمية ضد الضغط المتكرر (بتعطيل الزرارين فوراً)، وبتفرّق
 * بين النجاح والفشل بدل ما تفترض النجاح دايماً:
 *   - فشل: بترجّع الزرارين شغالين تاني عشان المستخدم يقدر يعيد المحاولة
 *     (توست الخطأ نفسه بيتبعت من جوه acceptFriendRequest/rejectFriendRequest)
 *   - نجاح: بتستبدل الزرارين برسالة تأكيد بسيطة جوه الكارت لثانية تقريباً،
 *     وبعدين تشيل الكارت بانيميشن الإزالة المعتاد (is-removing) لأنه بقى
 *     مش لازم (الطلب اتعالج)
 * @param {HTMLElement|null} card
 * @param {string|undefined} requestId
 * @param {'accept'|'reject'} action
 */
async function handleFriendRequestAction(card, requestId, action) {
    if (!requestId || !card) return;

    card.dataset.processing = 'true';
    setFriendRequestButtonsDisabled(card, true);

    let error = null;
    try {
        const result = action === 'accept'
            ? await acceptFriendRequest(requestId)
            : await rejectFriendRequest(requestId);
        error = (result && result.error) || null;
    } catch (err) {
        // احتياطي: أي استثناء غير متوقع (مش شكل {error} العادي من
        // Supabase) بنمسكه هنا برضه عشان مايفضلش Promise مرفوض من غير
        // معالجة يكسر باقي التطبيق
        error = err;
        console.error('خطأ غير متوقع أثناء معالجة طلب الصداقة:', err);
    }

    if (error) {
        card.dataset.processing = 'false';
        setFriendRequestButtonsDisabled(card, false);
        return;
    }

    showFriendRequestActionResult(card, action);
    setTimeout(() => removeNotificationCard(card), FRIEND_ACTION_CONFIRM_DISPLAY_MS);
}

/**
 * تعطيل/تفعيل زرار "قبول" و"رفض" داخل كارت طلب صداقة معيّن - بصرياً
 * (opacity + pointer-events) ووظيفياً (disabled الحقيقي، عشان الزرار
 * المعطّل أصلاً مايطلقش حدث click في المتصفح، فده أول خط حماية ضد
 * الضغط المزدوج قبل الـ Guard التاني في handleNotificationsListClick)
 * @param {HTMLElement} card
 * @param {boolean} disabled
 */
function setFriendRequestButtonsDisabled(card, disabled) {
    const acceptBtn = card.querySelector('.notif-action-accept');
    const rejectBtn = card.querySelector('.notif-action-reject');

    [acceptBtn, rejectBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = disabled;
        btn.classList.toggle('opacity-50', disabled);
        btn.classList.toggle('pointer-events-none', disabled);
    });
}

/**
 * بعد نجاح قبول/رفض طلب الصداقة - بنستبدل زرارين "قبول/رفض" برسالة
 * تأكيد بسيطة جوه نفس مكانهم (.notif-action-result، شكلها في CSS)
 * عشان المستخدم يشوف تغذية راجعة واضحة إن الضغطة نجحت فعلاً قبل ما
 * الكارت يختفي من قدامه
 * @param {HTMLElement} card
 * @param {'accept'|'reject'} action
 */
function showFriendRequestActionResult(card, action) {
    const actionsWrap = card.querySelector('.notif-actions');
    if (!actionsWrap) return;

    const message = action === 'accept' ? 'تم قبول الطلب' : 'تم رفض الطلب';
    actionsWrap.innerHTML = `<span class="notif-action-result">${message}</span>`;
}

/**
 * إزالة كارت إشعار من الواجهة بانيميشن Collapse ناعم (كلاس is-removing
 * المعرّف في CSS)، وحذف صفه فعلياً من جدول notifications في Supabase
 * وكذلك من notificationsCache المحلية
 * @param {HTMLElement} card
 */
async function removeNotificationCard(card) {
    const notifId = card.dataset.notifId;

    card.classList.add('is-removing');
    setTimeout(() => card.remove(), 350);

    if (notifId) {
        recordDismissedNotificationIds(notifId);
    }

    notificationsCache = notificationsCache.filter((n) => String(n.id) !== String(notifId));
    updateUnreadBadges();

    if (!notifId || !currentUser) return;

    try {
        const { error } = await supabaseClient
            .from('notifications')
            .delete()
            .eq('user_id', currentUser.id)
            .eq('id', notifId);

        if (error) {
            console.error('خطأ في حذف الإشعار من السيرفر:', error.message);
        }
    } catch (err) {
        console.warn('استثناء أثناء حذف الإشعار:', err);
    }
}


/* ------------------------------------------------------------------
   9) تحديث حالة القراءة (فردي / الكل)
   ------------------------------------------------------------------ */

/**
 * تحديد إشعار واحد كمقروء - محلياً في الواجهة فوراً، وفي Supabase في
 * الخلفية. بيتجاهل الطلب تماماً لو الإشعار مقروء بالفعل عشان نوفر أي
 * كتابة (Write) مش لازمة على قاعدة البيانات
 * @param {string} notificationId
 */
async function markNotificationAsRead(notificationId) {
    const notification = notificationsCache.find((n) => String(n.id) === String(notificationId));
    if (!notification || notification.is_read) return;

    notification.is_read = true;
    updateUnreadBadges();

    const card = document.querySelector(`.notif-card[data-notif-id="${notificationId}"]`);
    if (card) card.classList.remove('is-unread');

    // لو التبويب النشط "غير المقروء"، الكارت لازم يختفي من القائمة
    // الظاهرة فوراً بعد ما بقى مقروء
    if (currentFilter === 'unread') {
        renderNotificationsList();
    }

    const { error } = await supabaseClient
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId);

    if (error) {
        console.error('خطأ في تحديث حالة القراءة:', error.message);
    }
}

/**
 * تحديد كل إشعارات المستخدم الحالي كمقروءة دفعة واحدة - بتتنادى تلقائياً
 * عند فتح المودال، وكمان يدوياً من زرار "تحديد الكل كمقروء". بتتجاهل
 * العملية بالكامل لو مفيش أي إشعار غير مقروء أصلاً (توفير كتابة زيادة)
 */
async function markAllNotificationsAsRead() {
    if (!currentUser) return;

    const hasUnread = notificationsCache.some((n) => !n.is_read);
    if (!hasUnread) return;

    notificationsCache.forEach((n) => { n.is_read = true; });
    updateUnreadBadges();
    document.querySelectorAll('#notificationsList .notif-card.is-unread')
        .forEach((card) => card.classList.remove('is-unread'));

    // لو المستخدم واقف على تبويب غير المقروء، نعيد رسم القائمة لتظهر حالة الفراغ فوراً
    if (currentFilter === 'unread') {
        renderNotificationsList();
    }

    const { error } = await supabaseClient
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', currentUser.id)
        .eq('is_read', false);

    if (error) {
        console.error('خطأ في تحديد كل الإشعارات كمقروءة:', error.message);
    }
}


/* ------------------------------------------------------------------
   10) Supabase Realtime - وصول إشعار جديد فوراً
   ------------------------------------------------------------------ */

/**
 * الاشتراك في تحديثات Realtime الحية على جدول notifications، مفلترة
 * على user_id بتاع المستخدم الحالي بس (عبر عبارة filter الجاهزة اللي
 * بيوفرها Supabase على مستوى القناة، مش هنعتمد على RLS هنا لأن قنوات
 * Realtime بتتطلب فلتر صريح زي ده عشان الأداء). بنلغي أي قناة قديمة
 * الأول (لو bindNotificationsRealtimeSubscription اتنادت أكتر من مرة)
 * عشان مانفضلش مشتركين مرتين في نفس التحديثات
 */
function bindNotificationsRealtimeSubscription() {
    if (!currentUser) return;

    if (realtimeChannel) {
        supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }

    realtimeChannel = supabaseClient
        .channel(`notifications-user-${currentUser.id}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${currentUser.id}`,
            },
            (payload) => {
                try {
                    handleIncomingNotification(payload.new);
                } catch (err) {
                    // بنحمي القناة نفسها من أي استثناء غير متوقع جوه معالجة صف
                    // واحد (مثلاً شكل بيانات غير متوقع) عشان الاشتراك يفضل
                    // شغال لباقي الإشعارات الجاية بدل ما يقف بصمت
                    console.error('خطأ أثناء معالجة إشعار وارد لحظياً:', err);
                }
            },
        )
        .on(
            // بنسمع كمان لحدث DELETE عشان لو المستخدم فاتح جرس الإشعارات
            // فعلياً في نفس اللحظة اللي حد فيها بيلغي طلب صداقة كان بعتهولوا
            // (شوف trigger بتاع cleanup_friend_request_notification_on_cancel
            // في القاعدة - هو اللي بيمسح صف الإشعار فعلياً)، الكارت يختفي
            // من عنده فوراً بدل ما يفضل ظاهر لحد ما يقفل ويفتح المودال تاني
            'postgres_changes',
            {
                event: 'DELETE',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${currentUser.id}`,
            },
            (payload) => {
                try {
                    handleRealtimeNotificationDeleted(payload.old);
                } catch (err) {
                    console.error('خطأ أثناء معالجة حذف إشعار لحظياً:', err);
                }
            },
        )
        .subscribe((status, err) => {
            // نفس فلسفة تسجيل حالة الاشتراك في posts.js (bindPostsRealtimeSubscription) -
            // شوف التعليق هناك لتفسير قيم status المختلفة وأسباب تعليقها
            console.log('[notifications.js] حالة اشتراك Realtime بتاع الإشعارات:', status);
            if (err) {
                console.error('خطأ في اشتراك Realtime بتاع الإشعارات:', err.message || err);
            }
        });
}

/**
 * تُستدعى فور وصول حدث حذف إشعار لحظياً من Realtime (مثلاً: طلب صداقة
 * اتلغى من صاحبه قبل ما يتقبل - شوف الـ trigger في القاعدة). بتشيل
 * الإشعار ده من notificationsCache والواجهة على طول لو لسه ظاهر، من
 * غير ما تبعت أي طلب حذف تاني لقاعدة البيانات (هو اتحذف فعلياً بالفعل،
 * ده مجرد تزامن للواجهة)
 * @param {object} deletedRow - الصف المحذوف (على الأقل عمود id متوفر فيه)
 */
function handleRealtimeNotificationDeleted(deletedRow) {
    if (!deletedRow || deletedRow.id === undefined) return;
    recordDismissedNotificationIds(deletedRow.id);
    dismissNotificationLocally({ notifId: deletedRow.id });
}

/**
 * تُستدعى فور وصول صف إشعار جديد لحظياً من Realtime - بتضيفه أعلى
 * notificationsCache وأعلى القائمة المعروضة (لو بتطابق الفلتر النشط)
 * من غير أي إعادة جلب كاملة، بتزوّد شارة الجرس، وتشغّل صوت خفيف +
 * انيميشن نبضة بسيطة على الجرس (عبر Tailwind utility class جاهزة،
 * animate-bounce، بدل ما نحتاج نضيف أي CSS مخصص جديد)
 * @param {object} newNotification - الصف الجديد كامل من جدول notifications
 */
function handleIncomingNotification(newNotification) {
    if (!newNotification) return;

    // احتياطي: لو نفس الإشعار وصل مرتين لأي سبب (إعادة اتصال بالقناة
    // مثلاً)، منضيفوش تاني
    const alreadyExists = notificationsCache.some((n) => String(n.id) === String(newNotification.id));
    if (alreadyExists) return;

    notificationsCache.unshift(newNotification);

    // نفس سياسة الحد الأقصى (NOTIFICATIONS_MAX_COUNT) المطبّقة فعلياً
    // وبشكل نهائي على قاعدة البيانات (trigger بيحذف الأقدم تلقائياً مع
    // كل INSERT جديد) - هنا بنعمل بس trim فوري على النسخة المحلية
    // والواجهة عشان تتزامن على طول من غير ما تستنى Fetch جديد
    let removedOldest = null;
    if (notificationsCache.length > NOTIFICATIONS_MAX_COUNT) {
        removedOldest = notificationsCache.pop();
    }

    updateUnreadBadges();

    const matchesCurrentFilter = currentFilter === 'all' || !newNotification.is_read;
    if (matchesCurrentFilter) {
        const listContainer = document.getElementById('notificationsList');
        const emptyState = document.getElementById('notificationsEmptyState');
        const card = buildNotificationCard(newNotification);

        if (listContainer && card) {
            listContainer.insertBefore(card, listContainer.firstChild);
        }
        if (emptyState) {
            emptyState.classList.add('hidden');
            emptyState.classList.remove('flex');
        }
    }

    // لو الإشعار الجديد داس على الحد الأقصى وشال أقدم واحد من الكاش،
    // بنشيل كارته من الواجهة كمان لو لسه ظاهر (مش محتاجين انيميشن
    // is-removing هنا لأنه مش فعل قصده المستخدم - بس تنظيف تلقائي هادئ)
    if (removedOldest) {
        const oldestCard = document.querySelector(`.notif-card[data-notif-id="${removedOldest.id}"]`);
        if (oldestCard) oldestCard.remove();
    }

    playNewNotificationFeedback();

    // عرض الإشعار العائم الزجاجي التفاعلي بالأعلى (In-App Toast Banner)
    showGlassyInAppNotification(newNotification);
}

/**
 * عرض إشعار عائم زجاجي فاخر أعلى الشاشة (In-App Glassy Banner)
 * يظهر لحظيًا فور وصول إشعار جديد أثناء استخدام التطبيق
 * يدعم التمرير لأعلى للإغلاق، الضغط للتنقل المباشر، وتلقائية الاختفاء بعد 5 ثوان
 * @param {object} notification
 */
export function showGlassyInAppNotification(notification) {
    if (!notification) return;

    const container = document.getElementById('toastContainer');
    if (!container) return;

    const banner = document.createElement('div');
    banner.className = 'glassy-notif-banner';
    banner.setAttribute('role', 'alert');

    const iconWrap = document.createElement('div');
    iconWrap.className = 'glassy-notif-icon-wrap';

    const AVATAR_TYPES = ['friend_request', 'friend_accept', 'leaderboard_pass', 'story_reaction', 'comment_reply', 'comment_like'];
    const BADGE_TYPES = ['achievement', 'achievement_unlocked'];

    if (AVATAR_TYPES.includes(notification.type) && notification.data && notification.data.sender_avatar_url) {
        const img = document.createElement('img');
        img.className = 'glassy-notif-avatar';
        img.src = notification.data.sender_avatar_url;
        img.alt = '';
        img.onerror = () => { img.src = FALLBACK_SENDER_AVATAR; };
        iconWrap.appendChild(img);
    } else if (AVATAR_TYPES.includes(notification.type)) {
        const img = document.createElement('img');
        img.className = 'glassy-notif-avatar';
        img.src = FALLBACK_SENDER_AVATAR;
        img.alt = '';
        iconWrap.appendChild(img);
    } else if (BADGE_TYPES.includes(notification.type)) {
        iconWrap.innerHTML = ACHIEVEMENT_BADGE_SVG;
    } else if (NOTIFICATION_ICONS[notification.type]) {
        iconWrap.innerHTML = NOTIFICATION_ICONS[notification.type];
    } else {
        iconWrap.innerHTML = `
            <svg viewBox="0 0 24 24" class="w-5 h-5 text-amber-400 stroke-current fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
        `;
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'glassy-notif-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'glassy-notif-title';
    titleEl.textContent = notification.title || 'إشعار جديد';

    const textEl = document.createElement('div');
    textEl.className = 'glassy-notif-text';
    textEl.textContent = notification.message || '';

    bodyEl.appendChild(titleEl);
    bodyEl.appendChild(textEl);

    const badgeEl = document.createElement('div');
    badgeEl.className = 'glassy-notif-badge';

    banner.appendChild(iconWrap);
    banner.appendChild(bodyEl);
    banner.appendChild(badgeEl);

    let isDismissed = false;
    const dismissBanner = () => {
        if (isDismissed) return;
        isDismissed = true;
        banner.classList.remove('is-visible');
        banner.classList.add('is-leaving');
        setTimeout(() => {
            banner.remove();
        }, 340);
    };

    const autoDismissTimeout = setTimeout(dismissBanner, 5000);

    // النقر على الإشعار العائم: الذهاب للوجهة وتعليمه كمقروء
    banner.addEventListener('click', () => {
        clearTimeout(autoDismissTimeout);
        dismissBanner();

        if (notification.id) {
            markNotificationAsRead(notification.id);
        }

        const nav = resolveNotificationNavigation(notification.type, notification.data);
        if (nav && nav.action) {
            nav.action();
        } else {
            openNotificationsModal();
        }
    });

    // سحب لأعلى للإغلاق (Swipe up to dismiss)
    let startY = 0;
    banner.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
    }, { passive: true });

    banner.addEventListener('touchmove', (e) => {
        const currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;
        if (deltaY < -15) {
            clearTimeout(autoDismissTimeout);
            dismissBanner();
        }
    }, { passive: true });

    container.appendChild(banner);

    // تشغيل أنيميشن النزول
    requestAnimationFrame(() => {
        banner.classList.add('is-visible');
    });
}

/** تنبيه خفيف (صوت + نبضة بصرية على الجرس) عند وصول إشعار جديد لحظياً */
function playNewNotificationFeedback() {
    // بنستخدم نفس جسر الصوت المشترك في app.js (playSound عبر حدث
    // 'app:sound') بدل ما نكرر كود Web Audio API من الصفر هنا. لو
    // app.js لسه مايدعمش نوع 'notify' وقت القراءة، هيتجاهله بأمان
    // (playSound الحالية بترجع من غير خطأ لو النوع مش معروف)
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { type: 'notify' } }));

    const bellBtn = document.getElementById('notificationBellBtn');
    if (!bellBtn) return;

    if (bellAnimationTimeoutId) {
        // إشعار تاني وصل قبل ما نبضة الجرس السابقة تخلص - بنلغي المؤقّت
        // القديم ونعمل reflow بسيط عشان الأنيميشن تبدأ من جديد بصرياً
        // (بدل ما يفضل نفس الـ bell-shake شغال من الأول من غير ريستارت)
        clearTimeout(bellAnimationTimeoutId);
        bellBtn.classList.remove('bell-shake');
        void bellBtn.offsetWidth;
    }

    // "bell-shake" (مُعرّفة في css/style.css): نبضة أفقية خفيفة (يمين/شمال)
    // بدل Tailwind الجاهزة "animate-bounce" اللي كانت بتعمل قفزة رأسية
    // (فوق/تحت) واضحة وملفتة أكتر من اللازم في الهيدر
    bellBtn.classList.add('bell-shake');
    bellAnimationTimeoutId = setTimeout(() => {
        bellBtn.classList.remove('bell-shake');
        bellAnimationTimeoutId = null;
    }, 700); // لازم يتطابق مع مدة أنيميشن bellShake (0.7s) في css/style.css
}


/* ------------------------------------------------------------------
   11) أدوات مساعدة (Helpers)
   ------------------------------------------------------------------ */

/**
 * تنسيق وقت نسبي بالعربي (زي "منذ 5 دقائق" أو "أمس")، بنفس فلسفة
 * formatRelativeTimeArabic الموجودة في stories.js، مكرّرة هنا محلياً
 * عشان نتجنب استيراد ملف stories.js كامل بس عشان دالة مساعدة واحدة
 * @param {string|null} isoDateString
 * @returns {string}
 */
function formatRelativeTimeArabic(isoDateString) {
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