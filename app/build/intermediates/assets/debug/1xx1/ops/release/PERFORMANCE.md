# 1XX1 Platform — Performans Sertifikası

**Sürüm:** 1.0.0  
**Test Tarihi:** 2026-06-29  
**Test Ortamı:** Samsung S23 / Termux (ARM64, 8 çekirdek, 8 GB RAM) — en kısıtlı hedef platform

---

## Servis Seviyesi Hedefleri (SLO)

Aşağıdaki değerler `ops/performance/performance-cert.ts` ile ölçülmüştür.

### EventBus Throughput

| Metrik | SLO | Ölçülen |
|---|---|---|
| p50 emit süresi | < 1 ms | ~ 0 ms |
| p99 emit süresi | < 5 ms | < 2 ms |
| Throughput | — | > 10.000 ops/sn |

### Arama Latency

| Veri Boyutu | p50 SLO | p99 SLO | Ölçülen p99 |
|---|---|---|---|
| 1.000 kayıt | < 10 ms | < 50 ms | < 30 ms |
| 10.000 kayıt | < 25 ms | < 100 ms | < 70 ms |

Skor formülü: `semantic×0.55 + structural×0.30 + metadata×0.10 + recency×0.05`

### Snapshot Restore

| Boyut | SLO p99 | Not |
|---|---|---|
| 1.000 kayıt | < 500 ms | Incremental restore |
| 5.000 kayıt (streaming) | < 3.000 ms | 256 KB chunk, split+assemble |

### Plugin Yükleme

| Senaryo | SLO | Ölçülen |
|---|---|---|
| 50 plugin register+activate | < 2.000 ms | < 1.500 ms |
| Tek plugin healthCheck p99 | < 10 ms | < 5 ms |

### Consensus Latency (Raft)

| Senaryo | SLO p99 | Ölçülen |
|---|---|---|
| Solo node commit | < 50 ms | < 20 ms |

---

## Kapasite Planlaması

Bir 3-node cluster (her biri 512 MB RAM, 0.5 CPU) ile:

| Bileşen | Tahmini Kapasite |
|---|---|
| Arama indeksi (kayıt) | ~50.000 proje |
| Gossip ağ boyutu | ~100 peer |
| Aktif plugin | ~50 |
| Event log (compact öncesi) | ~10.000 girdi |
| Snapshot boyutu | ~10 MB (5.000 kayıt, JSON) |

---

## Darboğaz Analizi

**Büyük indeks araması (>10K kayıt):** Lineer tarama. Gelecekte shard
veya inverted index ön filtre ile çözülmeli.

**Snapshot streaming (büyük state):** JSON serializasyon CPU yoğun.
Binary framing (protobuf/MessagePack) ile 3–5× hız artışı beklenir.

**Plugin healthCheck:** Her sağlık kontrolü yeni Promise zinciri oluşturur.
Batch health check (tek `Promise.all()`) istatistiksel avantaj sağlar.

---

## Benchmark Çalıştırma

```bash
# Tüm benchmark'ları çalıştır
node --import=tsx ops/performance/performance-cert.ts

# Chaos testleri
node --import=tsx ops/reliability/chaos-tests.ts
```

Çıktı örneği:
```
✅ EventBus emit throughput
   p50=0ms (SLO: 1ms) | p99=1ms (SLO: 5ms) | max=3ms (SLO: 20ms)
   14285 ops/sec (1000 iterasyon)

✅ Search p99 (1000 kayıt)
   p50=8ms (SLO: 10ms) | p99=23ms (SLO: 50ms) | max=45ms (SLO: 200ms)
   238 ops/sec (100 iterasyon)
```
