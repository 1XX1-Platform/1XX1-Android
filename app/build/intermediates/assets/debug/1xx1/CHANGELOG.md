# Değişiklik Günlüğü

## [1.0.0] — 2026-07-01

### İlk Üretim Sürümü

#### Çekirdek Platform (Aşama 01–13)
- Fraktal Küp Motoru (11³ = 1331 kök küp, split/merge, NodeLock)
- Arama Motoru: Semantic + Structural + Reverse Index
- REST API + SSE stream + rate limiter
- Database: InMemoryPool + PgPool, UnitOfWork, 6 migration
- CQRS + Orchestrator + 11 validator + Policy Engine
- Kanal sistemi: slug, wallets, TrustScore (6 metrik)
- Pulse Engine: `pulseNumber = floor(unixMs/intervalMs)`, deterministik fairness
- Asset Bank: 13 AssetType, 14 LicenseType, SHA-256+SHA-512
- Güvenlik: 4 analizör, 6 kural (P001-P006), Risk Engine
- Sandbox: ISandboxAdapter, BehaviorMonitor

#### Dağıtık Altyapı (Aşama 14–16)
- Node Runtime: Gossip (fan-out k=6, LRU 10K, TTL), PeerManager
- Lightweight Raft: Lider seçimi + log replikasyonu, majority commit
- PulseBlock zinciri: deterministik hash zinciri
- P2P CAS: CID=SHA-256, 2MB chunk, TransferEngine (concurrency=4)

#### Önizleme + Compaction + Plugin (Aşama 17–19)
- Preview Engine: Core/Renderer ayrımı (I-11 invariant)
- Log Compaction: IncrementalLogCompactor + FastJoin protokolü
- Plugin SDK: 8 extension point, 3 risk düzeltmesi, god-object refactor
  - PluginSecurityLayer, PluginGraphResolver, PluginLifecycleManager

#### Production Hardening (Aşama 20)
- Prometheus metrics, OpenTelemetry tracing, Structured logging
- Docker multi-stage + Docker Compose 3-node cluster
- Kubernetes Helm chart (anti-affinity, PodDisruptionBudget)
- Chaos testleri, Performance certification, 7 operasyon belgesi
- Architecture Freeze ilanı

#### Web UI (Aşama 21)
- Offline-first single-file web arayüzü
- Orbitron + Share Tech Mono + Inter fontları
- 8 sayfa: Dashboard, Pulse, Arama, Projeler, Kanallar, Assets, Küme, Plugin'ler

#### 1331 Spatial Mesh Protocol (Aşama 22–24)
- Ghost Cube: Temporary Spatial Reservation, DR(d) → priority
- GhostChainBuilder, GhostRouter (hibrit mod), PathOptimizer
- SpatialTopology (k-hop), GhostHealthMonitor, RouteCache
- GhostReplication (DR×kopya), GhostReceipt (confidence score)
- LinkManager: BLE/WiFi/LAN otomatik seçimi
- LANTransport: UDP multicast, gerçek peer keşfi (Termux'ta çalışır)
- Simülasyon v2: Ghost vs AODV, gerçek donanım modeli

#### Final Release (Bu Sürüm)
- README, LICENSE, CHANGELOG, tsconfig.json
- Platform başlatıcıları (Linux, macOS, Windows, Termux)
- PDF-1: Teknik Mimari Raporu
- PDF-2: Kullanıcı Kılavuzu (TR + EN)

---

## [0.x.x] — 2026-01 / 2026-06

Geliştirme aşamaları — bkz. `docs/stages/`
