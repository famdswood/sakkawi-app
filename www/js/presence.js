/* ==================================================================
   سِكّاوي | js/presence.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: النقطة الخضراء "أونلاين الآن" اللي
   بتتحط فوق صورة البروفايل في أي مكان في التطبيق (بروفايلي، بروفايل
   عام، لوحة الصدارة، شات الدعم، ...إلخ) - زي فيسبوك بالظبط.

   ================================================================
   ليه ملف منفصل ومش جوه profiles.js؟
   ================================================================
   عشان support-chat.js محتاج يستخدم نفس المنطق (نقطة الأونلاين فوق
   صورة الطرف التاني في الشات)، لكن support-chat.js ممنوع (بتصميم
   واضح - شوف التعليق في أول profiles.js) إنه يستورد من profiles.js
   عشان محدش يعمل Circular Import. فبدل ما نكرر نفس المنطق مرتين،
   عملناه هنا في ملف مستقل زي modal-history.js/auth.js بالظبط، يقدر
   أي ملف تاني (profiles.js، support-chat.js، admin.js لو احتاج)
   يستورد منه من غير أي مشكلة اتجاه استيراد.

   ================================================================
   القاعدة الأمنية (مهم جداً - الإخفاء هنا مش بس بصري)
   ================================================================
   حالة الأونلاين (is_online/last_seen_at) عمودين حساسين نسبياً -
   المفروض حسب الطلب إنهم يظهروا بس لـ:
     1) المستخدم نفسه (يشوف حالته هو)
     2) أصدقاءه المقبولين (accepted) بس
     3) الأدمن - يشوف أي حد حتى لو مش صديقه
   وأي حد تاني (زائر، مستخدم مش صديق) المفروض يستحيل يعرف حالة
   أونلاين حد تاني، حتى لو فتح Devtools وقرا الـ Network requests.
   عشان كده مبنعتمدش على public_profiles (الـ View المتاحة لأي حد -
   شوف تعليقات fetchLeaderboardTop في profiles.js) ولا حتى بنجيب
   العمودين دول من جدول profiles مباشرة من الكلاينت. بدل كده بنعدي
   عن طريق RPC واحدة (get_presence_for_users - شوف
   sql/phase-X-friend-presence.sql) بتتحقق هي نفسها على السيرفر من
   الشروط التلاتة فوق، وبترجع بس الصفوف المسموح بيها فعلاً. أي id
   مش مسموح بيه ببساطة مبيرجعش في النتيجة، فالنقطة بتفضل مخفية له
   (الحالة الافتراضية الآمنة في CSS - شوف .presence-dot في style.css).

   ================================================================
   طريقة الاستخدام في أي ملف تاني
   ================================================================
   1) وقت بناء الـ HTML بتاع أي كارت/صف فيه صورة بروفايل، لازم:
      - الصورة تكون جوه حاوية عندها position:relative (زي
        `<span class="relative inline-block">` أو أي div عنده
        Tailwind class زي `relative`)
      - تحط `presenceDotHtml(userId)` جوه نفس الحاوية دي، جنب الـ <img>
   2) بعد ما الـ HTML يتحط فعلياً في الصفحة (innerHTML = ...)، ننادي
      `loadAndApplyPresence([...IDs])` بكل الـ IDs اللي ظهرت في الرسمة
      دي - بتجيب حالتهم وتفعّل/تعطّل النقط تلقائياً.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';

/** أقصى مدة من غير heartbeat قبل ما نعتبر أي حد "أونلاين الآن" مش
 * دقيقة - نفس فلسفة ONLINE_FRESHNESS_THRESHOLD_MS الموجودة في admin.js
 * بالظبط (نفس القيمة كمان)، لازم تفضل القيمتين متطابقين عشان مايحصلش
 * تعارض بصري بين لوحة تحكم الأدمن ونقطة الأونلاين العادية لنفس المستخدم */
export const ONLINE_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 دقايق

/**
 * بترجع true لو صف الحضور ده (من get_presence_for_users) بيعتبر
 * "أونلاين الآن" فعلياً - نفس منطق isUserOnline في admin.js بالظبط
 * @param {{is_online?: boolean, last_seen_at?: string}|undefined} row
 * @returns {boolean}
 */
export function isPresenceOnline(row) {
    if (!row || !row.is_online || !row.last_seen_at) return false;
    const lastSeenTime = new Date(row.last_seen_at).getTime();
    if (isNaN(lastSeenTime)) return false;
    const elapsedMs = Date.now() - lastSeenTime;
    // التحقق من الحداثة وحماية تفاوت التوقيت (ساعة الجهاز متأخرة أو متقدمة)
    return elapsedMs > -2 * 60 * 60 * 1000 && elapsedMs < ONLINE_FRESHNESS_THRESHOLD_MS;
}

/**
 * بتبني الـ <span> الخاص بنقطة الأونلاين، جاهزة تتحط جوه أي حاوية
 * position:relative حوالين صورة بروفايل. مخفية افتراضيًا (شوف
 * .presence-dot في style.css) لحد ما loadAndApplyPresence تتأكد
 * فعليًا إن المستخدم الحالي مسموحله يشوف حالة صاحب الـ userId ده
 * @param {string} userId
 * @param {string} [sizeClass] - كلاس تعديل مقاس اختياري، زي 'presence-dot-lg' لصور البروفايل الكبيرة
 * @returns {string}
 */
export function presenceDotHtml(userId, sizeClass = '') {
    if (!userId) return '';
    const cleanSize = sizeClass ? ` ${sizeClass.trim()}` : '';
    return `<span class="presence-dot${cleanSize}" data-presence-avatar="${userId}" aria-hidden="true"></span>`;
}

/**
 * بتجيب حالة الأونلاين لمجموعة IDs عن طريق RPC واحدة (get_presence_for_users)
 * بترجع Map(userId -> {is_online, last_seen_at}) - أي id مش موجود في
 * النتيجة معناه إن السيرفر رفض يورينا حالته (مش نفسنا/صديق مقبول/أدمن)
 * @param {string[]} userIds
 * @returns {Promise<Map<string, object>>}
 */
export async function fetchPresenceMap(userIds) {
    const uniqueIds = [...new Set((userIds || []).filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const { data, error } = await supabaseClient.rpc('get_presence_for_users', {
        target_ids: uniqueIds,
    });

    if (error) {
        console.error('خطأ في جلب حالة الأونلاين:', error.message);
        return new Map();
    }

    return new Map((data || []).map((row) => [row.id, row]));
}

/**
 * بتلف بس على نقط الأونلاين اللي ID بتاعها موجود في scopeIds (المجموعة
 * اللي فعلاً اتطلبت في نفس نداء loadAndApplyPresence ده) وتفعّل/تعطّل
 * class is-online حسب الـ Map الجاية من fetchPresenceMap - أي id من
 * scopeIds مش راجع في الـ presenceMap بيتعطّل (يفضل مخفي).
 *
 * (إصلاح - باج حقيقي: Race Condition): قبل كده الدالة كانت بتلف على
 * *كل* عنصر `[data-presence-avatar]` في الصفحة كلها بغض النظر عن مين
 * طلب التحديث ده - فلو صفحة فيها أكتر من نداء loadAndApplyPresence شغال
 * في نفس الوقت (مثال حقيقي: renderLeaderboardPodium بتنادي بـ 3 IDs،
 * وjuxtaposed renderLeaderboardRemainingList بتنادي بـ ~47 ID تانيين)،
 * أي نداء يخلص (يرجعله رد من الـ RPC) *بعد* التاني كان بيدوس على نقط
 * التاني ويطفيها، لأن الـ IDs بتاعت التاني مش موجودة أصلاً في presenceMap
 * بتاعه هو (map مالوش غير الـ IDs اللي هو طلبها). ده كان بالظبط سبب
 * اختفاء نقطة البودیوم (Top 3) في الليدربورد - نداء باقي القائمة (أكتر
 * IDs، وقت رد أطول غالباً) كان بيوصل متأخر عن نداء البودیوم (3 IDs بس)
 * ويصفّر نقط البودیوم فور ما يوصل، حتى لو كانت اتظبطت صح قبل كده بلحظة.
 * الحل: كل نداء بيقتصر تأثيره بس على الـ IDs اللي هو طلبها (scopeIds)،
 * وبيسيب أي عنصر تاني (متطلوب من نداء موازي تاني) زي ما هو تماماً.
 * @param {Map<string, object>} presenceMap
 * @param {string[]} [scopeIds] - الـ IDs اللي المفروض النداء ده يحدّثها بس
 */
export function applyPresenceMapToDom(presenceMap, scopeIds) {
    const scopeSet = scopeIds ? new Set(scopeIds) : (presenceMap ? new Set(presenceMap.keys()) : new Set());
    document.querySelectorAll('[data-presence-avatar]').forEach((el) => {
        const userId = el.getAttribute('data-presence-avatar');
        if (!scopeSet.has(userId)) return; // مش من ضمن الـ IDs اللي النداء ده مسؤول عنها - سيبه زي ما هو
        el.classList.toggle('is-online', isPresenceOnline(presenceMap?.get(userId)));
    });
}

/**
 * الاختصار اللي المفروض ينادى عليه بعد أي render فيه صور بروفايل -
 * بيجمع fetchPresenceMap + applyPresenceMapToDom في نداء واحد.
 * "Fire and forget" بنفس فلسفة sendNotification/notifyLeaderboardPassIfNeeded
 * في profiles.js - فشلها مايكسرش الرسمة نفسها، النقط بتفضل مخفية بس
 * (نفس الحالة الافتراضية الآمنة في .presence-dot). بتبعت نفس userIds
 * كـ "نطاق" لـ applyPresenceMapToDom عشان تتجنب أي تعارض مع نداء تاني
 * شغال في نفس الوقت على IDs مختلفة (شوف الشرح فوق applyPresenceMapToDom)
 * @param {string[]} userIds
 */
export async function loadAndApplyPresence(userIds) {
    try {
        const presenceMap = await fetchPresenceMap(userIds);
        applyPresenceMapToDom(presenceMap, userIds);
    } catch (err) {
        console.error('خطأ غير متوقع في نظام نقطة الأونلاين:', err?.message || err);
    }
}

/**
 * تحديث فوري لكافة شارات الأونلاين المعروضة حالياً في الـ DOM.
 * مفيدة عند العودة للتطبيق من الخلفية أو استعادة الاتصال بالإنترنت.
 */
export async function refreshCurrentPresence() {
    try {
        const visibleDots = document.querySelectorAll('[data-presence-avatar]');
        const ids = [];
        visibleDots.forEach((el) => {
            const id = el.getAttribute('data-presence-avatar');
            if (id) ids.push(id);
        });
        if (ids.length > 0) {
            await loadAndApplyPresence(ids);
        }
    } catch (err) {
        console.error('خطأ في إنعاش شارات الأونلاين:', err?.message || err);
    }
}