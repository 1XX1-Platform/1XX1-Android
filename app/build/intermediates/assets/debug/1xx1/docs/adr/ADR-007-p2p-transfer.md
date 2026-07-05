# ADR-007 — P2P Asset Transfer & Content-Addressed Storage

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 16

---

## 1. Problem

1XX1'de asset'ler (STL, PNG, WASM, shader...) düğümler arasında transfer edilmeli.
Ancak:

- Büyük dosyalar gossip ile taşınamaz (gossip küçük metadata için)
- Merkezi CDN → single point of failure, sansür riski
- HTTP doğrudan indirme → hangi düğümden? Yük dengeleme?
- Bozulmuş dosya nasıl tespit edilir?
- Aynı dosya iki kez indirilmemeli

---

## 2. Kararlar

### Neden Content-Addressed Storage?
- `CID = SHA-256(içerik)` → içerik değişince CID değişir
- İki düğüm aynı CID'yi indirirse aynı dosyayı alır — garanti
- Duplicate detection: CID zaten varsa → tekrar indirme yok
- Bozulmuş dosya tespit: CID doğrulaması başarısız → discard
- İleride IPFS/IPLD uyumlu: aynı CID sistemi

### Neden Chunking (2 MB)?
- Büyük dosya (100 MB STL) tek seferde → bant genişliği monopolü
- Chunk: paralel indirme (4 chunk aynı anda) → 4× hızlı
- Başarısız chunk → sadece o chunk yeniden istek → full retry değil
- Her chunk ayrı hash → bozulma tam lokalize edilir
- 2 MB: MTU × 1400 = pratik minimum overhead

### Neden Gossip → Metadata, P2P → Binary?
- Gossip'te binary: flood → ağ çöker
- Gossip: `content:announce { cid, size, mimeType, chunks }` — küçük
- P2P transfer: `chunk:response { data: base64 }` — büyük, hedefli
- QoS ayrımı: gossip öncelikli, asset transfer arka plan

### Neden IP2PTransport Arayüzü?
- MemoryTransport: 100 düğümlü simülasyon, sıfır I/O
- QUIC stub: düşük latency, 0-RTT, UDP tabanlı (Aşama 18)
- libp2p stub: NAT traversal, DHT, hole punching (Aşama 18)
- Transport swap: üst katman değişmez

### Neden SHA-256 (BLAKE3 değil)?
- SHA-256: Web Crypto API native, browser ve Node.js her yerde
- BLAKE3: daha hızlı ama native desteği yok, external dep gerekir
- İleride: `computeCID(data, algo = "sha256")` genişletme noktası

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| BitTorrent protokolü | External library; tracker gereksinimi |
| IPFS (js-ipfs) | Ağır, kompleks; 1XX1'e özgü değil |
| HTTP GET endpoint | Merkezi; hangi düğüm sunar? |
| Gossip üzerinden binary | Ağ flood; gossip metadata için |
| WebRTC DataChannel | Browser-first; server node'larda zor |
| rsync benzeri delta | Asset değişmez (immutable CID); delta gereksiz |

---

## 4. Sonuçlar

**Artıları:**
- CID garantisi: aynı CID → aynı içerik (matematiksel)
- Paralel 4× chunk indirme → büyük dosyalarda hız
- Her chunk anında doğrulanır → bozuk chunk erken tespit
- Transport adapter: MemoryP2P test, QUIC/libp2p production
- Gossip/P2P ayrımı → QoS, ağ tıkanıklığı önleme
- ContentRegistry: provider listesi peer'lardan toplanır, merkezi değil

**Eksileri:**
- base64 encoding: ~33% boyut artışı (JSON transport nedeniyle)
  - Çözüm: Aşama 18 binary framing (MessagePack/protobuf)
- Semaphore concurrency: Node.js single-thread'de gerçek paralel değil
  - Yeterli: I/O bound operasyonlar için async yeterli
- Buffer API: Node.js'e özgü base64 kullanımı
  - Düzeltme: Aşama 18'de Uint8Array native encode

---

## 5. İleride Değiştirilebilir Noktalar

- `computeCID(data, algo)` → SHA-256 | BLAKE3 | SHA-3
- base64 → binary framing (Aşama 18, protobuf)
- `InMemoryChunkStore` → LevelDB / disk (Aşama 18)
- `MemoryP2PTransport` → `QUICTransport` (Aşama 18)
- `ContentRegistry` → DHT-based discovery (Aşama 18)
- Chunk boyutu adaptive (ağ hızına göre)
- NAT traversal: libp2p STUN/TURN (Aşama 18)

---

## İlgili Bileşenler

`p2p/content/content-addresser.ts` · `p2p/content/chunk-store.ts` · `p2p/transport/p2p-transport.ts` · `p2p/transfer/transfer-engine.ts`

---

# Aşama-16 — P2P Asset Transfer & Content-Addressed Storage

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-17 — Web Önizleme Motoru

---

## Mimari

```
Asset yükleme (Aşama 11)
    ↓
ContentAddresser.computeCID(data) → CID
ContentAddresser.split(data)      → ChunkDescriptor[]
    ↓
InMemoryChunkStore.putChunk()     → chunk sakla
    ↓
TransferEngine.announce(cid, address)
    ↓ (gossip üzerinden)
ContentRegistry.announce(cid, peer, address)  [diğer düğümde]
    ↓
TransferEngine.download(cid)
    ↓ paralel (concurrency=4)
chunk:request  → peer
chunk:response ← peer
chunkHash doğrula
    ↓
InMemoryChunkStore.assemble(cid)
    ↓
SHA-256(assembled) == cid → TAM DOĞRULAMA
```

---

## Content-Addressed ID

```
CID = SHA-256(dosya_içeriği)

Garantiler:
  - Aynı içerik → her zaman aynı CID
  - Farklı içerik → (astronomik ihtimalle) farklı CID
  - CID değişirse içerik değişmiş demektir
  - Duplicate: CID mevcutsa indirme yapılmaz
```

---

## Chunk Protokolü

```
Dosya (örn. 10 MB STL)
  → 5 chunk (her biri 2 MB)
  → Her chunk: ChunkDescriptor { cid, chunkIndex, chunkHash, offset, size }
  → Paralel indirme (max 4 eş zamanlı)
  → Her chunk: SHA-256 doğrulama
  → Tüm chunk'lar tamam → assemble
  → Tam CID doğrulama → kabul/red
```

---

## Gossip vs P2P Ayrımı

| Kanal | İçerik | Boyut | Öncelik |
|---|---|---|---|
| Gossip (Aşama 14) | Metadata, CID duyurusu | KB | Yüksek |
| P2P Transfer (Aşama 16) | Binary chunk verisi | MB | Normal |

---

## Test Kapsamı (7 grup, 30+ test)

ContentAddresser (CID, split, assemble, doğrulama), ChunkStore (put/get, complete, assemble), ContentRegistry (announce, providers, prune), P2PTransport (send/recv, partition, heal), TransferEngine (duyuru, tek/çok chunk tam akış), Determinizm (100 iterasyon aynı CID), Performans (10MB CID < 2s, 10MB split < 3s, 1000 chunk < 1s)
