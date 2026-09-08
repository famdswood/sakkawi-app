/* ==================================================================
   سِكّاوي | js/network-status.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: اكتشاف رجوع النت بعد انقطاعه، وإطلاق
   حدث مخصص 'app:online' على document عشان أي ملف تاني في التطبيق
   يقدر يستمع له لو محتاج يعمل حاجة إضافية لحظة رجوع الاتصال (مثلاً
   Sync فوري بدل ما يستنى المستخدم يعمل أي حركة يدوية).

   ملحوظة: مش شرط أي ملف يستمع للحدث ده عشان الـ Offline Cache
   (fetchWithCache في js/offline-cache.js) يشتغل - كل شاشة أصلاً
   بتعمل Sync لوحدها كل ما المستخدم يفتحها/يرجعلها. الحدث ده تحسين
   إضافي اختياري بس (مثال: تحديث فوري للشاشة المفتوحة حالياً من غير
   ما تستنى المستخدم يبدّل تبويب).
   ================================================================== */

/**
 * @returns {boolean} true لو المتصفح/الجهاز شايف إنه متصل بالنت دلوقتي.
 *          ملحوظة: navigator.onLine بتعتمد على وجود اتصال شبكة عام
 *          (Wifi/Data شغالة)، مش بالضرورة إن Supabase نفسه متاح -
 *          يعني ممكن ترجع true وبرضه طلب Supabase يفشل (مثلاً السيرفر
 *          نفسه واقع)، وده متوقع وطبيعي.
 */
export function isOnline() {
    return navigator.onLine;
}

/** true بعد أول نداء لـ initNetworkStatusWatcher، عشان منربطش أكتر من
 *  Listener لو الدالة اتنادت أكتر من مرة بالغلط */
let isWatcherInitialized = false;

/**
 * تربط مستمع 'online' الخام بتاع المتصفح، وتطلق حدث 'app:online' على
 * document كل ما النت يرجع بعد ما كان مقطوع.
 * تُستدعى مرة واحدة بس من initApp() في js/app.js.
 */
export function initNetworkStatusWatcher() {
    if (isWatcherInitialized) return;
    isWatcherInitialized = true;

    window.addEventListener('online', () => {
        document.dispatchEvent(new CustomEvent('app:online'));
    });
}
