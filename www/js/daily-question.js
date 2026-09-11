/* ==================================================================
   سِكّاوي | js/daily-question.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: التحكم في كارتي "السؤال اليومي" في
   الصفحة الرئيسية (تبويب #tab-home، فوق كارت "تحدي الذكاء اليومي"
   مباشرة). كل يوم فيه سؤالين، وكل سؤال بقى في كارت منفصل وقائم بذاته
   تماماً (#dailyQuestionCard1 و #dailyQuestionCard2 في index.html) -
   الكارتين ظاهرين مع بعض تحت بعض من أول ما اليوم يبدأ، وكل واحد فيهم
   مستقل بالكامل عن التاني:
     - تقدر تجاوب على أي واحد فيهم الأول من غير ما تستنى التاني.
     - كل كارت له حالة "مغلق/نشط" ومؤقّت خاص بيه.
     - نتيجة كارت متأثرش على شكل الكارت التاني خالص.

     - إظهار مودال تحذيري (#dqWarningModal، مشترك بين الكارتين) قبل
       بدء أي سؤال فعلياً.
     - التنقل بين حالة "مغلق" و"نشط" بعد تأكيد المودال، لكارت الـ Slot
       اللي اتضغط بدأه فعلاً بس (مش الاتنين).
     - تشغيل عدّاد 25 ثانية بصرياً (شريط + رقم) وتغيير لونه ديناميكياً
       لكل كارت لوحده.
     - التقاط اختيار المستخدم لأحد الاختيارات الأربعة، ومقارنته
       بالإجابة الصحيحة (correctOptionId) وإظهار نتيجة الاختيار بصرياً
       (أخضر = صح / أحمر = غلط + إبراز الاختيار الصحيح).
     - حماية ضد الخروج من التطبيق أثناء أي جولة نشطة (Page Visibility
       API): بيتراقب مع document.hidden لكل Slot عنده جولة شغالة لسه
       ملهاش نتيجة - لو المستخدم خرج/غيّر تاب/جاله إشعار قبل ما يجاوب:
       التايمر بتاع الكارت ده يوقف فوراً، السؤال يتسجّل "ملغي بسبب
       الخروج"، والكارت ده بس ينتقل (الكارت التاني، لو كان شغال في
       نفس اللحظة، يفضل زي ما هو).

   الملف بيطلق الأحداث المخصّصة (Custom Events) دي عشان أي مرحلة تانية
   تقدر تسمعهم وتكمل عليهم من غير ما تعدّل في الملف ده:
     - "dailyQuestion:answered"    → { slot, optionId, isCorrect, pointsAwarded,
       alreadyRecorded } - (إصلاح أمني) بتتطلق دلوقتي من finalizeSlot بس
       *بعد* رد دالة RPC السيرفرية record_daily_question_result، وقيمة
       isCorrect هنا مؤكدة من السيرفر (مش من المتصفح) - شوف
       daily-question-security.sql
     - "dailyQuestion:timeout"     → { slot }
     - "dailyQuestion:exited"      → { slot, remainingSeconds }
     - "dailyQuestion:dayCompleted"→ { slot1, slot2 } (لما آخر Slot من
       الاتنين يخلص فعلياً - ملخص الحالتين، مفيدة لأي إحصائيات لاحقاً)
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { sendNotification } from './notifications.js';
import { fetchWithCache } from './offline-cache.js';
import { evaluateAndScheduleDailyQuestionReminder, cancelDailyQuestionReminder } from './smart-notifications.js';
import { pushModalState, closeModal, hasOpenModal } from './modal-history.js';

/** مدة السؤال بالثواني (شرط الميزة: 25 ثانية) - نفس القيمة لكل سؤال
 *  من السؤالين */
const QUESTION_DURATION_SECONDS = 25;

/** الحدود اللي بيتغيّر عندها لون العدّاد */
const TIMER_WARN_THRESHOLD_SECONDS = 10; // من هنا يبقى ذهبي (تنبيه)
const TIMER_DANGER_THRESHOLD_SECONDS = 5; // من هنا يبقى ياقوتي (حرج)

/** المدة اللي بنسيب فيها ألوان صح/غلط بارزة قبل ما ننتقل تلقائياً
 *  لحالة "مغلق" النهائية بتاعة نفس الكارت - عشان المستخدم يقدر يشوف
 *  نتيجته فعلياً قبل ما الشاشة تتغيّر من تحته */
const FEEDBACK_DISPLAY_MS = 1400;

/** عدد أسئلة اليوم الثابت */
const TOTAL_DAILY_SLOTS = 2;

/** ------------------------------------------------------------------
 *  (مرحلة 6) بنك الأسئلة الحقيقي بقى في جدول public.daily_questions،
 *  وسؤالي اليوم بيتحددوا تلقائياً كل يوم عن طريق pg_cron (دالة
 *  pick_daily_questions - شوف sql/phase-6-daily-questions.sql).
 *  بنجيبهم مرة واحدة عند تحميل الصفحة (loadTodaysQuestionsFromServer
 *  تحت) ونخزّنهم في dynamicQuestionBank بنفس الشكل بالظبط.
 *
 *  DAILY_QUESTION_BANK القديم تحت ده فضل موجود بس كـ "شبكة أمان"
 *  (Fallback) لحالتين بس: (أ) فشل جلب الأسئلة من السيرفر لأي سبب
 *  (مشكلة شبكة مثلاً)، أو (ب) لسه الصفحة بتحمّل ولسه الطلب ما رجعش،
 *  والمستخدم ضغط "ابدأ" بسرعة قبل ما يوصل الرد - عشان الكارت ميفضلش
 *  عالق من غير أي سؤال أبداً. في الاستخدام العادي، الأسئلة الحقيقية
 *  من الجدول هي اللي هتظهر دايمًا.
 *  ------------------------------------------------------------------ */
const DAILY_QUESTION_BANK = {
    1: {
        id: 'geo-nile-length',
        text: 'نهر النيل بيعدّي على كام دولة أفريقية قبل ما يوصل مصر؟',
        options: [
            { id: '1', text: '5 دول' },
            { id: '2', text: '11 دولة' },
            { id: '3', text: '7 دول' },
            { id: '4', text: '3 دول بس' },
        ],
        correctOptionId: '2',
    },
    2: {
        id: 'space-moon-landing-year',
        text: 'في أنهي سنة حطّت أول مركبة مأهولة على سطح القمر؟',
        options: [
            { id: '1', text: '1965' },
            { id: '2', text: '1972' },
            { id: '3', text: '1969' },
            { id: '4', text: '1958' },
        ],
        correctOptionId: '3',
    },
};

/** مفتاح التخزين المحلي لنتيجة سؤالي النهاردة - شكل القيمة المخزّنة:
 *  JSON.stringify({
 *    date: 'YYYY-MM-DD',
 *    slots: {
 *      1: { status: 'answered'|'timeout'|'forfeited', isCorrect: true|false|null },
 *      2: { status: 'answered'|'timeout'|'forfeited', isCorrect: true|false|null },
 *    }
 *  })
 *  ده كاش فوري بس (Optimistic) عشان كل كارت يتقفل فوراً من غير ما
 *  يستنى رد الشبكة - جدول Supabase (public.daily_question_status) هو
 *  مصدر الحقيقة الحقيقي لو المستخدم مسجّل دخول (شوف reconcileTodayStatusFromSupabase) */
const DQ_STATUS_STORAGE_KEY_PREFIX = 'skawy_dq_today_status';

/** (إصلاح) مفتاح الكاش لازم يبقى خاص بكل حساب لوحده، مش نفس المفتاح
 *  لكل الأجهزة/الحسابات - وإلا لو حساب اتسجّل خروج وحساب تاني دخل على
 *  نفس الجهاز، هيلاقي حالة الحساب الأول (مقفول/نتيجة) لسه معروضة له.
 *  currentUserId فاضي (null) = وضع ضيف، وكاش الضيف منفصل برضه */
function getDailyStatusStorageKeyForCurrentUser() {
    return `${DQ_STATUS_STORAGE_KEY_PREFIX}:${currentUserId || 'guest'}`;
}

/** نوع الإشعار المُرسل عبر sendNotification لحالة الخروج بدري - لازم
 *  يتطابق مع القيمة المضافة في notifications_type_check (شوف ملف الـ
 *  SQL المرفق) */
const DQ_FORFEIT_NOTIFICATION_TYPE = 'daily_question_forfeited';

/** النصوص الافتراضية لحالة "مغلق" قبل ما كل سؤال يتفتح النهاردة - نفس
 *  النصوص الموجودة Static جوه index.html لكل كارت، محتفظين بيهم هنا
 *  عشان نقدر نرجّعهم بعد ما اليوم يتغيّر (نص جديد يبقى محتاج Refresh
 *  للصفحة أصلاً، فمش هيتفعل عملياً غير بعد منتصف الليل + إعادة تحميل) */
const DEFAULT_LOCKED_DESCRIPTIONS = {
    1: 'سؤال سريع كل يوم يكشفلك حاجة جديدة عن نفسك، وعندك ٢٥ ثانية بس تجاوب فيها.',
    2: 'سؤال سريع تاني كل يوم يكشفلك حاجة جديدة عن نفسك، وعندك ٢٥ ثانية بس تجاوب فيها.',
};

const START_BUTTON_LABELS = {
    1: 'ابدأ السؤال الأول!',
    2: 'ابدأ السؤال الثاني!',
};

/** ------------------------------------------------------------------
 *  حالة كل كارت وقت التشغيل (Runtime) - كل Slot ليه نسخته الخاصة
 *  بالكامل (تايمر مستقل، حالة إجابة مستقلة، الخ) عشان الكارتين
 *  يقدروا يشتغلوا مستقلين تماماً عن بعض
 *  ------------------------------------------------------------------ */
function createEmptySlotRuntime() {
    return {
        /** مرجع الـ interval الحالي بتاع تايمر الكارت ده (عشان نقدر نوقفه بأمان) */
        timerIntervalId: null,
        /** وقت بداية عدّاد الكارت ده (بالمللي ثانية) */
        timerStartedAt: null,
        /** هل المستخدم اختار إجابة في الجولة الحالية بتاعة الكارت ده بالفعل */
        hasAnswered: false,
        /** هل فيه جولة سؤال نشطة دلوقتي في الكارت ده (بدأت ولسه ملهاش
         *  نتيجة). هي المتغيّر اللي مراقبة الـ Page Visibility
         *  (handleVisibilityChange) بتتحقق منه قبل ما تقرر تلغي أي حاجة */
        isActive: false,
        /** تعريف السؤال المعروض فعلياً في الكارت ده (نص + اختيارات +
         *  الإجابة الصحيحة) - بيتحدّث في renderQuestionForSlot() قبل بداية
         *  كل جولة */
        questionDef: null,
    };
}

const slotRuntime = {
    1: createEmptySlotRuntime(),
    2: createEmptySlotRuntime(),
};

/** (مرحلة 6) بنك الأسئلة الحقيقي الجاي من Supabase - null لحد ما
 *  loadTodaysQuestionsFromServer() تخلص بنجاح (شوف getQuestionBankForSlot
 *  تحت لمنطق الرجوع لـ DAILY_QUESTION_BANK الثابت لو لسه null) */
let dynamicQuestionBank = null;

/** حماية من ربط مستمع "document:visibilitychange" أكتر من مرة */
let visibilityListenerBound = false;

/** رقم الـ Slot اللي المستخدم دوس على زرار البدء عشانه، بس لسه ما
 *  أكدش مودال التحذير (المودال مشترك بين الكارتين) - بنستخدمه عشان
 *  نعرف نبدأ أنهي سؤال بعد التأكيد */
let pendingSlot = null;

/** معرّف المستخدم الحالي (من حدث 'auth:login') - null لو مفيش تسجيل
 *  دخول. بنعرفه بنفس فلسفة js/notifications.js بالظبط (الاستماع
 *  لحدث 'auth:login'/'auth:signed-out' بدل استيراد getCurrentUser
 *  مباشرة) عشان initDailyQuestionCard() بتتنادى من app.js *قبل* ما
 *  الجلسة تتأكد فعلياً (شوف ترتيب النداءات في initApp) */
let currentUserId = null;

/**
 * إرجاع عناصر كارت Slot معيّن دفعة واحدة (بيتنادى كل مرة عشان نتجنب
 * مشاكل لو الكارت اتحط في الصفحة بعد تحميل الـ JS). كل عنصر معرّفه
 * (ID) بياخد لاحقة رقم الـ Slot (1 أو 2) زي ما هو متعرّف في index.html
 * @param {1|2} slot
 */
function getDailyQuestionElements(slot) {
    return {
        card: document.getElementById(`dailyQuestionCard${slot}`),
        lockedState: document.getElementById(`dqLockedState${slot}`),
        activeState: document.getElementById(`dqActiveState${slot}`),
        lockedIcon: document.getElementById(`dqLockedIcon${slot}`),
        lockedDescription: document.getElementById(`dqLockedDescription${slot}`),
        startBtn: document.getElementById(`dqStartBtn${slot}`),
        timerTrack: document.querySelector(`#dqActiveState${slot} .dq-timer-track`),
        timerFill: document.getElementById(`dqTimerFill${slot}`),
        timerSeconds: document.getElementById(`dqTimerSeconds${slot}`),
        questionText: document.getElementById(`dqQuestionText${slot}`),
        optionsGrid: document.getElementById(`dqOptionsGrid${slot}`),
    };
}

/** عناصر مودال التحذير (مشترك بين الكارتين، معرّفاته من غير لاحقة رقم) */
function getWarningModalElements() {
    return {
        warningModal: document.getElementById('dqWarningModal'),
        warningCancelBtn: document.getElementById('dqWarningCancelBtn'),
        warningConfirmBtn: document.getElementById('dqWarningConfirmBtn'),
    };
}

/* ------------------------------------------------------------------
   تسجيل/قراءة نتيجة سؤالي النهاردة (محلي + Supabase)
   ------------------------------------------------------------------ */

/** (إصلاح) مفتاح يوم ثابت الشكل (YYYY-MM-DD) محسوب بتوقيت القاهرة
 *  (Africa/Cairo) - نفس المنطقة الزمنية اللي بيحسب بيها السيرفر
 *  "اليوم الحقيقي" جوه RPC record_daily_question_result (شوف تعليق
 *  recordSlotResultOnServer فوق).
 *
 *  قبل كده الدالة دي كانت بتحسب التاريخ من ساعة/تاريخ جهاز المستخدم
 *  نفسه (new Date() بتوقيت المتصفح المحلي)، وده كان سبب باج حقيقي:
 *  أي مستخدم في منطقة زمنية متقدمة عن القاهرة (زي دول الخليج وقت
 *  التوقيت الصيفي المصري، فرق ساعة كاملة) كان جهازه بيعدّي منتصف
 *  الليل *قبل* ما اليوم الحقيقي في القاهرة يخلص فعلاً - فالكاش
 *  المحلي (getStoredDailyState) كان بيتجاهَل فورًا لأن `date` المخزّن
 *  بقى "قديم" بالنسبة لتاريخ الجهاز الجديد، فالكارت يفضل يرجع لحالة
 *  "متاح" ويوريله زرار "ابدأ" تاني - رغم إن سؤال النهاردة (حسب
 *  السيرفر) لسه هو هو. كل استعلام بيعتمد على getTodayDateKey()
 *  (الكاش المحلي، وreconcileTodayStatusFromSupabase) كان بيتأثر بنفس
 *  المشكلة. النقاط نفسها كانت محمية أصلاً (RPC بيرجّع alreadyRecorded)،
 *  لكن ظهور الكارت "بيتفتح تاني" كان بيبان زي ثغرة حتى لو مش فعليًا.
 *  حساب التاريخ هنا بتوقيت القاهرة تحديدًا (مش UTC ثابت، عشان مصر
 *  بتتغيّر بين +2 و+3 مع التوقيت الصيفي كل سنة) بيخلي الواجهة والسيرفر
 *  متفقين دايمًا على *نفس* اليوم، أيًا كان جهاز أو منطقة المستخدم -
 *  فمفيش فتح مزدوج ممكن يظهر أصلاً، حتى بصريًا */
function getTodayDateKey() {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Africa/Cairo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(new Date());

        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        const day = parts.find((part) => part.type === 'day')?.value;
        if (year && month && day) {
            return `${year}-${month}-${day}`;
        }
    } catch (err) {
        // احتياطي في حال عدم توفر أو خطأ في قراءة المنطقة الزمنية
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** مفتاح التخزين المحلي لطابور مزامنة نتائج الأسئلة عند انقطاع الإنترنت */
const DQ_PENDING_SYNC_STORAGE_KEY = 'skawy_dq_pending_sync';

function getPendingDqSyncList() {
    try {
        const raw = window.localStorage.getItem(DQ_PENDING_SYNC_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function queueDqPendingSync(item) {
    try {
        const list = getPendingDqSyncList();
        list.push(item);
        window.localStorage.setItem(DQ_PENDING_SYNC_STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('[daily-question.js] تعذر حفظ نتيجة السؤال في طابور المزامنة:', e);
    }
}

/**
 * إرسال نتائج الأسئلة المعلقة في طابور المزامنة عند عودة الاتصال
 */
async function flushPendingDqSync() {
    if (!currentUserId) return;
    const list = getPendingDqSyncList();
    if (list.length === 0) return;

    const remaining = [];
    for (const item of list) {
        try {
            if (item.dateKey === getTodayDateKey() && item.userId === currentUserId) {
                const { data, error } = await supabaseClient.rpc('record_daily_question_result', {
                    p_slot: item.slot,
                    p_status: item.status,
                    p_option_id: item.extra?.optionId ?? null,
                    p_remaining_seconds: item.extra?.remainingSeconds ?? null,
                });

                if (error) {
                    remaining.push(item);
                    continue;
                }

                const row = Array.isArray(data) ? data[0] : data;
                if (row && !row.out_already_recorded && row.out_is_correct) {
                    document.dispatchEvent(new CustomEvent('dailyQuestion:answered', {
                        detail: {
                            slot: item.slot,
                            optionId: item.extra?.optionId ?? null,
                            isCorrect: row.out_is_correct,
                            pointsAwarded: row.out_points_awarded ?? 0,
                            alreadyRecorded: false,
                        },
                    }));
                }
            }
        } catch (err) {
            remaining.push(item);
        }
    }

    try {
        if (remaining.length > 0) {
            window.localStorage.setItem(DQ_PENDING_SYNC_STORAGE_KEY, JSON.stringify(remaining));
        } else {
            window.localStorage.removeItem(DQ_PENDING_SYNC_STORAGE_KEY);
        }
    } catch (e) {}
}

/** قراءة حالة سؤالي *النهاردة* بس من الكاش المحلي (لو محفوظة نتيجة
 *  يوم قديم بالغلط، بنتجاهلها ونرجع {} - يوم جديد = سؤالين جداد).
 *  الشكل المُرجع: { 1?: { status, isCorrect }, 2?: { status, isCorrect } } */
function getStoredDailyState() {
    try {
        const raw = window.localStorage.getItem(getDailyStatusStorageKeyForCurrentUser());
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.date !== getTodayDateKey()) return {};
        return parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {};
    } catch (err) {
        // localStorage ممكن يكون متعطل (وضع تصفح خاص مثلاً) - بنتجاهل
        // ونسيب السؤال متاح بدل ما نكسر الكارت كله
        return {};
    }
}

/**
 * التحقق مما إذا كان المستخدم قد أتم سؤالي اليوم (بالإجابة أو انتهاء الوقت أو الإلغاء)
 * يُستخدم لحسم شرط إلغاء تذكير السؤال اليومي فوراً
 * @returns {boolean}
 */
export function areTodaysQuestionsCompleted() {
    const slots = getStoredDailyState();
    const isDone = (s) => Boolean(s && (s.status === 'answered' || s.status === 'timeout' || s.status === 'forfeited'));
    return isDone(slots[1]) && isDone(slots[2]);
}

/** تسجيل نتيجة Slot معيّن محلياً (فوري، من غير ما نستنى الشبكة) -
 *  بيحافظ على حالة الـ Slot التاني زي ما هي */
function storeSlotStatus(slot, status, isCorrect) {
    try {
        const slots = getStoredDailyState();
        slots[slot] = { status, isCorrect: isCorrect ?? null };
        window.localStorage.setItem(
            getDailyStatusStorageKeyForCurrentUser(),
            JSON.stringify({ date: getTodayDateKey(), slots }),
        );
    } catch (err) {
        // نفس ملاحظة getStoredDailyState - فشل التخزين مش سبب لكسر الكارت
    }
}

/**
 * (إصلاح أمني) تسجيل نتيجة Slot معيّن على السيرفر عن طريق دالة RPC
 * واحدة ذرية: public.record_daily_question_result (شوف
 * daily-question-security.sql). النسخة القديمة كانت بتعمل upsert مباشر
 * من الـ Frontend على جدول daily_question_status، وكانت بتصدّق قيمة
 * isCorrect جاية من المتصفح نفسه من غير أي تحقق - وده اللي كان بيسمح
 * لأي حد يفتح Developer Tools ويطلق حدث 'dailyQuestion:answered' وهمي
 * ويكسب نقاط لا نهائية.
 *
 * دلوقتي كل حاجة بتحصل جوه transaction واحدة في السيرفر:
 *   - تاريخ اليوم بيتحسب من السيرفر (Africa/Cairo)، مش من المتصفح.
 *   - الإجابة الصح بتتقارن من جدول answer_key سري، مش من isCorrect
 *     اللي المتصفح بعته.
 *   - لو الـ Slot ده كان اتسجّل بالفعل النهاردة، الـ RPC بترجع
 *     alreadyRecorded: true ومفيش أي نقاط تتضاف تاني - مستحيل تتكرر
 *     حتى لو الحدث اتطلق يدوياً 100 مرة من الـ Console.
 *
 * "Fire and forget" من ناحية الواجهة (زي الفلسفة القديمة بالظبط) -
 * فشلها ميوقفش أي حاجة تانية جوه الكارت، بس بيتسجل في console.error.
 * @param {1|2} slot
 * @param {'answered'|'timeout'|'forfeited'} status
 * @param {{optionId?: string, remainingSeconds?: number}} [extra]
 * @returns {Promise<{isCorrect: boolean|null, pointsAwarded: number, alreadyRecorded: boolean}|null>}
 */
async function recordSlotResultOnServer(slot, status, extra = {}) {
    if (!currentUserId) return null; // مفيش تسجيل دخول دلوقتي - localStorage بس كافي، مفيش نقاط أصلاً

    try {
        const { data, error } = await supabaseClient.rpc('record_daily_question_result', {
            p_slot: slot,
            p_status: status,
            p_option_id: extra.optionId ?? null,
            p_remaining_seconds: extra.remainingSeconds ?? null,
        });

        if (error) {
            console.error('[daily-question.js] فشل تسجيل نتيجة السؤال اليومي في السيرفر:', error.message);
            return null;
        }

        // الدالة معرّفة بـ "returns table" فبترجع Array من صف واحد
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return null;

        return {
            isCorrect: row.out_is_correct ?? null,
            pointsAwarded: row.out_points_awarded ?? 0,
            alreadyRecorded: Boolean(row.out_already_recorded),
        };
    } catch (err) {
        console.error('[daily-question.js] استثناء غير متوقع أثناء تسجيل نتيجة السؤال اليومي:', err);
        return null;
    }
}

/**
 * تسجيل نتيجة نهاية جولة Slot معيّن في المكانين معاً (محلي + السيرفر) -
 * نقطة دخول واحدة تُستدعى من الثلاث مسارات اللي بتنهي أي جولة
 * (إجابة/تايم آوت/خروج بدري) بدل ما كل مسار يكرر نفس المنطق.
 *
 * (إصلاح أمني) الإجابة الصح المخزّنة محلياً وحدث 'dailyQuestion:answered'
 * اللي بيسمعه profiles.js دلوقتي مصدرهم *السيرفر* (بعد تحقق RPC)، مش
 * قيمة isCorrect الجاية من الـ Click handler - فمفيش أي مسار من الـ
 * Frontend يقدر يمنح نقاط من غير ما يعدي على تحقق سيرفري حقيقي.
 * @param {1|2} slot
 * @param {'answered'|'timeout'|'forfeited'} status
 * @param {{optionId?: string, remainingSeconds?: number}} [extra]
 */
async function finalizeSlot(slot, status, extra = {}) {
    // 1) حفظ متفائل فوري محلياً (Optimistic Persistence) قبل انتظار السيرفر
    // يضمن أن advanceCardAfterSlot تجد الحالة مسجلة دائماً فور انتهاء المهلة وتمنع عودة زر ابدأ
    const optimisticIsCorrect = typeof extra.isCorrect === 'boolean' ? extra.isCorrect : null;
    storeSlotStatus(slot, status, optimisticIsCorrect);

    // إلغاء تذكير السؤال اليومي فوراً بمجرد اكتمال سؤالي اليوم
    if (areTodaysQuestionsCompleted()) {
        cancelDailyQuestionReminder();
    }

    // 2) إرسال النتيجة إلى السيرفر
    const serverResult = await recordSlotResultOnServer(slot, status, extra);

    // (إصلاح) لو السيرفر قال "متسجّل بالفعل" (alreadyRecorded)، يبقى
    // النتيجة الحقيقية اتسجّلت من قبل - الـ RPC بترجع isCorrect: null في
    // الحالة دي لأنها مش هي اللي حسبتها. بدل ما نخزّن null ونمسح فوق
    // نتيجة صح كانت متسجّلة، نجيب الحقيقة من جدول daily_question_status
    // نفسه (نفس مصدر reconcileTodayStatusFromSupabase وقت تحميل الصفحة)
    if (status === 'answered' && serverResult && serverResult.alreadyRecorded) {
        await reconcileTodayStatusFromSupabase();
        return;
    }

    // إذا تعذر الوصول للسيرفر والمستخدم مسجل دخول، نضيف المحاولة لطابور المزامنة
    if (!serverResult && currentUserId) {
        queueDqPendingSync({
            dateKey: getTodayDateKey(),
            userId: currentUserId,
            slot,
            status,
            extra,
            timestamp: Date.now(),
        });
    }

    // اعتماد نتيجة السيرفر المؤكدة، أو النتيجة المتفائلة كاحتياطي لتفادي رسالة "غلط" كاذبة
    const verifiedIsCorrect = serverResult
        ? serverResult.isCorrect
        : (typeof extra.isCorrect === 'boolean' ? extra.isCorrect : null);

    storeSlotStatus(slot, status, verifiedIsCorrect);

    // إعادة رسم بطاقة الـ Slot في الواجهة بالنتيجة المؤكدة
    const slots = getStoredDailyState();
    applyLockedUIForSlot(slot, slots[slot]);

    if (status === 'answered' && serverResult && !serverResult.alreadyRecorded) {
        document.dispatchEvent(new CustomEvent('dailyQuestion:answered', {
            detail: {
                slot,
                optionId: extra.optionId ?? null,
                isCorrect: serverResult.isCorrect,
                pointsAwarded: serverResult.pointsAwarded,
                alreadyRecorded: false,
            },
        }));
    }
}

/**
 * (كاش الأوفلاين) نسخة "خام" من جلب حالة سؤالي النهاردة (الاتنين) من
 * Supabase - بترجع null صراحة عند فشل حقيقي (مشكلة شبكة/سيرفر)، أو
 * المصفوفة (حتى لو فاضية - يعني فعلاً لسه ما جاوبش على أي سؤال
 * النهاردة) في حالة النجاح. تُستخدم بس جوه reconcileTodayStatusFromSupabase
 * تحت.
 * @returns {Promise<Array<object>|null>}
 */
async function fetchTodayStatusFromServer() {
    const { data, error } = await supabaseClient
        .from('daily_question_status')
        .select('question_slot, status, is_correct')
        .eq('user_id', currentUserId)
        .eq('question_date', getTodayDateKey());

    if (error) {
        console.error('[daily-question.js] فشل جلب حالة السؤال اليومي من Supabase:', error.message);
        return null;
    }

    return data || [];
}

/**
 * تطبيق صفوف حالة السؤال (من الكاش أو من السيرفر) على الكاش المحلي
 * (localStorage) وعلى واجهة الكارتين - مفصولة عن الجلب نفسه عشان
 * تُستخدم مع النسختين (المخزّنة والجاية من الشبكة) من غير تكرار
 * @param {Array<object>} data
 */
function applyTodayStatusRows(data) {
    if (!Array.isArray(data) || data.length === 0) return;

    // نحدّث الكاش المحلي كمان عشان لو الجهاز ده جديد (localStorage
    // فاضي) يتظبط من أول مرة، وبعدين نرسم حالة كل كارت لوحده
    data.forEach((row) => {
        if (row?.question_slot) {
            storeSlotStatus(row.question_slot, row.status, row.is_correct);
        }
    });
    const slots = getStoredDailyState();
    applyLockedUIForSlot(1, slots[1]);
    applyLockedUIForSlot(2, slots[2]);

    // تقييم وجدولة أو إلغاء تذكير السؤال اليومي بناءً على حالة اليوم الحقيقية
    evaluateAndScheduleDailyQuestionReminder({
        areAllQuestionsDone: areTodaysQuestionsCompleted(),
    });
}

/**
 * جلب نتيجة سؤالي النهاردة (الاتنين) من Supabase (لو المستخدم مسجّل
 * دخول) عشان نتأكد إن كل كارت يفضل بالحالة الصح حتى لو المستخدم عمل
 * Refresh أو فتح التطبيق من جهاز تاني - مش بس معتمدين على
 * localStorage الجهاز الحالي. بتتنادى مرة واحدة كل ما هوية المستخدم
 * تتأكد (حدث 'auth:login').
 *
 * (كاش الأوفلاين) بتعرض النسخة المخزّنة محلياً
 * (cached_daily_question_status:<userId>:<تاريخ اليوم>) فوراً لو
 * موجودة (مفيدة أساساً وقت فتح التطبيق أوفلاين بعد تسجيل الدخول من
 * قبل)، وتحدّثها في الخلفية تلقائياً بعد كل قراءة ناجحة من الشبكة -
 * نفس منطق التطبيق القديم (بدون كاش) فضل زي ما هو تماماً، بس اتقسم
 * لدالتين (fetchTodayStatusFromServer + applyTodayStatusRows) عشان
 * يتقدروا يتستخدموا مع fetchWithCache
 */
async function reconcileTodayStatusFromSupabase() {
    if (!currentUserId) return;

    try {
        await fetchWithCache(
            `cached_daily_question_status:${currentUserId}:${getTodayDateKey()}`,
            fetchTodayStatusFromServer,
            applyTodayStatusRows,
        );
    } catch (err) {
        console.error('[daily-question.js] استثناء غير متوقع أثناء جلب حالة السؤال اليومي:', err);
    }
}

/* ------------------------------------------------------------------
   (مرحلة 6) جلب سؤالي اليوم الحقيقيين من Supabase
   ------------------------------------------------------------------ */

/**
 * (كاش الأوفلاين) نسخة "خام" من جلب سؤالي اليوم من
 * public.get_todays_daily_questions وتحويلهم لنفس شكل
 * DAILY_QUESTION_BANK (id/text/options/correctOptionId) - بترجع null
 * صراحة عند فشل حقيقي أو لو الاتنين Slot 1 وSlot 2 مجاش سليمين (نفس
 * فلسفة "نرجع للاحتياطي كامل بدل ما نخلط سؤال حقيقي مع Placeholder"
 * الأصلية)، وإلا بترجع الـ bank كامل. تُستخدم بس جوه
 * loadTodaysQuestionsFromServer تحت.
 * @returns {Promise<object|null>}
 */
async function fetchTodaysQuestionsFromServer() {
    const { data, error } = await supabaseClient.rpc('get_todays_daily_questions');

    if (error) {
        console.error('[daily-question.js] فشل جلب أسئلة اليوم من السيرفر، هنستخدم الأسئلة الاحتياطية:', error.message);
        return null;
    }

    if (!Array.isArray(data) || data.length === 0) return null;

    const bank = {};
    data.forEach((row) => {
        if (!row || (row.slot !== 1 && row.slot !== 2)) return;
        bank[row.slot] = {
            id: String(row.question_id || ''),
            text: row.question_text,
            options: Array.isArray(row.options)
                ? row.options.map((opt) => ({
                    id: String(opt.id),
                    text: String(opt.text || ''),
                }))
                : [],
            correctOptionId: String(row.correct_option_id ?? ''),
        };
    });

    return (bank[1] && bank[2]) ? bank : null;
}

/**
 * تجيب سؤالي اليوم (Slot 1 و2) وتخزّنهم في dynamicQuestionBank عشان
 * renderQuestionForSlot تشتغل من غير أي تعديل تاني في منطقها. بتتنادى
 * مرة واحدة بس من initDailyQuestionCard() - لو فشلت لأي سبب (شبكة،
 * السيرفر لسه ما جهزش الأسئلة..) بيفضل dynamicQuestionBank = null
 * وgetQuestionBankForSlot بترجع لـ DAILY_QUESTION_BANK الثابت تلقائياً
 * كشبكة أمان.
 *
 * (كاش الأوفلاين) بتعرض النسخة المخزّنة محلياً
 * (cached_daily_questions:<تاريخ اليوم>) فوراً لو موجودة (مش شخصية -
 * نفس السؤالين لكل الناس)، وتحدّثها في الخلفية تلقائياً بعد كل قراءة
 * ناجحة من الشبكة. ده تحسين إضافي بس مش أساسي (الشبكة الأمان الثابتة
 * DAILY_QUESTION_BANK موجودة أصلاً) - شوف ملحوظة الأولوية في خطة
 * التخزين المؤقت
 */
async function loadTodaysQuestionsFromServer() {
    try {
        await fetchWithCache(
            `cached_daily_questions:${getTodayDateKey()}`,
            fetchTodaysQuestionsFromServer,
            (bank) => {
                dynamicQuestionBank = bank;
            },
        );
    } catch (err) {
        console.error('[daily-question.js] استثناء غير متوقع أثناء جلب أسئلة اليوم:', err);
    }
}

/** إرجاع تعريف سؤال Slot معيّن - من البنك الحقيقي الجاي من Supabase
 *  لو جاهز، وإلا من البنك الثابت الاحتياطي (شوف تعليق dynamicQuestionBank فوق)
 * @param {1|2} slot
 */
function getQuestionBankForSlot(slot) {
    if (dynamicQuestionBank && dynamicQuestionBank[slot]) return dynamicQuestionBank[slot];
    return DAILY_QUESTION_BANK[slot];
}

/* ------------------------------------------------------------------
   رسم حالة "مغلق" لكارت Slot معيّن حسب نتيجته هو بس (مستقل تماماً عن
   حالة الكارت التاني)
   ------------------------------------------------------------------ */

/**
 * رسم حالة "مغلق" لكارت Slot معيّن: يتحكم في ظهور/اختفاء زرار البدء
 * (ولابل بتاعه)، ويغيّر لون الأيقونة والنص حسب "danger" (true = روز/
 * تحذيري لحالة forfeited، false = محايد بلون النص الافتراضي)
 * @param {1|2} slot
 * @param {string} message
 * @param {{danger?: boolean, showStart?: boolean}} [options]
 */
function renderLockedCompletionUI(slot, message, { danger = false, showStart = false } = {}) {
    const { lockedIcon, lockedDescription, startBtn } = getDailyQuestionElements(slot);

    if (lockedIcon) lockedIcon.classList.toggle('is-forfeited', danger);
    if (lockedDescription) {
        lockedDescription.textContent = message;
        lockedDescription.classList.toggle('text-rose-400', danger);
        lockedDescription.classList.toggle('font-bold', danger);
        lockedDescription.classList.toggle('text-lux-400', !danger);
        lockedDescription.classList.toggle('font-medium', !danger);
    }
    if (startBtn) {
        startBtn.classList.toggle('hidden', !showStart);
        if (showStart) {
            const labelSpan = startBtn.querySelector('span');
            if (labelSpan) labelSpan.textContent = START_BUTTON_LABELS[slot];
        }
    }
}

/** رسالة نتيجة كارت Slot بعد ما يخلص، بتختلف حسب طريقة انتهائه -
 *  الرسالة دي خاصة بالكارت ده بس، ومش بتتكلم عن الكارت التاني خالص
 *  لأن كل كارت بقى مستقل تماماً عن التاني
 * @param {{status: string, isCorrect: boolean|null}} outcome
 */
function buildSlotOutcomeMessage(outcome) {
    if (!outcome) return '';
    if (outcome.status === 'answered') {
        return outcome.isCorrect
            ? 'إجابتك كانت صح! تعالى بكرة تلاقي سؤال جديد.'
            : 'إجابتك كانت غلط، حظ أوفر بكرة!';
    }
    if (outcome.status === 'timeout') {
        return 'خلص الوقت من غير إجابة! تعالى بكرة تجاوب بسرعة أكتر.';
    }
    return 'السؤال ده متحسبش عشان طلعت برة سِكّاوي! تعالى بكرة تجاوبه من الأول.';
}

/**
 * توزيع حالة كارت Slot معيّن المخزّنة (محلياً أو من Supabase) على شكل
 * الكارت المناسب - مستقل تماماً عن حالة الكارت التاني:
 *   1) لسه السؤال ده ما اتفتحش → الشكل الافتراضي (بدون تعديل، زي ما
 *      هو مكتوب Static في index.html من الأساس).
 *   2) السؤال ده خلص (جاوب/خلص وقته/طلع بدري) → شكل "مقفول" نهائي
 *      لبقية اليوم (زرار البدء مختفي خالص) فيه نتيجته هو بس.
 * @param {1|2} slot
 * @param {{status: string, isCorrect: boolean|null}|undefined} outcome
 */
function applyLockedUIForSlot(slot, outcome) {
    const { activeState, lockedState } = getDailyQuestionElements(slot);

    if (!outcome) {
        // لسه محدش لمس الكارت ده - الحالة الافتراضية: شاشة "ابدأ" (جوه
        // lockedState) هي الظاهرة، والشاشة النشطة (تايمر + اختيارات)
        // مخفية - لحد ما المستخدم يدوس "ابدأ" بنفسه (activateDailyQuestion)
        if (activeState) activeState.classList.add('hidden');
        if (lockedState) lockedState.classList.remove('hidden');
        renderLockedCompletionUI(slot, DEFAULT_LOCKED_DESCRIPTIONS[slot], {
            danger: false,
            showStart: true,
        });
        return;
    }

    // (إصلاح) السؤال ده خلص بالفعل - لازم نخفي شاشة "نشط" (زرار "ابدأ")
    // ونظهر شاشة "مقفول" فعليًا، مش بس نحدّث النص جواها. من غير السطرين
    // دول، أي Refresh أو مزامنة (reconcileTodayStatusFromSupabase) بعد
    // الإجابة كانت بتسيب زرار "ابدأ" ظاهر وتسمح بإعادة الإجابة على سؤال
    // اتقفل بالفعل من ناحية السيرفر
    if (activeState) activeState.classList.add('hidden');
    if (lockedState) lockedState.classList.remove('hidden');

    const isForfeited = outcome.status === 'forfeited';
    renderLockedCompletionUI(slot, buildSlotOutcomeMessage(outcome), {
        danger: isForfeited,
        showStart: false,
    });
}

/** رسم حالة "مغلق" للكارتين الاتنين مرة واحدة حسب آخر حالة مخزّنة -
 *  Helper بسيط بينادي applyLockedUIForSlot() لكل Slot لوحده */
function applyLockedUIForAllSlots() {
    const slots = getStoredDailyState();
    applyLockedUIForSlot(1, slots[1]);
    applyLockedUIForSlot(2, slots[2]);
}

/* ------------------------------------------------------------------
   مودال التحذير قبل البدء (مشترك بين الكارتين)
   ------------------------------------------------------------------ */

function openDqWarningModal() {
    const { warningModal } = getWarningModalElements();
    if (!warningModal) return;
    pushModalState(hideDqWarningModal);
    warningModal.classList.remove('hidden');
    warningModal.classList.add('flex');
}

function hideDqWarningModal() {
    pendingSlot = null;
    const { warningModal } = getWarningModalElements();
    if (!warningModal) return;
    warningModal.classList.add('hidden');
    warningModal.classList.remove('flex');
}

function closeDqWarningModal() {
    if (hasOpenModal()) {
        closeModal();
    } else {
        hideDqWarningModal();
    }
}

/**
 * تحديد لون العدّاد المناسب للثواني المتبقية لكارت Slot معيّن عن طريق
 * ضبط متغيّر CSS "--dq-timer-color" على كارت ده بس (كل كارت مستقل بلونه)
 * @param {1|2} slot
 * @param {number} remainingSeconds
 */
function applyTimerColorState(slot, remainingSeconds) {
    const { card } = getDailyQuestionElements(slot);
    if (!card) return;

    let colorVar = '--brand-500'; // آمن (التركواز الأساسي)
    if (remainingSeconds <= TIMER_DANGER_THRESHOLD_SECONDS) {
        colorVar = '--dq-timer-danger';
    } else if (remainingSeconds <= TIMER_WARN_THRESHOLD_SECONDS) {
        colorVar = '--gold-500';
    }

    card.style.setProperty('--dq-timer-color', `var(${colorVar})`);
}

/**
 * تحديث شكل شريط المؤقت ورقم الثواني على كل "تِك" لكارت Slot معيّن
 * @param {1|2} slot
 */
function tickTimer(slot) {
    const runtime = slotRuntime[slot];
    const { timerFill, timerSeconds, timerTrack } = getDailyQuestionElements(slot);
    if (!timerFill || !timerSeconds) return;

    const elapsedMs = Date.now() - runtime.timerStartedAt;
    const remainingMs = Math.max(0, QUESTION_DURATION_SECONDS * 1000 - elapsedMs);
    const remainingSecondsCeil = Math.ceil(remainingMs / 1000);
    const progressPercent = (remainingMs / (QUESTION_DURATION_SECONDS * 1000)) * 100;

    timerFill.style.width = `${progressPercent}%`;
    timerSeconds.textContent = String(remainingSecondsCeil);
    applyTimerColorState(slot, remainingSecondsCeil);

    if (remainingMs <= 0) {
        stopTimer(slot);
        runtime.isActive = false;
        if (timerTrack) timerTrack.classList.add('is-expired');
        if (!runtime.hasAnswered) {
            disableAllOptions(slot);
            applyTimeoutFeedbackUI(slot);
            document.dispatchEvent(new CustomEvent('dailyQuestion:timeout', {
                detail: { slot },
            }));
            completeSlotAndAdvance(slot, 'timeout');
        }
    }
}

/**
 * بدء عدّاد الـ 25 ثانية من جديد لكارت Slot معيّن (بيتنادى كل ما سؤال
 * جديد يتفتح)
 * @param {1|2} slot
 */
function startTimer(slot) {
    stopTimer(slot); // احتياطي لو كان فيه عدّاد شغال أصلاً لنفس الكارت

    const runtime = slotRuntime[slot];
    runtime.timerStartedAt = Date.now();
    runtime.hasAnswered = false;
    runtime.isActive = true;

    const { timerTrack } = getDailyQuestionElements(slot);
    if (timerTrack) timerTrack.classList.remove('is-expired');

    applyTimerColorState(slot, QUESTION_DURATION_SECONDS);
    tickTimer(slot); // أول رسمة فورية من غير ما ننتظر أول interval

    // بنحدّث كل 100ms عشان شريط التقدّم يبان ناعم، مش قافز كل ثانية
    runtime.timerIntervalId = window.setInterval(() => tickTimer(slot), 100);
}

/**
 * إيقاف العدّاد الحالي بتاع كارت Slot معيّن (يتنادى عند الإجابة، أو
 * انتهاء الوقت، أو الخروج المبكر)
 * @param {1|2} slot
 */
function stopTimer(slot) {
    const runtime = slotRuntime[slot];
    if (runtime.timerIntervalId !== null) {
        window.clearInterval(runtime.timerIntervalId);
        runtime.timerIntervalId = null;
    }
}

/**
 * تعطيل كل كروت الاختيارات بصرياً وفعلياً في كارت Slot معيّن
 * @param {1|2} slot
 */
function disableAllOptions(slot) {
    const { optionsGrid } = getDailyQuestionElements(slot);
    if (!optionsGrid) return;

    optionsGrid.querySelectorAll('.dq-option-card').forEach((optionBtn) => {
        optionBtn.disabled = true;
    });
}

/**
 * إبراز نتيجة اختيار المستخدم بصرياً بعد ما يجاوب في كارت Slot معيّن:
 *   - الاختيار المُختار: is-correct (أخضر) لو صح، أو is-incorrect
 *     (أحمر) لو غلط.
 *   - لو غلط: الاختيار الصحيح ياخد is-correct-reveal (أخضر) عشان
 *     المستخدم يشوف الإجابة الصح كانت إيه.
 * @param {1|2} slot
 * @param {string} selectedOptionId
 * @param {boolean} isCorrect
 */
function applyAnswerFeedbackUI(slot, selectedOptionId, isCorrect) {
    const { optionsGrid } = getDailyQuestionElements(slot);
    const questionDef = slotRuntime[slot].questionDef;
    if (!optionsGrid || !questionDef) return;

    const selectedBtn = optionsGrid.querySelector(`[data-option-id="${selectedOptionId}"]`);
    if (selectedBtn) selectedBtn.classList.add(isCorrect ? 'is-correct' : 'is-incorrect');

    if (!isCorrect) {
        const correctBtn = optionsGrid.querySelector(`[data-option-id="${questionDef.correctOptionId}"]`);
        if (correctBtn) correctBtn.classList.add('is-correct-reveal');
    }
}

/**
 * إبراز الإجابة الصحيحة بس (من غير أي اختيار "غلط") في كارت Slot
 * معيّن - بتتنادى في حالة "خلص الوقت من غير ما المستخدم يجاوب" عشان
 * يتعلم الإجابة الصح
 * @param {1|2} slot
 */
function applyTimeoutFeedbackUI(slot) {
    const { optionsGrid } = getDailyQuestionElements(slot);
    const questionDef = slotRuntime[slot].questionDef;
    if (!optionsGrid || !questionDef) return;

    const correctBtn = optionsGrid.querySelector(`[data-option-id="${questionDef.correctOptionId}"]`);
    if (correctBtn) correctBtn.classList.add('is-correct-reveal');
}

/**
 * التعامل مع ضغط المستخدم على أحد كروت الاختيارات في كارت Slot معيّن:
 * بيسجّل الاختيار، يقارنه بالإجابة الصحيحة، يرسم النتيجة بصرياً،
 * وبعدين ينهي جولة الكارت ده بس
 * @param {1|2} slot
 * @param {MouseEvent} event
 */
function handleOptionClick(slot, event) {
    const runtime = slotRuntime[slot];
    const optionBtn = event.currentTarget;
    if (optionBtn.disabled || runtime.hasAnswered || !runtime.questionDef) return;

    runtime.hasAnswered = true;
    runtime.isActive = false;

    const { timerSeconds } = getDailyQuestionElements(slot);
    const remainingSeconds = timerSeconds ? Number(timerSeconds.textContent) : 0;
    const selectedOptionId = optionBtn.dataset.optionId;
    const isCorrect = String(selectedOptionId) === String(runtime.questionDef.correctOptionId);

    optionBtn.classList.add('is-selected');
    optionBtn.setAttribute('aria-checked', 'true');
    applyAnswerFeedbackUI(slot, selectedOptionId, isCorrect);

    stopTimer(slot);
    disableAllOptions(slot);

    // (إصلاح أمني) الحدث 'dailyQuestion:answered' اللي profiles.js بيسمعه
    // عشان يعكس النقاط بقى بيتطلق من finalizeSlot *بعد* ما السيرفر يتحقق
    // من الإجابة (شوف recordSlotResultOnServer) - مش من هنا مباشرة بقيمة
    // isCorrect المحسوبة في المتصفح. isCorrect هنا بتستخدم بس للتلوين
    // البصري الفوري (أخضر/أحمر) قبل ما رد السيرفر يوصل.
    completeSlotAndAdvance(slot, 'answered', { optionId: selectedOptionId, isCorrect, remainingSeconds });
}

/**
 * بناء محتوى سؤال Slot معيّن (نص + كروت الاختيارات) ديناميكياً من
 * DAILY_QUESTION_BANK، وربط حدث الضغط بكل كارت اختيار جديد. بتُستدعى
 * قبل بداية كل جولة (Slot 1 أو Slot 2)
 * @param {1|2} slot
 */
function renderQuestionForSlot(slot) {
    const questionDef = getQuestionBankForSlot(slot);
    slotRuntime[slot].questionDef = questionDef;
    if (!questionDef) return;

    const { questionText, optionsGrid } = getDailyQuestionElements(slot);
    if (questionText) questionText.textContent = questionDef.text;
    if (!optionsGrid) return;

    optionsGrid.innerHTML = '';

    questionDef.options.forEach((option) => {
        const optionBtn = document.createElement('button');
        optionBtn.type = 'button';
        optionBtn.className = 'dq-option-card';
        optionBtn.setAttribute('role', 'radio');
        optionBtn.setAttribute('aria-checked', 'false');
        optionBtn.dataset.optionId = option.id;

        const marker = document.createElement('span');
        marker.className = 'dq-option-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + '<path d="M5 12.5L9.5 17L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
            + '</svg>';

        const label = document.createElement('span');
        label.textContent = option.text;

        optionBtn.append(marker, label);
        optionBtn.addEventListener('click', (event) => handleOptionClick(slot, event));
        optionsGrid.appendChild(optionBtn);
    });
}

/**
 * إعادة تصفير شكل كروت الاختيارات في كارت Slot معيّن (احتياطي - في
 * الغالب مش هيلاقي حاجة يشيلها لأن renderQuestionForSlot() بيبني
 * الكروت من جديد كل مرة، بس سايبينها كطبقة أمان لو الدالة دي اتنادت
 * من مكان تاني في المستقبل)
 * @param {1|2} slot
 */
function resetOptionsUI(slot) {
    const { optionsGrid } = getDailyQuestionElements(slot);
    if (!optionsGrid) return;

    optionsGrid.querySelectorAll('.dq-option-card').forEach((optionBtn) => {
        optionBtn.disabled = false;
        optionBtn.classList.remove('is-selected', 'is-correct', 'is-incorrect', 'is-correct-reveal');
        optionBtn.setAttribute('aria-checked', 'false');
    });
}

/**
 * الانتقال من حالة "مغلق" إلى حالة "نشط" لسؤال Slot معيّن: بناء
 * محتوى السؤال + تصفير الشكل + بدء العدّاد بتاع الكارت ده بس. بتتنادى
 * فقط بعد تأكيد مودال التحذير
 * @param {1|2} slot
 */
function activateDailyQuestion(slot) {
    const { lockedState, activeState } = getDailyQuestionElements(slot);
    if (!lockedState || !activeState) return;

    renderQuestionForSlot(slot);
    resetOptionsUI(slot);

    lockedState.classList.add('hidden');
    activeState.classList.remove('hidden');

    startTimer(slot);
}

/** نص التوست الموحّد اللي بيظهر للزائر لو حاول يبدأ السؤال اليومي -
 *  نفس نص GUEST_LOCKED_TOAST_MESSAGE في geofence.js بالظبط، عشان تفضل
 *  رسالة "محتاج حساب" موحّدة في كل التطبيق مهما كان مصدرها */
const DQ_GUEST_LOCKED_TOAST_MESSAGE =
    'الميزة دي محتاجة حساب - سجّل حساب أو سجّل دخول عشان تقدر تستخدمها.';

/** التعامل مع ضغط زرار البدء بتاع كارت Slot معيّن - بيفتح مودال
 *  التحذير قبل ما يبدأ السؤال ده فعلياً
 * @param {1|2} slot
 */
function handleStartButtonClick(slot) {
    // (إصلاح أمني - طلب صريح): السؤال اليومي لازم يفضل مقفول بالكامل
    // لغير المسجّلين، بدون أي استثناء أو معاينة. الاعتماد كان قبل كده
    // على window.isGuestMode بس، وده علم بيتحدد بشكل غير متزامن (بعد
    // تأكيد Supabase فعليًا - شوف تعليق applyGuestModeRestrictions في
    // app.js) فبييفضل undefined (يعني "مش true" = مسموح) لجزء من
    // الثانية عند كل فتح للتطبيق قبل ما التأكيد يوصل. لو مستخدم زائر
    // ضغط "ابدأ" بسرعة في اللحظة دي بالظبط، كان بيعدّي فعليًا رغم إنه
    // زائر. الفحص هنا بقى على currentUserId مباشرة بدل isGuestMode:
    // القيمة دي مبتتغيرش أبداً لزائر حقيقي (بتفضل null طول الوقت لحد
    // ما 'auth:login' يتطلق فعليًا بهوية حقيقية)، فمفيش أي نافذة زمنية
    // ممكن الزائر يستغلها - القفل بقى "افتراضيًا مرفوض" (Fail-Closed)
    // بدل "افتراضيًا مسموح لحد ما يتأكد العكس" (Fail-Open) القديم.
    if (!currentUserId) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: DQ_GUEST_LOCKED_TOAST_MESSAGE },
        }));
        return;
    }

    pendingSlot = slot;
    openDqWarningModal();
}

/** التعامل مع تأكيد مودال التحذير: قفل المودال وبدء سؤال الـ Slot
 *  المُعلّق فعلياً (الكارت التاني، لو كان في حالة "مغلق"، يفضل زي ما
 *  هو من غير ما يتأثر خالص) */
function handleWarningConfirmClick() {
    const slotToActivate = pendingSlot;
    closeDqWarningModal();
    if (!slotToActivate) return;
    activateDailyQuestion(slotToActivate);
}

/**
 * حماية ضد الخروج من التطبيق أثناء أي جولة نشطة. بتتنادى على كل
 * تغيير في document.visibilityState؛ بتفحص الكارتين الاتنين كل واحد
 * لوحده - أي Slot عنده جولة شغالة فعلاً (isActive === true) ولسه
 * ملهوش إجابة (hasAnswered === false) وقت ما المستخدم خرج
 * (document.hidden === true - سواء قلب على أبلكيشن تاني، أو جاله
 * إشعار/مكالمة سحبت الفوكس) بيتلغى، حتى لو الكارت التاني كان قاعد في
 * حالة مغلق أو نشط في نفس اللحظة
 */
function handleVisibilityChange() {
    if (!document.hidden) return;

    [1, 2].forEach((slot) => {
        const runtime = slotRuntime[slot];
        if (runtime.isActive && !runtime.hasAnswered) {
            forfeitDueToExit(slot);
        }
    });
}

/**
 * تنفيذ "الإلغاء" الفعلي لسؤال كارت Slot معيّن بسبب خروج مبكر:
 *   1) يوقف تايمر الكارت ده فوراً.
 *   2) يسجّل الجولة كـ "forfeited" في localStorage + Supabase.
 *   3) يبعت إشعار رسمي حقيقي عبر sendNotification (لو مسجّل دخول)
 *      موضّح فيه أنهي سؤال (الأول ولا الثاني) اتحرم.
 *   4) يطلق حدث "dailyQuestion:exited" لأي مرحلة تانية عايزة تكمل عليه.
 *   5) ينقل الكارت ده بس لحالة "مغلق" النهائية (الكارت التاني مش بيتأثر)
 * @param {1|2} slot
 */
function forfeitDueToExit(slot) {
    const runtime = slotRuntime[slot];
    const { timerSeconds } = getDailyQuestionElements(slot);
    const remainingSeconds = timerSeconds ? Number(timerSeconds.textContent) : 0;

    runtime.isActive = false;
    stopTimer(slot);
    disableAllOptions(slot);

    if (currentUserId) {
        // Fire and forget - نفس فلسفة sendNotification نفسها (مفيش داعي
        // نستنى الرد قبل ما نكمل، الإشعار مش شرط لإتمام عملية الإلغاء)
        sendNotification({
            userId: currentUserId,
            type: DQ_FORFEIT_NOTIFICATION_TYPE,
            title: 'السؤال اليومي',
            message: slot === 1
                ? 'إجابة السؤال الأول متحسبتش النهاردة عشان طلعت برة سِكّاوي!'
                : 'إجابة السؤال الثاني متحسبتش النهاردة عشان طلعت برة سِكّاوي!',
        });
    }

    document.dispatchEvent(new CustomEvent('dailyQuestion:exited', {
        detail: { slot, remainingSeconds },
    }));

    completeSlotAndAdvance(slot, 'forfeited', { remainingSeconds });
}

/**
 * نقطة النهاية الموحّدة لأي طريقة تنهي بيها جولة كارت Slot معيّن
 * (إجابة/تايم آوت/خروج بدري): بتسجّل النتيجة، وبعد فترة بسيطة (عشان
 * يبان تأثير الألوان في حالة الإجابة/التايم آوت) بتنقل الكارت ده بس
 * لحالة "مغلق" النهائية بتاعته - من غير ما تلمس الكارت التاني خالص.
 * لحالة "forfeited" (خروج من التطبيق) بننقل على طول من غير تأخير لأن
 * المستخدم أصلاً مش شايف الشاشة دلوقتي.
 * @param {1|2} slot
 * @param {'answered'|'timeout'|'forfeited'} status
 * @param {{optionId?: string, remainingSeconds?: number, isCorrect?: boolean}} [extra]
 */
function completeSlotAndAdvance(slot, status, extra = {}) {
    finalizeSlot(slot, status, extra);

    const delayMs = status === 'forfeited' ? 0 : FEEDBACK_DISPLAY_MS;

    window.setTimeout(() => {
        advanceCardAfterSlot(slot);
    }, delayMs);
}

/**
 * الانتقال الفعلي لكارت Slot معيّن بعد ما يخلص: إخفاء حالة "نشط"،
 * إظهار حالة "مغلق"، ورسم نتيجته هو بس (الكارت التاني مش بيتلمس).
 * لو الكارتين الاتنين خلصوا دلوقتي، بيطلق كمان حدث
 * "dailyQuestion:dayCompleted"
 * @param {1|2} finishedSlot
 */
function advanceCardAfterSlot(finishedSlot) {
    const { activeState, lockedState } = getDailyQuestionElements(finishedSlot);
    if (activeState) activeState.classList.add('hidden');
    if (lockedState) lockedState.classList.remove('hidden');

    const slots = getStoredDailyState();
    applyLockedUIForSlot(finishedSlot, slots[finishedSlot]);

    const bothSlotsCompleted = [1, 2].every((slot) => Boolean(slots[slot]));
    if (bothSlotsCompleted) {
        document.dispatchEvent(new CustomEvent('dailyQuestion:dayCompleted', {
            detail: { slot1: slots[1] ?? null, slot2: slots[2] ?? null },
        }));
    }
}

/**
 * ربط كل أحداث كارتي السؤال اليومي (زرار بدء كل كارت لوحده، مودال
 * التحذير المشترك، حماية الخروج المبكر، ومعرفة هوية المستخدم). تُستدعى
 * مرة واحدة من app.js عند تحميل الصفحة الرئيسية، بنفس نمط باقي دوال
 * init التانية
 */
export function initDailyQuestionCard() {
    // لو سؤالي النهاردة (أو حتى بس واحد منهم) له نتيجة متسجّلة بالفعل
    // محلياً (على نفس الجهاز) من قبل ما الصفحة تُحمّل من الأساس - نعرض
    // الحالة المناسبة لكل كارت على طول، من غير ما نستنى Supabase (اللي
    // محتاجة هوية مستخدم لسه مش متأكدة في اللحظة دي - شوف تعليق
    // currentUserId فوق)
    applyLockedUIForAllSlots();

    // (مرحلة 6) نجيب سؤالي اليوم الحقيقيين بدري قد ما نقدر - Fire and
    // forget زي باقي نداءات الشبكة في الملف ده، مفيش داعي نستنى ردها
    // قبل ما نكمل تهيئة باقي الكارت (getQuestionBankForSlot بترجع
    // للاحتياطي تلقائياً لو المستخدم ضغط "ابدأ" قبل ما الرد يوصل)
    loadTodaysQuestionsFromServer();

    [1, 2].forEach((slot) => {
        const { startBtn } = getDailyQuestionElements(slot);
        if (startBtn) {
            startBtn.addEventListener('click', () => handleStartButtonClick(slot));
        }
        // ملحوظة: مفيش ربط لأحداث كروت الاختيارات هنا زي الإصدار القديم،
        // لأن الكروت بقت تتبني ديناميكياً من renderQuestionForSlot() قبل
        // كل جولة، وبيتم ربط الحدث لكل كارت اختيار وقت إنشائه
    });

    const { warningModal, warningCancelBtn, warningConfirmBtn } = getWarningModalElements();
    if (warningCancelBtn) {
        warningCancelBtn.addEventListener('click', closeDqWarningModal);
    }
    if (warningConfirmBtn) {
        warningConfirmBtn.addEventListener('click', handleWarningConfirmClick);
    }
    if (warningModal) {
        // الضغط على الخلفية المعتمة بس (مش على أي عنصر جواها) بيقفل
        // المودال - نفس نمط باقي مودالات التأكيد في التطبيق
        warningModal.addEventListener('click', (event) => {
            if (event.target === warningModal) closeDqWarningModal();
        });
    }

    if (!visibilityListenerBound) {
        visibilityListenerBound = true;
        document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // مزامنة أي نتائج معلقة عند عودة اتصال الإنترنت
    window.addEventListener('online', flushPendingDqSync);

    // تقييم أولي لتذكير السؤال اليومي بناءً على الكاش المحلي
    evaluateAndScheduleDailyQuestionReminder({
        areAllQuestionsDone: areTodaysQuestionsCompleted(),
    });

    // معرفة هوية المستخدم بنفس فلسفة js/notifications.js (الاستماع
    // لحدث 'auth:login' بدل استيراد getCurrentUser مباشرة) - وبمجرد ما
    // نعرف المستخدم، نراجع Supabase (مصدر الحقيقة) للتأكد إن حالة
    // الكارتين المحلية (لو موجودة) مش ناقصة حاجة (مثلاً: جهاز جديد)
    document.addEventListener('auth:login', (event) => {
        currentUserId = event.detail?.user?.id || null;
        // (إصلاح) لازم نعيد رسم الكارتين فورًا بكاش الحساب الجديد (اللي
        // غالبًا فاضي لحساب لسه ما جاوبش) قبل ما نستنى رد الشبكة - وإلا
        // هيفضل شكل الحساب اللي فات (اللي كان مسجّل خروج منه) ظاهر على
        // الشاشة لحظياً. بعد كده reconcileTodayStatusFromSupabase بتجيب
        // نتيجة الحساب الجديد الحقيقية لو فعلاً جاوب قبل كده من جهاز تاني
        applyLockedUIForAllSlots();
        evaluateAndScheduleDailyQuestionReminder({
            areAllQuestionsDone: areTodaysQuestionsCompleted(),
        });
        reconcileTodayStatusFromSupabase();
        flushPendingDqSync();
    });
    document.addEventListener('auth:signed-out', () => {
        currentUserId = null;
        // (إصلاح) رجّع الكارتين لحالة الضيف الافتراضية فورًا كمان
        applyLockedUIForAllSlots();
    });
}