# 1XX1 — Oturum Bağlamı (Her Yeni Sohbette Oku)

## Proje
1XX1: Merkeziyetsiz, reklamsız, açık kaynak uygulama ekosistemi.
"Para sıralamayı hiçbir zaman etkilemez." — temel değişmez.

## Geliştirici
Kaptan (Emirhan) — Vienna, Samsung S23, Termux ortamı.

## Teknik Özet
- 214 TypeScript dosyası, 191 temiz (syntax OK)
- Node.js --experimental-strip-types ile çalışır
- İki telefon LAN testi geçti (peers: 1)
- ZIP: /mnt/user-data/outputs/1XX1-v1.0.0.zip (738KB)

## FAZ Durumu
| FAZ | İçerik | Durum |
|-----|--------|-------|
| 0 | Identity (Ed25519, base58 nodeId, persist) | TAMAM |
| 1 | Gossip Discovery (transitive, dedup, failure detect) | TAMAM |
| 2 | Raft (hash-chain, split-brain, commitIndex monoton) | TAMAM |
| 3 | DHT Kademlia-lite + NAT traversal | TAMAM |
| 4 | Reputation (EWMA) + Sybil Guard | TAMAM |
| 5 | Observability (/raft/status, /cluster/state) | TAMAM |
| 6 | Plugin Runtime (EPR 8 EP, DAG, CB, lifecycle) | TAMAM |
| 7 | Plugin Intelligence (Telemetry, CB v2, Rollback, HotSwap) | TAMAM |
| 8 | System Coordination (BehaviorGraph, CausalTracer, PolicyEngine) | TAMAM |
| 9 | Bounded Autonomy (EBM, InteractionGuard, Governor, CAL) | TAMAM |
| 10 | Knowledge Layer (KR, Catalog, Matrix, Recommendations) | TAMAM |
| FAZ X | System Stabilization (RuntimeContract, DriftDetector) | TAMAM |

## Core Freeze v1.0
Core donduruldu. Yeni özellik Core'a girmez.
Kural: "Bu kod olmadan sistem yaşayamaz mı?" → Evet=Core, Hayır=üst katman.

## Mimari Kurallar
1. CB (Circuit Breaker) = SAFETY → her zaman override eder
2. Intelligence = OPTIMIZE → sadece öneri verir
3. PolicyEngine = tek karar noktası
4. CAL sadece: degrade/throttle/isolate/recommend_rollback
5. CB override YASAK
6. Knowledge → PolicyEngine'e VERİ sağlar, yerine GEÇMEZ

## Çalışma Kuralları
1. Her faz sonunda Python/Node ile otomatik test
2. Syntax kontrolü (tüm plugin/ ve core/ dizini)
3. Test geçince ZIP ver
4. Constructor'da private readonly kullanma (Node.js 26 desteklemiyor)
5. interface yerine type = kullan
6. Test kodunda TypeScript cast kullanma

## Termux Başlatma
```bash
cd ~/1XX1-v1.0.0
node --experimental-strip-types main.ts
# http://localhost:1331/app
# http://localhost:1331/cluster/state
# http://localhost:1331/raft/status
```

## GitHub Repoları
- Kaynak kod: https://github.com/1XX1-Platform/1XX1 (main branch)
- Android proje: https://github.com/1XX1-Platform/1XX1-Android (main branch)
- Token (workflow+repo): TOKEN_GIZLI

## APK Build — DEVAM EDİYOR (Kaldığımız Yer)

### Sorun
GitHub Actions ile APK build yapılıyor ama Kotlin derleme hataları var.

### Son hata (en son build)
```
e: NodeBridge.kt:160:1 Syntax error: Unclosed comment
e: MainActivity.kt - Conflicting import: R ambiguous
e: X1XXBrowserActivity.kt - Unresolved reference NodeBridge
e: NodeRuntimeLauncher.kt - Unresolved reference NodeBridge, log, setRunning, setStopped
e: NodeForegroundService.kt - Unresolved reference NodeBridge
```

### Yapılacak (yeni sohbette devam)
```bash
# 1. MainActivity'den duplicate R import kaldır
sed -i '/import com.kaptan.x1xx.R/d' ~/1xx1-android/app/src/main/java/com/kaptan/x1xx/ui/MainActivity.kt

# 2. Browser'dan da kaldır
sed -i '/import com.kaptan.x1xx.R/d' ~/1xx1-android/app/src/main/java/com/kaptan/x1xx/browser/X1XXBrowserActivity.kt

# 3. Push
git add .
git commit -m "Fix: remove duplicate R import"
git push
```

Ama asıl sorun NodeBridge referansları — tüm Kotlin dosyaları Claude tarafında
yeniden yazılmalı, temiz ve doğru import'larla.

### Android Proje Yapısı
```
~/1xx1-android/
  app/src/main/java/com/kaptan/x1xx/
    bridge/NodeBridge.kt          ← OkHttp ile Node.js köprüsü
    browser/X1XXBrowserActivity.kt ← WebView tarayıcı
    runtime/NodeRuntimeLauncher.kt ← Node.js başlatıcı
    service/NodeForegroundService.kt ← Arka plan servisi
    ui/MainActivity.kt            ← Ana ekran
  app/build.gradle
    namespace 'com.kaptan.x1xx'
    applicationId "com.kaptan.x1xx"
    compileSdk 35, targetSdk 35, minSdk 26
    AGP 8.5.2, Kotlin 2.0.21, JDK 17
  build.gradle
    AGP 8.5.2, Kotlin 2.0.21
  gradle.properties
    android.useAndroidX=true
    android.enableJetifier=true
    android.aapt2FromMavenOverride=/data/data/com.termux/files/usr/bin/aapt2
  .github/workflows/build-apk.yml
    JDK 17, assembleDebug, artifact upload
```

### Hedef
GitHub Actions'ta BUILD SUCCESSFUL → APK indir → telefona kur → Termux'suz çalışsın

## Sonraki Fazlar (APK bittikten sonra)
FAZ 11 — Kullanıcı kimliği (hesap sistemi)
FAZ 12 — Yaş + rol politikası
FAZ 13 — Farklı UI'lar
