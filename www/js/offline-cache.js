/* ==================================================================
   سِكّاوي | js/offline-cache.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: طبقة تخزين مؤقت عامة (Offline Cache)
   فوق IndexedDB، تستخدمها أي شاشة في التطبيق محتاجة "تعرض آخر نسخة
   محفوظة من الداتا فوراً وقت الفتح، وتحدّثها في الخلفية لو النت شغال".

   ليه IndexedDB مش localStorage؟ لأن التطبيق شغال جوه Capacitor
   WebView، وبعض الشاشات (منشورات/ستوريز) ممكن تكبر وتتعدى حد
   الـ localStorage (~5MB) بسهولة. IndexedDB مالوش الحد ده عملياً.

   النمط المستخدم: Stale-While-Revalidate
     1) اعرض القيمة المخزّنة فوراً (لو موجودة).
     2) ابعت الطلب الحقيقي لـ Supabase بالتوازي (مش بالتتابع).
     3) لو نجح: حدّث الشاشة + احفظ النسخة الجديدة في الكاش.
     4) لو فشل (مفيش نت): سيب الداتا المعروضة زي ما هي، من غير أي
        رسالة خطأ مزعجة للمستخدم - هو أصلاً شايف آخر نسخة صحيحة.

   ملاحظة مهمة: أي فشل في IndexedDB نفسه (متصفح قديم، Private Mode في
   بعض الحالات..) بيتبلع بهدوء (console.warn) والتطبيق بيكمّل عادي من
   غير كاش، مش بيقف أو يرمي خطأ يوقف باقي الشاشة.
   ================================================================== */

const DB_NAME = 'sekkawy-offline-cache';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

/** الاتصال المفتوح بقاعدة البيانات (Promise واحدة تتشارك بين كل
 *  الاستدعاءات، عشان منفتحش اتصال جديد كل مرة) */
let dbPromise = null;

/**
 * تفتح (أو تنشئ لأول مرة) قاعدة بيانات IndexedDB الخاصة بالكاش.
 * بترجع نفس الـ Promise لو اتنادت أكتر من مرة (Singleton) بدل ما تفتح
 * اتصال جديد كل مرة حد يستخدم الكاش.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB مش متاح في المتصفح/الجهاز ده'));
            return;
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // الـ key هو الـ string بتاع "cached_..." نفسه، مفيش
                // داعي لـ keyPath منفصل - الـ value هي القيمة كاملة
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    // لو فتح القاعدة فشل، منسيبش dbPromise متعلّقة بخطأ قديم لأي محاولة
    // تانية بعدين - نفضّي المتغير عشان أي نداء لاحق يحاول يفتح من جديد
    dbPromise.catch(() => {
        dbPromise = null;
    });

    return dbPromise;
}

/**
 * تجيب قيمة محفوظة من الكاش.
 * @param {string} key - مفتاح الكاش، مثلاً 'cached_leaderboard:today'
 * @returns {Promise<any|null>} القيمة المخزّنة، أو null لو مش موجودة
 *          أو لو حصل أي خطأ (بدون ما يوقف باقي التطبيق)
 */
export async function getCached(key) {
    try {
        const db = await openDatabase();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);

            request.onsuccess = () => {
                const record = request.result;
                resolve(record ? record.data : null);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn(`[offline-cache.js] فشل قراءة الكاش (${key}):`, err.message || err);
        return null;
    }
}

/**
 * تحفظ قيمة في الكاش (بتستبدل القديمة لو موجودة بنفس المفتاح).
 * @param {string} key
 * @param {any} data - أي قيمة قابلة للـ structured clone (Array/Object/رقم..)
 * @returns {Promise<void>}
 */
export async function setCached(key, data) {
    try {
        const db = await openDatabase();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put({ data, savedAt: Date.now() }, key);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        // فشل الحفظ مش مشكلة كبيرة - الشاشة هتشتغل عادي بس من غير
        // كاش للمرة الجاية، مش داعي نعطّل حاجة تانية بسببه
        console.warn(`[offline-cache.js] فشل حفظ الكاش (${key}):`, err.message || err);
    }
}

/**
 * تمسح قيمة معينة من الكاش (مفيدة مثلاً وقت تسجيل الخروج، عشان بيانات
 * مستخدم قديم متفضلش متخزنة لو حد تاني يستخدم نفس الجهاز بمفتاح غير
 * متوقع - رغم إن أغلب مفاتيحنا أصلاً فيها userId فمعزولة عن بعض).
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function clearCached(key) {
    try {
        const db = await openDatabase();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(`[offline-cache.js] فشل مسح الكاش (${key}):`, err.message || err);
    }
}

/**
 * الدالة الرئيسية اللي كل ملفات التطبيق هتستخدمها بدل النداء المباشر
 * لـ Supabase - بتنفذ نمط Stale-While-Revalidate بالكامل:
 *   1) تجيب القيمة المخزّنة (لو موجودة) وتناديلك onData بيها فوراً
 *      بعلامة 'cache'.
 *   2) بالتوازي (مش بعد كده)، تنفّذ fetchFn() الحقيقية.
 *   3) لو نجحت ورجّعت نتيجة (مش undefined/null): تحفظها في الكاش
 *      وتناديلك onData بيها تاني بعلامة 'network'.
 *   4) لو فشلت (رمت استثناء، أو fetchFn نفسها رجّعت null/undefined
 *      كإشارة فشل - حسب المتعارف عليه في باقي دوال الجلب في المشروع):
 *      متعملش أي حاجة تانية - الداتا المخزّنة (لو اتعرضت في خطوة 1)
 *      تفضل زي ما هي على الشاشة من غير أي رسالة خطأ.
 *
 * ملحوظة: الدالة دي بترجع بعد ما الاتنين (كاش + شبكة) يخلصوا، فلو
 * الكود اللي بينادّيها محتاج يعمل حاجة "بعد ما كل حاجة تخلص خالص"
 * (زي إخفاء Skeleton مثلاً) يقدر يعمله بعد الـ await العادي - مش
 * لازم يستنى جوه onData نفسها.
 *
 * @param {string} key - مفتاح الكاش
 * @param {() => Promise<any>} fetchFn - دالة async بترجع الداتا
 *        الحقيقية من Supabase (بنفس المنطق الموجود حالياً في دوال
 *        الجلب - لو فيها try/catch داخلي وبترجع [] أو null عند الفشل،
 *        فـ fetchWithCache هتتعامل مع القيمة دي كـ "مفيش جديد نعرضه"،
 *        مش كـ "امسح المعروض الحالي")
 * @param {(data: any, source: 'cache'|'network') => void} onData
 * @returns {Promise<void>}
 */
export async function fetchWithCache(key, fetchFn, onData) {
    // 1) الكاش أولاً - فوري، من غير استنى أي حاجة
    const cachedValue = await getCached(key);
    if (cachedValue !== null && cachedValue !== undefined) {
        onData(cachedValue, 'cache');
    }

    // 2) الشبكة بالتوازي - مش بعد الكاش بالتتابع (الـ await فوق كان
    // لازم يخلص الأول عشان نعرف نعرض الكاش قبل الشبكة، لكن هو نفسه
    // سريع جداً محلياً؛ الطلب الحقيقي البطيء هو ده اللي جاي دلوقتي)
    let freshValue;
    try {
        freshValue = await fetchFn();
    } catch (err) {
        console.warn(`[offline-cache.js] فشل جلب الداتا الحقيقية (${key}):`, err.message || err);
        return;
    }

    // لو fetchFn رجّعت null/undefined (فشل من غير استثناء - نفس أسلوب
    // باقي دوال الجلب في المشروع اللي بترجع [] أو null عند الخطأ)،
    // منمسحش الكاش المعروض ومنعملش أي حاجة تانية
    const isEmptyFailure = freshValue === null || freshValue === undefined;
    if (isEmptyFailure) return;

    await setCached(key, freshValue);
    onData(freshValue, 'network');
}
