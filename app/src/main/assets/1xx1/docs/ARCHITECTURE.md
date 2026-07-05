# 1XX1 Platform — Mimari Genel Bakış

**Sürüm:** Aşama 19  
**Güncelleme:** 2026-06-29

---

## Platform Nedir?

1XX1, merkezi olmayan, reklamsız, açık kaynak uygulama ekosistemidir.  
Platform hiçbir varlığın sahibi değildir; yalnızca indeksler, aranabilirliği ve erişimi organize eder.

---

## Mimari Geçiş (Aşama 19)

Aşama 1–18: **"distributed system core"** — çekirdek dağıtık platform inşa edildi.  
Aşama 19+: **"platform ecosystem"** — çekirdek DEĞİŞMEDEN dış geliştiriciler genişletebilir.

```
┌─────────────────────────────────────────────────────┐
│  EKOSİSTEM KATMANI (Aşama 19+)                      │
│  Plugin SDK                                         │
│  ├── plugin/core/      — IPlugin, manifest, izinler │
│  ├── plugin/extension-points/ — Search/Asset/Pulse/ │
│  │     Index/Event/Security/Preview/Consensus hooks │
│  ├── plugin/sandbox/   — Aşama 13 izolasyonu        │
│  └── plugin/registry/  — versiyon, bağımlılık, yaşam│
│        döngüsü yönetimi                             │
└──────────────────────┬──────────────────────────────┘
                       │ (extension points, event-only)
                       ▼
```

## Katman Diyagramı

```
┌─────────────────────────────────────────────────────┐
│  KULLANICI KATMANI (Aşama 17+)                      │
│  Web UI · Masaüstü · Mobil · CLI                    │
│                                                     │
│  Preview Engine (Aşama 17)                          │
│  ├── preview/core/     — platform bağımsız çekirdek │
│  │     (extractor, cache, service — DOM bilmez)     │
│  └── preview/renderer/ — Browser/DOM katmanı        │
│        (renderToHtml: her ortam, render: yalnız     │
│         tarayıcı — Core'u import eder, tersi yasak) │
│                                                     │
│  Asset Viewer · Pulse Dashboard                     │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP/WebSocket/P2P
┌──────────────────────▼──────────────────────────────┐
│  API KATMANI (Aşama 06)                             │
│  REST · SSE Streaming · Rate Limiting               │
│  Search · Pulse · Asset · Channel · Analysis        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  UYGULAMA KATMANI (Aşama 08)                        │
│  CQRS Commands · Queries · Orchestrator             │
│  Domain Validators · Policy Engine                  │
│  Domain Events                                      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  DOMAIN KATMANI (Aşama 09–13)                       │
│  Channel (Ada) · Release · Trust Score              │
│  Pulse Engine · Eligibility · Ranking · Rotation    │
│  Asset Bank · Dependency Graph · License Policy     │
│  Security Analysis · Static/Binary/Meta Analyzer    │
│  Policy Engine · Risk Engine                        │
│  Sandbox · Behavior Monitor · Telemetry             │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  ÇEKIRDEK KATMANI (Aşama 01–07)                     │
│  Fractal Cube Engine (11³ koordinat)                │
│  Search Engine (semantic + structural + metadata)   │
│  Identity · EventBus · Config · Logger              │
│  Database UnitOfWork · Migrations                   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  DAĞITIK KATMAN (Aşama 14–16)                       │
│                                                     │
│  NodeRuntime (Aşama 14)                             │
│  ├── MessageEnvelope (immutable, versioned)         │
│  ├── LamportClock (IClock → VectorClock hazır)      │
│  ├── GossipEngine (fan-out k=6, LRU anti-dup)      │
│  ├── PeerManager (trust, reputation, heartbeat)     │
│  ├── SyncStore × 6 (eventual consistency)           │
│  ├── EventLog (append-only)                         │
│  ├── SnapshotManager (deterministik hash)           │
│  └── ITransport (Memory|TCP|WS|QUIC stub)           │
│                                                     │
│  ConsensusNode (Aşama 15)                           │
│  ├── RaftEngine (Lightweight Raft)                  │
│  ├── PulseSynchronizer (PulseBlock zinciri)         │
│  └── ValidatorSetManager (weighted quorum)          │
│                                                     │
│  P2P Transfer (Aşama 16)                            │
│  ├── ContentAddresser (CID = SHA-256)               │
│  ├── ChunkStore + ContentRegistry                   │
│  └── IP2PTransport (Memory|QUIC|libp2p stub)        │
└─────────────────────────────────────────────────────┘
```

---

## Modül Bağımlılık Haritası

```
core/          ← hiçbir şeyi import etmez (temel)
database/      ← core
identity/      ← core
event-bus/     ← core
search/        ← core, cube_engine
pulse/         ← core
channel/       ← core
asset/         ← core
security/      ← core, asset (metadata)
sandbox/       ← core, security
application/   ← core, channel, pulse, asset, security
api/           ← application, search, pulse
distributed/   ← core (kendi içinde bağımsız)
consensus/     ← distributed, pulse (PulseEntry tipi)
consensus/compaction/ ← consensus/, distributed/sync, distributed/security (Aşama 18)
consensus/join/       ← consensus/compaction/ (Aşama 18, Fast Join)
p2p/           ← core, distributed (transport)
preview/core/  ← core, asset (tipler), p2p (CID) — platform bağımsız (Aşama 17)
preview/renderer/ ← preview/core (tek yönlü, Browser/DOM bilir) (Aşama 17)
plugin/        ← core, security/security-types (tip), preview/core (tip), consensus/consensus-types (tip), sandbox (Aşama 19)
```

---

## Önemli Veri Akışları

### Proje Yükleme
```
HTTP POST /projects
  → ApplicationOrchestrator
  → DomainValidator (11 kural)
  → PolicyEngine
  → ProjectRepository
  → CubeEngine.assign()
  → SearchIndex.index()
  → EventBus("project:created")
  → PulseEngine.eligibility()
```

### Asset Yükleme
```
HTTP POST /assets
  → MetadataEngine.extract()
  → SHA-256 duplicate detection
  → IStorageAdapter.put()
  → AssetRepository.create()
  → SecurityAnalysis.pipeline()
  → EventBus("asset:created")
  → P2P.announce(cid)
```

### Pulse Tick
```
PulseScheduler.tick()
  → EligibilityEngine.filter()
  → RankingEngine.rank()
  → RotationEngine.apply()
  → PulseSnapshotStore.save()
  → [Lider Düğümde] ConsensusNode.commitPulse()
  → RaftEngine.propose()
  → Commit → PulseBlock
  → NodeRuntime.stores.pulse
  → Gossip → Tüm Düğümler
```

### Arama
```
GET /search?q=stl+motor
  → QueryParser.parse()
  → QueryPlanner.plan()
  → SemanticIndex + StructuralIndex + ReverseIndex
  → ScoringEngine (0.55 + 0.30 + 0.10 + 0.05)
  → Ranker.rank()
  → API response
```

### P2P Asset İndirme
```
TransferEngine.download(cid)
  → ContentRegistry.providers(cid)
  → paralel chunk:request (concurrency=4)
  → ChunkStore.putChunk() + SHA-256 doğrula
  → assemble() → tam CID doğrula
  → IStorageAdapter.put()
```

---

## Tasarım Sabitleri

| Sabit | Formül | Kullanım |
|---|---|---|
| DR(n) | n===0 ? 0 : 1+(n-1)%9 | Cube koordinat |
| T(n) | n×(n+1)/2 | Üçgensel sayı |
| influence | 1/(1+k×d²) | Mesafe ağırlığı |
| pulseNumber | floor(unixMs/intervalMs) | Deterministik tick |
| searchScore | sem×0.55+str×0.30+meta×0.10+rec×0.05 | Karma arama skoru |
| trustScore | openSource:20+verified:20+... (max 100) | Şeffaf güven |
| electionTimeout | seededRandom(nodeId:attempt) | Deterministik Raft |

---

## Teknoloji Tercihleri

| Katman | Tercih | Neden |
|---|---|---|
| Runtime | Node.js 20+ / Deno | TypeScript native, edge uyumlu |
| Dil | TypeScript (strict) | Tip güvenliği, DX |
| DB | PostgreSQL (in-memory dev) | UnitOfWork (Aşama 07) |
| Transport | MemoryTransport → QUIC | Adapter swap |
| Consensus | Lightweight Raft | Anlaşılabilir, test edilebilir |
| Hash | SHA-256 (Web Crypto API) | Native, her yerde |
| Signature | Ed25519 (ISignatureProvider) | Küçük, hızlı |
| Frontend | React + TypeScript + Vite | Performanslı, ekosistem |

---

## Kısaltma Rehberi

| Kısaltma | Açıklama |
|---|---|
| CID | Content ID (SHA-256 hash) |
| DR(n) | Dijital Kök (Digital Root) |
| TTL | Time To Live (Gossip hop count) |
| ADR | Architectural Decision Record |
| CQRS | Command Query Responsibility Segregation |
| UoW | Unit of Work |
| SSE | Server-Sent Events |
