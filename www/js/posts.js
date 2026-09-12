/* ==================================================================
   سِكّاوي | js/posts.js
   ------------------------------------------------------------------
   منشورات باسم التطبيق (فيسبوك-ستايل) - المرحلة 5 من خطة لوحة تحكم
   الأدمن. الملف ده مسؤول بس عن جهة "المستخدم العادي" (عرض المنشورات
   في index.html + لايك + كومنت نصي) - إنشاء/حذف المنشورات نفسها من
   لوحة تحكم الأدمن (admin.js/admin.html).

   بنفس فلسفة stories.js بالظبط:
     - دالة initPostsUI() واحدة بتتصدّر (export) وبتتنادى من app.js
       ضمن تسلسل التهيئة (initApp) - مفيش <script> منفصل ليه في
       index.html، زي profiles.js وnotifications.js بالظبط.
     - fetchPosts() تجيب المنشورات + عدد اللايكات/الكومنتات + حالة
       لايك المستخدم الحالي دفعة واحدة، وrenderPosts() ترسمهم ككروت.
     - اشتراك Realtime على الجداول التلاتة (posts/post_likes/
       post_comments) عشان أي منشور/لايك/كومنت جديد (حتى من جهاز
       تاني) يظهر لحظياً من غير أي Refresh يدوي.

   اللايك والكومنت بيعدّوا مباشرة عن طريق .insert()/.delete() على
   post_likes/post_comments (مسموح بيهم من RLS: auth.uid() = user_id -
   شوف sql/phase-5-posts.sql) - مش محتاجين RPC هنا لأنهم مش أعمدة حساسة
   زي profiles.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { getCurrentUser } from './auth.js';
import { sendNotification } from './notifications.js';
import { openPublicProfile } from './profiles.js';
import { showGuestLockedToast } from './geofence.js';
// (جديد - كاش الأوفلاين) شوف js/offline-cache.js للتفاصيل الكاملة
import { fetchWithCache, getCached, setCached } from './offline-cache.js';
import { pushModalState, closeModal, hasOpenModal } from './modal-history.js';

/* ------------------------------------------------------------------
   0) حالة محلية
   ------------------------------------------------------------------ */

/** كل المنشورات المحمّلة حالياً، بالأحدث أولاً - كل عنصر فيه شكل
 *  { id, content, image_url, created_at, likesCount, commentsCount,
 *    likedByMe, comments: [] | null }
 *  comments بتفضل null لحد ما المستخدم يفتح قسم الكومنتات لأول مرة
 *  (تحميل كسول - Lazy Load - عشان منجيبش كل كومنتات كل المنشورات
 *  دفعة واحدة من غير داعي) */
let postsList = [];

/** خريطة id المنشور -> true لو قسم الكومنتات بتاعه مفتوح دلوقتي في
 *  الواجهة - بنستخدمها عشان نعرف نضيف كومنت جديد وصل عن طريق Realtime
 *  في مكانه ولا لأ من غير ما نعيد رسم كل حاجة */
const openCommentSections = new Set();

let currentUserId = null;

/** بروفايل المستخدم الحالي المسجّل دخوله دلوقتي (username/full_name/
 *  avatar_url بس) - null لو زائر مش مسجّل دخول. بنحمّله مرة واحدة في
 *  initPostsUI (شوف fetchCurrentUserProfile) ونستخدمه في إشعار
 *  comment_like (اسم/صورة اللي عمل لايك) عشان منعملش استعلام إضافي لكل
 *  ضغطة لايك على كومنت - على عكس comment_reply اللي بياخد اسم/صورة
 *  الراد من نفس صف الكومنت الجديد المُرجَع من get_comment_with_author
 *  أصلاً (RPC)، فمش محتاج نسخة منفصلة */
let currentUserProfile = null;

let postsRealtimeChannel = null;

/** [الجزء ج] اسم/صورة "سِكّاوي" القابلين للتحكم من admin.html
 *  (جدول app_identity، صف واحد Singleton) - بيتحمّلوا مرة واحدة بس في
 *  initPostsUI() (شوف fetchAppIdentity) ويتخزّنوا هنا محلياً، عشان
 *  منعملش استعلام لكل كارت منشور. القيم الافتراضية هنا هي بالظبط نفس
 *  القيم اللي كانت ثابتة في الكود قبل كده، فلو فشل التحميل لأي سبب
 *  الشكل بيفضل زي ما كان بالظبط */
let appIdentityName = 'سِكّاوي';
let appIdentityAvatarUrl = null;


/* ------------------------------------------------------------------
   1) أدوات مساعدة عامة (نفس نمط escapeHtml/formatRelativeArabicTime
      الموجود في admin.js - مكرّرة هنا بتعمّد لأن posts.js وadmin.js
      وحدتين (Modules) منفصلتين تماماً بدون أي استيراد مشترك بينهم)
   ------------------------------------------------------------------ */

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

/**
 * بترجع الصيغة العربية الصحيحة لعدد ووحدة زمن (دقيقة/ساعة/يوم) حسب
 * قواعد العدد والمعدود: ١ مفرد ("دقيقة واحدة")، ٢ مثنى ("دقيقتين")،
 * ٣-١٠ جمع ("٥ دقائق")، ١١+ مفرد بعد الرقم ("١٥ دقيقة") - نفس القاعدة
 * المستخدمة في buildRemainingParticipantsPhrase بتاعة الليدربورد
 * (js/leaderboard.js) بالظبط، مطبّقة هنا على وحدات الزمن بدل "الأبطال"
 * @param {number} count
 * @param {{one: string, two: string, few: string, many: string}} forms
 * @returns {string}
 */
function pluralizeArabicTimeUnit(count, forms) {
    if (count === 1) return forms.one;
    if (count === 2) return forms.two;
    const formattedCount = count.toLocaleString('ar-EG');
    if (count <= 10) return `${formattedCount} ${forms.few}`;
    return `${formattedCount} ${forms.many}`;
}

function formatRelativeArabicTime(isoDateString) {
    if (!isoDateString) return '';
    const timestamp = new Date(isoDateString).getTime();
    if (isNaN(timestamp)) return '';
    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));

    if (elapsedMinutes < 1) return 'دلوقتي';
    if (elapsedMinutes < 60) {
        return `من ${pluralizeArabicTimeUnit(elapsedMinutes, { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' })}`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
        return `من ${pluralizeArabicTimeUnit(elapsedHours, { one: 'ساعة واحدة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' })}`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    return `من ${pluralizeArabicTimeUnit(elapsedDays, { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يوم' })}`;
}

function setStatusText(el, message, state) {
    if (!el) return;
    el.textContent = message;
    if (state) {
        el.dataset.state = state;
    } else {
        delete el.dataset.state;
    }
}


/* ------------------------------------------------------------------
   2) تحميل المنشورات
   ------------------------------------------------------------------ */

/**
 * تجيب أحدث المنشورات + عدد اللايكات/الكومنتات لكل واحد + هل المستخدم
 * الحالي عامل لايك ولا لأ - كل ده في 4 استعلامات بس (مش N+1) عن طريق
 * تجميع النتايج محلياً بعد الجلب
 */
/**
 * تجيب أحدث المنشورات + عدد اللايكات/الكومنتات لكل واحد + هل المستخدم
 * الحالي عامل لايك ولا لأ - كل ده في 4 استعلامات بس (مش N+1) عن طريق
 * تجميع النتايج محلياً بعد الجلب.
 *
 * (تعديل - كاش الأوفلاين): الدالة دي بقت جلب خام بس (من غير أي لمس
 * للـ DOM) - منطق الرسم/الحالة اتنقل لـ fetchPosts() تحت اللي بتنادّيها
 * عن طريق fetchWithCache. بترجع null صراحة عند فشل حقيقي في جلب
 * المنشورات نفسها (postsError)، أو [] لو فعلاً مفيش منشورات - نفس
 * منطق التفرقة المستخدم في stories.js وbanner.js.
 * @returns {Promise<Array<object>|null>}
 */
async function fetchPostsFromServer() {
    const { data: posts, error: postsError } = await supabaseClient
        .from('posts')
        .select('id, content, image_url, created_at')
        .order('created_at', { ascending: false })
        .limit(30);

    if (postsError) {
        console.error('[posts.js] فشل تحميل المنشورات:', postsError);
        return null;
    }

    if (!posts || posts.length === 0) {
        return [];
    }

    const postIds = posts.map((p) => p.id);

    const [likesResult, commentCountsResult, myLikesResult] = await Promise.all([
        // كل صفوف اللايكات لكل المنشورات دي - بنعدّهم محلياً لكل منشور
        // (أخف من N استعلام count منفصل، والحجم متوقع يفضل صغير)
        supabaseClient.from('post_likes').select('post_id').in('post_id', postIds),
        supabaseClient.from('post_comments').select('post_id').in('post_id', postIds),
        currentUserId
            ? supabaseClient.from('post_likes').select('post_id').in('post_id', postIds).eq('user_id', currentUserId)
            : Promise.resolve({ data: [], error: null }),
    ]);

    const likesCountMap = countByPostId(likesResult.data);
    const commentsCountMap = countByPostId(commentCountsResult.data);
    const myLikedSet = new Set((myLikesResult.data || []).map((row) => row.post_id));

    return posts.map((post) => ({
        ...post,
        likesCount: likesCountMap.get(post.id) || 0,
        commentsCount: commentsCountMap.get(post.id) || 0,
        likedByMe: myLikedSet.has(post.id),
        comments: null,
    }));
}

/** آخر "توقيع" (fingerprint) اتعمله رسم فعلي بيه - بنستخدمه عشان
 *  نتجنب إعادة رسم كاملة (feedEl.innerHTML = '' وإعادة بناء كل
 *  الكروت) لو الداتا الجديدة الجاية من الشبكة في الخلفية مطابقة
 *  تماماً للمعروض حالياً بالفعل. من غير الفحص ده، أي Sync في الخلفية
 *  (حتى لو مفيش تغيير فعلي) كان هيرجّع المستخدم لأول القائمة كل مرة
 *  لو كان عامل سكرول لتحت وقت ما الـ Sync حصل. */
let lastRenderedPostsSignature = null;

/**
 * توقيع خفيف لمصفوفة منشورات (id + likesCount + commentsCount +
 * likedByMe لكل منشور) - كفاية عشان نقارن "هل فعلاً فيه تغيير محتاج
 * إعادة رسم" من غير ما نعمل مقارنة عميقة لكل حقل
 * @param {Array<object>} posts
 * @returns {string}
 */
function computePostsSignature(posts) {
    return posts.map((p) => `${p.id}:${p.likesCount}:${p.commentsCount}:${p.likedByMe}`).join('|');
}

/**
 * (جديد - كاش الأوفلاين) نقطة الدخول الرئيسية لتحميل المنشورات - بتعرض
 * النسخة المخزّنة محلياً (cached_posts) فوراً لو موجودة، وتحدّثها في
 * الخلفية تلقائياً بعد كل قراءة ناجحة من الشبكة.
 *
 * ملحوظة عن likedByMe: مفتاح الكاش (cached_posts) مش خاص بمستخدم
 * معيّن (المنشورات نفسها عامة/مشتركة بين الكل)، بس حقل likedByMe جوه
 * كل منشور خاص بالمستخدم اللي كان مسجّل دخول وقت آخر حفظ للكاش. يعني
 * لو مستخدم B سجّل دخول بعد مستخدم A على نفس الجهاز، ممكن يشوف لمدة
 * أجزاء من الثانية حالة "لايك" خاطئة (بتاعة A) لحد ما رد الشبكة الحقيقي
 * (بحساب حالة B الصح) يوصل ويصحّحها تلقائياً - ده تكلفة بسيطة ومقبولة
 * (مش تسريب بيانات حساسة، مجرد لون قلب يتصحّح لوحده بعد لحظة) في مقابل
 * تبسيط الكاش (مفيش داعي لمفتاح منفصل لكل مستخدم لبيانات أصلاً عامة).
 */
async function fetchPosts() {
    const statusEl = document.getElementById('postsFeedStatus');
    setStatusText(statusEl, 'جاري تحميل المنشورات…', 'loading');

    let hasReceivedData = false;

    await fetchWithCache('cached_posts', fetchPostsFromServer, (posts) => {
        hasReceivedData = true;

        const signature = computePostsSignature(posts);
        postsList = posts;

        // نعيد الرسم الكامل بس لو فعلاً فيه تغيير - غير كده منلمسش
        // الـ DOM خالص (شوف تعليق lastRenderedPostsSignature فوق)
        if (signature !== lastRenderedPostsSignature) {
            lastRenderedPostsSignature = signature;
            renderPosts();
        }

        setStatusText(statusEl, '', null);
    });

    // مفيش كاش محفوظ ومفيش رد شبكة نجح خالص (أول فتح للتطبيق من غير
    // نت ومن غير أي كاش سابق على الجهاز) - نعرض رسالة خطأ واضحة بدل
    // ما "جاري تحميل المنشورات…" تفضل معلّقة للأبد
    if (!hasReceivedData) {
        setStatusText(statusEl, 'تعذّر تحميل المنشورات. حاول تاني.', 'error');
    }
}

/**
 * [الجزء ج] تجيب اسم/صورة "سِكّاوي" الحاليين من app_identity (صف واحد،
 * SELECT عام - مفيش RLS بيمنع القراءة، بعكس التعديل اللي محصور
 * بالأدمن عن طريق admin_update_app_identity RPC في admin.js). بتتنادى
 * مرة واحدة بس من initPostsUI() قبل أول رسم للمنشورات
 */
async function fetchAppIdentity() {
    // قراءة فورية لهوية التطبيق من كاش الأوفلاين
    const cached = await getCached('cached_app_identity');
    if (cached && typeof cached === 'object') {
        appIdentityName = cached.display_name || 'سِكّاوي';
        appIdentityAvatarUrl = cached.avatar_url || null;
    }

    try {
        const { data, error } = await supabaseClient
            .from('app_identity')
            .select('display_name, avatar_url')
            .eq('id', true)
            .single();

        if (error || !data) {
            return;
        }

        appIdentityName = data.display_name || 'سِكّاوي';
        appIdentityAvatarUrl = data.avatar_url || null;
        setCached('cached_app_identity', { display_name: appIdentityName, avatar_url: appIdentityAvatarUrl });
    } catch (err) {
        console.warn('[posts.js] استثناء أثناء جلب app_identity:', err);
    }
}

/**
 * تجيب بروفايل المستخدم الحالي (username/full_name/avatar_url) من صفه
 * هو بس في profiles (مع دعم كاش الأوفلاين)
 */
async function fetchCurrentUserProfile() {
    if (!currentUserId) {
        currentUserProfile = null;
        return;
    }

    // استرجاع فوري من كاش البروفايل المحفوظ
    const cachedProfileData = await getCached(`cached_profile:${currentUserId}`);
    if (cachedProfileData?.profile) {
        currentUserProfile = {
            username: cachedProfileData.profile.username,
            full_name: cachedProfileData.profile.full_name,
            avatar_url: cachedProfileData.profile.avatar_url,
        };
    }

    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('username, full_name, avatar_url, is_verified, verified_until')
            .eq('id', currentUserId)
            .single();

        if (error || !data) {
            return;
        }

        const isVerifiedActive = Boolean(data.is_verified && (!data.verified_until || new Date(data.verified_until) > new Date()));
        currentUserProfile = {
            ...data,
            is_verified: isVerifiedActive,
        };
    } catch (err) {
        // يتم الاعتماد على كاش الأوفلاين بهدوء
    }
}

/** @param {Array<{post_id: string}>|null} rows @returns {Map<string, number>} */
function countByPostId(rows) {
    const map = new Map();
    (rows || []).forEach((row) => {
        map.set(row.post_id, (map.get(row.post_id) || 0) + 1);
    });
    return map;
}


/* ------------------------------------------------------------------
   3) الرسم (Render)
   ------------------------------------------------------------------ */

function renderPosts() {
    const feedEl = document.getElementById('postsFeed');
    const statusEl = document.getElementById('postsFeedStatus');
    if (!feedEl) return;

    if (postsList.length === 0) {
        feedEl.innerHTML = '';
        setStatusText(statusEl, 'مفيش منشورات دلوقتي.', 'empty');
        return;
    }

    feedEl.innerHTML = '';
    postsList.forEach((post) => {
        feedEl.appendChild(buildPostCardElement(post));
    });
}

/**
 * إدارة مودال معاينة الصورة بالشاشة الكاملة (#postImageViewerModal)
 */
function openPostImageViewer(imageUrl) {
    if (!imageUrl) return;
    const modal = document.getElementById('postImageViewerModal');
    const img = document.getElementById('postImageViewerImg');
    if (!modal || !img) return;

    img.src = imageUrl;
    pushModalState(hidePostImageViewer);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function hidePostImageViewer() {
    const modal = document.getElementById('postImageViewerModal');
    const img = document.getElementById('postImageViewerImg');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    if (img) img.src = '';
}

function closePostImageViewer() {
    if (hasOpenModal()) {
        closeModal();
    } else {
        hidePostImageViewer();
    }
}

/**
 * تحديث نصوص التوقيت النسبي لجميع الكروت والتعليقات المعروضة تلقائياً
 */
let relativeTimeIntervalId = null;

function refreshAllRelativeTimes() {
    document.querySelectorAll('.post-card-time[data-created-at]').forEach((el) => {
        const iso = el.dataset.createdAt;
        if (iso) el.textContent = formatRelativeArabicTime(iso);
    });
    document.querySelectorAll('.post-comment-time[data-created-at]').forEach((el) => {
        const iso = el.dataset.createdAt;
        if (iso) el.textContent = formatRelativeArabicTime(iso);
    });
}

/**
 * تبني كارت منشور واحد كامل (هيدر باسم التطبيق + المحتوى + الصورة لو
 * موجودة + شريط لايك/كومنت + قسم الكومنتات لو مفتوح)
 * @param {object} post
 * @returns {HTMLElement}
 */
function buildPostCardElement(post) {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.postId = post.id;

    const timeText = escapeHtml(formatRelativeArabicTime(post.created_at));
    const contentHtml = post.content
        ? `<p class="post-card-content">${escapeHtml(post.content).replace(/\n/g, '<br>')}</p>`
        : '';
    const imageHtml = post.image_url
        ? `<img class="post-card-image" src="${escapeHtml(post.image_url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '';
    const commentsOpen = openCommentSections.has(post.id);

    // [الجزء ج] الاسم والأفاتار بقوا ديناميكيين من appIdentityName/
    // appIdentityAvatarUrl (شوف fetchAppIdentity) بدل النص/الحرف
    // الثابتين "سِكّاوي"/"س" - avatar_url بييجي من Storage بتاعنا
    // (مش مدخل مستخدم حر)، لكن بنعمل escapeHtml برضو كخط دفاع إضافي
    // قبل ما نحطه جوه attribute
    const appName = escapeHtml(appIdentityName || 'سِكّاوي');
    const appInitial = escapeHtml((appIdentityName || 'س').trim()[0] || 'س').toUpperCase();
    const appAvatarHtml = appIdentityAvatarUrl
        ? `<img class="post-card-app-avatar" src="${escapeHtml(appIdentityAvatarUrl)}" alt="" loading="lazy">`
        : `<span class="post-card-app-avatar" aria-hidden="true">${appInitial}</span>`;

    card.innerHTML = `
        <div class="post-card-header">
            ${appAvatarHtml}
            <div class="post-card-header-text">
                <span class="post-card-app-name flex items-center">${appName}${buildVerifiedBadgeHtml(true)}</span>
                <span class="post-card-time" data-created-at="${post.created_at || ''}">${timeText}</span>
            </div>
        </div>
        ${contentHtml}
        ${imageHtml}
        <div class="post-card-actions">
            <button type="button" class="post-like-btn ${post.likedByMe ? 'is-liked' : ''}" aria-pressed="${post.likedByMe}">
                <svg viewBox="0 0 24 24" fill="${post.likedByMe ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20.5s-7.5-4.6-10-9.3C.5 8 2 4.5 5.5 4c2-.3 3.8.7 6.5 3.2C14.7 4.7 16.5 3.7 18.5 4c3.5.5 5 4 3.5 7.2-2.5 4.7-10 9.3-10 9.3z"></path>
                </svg>
                <span class="post-like-count">${post.likesCount.toLocaleString('ar-EG')}</span>
            </button>
            <button type="button" class="post-comment-toggle-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-4-1L3 20l1.3-4A8.38 8.38 0 0 1 3 11.5 8.5 8.5 0 0 1 11.5 3 8.38 8.38 0 0 1 21 11.5z"></path>
                </svg>
                <span class="post-comment-count">${post.commentsCount.toLocaleString('ar-EG')}</span>
            </button>
        </div>
        <div class="post-comments-section ${commentsOpen ? '' : 'hidden'}">
            <ul class="post-comments-list"></ul>
            <form class="post-comment-form">
                <input type="text" class="post-comment-input" maxlength="500" placeholder="اكتب كومنت…" autocomplete="off">
                <button type="submit" class="post-comment-submit-btn" aria-label="إرسال">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M4 12h14M13 6l6 6-6 6"></path>
                    </svg>
                </button>
            </form>
        </div>
    `;

    bindPostCardEvents(card, post);

    if (commentsOpen) {
        ensureCommentsLoaded(post).then(() => renderCommentsList(card, post));
    }

    return card;
}

// (إصلاح - باج "تكرار التوست" لسه موجود جزئيًا): كان هنا نسخة طبق
// الأصل من showGuestLockedToast (geofence.js) بنفس النص وبنفس مدة
// الكولداون، لكن بمتغيّر تبريد مستقل تمامًا عن geofence.js. النتيجة:
// لو الزائر ضغط لايك على بوست (يفعّل تبريد posts.js) وبعدها على طول
// ضغط زرار مقفول تاني في مكان تاني بالتطبيق (زي إرسال السؤال اليومي،
// اللي بيفعّل تبريد geofence.js)، التوست التاني كان بيظهر فورًا من غير
// أي تبريد فعلي - لأن كل ملف بيشوف تبريده هو بس. دلوقتي بنستخدم
// showGuestLockedToast المستوردة من geofence.js مباشرة (export جديد)
// بدل النسخة المحلية، عشان يبقى فيه مصدر واحد + تبريد واحد فعلي مشترك
// للتطبيق كله.

function bindPostCardEvents(card, post) {
    const likeBtn = card.querySelector('.post-like-btn');
    if (likeBtn) {
        likeBtn.addEventListener('click', () => {
            // (إصلاح - باج حقيقي): كان الضغط بيرجع من غير أي رد فعل خالص
            // (لا توست ولا أي إشارة) لأن handleLikeToggle كانت بترجع
            // بصمت لو !currentUserId - فالزائر كان بيحس إن الزرار "عطلان"
            // مش "مقفول". دلوقتي بنطلع نفس توست القفل الموحّد المستخدم
            // في باقي التطبيق قبل ما نستدعي المنطق الفعلي أصلاً
            if (!currentUserId) {
                showGuestLockedToast();
                return;
            }
            handleLikeToggle(likeBtn, post);
        });
    }

    const commentToggleBtn = card.querySelector('.post-comment-toggle-btn');
    const commentsSection = card.querySelector('.post-comments-section');
    if (commentToggleBtn && commentsSection) {
        commentToggleBtn.addEventListener('click', async () => {
            // (إصلاح - نفس باج اللايك بالظبط): زائر بيضغط "تعليق" كان
            // بيشيل كلاس hidden فعليًا وتتنادى ensureCommentsLoaded (طلب
            // شبكة كامل) من غير أي فايدة - لأن .is-guest-mode
            // .post-comments-section في style.css أصلاً بتفرض
            // display:none بغض النظر عن الكلاس ده. فبيبان للزائر إن
            // الزرار "مش شغال" بدل ما يوضحله إنه محتاج حساب
            if (!currentUserId) {
                showGuestLockedToast();
                return;
            }

            const isOpen = !commentsSection.classList.contains('hidden');
            if (isOpen) {
                commentsSection.classList.add('hidden');
                openCommentSections.delete(post.id);
                return;
            }

            commentsSection.classList.remove('hidden');
            openCommentSections.add(post.id);
            await ensureCommentsLoaded(post);
            renderCommentsList(card, post);
        });
    }

    const commentForm = card.querySelector('.post-comment-form');
    if (commentForm) {
        commentForm.addEventListener('submit', (event) => {
            event.preventDefault();
            handleCommentSubmit(card, post, commentForm);
        });
    }

    const postImg = card.querySelector('.post-card-image');
    if (postImg && post.image_url) {
        postImg.addEventListener('click', () => openPostImageViewer(post.image_url));
    }
}


/* ------------------------------------------------------------------
   4) اللايك
   ------------------------------------------------------------------ */

/**
 * بتحدّث الواجهة فوراً (Optimistic Update) قبل ما ترد Supabase، وبترجع
 * السطر القديم (Rollback) لو فشل الطلب - نفس فلسفة toggleUserVerifiedOverride
 * في admin.js
 */
async function handleLikeToggle(likeBtn, post) {
    if (!currentUserId) return; // زائر مش مسجّل دخول - الزرار مش المفروض يبقى شغال أصلاً بدون حساب
    if (post._likeInProgress) return;
    post._likeInProgress = true;

    try {
        const wasLiked = post.likedByMe;
        const newLiked = !wasLiked;

        post.likedByMe = newLiked;
        post.likesCount += newLiked ? 1 : -1;
        updateLikeButtonUI(likeBtn, post);

        const { error } = newLiked
            ? await supabaseClient.from('post_likes').insert({ post_id: post.id, user_id: currentUserId })
            : await supabaseClient.from('post_likes').delete().eq('post_id', post.id).eq('user_id', currentUserId);

        if (error) {
            console.error('[posts.js] فشل تحديث اللايك:', error);
            // Rollback
            post.likedByMe = wasLiked;
            post.likesCount += wasLiked ? 1 : -1;
            updateLikeButtonUI(likeBtn, post);
        }

        // (كاش الأوفلاين) لازم نحدّث التوقيع المحفوظ هنا كمان (نجاح أو
        // Rollback، في الحالتين postsList اتغيّرت فعلياً) - وإلا أول Sync في
        // الخلفية بعد اللايك ده هيلاقي السيرفر راجع بنفس الحالة المعروضة
        // بالظبط، بس السيغنتشر القديمة (من قبل اللايك) مش متطابقة معاها،
        // فهيعمل renderPosts() كاملة من غير داعي ويرجّع سكرول المستخدم لفوق
        lastRenderedPostsSignature = computePostsSignature(postsList);
    } finally {
        post._likeInProgress = false;
    }
}

function updateLikeButtonUI(likeBtn, post) {
    likeBtn.classList.toggle('is-liked', post.likedByMe);
    likeBtn.setAttribute('aria-pressed', String(post.likedByMe));
    const svgPath = likeBtn.querySelector('svg');
    if (svgPath) svgPath.setAttribute('fill', post.likedByMe ? 'currentColor' : 'none');
    const countEl = likeBtn.querySelector('.post-like-count');
    if (countEl) countEl.textContent = post.likesCount.toLocaleString('ar-EG');
}


/* ------------------------------------------------------------------
   5) الكومنتات
   ------------------------------------------------------------------ */

/** تجيب كومنتات منشور معين من السيرفر أول مرة بس (Lazy) - لو محمّلة بالفعل بترجع فوراً */
async function ensureCommentsLoaded(post) {
    if (post.comments !== null) return;

    // بنستخدم RPC (get_post_comments_with_authors) بدل .select(...profiles(...))
    // المباشر - الـ RLS على profiles بيسمح لكل مستخدم يشوف صفه هو بس، فالـ
    // join المباشر كان بيرجع null لأي كومنت مش بتاعك. الدالة SECURITY DEFINER
    // وبترجع بس الأعمدة الآمنة (username, full_name, avatar_url) لصاحب كل كومنت
    const { data, error } = await supabaseClient
        .rpc('get_post_comments_with_authors', { p_post_id: post.id });

    if (error) {
        console.error('[posts.js] فشل تحميل الكومنتات:', error);
        post.comments = [];
        return;
    }

    post.comments = (data || []).map(mapCommentRowToAuthoredComment);
}

/** بتحوّل صف مُرجَع من RPC (id, content, created_at, user_id,
 *  parent_comment_id, username, full_name, avatar_url, likes_count,
 *  liked_by_me) لشكل محلي مريح - profiles زي قبل كده، بالإضافة
 *  لـ parentCommentId/likesCount/likedByMe الجداد (الجزء هـ) */
function mapCommentRowToAuthoredComment(row) {
    return {
        id: row.id,
        content: row.content,
        created_at: row.created_at,
        user_id: row.user_id,
        parentCommentId: row.parent_comment_id || null,
        likesCount: row.likes_count || 0,
        likedByMe: Boolean(row.liked_by_me),
        profiles: {
            username: row.username,
            full_name: row.full_name,
            avatar_url: row.avatar_url,
            is_verified: Boolean(row.is_verified),
        },
    };
}

function renderCommentsList(card, post) {
    const listEl = card.querySelector('.post-comments-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (!post.comments || post.comments.length === 0) {
        listEl.innerHTML = '<li class="post-comments-empty">لسه مفيش كومنتات - اكتب أول كومنت!</li>';
        return;
    }

    // [الجزء هـ] بس الكومنتات الأساسية (parentCommentId فاضي) بترسم
    // هنا مباشرة - أي رد (parentCommentId مليان) بيترسم متداخل جوه
    // الكومنت الأساسي بتاعه في buildCommentElement نفسها، مش كعنصر
    // منفصل في القائمة دي
    const topLevelComments = post.comments.filter((c) => !c.parentCommentId);
    topLevelComments.forEach((comment) => {
        listEl.appendChild(buildCommentElement(card, post, comment, false));
    });
}

/**
 * @param {HTMLElement} card
 * @param {object} post
 * @param {object} comment
 * @param {boolean} isReply - true لو الكومنت ده نفسه رد على كومنت تاني
 *  (parentCommentId مليان) - بيمنع زرار "رد" يبان تحته (قيد "مستوى
 *  واحد بس" على مستوى الواجهة، بالإضافة لـ trigger قاعدة البيانات)
 */
function buildCommentElement(card, post, comment, isReply) {
    const li = document.createElement('li');
    li.className = isReply ? 'post-comment-row is-reply' : 'post-comment-row';
    li.dataset.commentId = comment.id;

    const author = comment.profiles || {};
    const displayName = escapeHtml(author.full_name || author.username || 'مستخدم');
    const isAuthorVerified = Boolean(author.is_verified || comment.is_verified);
    const verifiedBadgeHtml = isAuthorVerified ? buildVerifiedBadgeHtml(true) : '';
    const avatarUrl = author.avatar_url || buildFallbackAvatarUrl(author.username || author.full_name || '؟');
    const isOwnComment = comment.user_id === currentUserId;
    const canReply = !isReply && Boolean(currentUserId);
    const likeCountText = comment.likesCount > 0 ? comment.likesCount.toLocaleString('ar-EG') : '';

    li.innerHTML = `
        <img class="post-comment-avatar post-comment-clickable" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy">
        <div class="post-comment-body">
            <div class="post-comment-bubble">
                <span class="post-comment-author post-comment-clickable inline-flex items-center">${displayName}${verifiedBadgeHtml}</span>
                <span class="post-comment-text">${escapeHtml(comment.content)}</span>
            </div>
            <div class="post-comment-meta">
                <span class="post-comment-time" data-created-at="${comment.created_at || ''}">${comment.created_at ? escapeHtml(formatRelativeArabicTime(comment.created_at)) : ''}</span>
                <button type="button" class="post-comment-like-btn ${comment.likedByMe ? 'is-liked' : ''}" aria-pressed="${comment.likedByMe}" ${currentUserId ? '' : 'disabled'}>
                    <svg viewBox="0 0 24 24" fill="${comment.likedByMe ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 20.5s-7.5-4.6-10-9.3C.5 8 2 4.5 5.5 4c2-.3 3.8.7 6.5 3.2C14.7 4.7 16.5 3.7 18.5 4c3.5.5 5 4 3.5 7.2-2.5 4.7-10 9.3-10 9.3z"></path>
                    </svg>
                    <span class="post-comment-like-count">${likeCountText}</span>
                </button>
                ${canReply ? '<button type="button" class="post-comment-reply-btn">رد</button>' : ''}
                ${isOwnComment ? '<button type="button" class="post-comment-delete-btn" aria-label="حذف الكومنت"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 pointer-events-none" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>' : ''}
            </div>
            ${canReply ? `
            <form class="post-comment-reply-form hidden">
                <input type="text" class="post-comment-reply-input" maxlength="500" placeholder="اكتب رد…" autocomplete="off">
                <button type="submit" class="post-comment-reply-submit-btn" aria-label="إرسال الرد">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M4 12h14M13 6l6 6-6 6"></path>
                    </svg>
                </button>
            </form>` : ''}
            ${!isReply ? '<ul class="post-comment-replies"></ul>' : ''}
        </div>
    `;

    const likeBtn = li.querySelector('.post-comment-like-btn');
    if (likeBtn) {
        likeBtn.addEventListener('click', () => handleCommentLikeToggle(likeBtn, comment, post));
    }

    // فتح بروفايل صاحب الكومنت العام لما تُضغط صورته أو اسمه - نفس فلسفة
    // فتح بروفايل مُرسل إشعار friend_accept/story_reaction في notifications.js
    // بالظبط (openPublicProfile بتاعة profiles.js، بتتولى هي فتح تاب
    // tab-public-profile وتحميل بياناته). بيشتغل مع الكومنتات والردود
    // على حد سواء (buildCommentElement بتتنادى لكل الاثنين)، وحتى لو
    // ضغط المستخدم على كومنت/رد نفسه - بيفتحله نفس شكل البروفايل العام
    // اللي بيشوفه أي حد تاني، مش أي حاجة خاصة إضافية
    if (comment.user_id) {
        li.querySelectorAll('.post-comment-clickable').forEach((el) => {
            el.addEventListener('click', () => openPublicProfile(comment.user_id, { replaceHistory: true }));
        });
    }

    const deleteBtn = li.querySelector('.post-comment-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => openCommentDeleteModal(card, post, comment.id));
    }

    const replyBtn = li.querySelector('.post-comment-reply-btn');
    const replyForm = li.querySelector('.post-comment-reply-form');
    if (replyBtn && replyForm) {
        replyBtn.addEventListener('click', () => {
            replyForm.classList.toggle('hidden');
            if (!replyForm.classList.contains('hidden')) {
                const input = replyForm.querySelector('.post-comment-reply-input');
                if (input) input.focus();
            }
        });
        replyForm.addEventListener('submit', (event) => {
            event.preventDefault();
            handleCommentSubmit(card, post, replyForm, comment.id);
        });
    }

    // [الجزء هـ] الردود (مستوى واحد بس - comment هنا دايماً كومنت
    // أساسي وصل هنا بisReply=false، فمينفعش الردود اللي جوّاها يكون
    // ليها ردود تانية أصلاً - لا الواجهة ولا الـ trigger بيسمحوا بده)
    if (!isReply) {
        const repliesEl = li.querySelector('.post-comment-replies');
        if (repliesEl) {
            const replies = (post.comments || []).filter((c) => c.parentCommentId === comment.id);
            replies.forEach((reply) => {
                repliesEl.appendChild(buildCommentElement(card, post, reply, true));
            });
        }
    }

    return li;
}

function buildFallbackAvatarUrl(seedText) {
    const safeText = typeof seedText === 'string' ? seedText.trim() : '';
    const initial = (safeText[0] || '؟').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#14171F"/><text x="20" y="26" font-size="16" font-family="Cairo,sans-serif" text-anchor="middle" fill="#D4AF37">${initial}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * بناء شارة التوثيق الذهبية الرسمية بتصميم دائري مميز وفاخر (Scalloped Rosette Seal)
 * @param {boolean} isVerified
 * @param {string} [extraClasses='']
 * @returns {string}
 */
function buildVerifiedBadgeHtml(isVerified, extraClasses = '') {
    if (!isVerified) return '';
    return `<span class="inline-flex items-center align-middle select-none text-gold-400 cursor-pointer shrink-0 ${extraClasses}" title="حساب موثق رسمي في سِكّاوي" onclick="if(window.showToast) window.showToast('حساب موثق رسمي في سِكّاوي')"><svg class="w-4 h-4 inline-block shrink-0" viewBox="0 0 24 24" fill="none"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.67-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z" fill="#D4AF37"/><circle cx="12" cy="12" r="7.5" stroke="#FFF0A0" stroke-width="0.6" stroke-opacity="0.5"/><path d="M7.75 12l3.25 3.25 6-6.5" stroke="#0B0D12" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

/**
 * إدارة مودال تأكيد حذف التعليق (#commentDeleteConfirmModal)
 * متكامل مع نظام التاريخ وزر الرجوع بالهاتف
 */
let pendingDeleteCommentInfo = null;

function openCommentDeleteModal(card, post, commentId) {
    pendingDeleteCommentInfo = { card, post, commentId };
    const modal = document.getElementById('commentDeleteConfirmModal');
    if (!modal) {
        executeCommentDelete(card, post, commentId);
        return;
    }
    pushModalState(hideCommentDeleteModal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function hideCommentDeleteModal() {
    pendingDeleteCommentInfo = null;
    const modal = document.getElementById('commentDeleteConfirmModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function closeCommentDeleteModal() {
    if (hasOpenModal()) {
        closeModal();
    } else {
        hideCommentDeleteModal();
    }
}

function handleConfirmDeleteCommentClick() {
    const info = pendingDeleteCommentInfo;
    closeCommentDeleteModal();
    if (!info) return;
    executeCommentDelete(info.card, info.post, info.commentId);
}

/**
 * @param {HTMLElement} card
 * @param {object} post
 * @param {HTMLFormElement} formEl - فورم الكومنت الرئيسي (.post-comment-form)
 *  أو فورم رد (.post-comment-reply-form) حسب parentCommentId
 * @param {string|null} parentCommentId - null لكومنت أساسي، أو id
 *  الكومنت الأب لو ده رد (الجزء هـ)
 */
async function handleCommentSubmit(card, post, formEl, parentCommentId = null) {
    if (!currentUserId) return;
    if (formEl.dataset.submitting === 'true') return;

    const inputEl = formEl.querySelector(parentCommentId ? '.post-comment-reply-input' : '.post-comment-input');
    const submitBtn = formEl.querySelector(parentCommentId ? '.post-comment-reply-submit-btn' : '.post-comment-submit-btn');
    const content = inputEl ? inputEl.value.trim() : '';
    if (!content) return;

    if (window.currentMasterSettings?.feature_comments_enabled === false) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'التعليقات متوقفة مؤقتاً بقرار إداري', type: 'error' },
        }));
        return;
    }

    if (window.checkProfanity) {
        const { hasProfanity } = window.checkProfanity(content);
        if (hasProfanity) {
            document.dispatchEvent(new CustomEvent('app:toast', {
                detail: { message: 'التعليق يحتوي على كلمات غير مسموح بنشرها', type: 'error' },
            }));
            return;
        }
    }

    formEl.dataset.submitting = 'true';
    if (submitBtn) submitBtn.disabled = true;

    try {
        const insertPayload = { post_id: post.id, user_id: currentUserId, content };
        if (parentCommentId) insertPayload.parent_comment_id = parentCommentId;

        const { data: insertedRow, error } = await supabaseClient
            .from('post_comments')
            .insert(insertPayload)
            .select('id')
            .single();

        if (error) {
            console.error('[posts.js] فشل إرسال الكومنت:', error);
            document.dispatchEvent(new CustomEvent('app:toast', {
                detail: { message: 'تعذر إرسال التعليق، تأكد من الاتصال', type: 'error' },
            }));
            return;
        }

        // بعد نجاح الـ insert بنجيب بيانات الكومنت + الكاتب عن طريق RPC
        const { data: authoredRow, error: fetchError } = await supabaseClient
            .rpc('get_comment_with_author', { p_comment_id: insertedRow.id })
            .single();

        const data = (!fetchError && authoredRow)
            ? mapCommentRowToAuthoredComment(authoredRow)
            : {
                id: insertedRow.id,
                content,
                created_at: new Date().toISOString(),
                user_id: currentUserId,
                parentCommentId,
                likesCount: 0,
                likedByMe: false,
                profiles: {
                    username: currentUserProfile?.username || '',
                    full_name: currentUserProfile?.full_name || '',
                    avatar_url: currentUserProfile?.avatar_url || null,
                    is_verified: Boolean(currentUserProfile?.is_verified),
                },
            };

        // إشعار صاحب الكومنت الأصلي عند الرد عليه
        if (parentCommentId) {
            const parentComment = (post.comments || []).find((c) => c.id === parentCommentId);
            if (parentComment && parentComment.user_id && parentComment.user_id !== currentUserId) {
                const replierName = data.profiles.full_name || data.profiles.username || 'مستخدم';
                sendNotification({
                    userId: parentComment.user_id,
                    type: 'comment_reply',
                    title: `${replierName} رد على تعليقك`,
                    message: content.length > 120 ? `${content.slice(0, 120)}…` : content,
                    data: {
                        post_id: post.id,
                        comment_id: parentCommentId,
                        reply_id: data.id,
                        sender_id: currentUserId,
                        sender_avatar_url: data.profiles.avatar_url || null,
                    },
                });
            }
        }

        if (inputEl) inputEl.value = '';
        if (parentCommentId) formEl.classList.add('hidden');

        if (post.comments === null) post.comments = [];
        if (!post.comments.some((c) => c.id === data.id)) {
            post.comments.push(data);
        }
        post.commentsCount += 1;
        lastRenderedPostsSignature = computePostsSignature(postsList);

        renderCommentsList(card, post);
        updateCommentCountUI(card, post);
    } finally {
        delete formEl.dataset.submitting;
        if (submitBtn) submitBtn.disabled = false;
    }
}

/** سجل بالمعرفات التي تم حذفها محلياً لمنع الخصم المزدوج عند استقبال حدث Realtime */
const recentlyDeletedCommentIds = new Set();

/**
 * الحذف الفعلي للتعليق بعد التأكيد
 */
async function executeCommentDelete(card, post, commentId) {
    recentlyDeletedCommentIds.add(commentId);

    const { error } = await supabaseClient.from('post_comments').delete().eq('id', commentId);

    if (error) {
        recentlyDeletedCommentIds.delete(commentId);
        console.error('[posts.js] فشل حذف الكومنت:', error);
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'تعذر حذف التعليق، حاول مرة أخرى', type: 'error' },
        }));
        return;
    }

    // حذف أي إشعارات مرتبطة بهذا الكومنت
    supabaseClient
        .from('notifications')
        .delete()
        .or(`data->>comment_id.eq.${commentId},data->>reply_id.eq.${commentId}`)
        .then(() => {})
        .catch(() => {});

    const removedIds = new Set([commentId]);
    (post.comments || []).forEach((c) => {
        if (c.parentCommentId === commentId) {
            removedIds.add(c.id);
            recentlyDeletedCommentIds.add(c.id);
        }
    });

    post.comments = (post.comments || []).filter((c) => !removedIds.has(c.id));
    post.commentsCount = Math.max(0, post.commentsCount - removedIds.size);
    lastRenderedPostsSignature = computePostsSignature(postsList);

    renderCommentsList(card, post);
    updateCommentCountUI(card, post);

    document.dispatchEvent(new CustomEvent('app:toast', {
        detail: { message: 'تم حذف التعليق', type: 'info' },
    }));
}

function updateCommentCountUI(card, post) {
    const countEl = card.querySelector('.post-comment-count');
    if (countEl) countEl.textContent = post.commentsCount.toLocaleString('ar-EG');
}


/* ------------------------------------------------------------------
   5ب) [الجزء هـ] لايك الكومنتات - نفس فلسفة handleLikeToggle/
   updateLikeButtonUI بتاعة المنشور نفسه بالظبط، بس على comment_likes
   بدل post_likes (RLS بنفس النمط: INSERT/DELETE لصاحب الحساب بس)
   ------------------------------------------------------------------ */

/**
 * بتحدّث الواجهة فوراً (Optimistic Update) قبل ما ترد Supabase، وبترجع
 * الحالة القديمة (Rollback) لو فشل الطلب
 * @param {HTMLElement} likeBtn
 * @param {object} comment
 * @param {object} post - المنشور الحاوي للكومنت (محتاجينه بس عشان
 *  data.post_id في إشعار comment_like - نفسه مش بيتغيّر هنا)
 */
async function handleCommentLikeToggle(likeBtn, comment, post) {
    if (!currentUserId) return;
    if (comment._likeInProgress) return;
    comment._likeInProgress = true;

    try {
        const wasLiked = comment.likedByMe;
        const newLiked = !wasLiked;

        comment.likedByMe = newLiked;
        comment.likesCount = Math.max(0, comment.likesCount + (newLiked ? 1 : -1));
        updateCommentLikeButtonUI(likeBtn, comment);

        const { error } = newLiked
            ? await supabaseClient.from('comment_likes').insert({ comment_id: comment.id, user_id: currentUserId })
            : await supabaseClient.from('comment_likes').delete().eq('comment_id', comment.id).eq('user_id', currentUserId);

        if (error) {
            console.error('[posts.js] فشل تحديث لايك الكومنت:', error);
            // Rollback
            comment.likedByMe = wasLiked;
            comment.likesCount = Math.max(0, comment.likesCount + (wasLiked ? 1 : -1));
            updateCommentLikeButtonUI(likeBtn, comment);
            return;
        }

        // ببعت إشعار لصاحب الكومنت بس لما يكون "لايك جديد" (مش إلغاء لايك)
        if (newLiked && comment.user_id && comment.user_id !== currentUserId) {
            const likerName = (currentUserProfile && (currentUserProfile.full_name || currentUserProfile.username)) || 'مستخدم';
            sendNotification({
                userId: comment.user_id,
                type: 'comment_like',
                title: `${likerName} عمل لايك على تعليقك`,
                message: comment.content.length > 120 ? `${comment.content.slice(0, 120)}…` : comment.content,
                data: {
                    post_id: post.id,
                    comment_id: comment.id,
                    sender_id: currentUserId,
                    sender_avatar_url: (currentUserProfile && currentUserProfile.avatar_url) || null,
                },
            });
        } else if (!newLiked && comment.user_id && comment.user_id !== currentUserId) {
            // حذف إشعار اللايك عند إلغاء الإعجاب
            supabaseClient
                .from('notifications')
                .delete()
                .eq('user_id', comment.user_id)
                .eq('type', 'comment_like')
                .filter('data->>comment_id', 'eq', String(comment.id))
                .filter('data->>sender_id', 'eq', String(currentUserId))
                .then(() => {})
                .catch(() => {});
        }
    } finally {
        comment._likeInProgress = false;
    }
}

function updateCommentLikeButtonUI(likeBtn, comment) {
    likeBtn.classList.toggle('is-liked', comment.likedByMe);
    likeBtn.setAttribute('aria-pressed', String(comment.likedByMe));
    const svgPath = likeBtn.querySelector('svg');
    if (svgPath) svgPath.setAttribute('fill', comment.likedByMe ? 'currentColor' : 'none');
    const countEl = likeBtn.querySelector('.post-comment-like-count');
    if (countEl) countEl.textContent = comment.likesCount > 0 ? comment.likesCount.toLocaleString('ar-EG') : '';
}


/* ------------------------------------------------------------------
   6) Realtime
   ------------------------------------------------------------------
   بتحدّث العدادات/القوائم لحظياً لو منشور جديد اتنشر أو حد تاني عمل
   لايك/كومنت وانت فاتح الصفحة - بنفس فلسفة bindAllUsersRealtimeSubscription
   في admin.js
   ------------------------------------------------------------------ */

function bindPostsRealtimeSubscription() {
    unbindPostsRealtimeSubscription();

    postsRealtimeChannel = supabaseClient
        .channel('public-posts-feed')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, (payload) => {
            handlePostInserted(payload.new);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
            handlePostDeleted(payload.old);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'post_likes' }, (payload) => {
            handleLikeRealtimeChange(payload.new.post_id, 1, payload.new.user_id);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'post_likes' }, (payload) => {
            handleLikeRealtimeChange(payload.old.post_id, -1, payload.old.user_id);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'post_comments' }, (payload) => {
            handleCommentInsertedRealtime(payload.new);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'post_comments' }, (payload) => {
            handleCommentDeletedRealtime(payload.old);
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comment_likes' }, (payload) => {
            handleCommentLikeRealtimeChange(payload.new.comment_id, 1, payload.new.user_id);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comment_likes' }, (payload) => {
            handleCommentLikeRealtimeChange(payload.old.comment_id, -1, payload.old.user_id);
        })
        .subscribe((status, err) => {
            // بنسجّل حالة الاشتراك دايماً (مش بس وقت الخطأ) - أهم حاجة
            // نتأكد منها لو المزامنة اللحظية مش شغالة: 'SUBSCRIBED' يعني
            // القناة اتوصلت صح وبتستقبل الأحداث فعلاً. لو الحالة فضلت
            // عالقة عند 'CHANNEL_ERROR' أو 'TIMED_OUT'، غالباً الجداول
            // (posts/post_likes/post_comments/comment_likes) مش مضافة
            // لـ publication الـ Realtime بتاعة Supabase (supabase_realtime)
            // من الأساس، أو الـ RLS بتاعتها بيمنع القراءة اللحظية
            console.log('[posts.js] حالة اشتراك Realtime بتاع المنشورات:', status);
            if (err) {
                console.error('[posts.js] خطأ في اشتراك Realtime بتاع المنشورات:', err.message || err);
            }
        });
}

function unbindPostsRealtimeSubscription() {
    if (postsRealtimeChannel) {
        supabaseClient.removeChannel(postsRealtimeChannel);
        postsRealtimeChannel = null;
    }
}

function handlePostInserted(newPostRow) {
    if (!newPostRow || postsList.some((p) => p.id === newPostRow.id)) return;

    const newPost = {
        ...newPostRow,
        likesCount: 0,
        commentsCount: 0,
        likedByMe: false,
        comments: null,
    };
    postsList.unshift(newPost);
    lastRenderedPostsSignature = computePostsSignature(postsList);

    const feedEl = document.getElementById('postsFeed');
    const statusEl = document.getElementById('postsFeedStatus');
    if (!feedEl) return;

    if (postsList.length === 1) {
        renderPosts();
    } else {
        const newCard = buildPostCardElement(newPost);
        feedEl.prepend(newCard);
    }
    setStatusText(statusEl, '', null);
}

function handlePostDeleted(oldPostRow) {
    if (!oldPostRow || !oldPostRow.id) return;
    postsList = postsList.filter((p) => p.id !== oldPostRow.id);
    openCommentSections.delete(oldPostRow.id);
    lastRenderedPostsSignature = computePostsSignature(postsList);

    const card = document.querySelector(`.post-card[data-post-id="${oldPostRow.id}"]`);
    if (card) {
        card.remove();
    }

    if (postsList.length === 0) {
        const feedEl = document.getElementById('postsFeed');
        const statusEl = document.getElementById('postsFeedStatus');
        if (feedEl) feedEl.innerHTML = '';
        setStatusText(statusEl, 'مفيش منشورات دلوقتي.', 'empty');
    }
}

function handleLikeRealtimeChange(postId, delta, byUserId) {
    const post = postsList.find((p) => p.id === postId);
    if (!post) return;

    // لو التغيير ده أصلاً هو نفس فعل المستخدم الحالي (اللي اتحدّث محلياً
    // فوراً - Optimistic Update)، منعملش تحديث مضاعف
    if (byUserId === currentUserId) return;

    post.likesCount = Math.max(0, post.likesCount + delta);
    const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
    if (card) {
        const countEl = card.querySelector('.post-like-count');
        if (countEl) countEl.textContent = post.likesCount.toLocaleString('ar-EG');
    }
    // (كاش الأوفلاين) تحديث مباشر للـ DOM من غير renderPosts() كاملة -
    // بس برضه لازم نحدّث التوقيع المحفوظ عشان يفضل معبّر عن الحالة
    // الحقيقية المعروضة دلوقتي
    lastRenderedPostsSignature = computePostsSignature(postsList);
}

function handleCommentInsertedRealtime(newCommentRow) {
    if (!newCommentRow) return;
    const post = postsList.find((p) => p.id === newCommentRow.post_id);
    if (!post) return;

    // إذا كان التعليق أضيف من المستخدم الحالي أو موجود مسبقاً في القائمة، نتجاهل الزيادة لمنع التضخم
    if (newCommentRow.user_id === currentUserId) return;
    if (post.comments !== null && post.comments.some((c) => c.id === newCommentRow.id)) return;

    post.commentsCount += 1;
    const card = document.querySelector(`.post-card[data-post-id="${post.id}"]`);
    if (card) updateCommentCountUI(card, post);
    lastRenderedPostsSignature = computePostsSignature(postsList);

    // لو قسم الكومنتات مفتوح دلوقتي وقاعدين محمّلين الكومنتات، نضيف
    // الصف الجديد فعلياً
    if (post.comments !== null && openCommentSections.has(post.id) && card) {
        supabaseClient
            .rpc('get_comment_with_author', { p_comment_id: newCommentRow.id })
            .single()
            .then(({ data: row }) => {
                if (!row || post.comments.some((c) => c.id === row.id)) return;
                post.comments.push(mapCommentRowToAuthoredComment(row));
                renderCommentsList(card, post);
            });
    }
}

function handleCommentDeletedRealtime(oldCommentRow) {
    if (!oldCommentRow || !oldCommentRow.id) return;
    const commentId = oldCommentRow.id;

    // إذا كان هذا التعليق حُذف بالفعل محلياً بواسطة المستخدم الحالي، نتجاهل الخصم المزدوج
    if (recentlyDeletedCommentIds.has(commentId)) {
        recentlyDeletedCommentIds.delete(commentId);
        return;
    }

    // البحث عن المنشور إما بـ post_id أو بالبحث داخل كوليكشن الكومنتات المحمّلة
    let post = oldCommentRow.post_id
        ? postsList.find((p) => p.id === oldCommentRow.post_id)
        : null;

    if (!post) {
        post = postsList.find((p) => p.comments && p.comments.some((c) => c.id === commentId));
    }
    if (!post) return;

    post.commentsCount = Math.max(0, post.commentsCount - 1);
    if (post.comments) {
        post.comments = post.comments.filter((c) => c.id !== commentId && c.parentCommentId !== commentId);
    }
    lastRenderedPostsSignature = computePostsSignature(postsList);

    const card = document.querySelector(`.post-card[data-post-id="${post.id}"]`);
    if (card) {
        updateCommentCountUI(card, post);
        if (openCommentSections.has(post.id)) renderCommentsList(card, post);
    }
}


/**
 * [الجزء هـ] لايك/إزالة لايك على كومنت من مستخدم تاني - بندوّر على
 * الكومنت في كل المنشورات المحمّلة (مش بس الأول اللي نلاقيه، عشان
 * منعرفش مقدماً هو تابع لأي منشور من الـ payload وحده) وبنحدّث العداد +
 * الزرار لو ظاهر فعلاً دلوقتي (قسم الكومنتات مفتوح)
 * @param {string} commentId
 * @param {1|-1} delta
 * @param {string} byUserId
 */
function handleCommentLikeRealtimeChange(commentId, delta, byUserId) {
    // لو التغيير ده أصلاً هو نفس فعل المستخدم الحالي (اتحدّث محلياً فوراً
    // - Optimistic Update)، منعملش تحديث مضاعف
    if (byUserId === currentUserId) return;

    for (const post of postsList) {
        if (!post.comments) continue;
        const comment = post.comments.find((c) => c.id === commentId);
        if (!comment) continue;

        comment.likesCount = Math.max(0, comment.likesCount + delta);

        const card = document.querySelector(`.post-card[data-post-id="${post.id}"]`);
        if (card) {
            const commentLi = card.querySelector(`[data-comment-id="${commentId}"]`);
            const likeBtn = commentLi ? commentLi.querySelector('.post-comment-like-btn') : null;
            if (likeBtn) updateCommentLikeButtonUI(likeBtn, comment);
        }
        break;
    }
}


/* ------------------------------------------------------------------
   7) التهيئة العامة - بتتنادى من app.js
   ------------------------------------------------------------------ */

export async function initPostsUI() {
    const feedEl = document.getElementById('postsFeed');
    if (!feedEl) return; // مفيش قسم منشورات في الصفحة دي أصلاً

    const user = await getCurrentUser();
    currentUserId = user ? user.id : null;

    // زرار اللايك وفورم الكومنت مش المفروض يشتغلوا لزائر مش مسجّل دخول -
    // بنعلّم الحاوية بكلاس عام والـ CSS/JS بيحترموه (شوف post-card-actions
    // في style.css: .is-guest-mode)
    feedEl.classList.toggle('is-guest-mode', !currentUserId);

    // [الجزء ج] لازم قبل fetchPosts (اللي بينادي renderPosts داخلياً)
    // عشان أول رسم للكروت يطلع فيه الاسم/الصورة الصح من أول لحظة، مش
    // القيم الافتراضية ثم re-render تاني
    await fetchAppIdentity();
    await fetchCurrentUserProfile();
    await fetchPosts();
    bindPostsRealtimeSubscription();

    // بنسمع لحدث 'posts:open-comment' مرة واحدة بس هنا (نفس فلسفة
    // إعادة النداء الآمنة بتاعة initPostsUI عموماً) - بيتبعت من
    // notifications.js (openPostReplyById) لما المستخدم يضغط على إشعار
    // "رد على تعليقك" أو "لايك على تعليقك"، عشان نفتح نفس المنشور ونظلّل الرد بالظبط، من غير
    // ما نحتاج notifications.js يستورد أي حاجة من الملف ده مباشرة
    // (تجنب Circular Import - نفس فلسفة app:switch-tab/app:toast)
    document.addEventListener('posts:open-comment', (event) => {
        const { postId, commentId } = event.detail || {};
        if (postId) handleOpenCommentFromNotification(postId, commentId);
    });

    // ربط أزرار مودال تأكيد حذف التعليق
    const cancelDeleteBtn = document.getElementById('btnCancelDeleteComment');
    const confirmDeleteBtn = document.getElementById('btnConfirmDeleteComment');
    const commentDeleteModal = document.getElementById('commentDeleteConfirmModal');

    if (cancelDeleteBtn) {
        cancelDeleteBtn.addEventListener('click', closeCommentDeleteModal);
    }
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', handleConfirmDeleteCommentClick);
    }
    if (commentDeleteModal) {
        commentDeleteModal.addEventListener('click', (event) => {
            if (event.target === commentDeleteModal) closeCommentDeleteModal();
        });
    }

    // ربط مودال معاينة صورة المنشور بالشاشة الكاملة
    const imageViewerModal = document.getElementById('postImageViewerModal');
    const imageViewerCloseBtn = document.getElementById('postImageViewerCloseBtn');
    if (imageViewerCloseBtn) {
        imageViewerCloseBtn.addEventListener('click', closePostImageViewer);
    }
    if (imageViewerModal) {
        imageViewerModal.addEventListener('click', (event) => {
            if (event.target === imageViewerModal || event.target.id === 'postImageViewerImg') {
                closePostImageViewer();
            }
        });
    }

    // بدء التحديث التلقائي للتوقيت النسبي كل دقيقة
    if (!relativeTimeIntervalId) {
        relativeTimeIntervalId = window.setInterval(refreshAllRelativeTimes, 60000);
    }

    // بنسمع لنفس حدثي تسجيل الدخول/الخروج اللي notifications.js بتسمعلهم
    // (شوف تعليق initNotificationsUI في notifications.js لتفسير امتى
    // 'auth:login' بتتطلق بالظبط) - من غير الاستماع ده، currentUserId/
    // currentUserProfile بيفضلوا محفوظين على أول حالة شافوها بس وقت
    // initPostsUI، فلو حد سجّل دخول أو خرج من جوه نفس الصفحة (من غير
    // Refresh)، زرار اللايك ومعرّف "لايكي أنا" وبيانات إشعارات
    // comment_like كلهم هيفضلوا غلط لحد ما يعمل Refresh يدوي
    document.addEventListener('auth:login', (event) => {
        handleUserSignedIn(event.detail.user);
    });

    document.addEventListener('auth:signed-out', () => {
        handleUserSignedOut();
    });

    document.addEventListener('profile:updated', (event) => {
        if (event.detail?.profile) {
            currentUserProfile = { ...currentUserProfile, ...event.detail.profile };
        }
    });
}

/**
 * تُستدعى مع كل حدث 'auth:login' - بتحدّث currentUserId/currentUserProfile
 * وتعيد جلب المنشورات من جديد عشان حالة "لايكي أنا" على كل بوست/كومنت
 * تتحسب صح على أساس هوية المستخدم الجديد (كانت محسوبة كـ false افتراضياً
 * وقت ما كان زائر)، وتفعّل زرار اللايك/الكومنت (شوف .is-guest-mode)
 * @param {import('@supabase/supabase-js').User} user
 */
async function handleUserSignedIn(user) {
    if (!user) return;

    // لو نفس المستخدم بالظبط اللي كان مسجل بالفعل (مثلاً auth:login
    // اتطلقت أكتر من مرة لنفس الجلسة)، مفيش داعي نعيد الجلب من الصفر تاني
    if (currentUserId === user.id) return;

    currentUserId = user.id;
    await fetchCurrentUserProfile();

    const feedEl = document.getElementById('postsFeed');
    if (feedEl) feedEl.classList.remove('is-guest-mode');

    openCommentSections.clear();
    await fetchPosts();
}

/**
 * تُستدعى مع 'auth:signed-out' - بترجّع الحالة لحالة "زائر" (نفس الحالة
 * الافتراضية وقت أول تحميل من غير تسجيل دخول)
 */
async function handleUserSignedOut() {
    currentUserId = null;
    currentUserProfile = null;

    const feedEl = document.getElementById('postsFeed');
    if (feedEl) feedEl.classList.add('is-guest-mode');

    openCommentSections.clear();
    await fetchPosts();
}

/**
 * تُستدعى لما 'posts:open-comment' يوصل (شوف initPostsUI فوق) - بتفتح
 * قسم الكومنتات بتاع المنشور المطلوب لو مقفول، تتأكد إن الكومنتات
 * محمّلة، ترسمها، تتمرّر (Scroll) للمنشور نفسه، وبعدين تظلّل الرد
 * بالظبط لو معرّفه متاح (تظليل مؤقت بكلاس is-highlighted - شوف
 * css/style.css). لو المنشور مش موجود في postsList الحالية أصلاً
 * (اتحذف مثلاً) بنعرض توست واضح بدل ما نفشل بصمت، بنفس فلسفة
 * openStoryById في notifications.js بالظبط
 * @param {string} postId
 * @param {string|undefined} commentId
 */
async function handleOpenCommentFromNotification(postId, commentId) {
    const post = postsList.find((p) => String(p.id) === String(postId));
    const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);

    if (!post || !card) {
        document.dispatchEvent(new CustomEvent('app:toast', {
            detail: { message: 'المنشور ده لم يعد متاحاً', type: 'info' },
        }));
        return;
    }

    const commentsSection = card.querySelector('.post-comments-section');
    if (commentsSection && commentsSection.classList.contains('hidden')) {
        commentsSection.classList.remove('hidden');
        openCommentSections.add(post.id);
    }

    await ensureCommentsLoaded(post);
    renderCommentsList(card, post);

    // بنستنى فريم واحد عشان قسم الكومنتات يبقى ظاهر فعلياً في الـ DOM
    // (زي نفس فلسفة scrollToId في app.js) قبل ما نحسب موضع السكرول
    requestAnimationFrame(() => {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });

        if (!commentId) return;
        const commentRow = card.querySelector(`.post-comment-row[data-comment-id="${commentId}"]`);
        if (!commentRow) return;
        commentRow.classList.add('is-highlighted');
        setTimeout(() => commentRow.classList.remove('is-highlighted'), 1800);
    });
}