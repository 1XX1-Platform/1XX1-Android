# ADR-010 — Plugin SDK

**Tarih:** 2026-06-29  
**Durum:** Kabul Edildi  
**Aşama:** 19

---

## 1. Problem

Aşama 1–18 boyunca "distributed system core" inşa edildi: çekirdek dağıtık
platform artık üretim kalitesinde (Aşama 18: bounded log, incremental
snapshot, fast join). Ancak sistem yalnızca Anthropic/Kaptan'ın yazdığı
kodla genişleyebiliyor — dış geliştiriciler katkı sağlayamıyor.

Mevcut sistemde zaten **mikro-plugin desenleri** vardı ama resmi değildi:

- `IAnalyzer` (Aşama 12) — statik/binary/metadata analiz
- `IPreviewExtractor` (Aşama 17) — önizleme üretimi
- `ISandboxAdapter` (Aşama 13) — çalıştırma izolasyonu

Bu desenler kanıtlanmıştı ama her biri kendi modülüne özgüydü, ortak bir
yaşam döngüsü/izin/sandbox çerçevesi yoktu.

---

## 2. Kararlar

### Neden Mevcut Arayüzlerle Yapısal Uyum (Yeniden Yazım Değil)?
- `ISecurityAnalyzerPlugin` → `IAnalyzer` ile yapısal olarak özdeş
- `IPreviewGeneratorPlugin` → `IPreviewExtractor` ile yapısal olarak özdeş
- `adaptSecurityPlugin()`/`adaptPreviewPlugin()` köprü fonksiyonları, plugin'i
  çekirdeğin zaten bildiği arayüze dönüştürür — `AnalysisPipeline` veya
  `PreviewService.registerExtractor()` SIFIR DEĞİŞİKLİKLE plugin kabul eder
- Bu, "sistem çekirdeği değişmeden genişler" hedefinin somut kanıtı

### Neden IPulseModifier'a Matematiksel Sınır (MAX_PLUGIN_PULSE_WEIGHT)?
- INVARIANTS.md II-1: "Para/bağış sıralamayı hiçbir zaman etkilemez"
- Plugin ekosistemi bu garantiyi zayıflatabilir: kötü niyetli/hatalı bir
  plugin Pulse sıralamasını manipüle edebilir
- Çözüm: `clampPulseAdjustment()` her zaman `≤ %5` ana formül ağırlığına
  sınırlar — `proposeAdjustment()` 9999 döndürse bile etki ihmal edilebilir kalır
- Bu sınır test edilebilir ve test edildi (`pulse-modifier-limits` grubu)

### Neden IConsensusExtension Salt-Okunur (propose/vote Metodu Yok)?
- ADR-006: "Herkes Raft'a katılırsa Sybil attack riski" — validator seti
  kapalı ve konsensüsle yönetilir
- Plugin arayüzünde KASITLI OLARAK `propose()`/`vote()` metodu YOK —
  yalnızca `onStateChange`/`onPulseBlockCommitted` callback'leri
- Bu, "plugin asla validator olamaz" garantisini tip sisteminde somutlaştırır

### Neden Event Interceptor Dönüş Değeri Yok (Fire-and-Forget)?
- INVARIANTS I-7: "EventBus hiçbir zaman Storage'ı bilmez" — event akışı
  tek yönlü ve mutasyona kapalı olmalı
- `onEvent(): Promise<void>` — event'i değiştirip geri döndürme imkanı yok
- Bu, plugin'lerin event akışını kesintiye uğratmasını mimari olarak imkansız kılar

### Neden Aşama 13 ISandboxAdapter Yeniden Kullanıldı (Yeni Sandbox Yazılmadı)?
- Aşama 13'ün "gözlem yapar, karar vermez" prensibi plugin çalıştırma için
  de geçerli — tekerleği yeniden icat etmek yerine `PluginSandboxRunner`
  mevcut `ISandboxAdapter`'ı sarmalar
- `PLUGIN_RESOURCE_LIMITS` genel sandbox limitlerinden daha sıkı (64 MB vs
  128 MB, 2s CPU vs 5s) — plugin'ler sürekli çalışan, daha hafif bileşenler

### Neden Deny-by-Default İzin Modeli?
- `PluginPermission` listesi boşsa plugin HİÇBİR ŞEYE erişemez
- `PluginContext.emitEvent()`/`readResource()` her çağrıda izin kontrolü yapar
- Manifest doğrulama zaten çelişkili izin/extension-point kombinasyonlarını
  reddeder (örn. `write:pulse_score` izni `pulse_hook` olmadan anlamsız)

### Neden Minimal Semver (Tam Kütüphane Değil)?
- `satisfiesVersion()` yalnızca `^`, `~`, `>=`, tam eşleşme destekler
- Sıfır bağımlılık prensibi (1XX1 genelinde tutarlı: ADR-001'den beri)
- Karmaşık range'ler (`||`, `-`) Aşama 19 kapsamı dışında — ihtiyaç olursa genişletilir

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| WASM-tabanlı plugin (gerçek izolasyon) | Aşama 19 kapsamı: sözleşme + sandbox entegrasyonu; gerçek WASM runtime Aşama 20+ |
| npm paket sistemi (package.json) | Harici registry bağımlılığı; 1XX1 kendi P2P/CAS sistemine sahip (Aşama 16) |
| Plugin'lere doğrudan Repository erişimi | INVARIANTS VI-1 ihlali; güvenlik riski |
| Ağırlıksız (sınırsız) Pulse modifier | II-1 ihlali — manipülasyon riski |
| Plugin'lerin Raft'a oy hakkı vermesi | Sybil-direnç garantisini kırar (ADR-006) |
| Tam semver kütüphanesi (node-semver) | Dış bağımlılık; minimal implementasyon yeterli |

---

## 4. Sonuçlar

**Artıları:**
- Çekirdek sistem hiçbir satır değişmeden genişletilebilir hale geldi
- 8 extension point, her biri gerçek bir çekirdek sisteme (search, asset,
  pulse, index, event, security, preview, consensus) karşılık geliyor
- Güvenlik sınırları matematiksel olarak test edilebilir (`clampPulseAdjustment`)
- `PluginRegistry` versiyon/bağımlılık çözümlemesi deterministik
- Sandbox izolasyonu Aşama 13'ün kanıtlanmış desenini yeniden kullanıyor

**Eksileri:**
- Gerçek kod izolasyonu (WASM/V8 isolate) henüz yok — `PluginSandboxRunner`
  şu an sözleşme + gözlem akışı kurar, gerçek untrusted-code execution
  Aşama 20'ye bırakıldı
- `readResource()` şu an placeholder (`null` döner) — gerçek resource
  provider'lar (örn. PulseScheduler'dan canlı veri) entegrasyon katmanında
  (registry üstü) tamamlanmalı
- Semver range desteği minimal — karmaşık bağımlılık grafiklerinde yetersiz kalabilir

---

## 5. İleride Değiştirilebilir Noktalar

- `PluginSandboxRunner` → gerçek V8 isolate veya WASM runtime (Aşama 20)
- `readResource()` → gerçek resource provider registry (her izin için bir sağlayıcı)
- `satisfiesVersion()` → tam semver range desteği (gerekirse)
- Plugin dağıtımı → Aşama 16 P2P/CAS sistemi üzerinden (CID ile plugin paketi)
- `IConsensusExtension` → gelecekte "danışman" rolü eklenebilir (oy değil, öneri)

---

## 6. Ek — Mimari İnceleme Sonrası Risk Düzeltmeleri (2026-06-29)

Kaptan'ın Aşama 19 teslimi sonrası yaptığı mimari inceleme üç ileri seviye
risk tespit etti. Bu bölüm, her birinin nasıl çözüldüğünü belgeler.

### Risk 1 — Capability Explosion

**Tespit:** Plugin sayısı arttıkça extension point × permission
kombinasyonları çarpımsal büyür; her plugin yazarı izinleri tek tek
seçerse tutarsızlık ve denetim karmaşıklığı doğar.

**Çözüm:** `plugin/core/capability-profiles.ts` — 8 önceden denetlenmiş
`CapabilityProfile` (örn. `search-readonly`, `pulse-fairness-hook`,
`passive-observer`). Plugin yazarı tek tek izin seçmek yerine bir profil
seçer; `resolveCapabilityProfile()` sabit, otoriter bir (extensionPoints,
permissions) demeti döner — manifest'teki serbest seçim YOK SAYILIR.
`"custom"` profili hâlâ mevcuttur ama her zaman bir uyarı üretir (denetim
panelinde görünür olması için).

### Risk 2 — Sandbox Drift

**Tespit:** `ISandboxAdapter` arayüzü var ama hangi implementasyonun
(`MockSandboxAdapter` simüle/`ProcessSandboxAdapter` gerçek OS izolasyonu)
kullanıldığı plugin yazarına/operatöre görünür değildi — production'da
yanlışlıkla Mock adapter kullanılırsa sessiz güvenlik açığı oluşurdu.

**Çözüm:** `plugin/sandbox/isolation-level.ts` — 5 seviyeli `IsolationLevel`
(`none < simulated < process < container < vm`). Her manifest artık
`isolationRequirement` beyan eder (varsayılan: `"process"` — en güvenli
varsayım). `PluginRegistry.activate()`, aktivasyondan ÖNCE
`checkIsolationRequirement()` ile beyan edilen minimum seviye ile mevcut
adapter'ın gerçek seviyesini karşılaştırır; uyumsuzsa plugin SESSİZCE
daha zayıf izolasyonla çalıştırılmaz — açıkça reddedilir
(`status: "failed"`, `plugin:isolation_rejected` event'i).

### Risk 3 — Cross-plugin Interaction

**Tespit:** Model yalnızca plugin→core ve plugin→EventBus etkileşimini
tanımlıyordu. Ancak `emitEvent()` ile bir plugin'in event'i başka bir
`IEventInterceptor` tarafından dinlenebilir — bu, registry'de hiç
görünmeyen implicit bir bağımlılık grafiği oluşturur.

**Çözüm:** `plugin/registry/plugin-dependency-graph.ts` —
`PluginDependencyGraph`, Aşama 11'in `DependencyGraph`'ıyla (asset/) AYNI
kanıtlanmış desende (DAG + BFS döngü tespiti) ama plugin/ modülü asset/'i
import edemeyeceği için (DEPENDENCY_RULES.md) bağımsız olarak yeniden
yazıldı. `register()` artık opsiyonel `subscribesToPlugins` parametresi
alır; döngüsel abonelik (A dinler B'yi, B dinler A'yı) reddedilir.
`deactivate()` öncesi `impactRadius()` ile "blast radius" hesaplanır ve
`plugin:deactivation_impact` event'i ile operatöre bildirilir — implicit/
sessiz bozulma riski, açık/görünür etki analizine dönüştürüldü.

### Test Kapsamı (Risk Düzeltmeleri)

`plugin/__tests__/risk-mitigations.test.ts` — 5 grup, 30+ test:
capability-profiles (profil otoritesi, immutability), isolation-level
(Mock=simulated/Process=process doğrulaması, production-grade kontrolü),
plugin-dependency-graph (döngü tespiti, blast radius, topological order),
registry-integration (üç düzeltmenin birlikte çalışması — örn. process
gerektiren plugin Mock adapter ile register edilir ama activate reddedilir),
determinizm.

---

## İlgili Bileşenler

`plugin/core/plugin-types.ts` · `plugin/core/capability-profiles.ts` · `plugin/extension-points/data-plugins.ts` · `plugin/extension-points/observer-plugins.ts` · `plugin/sandbox/plugin-sandbox.ts` · `plugin/sandbox/isolation-level.ts` · `plugin/registry/plugin-registry.ts` · `plugin/registry/plugin-dependency-graph.ts`

## 7. Ek — God-Object Önleme Refactor'ü (2026-06-29, 2. inceleme)

Kaptan'ın ikinci mimari incelemesi şu tespiti yaptı: `PluginRegistry` üç
ayrı sorumluluğu (security enforcement, dependency graph engine, lifecycle
manager) tek sınıfta topluyordu — büyüdükçe "god-object" riski.

**Çözüm:** `PluginRegistry` ince bir facade'e dönüştürüldü. Gerçek iş üç
bağımsız, tek-sorumluluklu sınıfa taşındı:

| Sınıf | Sorumluluk | Dosya |
|---|---|---|
| `PluginSecurityLayer` | Manifest/versiyon/izolasyon doğrulama | `plugin-security-layer.ts` |
| `PluginGraphResolver` | Cross-plugin etkileşim politikası (atomik ekleme/geri alma, blast-radius) | `plugin-graph-resolver.ts` |
| `PluginLifecycleManager` | register/activate/deactivate/suspend state makinesi | `plugin-lifecycle-manager.ts` |

**Davranış değişmedi — yalnızca iç yapı.** `PluginRegistry`'nin public API
yüzeyi (`register`, `activate`, `activateAll`, `deactivate`, `suspend`,
`get`, `all`, `activeByExtensionPoint`, `healthCheckAll`, `stats`,
`interactionGraph`) birebir korundu; mevcut tüm testler (`plugin.test.ts`,
`risk-mitigations.test.ts`) hiçbir değişiklik gerektirmeden geçmeye devam
eder. Bu, davranışsal bir değişiklik değil, **iç mimari refactor**'üdür.

İsim çakışması notu: `PluginLifecycleManager`'ın generic kayıt tipi
`PluginRegistration` yerine `PluginLifecycleEntry<TImpl>` olarak
adlandırıldı — `plugin/index.ts`'in `export *` ile her iki dosyayı da
dışa açması nedeniyle `PluginRegistration` isminin facade seviyesinde
(`plugin-registry.ts`) tek bir kaynaktan gelmesi gerekiyordu.

---
