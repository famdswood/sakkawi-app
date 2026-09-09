package com.sakkawi.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * خدمة أمامية (Foreground Service) بتفضل شغّالة حتى لو التطبيق مقفول
 * تمامًا. عندها وضعين حسب هاردوير الجهاز:
 *
 * الوضع 1 (الأفضل - أدق وأوفر بطارية): لو الجهاز عنده حساس
 * TYPE_STEP_COUNTER أصلي (شريحة Pedometer مخصصة)، بنستخدمه مباشرة.
 * الحساس ده بيرجّع "إجمالي عدد الخطوات من آخر Reboot"، فبنحسب فرق
 * (delta) من baseline محفوظ عشان نعرف خطوات اليوم بس.
 *
 * الوضع 2 (Fallback - لأي جهاز حتى لو معندوش الحساس ده): لو
 * TYPE_STEP_COUNTER مش موجود (null)، بنرجع لحساس التسارع الخام
 * (TYPE_ACCELEROMETER) - موجود في كل الأجهزة تقريبًا - ونطبّق عليه
 * نفس خوارزمية Peak Detection اللي في sensors.js بالظبط (نفس القيم:
 * GRAVITY, STEP_THRESHOLD_HIGH/LOW, STEP_COOLDOWN_MS, LOW_PASS_ALPHA)،
 * بس مكتوبة هنا Java عشان تقدر تشتغل والتطبيق مقفول.
 */
public class StepCounterForegroundService extends Service implements SensorEventListener {

    private static final String CHANNEL_ID = "sakkawi_step_tracking_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final String PREFS_NAME = "sakkawi_native_step_prefs";

    // نفس فكرة getTodayKey() في sensors.js بالظبط (صيغة yyyy-MM-dd
    // بالتوقيت المحلي للجهاز) - لازم يفضلوا متطابقين تمامًا عشان
    // المزامنة مع localStorage تشتغل صح
    private static final SimpleDateFormat DAY_FORMAT =
            new SimpleDateFormat("yyyy-MM-dd", Locale.US);

    // --- تعييرات خوارزمية الـ Fallback (accelerometer) - منسوخة
    // بالظبط من نفس القيم في sensors.js عشان يفضل سلوك العداد متسق
    // سواء اشتغل بالوضع 1 أو 2 ---
    private static final double GRAVITY = 9.81;
    // (تعديل - تقليل الخطوات الوهمية في وضع الـ Fallback) رفعنا العتبة
    // من 12.8 لـ 13.2 وزوّدنا الـ Cooldown من 350 لـ 400ms بعد ملاحظة
    // إن العداد بيحسب أعلى من الواقع بحوالي 20% على أجهزة بتستخدم هذا
    // الوضع. ⚠️ القيم دي لازم تفضل مطابقة تمامًا لنفس القيم في
    // sensors.js عشان يفضل سلوك العداد متسق - غيّرهم مع بعض دايمًا
    private static final double STEP_THRESHOLD_HIGH = 13.2;
    private static final double STEP_THRESHOLD_LOW = STEP_THRESHOLD_HIGH - 1.5; // 11.7
    private static final long STEP_COOLDOWN_MS = 400;
    private static final double LOW_PASS_ALPHA = 0.15;

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;   // الوضع 1
    private Sensor accelerometerSensor; // الوضع 2 (Fallback)
    private boolean usingFallbackMode = false;

    // (إصلاح - باج حقيقي خطير) startTracking() من الـ Plugin بتتنادى من
    // JS كل 4 ثواني (البولينج في syncFromNativeStepCounter) طول ما
    // التطبيق فاتح - وده بيعمل onStartCommand() تاني على الخدمة اللي
    // شغّالة أصلاً (مش onCreate جديد). كان ده بيسجّل نفس الـ
    // SensorEventListener تاني لنفس الحساس مرة كل 4 ثواني من غير أي
    // unregister بينهم - وأندرويد بيوصّل كل قراءة حساس *مكررة* بعدد
    // مرات التسجيل النشطة كلها. يعني بعد دقيقة بس من فتح التطبيق ممكن
    // يبقى فيه 15 تسجيل نشط لنفس الحساس، فكل خطوة حقيقية تتحسب 15 مرة!
    // ده على الأغلب هو السبب الحقيقي وراء إن العداد بيدي رقم أعلى بكتير
    // من الواقع، مش بس حساسية الخوارزمية. الحل: نسجّل الحساس مرة واحدة
    // بس لكل دورة حياة للخدمة، ونتجاهل أي نداء onStartCommand تاني
    // لسه الحساس متسجّل فيه أصلاً
    private boolean sensorListenerRegistered = false;

    // حالة خوارزمية الـ Fallback (نفس متغيرات sensors.js بالظبط)
    private double filteredMagnitude = GRAVITY;
    private boolean awaitingPeakReset = false;
    private long lastStepTimestamp = 0;
    private int fallbackStepsAccumulator = 0; // عدّاد تراكمي مستقل للـ fallback (مفيش "منذ Boot" هنا زي الحساس الأصلي)

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);

        // (تشخيص مؤقت - شيله بعد ما تتأكد من نتيجته) بيوضح في Logcat
        // (فلتر "Sakkawi") هل الجهاز ده بيدخل الوضع 1 (حساس حقيقي) ولا
        // الوضع 2 (Fallback على الأكسلرومتر) - ده اللي بيفسّر أي فرق في
        // العدد مقارنة بعدادات زي Google Fit
        android.util.Log.d("Sakkawi", "stepCounterSensor = " + stepCounterSensor);

        if (stepCounterSensor == null) {
            // [الوضع 2] الجهاز معندوش حساس عدّ خطوات أصلي - نرجع
            // لحساس التسارع الخام بدل ما العداد يقف تمامًا
            usingFallbackMode = true;
            accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());

        // (إصلاح - باج حقيقي خطير - شوف تعليق sensorListenerRegistered
        // فوق): لو الحساس متسجّل بالفعل، مننداش registerListener() تاني
        // خالص - ده بالظبط اللي كان بيسبب تسجيل نفس القراءة كذا مرة
        // وزيادة العدد بشكل كبير عن الحقيقة كل ما JS تعيد نداء
        // startTracking() (كل 4 ثواني تقريبًا طول ما التطبيق فاتح)
        if (sensorListenerRegistered) {
            return START_STICKY;
        }

        if (!usingFallbackMode && stepCounterSensor != null) {
            sensorManager.registerListener(
                    this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL);
            sensorListenerRegistered = true;
        } else if (usingFallbackMode && accelerometerSensor != null) {
            // بنسجّل بمعدل أسرع شوية (GAME) عشان دقة أعلى في اكتشاف
            // القمم، زي ما المتصفح بيعمل تقريبًا مع devicemotion
            sensorManager.registerListener(
                    this, accelerometerSensor, SensorManager.SENSOR_DELAY_GAME);
            sensorListenerRegistered = true;

            // نسترجع أي عدّاد fallback محفوظ من قبل لنفس اليوم (لو
            // الخدمة اتقفلت وأعيد تشغيلها)
            fallbackStepsAccumulator = loadFallbackStepsIfSameDay();
        } else {
            // [حالة نادرة جدًا] الجهاز معندوش لا حساس عدّ خطوات ولا حتى
            // حساس تسارع خام (شبه مستحيل فعليًا، بس بنتعامل معاها
            // دفاعيًا). العداد مش هيقدر يشتغل، والإشعار هيوضّح كده.
            updateNotificationWithMessage("الجهاز ده معندوش حساس حركة، عداد الخطوات مش متاح");
        }

        return START_STICKY;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!usingFallbackMode && event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            // [الوضع 1] القيمة دي = إجمالي الخطوات من آخر إعادة تشغيل للجهاز
            float totalStepsSinceBoot = event.values[0];
            int stepsToday = resolveTodayStepCount(totalStepsSinceBoot);
            updateNotification(stepsToday);

        } else if (usingFallbackMode && event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
            handleFallbackAccelerometerEvent(event);
        }
    }

    /** [الوضع 1] بيحسب "خطوات اليوم الحالي بس" من إجمالي الخطوات منذ آخر Reboot */
    private int resolveTodayStepCount(float totalStepsSinceBoot) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String todayKey = DAY_FORMAT.format(new Date());
        String savedDay = prefs.getString("baseline_date", null);
        float baseline = prefs.getFloat("baseline_total_steps", -1);

        SharedPreferences.Editor editor = prefs.edit();

        if (savedDay == null || !savedDay.equals(todayKey) || baseline < 0) {
            baseline = totalStepsSinceBoot;
            editor.putString("baseline_date", todayKey);
            editor.putFloat("baseline_total_steps", baseline);
        }

        int stepsToday = Math.max(0, Math.round(totalStepsSinceBoot - baseline));

        editor.putInt("steps_today", stepsToday);
        editor.putString("steps_today_date", todayKey);
        editor.apply();

        return stepsToday;
    }

    /**
     * [الوضع 2 - Fallback] نفس خوارزمية Peak Detection اللي في
     * handleMotionEvent() جوه sensors.js بالظبط، بس هنا بتشتغل حتى لو
     * التطبيق مقفول (لأنها جوه Foreground Service مش جوه صفحة ويب).
     */
    private void handleFallbackAccelerometerEvent(SensorEvent event) {
        double x = event.values[0];
        double y = event.values[1];
        double z = event.values[2];
        double rawMagnitude = Math.sqrt(x * x + y * y + z * z);

        filteredMagnitude = LOW_PASS_ALPHA * rawMagnitude + (1 - LOW_PASS_ALPHA) * filteredMagnitude;

        if (!awaitingPeakReset && filteredMagnitude >= STEP_THRESHOLD_HIGH) {
            awaitingPeakReset = true;
            long now = System.currentTimeMillis();
            if (now - lastStepTimestamp >= STEP_COOLDOWN_MS) {
                lastStepTimestamp = now;
                registerFallbackStep();
            }
        } else if (awaitingPeakReset && filteredMagnitude <= STEP_THRESHOLD_LOW) {
            awaitingPeakReset = false;
        }
    }

    /** [الوضع 2] بيسجّل خطوة واحدة جديدة ويحفظها فورًا (Auto Save زي persistDailyState في JS) */
    private void registerFallbackStep() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String todayKey = DAY_FORMAT.format(new Date());
        String savedDay = prefs.getString("fallback_steps_date", null);

        if (savedDay == null || !savedDay.equals(todayKey)) {
            // يوم جديد - تصفير العدّاد التراكمي
            fallbackStepsAccumulator = 0;
        }

        fallbackStepsAccumulator += 1;

        prefs.edit()
                .putInt("steps_today", fallbackStepsAccumulator)
                .putString("steps_today_date", todayKey)
                .putInt("fallback_steps_accumulator", fallbackStepsAccumulator)
                .putString("fallback_steps_date", todayKey)
                .apply();

        updateNotification(fallbackStepsAccumulator);
    }

    /** [الوضع 2] استرجاع العدّاد المحفوظ لو لسه نفس اليوم (بعد إعادة تشغيل الخدمة مثلاً) */
    private int loadFallbackStepsIfSameDay() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String todayKey = DAY_FORMAT.format(new Date());
        String savedDay = prefs.getString("fallback_steps_date", null);

        if (todayKey.equals(savedDay)) {
            return prefs.getInt("fallback_steps_accumulator", 0);
        }
        return 0;
    }

    /** بيبني قناة الإشعارات (مطلوب إجباريًا على أندرويد 8+ / API 26+) */
    private void createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "تتبّع الخطوات",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("إشعار ثابت لتتبّع خطواتك حتى لو التطبيق مقفول");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        createNotificationChannelIfNeeded();

        Intent openAppIntent = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openAppIntent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("سِكّاوي بيتابع خطواتك")
                .setContentText("التتبع شغّال في الخلفية")
                .setSmallIcon(android.R.drawable.ic_menu_compass) // مؤقت، غيّره لأيقونة التطبيق الحقيقية لاحقًا
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    private void updateNotification(int stepsToday) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("سِكّاوي بيتابع خطواتك")
                .setContentText("خطوات النهاردة: " + stepsToday
                        + (usingFallbackMode ? " (وضع بديل)" : ""))
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .build();

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification);
    }

    private void updateNotificationWithMessage(String message) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("سِكّاوي")
                .setContentText(message)
                .setSmallIcon(android.R.drawable.ic_menu_compass)
                .setOngoing(true)
                .build();

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        sensorListenerRegistered = false;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // مش محتاجينه هنا
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // مش Bound Service، بس Started Service
    }
}