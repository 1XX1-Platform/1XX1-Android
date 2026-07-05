# 1XX1 Platform — Bağımlılık Kuralları (DEPENDENCY_RULES)

**Sürüm:** Aşama 17  
**Durum:** Zorunlu

---

## Genel Prensip

Her katman yalnızca **bir alt katmanı** bilir.  
Üst katman alt katmanı tanır; alt katman üst katmanı tanımaz.

---

## İzin Matrisi

```
Modül              ← İmport Edebilir
──────────────────────────────────────────────────────────────
core/              ← (hiçbir şey — bağımsız çekirdek)
database/          ← core/
search/            ← core/, cube_engine/
pulse/             ← core/
channel/           ← core/
asset/             ← core/
security/          ← core/, asset/metadata (sadece tipler)
sandbox/           ← core/, security/security-types (sadece tipler)
application/       ← core/, channel/, pulse/, asset/, security/, sandbox/
api/               ← application/, search/, pulse/
distributed/       ← core/ (kendi içinde izole)
consensus/         ← distributed/, core/, pulse/pulse-types (sadece tipler)
p2p/               ← core/, distributed/security (sha256Hex)
preview/core/      ← core/, asset/entities (tipler), p2p/ (CID)
preview/renderer/  ← preview/core/ (tek yönlü — Core asla Renderer'ı bilmez)
plugin/core/             ← core/
plugin/extension-points/ ← plugin/core/, security/security-types (tip), preview/core/preview-types (tip), consensus/consensus-types (tip)
plugin/sandbox/          ← plugin/core/, sandbox/sandbox-types
plugin/registry/         ← plugin/core/, plugin/extension-points/, plugin/sandbox/
ui/                ← api/ (HTTP client), preview/renderer/
```

---

## Katman Detayları

### `core/`
**İmport edebilir:** Hiçbir şey  
**Dışa aktarır:** ILogger, IEventBus, ErrorCode, generateId, SystemError, config

### `database/`
**İmport edebilir:** `core/`  
**Yasak:** domain modülleri (channel, pulse, asset...)  
**Not:** Database yalnızca generic persistence — domain bilgisi yok

### `search/`
**İmport edebilir:** `core/`, `cube_engine/`  
**Yasak:** channel, pulse, asset servislerini → yalnızca arama tiplerini  
**Kural:** Search READ-ONLY — hiçbir zaman yazma işlemi yapmaz

### `pulse/`
**İmport edebilir:** `core/`  
**Yasak:** consensus/, distributed/, channel/, asset/  
**Kural:** Pulse Engine Raft'ı bilmez — ConsensusNode dışarıdan commitPulse() çağırır

### `channel/`
**İmport edebilir:** `core/`  
**Yasak:** pulse/, asset/, security/  
**İstisna:** TrustScore hesaplamada proje tipi için `core/types.ts`

### `asset/`
**İmport edebilir:** `core/`  
**Yasak:** channel/, pulse/, security/, p2p/  
**Not:** Storage Adapter ayrı — asset domain depolama implementasyonunu bilmez

### `security/`
**İmport edebilir:** `core/`, `asset/entities` (sadece tipler)  
**Yasak:** channel/, pulse/, distributed/, consensus/  
**Kural:** Security analizörler karar vermez — PolicyEngine karar verir

### `sandbox/`
**İmport edebilir:** `core/`, `security/security-types` (sadece tipler)  
**Yasak:** asset/, channel/, distributed/  
**Kural:** Sandbox gözlem yapar — karar Policy Engine'e aittir

### `application/`
**İmport edebilir:** `core/`, `channel/`, `pulse/`, `asset/`, `security/`, `sandbox/`  
**Yasak:** `api/`, `distributed/`, `consensus/`  
**Kural:** CQRS — Commands yazar, Queries okur. Asla HTTP bilmez.

### `api/`
**İmport edebilir:** `application/`, `search/`, `pulse/` (istatistik için)  
**Yasak:** domain entity'lerini direkt expose etmez → DTO kullanır  
**Kural:** API katmanı translate eder — domain logic içermez

### `distributed/`
**İmport edebilir:** `core/` (interfaces, utils)  
**Yasak:** application/, channel/, pulse/, asset/, consensus/  
**Kural:** Distributed katman domain'e kör — yalnızca generik veri taşır

### `consensus/`
**İmport edebilir:** `distributed/`, `core/`, `pulse/pulse-types` (sadece tipler)  
**Yasak:** asset/, channel/, security/, application/, p2p/  
**Kural:** Consensus genel — pulse komutunu bilir ama pulse implementasyonunu değil  
**Alt modüller (Aşama 18):** `consensus/compaction/` ve `consensus/join/` yalnızca
`consensus/` içi ve `distributed/sync/`, `distributed/security/` import eder —
Aşama 16'nın `p2p/`'ini import ETMEZ (aynı chunk/hash prensibi ayrı implemente edilir)

### `p2p/`
**İmport edebilir:** `core/`, `distributed/security` (sha256Hex için)  
**Yasak:** asset/, channel/, pulse/, consensus/  
**Kural:** P2P yalnızca byte taşır — domain bilgisi yok

### `preview/core/` (Aşama 17)
**İmport edebilir:** `core/`, `asset/entities` (tipler), `p2p/` (CID)  
**Yasak:** application/, channel/, pulse/, distributed/, **preview/renderer/**  
**Kural:** Platform bağımsız — `document`, `window`, `HTMLElement`, Browser API, React, Vue, CSS bilmez. Preview Core hiçbir zaman Renderer'ı import edemez.

### `preview/renderer/` (Aşama 17)
**İmport edebilir:** `preview/core/` (tek yönlü bağımlılık)  
**Yasak:** application/, channel/, pulse/, distributed/  
**Kural:** Browser/DOM bilir. `renderToHtml()` her ortamda çalışmak zorunda (SSR dahil); `render()` opsiyonel ve yalnızca `document` mevcutsa çalışır.

---

## Tip vs İmplementasyon

Bir modül başka bir modülden yalnızca tip import edebilir:
```typescript
// ✅ İzin verilir — sadece tip
import type { PulseEntry } from "../../pulse/pulse-types.ts";

// ❌ Yasaktır — implementasyon import
import { PulseScheduler } from "../../pulse/scheduler/pulse-scheduler.ts"; // consensus içinde
```

---

## Circular Import Kontrolü

Aşağıdaki bağımlılıklar yasaktır (döngü oluşturur):

```
// ❌
search/ → application/ → search/
// ❌
pulse/  → consensus/  → pulse/
// ❌
asset/  → p2p/        → asset/
// ❌
channel/ → security/ → channel/
```

---

## Test Modülleri

Test dosyaları (`__tests__/`) herhangi bir modülü import edebilir.  
Ancak test yardımcıları (`test-utils.ts`) sadece `core/` import eder.

### `plugin/core/` (Aşama 19)
**İmport edebilir:** `core/`  
**Yasak:** application/, channel/, pulse/, distributed/, herhangi bir extension-point implementasyonu  
**Kural:** `IPlugin` sözleşmesi minimal tutulur — gerçek işlevsellik extension-points/'ten gelir

### `plugin/extension-points/` (Aşama 19)
**İmport edebilir:** `plugin/core/`, `security/security-types` (yalnızca tip), `preview/core/preview-types` (yalnızca tip), `consensus/consensus-types` (yalnızca tip)  
**Yasak:** Gerçek implementasyon importu (`security/analyzers/...`, `preview/core/extractors.ts` vb.) — yalnızca arayüz/tip uyumluluğu sağlanır  
**Kural:** Bu dosyalar mevcut çekirdek arayüzlerle (`IAnalyzer`, `IPreviewExtractor`) yapısal uyum sağlar ama onları doğrudan import etmez

### `plugin/sandbox/` (Aşama 19)
**İmport edebilir:** `plugin/core/`, `sandbox/sandbox-types` (Aşama 13 `ISandboxAdapter` arayüzü)  
**Yasak:** `asset/`, `channel/`, `distributed/`  
**Kural:** Plugin çalıştırma izolasyonu Aşama 13'ün gözlem-yapar-karar-vermez prensibini miras alır

### `plugin/registry/` (Aşama 19)
**İmport edebilir:** `plugin/core/`, `plugin/extension-points/`, `plugin/sandbox/`, `sandbox/sandbox-types`  
**Yasak:** Doğrudan domain modülü importu (channel/, pulse/, asset/)  
**Kural:** Registry yalnızca yaşam döngüsü ve versiyon yönetimi yapar; gerçek entegrasyon (örn. arama skoruna plugin katkısı eklemek) çekirdek modülün kendi adapter kodunda gerçekleşir, registry'de değil

---

## Yeni Modül Ekleme Protokolü

1. Bu dosyaya yeni satır ekle
2. ARCHITECTURE.md diyagramını güncelle
3. INVARIANTS.md'de yeni kurallar gerekiyorsa ekle
4. Circular import kontrol et
5. PR'da reviewer onayı al

---

## Araç Önerisi

```bash
# Bağımlılık analizi (Aşama 20'de otomatikleştirilecek)
npx madge --circular ./src
npx dependency-cruiser --validate .dependency-cruiser.js ./src
```
