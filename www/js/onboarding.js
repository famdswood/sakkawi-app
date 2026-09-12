/* ==================================================================
   سِكّاوي | js/onboarding.js
   ------------------------------------------------------------------
   شاشات الترحيب التفاعلية (Onboarding) فائقة الخفة والسرعة (60fps) -
   8 سلايدات محتوى + سلايد تاسع للكأس وأزرار الدخول.

   محرك رسومات Lottie الاحترافي فائق الأداء:
   1) استرجاع كافة الرسومات التفاعلية الأصلية كاملة وبأعلى جودة.
   2) فصل بيانات الـ JSON في ملف مستقل (js/onboarding-lottie-data.js)
      لتحميل فوري وتخفيف كود الواجهة.
   3) كاش دائم للرسومات (Persistent Instance Caching) بدون هدم أو إعادة بناء،
      مع تحكم دقيق في Play/Pause لتوفير 100% من قدرة المعالج.
   4) تهيئة السلايدات الجديدة عبر requestAnimationFrame بدون تعطيل تحريك السحب.
   5) تحميل مسبق ذكي (Idle Preload) للسلايد التالي في الخلفية.
   6) دعم كامل لإيماءات السحب باللمس للواجهة العربية (RTL) ولوحة المفاتيح.
   ================================================================== */

import { showAuthModal, hideAuthModal, markGuestModeActive } from './auth.js';
import { checkLocationForSignup, GeofenceLocationError } from './geofence.js';

const STORAGE_KEY = 'sakkawy:onboardingSeen';
const TOTAL_SLIDES = 9;

/**
 * يشغّل فحص الموقع الجغرافي (GPS + مسافة، من غير أي كتابة في قاعدة
 * البيانات لأن معندناش userId لسه) ويرجع قرار واضح مع رسالة عربية
 * جاهزة للعرض في حالة الرفض.
 *
 * @returns {Promise<{ allowed: boolean, message: string }>}
 */
async function evaluateSignupLocationGate() {
    try {
        const { isInsideBounds } = await checkLocationForSignup();

        if (isInsideBounds) {
            return { allowed: true, message: '' };
        }

        return {
            allowed: false,
            message: 'التطبيق مخصص حصريًا لأهالي قرية نزلة عبيد. موقعك الحالي خارج النطاق المسموح به، لذلك لا يمكن إنشاء حساب جديد من هنا. إذا كنت من أهالي القرية وتتواجد بالخارج، يمكنك التواصل مع الدعم الفني للمغتربين.',
        };
    } catch (error) {
        const isLocationError = error instanceof GeofenceLocationError;

        return {
            allowed: false,
            message: isLocationError
                ? error.message
                : 'تعذّر التحقق من موقعك الجغرافي حاليًا. يرجى المحاولة مرة أخرى بعد قليل.',
        };
    }
}

/**
 * فلاج: true طول ما initOnboarding() شغالة وشاشتها ظاهرة.
 * لحماية showAuthGate() من التنافس معها على عناصر الـ DOM.
 */
let firstRunOnboardingActive = false;

function hasSeenOnboarding() {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
        return false;
    }
}

function markOnboardingSeen() {
    try {
        localStorage.setItem(STORAGE_KEY, '1');
    } catch (err) {
        // فشل الوصول لـ localStorage - تجاهل بهدوء
    }
}

/**
 * اهتزاز لمسي خفيف مع التنقل
 */
function playHapticTick() {
    if ('vibrate' in navigator) navigator.vibrate(15);
}

/**
 * كونفيتي ذهبي خفيف عند الوصول للسلايد الأخير
 */
function burstGoldConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const originY = canvas.height * 0.42;
    const colors = ['#D4AF37', '#F2D77E', '#FFF6D1', '#B8942A'];
    const pieces = [];

    for (let i = 0; i < 50; i++) {
        pieces.push({
            x: canvas.width / 2,
            y: originY,
            vx: (Math.random() - 0.5) * 10,
            vy: (Math.random() - 0.85) * 12,
            size: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            rotSpeed: (Math.random() - 0.5) * 8,
        });
    }

    let opacity = 1;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pieces.forEach((p) => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.28;
            p.rotation += p.rotSpeed;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = opacity;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
        });

        opacity -= 0.018;
        if (opacity > 0) {
            requestAnimationFrame(animate);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    animate();
}

/* ------------------------------------------------------------------
   محرك إدارة رسومات Lottie التفاعلية (فائق النعومة والسرعة 60fps)
   ------------------------------------------------------------------ */
const LOTTIE_CONFIGS = {
    1: { id: 'onbWalkLottie', fallback: '.onb-walk-fallback', key: 'walk', loop: true, rendererSettings: { preserveAspectRatio: 'xMidYMid slice' } },
    2: { id: 'onbQuizLottie', fallback: '.onb-quiz-fallback', key: 'quiz', loop: true },
    3: { id: 'onbLocationLottie', fallback: '.onb-location-fallback', key: 'location', loop: true },
    4: { id: 'onbRankLottie', fallback: '.onb-rank-fallback', key: 'rank', loop: true },
    5: { id: 'onbPointsLottie', fallback: '.onb-points-fallback', key: 'points', loop: true },
    7: { id: 'onbWritingLottie', fallback: '.onb-writing-fallback', key: 'writing', loop: true },
    8: { id: 'onbTrophyLottie', fallback: '.onb-trophy-fallback', key: 'trophy', loop: false },
};

const lottieInstances = new Map();

function showFallbackForSlide(index) {
    const config = LOTTIE_CONFIGS[index];
    if (!config) return;
    const container = document.getElementById(config.id);
    if (container) container.style.display = 'none';
    const fallback = document.querySelector(config.fallback);
    if (fallback) {
        const activeClass = config.fallback.replace('.', '') + '-active';
        fallback.classList.add(activeClass);
    }
}

function getOrInitLottie(index) {
    if (lottieInstances.has(index)) {
        return lottieInstances.get(index);
    }
    const config = LOTTIE_CONFIGS[index];
    if (!config) return null;

    if (!window.lottie || !window.ONB_LOTTIE_DATA || !window.ONB_LOTTIE_DATA[config.key]) {
        showFallbackForSlide(index);
        return null;
    }

    const container = document.getElementById(config.id);
    if (!container) {
        showFallbackForSlide(index);
        return null;
    }

    try {
        const anim = window.lottie.loadAnimation({
            container,
            renderer: 'svg',
            loop: config.loop,
            autoplay: false,
            animationData: window.ONB_LOTTIE_DATA[config.key],
            rendererSettings: config.rendererSettings || undefined,
        });

        anim.addEventListener('data_failed', () => showFallbackForSlide(index));
        anim.addEventListener('error', () => showFallbackForSlide(index));

        lottieInstances.set(index, anim);
        return anim;
    } catch (err) {
        showFallbackForSlide(index);
        return null;
    }
}

function playSlideLottie(index) {
    // إيقاف أي أنيميشن في سلايد آخر لتوفير 100% من قدرة المعالج أثناء التنقل
    lottieInstances.forEach((anim, i) => {
        if (i !== index && anim) {
            try { anim.pause(); } catch (e) {}
        }
    });

    if (LOTTIE_CONFIGS[index]) {
        const existing = lottieInstances.get(index);
        if (existing) {
            // الأنيميشن جاهز ومحمّل مسبقاً: تشغيل فوري بدون أي تأخير
            try {
                if (index === 8) {
                    existing.goToAndStop(0, true);
                }
                existing.play();
            } catch (e) {}
        } else {
            // تهيئة السلايد الجديد بنعومة في الفريم التالي حتى لا يتعطل تحريك السحب
            requestAnimationFrame(() => {
                const newAnim = getOrInitLottie(index);
                if (newAnim) {
                    try {
                        if (index === 8) {
                            newAnim.goToAndStop(0, true);
                        }
                        newAnim.play();
                    } catch (e) {}
                }
            });
        }
    }

    // تجهيز السلايدات التالية في الخلفية بذكاء أثناء قراءة المستخدم للسلايد الحالي
    preloadAdjacentLottie(index);
}

function preloadAdjacentLottie(currentIndex) {
    const candidates = [currentIndex + 1, currentIndex + 2];
    for (const idx of candidates) {
        if (LOTTIE_CONFIGS[idx] && !lottieInstances.has(idx)) {
            window.setTimeout(() => {
                getOrInitLottie(idx);
            }, 300);
            break;
        }
    }
}

function destroyAllLotties() {
    lottieInstances.forEach((anim) => {
        try { anim.destroy(); } catch (e) {}
    });
    lottieInstances.clear();
}

/* ------------------------------------------------------------------
   نقطة الدخول الرئيسية لرحلة السلايدات الأولى
   ------------------------------------------------------------------ */
export function initOnboarding() {
    return new Promise((resolve) => {
        if (hasSeenOnboarding()) {
            resolve(null);
            return;
        }

        const overlay = document.getElementById('onboardingOverlay');
        if (!overlay) {
            resolve(null);
            return;
        }

        overlay.classList.remove('hidden');
        firstRunOnboardingActive = true;
        document.body.classList.add('onb-scroll-lock');

        const glow1 = document.getElementById('onbGlow1');
        const glow2 = document.getElementById('onbGlow2');
        const nextBtn = document.getElementById('onbNextBtn');
        const nextBtnText = document.getElementById('onbNextBtnText');
        const skipBtn = document.getElementById('onbSkipBtn');
        const bullets = Array.from(overlay.querySelectorAll('.onb-bullet'));
        const slides = Array.from(overlay.querySelectorAll('.onb-page'));

        const authFormDock = document.getElementById('onbAuthFormDock');
        const authFormSlot = document.getElementById('onbAuthFormSlot');
        const authPageTitle = document.getElementById('onbAuthPageTitle');
        const authBackBtn = document.getElementById('onbAuthBackBtn');

        const signupBtn = document.getElementById('onbSignupBtn');
        const loginBtn = document.getElementById('onbLoginBtn');
        const locationRejectedDock = document.getElementById('onbLocationRejectedDock');
        const locationRejectedMessage = document.getElementById('onbLocationRejectedMessage');
        const locationRejectedBackBtn = document.getElementById('onbLocationRejectedBackBtn');
        const locationRetryBtn = document.getElementById('onbLocationRetryBtn');
        const guestBrowseBtn = document.getElementById('onbGuestBrowseBtn');
        const choiceGuestBrowseBtn = document.getElementById('onbChoiceGuestBrowseBtn');

        const AUTH_PAGE_TRANSITION_MS = 220;
        let pendingAuthIntent = null;
        let trophyCelebrated = false;
        let currentIndex = 0;
        let isNavigating = false;

        /**
         * التنقل السلس بين السلايدات مع قفل زمني خفيف (Debounce) لمنع التهنيج
         */
        function goToPage(index) {
            if (index < 0 || index >= TOTAL_SLIDES || index === currentIndex || isNavigating) return;
            isNavigating = true;
            window.setTimeout(() => { isNavigating = false; }, 180);

            currentIndex = index;

            slides.forEach((slide, i) => {
                slide.classList.toggle('onb-page-active', i === index);
            });

            updateSlideExperience(index);
            playHapticTick();

            // تشغيل أنيميشن السلايد النشط فقط وإيقاف الباقي
            playSlideLottie(index);

            // عند الوصول للسلايد الأخير (الكأس)
            if (index === TOTAL_SLIDES - 1) {
                if (!trophyCelebrated) {
                    trophyCelebrated = true;
                    window.setTimeout(burstGoldConfetti, 250);
                }
            }
        }

        function updateSlideExperience(index) {
            const activeSlide = slides[index];
            if (!activeSlide) return;

            const c1 = activeSlide.getAttribute('data-glow1') || '#D4AF37';
            const c2 = activeSlide.getAttribute('data-glow2') || '#B8942A';
            const accent = activeSlide.getAttribute('data-accent') || '#D4AF37';

            if (glow1) glow1.style.backgroundColor = c1;
            if (glow2) glow2.style.backgroundColor = c2;
            overlay.style.setProperty('--onb-active-accent', accent);

            bullets.forEach((b, i) => b.classList.toggle('onb-bullet-active', i === index));

            const isLast = index === TOTAL_SLIDES - 1;
            if (nextBtnText) nextBtnText.textContent = isLast ? 'يلا بينا' : 'التالي';
            if (nextBtn) {
                nextBtn.classList.toggle('opacity-0', isLast);
                nextBtn.classList.toggle('pointer-events-none', isLast);
            }
            if (skipBtn) {
                skipBtn.classList.toggle('opacity-0', isLast);
                skipBtn.classList.toggle('pointer-events-none', isLast);
            }
        }

        // إظهار السلايد الأول وتفعيل حالته وتشغيل محرك الأنيميشن الذكي
        slides.forEach((slide, i) => {
            slide.classList.toggle('onb-page-active', i === 0);
        });
        updateSlideExperience(0);
        playSlideLottie(0);

        // التنقل عبر نقاط الترقيم
        bullets.forEach((bullet) => {
            bullet.addEventListener('click', () => {
                goToPage(parseInt(bullet.getAttribute('data-index'), 10));
            });
        });

        // زرار التالي
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                goToPage(currentIndex + 1);
            });
        }

        // زرار التخطي
        if (skipBtn) {
            skipBtn.addEventListener('click', () => {
                goToPage(TOTAL_SLIDES - 1);
            });
        }

        /* --------------------------------------------------------------
           دعم إيماءات السحب باللمس (Touch Swipe Gestures) السلسة
           -------------------------------------------------------------- */
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        let isSwiping = false;

        function onTouchStart(e) {
            if (!authFormDock.classList.contains('hidden') || !locationRejectedDock.classList.contains('hidden')) {
                return;
            }
            if (!e.touches || e.touches.length === 0) return;
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            touchStartTime = Date.now();
            isSwiping = true;
        }

        function onTouchEnd(e) {
            if (!isSwiping) return;
            isSwiping = false;

            if (!authFormDock.classList.contains('hidden') || !locationRejectedDock.classList.contains('hidden')) {
                return;
            }

            if (!e.changedTouches || e.changedTouches.length === 0) return;
            const touch = e.changedTouches[0];
            const deltaX = touch.clientX - touchStartX;
            const deltaY = touch.clientY - touchStartY;
            const elapsed = Date.now() - touchStartTime;

            // التأكد من أن الحركة أفقية وليست تمريرًا رأسيًا
            if (Math.abs(deltaX) > Math.abs(deltaY) * 1.3 && Math.abs(deltaX) > 35 && elapsed < 700) {
                if (deltaX < 0) {
                    // سحب لليسار = التقدم للأمام في الواجهة العربية
                    if (currentIndex < TOTAL_SLIDES - 1) {
                        goToPage(currentIndex + 1);
                    }
                } else {
                    // سحب لليمين = الرجوع للخلف
                    if (currentIndex > 0) {
                        goToPage(currentIndex - 1);
                    }
                }
            }
        }

        overlay.addEventListener('touchstart', onTouchStart, { passive: true });
        overlay.addEventListener('touchend', onTouchEnd, { passive: true });

        // دعم التنقل عبر مفاتيح الأسهم (للتجربة على المتصفح أو أجهزة التحكم)
        function onKeyDown(e) {
            if (!authFormDock.classList.contains('hidden') || !locationRejectedDock.classList.contains('hidden')) return;
            if (e.key === 'ArrowLeft') {
                goToPage(currentIndex + 1);
            } else if (e.key === 'ArrowRight') {
                goToPage(currentIndex - 1);
            }
        }
        window.addEventListener('keydown', onKeyDown);

        function finish(authIntent) {
            destroyAllLotties();
            document.removeEventListener('auth:signed-in', handleAuthSuccessDuringOnboarding);
            overlay.removeEventListener('touchstart', onTouchStart);
            overlay.removeEventListener('touchend', onTouchEnd);
            window.removeEventListener('keydown', onKeyDown);

            markOnboardingSeen();
            firstRunOnboardingActive = false;
            overlay.classList.add('hidden');
            document.body.classList.add('onb-gate-dismissed');
            document.body.classList.remove('onb-scroll-lock');
            resolve(authIntent);
        }

        function revealAuthForm(intent) {
            pendingAuthIntent = intent;

            if (authPageTitle) {
                authPageTitle.textContent = intent === 'signup' ? 'إنشاء حساب جديد' : 'تسجيل الدخول';
            }

            authFormDock.classList.remove('hidden');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    authFormDock.classList.add('onb-auth-page-visible');
                });
            });

            showAuthModal(intent === 'signup' ? 'signup' : 'signin', { dockTarget: authFormSlot });
        }

        function returnToChoiceView() {
            hideAuthModal();
            authFormDock.classList.remove('onb-auth-page-visible');
            window.setTimeout(() => {
                authFormDock.classList.add('hidden');
            }, AUTH_PAGE_TRANSITION_MS);
            pendingAuthIntent = null;
        }

        function handleAuthSuccessDuringOnboarding() {
            if (authFormDock.classList.contains('hidden')) return;
            finish(pendingAuthIntent || 'login');
        }

        document.addEventListener('auth:signed-in', handleAuthSuccessDuringOnboarding);

        function showLocationRejected(message) {
            if (locationRejectedMessage) {
                locationRejectedMessage.textContent = message;
            }

            locationRejectedDock.classList.remove('hidden');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    locationRejectedDock.classList.add('onb-auth-page-visible');
                });
            });
        }

        function hideLocationRejected() {
            locationRejectedDock.classList.remove('onb-auth-page-visible');
            window.setTimeout(() => {
                locationRejectedDock.classList.add('hidden');
            }, AUTH_PAGE_TRANSITION_MS);
        }

        async function onSignupClick() {
            playHapticTick();

            const originalLabel = signupBtn.innerHTML;
            signupBtn.disabled = true;
            signupBtn.setAttribute('aria-busy', 'true');
            signupBtn.innerHTML = '<span>بنتحقق من موقعك...</span>';

            const result = await evaluateSignupLocationGate();

            signupBtn.disabled = false;
            signupBtn.removeAttribute('aria-busy');
            signupBtn.innerHTML = originalLabel;

            if (result.allowed) {
                revealAuthForm('signup');
            } else {
                showLocationRejected(result.message);
            }
        }

        if (signupBtn) signupBtn.addEventListener('click', onSignupClick);

        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                playHapticTick();
                revealAuthForm('login');
            });
        }

        if (locationRejectedBackBtn) {
            locationRejectedBackBtn.addEventListener('click', () => {
                playHapticTick();
                hideLocationRejected();
            });
        }

        if (locationRetryBtn) {
            locationRetryBtn.addEventListener('click', () => {
                hideLocationRejected();
                window.setTimeout(onSignupClick, AUTH_PAGE_TRANSITION_MS);
            });
        }

        if (guestBrowseBtn) {
            guestBrowseBtn.addEventListener('click', () => {
                playHapticTick();
                markGuestModeActive();
                finish('guest-browse');
            });
        }

        if (choiceGuestBrowseBtn) {
            choiceGuestBrowseBtn.addEventListener('click', () => {
                playHapticTick();
                markGuestModeActive();
                finish('guest-browse');
            });
        }

        if (authBackBtn) {
            authBackBtn.addEventListener('click', () => {
                playHapticTick();
                returnToChoiceView();
            });
        }

        updateSlideExperience(0);
    });
}

/* ------------------------------------------------------------------
   بوابة الدخول بعد تسجيل الخروج (Logout Gate)
   ------------------------------------------------------------------ */
export function showAuthGate(initialIntent = null) {
    if (firstRunOnboardingActive) return;

    const overlay = document.getElementById('onboardingOverlay');
    if (!overlay) {
        showAuthModal();
        return;
    }

    if (overlay.classList.contains('onb-gate-active')) return;
    overlay.classList.add('onb-gate-active');
    overlay.classList.remove('hidden');
    document.body.classList.add('onb-scroll-lock');

    const skipBtn = document.getElementById('onbSkipBtn');
    const footer = overlay.querySelector('footer');
    const slides = Array.from(overlay.querySelectorAll('.onb-page'));
    const lastSlide = slides[slides.length - 1];

    slides.forEach((slide) => {
        const isLast = slide === lastSlide;
        slide.style.display = isLast ? '' : 'none';
        slide.classList.toggle('onb-page-active', isLast);
    });
    if (skipBtn) skipBtn.style.display = 'none';
    if (footer) footer.style.display = 'none';

    const glow1 = document.getElementById('onbGlow1');
    const glow2 = document.getElementById('onbGlow2');
    if (lastSlide) {
        const c1 = lastSlide.getAttribute('data-glow1') || '#D4AF37';
        const c2 = lastSlide.getAttribute('data-glow2') || '#B8942A';
        const accent = lastSlide.getAttribute('data-accent') || '#D4AF37';
        if (glow1) glow1.style.backgroundColor = c1;
        if (glow2) glow2.style.backgroundColor = c2;
        overlay.style.setProperty('--onb-active-accent', accent);
    }

    // تشغيل أنيميشن الكأس الذهبي للسلايد الأخير مع احتفال الكونفيتي
    playSlideLottie(8);
    window.setTimeout(burstGoldConfetti, 250);

    const authFormDock = document.getElementById('onbAuthFormDock');
    const authFormSlot = document.getElementById('onbAuthFormSlot');
    const authPageTitle = document.getElementById('onbAuthPageTitle');
    const authBackBtn = document.getElementById('onbAuthBackBtn');
    const signupBtn = document.getElementById('onbSignupBtn');
    const loginBtn = document.getElementById('onbLoginBtn');

    const locationRejectedDock = document.getElementById('onbLocationRejectedDock');
    const locationRejectedMessage = document.getElementById('onbLocationRejectedMessage');
    const locationRejectedBackBtn = document.getElementById('onbLocationRejectedBackBtn');
    const locationRetryBtn = document.getElementById('onbLocationRetryBtn');
    const guestBrowseBtn = document.getElementById('onbGuestBrowseBtn');
    const choiceGuestBrowseBtn = document.getElementById('onbChoiceGuestBrowseBtn');

    const AUTH_PAGE_TRANSITION_MS = 220;

    authFormDock.classList.add('hidden');
    authFormDock.classList.remove('onb-auth-page-visible');
    locationRejectedDock.classList.add('hidden');
    locationRejectedDock.classList.remove('onb-auth-page-visible');

    function revealAuthForm(intent) {
        if (authPageTitle) {
            authPageTitle.textContent = intent === 'signup' ? 'إنشاء حساب جديد' : 'تسجيل الدخول';
        }

        authFormDock.classList.remove('hidden');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                authFormDock.classList.add('onb-auth-page-visible');
            });
        });

        showAuthModal(intent === 'signup' ? 'signup' : 'signin', { dockTarget: authFormSlot });
    }

    function returnToChoiceView() {
        hideAuthModal();
        authFormDock.classList.remove('onb-auth-page-visible');
        window.setTimeout(() => {
            authFormDock.classList.add('hidden');
        }, AUTH_PAGE_TRANSITION_MS);
    }

    function showLocationRejected(message) {
        if (locationRejectedMessage) {
            locationRejectedMessage.textContent = message;
        }

        locationRejectedDock.classList.remove('hidden');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                locationRejectedDock.classList.add('onb-auth-page-visible');
            });
        });
    }

    function hideLocationRejected() {
        locationRejectedDock.classList.remove('onb-auth-page-visible');
        window.setTimeout(() => {
            locationRejectedDock.classList.add('hidden');
        }, AUTH_PAGE_TRANSITION_MS);
    }

    async function onSignupClick() {
        playHapticTick();

        const originalLabel = signupBtn.innerHTML;
        signupBtn.disabled = true;
        signupBtn.setAttribute('aria-busy', 'true');
        signupBtn.innerHTML = '<span>بنتحقق من موقعك...</span>';

        const result = await evaluateSignupLocationGate();

        signupBtn.disabled = false;
        signupBtn.removeAttribute('aria-busy');
        signupBtn.innerHTML = originalLabel;

        if (result.allowed) {
            revealAuthForm('signup');
        } else {
            showLocationRejected(result.message);
        }
    }

    function onLoginClick() {
        playHapticTick();
        revealAuthForm('login');
    }

    function onBackClick() {
        playHapticTick();
        returnToChoiceView();
    }

    function onLocationRejectedBackClick() {
        playHapticTick();
        hideLocationRejected();
    }

    function onLocationRetryClick() {
        hideLocationRejected();
        window.setTimeout(onSignupClick, AUTH_PAGE_TRANSITION_MS);
    }

    function onGuestBrowseClick() {
        playHapticTick();
        markGuestModeActive();
        cleanup();
        document.dispatchEvent(new CustomEvent('app:enter-guest-browsing'));
    }

    function cleanup() {
        destroyAllLotties();
        document.removeEventListener('auth:signed-in', handleAuthSuccess);
        if (signupBtn) signupBtn.removeEventListener('click', onSignupClick);
        if (loginBtn) loginBtn.removeEventListener('click', onLoginClick);
        if (authBackBtn) authBackBtn.removeEventListener('click', onBackClick);
        if (locationRejectedBackBtn) locationRejectedBackBtn.removeEventListener('click', onLocationRejectedBackClick);
        if (locationRetryBtn) locationRetryBtn.removeEventListener('click', onLocationRetryClick);
        if (guestBrowseBtn) guestBrowseBtn.removeEventListener('click', onGuestBrowseClick);
        if (choiceGuestBrowseBtn) choiceGuestBrowseBtn.removeEventListener('click', onGuestBrowseClick);

        overlay.classList.add('hidden');
        overlay.classList.remove('onb-gate-active');
        document.body.classList.remove('onb-scroll-lock');
        document.body.classList.add('onb-gate-dismissed');

        slides.forEach((slide) => {
            slide.style.removeProperty('display');
            slide.classList.remove('onb-page-active');
        });
        if (skipBtn) skipBtn.style.removeProperty('display');
        if (footer) footer.style.removeProperty('display');
        authFormDock.classList.add('hidden');
        authFormDock.classList.remove('onb-auth-page-visible');
        locationRejectedDock.classList.add('hidden');
        locationRejectedDock.classList.remove('onb-auth-page-visible');
    }

    function handleAuthSuccess() {
        cleanup();
    }

    document.addEventListener('auth:signed-in', handleAuthSuccess);
    if (signupBtn) signupBtn.addEventListener('click', onSignupClick);
    if (loginBtn) loginBtn.addEventListener('click', onLoginClick);
    if (authBackBtn) authBackBtn.addEventListener('click', onBackClick);
    if (locationRejectedBackBtn) locationRejectedBackBtn.addEventListener('click', onLocationRejectedBackClick);
    if (locationRetryBtn) locationRetryBtn.addEventListener('click', onLocationRetryClick);
    if (guestBrowseBtn) guestBrowseBtn.addEventListener('click', onGuestBrowseClick);
    if (choiceGuestBrowseBtn) choiceGuestBrowseBtn.addEventListener('click', onGuestBrowseClick);

    if (initialIntent === 'login') {
        onLoginClick();
    }
}
