# Aşama-18 — Snapshot + Log Compaction

**Tarih:** 2026-06-29  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-19 — Plugin SDK

---

## Bu Aşamada Kapatılan Teknik Borç

Aşama 15'te `ILogCompactor` arayüzü ve `NoopLogCompactor` stub bırakılmıştı:

> "Aşama 18'de gerçek implementasyon" — ADR-006

Bu aşama o sözü tutar: gerçek `IncrementalLogCompactor`, incremental
snapshot, snapshot streaming ve fast join protokolü teslim edilir.

---

## Kritik Düzeltme: RaftEngine Index-Tabanlı Erişim

Compaction implementasyonuna başlamadan önce, Aşama 15'in `RaftEngine`'inde
**ciddi bir varsayım hatası** tespit edildi ve düzeltildi:

```typescript
// ÖNCE (Aşama 15) — TEHLİKELİ
const entry = this.log[this.lastApplied]; // dizi pozisyonu = index varsayımı

// SONRA (Aşama 18) — GÜVENLİ
const entry = this._findByIndex(this.lastApplied); // entry.index alanına göre arama
```

Bu varsayım, log hiç compact edilmediği sürece doğru çalışıyordu. Ancak
compaction sonrası `log[0].index` artık `0` değil (örn. `1000`) olduğunda,
eski kod **yanlış girdiyi uygulardı veya çökerdi** — sessiz veri bozulması
riski. `_findByIndex()`, `_sliceFromIndex()` ile düzeltilen yerler:

- `_applyCommitted()` — commit edilen komutları uygularken
- `_sendAppendEntries()` — lider, follower'lara log gönderirken
- `_handleAppendEntries()` — follower, lider'den log alırken
- `_maybeCommit()` — çoğunluk kontrolü yaparken

Bu düzeltme olmadan `IncrementalLogCompactor` güvenle kullanılamazdı.

---

## Mimari

```
RaftEngine (Aşama 15, Aşama 18'de düzeltildi)
    │
    ├── IncrementalLogCompactor          [consensus/compaction/log-compactor.ts]
    │     ├── shouldTrigger()            → otomatik tetikleme politikası
    │     ├── truncate()                 → güvenli kesme (retainTail garantili)
    │     └── ILogCompactor sözleşmesi   → Aşama 15'in arayüzünü implemente eder
    │
    ├── IncrementalSnapshotBuilder        [consensus/compaction/incremental-snapshot.ts]
    │     ├── take()                     → full (ilk) veya incremental (sonra)
    │     ├── _diffSince()               → yalnızca değişen kayıtlar
    │     └── restoreFromChain()         → zincir → state (DeterministicResolver ile)
    │
    ├── SnapshotStreamer                  [consensus/compaction/snapshot-streamer.ts]
    │     ├── split()                    → 256 KB chunk'lara böl
    │     └── assemble()                 → doğrula + birleştir + deserialize
    │
    └── FastJoinSponsor / FastJoinClient  [consensus/join/fast-join.ts]
          ├── evaluateJoinRequest()      → protokol/snapshot kontrolü
          ├── prepareSnapshotChunks()    → sponsor: zinciri chunk'la
          └── join()                     → client: chunk'lardan state inşa et
```

---

## Log Compaction Akışı

```
Log: [0, 1, 2, ..., 999, 1000, 1001, ...]   commitIndex=1000
  ↓ shouldTrigger(logLength, commitIndex)?
  ↓ evet → truncate(log, commitIndex)
  ↓ upToIndex = commitIndex - retainTail  (örn. 1000 - 100 = 900)
  ↓
Log: [901, 902, ..., 1000, 1001, ...]        (0..900 silindi)
  ↓
RaftEngine.compact() → tüm erişimler entry.index'e göre çalışmaya devam eder
```

**Güvenlik garantisi:** `upToIndex ≤ commitIndex - retainTail` her zaman
sağlanır. Commit edilmemiş hiçbir girdi asla silinemez.

---

## Incremental Snapshot Akışı

```
take(nodeId, clock, eventLogPos)
  ↓
chain.length === 0 VEYA incrementalCount >= fullSnapshotInterval?
  │
  ├── EVET → _takeFull()
  │     → tüm store'ların tüm kayıtları (storeDeltas = store.all())
  │     → lastVersions güncellenir (referans noktası)
  │
  └── HAYIR → _takeIncremental()
        → yalnızca version > lastVersions[type] olan kayıtlar
        → baseHash = önceki snapshot'ın hash'i (zincirleme)

restoreFromChain(targetStores, chain)
  ↓ her snapshot için (full, sonra incremental'lar sırayla)
  ↓ her store'un her delta entry'si → store.merge(entry)
  ↓ DeterministicResolver çakışmaları otomatik çözer (Aşama 14)
```

---

## Snapshot Streaming (Aşama 16 ile Simetrik, Ayrı Modül)

| Özellik | Aşama 16 (Asset) | Aşama 18 (Snapshot State) |
|---|---|---|
| Chunk boyutu | 2 MB | 256 KB |
| İçerik | Binary dosya | JSON state |
| Hash | SHA-256(binary) | SHA-256(JSON string parçası) |
| Modül | `p2p/content/` | `consensus/compaction/` |
| Bağımlılık | `core/`, `distributed/security` | `core/`, `distributed/security` |

İki modül birbirini import etmez — INVARIANTS.md kuralı (`consensus/`
asset/p2p bilmez) korunur. Yalnızca `sha256Hex` paylaşılır.

---

## Fast Join Akışı

```
Yeni Düğüm                          Sponsor (Mevcut Düğüm)
    │                                      │
    │──── JoinRequest ───────────────────▶│
    │      (nodeId, publicKey, protocol)   │
    │                                      │ evaluateJoinRequest()
    │                                      │  → protokol kontrolü
    │                                      │  → snapshot var mı?
    │◀──── JoinOffer ─────────────────────│
    │      (accept, snapshotHash, ...)     │
    │                                      │ prepareSnapshotChunks()
    │◀──── SnapshotChunk[] (256KB'lık) ───│  (full + incremental zinciri)
    │                                      │
    │ FastJoinClient.join()                │
    │  → assemble() her snapshot           │
    │  → restoreFromChain()                │
    │  → pendingEvents replay              │
    │                                      │
    │  [Senkronize, ağa katılabilir]       │
```

**Karmaşıklık kazanımı:** O(tüm event log geçmişi) → O(snapshot sonrası delta)

---

## Test Kapsamı (7 grup, 40+ test)

| Grup | Vurgu |
|---|---|
| log-compactor | shouldTrigger politikası, truncate retainTail güvenliği, no-op tekrar |
| raft-compaction | **Compaction sonrası index bütünlüğü** (kritik düzeltme doğrulaması) |
| incremental-snapshot | full/incremental ayrımı, delta hesaplama, otomatik full tetikleme |
| snapshot-streamer | split/assemble, bozuk chunk tespiti, eksik chunk tespiti, progress |
| fast-join | sponsor/client tam akış, protokol uyumsuzluğu reddi, bozuk chunk reddi |
| Determinizm | Aynı zincir → 2 bağımsız hedefte aynı checksum |
| Performans | 10K log compaction < 1s, 5000 kayıt streaming < 3s, fast join 1000 kayıt < 2s |

---

## ADR

- **ADR-009**: Compaction, incremental snapshot, streaming ve fast join kararları
  (özellikle RaftEngine index-tabanlı erişim düzeltmesinin gerekçesi)

---

## Sonraki Aşamanın Amacı

**Aşama-19 — Plugin SDK**

- `IAnalyzerPlugin`, `ISearchPlugin`, `IAssetProcessor` arayüzleri
- `IPreviewGenerator` (Aşama 17'nin `IPreviewExtractor`'ı resmi plugin arayüzüne taşınır)
- `IPulseModifier`, `IConsensusExtension`
- Plugin registry + sandboxed plugin çalıştırma (Aşama 13 entegrasyonu)
- Sistem çekirdeği değişmeden dış geliştiriciler genişletebilir
