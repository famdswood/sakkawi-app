/* ==================================================================
   سِكّاوي (بطل البلد) | js/geofence.js
   ------------------------------------------------------------------
   المرحلة الثانية (الجزء الأول): جلب إعدادات النطاق من Supabase
   + دوال تحديد موقع المستخدم (Geolocation) + حساب المسافة (Haversine)

   نطاق التطبيق: قرية نزلة عبيد - شرق النيل - مركز المنيا
   ================================================================== */

import { supabaseClient } from './supabase-config.js';


/* ==================================================================
   1) إعدادات ثابتة احتياطية (Fallback) + إدارة الـ Cache المحلي
   ------------------------------------------------------------------
   دي مش القيم الوحيدة اللي هنعتمد عليها؛ القيم الحقيقية بتتجاب من
   جدول app_settings في Supabase. لكن لو حصل أي خطأ في الاتصال بالشبكة
   (مثلاً أول مرة يفتح فيها المستخدم التطبيق وهو أوفلاين)، بنستخدم
   القيم دي كخط دفاع أخير عشان التطبيق ميقعش بالكامل.
   ================================================================== */

const FALLBACK_ZONE_SETTINGS = {
    centerLatitude: 28.1054,
    centerLongitude: 30.7492,
    radiusMeters: 3500,
};

// اسم المفتاح المستخدم لتخزين إعدادات النطاق في LocalStorage
const GEOFENCE_SETTINGS_CACHE_KEY = 'sekkawy_geofence_settings_cache';

// المدة الزمنية (بالميلي ثانية) اللي بنعتبر بعدها الـ Cache المحلي "قديم"
// ونحتاج نجيب نسخة جديدة من Supabase. هنا 15 دقيقة.
const GEOFENCE_SETTINGS_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

// متغير في الذاكرة (In-Memory) بيحتفظ بآخر إعدادات نطاق تم جلبها بنجاح
// خلال الجلسة الحالية، عشان نتجنب حتى القراءة من LocalStorage كل مرة.
let cachedZoneSettingsInMemory = null;


/**
 * قراءة إعدادات النطاق المخزّنة محليًا في LocalStorage، إن وُجدت وكانت
 * لسه صالحة (لم تنتهِ صلاحيتها بعد حسب GEOFENCE_SETTINGS_CACHE_MAX_AGE_MS).
 *
 * @returns {{centerLatitude: number, centerLongitude: number, radiusMeters: number} | null}
 */
function readGeofenceSettingsFromLocalCache() {
    try {
        const rawCachedValue = window.localStorage.getItem(GEOFENCE_SETTINGS_CACHE_KEY);

        if (!rawCachedValue) {
            return null;
        }

        const parsedCache = JSON.parse(rawCachedValue);

        const cacheAgeInMilliseconds = Date.now() - parsedCache.cachedAtTimestamp;

        if (cacheAgeInMilliseconds > GEOFENCE_SETTINGS_CACHE_MAX_AGE_MS) {
            // الكاش قديم، نتجاهله ونرجع null عشان نجبر جلب نسخة جديدة
            return null;
        }

        return parsedCache.zoneSettings;
    } catch (error) {
        // لو حصل أي خطأ في القراءة أو الـ parsing (بيانات تالفة مثلاً)،
        // نتعامل معاها بأمان ونرجع null بدل ما نكسر التطبيق
        console.warn('تعذّرت قراءة إعدادات النطاق من التخزين المحلي:', error.message);
        return null;
    }
}


/**
 * حفظ إعدادات النطاق الحالية في LocalStorage مع ختم زمني (Timestamp)
 * عشان نقدر نحدد لاحقًا هل الكاش لسه صالح ولا محتاج تحديث.
 *
 * @param {{centerLatitude: number, centerLongitude: number, radiusMeters: number}} zoneSettings
 */
function writeGeofenceSettingsToLocalCache(zoneSettings) {
    try {
        const cachePayload = {
            zoneSettings,
            cachedAtTimestamp: Date.now(),
        };

        window.localStorage.setItem(GEOFENCE_SETTINGS_CACHE_KEY, JSON.stringify(cachePayload));
    } catch (error) {
        // لو الـ LocalStorage مش متاح (مثلاً وضع تصفح خاص Private Mode)،
        // نتجاهل الخطأ بهدوء لأن الكاش تحسين أداء مش شرط أساسي للعمل
        console.warn('تعذّر حفظ إعدادات النطاق في التخزين المحلي:', error.message);
    }
}


/* ==================================================================
   2) دالة جلب إعدادات النطاق من Supabase: fetchGeofenceSettings
   ------------------------------------------------------------------
   بترجع دايمًا كائن (Object) بنفس الشكل الموحّد:
   { centerLatitude, centerLongitude, radiusMeters }
   بغض النظر عن مصدر البيانات (Supabase، الكاش المحلي، أو القيم الاحتياطية)،
   عشان باقي الكود في الملف ميحتاجش يعرف تفاصيل المصدر.
   ================================================================== */

/**
 * جلب إعدادات النطاق الجغرافي (مركز نزلة عبيد ونصف القطر المسموح بيه)
 * من جدول public.app_settings في Supabase.
 *
 * الأولوية في القراءة:
 *   1) الذاكرة المؤقتة الحالية (In-Memory) لو موجودة — الأسرع.
 *   2) التخزين المحلي (LocalStorage) لو موجود ولسه صالح.
 *   3) طلب فعلي من Supabase (وبعدها تخزين النتيجة في الكاش بمستوييه).
 *   4) في حالة فشل كل ما سبق: القيم الاحتياطية FALLBACK_ZONE_SETTINGS.
 *
 * @param {{forceRefresh?: boolean}} options
 *        forceRefresh: لو true، بيتخطى كل مستويات الكاش ويجيب نسخة
 *        جديدة من Supabase مباشرة (مفيد مثلاً لو الأدمن غيّر النطاق
 *        وعايزين نضمن إن المستخدم ياخد آخر تحديث).
 *
 * @returns {Promise<{centerLatitude: number, centerLongitude: number, radiusMeters: number}>}
 */
export async function fetchGeofenceSettings(options = {}) {
    const { forceRefresh = false } = options;

    // (1) لو مش مطلوب تحديث إجباري، وعندنا نسخة في الذاكرة، استخدمها فورًا
    if (!forceRefresh && cachedZoneSettingsInMemory !== null) {
        return cachedZoneSettingsInMemory;
    }

    // (2) لو مش مطلوب تحديث إجباري، جرّب الكاش المحلي في LocalStorage
    if (!forceRefresh) {
        const locallyCachedSettings = readGeofenceSettingsFromLocalCache();

        if (locallyCachedSettings !== null) {
            cachedZoneSettingsInMemory = locallyCachedSettings;
            return locallyCachedSettings;
        }
    }

    // (3) لم يوجد كاش صالح (أو تم طلب تحديث إجباري)، نجيب البيانات فعليًا من Supabase
    try {
        const { data, error } = await supabaseClient
            .from('app_settings')
            .select('geofence_center_lat, geofence_center_lng, geofence_radius_meters')
            .eq('id', 1)
            .single();

        if (error) {
            throw error;
        }

        if (!data) {
            throw new Error('لم يتم العثور على صف الإعدادات (id = 1) في جدول app_settings');
        }

        const freshZoneSettings = {
            centerLatitude: Number(data.geofence_center_lat),
            centerLongitude: Number(data.geofence_center_lng),
            radiusMeters: Number(data.geofence_radius_meters),
        };

        // تحديث الكاش بمستوييه (الذاكرة + LocalStorage) بالقيم الجديدة
        cachedZoneSettingsInMemory = freshZoneSettings;
        writeGeofenceSettingsToLocalCache(freshZoneSettings);

        return freshZoneSettings;
    } catch (error) {
        console.warn(
            'تعذّر جلب إعدادات النطاق الجغرافي من Supabase، سيتم استخدام القيم الاحتياطية:',
            error.message
        );

        // (4) فشل كل شيء آخر: نرجع القيم الاحتياطية الثابتة
        // (بدون تخزينها في الكاش، عشان أول اتصال ناجح لاحقًا يحل محلها فورًا)
        return { ...FALLBACK_ZONE_SETTINGS };
    }
}


/**
 * إفراغ الكاش المحلي لإعدادات النطاق (في الذاكرة و LocalStorage معًا).
 * مفيدة مثلاً عند تسجيل الخروج، أو لو عايزين نجبر التطبيق يعيد الجلب
 * من Supabase في المرة الجاية بدل الاعتماد على بيانات قديمة.
 */
export function clearGeofenceSettingsCache() {
    cachedZoneSettingsInMemory = null;

    try {
        window.localStorage.removeItem(GEOFENCE_SETTINGS_CACHE_KEY);
    } catch (error) {
        console.warn('تعذّر إفراغ التخزين المحلي لإعدادات النطاق:', error.message);
    }
}


/* ==================================================================
   3) دالة جلب إحداثيات المستخدم: getUserCoordinates
   ------------------------------------------------------------------
   واجهة Promise حديثة فوق navigator.geolocation.getCurrentPosition،
   مع معالجة تفصيلية لكل نوع من أنواع الأخطاء المحتملة، ورسائل عربية
   واضحة للمستخدم توضح له بالظبط هيعمل إيه عشان يظبط المشكلة.
   ================================================================== */

/**
 * أكواد أخطاء الـ Geolocation API القياسية، مع رسالة عربية واضحة لكل كود.
 * (المرجع: GeolocationPositionError.PERMISSION_DENIED = 1,
 *           GeolocationPositionError.POSITION_UNAVAILABLE = 2,
 *           GeolocationPositionError.TIMEOUT = 3)
 */
const GEOLOCATION_ERROR_MESSAGES = {
    1: 'تم رفض إذن الوصول للموقع الجغرافي. من فضلك افتح إعدادات المتصفح أو الهاتف، وفعّل صلاحية الموقع (GPS) لهذا الموقع حتى نتمكن من التحقق من تواجدك داخل نزلة عبيد.',
    2: 'تعذّر تحديد موقعك الجغرافي حاليًا. تأكد من تفعيل خدمة الـ GPS في هاتفك، وأنك في مكان مفتوح بعيد عن الأسقف أو المباني الكثيفة، ثم حاول مرة أخرى.',
    3: 'استغرق تحديد موقعك وقتًا أطول من المتوقع (انتهت المهلة). تأكد من تفعيل الـ GPS وقوة الإشارة، ثم حاول مرة أخرى.',
    UNSUPPORTED: 'متصفحك أو جهازك لا يدعم خاصية تحديد الموقع الجغرافي (Geolocation)، لذلك لا يمكن التحقق من تواجدك داخل نطاق نزلة عبيد.',
    UNKNOWN: 'حدث خطأ غير متوقع أثناء محاولة تحديد موقعك الجغرافي. من فضلك تأكد من تفعيل GPS وحاول مرة أخرى.',
};


/**
 * كائن خطأ مخصص يحمل رسالة عربية واضحة بالإضافة إلى كود الخطأ الأصلي،
 * عشان الكود اللي بيستخدم هذه الدالة يقدر يعرض الرسالة مباشرة للمستخدم.
 */
export class GeofenceLocationError extends Error {
    constructor(message, originalErrorCode) {
        super(message);
        this.name = 'GeofenceLocationError';
        this.originalErrorCode = originalErrorCode;
    }
}


/**
 * طلب إذن الوصول لموقع المستخدم الجغرافي، وجلب أحدث إحداثيات متاحة
 * بأعلى دقة ممكنة (enableHighAccuracy: true).
 *
 * @returns {Promise<{latitude: number, longitude: number, accuracyMeters: number}>}
 *          يرفض الـ Promise (reject) بكائن من نوع GeofenceLocationError
 *          يحتوي رسالة عربية جاهزة للعرض مباشرة للمستخدم.
 */
export function getUserCoordinates() {
    return new Promise((resolve, reject) => {
        // (1) التأكد أولًا إن المتصفح أصلًا بيدعم خاصية تحديد الموقع
        if (!('geolocation' in navigator)) {
            reject(new GeofenceLocationError(GEOLOCATION_ERROR_MESSAGES.UNSUPPORTED, 'UNSUPPORTED'));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            // معالج النجاح
            (position) => {
                resolve({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracyMeters: position.coords.accuracy,
                });
            },

            // معالج الخطأ
            (positionError) => {
                const arabicMessage =
                    GEOLOCATION_ERROR_MESSAGES[positionError.code] || GEOLOCATION_ERROR_MESSAGES.UNKNOWN;

                console.warn(
                    `فشل تحديد الموقع الجغرافي (كود ${positionError.code}):`,
                    positionError.message
                );

                reject(new GeofenceLocationError(arabicMessage, positionError.code));
            },

            // إعدادات الطلب: أعلى دقة ممكنة، مع مهلة معقولة ومنع استخدام
            // موقع قديم مخزّن في المتصفح لمدة طويلة (maximumAge: 0 يجبر
            // المتصفح يجيب قراءة جديدة بدل ما يرجّع آخر قراءة مخزّنة).
            {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 0,
            }
        );
    });
}


/* ==================================================================
   4) دالة حساب المسافة: calculateDistanceMeters (صيغة Haversine)
   ------------------------------------------------------------------
   تحسب المسافة التقريبية بالمتر بين نقطتين على سطح الكرة الأرضية،
   بالأخذ في الاعتبار انحناء الأرض (أدق من الحساب الإقليدي المباشر).
   ================================================================== */

/**
 * تحويل زاوية من الدرجات إلى الراديان (وحدة القياس المطلوبة لدوال
 * Math.sin و Math.cos في جافاسكريبت).
 *
 * @param {number} degrees
 * @returns {number}
 */
function convertDegreesToRadians(degrees) {
    return (degrees * Math.PI) / 180;
}


/**
 * حساب المسافة بالمتر بين نقطتين جغرافيتين (خط عرض/خط طول) باستخدام
 * صيغة Haversine.
 *
 * @param {number} latitude1  خط عرض النقطة الأولى (موقع المستخدم مثلًا)
 * @param {number} longitude1 خط طول النقطة الأولى
 * @param {number} latitude2  خط عرض النقطة الثانية (مركز النطاق مثلًا)
 * @param {number} longitude2 خط طول النقطة الثانية
 * @returns {number} المسافة بالمتر
 */
export function calculateDistanceMeters(latitude1, longitude1, latitude2, longitude2) {
    const EARTH_RADIUS_METERS = 6371000;

    const deltaLatitudeRadians = convertDegreesToRadians(latitude2 - latitude1);
    const deltaLongitudeRadians = convertDegreesToRadians(longitude2 - longitude1);

    const latitude1Radians = convertDegreesToRadians(latitude1);
    const latitude2Radians = convertDegreesToRadians(latitude2);

    const haversineComponentA =
        Math.sin(deltaLatitudeRadians / 2) * Math.sin(deltaLatitudeRadians / 2) +
        Math.cos(latitude1Radians) * Math.cos(latitude2Radians) *
        Math.sin(deltaLongitudeRadians / 2) * Math.sin(deltaLongitudeRadians / 2);

    const haversineComponentC =
        2 * Math.atan2(Math.sqrt(haversineComponentA), Math.sqrt(1 - haversineComponentA));

    return EARTH_RADIUS_METERS * haversineComponentC;
}


/* ==================================================================
   5) إدارة حالة النطاق المؤقتة (Geofencing Status Cache)
   ------------------------------------------------------------------
   بنفصّل هنا بين نوعين من الكاش:
     - كاش "إعدادات النطاق" (اتعامل معاه في الجزء الأول: مركز نزلة
       عبيد ونصف القطر) وهو بيتغيّر نادرًا (بس لو الأدمن عدّله).
     - كاش "حالة المستخدم نفسه" (جوه/بره، مسموح له ولا لأ) وهو اللي
       بنتعامل معاه هنا، وطبيعي إنه يتغيّر أكتر (المستخدم بيتحرك).

   الهدف: منع استدعاء الـ Stored Procedure في Supabase (اللي بيعمل
   قراءة وكتابة في قاعدة البيانات) مع كل حركة بسيطة للمستخدم، والاكتفاء
   بنتيجة آخر فحص طالما هي لسه "طازة" حسب GEOFENCE_STATUS_CACHE_MAX_AGE_MS.
   ================================================================== */

// اسم المفتاح المستخدم لتخزين آخر حالة نطاق معروفة في LocalStorage
const GEOFENCE_STATUS_CACHE_KEY = 'sekkawy_geofence_status_cache';

// المدة الزمنية (بالميلي ثانية) اللي بنعتبر بعدها حالة النطاق المخزنة
// "قديمة" ومحتاجة فحص جديد فعلي. هنا دقيقتين، لأن حالة الموقع بتتغيّر
// بسرعة أكبر بكتير من إعدادات النطاق نفسها.
const GEOFENCE_STATUS_CACHE_MAX_AGE_MS = 2 * 60 * 1000;

// متغير في الذاكرة بيحتفظ بآخر حالة نطاق تم التحقق منها فعليًا
// خلال الجلسة الحالية (أسرع من القراءة من LocalStorage في كل مرة).
let cachedGeofenceStatusInMemory = null;


/**
 * قراءة آخر حالة نطاق مخزّنة في LocalStorage، بشرط إنها تخص نفس
 * المستخدم (userId) المطلوب حاليًا، ولسه صالحة حسب الختم الزمني.
 *
 * @param {string} userId
 * @returns {object | null}
 */
function readGeofenceStatusFromLocalCache(userId) {
    try {
        const rawCachedValue = window.localStorage.getItem(GEOFENCE_STATUS_CACHE_KEY);

        if (!rawCachedValue) {
            return null;
        }

        const parsedCache = JSON.parse(rawCachedValue);

        // لازم نتأكد إن الكاش المخزن يخص نفس المستخدم الحالي، لأن الجهاز
        // ممكن يتستخدم من أكتر من حساب (تسجيل خروج ودخول بحساب تاني مثلًا)
        if (parsedCache.userId !== userId) {
            return null;
        }

        const cacheAgeInMilliseconds = Date.now() - parsedCache.cachedAtTimestamp;

        if (cacheAgeInMilliseconds > GEOFENCE_STATUS_CACHE_MAX_AGE_MS) {
            return null;
        }

        return parsedCache.geofenceStatus;
    } catch (error) {
        console.warn('تعذّرت قراءة حالة النطاق من التخزين المحلي:', error.message);
        return null;
    }
}


/**
 * حفظ حالة النطاق الحالية للمستخدم في LocalStorage مع ختم زمني،
 * عشان نقدر نحدد لاحقًا هل الكاش لسه صالح أم محتاج فحص جديد.
 *
 * @param {string} userId
 * @param {object} geofenceStatus
 */
function writeGeofenceStatusToLocalCache(userId, geofenceStatus) {
    try {
        const cachePayload = {
            userId,
            geofenceStatus,
            cachedAtTimestamp: Date.now(),
        };

        window.localStorage.setItem(GEOFENCE_STATUS_CACHE_KEY, JSON.stringify(cachePayload));
    } catch (error) {
        console.warn('تعذّر حفظ حالة النطاق في التخزين المحلي:', error.message);
    }
}


/**
 * إرجاع آخر حالة نطاق معروفة للمستخدم الحالي بسرعة، بدون انتظار أي
 * طلب شبكة جديد. بترجع null لو مفيش حالة مخزنة صالحة بعد (يعني لسه
 * محتاجين نستدعي verifyUserLocation مرة على الأقل).
 *
 * مفيدة مثلًا لعرض حالة أولية فورية في الواجهة (مثل شارة "داخل النطاق")
 * وقت تحميل الصفحة، قبل ما نستنى نتيجة فحص GPS جديد قد ياخد وقت.
 *
 * @param {string} userId
 * @returns {object | null}
 */
export function getCachedGeofenceStatus(userId) {
    // (1) الأولوية للذاكرة المؤقتة الحالية لو موجودة وتخص نفس المستخدم
    if (cachedGeofenceStatusInMemory !== null && cachedGeofenceStatusInMemory.userId === userId) {
        return cachedGeofenceStatusInMemory.geofenceStatus;
    }

    // (2) لو مفيش حاجة في الذاكرة، نجرب LocalStorage
    const locallyCachedStatus = readGeofenceStatusFromLocalCache(userId);

    if (locallyCachedStatus !== null) {
        // نحدّث الذاكرة المؤقتة كمان عشان القراءة الجاية تبقى أسرع
        cachedGeofenceStatusInMemory = { userId, geofenceStatus: locallyCachedStatus };
        return locallyCachedStatus;
    }

    return null;
}


/**
 * إفراغ الكاش المحلي لحالة النطاق (في الذاكرة و LocalStorage معًا).
 * لازم تتنادى عند تسجيل الخروج، عشان حالة نطاق مستخدم معين متفضلش
 * ظاهرة أو مؤثرة على مستخدم تاني هيسجل دخول على نفس الجهاز بعده.
 */
export function clearGeofenceStatusCache() {
    cachedGeofenceStatusInMemory = null;

    try {
        window.localStorage.removeItem(GEOFENCE_STATUS_CACHE_KEY);
    } catch (error) {
        console.warn('تعذّر إفراغ التخزين المحلي لحالة النطاق:', error.message);
    }
}


/* ==================================================================
   5ب) فحص الموقع *قبل* إنشاء حساب جديد (بدون userId)
   ------------------------------------------------------------------
   verifyUserLocation تحت محتاجة userId حقيقي موجود بالفعل في profiles
   (بتستدعي check_and_update_user_location وتكتب في الصف بتاعه). لكن
   وقت التسجيل نفسه لسه معندناش أي userId أصلاً - المستخدم بيقرر
   يعمل حساب من عدمه بناءً على نتيجة الفحص ده. فالدالة دي فحص "قراءة
   فقط" بالكامل: GPS + إعدادات النطاق من app_settings + حساب المسافة،
   من غير أي استدعاء لقاعدة البيانات بيكتب حاجة.

   ملحوظة مهمة: ده Gate أولي قبل التسجيل بس، مش بديل عن
   verifyUserLocation/check_and_update_user_location اللي المفروض
   لسه تتنفذ بعد نجاح التسجيل فعليًا (initGeofencingGuard في معالج
   'auth:login' الموجود بالفعل في app.js) عشان تسجّل الحالة الرسمية
   (is_inside_bounds) في بروفايل المستخدم على السيرفر.

   ملحوظة تانية: الفحص ده مش بيعرف حاجة عن is_verified_override (لأنه
   خاص بصف profile موجود بالفعل) - فمستخدم حقيقي من نزلة عبيد بس
   مسافر وقت ما بيعمل حسابه لأول مرة هيتمنع هنا. ده Trade-off مقبول
   (حالة نادرة)، وينفع نوجّهه لزرار "تواصل مع الدعم" بدل ما نمنعه
   نهائيًا من غير أي طريق بديل.
   ================================================================== */

/**
 * فحص موقع المستخدم الجغرافي مقابل حدود نزلة عبيد *قبل* إنشاء حساب،
 * من غير أي userId ومن غير أي كتابة في قاعدة البيانات.
 *
 * @returns {Promise<{isInsideBounds: boolean, distanceMeters: number}>}
 * @throws {GeofenceLocationError} لو فشل تحديد موقع المستخدم
 */
export async function checkLocationForSignup() {
    const userCoordinates = await getUserCoordinates();
    const zoneSettings = await fetchGeofenceSettings();

    const distanceMeters = Math.round(
        calculateDistanceMeters(
            userCoordinates.latitude,
            userCoordinates.longitude,
            zoneSettings.centerLatitude,
            zoneSettings.centerLongitude
        )
    );

    return {
        isInsideBounds: distanceMeters <= zoneSettings.radiusMeters,
        distanceMeters,
    };
}


/* ==================================================================
   6) دالة الفحص الرئيسية: verifyUserLocation
   ------------------------------------------------------------------
   بتربط كل حاجة ببعض:
     1) تجيب إحداثيات المستخدم الحالية عن طريق getUserCoordinates().
     2) تستدعي الدالة المخزّنة check_and_update_user_location في
        Supabase (اللي بدورها بتقرأ إعدادات النطاق ديناميكيًا من
        app_settings، وتحسب Haversine على السيرفر، وتحدّث بروفايل
        المستخدم، وترجع قرار السماح النهائي).
     3) تحسب المسافة أيضًا على الفرونت إند (باستخدام calculateDistanceMeters
        وإعدادات النطاق من fetchGeofenceSettings) عشان تقدر تعرض
        "المسافة بالمتر" في الواجهة، لأن الـ RPC نفسه بيرجع Boolean بس
        ومش بيرجع المسافة الفعلية.
     4) تبني كائن "حالة النطاق" الموحّد وتخزّنه في الكاش (ذاكرة + محلي).
   ================================================================== */

/**
 * التحقق من موقع المستخدم الجغرافي مقابل حدود نزلة عبيد، عن طريق
 * الجمع بين قراءة GPS من المتصفح واستدعاء الدالة المخزّنة في Supabase.
 *
 * @param {string} userId معرّف المستخدم (UUID) في جدول profiles
 * @param {{useCache?: boolean}} options
 *        useCache: لو true (الافتراضي)، وفيه حالة نطاق مخزّنة لسه
 *        صالحة لنفس المستخدم، بترجعها فورًا بدون أي طلب شبكة جديد.
 *        لو false، بتتجاهل الكاش وتعمل فحص فعلي جديد دايمًا (مفيدة
 *        مثلًا لما المستخدم يضغط زر "تحقق من موقعي يدويًا").
 *
 * @returns {Promise<{
 *   isInsideBounds: boolean,
 *   isVerifiedOverride: boolean,
 *   isAllowed: boolean,
 *   distanceMeters: number | null,
 *   checkedAt: number
 * }>}
 *
 * @throws {GeofenceLocationError} لو فشل تحديد موقع المستخدم (رفض إذن،
 *         GPS غير متاح، Timeout، أو متصفح غير داعم).
 * @throws {Error} لو فشل الاتصال بـ Supabase أو استدعاء الدالة المخزّنة.
 */
export async function verifyUserLocation(userId, options = {}) {
    const { useCache = true } = options;

    if (!userId) {
        throw new Error('لا يمكن التحقق من الموقع الجغرافي بدون معرّف مستخدم صالح (userId)');
    }

    // (1) لو مسموح باستخدام الكاش، وفيه نتيجة صالحة مخزّنة، نرجعها فورًا
    if (useCache) {
        const cachedStatus = getCachedGeofenceStatus(userId);

        if (cachedStatus !== null) {
            return cachedStatus;
        }
    }

    // (2) جلب إحداثيات المستخدم الحالية عن طريق الـ GPS
    // ملاحظة: لو فشلت هذه الخطوة، الخطأ (GeofenceLocationError) بيتصعّد
    // تلقائيًا لمين ما استدعى verifyUserLocation، وهو المسؤول عن عرضه
    // للمستخدم برسالته العربية الجاهزة.
    const userCoordinates = await getUserCoordinates();

    // (3) استدعاء الدالة المخزّنة check_and_update_user_location في Supabase
    // هذه الدالة هي "مصدر الحقيقة" الفعلي لقرار السماح، لأنها بتشتغل
    // بإعدادات النطاق الحالية من السيرفر مباشرة، وبتحدّث بروفايل
    // المستخدم (last_lat, last_lng, is_inside_bounds) بشكل موثوق
    // (SECURITY DEFINER) بغض النظر عن قيود RLS العادية.
    const { data: isAllowedFromServer, error: rpcError } = await supabaseClient.rpc(
        'check_and_update_user_location',
        {
            p_user_id: userId,
            p_lat: userCoordinates.latitude,
            p_lng: userCoordinates.longitude,
        }
    );

    if (rpcError) {
        throw new Error(`فشل التحقق من الموقع عبر قاعدة البيانات: ${rpcError.message}`);
    }

    // (4) جلب أحدث بيانات بروفايل المستخدم عشان نعرف تحديدًا:
    // هل هو جوه النطاق فعلًا (is_inside_bounds)، وهل عنده استثناء يدوي
    // (is_verified_override)؟ لأن الـ RPC بيرجع Boolean واحد بس بيمثل
    // "isAllowed" (النتيجة النهائية)، مش تفاصيل السبب.
    const { data: profileRow, error: profileError } = await supabaseClient
        .from('profiles')
        .select('is_inside_bounds, is_verified_override')
        .eq('id', userId)
        .single();

    if (profileError) {
        throw new Error(`فشل جلب حالة البروفايل بعد التحقق من الموقع: ${profileError.message}`);
    }

    // (5) حساب المسافة بالمتر على الفرونت إند عشان نعرضها في الواجهة
    // (الـ RPC والبروفايل مبيرجعوش المسافة الفعلية، بس حالة جوه/بره)
    const zoneSettings = await fetchGeofenceSettings();

    const distanceMeters = Math.round(
        calculateDistanceMeters(
            userCoordinates.latitude,
            userCoordinates.longitude,
            zoneSettings.centerLatitude,
            zoneSettings.centerLongitude
        )
    );

    // (6) بناء كائن حالة النطاق الموحّد
    const geofenceStatus = {
        isInsideBounds: Boolean(profileRow.is_inside_bounds),
        isVerifiedOverride: Boolean(profileRow.is_verified_override),
        isAllowed: Boolean(isAllowedFromServer),
        distanceMeters,
        checkedAt: Date.now(),
    };

    // (7) تخزين النتيجة في الكاش بمستوييه (ذاكرة + محلي) عشان الفحوصات
    // الجاية القريبة تستفيد منها بدل ما تضغط على قاعدة البيانات
    cachedGeofenceStatusInMemory = { userId, geofenceStatus };
    writeGeofenceStatusToLocalCache(userId, geofenceStatus);

    return geofenceStatus;
}


/* ==================================================================
   7) محرك وضع الزائر: applyGuestModeRestrictions
   ------------------------------------------------------------------
   فلسفة التطبيق هنا مبنية على طبقتين متكاملتين، مش طبقة واحدة:

     الطبقة الأولى (المُلزمة فعليًا - Enforcement الحقيقي):
       تتم عبر قاعدة البيانات نفسها. أي محاولة لتسجيل خطوات أو نقاط
       المفروض تتحقق من is_inside_bounds / is_verified_override في
       جدول profiles على مستوى الـ RLS Policies أو الدوال المخزّنة
       على السيرفر (Supabase)، لأن أي قيد في الفرونت إند وحده (زي
       window.isGuestMode) ممكن يتلعب فيه من الـ Console بسهولة.

     الطبقة الثانية (تجربة المستخدم - UX Enforcement):
       وهي اللي بيعملها هذا الملف: تعطيل/إخفاء العناصر البصرية، ومنع
       استدعاء دوال الإرسال أصلًا من جهة الفرونت إند، عشان المستخدم
       العادي (مش اللي بيحاول يخترق النظام) ياخد تجربة واضحة ومفهومة
       بدل ما يضغط زرار ويكتشف بعدين إن حركته اتجاهلت بصمت.

   الآلية المستخدمة لتطبيق القيود بصريًا:
     - علم عام window.isGuestMode يقدر أي ملف تاني في التطبيق (app.js،
       daily-question.js، tournaments.js..إلخ) يتأكد منه قبل أي عملية
       حساسة (مثلًا أول سطر في handleStepsIncrease لازم يبقى:
       "if (window.isGuestMode) return;").
     - كلاس عام على body ('guest-mode-active') لأي تنسيق CSS عام
       (مثلًا تعتيم قسم البطولات بالكامل).
     - Attribute عام "data-requires-membership" على أي عنصر HTML
       (زرار انضمام لبطولة، زرار إرسال إجابة السؤال اليومي..إلخ)،
       وهذا الملف بيدور تلقائيًا على كل عنصر عليه الـ attribute ده
       ويعطّله/يوسمه بصريًا كمقفول، من غير ما نحتاج نعرف اسم كل زرار
       بعينه هنا في هذا الملف.
     - حدث عام 'geofence:guest-mode-change' بيتبعت على document عشان
       أي وحدة تانية تقدر تستجيب فورًا (تخفي قسم، توقف مؤقت..إلخ).
   ================================================================== */

// الـ Attribute الموحّد اللي بنحط عليه أي عنصر HTML عايزين نقفله
// تلقائيًا في وضع الزائر (زراير انضمام للبطولات، إرسال السؤال اليومي..إلخ)
const GUEST_LOCKED_ELEMENT_SELECTOR = '[data-requires-membership]';

// الكلاس البصري اللي بنضيفه للعناصر المقفولة، عشان ملف الـ CSS يقدر
// يحدد شكلها (تعتيم، منع تفاعل، أيقونة قفل..إلخ) بشكل مركزي وموحّد.
const GUEST_LOCKED_VISUAL_CLASS = 'guest-locked';

// (تعديل) previousIsGuestModeState اتشال بالكامل - كان غرضه الوحيد منع
// تكرار توست "أهلاً بيك! كل ميزات التطبيق متاحة لك بالكامل." اللي
// اتشال هو نفسه بناءً على طلب صريح (شوف تعليق applyGuestModeRestrictions
// تحت)، فمفيش أي قراءة تانية للمتغيّر ده في الملف كله.

/**
 * (إعادة تصميم كاملة - باج حقيقي جذري): الأسلوب اللي كان مستخدم قبل
 * كده (طبقة <div> شفافة فوق الزرار بـ position:fixed + z-index رقمي
 * ثابت + حلقة requestAnimationFrame بتحسب مكانها بالبكسل) كان أصلاً
 * مبني على افتراض غلط: إن مقارنة z-index بين عنصرين بيبقى دايمًا حسب
 * الرقم بس. الحقيقة إن أي عنصر مقفول موجود جوه حاوية عندها Stacking
 * Context خاصة بيها (زي مودال مشاهدة الاستوري #storyViewerModal اللي
 * فيه storyHeartBtn، أو مودال نشر الاستوري اللي فيه btnPublishStory -
 * كلاهما بـ z-index أعلى بكتير من الـ 30 بتاع الـ overlay)، فالمتصفح
 * بيقارن الـ Stacking Contexts كوحدة كاملة، مش نقطة بنقطة بصريًا -
 * يعني الزرار الحقيقي (المعطل) جوه المودال هو اللي بياخد اللمسة فعليًا
 * دايمًا، مهما كان الـ overlay متحاذي صح بصريًا فوقه. ده سبب أساسي في
 * إن "كل الأماكن اللي عليها قفل مبتجيبش أي رد فعل" فعليًا. وحتى
 * للعناصر اللي مش جوه مودال (زي dqStartBtn1)، الأسلوب فضل هش: معتمد
 * على حساب بالبكسل يعيد نفسه 60 مرة/ثانية وعلى توقيت الـ RAF بالظبط.
 *
 * الحل الجذري: نلغي فكرة "الطبقة الشفافة + z-index + حساب مكان بالبكسل"
 * خالص، ونستبدلها بمستمع واحد على document في مرحلة الـ **Capture**
 * (الباراميتر الثالث true - يعني بيشتغل وهو نازل للعنصر المستهدف، قبل
 * أي مستمع click عادي متسجل على الزرار نفسه في مرحلة الـ Bubble).
 * المستمع ده بيمسك أي كليك/لمسة على عنصر عليه كلاس guest-locked (أو
 * جواه)، يوقفه فورًا (preventDefault + stopPropagation)، ويطلع توست
 * توضيحي - وده بيشتغل صح 100% بغض النظر عن مكان العنصر بالبكسل، أو
 * لو هو جوه مودال بأي z-index كان، أو لو الصفحة عملت Scroll، لأنه مش
 * معتمد على أي حساب هندسي خالص - بس على ترتيب مرحلة الـ Capture في
 * DOM Event Flow، وده ثابت دايمًا بغض النظر عن الـ CSS.
 *
 * الأمان (منع Enter Key من إرسال فورم "تعديل البروفايل" بالخطأ):
 * بدل الاعتماد على element.disabled (اللي كان بيمنع الـ click خالص
 * وهو سبب المشكلة الأصلية من الأول)، بنضيف مستمع submit مماثل على
 * document بنفس فلسفة الـ Capture، بيمنع submit أي <form> فيه عنصر
 * guest-locked جواه - يغطي حالة Enter Key وحالة أي submit برمجي تاني
 * من غير ما نحتاج نعطّل الزرار نفسه أبدًا.
 */

/** نص التوست الموحّد اللي بيظهر لما الزائر يحاول يستخدم ميزة مقفولة */
const GUEST_LOCKED_TOAST_MESSAGE =
    'الميزة دي محتاجة حساب - سجّل حساب أو سجّل دخول عشان تقدر تستخدمها.';

// (إصلاح - باج "تكرار التوست"): لو الزائر داس على عنصر مقفول بسرعة
// كذا مرة ورا بعض، كان كل ضغطة بتولّد عنصر توست جديد بالكامل في
// showToast() (app.js) - فبتتكدّس فوق بعض وتملأ الشاشة، مع إن الرسالة
// نفسها بالظبط بتتكرر من غير أي فايدة إضافية للمستخدم. الحل: تبريد
// بسيط (Cooldown) هنا بس على التوست ده تحديدًا - لو فيه توست من النوع
// ده اتعرض من ثانيتين بس، نتجاهل أي محاولة عرض جديدة تمامًا بدل ما
// نبعت حدث 'app:toast' تاني ونضيف عنصر توست زيادة على اللي ظاهر أصلاً.
//
// (إصلاح تاني - باج "تكرار التوست" لسه موجود جزئيًا): الدالة دي كانت
// مش export، فـ posts.js كان مضطر يعمل نسخة طبق الأصل منها بنفس النص
// وبنفس مدة الكولداون، لكن بمتغيّر تبريد مستقل تمامًا
// (postsGuestLockedToastCooldownUntil) عن متغيّر الملف ده
// (guestLockedToastCooldownUntil). النتيجة: لو الزائر ضغط لايك على
// بوست (يفعّل تبريد posts.js) وبعدها على طول ضغط زرار مقفول تاني (زي
// إرسال السؤال اليومي، اللي بيفعّل تبريد geofence.js)، التوست التاني
// كان بيظهر فورًا من غير أي تبريد فعلي - لأن كل ملف بيشوف تبريده هو
// بس، مش تبريد التطبيق كله. دلوقتي showGuestLockedToast بقت export
// واحدة، وposts.js بيستوردها ويستخدمها مباشرة بدل نسخته القديمة، عشان
// يبقى فيه مصدر واحد + تبريد واحد فعلي مشترك للتطبيق كله.
const GUEST_LOCKED_TOAST_COOLDOWN_MS = 2500;
let guestLockedToastCooldownUntil = 0;

export function showGuestLockedToast() {
    const now = Date.now();
    if (now < guestLockedToastCooldownUntil) {
        // لسه جوه فترة التبريد - نتجاهل الضغطة دي تمامًا من غير أي توست جديد
        return;
    }
    guestLockedToastCooldownUntil = now + GUEST_LOCKED_TOAST_COOLDOWN_MS;

    document.dispatchEvent(new CustomEvent('app:toast', {
        detail: { message: GUEST_LOCKED_TOAST_MESSAGE },
    }));
}

/**
 * مستمع الـ Capture الوحيد اللي بيمسك أي كليك/لمسة (touch بيتحول click
 * تلقائيًا في المتصفح) على أي عنصر guest-locked قبل ما توصل له خالص -
 * بيتسجل مرة واحدة بس عند تحميل الملف (مش مرتبط بدورة lock/unlock)
 * عشان يفضل شغال دايمًا ويوقف أي كليك من أول لحظة، بغض النظر عن ترتيب
 * تحميل باقي أجزاء الصفحة.
 */
function handleDocumentClickCapture(event) {
    if (!window.isGuestMode) return;

    const lockedElement = event.target.closest(`.${GUEST_LOCKED_VISUAL_CLASS}`);
    if (!lockedElement) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    showGuestLockedToast();
}

/** نفس فكرة الكليك بالظبط، بس لحدث submit (تغطية حالة Enter Key) */
function handleDocumentSubmitCapture(event) {
    if (!window.isGuestMode) return;

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.querySelector(`.${GUEST_LOCKED_VISUAL_CLASS}`)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    showGuestLockedToast();
}

document.addEventListener('click', handleDocumentClickCapture, true);
document.addEventListener('submit', handleDocumentSubmitCapture, true);


/**
 * تعطيل أو إخفاء بصري لكل العناصر الموسومة بـ data-requires-membership،
 * بشكل عام بدون الحاجة لمعرفة كل زرار بعينه (زراير البطولات، إرسال
 * السؤال اليومي، أي ميزة مستقبلية تتطلب عضوية مؤكدة داخل نزلة عبيد).
 *
 * (إصلاح): بطّلنا نستخدم element.disabled = true هنا خالص - ده كان هو
 * السبب الجذري إن مفيش أي click بيتولد أصلاً من الأول. الحماية دلوقتي
 * بالكامل عن طريق مستمعي الـ Capture فوق (click + submit)، فمفيش داعي
 * نعطّل العنصر فعليًا - بس نوسمه بصريًا (كلاس + aria-disabled) ونمنع
 * التفاعل معاه عن طريق اعتراض الحدث قبل ما يوصله.
 */
function lockGuestRestrictedElements() {
    const restrictedElements = document.querySelectorAll(GUEST_LOCKED_ELEMENT_SELECTOR);

    restrictedElements.forEach((element) => {
        element.classList.add(GUEST_LOCKED_VISUAL_CLASS);
        element.setAttribute('aria-disabled', 'true');
    });
}


/**
 * إعادة تفعيل كل العناصر الموسومة بـ data-requires-membership، لما
 * يتأكد إن المستخدم مسموح له بالوصول الكامل (جوه النطاق أو عنده استثناء).
 */
function unlockGuestRestrictedElements() {
    const restrictedElements = document.querySelectorAll(GUEST_LOCKED_ELEMENT_SELECTOR);

    restrictedElements.forEach((element) => {
        element.classList.remove(GUEST_LOCKED_VISUAL_CLASS);
        element.removeAttribute('aria-disabled');
    });
}


/**
 * تعتيم بصري خفيف لعداد الخطوات نفسه (stepCount / stepProgressBar)
 * في وضع الزائر، كإشارة إضافية واضحة للعين إن العداد ده "متوقف"
 * حاليًا عن احتساب نقاط حقيقية، حتى لو الأرقام لسه ظاهرة كمرجع بصري.
 *
 * ملاحظة مهمة: هذه الدالة تعالج الجانب البصري فقط. المنع الفعلي
 * لإرسال الخطوات لازم يتم داخل js/app.js نفسه، بإضافة تحقق من
 * window.isGuestMode في أول سطر من دالة handleStepsIncrease، لأن
 * منطق جمع الخطوات (Pedometer Events) موجود هناك مش هنا.
 *
 * @param {boolean} shouldMute
 */
function setStepsCounterMutedVisual(shouldMute) {
    const stepCountElement = document.getElementById('stepCount');
    const stepProgressBarElement = document.getElementById('stepProgressBar');

    [stepCountElement, stepProgressBarElement].forEach((element) => {
        if (!element) {
            return;
        }

        element.classList.toggle(GUEST_LOCKED_VISUAL_CLASS, shouldMute);
    });
}


/**
 * تطبيق أو رفع قيود وضع الزائر (Guest Mode) على كامل واجهة التطبيق،
 * بناءً على قرار السماح النهائي (isAllowed) القادم من verifyUserLocation.
 *
 * @param {boolean} isAllowed
 *        true = المستخدم جوه نطاق نزلة عبيد أو عنده استثناء يدوي مفعّل
 *               => إتاحة كامل ميزات التطبيق.
 *        false = المستخدم خارج النطاق وبدون استثناء
 *               => تفعيل وضع الزائر وحجب الميزات الحساسة.
 */
export function applyGuestModeRestrictions(isAllowed) {
    const isGuestMode = isAllowed !== true;

    // (1) تفعيل العلم العام على window، عشان أي ملف تاني في التطبيق
    // (app.js، daily-question.js، tournaments.js..إلخ) يقدر يتحقق منه
    // مباشرة قبل تنفيذ أي عملية حساسة (تسجيل خطوات، احتساب نقاط،
    // الاشتراك في بطولة، الإجابة على السؤال اليومي).
    window.isGuestMode = isGuestMode;

    // (2) كلاس عام على body لأي تنسيق CSS شامل مرتبط بوضع الزائر
    document.body.classList.toggle('guest-mode-active', isGuestMode);

    if (isGuestMode) {
        // --- تفعيل قيود وضع الزائر ---

        // تعطيل/حجب كل العناصر الموسومة بـ data-requires-membership
        // (المفروض تشمل: زراير الاشتراك في البطولة اليومية/الأسبوعية/
        // الشهرية، زرار إرسال إجابة السؤال اليومي، وأي زرار "اكسب نقاط")
        lockGuestRestrictedElements();

        // تعتيم بصري لعداد الخطوات كإشارة إضافية إن الاحتساب متوقف
        setStepsCounterMutedVisual(true);
    } else {
        // --- إتاحة كامل الميزات ---

        unlockGuestRestrictedElements();
        setStepsCounterMutedVisual(false);
    }

    // (3) إعلام باقي التطبيق بالتغيير عبر حدث عام على document، عشان
    // أي وحدة تانية (حتى لو اتضافت مستقبلًا) تقدر تستجيب فورًا بدون
    // ما تحتاج تستورد دوال من هذا الملف مباشرة.
    document.dispatchEvent(new CustomEvent('geofence:guest-mode-change', {
        detail: { isGuestMode, isAllowed: !isGuestMode },
    }));

    // (4) عرض توست توضيحي للمستخدم، بس فقط لما الحالة تتغيّر فعليًا
    // (يعني منمنعش نفس التوست يتكرر مع كل فحص دوري لنفس النتيجة)
    //
    // (إصلاح - طلب صريح): توست "أنت الآن في وضع التصفح فقط" وتوست
    // "أهلاً بيك! كل ميزات التطبيق متاحة لك بالكامل." اتشالوا خالص
    // بناءً على طلب المستخدم. سبب إضافي لحذف توست الترحيب تحديدًا: كان
    // معتمد على متغيّر previousIsGuestModeState في الذاكرة بيترجع null
    // مع كل Refresh للصفحة، فأول فحص بعد أي Refresh كان بيعتبر دايمًا
    // إنه "دخول جديد لحالة كاملة الصلاحيات" ويطلع التوست ده تاني، حتى
    // لو المستخدم صاحب حساب فعلي طول الوقت ومفيش أي تغيير حقيقي حصل -
    // فمفيش داعي له خالص دلوقتي (والمتغيّر نفسه اتشال فوق مع الملف).
}


/* ==================================================================
   8) دالة التهيئة عند فتح التطبيق: initGeofencingGuard
   ------------------------------------------------------------------
   نقطة الدخول الوحيدة المطلوب استدعاؤها من app.js (مثلًا داخل معالج
   حدث 'auth:login' أو فور تأكيد وجود مستخدم مسجّل دخوله بالفعل)، وهي
   المسؤولة عن تشغيل محرك الفحص بالكامل من أول خطوة لآخر خطوة، وتطبيق
   القيود المناسبة تلقائيًا فور معرفة النتيجة.
   ================================================================== */

/**
 * تهيئة "حارس النطاق الجغرافي" الكامل: تشغيل الفحص الشامل لموقع
 * المستخدم، وتطبيق قيود وضع الزائر تلقائيًا حسب النتيجة.
 *
 * سياسة الأمان الافتراضية عند حدوث أي خطأ (رفض إذن GPS، فشل الاتصال
 * بـ Supabase، أو أي خطأ غير متوقع): نطبّق وضع الزائر (القيود المُفعّلة)
 * كإجراء احترازي (Fail-Safe)، لأننا لا نستطيع تأكيد تواجد المستخدم
 * داخل نزلة عبيد طالما الفحص نفسه فشل. هذا أفضل من ترك الميزات
 * الحساسة متاحة افتراضيًا بدون أي تحقق فعلي.
 *
 * @param {string} userId معرّف المستخدم (UUID) في جدول profiles
 * @param {{useCache?: boolean}} options
 *        useCache: بتتمرر مباشرة إلى verifyUserLocation (راجع تعليقها).
 *        القيمة الافتراضية true مناسبة لأغلب حالات فتح التطبيق العادية.
 *
 * @returns {Promise<{isGuestMode: boolean, geofenceStatus: object | null}>}
 *          كائن يلخّص النتيجة النهائية، مفيد لو الكود المستدعي عايز
 *          يعرض تفاصيل إضافية في الواجهة (المسافة، سبب الحجب..إلخ).
 */
export async function initGeofencingGuard(userId, options = {}) {
    if (!userId) {
        console.warn('تعذّرت تهيئة حارس النطاق الجغرافي: لا يوجد معرّف مستخدم (userId)');
        applyGuestModeRestrictions(false);
        return { isGuestMode: true, geofenceStatus: null };
    }

    try {
        // تشغيل محرك الفحص الكامل: GPS + الدالة المخزّنة في Supabase
        // + بناء كائن حالة النطاق الموحّد (وتخزينه في الكاش تلقائيًا
        // داخل verifyUserLocation نفسها)
        const geofenceStatus = await verifyUserLocation(userId, options);

        // تطبيق القيود المناسبة فورًا بناءً على قرار السماح النهائي
        applyGuestModeRestrictions(geofenceStatus.isAllowed);

        return {
            isGuestMode: !geofenceStatus.isAllowed,
            geofenceStatus,
        };
    } catch (error) {
        // (1) خطأ متعلق تحديدًا بتحديد الموقع (رفض إذن، Timeout، GPS
        // غير متاح..إلخ) — رسالته العربية جاهزة بالفعل من getUserCoordinates
        if (error instanceof GeofenceLocationError) {
            document.dispatchEvent(new CustomEvent('app:toast', {
                detail: { message: error.message },
            }));
        } else {
            // (2) أي خطأ آخر (فشل شبكة، فشل استدعاء Supabase..إلخ)
            console.warn('فشل تشغيل حارس النطاق الجغرافي:', error.message);

            document.dispatchEvent(new CustomEvent('app:toast', {
                detail: {
                    message: 'تعذّر التحقق من موقعك الجغرافي حاليًا. تم تفعيل وضع التصفح فقط مؤقتًا حتى يتم التحقق بنجاح.',
                },
            }));
        }

        // إجراء احترازي: نفترض وضع الزائر (القيود مفعّلة) طالما الفحص فشل
        applyGuestModeRestrictions(false);

        return { isGuestMode: true, geofenceStatus: null };
    }
}


/**
 * إعادة محاولة التحقق من الموقع الجغرافي يدويًا (مثلًا لو حطّينا زرار
 * "حاول التحقق من موقعي مرة أخرى" في واجهة وضع الزائر). بتتجاهل أي
 * كاش قديم وتجبر فحصًا فعليًا جديدًا بالكامل.
 *
 * @param {string} userId
 * @returns {Promise<{isGuestMode: boolean, geofenceStatus: object | null}>}
 */
export async function retryGeofenceVerification(userId) {
    return initGeofencingGuard(userId, { useCache: false });
}


/* ==================================================================
   نهاية ملف js/geofence.js
   ------------------------------------------------------------------
   (تحديث - قرار معماري نهائي: "اختيار 2" لفصل وضع الزائر عن الحساب
   الشخصي): initGeofencingGuard / verifyUserLocation / retryGeofence
   Verification (فوق) **مبقتش متصلة بأي مسار تشغيل فعلي في التطبيق**.
   اتسابت هنا موجودة (بدل ما تتمسح) بس كمرجع/احتياط لو احتجنا مستقبلًا
   ميزة أدمن ("مين من المستخدمين المسجلين جوه النطاق دلوقتي") - لكنها
   محتاجة تتوصل يدويًا من جديد لو حد استخدمها، لأن محدش بينادِيها حاليًا.

   السبب: قررنا إن الفحص الجغرافي (طلب إذن GPS + استدعاء Supabase)
   يقتصر على حالة واحدة بس: قبل إنشاء حساب جديد، عن طريق
   checkLocationForSignup() (فوق) - اللي js/onboarding.js وjs/auth.js
   (ensureGuestAreaCheckedForToggle) بينادوها. أي مستخدم داخل بحساب
   شخصي فعلي (جوه النطاق أو برّه) ياخد وصول كامل فورًا بمجرد تسجيل
   الدخول - من غير أي طلب GPS ومن غير أي كتابة لـ is_inside_bounds/
   last_lat/last_lng (اللي بالتالي مش هتتحدّث تاني بعد أول مرة). راجع
   js/app.js (initSharedUIBridge وinitApp) - applyGuestModeRestrictions
   بقت بتتنادى مباشرة هناك (true لصاحب حساب، false للزائر)، بدل ما
   تمر على فحص جغرافي أول.

   ملخص نقاط التكامل الفعلية المتبقية في باقي ملفات المشروع:

     1) في js/app.js:
        - applyGuestModeRestrictions(true/false) بتتنادى مباشرة حسب
          حالة تسجيل الدخول (auth:login، app:enter-guest-browsing،
          initApp) - بدون أي وسيط جغرافي.
        - "if (window.isGuestMode) return;" كأول سطر داخل
          handleStepsIncrease، لمنع احتساب أي خطوات فعليًا في وضع الزائر.

     2) في ملفات HTML (index.html):
        - إضافة data-requires-membership="true" على: زراير الاشتراك في
          البطولة اليومية/الأسبوعية/الشهرية، وزرار إرسال إجابة السؤال
          اليومي، وأي زرار مستقبلي يمنح نقاطًا حقيقية.

     3) في ملف CSS الخاص بالمشروع:
        - تعريف شكل الكلاس .guest-locked (تعتيم + منع تفاعل بصري)
          وشكل .guest-mode-active على body لو محتاجين تخصيص أوسع.

     4) الأمان الحقيقي (غير قابل للتفاوض):
        - لازم تتأكد إن أي عملية كتابة حساسة على نقاط/خطوات في
          Supabase (سواء عبر RLS Policies أو دوال SECURITY DEFINER)
          بتتحقق بنفسها من profiles.is_inside_bounds أو
          profiles.is_verified_override على مستوى قاعدة البيانات،
          وميعتمدش أبدًا على window.isGuestMode وحده، لأنه قابل
          للتلاعب من طرف العميل (Client-Side).
   ================================================================== */