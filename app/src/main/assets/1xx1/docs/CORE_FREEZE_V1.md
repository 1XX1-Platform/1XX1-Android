# 1XX1 Core Freeze — v1.0

**Tarih:** 2026-07-04  
**Durum:** FROZEN

---

## Temel Mimari Prensip

> "Bu kod olmadan sistem yaşayamaz mı?"  
> Cevap evet → Core'a girer.  
> Cevap hayır → Üst katmana çıkar.

---

## Frozen Core (dokunulamaz)

```
core/
  identity.ts          Ed25519 keypair, nodeId = base58(SHA256(pubkey))
  logical-time.ts      Monotonic clock, ±250ms drift tolerance
  network.ts           getLocalIP(), normalizeEndpoint()
  event-bus.ts         Dahili event sistemi
  interfaces.ts        ILogger ve temel tipler

distributed/
  transport/           ITransport, MemoryTransport
  discovery/
    peer-table.ts      Conflict-free peer state, dedup, spoof koruması
    seed-nodes.ts      Bootstrap entry points
    gossip-discovery.ts Transitive peer propagation, 30s loop, failure detection
  security/
    signature.ts       Ed25519 sign/verify
  clock/
    lamport-clock.ts   Lamport saati

consensus/
  raft/raft-engine.ts  Leader election, log replication, split-brain detection
  consensus-types.ts   RaftLogEntry + prevHash + entryHash (hash-chain)
```

---

## Core Freeze Kuralları

1. Frozen dosyalara sadece şunlar yapılabilir:
   - Bug fix (test ile kanıtlanmış)
   - Güvenlik yaması
   - Performans optimizasyonu (davranış değişmeden)

2. Yeni özellik Core'a girmez → üst katmana çıkar.

3. Core API değişikliği geriye dönük uyumlu olmalı.

4. Her Core değişikliği `docs/PROTOCOL_V1.md` ile senkron tutulur.

---

## Node Tipleri (Core üzerinde çalışır)

```
Mobile Node      → Telefon (Termux / APK)
Fixed Node       → Raspberry Pi, Mini PC, NAS
Infrastructure   → Server, Cloud (opsiyonel)
```

Hepsi aynı protokolü konuşur. Core değişmez.

---

## Üst Katmanlar (Core'a dokunmaz)

```
CORE (Frozen v1.0)
        │
────────┼────────────────────────
        │
Knowledge Layer    Proje indeksi, arama, metadata
Ghost Layer        1331 SMP mesh routing
Spatial Layer      Cube Engine, koordinat sistemi
Application Layer  Pulse, Plugin SDK, Asset Bank
Marketplace        Proje keşif ve dağıtım
Browser (1XX1)     Gömülü WebView, 1xx1:// protokolü
AI Layer           Opsiyonel, modüler
DHT                Kademlia-lite internet discovery
NAT                STUN-lite, relay fallback
Reputation         EWMA trust scoring
Sybil Guard        Rate limit, IP bazlı koruma
```

---

## FAZ Durumu (Freeze Anında)

| FAZ | İçerik | Durum |
|-----|--------|-------|
| 0 | Identity + Clock | ✅ Frozen |
| 1 | Gossip Discovery | ✅ Frozen |
| 2 | Raft Consensus | ✅ Frozen |
| 3 | DHT + NAT | ✅ Frozen |
| 4 | Trust + Sybil | ✅ Frozen |
| 5 | Observability API | ✅ Frozen |
| 6 | Production Load Test | 🔲 Sonraki |

---

## Matematiksel Temel (Değişmez)

```
DR(n)       = n===0 ? 0 : 1+(n-1)%9
T(n)        = n*(n+1)/2
influence   = 1/(1+k·d²)
score       = sem×0.55 + str×0.30 + meta×0.10 + rec×0.05
pulseNumber = floor(unixMs / intervalMs)
nodeId      = base58(SHA256(ed25519_publicKey_DER))
1 unit      = 1 cm
```
