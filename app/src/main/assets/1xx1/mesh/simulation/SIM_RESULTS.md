# 1331 SMP — 5 Protokol Karşılaştırması

**Tarih:** 2026-07-02  
**Versiyon:** v2 — Hibrit mod + Gerçek donanım modeli  
**Rakipler:** AODV · BATMAN · OLSR · DSR  
**Motor:** Node.js 22.22.2, seeded PRNG (seed=42)

---

## Simülasyon Parametreleri

- **Node hareketi:** random walk, %10/tick
- **Arıza:** %2 offline, %15 recovery/tick
- **BLE:** advertising 80-200ms, connection 50-200ms, drop %5, path loss n=2.7
- **WiFi:** NSD 500-2500ms, handshake 200-800ms, drop %2
- **LAN:** mDNS 5-20ms, drop %0.1
- **AODV:** RREQ broadcast + RREP unicast + rota cache (30s TTL)
- **BATMAN:** Periyodik OGM broadcast, TQ (Transmission Quality) skoru
- **OLSR:** MPR seçimi, 2-hop kapsama, TC mesajı yalnızca MPR'lerden
- **DSR:** Reaktif RREQ, kaynak yönlendirme (tam rota pakette)

---

## Sonuçlar

### 10 node (256 paket)

| Metrik | Ghost SMP | AODV | BATMAN | OLSR | DSR |
|---|---|---|---|---|---|
| Teslim Oranı | **67.6% ✅** | 3.5% | 4.7% | 3.5% | 5.9% |
| Gecikme p50 | 21ms | 61ms | 2ms | 4ms | 2ms |
| Gecikme p99 | 973ms | 1098ms | 5ms | 6ms | 379ms |

### 100 node (297 paket)

| Metrik | Ghost SMP | AODV | BATMAN | OLSR | DSR |
|---|---|---|---|---|---|
| Teslim Oranı | **53.9% ✅** | 1.7% | 14.8% | 1.7% | 2.7% |
| Gecikme p99 | 989ms | 1014ms | 48ms | 10ms | 688ms |

### 1000 node (160 paket)

| Metrik | Ghost SMP | AODV | BATMAN | OLSR | DSR |
|---|---|---|---|---|---|
| Teslim Oranı | **61.9% ✅** | 1.3% | 15.6% | 9.4% | 1.3% |
| Enerji (mAh) | 5.299 | 0.035 | 1.118 | 1.316 | 0.021 |

### 10K node (60 paket)

| Metrik | Ghost SMP | AODV | BATMAN | OLSR | DSR |
|---|---|---|---|---|---|
| Teslim Oranı | **46.7% ✅** | 0.0% | 0.0% | 0.0% | 0.0% |

---

## Özet Tablosu

| Senaryo | Ghost | AODV | BATMAN | OLSR | DSR |
|---|---|---|---|---|---|
| 10 node | **67.6%** | 3.5% | 4.7% | 3.5% | 5.9% |
| 100 node | **53.9%** | 1.7% | 14.8% | 1.7% | 2.7% |
| 1000 node | **61.9%** | 1.3% | 15.6% | 9.4% | 1.3% |
| 10K node | **46.7%** | 0.0% | 0.0% | 0.0% | 0.0% |

---

## Analiz

**Ghost SMP tüm ölçeklerde en yüksek teslim oranını sağlıyor.**

BATMAN 100-1000 node'da ikinci en iyi (%14.8-15.6) — TQ skoru yönlendirmeye yardımcı oluyor ama seyrek ağda sınırları var.

OLSR 1000 node'da %9.4 ile üçüncü — MPR seçimi flood'u azaltıyor ama keşif hâlâ kırılgan.

**Neden Ghost kazanıyor?** Koordinat interpolasyonu sayesinde seyrek ağda komşu olmayan noktalar arasında "mantıksal köprü" kuruluyor. Diğer tüm protokoller yalnızca fiziksel komşulara güveniyor.

**Ghost'un zayıfladığı yer:** Gecikme ve enerji — 10-100 node'da diğer protokoller daha hızlı. Hibrit mod 9 kısayol yakaladı ama ghost zinciri kurma yükü küçük ağlarda yüksek.
