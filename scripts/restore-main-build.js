import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('Restoring Main App build state...');

// 1. Restore www/index.html
const wwwIndex = path.join(rootDir, 'www', 'index.html');
const wwwBackup = path.join(rootDir, 'www', 'index.user.html');

if (fs.existsSync(wwwBackup)) {
    fs.copyFileSync(wwwBackup, wwwIndex);
    fs.unlinkSync(wwwBackup);
    console.log('Restored www/index.html');
}

// 2. Restore capacitor.config.ts
const capConfigFile = path.join(rootDir, 'capacitor.config.ts');
if (fs.existsSync(capConfigFile)) {
    let content = fs.readFileSync(capConfigFile, 'utf-8');
    content = content.replace("appId: 'com.sakkawi.admin'", "appId: 'com.sakkawi.app'");
    content = content.replace("appName: 'سِكّاوي الأدمن'", "appName: 'سِكّاوي'");
    fs.writeFileSync(capConfigFile, content, 'utf-8');
    console.log('Restored capacitor.config.ts for main app');
}

// 3. Restore android/app/build.gradle
const buildGradleFile = path.join(rootDir, 'android', 'app', 'build.gradle');
if (fs.existsSync(buildGradleFile)) {
    let content = fs.readFileSync(buildGradleFile, 'utf-8');
    content = content.replace('applicationId "com.sakkawi.admin"', 'applicationId "com.sakkawi.app"');
    fs.writeFileSync(buildGradleFile, content, 'utf-8');
    console.log('Restored android/app/build.gradle applicationId to com.sakkawi.app');
}

// 4. Restore strings.xml
const stringsFile = path.join(rootDir, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
if (fs.existsSync(stringsFile)) {
    let content = fs.readFileSync(stringsFile, 'utf-8');
    content = content.replace(/<string name="app_name">.*?<\/string>/, '<string name="app_name">سِكّاوي</string>');
    content = content.replace(/<string name="title_activity_main">.*?<\/string>/, '<string name="title_activity_main">سِكّاوي</string>');
    content = content.replace(/<string name="package_name">.*?<\/string>/, '<string name="package_name">com.sakkawi.app</string>');
    content = content.replace(/<string name="custom_url_scheme">.*?<\/string>/, '<string name="custom_url_scheme">com.sakkawi.app</string>');
    fs.writeFileSync(stringsFile, content, 'utf-8');
    console.log('Restored strings.xml for main app');
}

console.log('Restoration complete.');
