# 1XX1 Platform — Release Notes

**Versiyon:** 1.0.0  
**Tarih:** 2026-06-29  
**Tip:** İlk Üretim Sürümü (General Availability)

---

## Bu Sürüm Nedir?

1XX1 v1.0.0, **merkeziyetsiz, reklamsız, açık kaynak uygulama ekosistemi**
platformunun çekirdek üretim sürümüdür.

Bu sürüm "platform çekirdeği"dir — üzerine farklı ürünlerin inşa
edilebileceği temel katman. Doğrudan son kullanıcıya değil, 1XX1 üzerinde
ürün/servis geliştiren ekiplere/geliştiricilere yöneliktir.

---

## Yenilikler (v1.0.0)

### Çekirdek Platform (Aşama 01–13)
- **Fraktal Küp Motoru:** 11³ = 1331 kök küp, split/merge, NodeLock, RecursionGuard
- **Arama Motoru:** Semantic + Structural + Reverse Index; skor: `sem×0.55 + str×0.30 + meta×0.10 + rec×0.05`
- **REST API:** Hız sınırlı, token bucket tabanlı; SSE stream endpoint
- **Persistence:** InMemoryPool + PgPool, 6 migration, TransactionManager, UnitOfWork
- **Domain Katmanı:** CQRS Commands + Queries, 11 validator, Policy Engine, Orchestrator
- **Kanal Sistemi:** Channel entity, slug, wallets, TrustScore (6 metrik, max 100)
- **Pulse Engine:** `pulseNumber = floor(unixMs/intervalMs)`, fairness, deterministik sıralama
- **Asset Bank:** 13 AssetType, 14 LicenseType, SHA-256+SHA-512 checksum, DependencyGraph
- **Güvenlik Analiz:** 4 analizör (StaticAnalyzer, BinaryAnalyzer, MetadataAnalyzerChecker, DependencyAnalyzerChecker), 6 kural P001-P006
- **Sandbox:** ISandboxAdapter, MockSandboxAdapter, ProcessSandboxAdapter, BehaviorMonitor

### Dağıtık Altyapı (Aşama 14–16)
- **Node Runtime:** Gossip (fan-out k=6, LRU duplicate cache 10.000, TTL), PeerManager, EventLog, SnapshotManager, NodeHealthMonitor
- **Lightweight Raft:** Lider seçimi + log replikasyonu, majority commit, deterministik election timeout (seededRandom xorshift32)
- **PulseBlock Zinciri:** blockNumber, pulseHash, snapshotHash, validatorRoot, zincir bütünlüğü
- **P2P Content-Addressed Storage:** CID = SHA-256(içerik), Chunking (2 MB), ContentAddresser, TransferEngine (concurrency=4, retry max 3)

### Önizleme + Compaction + Plugin (Aşama 17–19)
- **Preview Engine:** Core/Renderer ayrımı (I-11 invariant), 6 extractor, 6 renderer, `renderToHtml()` her ortamda çalışır
- **Log Compaction:** IncrementalLogCompactor (retainTail garantisi), IncrementalSnapshotBuilder (full+delta), SnapshotStreamer (256 KB chunk), Fast Join
- **Plugin SDK:** 8 extension point, 3 güvenlik düzeltmesi (Capability Profile, IsolationLevel, DependencyGraph), God-Object refactor (PluginSecurityLayer + PluginGraphResolver + PluginLifecycleManager)

### Production Hardening (Aşama 20)
- Prometheus metrics, OpenTelemetry tracing, Structured logging, Correlation ID
- Docker multi-stage build, Docker Compose 3-node cluster, Kubernetes Helm chart
- Chaos testleri (network partition, leader failure, snapshot recovery, plugin failure)
- Performance certification (search latency, consensus latency, snapshot restore, plugin load)

---

## Sürüm Numaralandırma

`MAJOR.MINOR.PATCH`

- `MAJOR` → uyumsuz API değişikliği
- `MINOR` → geriye uyumlu yeni özellik
- `PATCH` → geriye uyumlu hata düzeltmesi

v1.0.0: Architecture Freeze sonrası ilk GA sürüm.

---

## Bilinen Kısıtlamalar

| Kısıtlama | Not |
|---|---|
| Gerçek disk persistence yok | InMemory + PostgreSQL (pg pool); gerçek WAL/RocksDB Aşama 21+ |
| Plugin WASM izolasyonu yok | PluginSandboxRunner sözleşme + gözlem; gerçek V8/WASM Aşama 21+ |
| TLS/HTTPS zorunlu değil | Transport katmanı transport-agnostic; TLS wrapper eklenmeli |
| Semver range tam destek yok | `^`, `~`, `>=`, tam eşleşme; OR/range Aşama 21+ |

---

## Yükseltme Rehberi

Bu ilk GA sürüm olduğu için yükseltme rehberi bulunmamaktadır.
v1.1.0 sürümünde yer alacaktır.

---

## Lisans

MIT License — bkz. `LICENSE` dosyası
