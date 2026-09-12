/**
 * سِكّاوي | master-control.js
 * ------------------------------------------------------------------
 * وحدة التحكم الشاملة في التطبيق من لوحة الأدمن بدون تعديل أكواد:
 *   1) وضع الصيانة المؤقتة (Maintenance Mode) واستثناء الأدمن.
 *   2) الإجبار على التحديث (Force Update) ومقارنة أرقام الإصدارات.
 *   3) مفاتيح تشغيل وإيقاف الميزات (Feature Flags).
 *   4) الإعلان المنبثق العام (In-App Announcement Modal).
 *   5) فلتر الكلمات المحظورة (Profanity Filter).
 *   6) شارة مضاعفة النقاط الحية (Points Multiplier / Double XP).
 *   7) اشتراك Realtime لحظي مع جدول app_settings.
 * ------------------------------------------------------------------
 */

import { supabaseClient } from './supabase-config.js';

export const CURRENT_APP_VERSION = '1.0.0';

let currentSettings = null;
let countdownInterval = null;

/**
 * فحص ما إذا كان النص يحتوي على أي كلمة من قائمة الكلمات المحظورة
 * @param {string} text 
 * @returns {{ hasProfanity: boolean, word: string|null }}
 */
export function checkProfanity(text) {
    if (!text || !currentSettings?.profanity_words || !Array.isArray(currentSettings.profanity_words)) {
        return { hasProfanity: false, word: null };
    }

    const cleanText = text.trim().toLowerCase();
    for (const word of currentSettings.profanity_words) {
        const trimmedWord = (word || '').trim().toLowerCase();
        if (trimmedWord.length > 0 && cleanText.includes(trimmedWord)) {
            return { hasProfanity: true, word: trimmedWord };
        }
    }
    return { hasProfanity: false, word: null };
}

window.checkProfanity = checkProfanity;

/**
 * مقارنة رقمين من إصدارات التطبيق (SemVer style: X.Y.Z)
 * ترجع true إذا كان current أقل من minVersion
 * @param {string} current 
 * @param {string} minVersion 
 * @returns {boolean}
 */
function isVersionOlder(current, minVersion) {
    if (!minVersion) return false;
    const cParts = (current || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
    const mParts = minVersion.split('.').map((n) => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(cParts.length, mParts.length); i++) {
        const c = cParts[i] || 0;
        const m = mParts[i] || 0;
        if (c < m) return true;
        if (c > m) return false;
    }
    return false;
}

/**
 * فحص هل المستخدم الحالي يحمل دور admin
 */
function isCurrentUserAdmin() {
    return window.currentUserRole === 'admin' || window.currentProfile?.role === 'admin';
}

/**
 * تطبيق وضع الصيانة (Maintenance Mode)
 */
function applyMaintenanceMode(settings) {
    const overlay = document.getElementById('maintenanceOverlay');
    const adminNotice = document.getElementById('maintenanceAdminNotice');
    const msgEl = document.getElementById('maintenanceMessageText');
    const countdownEl = document.getElementById('maintenanceCountdownText');

    if (!overlay) return;

    const isMaintenance = Boolean(settings?.is_maintenance_mode);
    const isAdmin = isCurrentUserAdmin();

    if (isMaintenance) {
        if (isAdmin) {
            // الأدمن يستمر في تصفح التطبيق مع ظهور تنبيه عائم في الأعلى
            overlay.classList.add('hidden');
            if (adminNotice) {
                adminNotice.classList.remove('hidden');
            }
        } else {
            // المستخدم العادي أو الزائر يتم حجب التطبيق عنه بشاشة الصيانة
            overlay.classList.remove('hidden');
            if (adminNotice) adminNotice.classList.add('hidden');

            if (msgEl) {
                msgEl.textContent = settings.maintenance_message || 'التطبيق في وضع الصيانة المؤقتة، سنعود قريباً.';
            }

            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }

            if (settings.maintenance_estimated_end) {
                const targetTime = new Date(settings.maintenance_estimated_end).getTime();
                const updateCountdown = () => {
                    const now = Date.now();
                    const diff = targetTime - now;
                    if (diff <= 0) {
                        if (countdownEl) countdownEl.textContent = 'الانتهاء المتوقع: قريباً جداً';
                        if (countdownInterval) clearInterval(countdownInterval);
                        return;
                    }
                    const hours = Math.floor(diff / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
                    if (countdownEl) {
                        countdownEl.textContent = 'الوقت التقريبي المتبقي: ' + (hours > 0 ? hours + ' س و ' : '') + minutes + ' د و ' + seconds + ' ث';
                    }
                };
                updateCountdown();
                countdownInterval = setInterval(updateCountdown, 1000);
            } else {
                if (countdownEl) countdownEl.textContent = '';
            }
        }
    } else {
        // وضع الصيانة مغلق
        overlay.classList.add('hidden');
        if (adminNotice) adminNotice.classList.add('hidden');
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }
}

/**
 * تطبيق الإجبار على التحديث (Force Update)
 */
function applyForceUpdate(settings) {
    const overlay = document.getElementById('forceUpdateOverlay');
    const msgEl = document.getElementById('forceUpdateMessageText');
    const linkEl = document.getElementById('forceUpdateBtn');

    if (!overlay) return;

    const isEnabled = Boolean(settings?.is_force_update_enabled);
    const minVersion = settings?.min_app_version || '1.0.0';
    const requiresUpdate = isEnabled && isVersionOlder(CURRENT_APP_VERSION, minVersion);

    if (requiresUpdate) {
        overlay.classList.remove('hidden');
        if (msgEl && settings.force_update_message) {
            msgEl.textContent = settings.force_update_message;
        }
        if (linkEl && settings.force_update_url) {
            linkEl.href = settings.force_update_url;
        }
    } else {
        overlay.classList.add('hidden');
    }
}

/**
 * تطبيق مفاتيح الميزات (Feature Flags)
 * عند تعطيل أي ميزة، تختفي من التطبيق ويظهر مكانها كارت توضيحي أنيق يوضح التعطيل الإداري
 */
function applyFeatureFlags(settings) {
    if (!settings) return;

    // 1. القصص والستوريز (Stories)
    const storiesBar = document.getElementById('storiesBar');
    let storiesNotice = document.getElementById('storiesDisabledNotice');
    if (settings.feature_stories_enabled === false) {
        if (storiesBar) storiesBar.classList.add('hidden');
        if (!storiesNotice && storiesBar && storiesBar.parentNode) {
            storiesNotice = document.createElement('div');
            storiesNotice.id = 'storiesDisabledNotice';
            storiesNotice.className = 'p-3.5 bg-lux-900/60 border border-lux-800/80 rounded-2xl text-center my-2 space-y-0.5';
            storiesNotice.innerHTML = `
                <div class="text-xs font-bold text-lux-300">القصص والستوريز معطلة حالياً</div>
                <p class="text-[11px] text-lux-500 font-medium">تم إيقاف نشر ومشاهدة القصص مؤقتاً بقرار إداري</p>
            `;
            storiesBar.parentNode.insertBefore(storiesNotice, storiesBar);
        } else if (storiesNotice) {
            storiesNotice.classList.remove('hidden');
        }
    } else {
        if (storiesBar) storiesBar.classList.remove('hidden');
        if (storiesNotice) storiesNotice.classList.add('hidden');
    }

    // 2. الأسئلة اليومية (Daily Questions)
    const dqCard1 = document.getElementById('dailyQuestionCard1');
    const dqCard2 = document.getElementById('dailyQuestionCard2');
    let dqNotice = document.getElementById('dailyQuestionsDisabledNotice');
    if (settings.feature_daily_question_enabled === false) {
        if (dqCard1) dqCard1.classList.add('hidden');
        if (dqCard2) dqCard2.classList.add('hidden');
        if (!dqNotice && dqCard1 && dqCard1.parentNode) {
            dqNotice = document.createElement('div');
            dqNotice.id = 'dailyQuestionsDisabledNotice';
            dqNotice.className = 'dq-card bg-lux-900 rounded-3xl p-6 shadow-soft-card border border-lux-800 text-center space-y-2.5 my-3';
            dqNotice.innerHTML = `
                <div class="w-10 h-10 mx-auto rounded-2xl bg-lux-800/80 border border-lux-700 flex items-center justify-center text-lux-400">
                    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12L15 14"/></svg>
                </div>
                <h3 class="font-black text-lux-100 text-sm">مسابقة الأسئلة اليومية معطلة حالياً</h3>
                <p class="text-xs text-lux-400 font-medium leading-relaxed max-w-[280px] mx-auto">
                    تم إيقاف مسابقة الأسئلة اليومية بقرار إداري، انتظرونا قريباً في التحديات القادمة.
                </p>
            `;
            dqCard1.parentNode.insertBefore(dqNotice, dqCard1);
        } else if (dqNotice) {
            dqNotice.classList.remove('hidden');
        }
    } else {
        if (dqCard1) dqCard1.classList.remove('hidden');
        if (dqCard2) dqCard2.classList.remove('hidden');
        if (dqNotice) dqNotice.classList.add('hidden');
    }

    // 3. المنشورات (Posts)
    const postsSection = document.getElementById('postsSection');
    let postsNotice = document.getElementById('postsDisabledNotice');
    if (settings.feature_posts_enabled === false) {
        if (postsSection) postsSection.classList.add('hidden');
        if (!postsNotice && postsSection && postsSection.parentNode) {
            postsNotice = document.createElement('div');
            postsNotice.id = 'postsDisabledNotice';
            postsNotice.className = 'p-6 bg-lux-900 rounded-3xl border border-lux-800 text-center space-y-2 my-4';
            postsNotice.innerHTML = `
                <div class="text-sm font-black text-lux-100">قسم المنشورات معطل حالياً</div>
                <p class="text-xs text-lux-400 font-medium">تم إيقاف تغذية المنشورات العامة مؤقتاً بقرار إداري</p>
            `;
            postsSection.parentNode.insertBefore(postsNotice, postsSection);
        } else if (postsNotice) {
            postsNotice.classList.remove('hidden');
        }
    } else {
        if (postsSection) postsSection.classList.remove('hidden');
        if (postsNotice) postsNotice.classList.add('hidden');
    }

    // 4. لوحة المتصدرين (Leaderboard)
    const lbContent = document.getElementById('leaderboardMainContent');
    const lbTab = document.getElementById('tab-leaderboard');
    let lbNotice = document.getElementById('leaderboardDisabledNotice');
    if (settings.feature_leaderboard_enabled === false) {
        if (lbContent) lbContent.classList.add('hidden');
        if (!lbNotice && lbTab) {
            lbNotice = document.createElement('div');
            lbNotice.id = 'leaderboardDisabledNotice';
            lbNotice.className = 'p-7 bg-lux-900 rounded-3xl border border-lux-800 text-center space-y-3 m-4';
            lbNotice.innerHTML = `
                <div class="text-base font-black text-gold-400">لوحة المتصدرين مغلقة مؤقتاً</div>
                <p class="text-xs text-lux-400 font-medium leading-relaxed">
                    يتم حالياً تدقيق واحتساب نتائج البطولة وترتيب المراكز وتجهيز الجوائز، سنعاود فتح اللوحة قريباً.
                </p>
            `;
            lbTab.appendChild(lbNotice);
        } else if (lbNotice) {
            lbNotice.classList.remove('hidden');
        }
    } else {
        if (lbContent) lbContent.classList.remove('hidden');
        if (lbNotice) lbNotice.classList.add('hidden');
    }

    // 5. شات الدعم الفني للمغتربين (Support Chat)
    const supportFab = document.getElementById('supportInboxFab');
    const supportHeaderBtn = document.getElementById('btnSupportHelp');
    const supportBannerBtn = document.getElementById('guestBannerSupportBtn');
    const isSupportOff = settings.feature_support_chat_enabled === false;

    if (supportFab) supportFab.classList.toggle('hidden', isSupportOff);
    if (supportHeaderBtn) {
        supportHeaderBtn.classList.toggle('opacity-40', isSupportOff);
        supportHeaderBtn.classList.toggle('pointer-events-none', isSupportOff);
    }
    if (supportBannerBtn) {
        supportBannerBtn.classList.toggle('opacity-40', isSupportOff);
        supportBannerBtn.classList.toggle('pointer-events-none', isSupportOff);
    }

    // 6. التعليقات (Comments)
    const isCommentsOff = settings.feature_comments_enabled === false;
    document.body.classList.toggle('feature-comments-disabled', isCommentsOff);

    let commentsStyle = document.getElementById('featureCommentsDisabledStyle');
    if (isCommentsOff && !commentsStyle) {
        commentsStyle = document.createElement('style');
        commentsStyle.id = 'featureCommentsDisabledStyle';
        commentsStyle.textContent = `
            body.feature-comments-disabled .post-comments-container form,
            body.feature-comments-disabled .post-comment-form,
            body.feature-comments-disabled .btn-open-comment-form,
            body.feature-comments-disabled .post-card-comment-input-row {
                display: none !important;
            }
        `;
        document.head.appendChild(commentsStyle);
    } else if (!isCommentsOff && commentsStyle) {
        commentsStyle.remove();
    }

    // إرسال حدث عام لباقي أجزاء التطبيق للاستجابة للتغييرات
    document.dispatchEvent(new CustomEvent('app:feature-flags', {
        detail: { settings }
    }));
}

/**
 * تطبيق الإعلان المنبثق العام (In-App Announcement Modal)
 */
function applyAnnouncementModal(settings) {
    const modal = document.getElementById('announcementModal');
    if (!modal) return;

    const isEnabled = Boolean(settings?.announcement_enabled);
    const announcementId = settings?.announcement_id || 'announcement_default';

    if (!isEnabled) {
        modal.classList.add('hidden');
        return;
    }

    // التحقق هل شاهد المستخدم هذا الإعلان من قبل
    const storageKey = 'sakkawi_announcement_' + announcementId;
    if (localStorage.getItem(storageKey) === 'seen') {
        modal.classList.add('hidden');
        return;
    }

    const titleEl = document.getElementById('announcementModalTitle');
    const bodyEl = document.getElementById('announcementModalBody');
    const imgEl = document.getElementById('announcementModalImage');
    const actionBtn = document.getElementById('announcementModalActionBtn');
    const closeBtn = document.getElementById('announcementModalCloseBtn');

    if (titleEl) titleEl.textContent = settings.announcement_title || 'إعلان هام';
    if (bodyEl) bodyEl.textContent = settings.announcement_body || '';

    if (imgEl) {
        if (settings.announcement_image_url) {
            imgEl.src = settings.announcement_image_url;
            imgEl.classList.remove('hidden');
        } else {
            imgEl.classList.add('hidden');
        }
    }

    if (actionBtn) {
        actionBtn.textContent = settings.announcement_button_text || 'حسناً';
        actionBtn.onclick = () => {
            localStorage.setItem(storageKey, 'seen');
            modal.classList.add('hidden');
            if (settings.announcement_button_url) {
                window.open(settings.announcement_button_url, '_blank');
            }
        };
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            localStorage.setItem(storageKey, 'seen');
            modal.classList.add('hidden');
        };
    }

    modal.classList.remove('hidden');
}

/**
 * تطبيق شارة مضاعفة النقاط في الهيدر وكروت الإحصائيات (Double XP Badge)
 */
function applyPointsMultiplierBadge(settings) {
    const badgeEl = document.getElementById('pointsMultiplierBadge');
    if (!badgeEl) return;

    const multiplier = parseFloat(settings?.points_multiplier) || 1.0;
    const isExpired = settings?.points_multiplier_expires_at && new Date(settings.points_multiplier_expires_at).getTime() < Date.now();

    if (multiplier > 1.0 && !isExpired) {
        const title = settings.points_multiplier_title || 'مضاعفة النقاط نشطة';
        badgeEl.textContent = multiplier + 'x ' + title;
        badgeEl.classList.remove('hidden');
    } else {
        badgeEl.classList.add('hidden');
    }
}

/**
 * تطبيق كافة الإعدادات الرئيسية دفعة واحدة
 */
export function applyMasterSettings(settings) {
    if (!settings) return;
    currentSettings = settings;
    window.currentMasterSettings = settings;

    applyMaintenanceMode(settings);
    applyForceUpdate(settings);
    applyFeatureFlags(settings);
    applyAnnouncementModal(settings);
    applyPointsMultiplierBadge(settings);
}

/**
 * تهيئة وتحميل إعدادات التحكم الشاملة والاشتراك في Realtime
 */
export async function initMasterControl() {
    try {
        const { data, error } = await supabaseClient
            .from('app_settings')
            .select('*')
            .eq('id', 1)
            .single();

        if (error) {
            console.warn('تعذر تحميل إعدادات التحكم الرئيسية:', error.message);
            return;
        }

        applyMasterSettings(data);

        // اشتراك Realtime لحظي لأي تعديل من لوحة الأدمن
        supabaseClient
            .channel('realtime_app_settings')
            .on(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: 'id=eq.1' },
                (payload) => {
                    applyMasterSettings(payload.new);
                }
            )
            .subscribe();

    } catch (err) {
        console.error('خطأ غير متوقع في تهيئة master-control:', err);
    }
}

// تشغيل تلقائي عند اكتمال تحميل الصفحة
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initMasterControl());
} else {
    initMasterControl();
}

// إعادة تطبيق مفاتيح الميزات عند التنقل بين التابات أو عند إعادة رسم المكونات
window.addEventListener('hashchange', () => {
    if (currentSettings) applyFeatureFlags(currentSettings);
});
document.addEventListener('app:tab-changed', () => {
    if (currentSettings) applyFeatureFlags(currentSettings);
});
document.addEventListener('app:stories-rendered', () => {
    if (currentSettings) applyFeatureFlags(currentSettings);
});
document.addEventListener('app:posts-rendered', () => {
    if (currentSettings) applyFeatureFlags(currentSettings);
});

// فحص تأكيدي بعد اكتمال تهيئة السكريبتات الأخرى
setTimeout(() => { if (currentSettings) applyFeatureFlags(currentSettings); }, 500);
setTimeout(() => { if (currentSettings) applyFeatureFlags(currentSettings); }, 1500);

