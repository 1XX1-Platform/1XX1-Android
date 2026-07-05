# Aşama-16 — P2P Asset Transfer & Content-Addressed Storage

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-17 — Web Önizleme Motoru

---

## Mimari

```
Asset yükleme (Aşama 11)
    ↓
ContentAddresser.computeCID(data) → CID = SHA-256(içerik)
ContentAddresser.split(data, 2MB) → ChunkDescriptor[]
    ↓
InMemoryChunkStore.putChunk()
    ↓
TransferEngine.announce(cid)      → Gossip: metadata yayılımı
    ↓ (başka düğümde)
ContentRegistry.announce(cid, peer, address)
    ↓
TransferEngine.download(cid)
    ├── paralel chunk:request (concurrency=4)
    ├── her chunk → SHA-256 doğrula
    └── assemble → tam CID doğrula → TAM DOĞRULAMA
```

---

## İyileştirmeler (Aşama 15 geri dönüşü)

Aşama 15 için önerilen 7 mimari iyileştirme bu aşama öncesinde uygulandı:

| # | İyileştirme | Dosya |
|---|---|---|
| 1 | Pulse Engine Raft'ı bilmez — `ConsensusCommand` genel payload | `consensus-types.ts` |
| 2 | `CommandType` + `Payload` ayrımı — 10 komut tipi | `consensus-types.ts` |
| 3 | `seededRandom(nodeId:attempt)` deterministik election timeout | `consensus-types.ts`, `raft-engine.ts` |
| 4 | PulseBlock V2: `blockNumber`, `pulseHash`, `snapshotHash`, `validatorRoot` | `consensus-types.ts` |
| 5 | `ValidatorInfo.weight = 1` (ileride stake/DAO) | `consensus-types.ts` |
| 6 | `TransportChannel` tipi: `consensus \| gossip \| snapshot \| transfer` | `consensus-types.ts` |
| 7 | `ILogCompactor` + `NoopLogCompactor` stub (Aşama 18'de gerçek) | `consensus-types.ts`, `raft-engine.ts` |

---

## Content-Addressed ID

```
CID = SHA-256(dosya_içeriği)

Garantiler:
  - Aynı içerik → her zaman aynı CID (deterministik, test ile doğrulandı × 100)
  - İçerik değişince CID değişir
  - CID == indirilen verinin hash'i → bütünlük kanıtı
  - Duplicate: CID mevcutsa indirme yapılmaz
```

---

## Chunk Protokolü

```
Dosya (örn. 10 MB STL)
  → split(2MB chunk) → 5 ChunkDescriptor (her birinde SHA-256 chunk hash'i)
  → paralel indirme (max 4 eş zamanlı, Semaphore)
  → her chunk anında: SHA-256(chunk) == chunkHash ? kabul : retry
  → isComplete() → assemble()
  → SHA-256(assembled) == CID ? kabul : red (veri bozulmuş)
```

---

## Gossip vs P2P Ayrımı

| Kanal | Tip | Boyut | Öncelik |
|---|---|---|---|
| Gossip (Aşama 14 transport) | `content:announce { cid, size, mimeType, chunks }` | ~200 byte | Yüksek |
| P2P Transfer (bu modül) | `chunk:response { data: base64, chunkHash }` | ~2.7 MB | Normal |

---

## Transport Adaptörleri

| Transport | Durum | Açıklama |
|---|---|---|
| `MemoryP2PTransport` | ✅ | Simülasyon, partition/heal/latency |
| `QUICTransportStub` | Stub | 0-RTT UDP, NAT traversal (Aşama 18) |
| `LibP2PTransportStub` | Stub | DHT discovery, Noise handshake (Aşama 18) |

---

## Test Kapsamı (7 grup, 30+ test)

| Grup | Testler |
|---|---|
| ContentAddresser | CID deterministik, split tek/çok chunk, assemble, bozuk chunk |
| ChunkStore | put/get, isComplete, assemble sıralı, delete, totalBytes |
| ContentRegistry | announce, providers, removePeer, prune, stats |
| P2PTransport | send/recv, partition, heal, metrics |
| TransferEngine | duyuru, tek chunk, 3 chunk tam akış |
| Determinizm | 100 iterasyon aynı CID, chunk hash deterministik |
| Performans | 10MB CID < 2s, 10MB split < 3s, 1000 chunk put < 1s |

---

## ADR

- **ADR-007**: İçerik adresleme, chunking, Gossip/P2P ayrımı, SHA-256 seçimi

---

## Sonraki Aşamanın Amacı

**Aşama-17 — Web Önizleme Motoru**

- WASM sandbox'ta proje çalıştırma (Aşama 13 bağlantısı)
- Tarayıcı içi önizleme (iframe / Web Worker izolasyonu)
- Thumbnail ve metadata önizleme
- `WasmSandboxAdapter` (Aşama 13 ISandboxAdapter'ı implemente eder)
- P2P üzerinden önizleme varlıkları (Aşama 16 CID sistemi)
