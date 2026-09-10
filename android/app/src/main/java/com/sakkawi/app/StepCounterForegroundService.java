package com.sakkawi.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * خدمة أمامية (Foreground Service) بتفضل شغّالة حتى لو التطبيق مقفول
 * تمامًا. بتعتمد حصريًا على حساس TYPE_STEP_COUNTER الأصلي بالجهاز -
 * نفس الحساس اللي Google Fit وباقي تطبيقات اللياقة بتقرا منه - عشان
 * نضمن تطابق قريب جدًا مع Fit بدل أي خوارزمية تقريبية خاصة بينا.
 * الحساس ده بيرجّع "إجمالي عدد الخطوات من آخر Reboot"، فبنحسب فرق
 * (delta) من baseline محفوظ عشان نعرف خطوات اليوم بس (resolveTodayStepCount).
 *
 * ⚠️ (قرار منتج) اتشال نهائياً "وضع الـ Fallback" اللي كان بيرجع
 * لحساس التسارع الخام (TYPE_ACCELEROMETER) + خوارزمية Peak Detection
 * تقريبية لو الجهاز معندوش TYPE_STEP_COUNTER. السبب: الخوارزمية
 * التقريبية دي كانت بتنتج أرقام مختلفة عن Fit (مصدر مختلف تمامًا)،
 * وبما إن الجمهور المستهدف (مصر، 2024+) شبه كله بموبايلات 2019/2020
 * فأعلى وكلها عندها الحساس ده كجزء قياسي من الشريحة، الفئة اللي
 * هتتأثر (موبايلات ما قبل 2018 أو أجهزة "اتصال بس") أقلية هامشية جدًا.
 * دلوقتي: لو الجهاز معندوش TYPE_STEP_COUNTER، بنوضّح للمستخدم بصراحة
 * إن العداد مش متاح على جهازه (شوف onStartCommand) بدل ما نديله رقم
 * من مصدر تاني بيحاول "يقلّد" Fit من غير ما يبقى هو نفسه.
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

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;

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

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);

        // (تشخيص مؤقت - شيله بعد ما تتأكد من نتيجته) بيوضح في Logcat
        // (فلتر "Sakkawi") هل الجهاز ده عنده حساس الخطوات الأصلي ولا لأ -
        // لو null يبقى العداد مش متاح خالص على الجهاز ده (شوف onStartCommand)
        android.util.Log.d("Sakkawi", "stepCounterSensor = " + stepCounterSensor);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // [أمان] التحقق من منح إذن التعرف على النشاط على أندرويد 10+
        // لمنع حدوث SecurityException إذا سحب المستخدم الإذن يدويًا
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION)
                    != PackageManager.PERMISSION_GRANTED) {
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        // [أندرويد 14+ / API 34+] يجب تمرير نوع الخدمة صراحة عند استدعاء startForeground
        // وإلا يرمي النظام MissingForegroundServiceTypeException ويكرّش التطبيق
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }

        // (إصلاح - باج حقيقي خطير - شوف تعليق sensorListenerRegistered
        // فوق): لو الحساس متسجّل بالفعل، مننداش registerListener() تاني
        // خالص - ده بالظبط اللي كان بيسبب تسجيل نفس القراءة كذا مرة
        // وزيادة العدد بشكل كبير عن الحقيقة كل ما JS تعيد نداء
        // startTracking() (كل 4 ثواني تقريبًا طول ما التطبيق فاتح)
        if (sensorListenerRegistered) {
            return START_STICKY;
        }

        if (stepCounterSensor != null) {
            sensorManager.registerListener(
                    this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL);
            sensorListenerRegistered = true;
        } else {
            // الجهاز معندوش حساس خطوات أصلي (TYPE_STEP_COUNTER) - مش
            // هنقارب من أي حساس تاني (قرار منتج، شوف تعليق الكلاس فوق).
            // العداد هيفضل واقف على جهاز زي ده، والإشعار هيوضّح السبب.
            updateNotificationWithMessage("جهازك مفيهوش حساس خطوات (Step Counter) - العداد مش متاح");
        }

        return START_STICKY;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            // القيمة دي = إجمالي الخطوات من آخر إعادة تشغيل للجهاز
            float totalStepsSinceBoot = event.values[0];
            int stepsToday = resolveTodayStepCount(totalStepsSinceBoot);
            updateNotification(stepsToday);
        }
    }

    /**
     * يحسب "خطوات اليوم الحالي" بدقة، مع حماية ضد إعادة تشغيل الموبايل (Reboot Resilience).
     * حساس TYPE_STEP_COUNTER يعود للصفر عند إعادة تشغيل الهاتف؛ لذلك إذا انخفضت
     * قيمة totalStepsSinceBoot عن الـ baseline المحفوظ في نفس اليوم، يتم اكتشاف حدوث
     * Reboot والاحتفاظ بآخر خطوات سُجلت اليوم قبل الإقلاع بدلاً من تصفيرها وضياعها.
     */
    private int resolveTodayStepCount(float totalStepsSinceBoot) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String todayKey = DAY_FORMAT.format(new Date());
        String savedDay = prefs.getString("baseline_date", null);
        float baseline = prefs.getFloat("baseline_total_steps", -1);
        int stepsBeforeReboot = prefs.getInt("steps_before_reboot", 0);
        int lastSavedStepsToday = prefs.getInt("steps_today", 0);

        SharedPreferences.Editor editor = prefs.edit();

        boolean isNewDay = savedDay == null || !savedDay.equals(todayKey);

        if (isNewDay) {
            // يوم جديد: إعادة تعيين الـ baseline وتصفير رصيد ما قبل الـ Reboot
            baseline = totalStepsSinceBoot;
            stepsBeforeReboot = 0;
            editor.putString("baseline_date", todayKey);
            editor.putFloat("baseline_total_steps", baseline);
            editor.putInt("steps_before_reboot", 0);
        } else if (baseline < 0) {
            // أول قراءة مسجلة لليوم
            baseline = totalStepsSinceBoot;
            editor.putFloat("baseline_total_steps", baseline);
        } else if (totalStepsSinceBoot < baseline) {
            // [إصلاح ثغرة الـ Reboot]: الهاتف أُعيد تشغيله في منتصف اليوم!
            // الحساس بدأ برقم أقل من الـ baseline السابق.
            // نحتفظ بآخر عدد خطوات تم الوصول إليه اليوم كـ offset
            stepsBeforeReboot = lastSavedStepsToday;
            baseline = totalStepsSinceBoot;
            editor.putInt("steps_before_reboot", stepsBeforeReboot);
            editor.putFloat("baseline_total_steps", baseline);
        }

        int deltaSinceBaseline = Math.max(0, Math.round(totalStepsSinceBoot - baseline));
        int stepsToday = stepsBeforeReboot + deltaSinceBaseline;

        editor.putInt("steps_today", stepsToday);
        editor.putString("steps_today_date", todayKey);
        editor.apply();

        return stepsToday;
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
                .setContentText("خطوات النهاردة: " + stepsToday)
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