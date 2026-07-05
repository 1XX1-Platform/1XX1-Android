# Aşama-14 — Dağıtık Düğüm Senkronizasyonu V2

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-15 — Web Önizleme Motoru

---

## Mimari Özet

```
NodeRuntime
    │
    ├── ITransport          → MemoryTransport | TCP | WS | QUIC (stub)
    │     ↓
    ├── MessageEnvelope     → immutable, versioned, signed
    │     ↓ (validate: checksum → signature → version → TTL)
    ├── GossipEngine        → fan-out k=6, LRU duplicate cache, TTL hop count
    │     ↓
    ├── PeerManager         → PeerState, trust, reputation, heartbeat timeout
    │     ↓
    ├── SyncStore × 6       → projects, assets, releases, channels, pulse, policies
    │     ↓ (DeterministicResolver)
    ├── EventLog            → append-only, deterministik replay
    │     ↓
    ├── SnapshotManager     → deterministik hash, restore, maxHistory
    │     ↓
    └── NodeHealthMonitor   → ACTIVE | DEGRADED | ISOLATED | OFFLINE
```

---

## Temel Tasarım Kararları (bkz. ADR-005)

| Karar | Neden |
|---|---|
| Fan-out Gossip (k=6) | O(log n) yayılım, loop/flood koruması |
| Lamport Clock (IClock) | Nedensel sıralama, Vector Clock'a hazır |
| Ed25519 (ISignatureProvider) | Hızlı, küçük, Web Crypto native |
| Adapter Transport | MemoryTransport test, TCP/QUIC/libp2p production |
| Deterministic Conflict Resolver | Aynı iki entry → her zaman aynı kazanan |
| Snapshot + Event Log | Recovery = snapshot + replay (tek başına yetersiz) |
| 6 Typed Store | `any` yok — her store kendi conflict strategy'sine sahip |
| Metadata-first | Dosya verisi dağıtılmaz, sadece checksum/ID |

---

## Güvenlik Katmanı

Her mesaj işlenmeden önce zorunlu sıra:

```
Checksum (SHA-256)
  ↓
Signature (Ed25519)
  ↓
Protocol Version
  ↓
TTL (≥ 0)
  ↓
Deserialize
  ↓
Validation
  ↓
Dispatch
```

Doğrulanamayan mesaj → işlenmez + gönderenin reputation puanı düşer → ban threshold.

---

## Gossip Engine

- **Fan-out k=6**: her mesaj 6 rastgele peer'a iletilir
- **TTL**: başlangıç 8, her hop'ta -1, 0'da durur
- **seenMessages LRU (10.000 entry)**: duplicate asla işlenmez
- **Rate limiting**: 1.000 msg/saniye anti-storm koruması
- **Message cache (60 sn)**: son mesajlar replay için saklanır

---

## Conflict Resolution — Deterministik Sıra

```
1. Lamport Clock değeri (yüksek → kazanır)
2. Version numarası   (yüksek → kazanır)
3. Timestamp          (yüksek → kazanır)
4. Signature string   (lexicographic, deterministik)
5. NodeId string      (lexicographic, son kale)
```

Rastgele seçim yok. İki düğüm aynı girdi → aynı karar.

---

## Recovery Akışı

```
Sistem yeniden başladı
  ↓
SnapshotManager.latest() → son snapshot yükle
  ↓
StoreCollection.restore(snapshot) → store'ları doldur
  ↓
LamportClock.restore(snapshot.clockValue)
  ↓
EventLog.since(snapshot.eventLogPosition) → kalan event'leri replay et
  ↓
Mevcut State ← deterministik
```

---

## Network Partition / Merge

- **Partition sırasında**: her parça kendi yerel store'uyla çalışmaya devam eder
- **Veri kaybı yok**: EventLog append-only
- **Merge sonrası**: gossip devreye girer, DeterministicResolver çakışmaları çözer
- **MemoryTransport**: `partition()` + `heal()` metodları ile test edildi

---

## Transport Adaptörleri

| Transport | Durum | Açıklama |
|---|---|---|
| `MemoryTransport` | ✅ | Test/simülasyon, 1000 node |
| `TCPTransportStub` | Stub | Aşama 16'da gerçek TCP |
| `WebSocketTransportStub` | Stub | Web istemcisi için |
| `QUICTransportStub` | Stub | Düşük gecikme P2P |

---

## Test Kapsamı

| Test Grubu | İçerik |
|---|---|
| Envelope | Yapı, immutability, validation hataları |
| Lamport Clock | tick, merge, serialize/restore, compareTo |
| Signature | Mock sign/verify, SHA-256 checksum, validator |
| Transport | send/recv, broadcast, partition/heal, drop rate |
| LRU Cache | Max boyut, LRU sırası |
| Gossip | TTL=0, duplicate, spread cache |
| Peer Manager | Heartbeat, trust, reputation, ban, timeout |
| SyncStore | put/get, merge, conflict, delta, checksum |
| Conflict Resolver | Deterministik sıra, 100 iterasyon |
| Event Log | append, since, replay sırası |
| Snapshot | take/restore, hash deterministik, history limit |
| Node Runtime | start/stop, publish, snapshot recovery |
| 10 Node Simülasyon | Veri yayılımı, event log |
| 1000 Node Simülasyon | Ring + random topoloji, < 5s |
| Determinizm | İki cluster aynı veri → aynı checksum |
| Health Monitor | ACTIVE/DEGRADED/ISOLATED |
| Metrics | Kayıt, sample, conflict sayacı |

---

## Dosyalar

| Dosya | Satır | Açıklama |
|---|---|---|
| `envelope/message-envelope.ts` | ~130 | Immutable mesaj zarfı, tipler |
| `clock/lamport-clock.ts` | ~110 | LamportClock, VectorClock, IClock |
| `security/signature.ts` | ~160 | Ed25519, MockSigner, SHA-256 |
| `transport/transport.ts` | ~170 | ITransport, MemoryTransport, stubs |
| `gossip/gossip-engine.ts` | ~190 | Fan-out gossip, LRU, rate limit |
| `peer/peer-manager.ts` | ~180 | PeerState, trust, heartbeat |
| `sync/sync-engine.ts` | ~290 | SyncStore, resolver, EventLog, Snapshot |
| `health/health-monitor.ts` | ~140 | NodeHealthMonitor, MetricsCollector |
| `node/node-runtime.ts` | ~400 | Ana orkestratör |
| `__tests__/distributed.test.ts` | ~862 | 18 grup, 80+ test |
| `index.ts` | ~30 | Dışa aktarma |
| `docs/adr/ADR-005-distributed-sync.md` | ~150 | Mimari kararlar |

---

## Sonraki Aşamanın Amacı

**Aşama-15 — Web Önizleme Motoru**

- WASM sandbox'ta proje çalıştırma
- `WasmSandboxAdapter` (Aşama 13'e bağlanır)
- Tarayıcı içi önizleme iframe/worker izolasyonu
- Proje çıktısı → güvenli önizleme URL'si
- `WasmTransportStub` → gerçek WebRTC/WebSocket
