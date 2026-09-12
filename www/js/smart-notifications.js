/* ==================================================================
   سِكّاوي | js/smart-notifications.js
   ------------------------------------------------------------------
   إدارة الإشعارات الذكية المحلية والمجدولة (Native Local Notifications)
   عبر @capacitor/local-notifications.

   الميزات والمواعيد:
     1) تذكير الهدف اليومي (Daily Target):
        - الموعد: 7:45 مساءً (19:45).
        - المعرّف: 1001.
        - الشرط: يُجدول فقط إذا كانت الخطوات الحالية أقل من هدف اليوم.
        - الإلغاء الفوري: بمجرد تحقيق الهدف (خطوات >= 10,000) يُلغى فوراً.
     2) تذكير السؤال اليومي (Daily Question):
        - الموعد: 8:30 مساءً (20:30).
        - المعرّف: 1002.
        - الشرط: يُجدول فقط إذا كان هناك سؤال غير مجاب عنه لليوم.
        - الإلغاء الفوري: بمجرد الإجابة على السؤالين يُلغى فوراً.
     3) إنقاذ الستريك (Streak Saver Danger Alert):
        - الموعد: 9:30 مساءً (21:30).
        - المعرّف: 1003.
        - الشرط: يُجدول فقط لمستخدم لديه ستريك نشط (>= 1) ولم يسجل نشاطاً لليوم.
        - الإلغاء الفوري: بمجرد تسجيل أي نشاط لليوم (تأمين الستريك) يُلغى فوراً.

   التزام صارم:
     - بدون أي إيموجي (Zero Emojis) في النصوص أو العناوين.
     - العمل دون اتصال (Offline-first) وبدون استهلاك للبطارية.
     - مراعاة العمل داخل المتصفح أو بيئة التطوير دون أخطاء.
   ================================================================== */

export const NOTIF_ID_DAILY_TARGET = 1001;
export const NOTIF_ID_DAILY_QUESTION = 1002;
export const NOTIF_ID_STREAK_SAVER = 1003;

export const SMART_ALERTS_CHANNEL_ID = 'sakkawi_smart_alerts';

/** مرجع موحد للوصول لـ LocalNotifications Plugin بأمان */
function getLocalNotificationsPlugin() {
    return window.Capacitor?.Plugins?.LocalNotifications || null;
}

/**
 * حساب كائن Date لموعد اليوم بالساعة والدقيقة
 * @param {number} hour
 * @param {number} minute
 * @returns {Date}
 */
function getTodayDateAt(hour, minute) {
    const target = new Date();
    target.setHours(hour, minute, 0, 0);
    return target;
}

/**
 * التحقق مما إذا كان موعد معين اليوم قد مضى بالفعل
 * @param {Date} date
 * @returns {boolean}
 */
function isTimeInPast(date) {
    return date.getTime() <= Date.now();
}

/**
 * إلغاء إشعار محلي بمعرّفه بأمان
 * @param {number} id
 */
export async function cancelSmartNotification(id) {
    const plugin = getLocalNotificationsPlugin();
    if (!plugin?.cancel) return;

    try {
        await plugin.cancel({
            notifications: [{ id }],
        });
    } catch (err) {
        console.warn(`[smart-notifications.js] تعذر إلغاء الإشعار ${id}:`, err?.message || err);
    }
}

/**
 * جدولة إشعار محلي بأمان
 * @param {{ id: number, title: string, body: string, at: Date, extra?: object }} options
 */
export async function scheduleSmartNotification({ id, title, body, at, extra = {} }) {
    const plugin = getLocalNotificationsPlugin();
    if (!plugin?.schedule) return;

    // إذا كان التطبيق في وضع الصيانة، لا نجدول أي إشعار ذكي
    if (window.__app_maintenance_mode) {
        return;
    }

    // إذا كان الموعد قد مضى بالفعل لليوم، لا نقوم بجدولته
    if (isTimeInPast(at)) {
        return;
    }

    try {
        // نلغي أي نسخة قديمة بنفس المعرّف أولاً لمنع التكرار
        await cancelSmartNotification(id);

        await plugin.schedule({
            notifications: [
                {
                    id,
                    title,
                    body,
                    schedule: {
                        at,
                        allowWhileIdle: true,
                    },
                    channelId: SMART_ALERTS_CHANNEL_ID,
                    smallIcon: 'ic_stat_notify',
                    iconColor: '#D4AF37',
                    extra,
                },
            ],
        });
    } catch (err) {
        console.warn(`[smart-notifications.js] تعذر جدولة الإشعار ${id}:`, err?.message || err);
    }
}

/**
 * تقييم وجدولة أو إلغاء تذكير الهدف اليومي
 * @param {{ currentSteps: number, targetSteps?: number }} params
 */
export async function evaluateAndScheduleDailyTargetReminder({ currentSteps = 0, targetSteps = 10000 }) {
    // إذا كان التطبيق في وضع الصيانة، أو حقق المستخدم هدفه، يُلغى التذكير فوراً
    if (window.__app_maintenance_mode || currentSteps >= targetSteps) {
        await cancelSmartNotification(NOTIF_ID_DAILY_TARGET);
        return;
    }

    const reminderTime = getTodayDateAt(19, 45); // 7:45 مساءً
    if (isTimeInPast(reminderTime)) {
        return;
    }

    const remainingSteps = Math.max(0, targetSteps - currentSteps);

    await scheduleSmartNotification({
        id: NOTIF_ID_DAILY_TARGET,
        title: 'تذكير الهدف اليومي',
        body: `متبقي لك ${remainingSteps.toLocaleString('ar-EG')} خطوة للوصول إلى هدف اليوم (${targetSteps.toLocaleString('ar-EG')} خطوة). استمر في المشي قبل نهاية اليوم!`,
        at: reminderTime,
        extra: { type: 'daily_target' },
    });
}

/**
 * إلغاء تذكير الهدف اليومي فوراً
 */
export async function cancelDailyTargetReminder() {
    await cancelSmartNotification(NOTIF_ID_DAILY_TARGET);
}

/**
 * تقييم وجدولة أو إلغاء تذكير السؤال اليومي
 * @param {{ areAllQuestionsDone: boolean }} params
 */
export async function evaluateAndScheduleDailyQuestionReminder({ areAllQuestionsDone = false }) {
    // الشرط المنطقي الصارم: إذا تمت الإجابة، أو كانت الميزة معطلة إدارياً، أو التطبيق في وضع الصيانة، أو المستخدم زائر بدون حساب
    if (
        areAllQuestionsDone ||
        window.__feature_daily_question_enabled === false ||
        window.__app_maintenance_mode ||
        window.isGuestMode
    ) {
        await cancelSmartNotification(NOTIF_ID_DAILY_QUESTION);
        return;
    }

    const reminderTime = getTodayDateAt(20, 30); // 8:30 مساءً
    if (isTimeInPast(reminderTime)) {
        return;
    }

    await scheduleSmartNotification({
        id: NOTIF_ID_DAILY_QUESTION,
        title: 'تذكير السؤال اليومي',
        body: 'سؤال اليوم بانتظارك! أجب على السؤال اليومي الآن للحصول على النقاط قبل حلول منتصف الليل.',
        at: reminderTime,
        extra: { type: 'daily_question' },
    });
}

/**
 * إلغاء تذكير السؤال اليومي فوراً
 */
export async function cancelDailyQuestionReminder() {
    await cancelSmartNotification(NOTIF_ID_DAILY_QUESTION);
}

/**
 * تقييم وجدولة أو إلغاء تنبيه إنقاذ الستريك
 * @param {{ streakCount: number, isSecuredToday: boolean }} params
 */
export async function evaluateAndScheduleStreakSaver({ streakCount = 0, isSecuredToday = false }) {
    // لا نجدول تنبيه إنقاذ الستريك إذا كان التطبيق في وضع الصيانة أو المستخدم زائر أو الستريك مؤمن أو الستريك صفر
    if (
        window.__app_maintenance_mode ||
        window.isGuestMode ||
        isSecuredToday ||
        streakCount <= 0
    ) {
        await cancelSmartNotification(NOTIF_ID_STREAK_SAVER);
        return;
    }

    const reminderTime = getTodayDateAt(21, 30); // 9:30 مساءً
    if (isTimeInPast(reminderTime)) {
        return;
    }

    await scheduleSmartNotification({
        id: NOTIF_ID_STREAK_SAVER,
        title: 'تنبيه الحفاظ على السلسلة',
        body: `سلسلتك الحالية (${streakCount.toLocaleString('ar-EG')} يوم) مهددة بالانقطاع! سجل نشاطك الآن قبل منتصف الليل للحفاظ على تقدمك.`,
        at: reminderTime,
        extra: { type: 'streak_saver' },
    });
}

/**
 * إلغاء تنبيه إنقاذ الستريك فوراً
 */
export async function cancelStreakSaverReminder() {
    await cancelSmartNotification(NOTIF_ID_STREAK_SAVER);
}

/**
 * إلغاء كل التنبيهات المجدولة (مثل عند تسجيل الخروج)
 */
export async function cancelAllSmartReminders() {
    await Promise.all([
        cancelDailyTargetReminder(),
        cancelDailyQuestionReminder(),
        cancelStreakSaverReminder(),
    ]);
}

/**
 * تهيئة قناة الإشعارات لنظام أندرويد 8.0+
 */
async function ensureNotificationChannelCreated() {
    const plugin = getLocalNotificationsPlugin();
    if (!plugin?.createChannel) return;

    try {
        await plugin.createChannel({
            id: SMART_ALERTS_CHANNEL_ID,
            name: 'تنبيهات سِكّاوي الذكية',
            description: 'تذكيرات الهدف اليومي والسؤال اليومي والحفاظ على السلسلة',
            importance: 4, // IMPORTANCE_HIGH (إشعار بارز مع صوت)
            visibility: 1, // VISIBILITY_PUBLIC (يظهر على شاشة القفل)
            vibration: true,
        });
    } catch (err) {
        console.warn('[smart-notifications.js] تعذر إنشاء قناة الإشعارات:', err?.message || err);
    }
}

/**
 * طلب الإذن بالإشعارات المحلية إذا لزم الأمر
 */
async function ensureNotificationPermissions() {
    const plugin = getLocalNotificationsPlugin();
    if (!plugin?.checkPermissions || !plugin?.requestPermissions) return;

    try {
        const current = await plugin.checkPermissions();
        if (current.display !== 'granted') {
            await plugin.requestPermissions();
        }
    } catch (err) {
        console.warn('[smart-notifications.js] تعذر التحقق من أذونات الإشعارات:', err?.message || err);
    }
}

/**
 * التعامل مع ضغط المستخدم على إشعار محلي للانتقال للشاشة المناسبة
 * @param {object} action
 */
function handleLocalNotificationAction(action) {
    const type = action?.notification?.extra?.type;
    if (!type) return;

    switch (type) {
        case 'daily_question': {
            // الانتقال للشاشة الرئيسية والتمرير لكارت السؤال
            const homeBtn = document.getElementById('nav-home');
            if (homeBtn) homeBtn.click();
            setTimeout(() => {
                const card = document.getElementById('dailyQuestionCard1') || document.getElementById('dailyQuestionCard2');
                if (card) {
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 300);
            break;
        }
        case 'daily_target': {
            // الانتقال للشاشة الرئيسية حيث عداد الخطوات
            const homeBtn = document.getElementById('nav-home');
            if (homeBtn) homeBtn.click();
            break;
        }
        case 'streak_saver': {
            // الانتقال للشاشة الرئيسية أو الترتيب
            const homeBtn = document.getElementById('nav-home');
            if (homeBtn) homeBtn.click();
            break;
        }
    }
}

let isInitialized = false;

/**
 * نقطة التهيئة الرئيسية للإشعارات الذكية
 */
export async function initSmartNotifications() {
    if (isInitialized) return;
    isInitialized = true;

    if (window.Capacitor?.isNativePlatform?.()) {
        await ensureNotificationChannelCreated();
        await ensureNotificationPermissions();

        const plugin = getLocalNotificationsPlugin();
        if (plugin?.addListener) {
            plugin.addListener('localNotificationActionPerformed', (action) => {
                handleLocalNotificationAction(action);
            });
        }
    }

    // الاستماع لحدث الإجابة على السؤال اليومي لإلغاء التذكير فوراً
    document.addEventListener('dailyQuestion:answered', () => {
        cancelDailyQuestionReminder();
    });

    // الاستماع لإعادة التعيين اليومية
    document.addEventListener('sensors:day-reset', () => {
        // عند بداية يوم جديد، يتم تنظيف الجداول القديمة
        cancelAllSmartReminders();
    });

    // عند تسجيل الخروج، إلغاء كافة التنبيهات الشخصية المجدولة
    document.addEventListener('auth:signed-out', () => {
        cancelAllSmartReminders();
    });
}
