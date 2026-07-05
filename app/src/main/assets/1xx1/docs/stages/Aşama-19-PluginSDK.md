# Aşama-19 — Plugin SDK

**Tarih:** 2026-06-29  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-20 — Production Hardening

---

## Mimari Geçiş

> Aşama 1–18: **"distributed system core"**  
> Aşama 19+: **"platform ecosystem"**

Sistem çekirdeği DEĞİŞMEDEN dış geliştiriciler genişletebilir hale geldi.
Bu aşama yeni bir özellik değil, mevcut sistemin **resmileştirilmesi**:
Aşama 12'nin `IAnalyzer`'ı, Aşama 17'nin `IPreviewExtractor`'ı ve Aşama 13'ün
`ISandboxAdapter`'ı zaten birer mikro-plugin desenidir — bu SDK onları
ortak bir yaşam döngüsü, izin modeli ve sandbox çerçevesi altında birleştirir.

---

## Mimari

```
plugin/
 ├── core/
 │   └── plugin-types.ts        — IPlugin, PluginManifest, PluginContext,
 │                                  PluginPermission, validateManifest()
 │
 ├── extension-points/
 │   ├── data-plugins.ts        — ISearchPlugin, IAssetProcessor,
 │   │                             IPulseModifier, IIndexAugmenter
 │   └── observer-plugins.ts    — IEventInterceptor, ISecurityAnalyzerPlugin,
 │                                  IPreviewGeneratorPlugin, IConsensusExtension
 │                                  + adaptSecurityPlugin()/adaptPreviewPlugin()
 │
 ├── sandbox/
 │   └── plugin-sandbox.ts      — PluginSandboxRunner (Aşama 13 ISandboxAdapter
 │                                  sarmalayıcısı), IsolatedPluginMemory
 │
 └── registry/
     └── plugin-registry.ts     — PluginRegistry (kayıt, versiyon, bağımlılık,
                                    yaşam döngüsü), satisfiesVersion()
```

---

## 1. Core Plugin Interface

```typescript
interface IPlugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}
```

Kasıtlı olarak küçük — gerçek işlevsellik extension-points/'ten gelir.

---

## 2. Extension Points (8 Adet — Hepsi Gerçek Çekirdek Sisteme Bağlı)

| Extension Point | Arayüz | Bağlandığı Çekirdek Sistem | Sınır |
|---|---|---|---|
| `search` | `ISearchPlugin` | search/ (Aşama 04-05) | Skor katkısı [0,1], filtre |
| `asset_processor` | `IAssetProcessor` | asset/ (Aşama 11) | Yalnızca metadata, binary değil |
| `pulse_hook` | `IPulseModifier` | pulse/ (Aşama 10) | **≤%5 ana formül ağırlığı** |
| `index_augmenter` | `IIndexAugmenter` | search/ indeksi | Yalnızca ek alan, indeks yazmaz |
| `event_interceptor` | `IEventInterceptor` | EventBus (core/) | Fire-and-forget, dönüş yok |
| `security_analyzer` | `ISecurityAnalyzerPlugin` | security/ (Aşama 12) | `IAnalyzer` ile yapısal uyum |
| `preview_generator` | `IPreviewGeneratorPlugin` | preview/core/ (Aşama 17) | `IPreviewExtractor` ile yapısal uyum |
| `consensus_extension` | `IConsensusExtension` | consensus/ (Aşama 15/18) | **Salt-okunur, propose/vote yok** |

### Kritik Güvenlik Sınırı: IPulseModifier

```typescript
export const MAX_PLUGIN_PULSE_WEIGHT = 0.05; // ana formülün %5'i

function clampPulseAdjustment(raw: number): number {
  return Math.max(-1, Math.min(1, raw)) * MAX_PLUGIN_PULSE_WEIGHT;
}
```

Kötü niyetli bir plugin `proposeAdjustment()`'tan `9999` döndürse bile,
uygulanan etki her zaman `≤ 0.05`'tir. INVARIANTS.md II-1'in ("para/bağış
sıralamayı etkilemez") plugin ekosistemine genişletilmiş hali — test edildi.

### Kritik Güvenlik Sınırı: IConsensusExtension

```typescript
interface IConsensusExtension {
  onStateChange?(state: ConsensusState): Promise<void>;
  onPulseBlockCommitted?(block: PulseBlock): Promise<void>;
  // "propose()" veya "vote()" KASITLI OLARAK arayüzde YOK
}
```

ADR-006'nın Sybil-direnç garantisi (yalnızca validator'lar oy kullanır)
plugin arayüzünde tip sistemi seviyesinde korunuyor.

---

## 3. Sandbox Isolation

Aşama 13'ün `ISandboxAdapter`'ı yeniden kullanılır — yeni bir izolasyon
sistemi yazılmadı:

```typescript
const PLUGIN_RESOURCE_LIMITS: ResourceLimits = {
  cpuTimeMs:       2_000,   // Aşama 13 varsayılanından (5000) daha sıkı
  maxMemoryBytes:  64 MB,   // Aşama 13 varsayılanından (128 MB) daha sıkı
  maxDiskBytes:    0,       // plugin'ler disk yazamaz
  wallTimeMs:      10_000,
  allowNetwork:    false,
};
```

**Memory Boundary**: her plugin `IsolatedPluginMemory` adında ayrı bir
bellek alanına sahiptir — core state'e hiçbir doğrudan referans taşımaz.

**Event-Only Communication**: `PluginContext` plugin'in dış dünyayla TEK
temas noktasıdır. `emitEvent()` ve `readResource()` her çağrıda izin
kontrolü yapar (deny-by-default).

---

## 4. Registry System

```
register(plugin, implementations)
  → validateManifest()           [isim, versiyon, izin, extension point kuralları]
  → kapasite/isim çakışması kontrolü
  → platform versiyon uyumluluğu  [satisfiesVersion()]
  → bağımlılık çözümleme          [her dependency için versiyon kontrolü]
  → implementation/extensionPoint tutarlılığı
  → status: "registered"

activate(pluginName)
  → PluginSandboxRunner.initPlugin()
  → status: "active" | "failed"

activeByExtensionPoint("search")
  → yalnızca status==="active" olan plugin'lerin implementasyonları
  → çekirdek sistem (örn. SearchEngine) bunları kullanır
```

**Versiyonlu uyumluluk**: `satisfiesVersion()` minimal semver (`^`, `~`,
`>=`, tam eşleşme) — sıfır bağımlılık prensibi korunur.

**Bağımlılık çözümleme**: eksik bağımlılık veya versiyon uyumsuzluğu
→ kayıt reddedilir, plugin hiç init edilmez.

---

## Test Kapsamı (11 grup, 60+ test)

| Grup | Vurgu |
|---|---|
| manifest-validation | İsim/versiyon regex, izin/extension-point çelişki tespiti |
| version-compat | `^`, `~`, `>=`, tam eşleşme semver davranışı |
| pulse-modifier-limits | 9999 önerisi bile ≤%5 etki — kritik güvenlik testi |
| search-plugin-clamp | [0,1] skor sınırlama |
| sandbox-isolation | init/shutdown, hata yönetimi, memory boundary, healthCheck timeout |
| event-only-comm | İzinsiz event/resource erişimi reddedilir |
| registry-lifecycle | register→activate→deactivate, suspend, stats |
| registry-dependency | Eksik/uyumsuz bağımlılık reddi |
| extension-point-binding | Gerçek senaryo: search/pulse plugin entegrasyonu |
| Determinizm | Aynı manifest → aynı doğrulama (10 iterasyon) |
| Performans | 50 plugin kayıt+aktivasyon < 2s |

---

## ADR

- **ADR-010**: Mevcut arayüzlerle yapısal uyum kararı, güvenlik sınırları,
  deny-by-default izin modeli, minimal semver kararı

---

## Sonraki Aşamanın Amacı

**Aşama-20 — Production Hardening**

- Prometheus Metrics, OpenTelemetry, Distributed Tracing
- Health Checks (Aşama 14 NodeHealthMonitor'ın genişletilmesi)
- Docker, Kubernetes, Helm dağıtım paketleri
- Backup/Restore (Aşama 18 Snapshot sisteminin operasyonel hale getirilmesi)
- Chaos Tests, Load Tests, Benchmark Suite
- `PluginSandboxRunner` → gerçek V8 isolate/WASM runtime (Aşama 19'da bırakılan teknik not)

---

## Ek — Mimari İnceleme Sonrası Risk Düzeltmeleri

Kaptan'ın incelemesi üç ileri seviye risk tespit etti; üçü de aynı oturumda çözüldü (bkz. ADR-010 Bölüm 6):

| Risk | Çözüm | Yeni Dosya |
|---|---|---|
| Capability Explosion | 8 önceden denetlenmiş `CapabilityProfile` — profil otoritedir, manifest'in serbest seçimini geçersiz kılar | `plugin/core/capability-profiles.ts` |
| Sandbox Drift | Zorunlu `IsolationLevel` beyanı (`none<simulated<process<container<vm`); `activate()` öncesi doğrulanır, uyumsuzsa açıkça reddedilir | `plugin/sandbox/isolation-level.ts` |
| Cross-plugin Interaction | `PluginDependencyGraph` (Aşama 11 DependencyGraph ile aynı desen) — döngü tespiti, `impactRadius()` ile blast-radius analizi, `deactivate()` öncesi operatöre bildirim | `plugin/registry/plugin-dependency-graph.ts` |

**30+ yeni test** (`plugin/__tests__/risk-mitigations.test.ts`) — özellikle `registry-integration` grubu üç düzeltmenin BİRLİKTE çalıştığını doğruluyor (örn. process gerektiren plugin Mock adapter ile register edilir ama activate aşamasında reddedilir).
