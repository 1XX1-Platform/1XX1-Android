# Aşama-15 — Dağıtık Konsensüs ve Pulse Senkronizasyonu

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-16 — P2P Asset Transfer & QUIC/libp2p Transport

---

## Mimari

```
ConsensusNode
    │
    ├── RaftEngine              → lider seçimi + log replikasyonu
    │     └── RpcSender         → NodeRuntime.transport üzerinden
    │
    ├── PulseSynchronizer       → Pulse blokları üretir ve doğrular
    │     └── PulseBlockChain   → zincir, deterministik hash
    │
    └── ValidatorSetManager     → güvenilen düğüm seti, quorum
          └── (RaftEngine ile konsensüs)

NodeRuntime (Aşama 14)
    └── stores.pulse            → Pulse blokları gossip ile yayılır
```

---

## Ne Konsensüse Tabi?

| Veri | Strateji | Neden |
|---|---|---|
| Pulse sıralamasi | **Raft** | Tüm düğümlerde aynı liste zorunlu |
| Validator seti | **Raft** | Sybil koruması |
| Policy değişiklikleri | **Raft** | Güvenlik kuralları tutarlı olmalı |
| Projeler, assetler | **Gossip** | Eventual consistency yeterli |
| Kanallar, sürümler | **Gossip** | Eventual consistency yeterli |

---

## Raft Akışı

```
PulseScheduler.tick()
  ↓ (lider düğümde)
ConsensusNode.commitPulse(snapshot)
  ↓
RaftEngine.propose({ type: "pulse:commit", ... })
  ↓ AppendEntries RPC → follower'lara
Çoğunluk onayı (floor(n/2)+1)
  ↓
applyCmd() → PulseSynchronizer.applyPulseCommit()
  ↓
PulseBlock üret (deterministik hash, zincire ekle)
  ↓
NodeRuntime.stores.pulse.put() → gossip ile yay
  ↓
Tüm düğümler aynı bloğu görür
```

---

## Pulse Block Zinciri

```
Block N:
  prevBlockHash = hash(Block N-1)
  entries       = [sıralı Pulse listesi]
  blockHash     = sha256(pulseNumber + prevHash + topThree + ...)
  signatures    = { validatorId: sig, ... }
  term          = Raft term numarası
```

Zincir bütünlüğü: `chain.verify()` her bloğun `prevBlockHash`'ini kontrol eder.  
Hash deterministik: aynı entries → her düğümde aynı hash → karşılaştırma mümkün.

---

## ValidatorSet Quorum

```
activeValidators = 5
quorumSize = floor(5/2)+1 = 3

Pulse bloğu geçerli ← 3+ validator imzası var
```

Validator değişikliği yalnızca Raft commit ile gerçekleşir:  
`propose({ type: "validator:add", nodeId, publicKey })`

---

## Raft Yapılandırması (varsayılan)

```
electionTimeoutMin: 150ms
electionTimeoutMax: 300ms (randomize → eş zamanlı seçim önleme)
heartbeatInterval:  50ms  (electionTimeout'tan küçük)
```

---

## Test Kapsamı

| Test | Açıklama |
|---|---|
| Lider seçimi: 3/10 node | Çoğunlukla seçim, tek lider |
| Eski term reddi | Eski term → lider etkilenmez |
| Komut commit | çoğunluk → commit, follower oy kullanamaz |
| pulse:commit log'a girer | Pulse önerisi commit edilir |
| Log restore | Yeniden başlatmada log kurtarılır |
| Zincir bütünlüğü | Hash zinciri doğrulama, bozuk tespit |
| Validator add/remove | Quorum hesabı, imza doğrulama |
| 3 node ConsensusNode entegrasyon | Tam akış lider → pulse commit |
| Deterministik hash | Farklı node, aynı data → aynı blok hash |
| 1000 komut performans | < 5 saniye |
| 10 node seçim hızı | < 2 saniye |

---

## ADR

- **ADR-005**: Dağıtık altyapı (gossip, Lamport, transport)
- **ADR-006**: Konsensüs tasarımı (Lightweight Raft, PulseBlock, ValidatorSet)

---

## Sonraki Aşamanın Amacı

**Aşama-16 — P2P Asset Transfer & QUIC/libp2p Transport**

- `QUICTransport` gerçek implementasyonu
- `libp2pTransport` adaptörü
- Asset binary transfer protokolü (chunked, checksum-verified)
- NAT traversal desteği
- Transport swap: MemoryTransport → QUIC → sıfır üst katman değişikliği
