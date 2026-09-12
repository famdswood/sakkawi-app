import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('Preparing Admin App build...');

// 1. Backup and replace index.html with admin.html in www
const wwwIndex = path.join(rootDir, 'www', 'index.html');
const wwwAdmin = path.join(rootDir, 'www', 'admin.html');
const wwwBackup = path.join(rootDir, 'www', 'index.user.html');

if (fs.existsSync(wwwIndex)) {
    fs.copyFileSync(wwwIndex, wwwBackup);
    fs.copyFileSync(wwwAdmin, wwwIndex);
    console.log('Replaced www/index.html with www/admin.html');
}

// 2. Temporarily rename google-services.json so Firebase plugin is cleanly skipped for admin package
const googleServices = path.join(rootDir, 'android', 'app', 'google-services.json');
const googleServicesBak = path.join(rootDir, 'android', 'app', 'google-services.json.bak');
if (fs.existsSync(googleServices)) {
    fs.renameSync(googleServices, googleServicesBak);
    console.log('Backed up google-services.json');
}

// 3. Update capacitor.config.ts
const capConfigFile = path.join(rootDir, 'capacitor.config.ts');
if (fs.existsSync(capConfigFile)) {
    let content = fs.readFileSync(capConfigFile, 'utf-8');
    content = content.replace("appId: 'com.sakkawi.app'", "appId: 'com.sakkawi.admin'");
    content = content.replace("appName: 'سِكّاوي'", "appName: 'سِكّاوي الأدمن'");
    fs.writeFileSync(capConfigFile, content, 'utf-8');
    console.log('Updated capacitor.config.ts for admin');
}

// 4. Update android/app/build.gradle
const buildGradleFile = path.join(rootDir, 'android', 'app', 'build.gradle');
if (fs.existsSync(buildGradleFile)) {
    let content = fs.readFileSync(buildGradleFile, 'utf-8');
    content = content.replace('applicationId "com.sakkawi.app"', 'applicationId "com.sakkawi.admin"');
    fs.writeFileSync(buildGradleFile, content, 'utf-8');
    console.log('Updated android/app/build.gradle applicationId to com.sakkawi.admin');
}

// 5. Update strings.xml
const stringsFile = path.join(rootDir, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
if (fs.existsSync(stringsFile)) {
    let content = fs.readFileSync(stringsFile, 'utf-8');
    content = content.replace(/<string name="app_name">.*?<\/string>/, '<string name="app_name">سِكّاوي الأدمن</string>');
    content = content.replace(/<string name="title_activity_main">.*?<\/string>/, '<string name="title_activity_main">سِكّاوي الأدمن</string>');
    content = content.replace(/<string name="package_name">.*?<\/string>/, '<string name="package_name">com.sakkawi.admin</string>');
    content = content.replace(/<string name="custom_url_scheme">.*?<\/string>/, '<string name="custom_url_scheme">com.sakkawi.admin</string>');
    fs.writeFileSync(stringsFile, content, 'utf-8');
    console.log('Updated strings.xml for admin');
}

console.log('Admin preparation complete.');
