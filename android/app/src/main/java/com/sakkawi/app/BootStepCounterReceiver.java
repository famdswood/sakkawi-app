package com.sakkawi.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * بيستقبل حدث BOOT_COMPLETED (وبديله على بعض أجهزة OEM القديمة
 * QUICKBOOT_POWERON) ويشغّل StepCounterForegroundService فورًا من غير
 * أي تدخل من المستخدم ومن غير ما يفتح التطبيق خالص.
 *
 * ⚠️ ده هو الإصلاح الأساسي لمشكلة "عدد الخطوات أقل من Google Fit":
 * قبل الإصلاح، الخدمة (وبالتالي الـ baseline بتاع TYPE_STEP_COUNTER في
 * resolveTodayStepCount()) كانت بتتسجل بس أول ما المستخدم يفتح
 * التطبيق بإيده - يعني أي خطوات اتمشيت *قبل* أول فتحة للتطبيق في اليوم
 * ده كانت بتتحسب كـ"صفر" وتضيع نهائيًا من حساب اليوم (لأن الـ baseline
 * بتاخد قيمة السنسور وقت الفتح مش وقت منتصف الليل/الإقلاع). دلوقتي
 * بعد الإصلاح، الخدمة بتشتغل من وقت إقلاع الجهاز نفسه، فالـ baseline
 * بيتسجل قريب جدًا من نفس اللحظة اللي Google Fit بيبدأ يحسب منها -
 * فالفرق المفروض يقل بشكل كبير جدًا.
 */
public class BootStepCounterReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        boolean isBootEvent =
                Intent.ACTION_BOOT_COMPLETED.equals(action)
                        || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                        || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action);

        if (!isBootEvent) return;

        Intent serviceIntent = new Intent(context, StepCounterForegroundService.class);

        // مهم: من BroadcastReceiver لازم نستخدم startForegroundService()
        // صراحة على أندرويد 8+ (O+) - نفس المنطق المستخدم في
        // StepCounterPlugin.startTracking()، عشان النظام يديها فرصة
        // تستدعي startForeground() بسرعة قبل ما يعتبرها ANR
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, serviceIntent);
        } else {
            context.startService(serviceIntent);
        }
    }
}
