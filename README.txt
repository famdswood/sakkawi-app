مشروع سِكّاوي — جاهز كـ Capacitor project
==========================================

اللي حصل هنا (اتعمل جاهز مسبقًا، مش محتاج تعمل أي أوامر Node/Capacitor بنفسك):
- npm init + تثبيت @capacitor/core و @capacitor/cli
- npx cap init (اسم التطبيق: سكاوي | App ID: com.sakkawi.app)
- npم install @capacitor/android + npx cap add android
  -> ده ولّد فولدر android/ كامل (مشروع أندرويد ستوديو حقيقي جاهز للبناء)
- .gitignore جاهز (بيستثني node_modules والملفات المؤقتة)
- .github/workflows/build-apk.yml جاهز (هو اللي هيخلي GitHub يبني الـ APK تلقائيًا)

اللي المفروض تعمله إنت دلوقتي (خطوتين بس):
==========================================

1) استبدل فولدر www بالكامل بمشروعك الحقيقي
--------------------------------------------
فولدر www/ اللي موجود دلوقتي فيه ملف placeholder بسيط بس (index.html وهمي).
امسحه بالكامل، وحط بدله كل محتويات مشروعك الحقيقي:
- index.html (اللي فيه تعديلات الأوفلاين والخطوط)
- فولدر css/
- فولدر js/
- فولدر vendor/ (بكل المكتبات + fonts/)
- manifest.json
- أي صور/أيقونات تانية

يعني بعد الاستبدال، لازم يبقى شكل الفولدر كده:
sakkawi-capacitor/
  www/
    index.html          <- ده مشروعك الحقيقي
    css/
    js/
    vendor/
    manifest.json
  android/               <- سيبه زي ما هو، متلمسوش
  .github/
  package.json
  capacitor.config.ts

2) بعد الاستبدال، ارفع المشروع كله على GitHub
--------------------------------------------
من جوه فولدر sakkawi-capacitor (بعد ما استبدلت www)، افتح Terminal ونفّذ:

    git init
    git add .
    git commit -m "أول رفعة للمشروع مع Capacitor"
    git branch -M main
    git remote add origin https://github.com/USERNAME/REPO_NAME.git
    git push -u origin main

(استبدل USERNAME وREPO_NAME بحسابك الحقيقي بعد ما تعمل ريبو جديد على GitHub.com)

3) بمجرد الـ push، روح تاب "Actions" في صفحة الريبو على GitHub
--------------------------------------------
هتلاقي البناء شغّال لوحده تلقائي. لما يخلص (5-10 دقايق)، هتلاقي رابط
تنزيل الـ APK جوه نفس الصفحة تحت "Artifacts".

ملحوظة مهمة: لازم تتأكد إن كل المسارات النسبية جوه index.html
(زي vendor/fonts/fonts.css أو css/style.css) لسه شغالة صح بعد
ما تحط الملفات في www/ - المفروض تفضل شغالة عادي لأننا مش
بنغيّر هيكل الفولدر الداخلي، بس افتح index.html وشوف بعينك
إنه مفيش أي مسار غلط قبل ما ترفع.
