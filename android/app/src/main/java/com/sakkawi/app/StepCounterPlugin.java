package com.sakkawi.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * الجسر بين JavaScript (sensors.js) والخدمة الأصلية
 * StepCounterForegroundService. بيوفر لـ JS:
 * - requestPermissions(): يطلب إذن ACTIVITY_RECOGNITION من المستخدم
 * - startTracking(): يشغّل الخدمة الأمامية
 * - getStepsToday(): يرجّع عدد خطوات اليوم المحفوظ من الخدمة
 * - isIgnoringBatteryOptimizations(): بيرجّع هل التطبيق مستثنى بالفعل
 *   من توفير البطارية (عشان الـ JS يقرر يعرض التنبيه أو لأ)
 * - requestIgnoreBatteryOptimizations(): بيفتح نافذة الموافقة الرسمية
 *   من أندرويد نفسه عشان يستثني التطبيق من توفير البطارية
 * - getManufacturerInfo(): [جديد] بيرجّع اسم الشركة المصنّعة (Build.MANUFACTURER)
 *   وهل هي من الشركات المعروفة بتقييد التطبيقات في الخلفية بشدة
 *   (شاومي/هواوي/أوبو/فيفو..إلخ) - عشان الواجهة تقرر تعرض تنبيه Autostart أو لأ
 * - openAutostartSettings(): [جديد] بيحاول يفتح شاشة "التشغيل التلقائي"
 *   (Autostart) الخاصة بالشركة المصنّعة مباشرة (شاومي/هواوي/أوبو/فيفو..إلخ)،
 *   لأن التقييد ده أخطر من توفير البطارية العادي - على الشركات دي بتقفل
 *   أي Foreground Service للتطبيق لو مش مفعّل Autostart له، حتى لو
 *   التطبيق مستثنى من توفير البطارية أصلاً. ⚠️ دي Intent-ات غير رسمية
 *   (مفيش API معتمد من جوجل لها) بنعرفها من component names معروفة
 *   لكل شركة - ممكن تتغيّر أو متبقاش موجودة في إصدارات ROM مستقبلية،
 *   فبنتعامل معاها دفاعيًا (try/catch) وبنرجع للشاشة العامة
 *   (App Info/Application Details) لو فشلت
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

        // (إصلاح - ثغرة الـ Reboot): بنحفظ "الإذن بالتتبع" في SharedPreferences
        // عشان BootStepCounterReceiver يقدر يرجع يسأل نفس القيمة دي وقت
        // إقلاع الجهاز - لأن BroadcastReceiver مالوش أي وصول لحالة الزائر
        // في الواجهة (window.isGuestMode) أصلاً.
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("tracking_allowed", true).apply();

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

        // (إصلاح - ثغرة الـ Reboot): نفس الفكرة بالعكس - لما الزائر
        // يتوقف تتبعه، بنسجّل كده صراحة عشان لو قفل موبايله وشغّله تاني،
        // BootStepCounterReceiver ميشغّلش الخدمة تلقائيًا من غيره.
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("tracking_allowed", false).apply();

        context.stopService(new Intent(context, StepCounterForegroundService.class));
        call.resolve();
    }

    @PluginMethod
    public void getStepsToday(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int stepsToday = prefs.getInt("steps_today", 0);
        String date = prefs.getString("steps_today_date", null);
        String todayKey = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());

        // إذا كان التاريخ المحفوظ يخص يوماً سابقاً (قبل أول حركة للجهاز اليوم)،
        // نرجع صفر خطوات وتاريخ اليوم منعاً لقراءة رصيد الأمس الخامل
        if (date != null && !date.equals(todayKey)) {
            stepsToday = 0;
            date = todayKey;
        }

        JSObject result = new JSObject();
        result.put("steps", stepsToday);
        result.put("date", date != null ? date : todayKey);
        call.resolve(result);
    }

    /**
     * [جديد] بيرجّع true لو التطبيق مستثنى بالفعل من "توفير البطارية"
     * (يعني النظام مش هيقفل الـ Foreground Service بتاعنا في الخلفية).
     * قبل Android M (API 23) مفيش المفهوم ده أصلاً، فبنرجّع true دايمًا
     * (يعني "مفيش داعي نطلب حاجة") عشان الـ JS ميعرضش تنبيه لغير فايدة.
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = getContext();
            PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            boolean ignoring = powerManager != null
                    && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
            result.put("ignoring", ignoring);
        } else {
            result.put("ignoring", true);
        }

        call.resolve(result);
    }

    /**
     * [جديد] بيفتح نافذة الموافقة الرسمية بتاعة أندرويد
     * (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) عشان يستثني
     * التطبيق من توفير البطارية. النافذة دي بتاعة النظام نفسه - مش
     * حاجة برمجية بنقدر نجبرها من غير موافقة صريحة من المستخدم.
     * لو الجهاز أقل من Android M أو مفيش activity متاحة، بنرجّع
     * granted: false على طول من غير محاولة (مفيش API أصلاً قبل M).
     * ⚠️ ملحوظة: النافذة دي بتتقفل والنداء ده بيرجع فورًا (مش بعد ما
     * المستخدم يوافق أو يرفض) لأنها بتفتح Activity منفصلة - الـ JS
     * لازم ينادي isIgnoringBatteryOptimizations() تاني بعدها (مثلاً
     * لما التطبيق يرجع للمقدمة عبر visibilitychange) عشان يعرف
     * المستخدم وافق فعلاً ولا لأ.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("requested", false);
            result.put("reason", "not-applicable-below-android-m");
            call.resolve(result);
            return;
        }

        Context context = getContext();
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean alreadyIgnoring = powerManager != null
                && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());

        if (alreadyIgnoring) {
            result.put("requested", false);
            result.put("reason", "already-ignoring");
            call.resolve(result);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);

            result.put("requested", true);
            call.resolve(result);
        } catch (Exception e) {
            // بعض شركات الـ OEM بتشيل نافذة الموافقة دي من الـ ROM بتاعها
            // خالص (نادر لكن ممكن)، فبنتعامل معاها دفاعيًا بدل ما نكراش
            result.put("requested", false);
            result.put("reason", "activity-not-found");
            call.resolve(result);
        }
    }

    /**
     * [جديد] قائمة أسماء الشركات المعروفة بتطبيق تقييد "Autostart" على
     * تطبيقات الطرف التالت (بتمنعها من الشغل في الخلفية لو المستخدم
     * ملقاش يفتحها بإيده، حتى لو مستثناة من توفير البطارية). بنقارن
     * بيها Build.MANUFACTURER (بعد تحويله lower-case).
     */
    private static final String[] RESTRICTIVE_MANUFACTURERS = {
            "xiaomi", "redmi", "poco",           // MIUI / HyperOS
            "huawei", "honor",                    // EMUI/MagicOS + المستقلة hihonor
            "oppo", "realme", "oneplus",          // ColorOS (oneplus بقى نفس عيلة ColorOS)
            "vivo", "iqoo",                       // OriginOS/FuntouchOS
            "meizu",
            "letv",
            "asus"
    };

    /**
     * [جديد] بيرجّع اسم الشركة المصنّعة وهل هي معروفة بتقييد شديد
     * للتطبيقات في الخلفية (Autostart) - عشان الواجهة (app.js) تقرر
     * تعرض بانر "فعّل Autostart" أو لأ. الأجهزة "القياسية" (Pixel/
     * Android One) أو سامسونج بيرجعوا restrictive=false لأن Autostart
     * مش مفهوم موجود عندهم أصلاً (بيعتمدوا بس على Battery Optimization
     * العادي اللي متغطي في isIgnoringBatteryOptimizations()).
     */
    @PluginMethod
    public void getManufacturerInfo(PluginCall call) {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String normalized = manufacturer.toLowerCase(Locale.US);

        boolean restrictive = false;
        for (String known : RESTRICTIVE_MANUFACTURERS) {
            if (normalized.contains(known)) {
                restrictive = true;
                break;
            }
        }

        JSObject result = new JSObject();
        result.put("manufacturer", manufacturer);
        result.put("restrictive", restrictive);
        call.resolve(result);
    }

    /**
     * [جديد] قائمة الـ Intent-ات غير الرسمية المعروفة لفتح شاشة
     * "التشغيل التلقائي" (Autostart) لكل شركة - جُمّعت من component
     * names موثّقة ومستخدمة على نطاق واسع في مكتبات مفتوحة المصدر
     * مشابهة. مرتبة بالترتيب اللي بنجرّبها بيه لكل شركة (بعض الشركات
     * غيّرت اسم الـ Activity بين إصدارات ROM مختلفة، فبنجرّب أكتر من
     * احتمال قبل ما نستسلم).
     */
    private List<ComponentName> autostartCandidatesFor(String normalizedManufacturer) {
        List<ComponentName> candidates = new ArrayList<>();

        if (normalizedManufacturer.contains("xiaomi")
                || normalizedManufacturer.contains("redmi")
                || normalizedManufacturer.contains("poco")) {
            candidates.add(new ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"));
            candidates.add(new ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.securitycenter.permission.AppPermissionsEditorActivity"));
        } else if (normalizedManufacturer.contains("honor")) {
            // هونر بقت شركة مستقلة عن هواوي من إصدارات معينة وليها
            // package منفصل، بس بعض أجهزة هونر القديمة لسه بتستخدم
            // package هواوي - بنجرّب الاتنين
            candidates.add(new ComponentName(
                    "com.hihonor.systemmanager",
                    "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            candidates.add(new ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
        } else if (normalizedManufacturer.contains("huawei")) {
            candidates.add(new ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            candidates.add(new ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"));
        } else if (normalizedManufacturer.contains("oppo")
                || normalizedManufacturer.contains("realme")
                || normalizedManufacturer.contains("oneplus")) {
            candidates.add(new ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            candidates.add(new ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.startupapp.StartupAppListActivity"));
            candidates.add(new ComponentName(
                    "com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity"));
        } else if (normalizedManufacturer.contains("vivo")
                || normalizedManufacturer.contains("iqoo")) {
            candidates.add(new ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            candidates.add(new ComponentName(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"));
            candidates.add(new ComponentName(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"));
        } else if (normalizedManufacturer.contains("meizu")) {
            candidates.add(new ComponentName(
                    "com.meizu.safe",
                    "com.meizu.safe.permission.SmartBGActivity"));
        } else if (normalizedManufacturer.contains("letv")) {
            candidates.add(new ComponentName(
                    "com.letv.android.letvsafe",
                    "com.letv.android.letvsafe.AutobootManageActivity"));
        } else if (normalizedManufacturer.contains("asus")) {
            candidates.add(new ComponentName(
                    "com.asus.mobilemanager",
                    "com.asus.mobilemanager.autostart.AutoStartActivity"));
        }

        return candidates;
    }

    /**
     * [جديد] بيحاول يفتح شاشة "Autostart" الخاصة بالشركة المصنّعة
     * مباشرة (بيجرّب كل الاحتمالات المعروفة للشركة دي واحد ورا التانية
     * لحد ما واحد ينجح). لو كل المحاولات فشلت (أو الشركة مش من الشركات
     * المعروفة أصلاً)، بيرجع للشاشة العامة لتفاصيل التطبيق
     * (Application Details Settings) عشان المستخدم على الأقل يقدر
     * يدوّر بنفسه بدل ما نسيبه من غير أي حاجة.
     *
     * ⚠️ مفيش ضمان إن الشاشة اللي فتحناها هي بالظبط الصفحة اللي فيها
     * سِكّاوي جاهز يتفعّله - بعض الشركات بتفتح قائمة عامة والمستخدم
     * لازم يدوّر على التطبيق فيها بنفسه. برضو مفيش طريقة رسمية نتأكد
     * بيها إن المستخدم فعّل الخيار فعلاً (على عكس توفير البطارية).
     */
    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        Context context = getContext();
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String normalized = manufacturer.toLowerCase(Locale.US);

        JSObject result = new JSObject();

        for (ComponentName candidate : autostartCandidatesFor(normalized)) {
            try {
                Intent intent = new Intent();
                intent.setComponent(candidate);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);

                result.put("opened", true);
                result.put("method", "manufacturer-specific");
                result.put("manufacturer", manufacturer);
                call.resolve(result);
                return;
            } catch (ActivityNotFoundException | SecurityException e) {
                // الاحتمال ده مش موجود/متاح على الـ ROM ده - نجرّب اللي بعده
            }
        }

        // كل الاحتمالات الخاصة بالشركة فشلت (أو الشركة مش معروفة عندنا
        // أصلاً) - رجوع للشاشة العامة "About This App" بدل ما نسيب
        // المستخدم من غير أي حاجة تفتح خالص
        try {
            Intent fallbackIntent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            fallbackIntent.setData(Uri.parse("package:" + context.getPackageName()));
            fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(fallbackIntent);

            result.put("opened", true);
            result.put("method", "app-details-fallback");
            result.put("manufacturer", manufacturer);
            call.resolve(result);
        } catch (Exception e) {
            result.put("opened", false);
            result.put("reason", "no-settings-screen-found");
            result.put("manufacturer", manufacturer);
            call.resolve(result);
        }
    }
}
