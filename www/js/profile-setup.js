/* ==================================================================
   سِكّاوي | js/profile-setup.js
   ------------------------------------------------------------------
   المسؤولية الوحيدة لهذا الملف: التحكم في موديل "إعداد البطل لأول
   مرة" (firstTimeProfileModal). الموديل ده بيظهر تلقائياً بعد أي
   تسجيل دخول ناجح لمستخدم لسه معندهوش صف في جدول profiles (الحالة
   دي بييجينا جاهزة من حدث "auth:signed-in" اللي بيطلقه js/auth.js).

   المسؤوليات بالتفصيل:
     - إظهار الموديل تلقائياً للمستخدم الجديد فقط.
     - عرض شبكة أفاتارات افتراضية يقدر يختار منها، أو يرفع صورة بنفسه.
     - حفظ صف جديد في جدول profiles بمجرد ما يضغط "ابدأ الرحلة".
     - إطلاق حدث "profile:created" بعد الحفظ عشان باقي التطبيق
       (app.js) يبدأ يعرض شاشة البروفايل والداشبورد الحقيقية.
   ================================================================== */

import { supabaseClient } from './supabase-config.js';
import { dispatchToast } from './auth.js';

/** بيانات المستخدم الحالي اللي بنجهزله البروفايل دلوقتي */
let pendingUser = null;

/** رابط الصورة المختارة حالياً (سواء افتراضية أو مرفوعة) */
let selectedAvatarUrl = null;

/** ملف الصورة المرفوع من جهاز المستخدم (لو موجود) */
let uploadedAvatarFile = null;

/** مجموعة أفاتارات افتراضية جاهزة يقدر المستخدم يختار منها بسرعة */
const DEFAULT_AVATAR_OPTIONS = [
    'https://placehold.co/160x160/14b8a6/ffffff?text=%F0%9F%A6%81',
    'https://placehold.co/160x160/eab308/1a1a1a?text=%F0%9F%A6%85',
    'https://placehold.co/160x160/ef4444/ffffff?text=%F0%9F%90%AF',
    'https://placehold.co/160x160/3b82f6/ffffff?text=%F0%9F%90%A2',
];

/**
 * إظهار موديل "إعداد البطل لأول مرة"
 */
function showFirstTimeProfileModal() {
    const modal = document.getElementById('firstTimeProfileModal');
    if (modal) modal.classList.remove('hidden');
}

/**
 * إخفاء موديل "إعداد البطل لأول مرة"
 */
function hideFirstTimeProfileModal() {
    const modal = document.getElementById('firstTimeProfileModal');
    if (modal) modal.classList.add('hidden');
}

/**
 * رسم شبكة الأفاتارات الافتراضية داخل الموديل، مع ربط حدث الاختيار
 * بكل واحدة فيهم
 */
function renderDefaultAvatarsGrid() {
    const grid = document.getElementById('defaultAvatarsGrid');
    if (!grid) return;

    grid.innerHTML = DEFAULT_AVATAR_OPTIONS.map((avatarUrl, index) => `
        <button type="button" data-avatar-url="${avatarUrl}" data-avatar-index="${index}"
                class="default-avatar-option w-9 h-9 rounded-full overflow-hidden border-2
                       border-gold-500/20 hover:border-gold-500/60 transition-colors">
            <img src="${avatarUrl}" alt="أفاتار افتراضي ${index + 1}" class="w-full h-full object-cover" />
        </button>
    `).join('');

    grid.querySelectorAll('.default-avatar-option').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedAvatarUrl = btn.dataset.avatarUrl;
            uploadedAvatarFile = null;
            updateAvatarPreview(selectedAvatarUrl);
        });
    });
}

/**
 * تحديث الصورة المعروضة أعلى الفورم (Preview)
 * @param {string} imageUrl
 */
function updateAvatarPreview(imageUrl) {
    const previewEl = document.getElementById('setupAvatarPreview');
    if (previewEl) previewEl.src = imageUrl;
}

/**
 * ربط زرار وحقل رفع الصورة الشخصية من جهاز المستخدم
 */
function bindAvatarUploadEvents() {
    const uploadBtn = document.getElementById('btnUploadAvatar');
    const fileInput = document.getElementById('avatarFileInput');

    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener('click', () => fileInput.click());
    }

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                dispatchToast('من فضلك اختار ملف صورة صحيح', 'error');
                return;
            }

            uploadedAvatarFile = file;
            selectedAvatarUrl = null;

            const localPreviewUrl = URL.createObjectURL(file);
            updateAvatarPreview(localPreviewUrl);
        });
    }
}

/**
 * رفع الصورة اللي اختارها المستخدم من جهازه لباكت "avatars" في
 * Supabase Storage، وإرجاع الرابط العام (Public URL) بتاعها
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function uploadAvatarFile(userId) {
    const fileExtension = uploadedAvatarFile.name.split('.').pop();
    const filePath = `${userId}/avatar-${Date.now()}.${fileExtension}`;

    const { error: uploadError } = await supabaseClient
        .storage
        .from('avatars')
        .upload(filePath, uploadedAvatarFile, { upsert: true });

    if (uploadError) {
        throw new Error('حصل خطأ أثناء رفع الصورة، جرّب صورة تانية');
    }

    const { data } = supabaseClient.storage.from('avatars').getPublicUrl(filePath);
    return data.publicUrl;
}

/**
 * التحكم في ظهور مؤشر التحميل جوه زرار "ابدأ الرحلة"
 * @param {boolean} isLoading
 */
function setProfileSetupLoading(isLoading) {
    const submitBtn = document.getElementById('btnStartJourney');
    const spinner = document.getElementById('profileSetupLoadingSpinner');
    const submitText = document.getElementById('btnStartJourneyText');

    if (submitBtn) submitBtn.disabled = isLoading;
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
    if (submitText) submitText.classList.toggle('opacity-60', isLoading);
}

/**
 * حفظ بروفايل المستخدم الجديد في جدول profiles، شامل التعامل مع رفع
 * الصورة (لو المستخدم رفع صورة من جهازه) قبل الحفظ
 */
async function handleProfileSetupSubmit(event) {
    event.preventDefault();

    if (!pendingUser) {
        dispatchToast('حصل خطأ في التعرف على المستخدم، حاول تسجل دخول تاني', 'error');
        return;
    }

    const heroName = document.getElementById('setupHeroNameInput').value.trim();
    const heroTitle = document.getElementById('setupTitleSelect').value;

    if (!heroName) {
        dispatchToast('من فضلك اكتب اسم البطل', 'error');
        return;
    }

    setProfileSetupLoading(true);

    try {
        let finalAvatarUrl = selectedAvatarUrl || DEFAULT_AVATAR_OPTIONS[0];

        if (uploadedAvatarFile) {
            finalAvatarUrl = await uploadAvatarFile(pendingUser.id);
        }

        const { data: insertedProfile, error: insertError } = await supabaseClient
            .from('profiles')
            // upsert بدل insert لنفس السبب الموضّح في auth.js: الـ
            // Trigger الاحتياطي في الداتابيز ممكن يكون سبق وعمل صف
            // مبدئي للمستخدم ده، فـ upsert بيكمّله بأمان بدل ما يفشل
            // بخطأ تكرار مفتاح أساسي (duplicate key)
            .upsert({
                id: pendingUser.id,
                // اسم المستخدم (Username) اللي سجّل بيه في js/auth.js، بنخزنه هنا
                // كمان عشان يبقى متاح بسهولة من جدول profiles (مثلاً في
                // لوحة تحكم الأدمن) من غير ما نرجع لجدول auth.users.
                username: pendingUser.user_metadata?.username || null,
                full_name: heroName,
                avatar_url: finalAvatarUrl,
                title: heroTitle,
                total_steps: 0,
                daily_steps: 0,
                points: 0,
            }, { onConflict: 'id' })
            .select()
            .single();

        if (insertError) {
            console.error('خطأ في حفظ البروفايل (إعداد أول مرة):', insertError.message);
            throw new Error(`حصل خطأ أثناء حفظ البروفايل (${insertError.message}) - حاول تاني`);
        }

        hideFirstTimeProfileModal();
        dispatchToast(`أهلاً بيك يا ${heroName}! رحلتك بدأت`, 'success');

        document.dispatchEvent(new CustomEvent('profile:created', {
            detail: { profile: insertedProfile },
        }));
    } catch (error) {
        dispatchToast(error.message, 'error');
    } finally {
        setProfileSetupLoading(false);
    }
}

/**
 * إعادة تصفير حالة الفورم قبل ما يتفتح لمستخدم جديد (الاسم، اللقب،
 * والصورة المختارة)
 */
function resetProfileSetupForm() {
    const nameInput = document.getElementById('setupHeroNameInput');
    const titleSelect = document.getElementById('setupTitleSelect');

    if (nameInput) nameInput.value = '';
    if (titleSelect) titleSelect.value = 'ابن البلد';

    selectedAvatarUrl = DEFAULT_AVATAR_OPTIONS[0];
    uploadedAvatarFile = null;
    updateAvatarPreview(DEFAULT_AVATAR_OPTIONS[0]);
}

/**
 * الاستماع لحدث "auth:signed-in" اللي بيطلقه js/auth.js بعد كل تسجيل
 * دخول ناجح. لو المستخدم عنده بروفايل بالفعل (hasProfile = true)،
 * الموديل ده مايفتحش خالص.
 */
function listenToSignInEvents() {
    document.addEventListener('auth:signed-in', (event) => {
        const { user, hasProfile } = event.detail;

        if (hasProfile) return; // مستخدم قديم، مش محتاج إعداد أول مرة

        pendingUser = user;
        resetProfileSetupForm();
        renderDefaultAvatarsGrid();
        showFirstTimeProfileModal();
    });
}

/**
 * نقطة الدخول الرئيسية لملف إعداد البروفايل، تُستدعى مرة واحدة من
 * app.js بعد استدعاء initAuthUI() من js/auth.js
 */
export function initProfileSetupUI() {
    const form = document.getElementById('firstTimeProfileForm');
    if (form) form.addEventListener('submit', handleProfileSetupSubmit);

    bindAvatarUploadEvents();
    listenToSignInEvents();
}