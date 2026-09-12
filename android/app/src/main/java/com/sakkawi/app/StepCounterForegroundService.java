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
import android.hardware.SensorEventListener2;
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
 * تمامًا. بتعتمد حصريًا على حساس TYPE_STEP_COUNTER الأصلي بالجهاز.
 */
public class StepCounterForegroundService extends Service implements SensorEventListener2 {

    private static final String CHANNEL_ID = "sakkawi_step_tracking_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final String PREFS_NAME = "sakkawi_native_step_prefs";

    private static final SimpleDateFormat DAY_FORMAT =
            new SimpleDateFormat("yyyy-MM-dd", Locale.US);

    private static StepCounterForegroundService instance;

    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private boolean sensorListenerRegistered = false;

    public static StepCounterForegroundService getInstance() {
        return instance;
    }

    public void flushSensor() {
        if (sensorManager != null && stepCounterSensor != null && sensorListenerRegistered) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                try {
                    sensorManager.flush(this);
                } catch (Exception e) {
                    android.util.Log.w("Sakkawi", "sensorManager.flush failed", e);
                }
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                sensorManager.registerListener(
                        this, stepCounterSensor, SensorManager.SENSOR_DELAY_UI, 0);
            } else {
                sensorManager.registerListener(
                        this, stepCounterSensor, SensorManager.SENSOR_DELAY_UI);
            }
            sensorListenerRegistered = true;
        } else {
            updateNotificationWithMessage("جهازك مفيهوش حساس خطوات (Step Counter) - العداد مش متاح");
        }

        return START_STICKY;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_STEP_COUNTER) {
            float totalStepsSinceBoot = event.values[0];
            int stepsToday = resolveTodayStepCount(totalStepsSinceBoot);
            updateNotification(stepsToday);
        }
    }

    @Override
    public void onFlushCompleted(Sensor sensor) {
        // اكتمال تفريغ ذاكرة الحساس العتادية
    }

    /**
     * يحسب خطوات اليوم الحالي بدقة تامة مع الحفاظ على خطوات الصباح
     * وحماية ضد إعادة تشغيل الموبايل (Reboot Resilience).
     */
    private int resolveTodayStepCount(float totalStepsSinceBoot) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String todayKey = DAY_FORMAT.format(new Date());
        String savedBaselineDay = prefs.getString("baseline_date", null);
        float lastHardwareSteps = prefs.getFloat("last_hardware_total_steps", -1);
        float baseline = prefs.getFloat("baseline_total_steps", -1);
        int stepsBeforeReboot = prefs.getInt("steps_before_reboot", 0);
        int lastSavedStepsToday = prefs.getInt("steps_today", 0);

        SharedPreferences.Editor editor = prefs.edit();

        boolean isNewDay = savedBaselineDay == null || !savedBaselineDay.equals(todayKey);

        if (isNewDay) {
            // يوم جديد: ضبط خط الأساس لليوم الجديد
            // إذا كان لدينا قراءة عتادية مسجلة من قبل ولم يحدث Reboot (أي totalStepsSinceBoot >= lastHardwareSteps)
            // فإن الخطوات التي قُطعت بين lastHardwareSteps و totalStepsSinceBoot قد تمت بالفعل اليوم
            if (lastHardwareSteps >= 0 && totalStepsSinceBoot >= lastHardwareSteps) {
                baseline = lastHardwareSteps;
            } else {
                boolean isFirstRunEver = !prefs.contains("last_hardware_total_steps");
                if (isFirstRunEver) {
                    baseline = totalStepsSinceBoot;
                } else {
                    baseline = 0f;
                }
            }
            stepsBeforeReboot = 0;
            editor.putString("baseline_date", todayKey);
            editor.putFloat("baseline_total_steps", baseline);
            editor.putInt("steps_before_reboot", 0);
        } else if (baseline < 0) {
            if (lastHardwareSteps >= 0 && totalStepsSinceBoot >= lastHardwareSteps) {
                baseline = lastHardwareSteps;
            } else {
                baseline = totalStepsSinceBoot;
            }
            editor.putFloat("baseline_total_steps", baseline);
        } else if (totalStepsSinceBoot < baseline) {
            // حدث Reboot في منتصف اليوم الحالي
            stepsBeforeReboot = lastSavedStepsToday;
            baseline = 0f;
            editor.putInt("steps_before_reboot", stepsBeforeReboot);
            editor.putFloat("baseline_total_steps", baseline);
        }

        int deltaSinceBaseline = Math.max(0, Math.round(totalStepsSinceBoot - baseline));
        int stepsToday = stepsBeforeReboot + deltaSinceBaseline;

        editor.putInt("steps_today", stepsToday);
        editor.putString("steps_today_date", todayKey);
        editor.putFloat("last_hardware_total_steps", totalStepsSinceBoot);
        editor.putString("last_hardware_step_date", todayKey);
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

    private PendingIntent getOpenAppPendingIntent() {
        Intent openAppIntent = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, openAppIntent, flags);
    }

    private int getNotificationIcon() {
        return R.drawable.ic_stat_notify;
    }

    private Notification buildNotification() {
        createNotificationChannelIfNeeded();

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("سِكّاوي بيتابع خطواتك")
                .setContentText("التتبع شغّال في الخلفية")
                .setSmallIcon(getNotificationIcon())
                .setColor(ContextCompat.getColor(this, R.color.notification_accent))
                .setContentIntent(getOpenAppPendingIntent())
                .setOngoing(true)
                .build();
    }

    private void updateNotification(int stepsToday) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("سِكّاوي بيتابع خطواتك")
                .setContentText("خطوات النهاردة: " + stepsToday)
                .setSmallIcon(getNotificationIcon())
                .setColor(ContextCompat.getColor(this, R.color.notification_accent))
                .setContentIntent(getOpenAppPendingIntent())
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
                .setSmallIcon(getNotificationIcon())
                .setColor(ContextCompat.getColor(this, R.color.notification_accent))
                .setContentIntent(getOpenAppPendingIntent())
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
        if (instance == this) {
            instance = null;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // مش محتاجينه هنا
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        // ضمان استمرار خدمة تتبع الخطوات حتى لو مسح المستخدم التطبيق من قائمة التطبيقات الحديثة (Recents)
        try {
            Intent restartServiceIntent = new Intent(getApplicationContext(), this.getClass());
            restartServiceIntent.setPackage(getPackageName());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(restartServiceIntent);
            } else {
                startService(restartServiceIntent);
            }
        } catch (Exception e) {
            android.util.Log.w("Sakkawi", "onTaskRemoved restart failed", e);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // مش Bound Service، بس Started Service
    }
}