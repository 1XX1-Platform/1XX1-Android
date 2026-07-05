# 1XX1 Android Native App

## Proje Yapisi

```
1xx1-android/
├── app/
│   ├── src/main/
│   │   ├── java/com/kaptan/x1xx/
│   │   │   ├── ui/MainActivity.kt          ← Ana ekran
│   │   │   ├── service/
│   │   │   │   ├── NodeForegroundService.kt ← Arka plan servisi
│   │   │   │   └── BootReceiver.kt          ← Acilis sonrasi otomatik baslat
│   │   │   ├── bridge/NodeBridge.kt         ← Android <-> Node.js kopru
│   │   │   └── runtime/NodeRuntimeLauncher.kt ← Node.js process yonetimi
│   │   ├── res/layout/activity_main.xml     ← Arayuz
│   │   └── AndroidManifest.xml
│   └── build.gradle
└── settings.gradle
```

## Kurulum (Android Studio)

1. Bu klasoru Android Studio'da ac
2. `app/src/main/assets/1xx1/` klasoru olustur
3. 1XX1 TypeScript dosyalarini buraya kopyala (main.ts dahil tum proje)
4. `app/src/main/assets/nodejs/` klasoru olustur
5. Node.js ARM64 binary'sini `assets/nodejs/arm64/node` olarak koyar
6. Build > Generate APK

## Node.js Binary

Android icin Node.js binary indirme:
https://github.com/nicedoc/nodejs-android/releases

arm64-v8a icin: `node-v22-android-arm64.tar.gz`
Icinden `bin/node` dosyasini al, `assets/nodejs/arm64/node` olarak kaydet.

## Modlar

- Manuel: Kullanici BASLAT tusuna basar
- Otomatik: Uygulama acilinca otomatik baslar
- Arka Plan: Telefon acilinca bile calismaya devam eder

## Mimari

Android App (Kotlin)
       |
NodeForegroundService  <-- arka planda yasatir
       |
NodeRuntimeLauncher    <-- Node.js process baslatir
       |
Process: node --experimental-strip-types main.ts
       |
localhost:1331         <-- HTTP API + SSE
       |
NodeBridge             <-- Android <-> Node iletisimi
       |
MainActivity           <-- UI guncelleme
