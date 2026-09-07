package com.sakkawi.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * الجسر بين JavaScript (sensors.js) والخدمة الأصلية
 * StepCounterForegroundService. بيوفر 3 دوال لـ JS:
 * - requestPermissions(): يطلب إذن ACTIVITY_RECOGNITION من المستخدم
 * - startTracking(): يشغّل الخدمة الأمامية
 * - getStepsToday(): يرجّع عدد خطوات اليوم المحفوظ من الخدمة
 */
@CapacitorPlugin(
        name = "StepCounter",
        permissions = {
                @Permission(
                        alias = "activityRecognition",
                        strings = { Manifest.permission.ACTIVITY_RECOGNITION }
                )
        }
)
public class StepCounterPlugin extends Plugin {

    private static final String PREFS_NAME = "sakkawi_native_step_prefs";

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            requestPermissionForAlias("activityRecognition", call, "permissionCallback");
        } else {
            // قبل أندرويد 10 مفيش حاجة تتطلب أصلاً
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        boolean granted = getPermissionState("activityRecognition").equals(
                com.getcapacitor.PermissionState.GRANTED);
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        Context context = getContext();
        Intent serviceIntent = new Intent(context, StepCounterForegroundService.class);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, serviceIntent);
        } else {
            context.startService(serviceIntent);
        }

        call.resolve();
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, StepCounterForegroundService.class));
        call.resolve();
    }

    @PluginMethod
    public void getStepsToday(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int stepsToday = prefs.getInt("steps_today", 0);
        String date = prefs.getString("steps_today_date", null);

        JSObject result = new JSObject();
        result.put("steps", stepsToday);
        result.put("date", date);
        call.resolve(result);
    }
}
