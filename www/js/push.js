/* ==================================================================
   سِكّاوي | js/push.js
   ------------------------------------------------------------------
   المرحلة 5 من خطة الإشعارات الخارجية (push-notifications-plan.md):
   تسجيل جهاز المستخدم لاستقبال Push Notifications حقيقية عبر Firebase
   Cloud Messaging (FCM)، حتى لو التطبيق مقفول تمامًا، ومعالجة الضغط
   على الإشعار لما يوصل والتطبيق في الخلفية/مقفول.

   بيتبع بالظبط نفس فلسفة باقي الموديولز في المشروع (sensors.js,
   notifications.js):
     - مفيش أي استيراد مباشر لـ getCurrentUser - معرفة هوية المستخدم
       الحالي بتتم عبر حدثي 'auth:login' و'auth:signed-out' اللي
       بيتطلقوا من auth.js، عشان الترتيب يفضل صحيح مهما كان توقيت
       تحميل الموديولز.
     - الوصول لأي Capacitor Plugin (بما فيهم @capacitor/push-notifications
       نفسه) بيتم عن طريق window.Capacitor.Plugins.XXX مباشرة، مش عن
       طريق `import ... from '@capacitor/push-notifications'` -
       المشروع ده مفيهوش أي bundler (كل الملفات بتتحمّل كـ
       <script type="module"> خام في المتصفح زي ما هو واضح في
       index.html)، فـ import مباشر لباكيدج npm كده هيفشل فعليًا وقت
       التشغيل. نفس بالظبط الأسلوب المستخدم في sensors.js مع
       StepCounter (Capacitor.Plugins.StepCounter).
     - initPushNotifications() هي نقطة التهيئة الوحيدة، بتتنادى مرة
       واحدة من app.js (initApp) زي باقي دوال initXxxUI.

   ⚠️ ملحوظة (Phase 6 لسه ماتعملتش): دالة handleNotificationTapData()
   تحت دلوقتي بتعمل log بس بدل ما تنقّل المستخدم فعليًا لمكان الإشعار.
   لما resolveNotificationNavigation(type, data) تتضاف لـ notifications.js
   (Phase 6 في الخطة)، المفروض نستوردها هنا ونستبدل جسم الدالة دي
   بنداء ليها، بنفس فلسفة handleNotificationsListClick هناك بالظبط.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { resolveNotificationNavigation } from './notifications.js';

/* ------------------------------------------------------------------
   حالة الموديول (Module State)
   ------------------------------------------------------------------ */

/** المستخدم الحالي (نفس شكل user بتاع Supabase Auth) - null لو مفيش تسجيل دخول */
let currentUser = null;

/** آخر توكن جهاز اتسجل فعليًا في push_tokens للمستخدم الحالي - محتاجينه عشان نمسحه بالظبط عند تسجيل الخروج */
let currentDeviceToken = null;

/**
 * لو حدث 'pushNotificationActionPerformed' اتطلق قبل ما 'auth:login'
 * يوصل ويحدد currentUser (حالة الإقلاع البارد - Cold Start: المستخدم
 * دوس على الإشعار والتطبيق كان مقفول تمامًا)، بنخزّن بيانات الإشعار
 * هنا مؤقتًا، ونتعامل معاها فور ما auth:login يحصل بعد كده
 * (شوف handleUserSignedIn تحت)
 */
let pendingNotificationTap = null;

/** true بمجرد ما نربط مستمعات الـ Plugin (registration/...) مرة واحدة بس، حتى لو المستخدم سجّل دخول/خروج أكتر من مرة في نفس الجلسة */
let hasBoundPluginListeners = false;

/* ------------------------------------------------------------------
   نقطة الدخول العامة - initPushNotifications()
   ------------------------------------------------------------------ */

/**
 * نقطة التهيئة الوحيدة للملف ده - تُستدعى مرة واحدة من app.js (initApp)
 * زي باقي دوال initXxxUI. بتسجّل مستمعين لحالة تسجيل الدخول/الخروج
 * عشان تسجّل/تمسح توكن الجهاز تلقائيًا مع كل تغيير في هوية المستخدم.
 */
export function initPushNotifications() {
    console.log('[push.js] initPushNotifications() اتنادت.');

    // 'auth:login' بتتطلق من auth.js في حالتين: أول تشغيل للتطبيق لو
    // فيه جلسة محفوظة صحيحة، أو فور نجاح تسجيل دخول/تسجيل حساب جديد
    document.addEventListener('auth:login', (event) => {
        handleUserSignedIn(event.detail.user);
    });

    document.addEventListener('auth:signed-out', () => {
        handleUserSignedOut();
    });
}

/* ------------------------------------------------------------------
   دخول/خروج المستخدم
   ------------------------------------------------------------------ */

/**
 * تُستدعى مع كل حدث 'auth:login' - بتتأكد إننا على منصة native فعلاً،
 * بتطلب صلاحية الإشعارات، وتسجّل الجهاز لو اتوافق. الويب/المتصفح
 * (وقت التطوير مثلاً) متسيبهوش يحاول يسجل خالص.
 * @param {import('@supabase/supabase-js').User} user
 */
async function handleUserSignedIn(user) {
    if (!user) return;

    currentUser = user;

    if (!window.Capacitor?.isNativePlatform?.()) {
        // مفيش Push على الويب/PWA العادي - مفيش أي حاجة تانية نعملها هنا
        return;
    }

    bindPluginListenersOnce();

    try {
        const { PushNotifications } = Capacitor.Plugins;
        const permStatus = await PushNotifications.requestPermissions();

        if (permStatus.receive !== 'granted') {
            console.warn('[push.js] المستخدم رفض إذن الإشعارات - مش هيقدر يستقبل Push على الجهاز ده.');
            return;
        }

        // التسجيل نفسه (الحصول على FCM token) بيحصل بشكل غير متزامن -
        // النتيجة بتوصل عبر حدث 'registration' (bindPluginListenersOnce فوق)
        await PushNotifications.register();
    } catch (err) {
        // "Fire and forget" - نفس فلسفة sendNotification بالظبط: بنسجّل
        // الخطأ بس متكسرش أي حاجة تانية في تسجيل الدخول لو فشل ده
        console.error('[push.js] خطأ أثناء طلب إذن/تسجيل الإشعارات:', err);
        return;
    }

    // حالة الإقلاع البارد: لو المستخدم كان دوس على إشعار قبل ما
    // currentUser يبقى جاهز، نتعامل مع النقرة دلوقتي بعد ما هويته
    // بقت معروفة
    if (pendingNotificationTap) {
        const data = pendingNotificationTap;
        pendingNotificationTap = null;
        handleNotificationTapData(data);
    }
}

/**
 * تُستدعى مع 'auth:signed-out' - بتمسح صف توكن الجهاز الحالي من
 * push_tokens عشان لو حد تاني سجّل دخول على نفس الجهاز بعد كده
 * متوصلوش إشعارات المستخدم القديم
 */
function handleUserSignedOut() {
    currentUser = null;

    if (window.Capacitor?.isNativePlatform?.() && currentDeviceToken) {
        const tokenToRemove = currentDeviceToken;

        supabaseClient
            .from('push_tokens')
            .delete()
            .eq('token', tokenToRemove)
            .then(({ error }) => {
                if (error) {
                    console.error('[push.js] خطأ أثناء حذف توكن الجهاز عند تسجيل الخروج:', error.message);
                }
            });
    }

    currentDeviceToken = null;
}

/* ------------------------------------------------------------------
   مستمعات الـ Plugin (@capacitor/push-notifications)
   ------------------------------------------------------------------ */

/**
 * ربط كل مستمعات PushNotifications Plugin مرة واحدة بس طول عمر
 * الصفحة (محمية بعلم hasBoundPluginListeners) - مفيش داعي نربطهم من
 * جديد مع كل auth:login (لو المستخدم سجّل خروج ودخول تاني في نفس
 * الجلسة مثلاً)
 */
function bindPluginListenersOnce() {
    if (hasBoundPluginListeners) return;
    hasBoundPluginListeners = true;

    const { PushNotifications } = Capacitor.Plugins;

    // التسجيل نجح - وصلنا FCM token بتاع الجهاز ده
    PushNotifications.addListener('registration', (token) => {
        handleTokenRegistration(token?.value);
    });

    // فشل التسجيل (مشكلة شبكة، Google Play Services مش موجودة على
    // الجهاز...إلخ) - "Fire and forget" زي أي خطأ تاني هنا، مجرد log
    PushNotifications.addListener('registrationError', (err) => {
        console.error('[push.js] registrationError أثناء تسجيل الجهاز:', err);
    });

    // إشعار وصل والتطبيق فاتح فعليًا (foreground) - متعملش حاجة إضافية
    // هنا عمدًا: Supabase Realtime في notifications.js أصلاً بيحدّث
    // الجرس/القائمة لحظيًا بمجرد ما صف INSERT يوصل لقاعدة البيانات،
    // فتكرار المعالجة هنا هيبقى ازدواجية بلا داعي
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[push.js] إشعار Push وصل والتطبيق فاتح (foreground):', notification);
    });

    // المستخدم دوس فعليًا على الإشعار من شريط إشعارات الموبايل
    // (التطبيق كان في الخلفية أو مقفول تمامًا وقتها)
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = action?.notification?.data || {};

        if (!currentUser) {
            // Cold Start: currentUser لسه مش جاهز - نأجّل المعالجة لحد
            // ما handleUserSignedIn تشتغل (شوف فوق)
            pendingNotificationTap = data;
            return;
        }

        handleNotificationTapData(data);
    });
}

/**
 * تُستدعى فور وصول FCM token جديد من الـ Plugin - بتعمل upsert له في
 * push_tokens مربوط بـ user_id المستخدم الحالي. onConflict: 'token'
 * (مش user_id) عشان لو نفس المستخدم مسجّل دخول على أكتر من جهاز،
 * الكل يفضل يوصله الإشعار (شوف تعليق الجدول في push-notifications-plan.md)
 * @param {string|undefined} token
 */
async function handleTokenRegistration(token) {
    if (!token || !currentUser) return;

    currentDeviceToken = token;

    try {
        const { error } = await supabaseClient
            .from('push_tokens')
            .upsert(
                {
                    user_id: currentUser.id,
                    token,
                    platform: 'android',
                },
                { onConflict: 'token' },
            );

        if (error) {
            console.error('[push.js] خطأ أثناء حفظ توكن الجهاز في push_tokens:', error.message);
        }
    } catch (err) {
        console.error('[push.js] استثناء غير متوقع أثناء حفظ توكن الجهاز:', err);
    }
}

/**
 * منطق "فين نروح" لما المستخدم يدوس على إشعار Push فعليًا (التطبيق
 * كان في الخلفية أو مقفول تمامًا وقتها). بيستخدم نفس دالة
 * resolveNotificationNavigation الموحّدة المستخدمة في notifications.js
 * (Phase 6 في الخطة) عشان منكررش منطق "فين نروح" مرتين - أي نوع إشعار
 * جديد يتضاف مستقبلًا، التعديل بيحصل مكان واحد بس (جوه notifications.js).
 *
 * @param {object} data - نفس بيانات عمود `data` (jsonb) بتاعة صف
 *   الإشعار، زي ما اتحددت في FCM payload (Phase 2.3 في الخطة):
 *   { type, notification_id, sender_id, request_id, post_id, comment_id, story_id }
 */
function handleNotificationTapData(data) {
    const result = resolveNotificationNavigation(data?.type, data);

    if (result?.action) {
        result.action();
    } else {
        // نوع مش معروف أو بيانات ناقصة - نكتفي بـ log، زي أي حالة
        // تانية معندناش فيها تنقّل واضح نروح له
        console.log('[push.js] مفيش تنقّل واضح لهذا الإشعار (نوع/بيانات غير كافية):', data);
    }
}