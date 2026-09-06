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
    const elapsedMs = Date.now() - new Date(isoDateString).getTime();
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
async function fetchPosts() {
    const statusEl = document.getElementById('postsFeedStatus');
    setStatusText(statusEl, 'جاري تحميل المنشورات…', 'loading');

    const { data: posts, error: postsError } = await supabaseClient
        .from('posts')
        .select('id, content, image_url, created_at')
        .order('created_at', { ascending: false })
        .limit(30);

    if (postsError) {
        console.error('[posts.js] فشل تحميل المنشورات:', postsError);
        setStatusText(statusEl, 'تعذّر تحميل المنشورات. حاول تاني.', 'error');
        return;
    }

    if (!posts || posts.length === 0) {
        postsList = [];
        renderPosts();
        setStatusText(statusEl, '', null);
        return;
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

    postsList = posts.map((post) => ({
        ...post,
        likesCount: likesCountMap.get(post.id) || 0,
        commentsCount: commentsCountMap.get(post.id) || 0,
        likedByMe: myLikedSet.has(post.id),
        comments: null,
    }));

    renderPosts();
    setStatusText(statusEl, '', null);
}

/**
 * [الجزء ج] تجيب اسم/صورة "سِكّاوي" الحاليين من app_identity (صف واحد،
 * SELECT عام - مفيش RLS بيمنع القراءة، بعكس التعديل اللي محصور
 * بالأدمن عن طريق admin_update_app_identity RPC في admin.js). بتتنادى
 * مرة واحدة بس من initPostsUI() قبل أول رسم للمنشورات
 */
async function fetchAppIdentity() {
    const { data, error } = await supabaseClient
        .from('app_identity')
        .select('display_name, avatar_url')
        .eq('id', true)
        .single();

    if (error || !data) {
        console.error('[posts.js] فشل تحميل app_identity:', error);
        return; // بنسيب القيم الافتراضية (سِكّاوي / بلا أفاتار) - مش خطأ قاتل
    }

    appIdentityName = data.display_name || 'سِكّاوي';
    appIdentityAvatarUrl = data.avatar_url || null;
}

/**
 * تجيب بروفايل المستخدم الحالي (username/full_name/avatar_url) من صفه
 * هو بس في profiles (RLS بيسمح بده - auth.uid() = id)، ومتخزّنه في
 * currentUserProfile. بتتنادى مرة واحدة بس من initPostsUI() لو المستخدم
 * مسجّل دخول - محتاجينها عشان نعرف اسم/صورة اللي عمل لايك على كومنت
 * وقت إرسال إشعار comment_like (شوف handleCommentLikeToggle)
 */
async function fetchCurrentUserProfile() {
    if (!currentUserId) {
        currentUserProfile = null;
        return;
    }

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('username, full_name, avatar_url')
        .eq('id', currentUserId)
        .single();

    if (error || !data) {
        console.error('[posts.js] فشل تحميل بروفايل المستخدم الحالي:', error);
        currentUserProfile = null;
        return;
    }

    currentUserProfile = data;
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
        ? `<img class="post-card-image" src="${post.image_url}" alt="" loading="lazy">`
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
                <span class="post-card-app-name">${appName}</span>
                <span class="post-card-time">${timeText}</span>
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
    const avatarUrl = author.avatar_url || buildFallbackAvatarUrl(author.username || author.full_name || '؟');
    const isOwnComment = comment.user_id === currentUserId;
    const canReply = !isReply && Boolean(currentUserId);
    const likeCountText = comment.likesCount > 0 ? comment.likesCount.toLocaleString('ar-EG') : '';

    li.innerHTML = `
        <img class="post-comment-avatar post-comment-clickable" src="${avatarUrl}" alt="" loading="lazy">
        <div class="post-comment-body">
            <div class="post-comment-bubble">
                <span class="post-comment-author post-comment-clickable">${displayName}</span>
                <span class="post-comment-text">${escapeHtml(comment.content)}</span>
            </div>
            <div class="post-comment-meta">
                <span class="post-comment-time">${comment.created_at ? escapeHtml(formatRelativeArabicTime(comment.created_at)) : ''}</span>
                <button type="button" class="post-comment-like-btn ${comment.likedByMe ? 'is-liked' : ''}" aria-pressed="${comment.likedByMe}" ${currentUserId ? '' : 'disabled'}>
                    <svg viewBox="0 0 24 24" fill="${comment.likedByMe ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 20.5s-7.5-4.6-10-9.3C.5 8 2 4.5 5.5 4c2-.3 3.8.7 6.5 3.2C14.7 4.7 16.5 3.7 18.5 4c3.5.5 5 4 3.5 7.2-2.5 4.7-10 9.3-10 9.3z"></path>
                    </svg>
                    <span class="post-comment-like-count">${likeCountText}</span>
                </button>
                ${canReply ? '<button type="button" class="post-comment-reply-btn">رد</button>' : ''}
                ${isOwnComment ? '<button type="button" class="post-comment-delete-btn" aria-label="حذف الكومنت">✕</button>' : ''}
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
        deleteBtn.addEventListener('click', () => handleCommentDelete(card, post, comment.id));
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
    // أساسي وصل هنا بـ isReply=false، فمينفعش الردود اللي جوّاها يكون
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
    const initial = (seedText.trim()[0] || '؟').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#14171F"/><text x="20" y="26" font-size="16" font-family="Cairo,sans-serif" text-anchor="middle" fill="#D4AF37">${initial}</text></svg>`;
    // encodeURIComponent على الـ SVG كامل (مش تعليمات يدوية جزئية زي
    // %22 اللي كانت ناسية علامات التنصيص التانية) - عشان مايبقاش فيه أي
    // " أو < خام جوه الـ data URI، ده اللي كان بيكسر src="..." في <img>
    // ويخلي الـ HTML يبان كنص عادي في الصفحة
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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

    const inputEl = formEl.querySelector(parentCommentId ? '.post-comment-reply-input' : '.post-comment-input');
    const submitBtn = formEl.querySelector(parentCommentId ? '.post-comment-reply-submit-btn' : '.post-comment-submit-btn');
    const content = inputEl ? inputEl.value.trim() : '';
    if (!content) return;

    if (submitBtn) submitBtn.disabled = true;

    // INSERT عادي من غير join على profiles (post_comments نفسها مسموح
    // بالـ insert للمستخدم على صفه هو - RLS الحالي مش مشكلة هنا).
    // parent_comment_id بيتضاف بس لو ده رد - الـ trigger على الجدول
    // (enforce_single_level_comment_reply) بيرفض أي محاولة رد على رد
    // من غير ما يعتمد على الواجهة بس (زرار "رد" أصلاً مش بيبان تحت أي
    // رد - شوف canReply في buildCommentElement)
    const insertPayload = { post_id: post.id, user_id: currentUserId, content };
    if (parentCommentId) insertPayload.parent_comment_id = parentCommentId;

    const { data: insertedRow, error } = await supabaseClient
        .from('post_comments')
        .insert(insertPayload)
        .select('id')
        .single();

    if (error) {
        if (submitBtn) submitBtn.disabled = false;
        console.error('[posts.js] فشل إرسال الكومنت:', error);
        return;
    }

    // بعد نجاح الـ insert بنجيب بيانات الكومنت + الكاتب عن طريق نفس RPC
    // اللي بيتخطى RLS على profiles (get_comment_with_author)
    const { data: authoredRow, error: fetchError } = await supabaseClient
        .rpc('get_comment_with_author', { p_comment_id: insertedRow.id })
        .single();

    if (submitBtn) submitBtn.disabled = false;

    if (fetchError || !authoredRow) {
        console.error('[posts.js] فشل جلب بيانات الكومنت بعد الإرسال:', fetchError);
        return;
    }

    const data = mapCommentRowToAuthoredComment(authoredRow);

    // لو ده رد (مش كومنت أساسي)، ببعت إشعار لصاحب الكومنت الأساسي اللي
    // اترد عليه - "Fire and forget" زي فلسفة sendNotification نفسها (شوف
    // notifications.js)، فمش بنستنى نتيجتها ولا بنوقف تحديث الواجهة
    // عشانها. بندوّر على صاحب الكومنت الأساسي في post.comments المحمّلة
    // فعلاً (لازم تكون محمّلة أصلاً عشان زرار "رد" يبان تحتها من الأول)
    // بدل ما نعمل استعلام إضافي للسيرفر بس عشان معرّف المستقبِل. ومنبعتش
    // الإشعار لو المستخدم رد على كومنت نفسه (رد على نفسه مش محتاج إشعار)
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
    // فورم الرد بيتقفل تاني بعد الإرسال الناجح (الفورم الرئيسي بيفضل ظاهر دايماً)
    if (parentCommentId) formEl.classList.add('hidden');

    if (post.comments === null) post.comments = [];
    // ممكن نفس الكومنت يوصل تاني عن طريق Realtime (handleCommentInserted) -
    // بنتأكد منه مش موجود قبل ما نضيفه هنا يدوياً
    if (!post.comments.some((c) => c.id === data.id)) {
        post.comments.push(data);
    }
    post.commentsCount += 1;

    renderCommentsList(card, post);
    updateCommentCountUI(card, post);
}

/**
 * الحذف بيتكسّح تلقائياً في قاعدة البيانات لأي ردود تحت الكومنت ده
 * (on delete cascade على parent_comment_id)، فبنشيلهم من النسخة
 * المحلية كمان مش بس الكومنت نفسه - عشان كده بنعيد رسم القائمة كاملة
 * بدل ما نشيل عنصر واحد بس زي قبل كده
 */
async function handleCommentDelete(card, post, commentId) {
    if (!window.confirm('تأكيد حذف الكومنت؟')) return;

    const { error } = await supabaseClient.from('post_comments').delete().eq('id', commentId);

    if (error) {
        console.error('[posts.js] فشل حذف الكومنت:', error);
        return;
    }

    const removedIds = new Set([commentId]);
    (post.comments || []).forEach((c) => {
        if (c.parentCommentId === commentId) removedIds.add(c.id);
    });

    post.comments = (post.comments || []).filter((c) => !removedIds.has(c.id));
    post.commentsCount = Math.max(0, post.commentsCount - removedIds.size);

    renderCommentsList(card, post);
    updateCommentCountUI(card, post);
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

    // ببعت إشعار لصاحب الكومنت بس لما يكون "لايك جديد" (مش إلغاء لايك -
    // مفيش داعي نزعج حد بإشعار "شال لايكه")، ومش بنبعته لو المستخدم عمل
    // لايك لكومنت نفسه. "Fire and forget" زي comment_reply بالظبط - شوف
    // handleCommentSubmit فوق لنفس الفلسفة
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
    if (postsList.some((p) => p.id === newPostRow.id)) return;

    postsList.unshift({
        ...newPostRow,
        likesCount: 0,
        commentsCount: 0,
        likedByMe: false,
        comments: null,
    });
    renderPosts();
}

function handlePostDeleted(oldPostRow) {
    postsList = postsList.filter((p) => p.id !== oldPostRow.id);
    openCommentSections.delete(oldPostRow.id);
    renderPosts();
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
}

function handleCommentInsertedRealtime(newCommentRow) {
    const post = postsList.find((p) => p.id === newCommentRow.post_id);
    if (!post) return;

    post.commentsCount += 1;
    const card = document.querySelector(`.post-card[data-post-id="${post.id}"]`);
    if (card) updateCommentCountUI(card, post);

    // لو قسم الكومنتات مفتوح دلوقتي وقاعدين محمّلين الكومنتات، نضيف
    // الصف الجديد فعلياً (لو مش موجود بالفعل - زي كومنت المستخدم الحالي
    // نفسه اللي اتضاف يدوياً في handleCommentSubmit)
    if (post.comments !== null && !post.comments.some((c) => c.id === newCommentRow.id)) {
        // Realtime payload مفيهوش join على profiles - بنجيب بيانات الكاتب
        // بشكل منفصل بس لو القسم فعلاً مفتوح وظاهر للمستخدم دلوقتي
        if (openCommentSections.has(post.id) && card) {
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
}

function handleCommentDeletedRealtime(oldCommentRow) {
    const post = postsList.find((p) => p.id === oldCommentRow.post_id);
    if (!post) return;

    post.commentsCount = Math.max(0, post.commentsCount - 1);
    if (post.comments) {
        post.comments = post.comments.filter((c) => c.id !== oldCommentRow.id);
    }

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