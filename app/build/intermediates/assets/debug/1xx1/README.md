# 1XX1 Platform

**Merkeziyetsiz · Reklamsız · Açık Kaynak Uygulama Ekosistemi**

> "Para, sıralamayı hiçbir zaman etkilemez." — Temel Değişmez (INVARIANTS II-1)

---

## Nedir?

1XX1, bireylerin ve küçük geliştiricilerin projelerini büyük şirket platformlarına
bağımlı kalmadan paylaşabildiği, keşfedebildiği ve kullanabildiği bir platform çekirdeğidir.

Tek bir sunucuya bağımlı değildir. Cihazlar birbirleriyle doğrudan konuşur.
İnternet olmadan da çalışır. Sıralama algoritmasına kimse para ödeyemez.

---

## Hızlı Başlangıç

```bash
# Gereksinim: Node.js 22+

# Tek komutla başlat
node --experimental-strip-types main.ts

# Tarayıcıda aç
# http://localhost:1331
```

Platform başlatıcıları (ZIP'ten çalıştır):

| Platform | Dosya |
|---|---|
| Linux / Android (Termux) | `start.sh` |
| macOS | `Start.command` |
| Windows | `Start-1XX1.bat` |

---

## Mimari Özeti

```
Application Layer
      │
Cube Engine (11³ = 1331 koordinat)
      │
┌─────────────────────────────────────┐
│  Core Services                      │
│  Search · Pulse · Asset · Channel  │
└─────────────────────────────────────┘
      │
┌─────────────────────────────────────┐
│  Distributed Infrastructure         │
│  NodeRuntime · Raft · P2P · Gossip │
└─────────────────────────────────────┘
      │
┌─────────────────────────────────────┐
│  1331 Spatial Mesh Protocol (SMP)   │
│  Ghost Cube · LinkManager · AODV   │
└─────────────────────────────────────┘
      │
Physical Transport (LAN · BLE · WiFi)
```

---

## Temel Özellikler

- **Offline First** — İnternet olmadan tam çalışır
- **Sıralama Adaleti** — Pulse Engine, para/bağış sıralamayı etkileyemez
- **Ghost Mesh** — 1331 Spatial Mesh Protocol ile offline P2P
- **Plugin SDK** — 8 extension point, deny-by-default güvenlik
- **Snapshot + Raft** — Deterministik, lider seçimli konsensüs
- **Sıfır Reklam** — Hiçbir zaman reklam olmayacak

---

## Proje Yapısı

```
1xx1/
├── core/          Temel tipler, EventBus, Logger
├── cube_engine/   11³ Fraktal Küp Motoru
├── search/        Semantic + Structural + Reverse Index
├── pulse/         Fairness sıralama motoru
├── asset/         Asset Bank, SHA-256 checksum
├── channel/       Kanal sistemi, Trust Score
├── security/      4 analizör, Policy Engine
├── sandbox/       Plugin izolasyon katmanı
├── distributed/   Node Runtime, Gossip, Transport
├── consensus/     Lightweight Raft + Log Compaction
├── p2p/           Content-Addressed Storage
├── preview/       Preview Engine (Core/Renderer)
├── plugin/        Plugin SDK, 8 Extension Point
├── mesh/          1331 SMP, Ghost Cube, AODV
├── ops/           Observability, Docker, Helm, Chaos
├── ui/            Web Arayüzü (offline-first)
├── docs/          ADR + Stage dokümantasyonu
├── main.ts        Sistem giriş noktası
└── package.json
```

---

## Matematiksel Temel (Değişmez)

```
DR(n)      = n===0 ? 0 : 1+(n-1)%9     Dijital kök (routing seed, priority)
T(n)       = n*(n+1)/2                   Üçgensel sayı (mesafe birikici)
influence  = 1/(1+k·d²)                  Etki azalması
score      = sem×0.55 + str×0.30 + meta×0.10 + rec×0.05  Arama skoru
pulseNumber = floor(unixMs / intervalMs)  Deterministik pulse
1 unit     = 1 cm                        Evrensel ölçek sabiti
```

---

## Geliştirici Belgeleri

- `docs/ARCHITECTURE.md` — Mimari genel bakış
- `docs/INVARIANTS.md` — 21 değişmez kural
- `docs/DEPENDENCY_RULES.md` — Modül bağımlılık matrisi
- `docs/adr/` — 10 Mimari Karar Kaydı (ADR)
- `docs/stages/` — 20 aşama dokümantasyonu
- `mesh/simulation/SIM_RESULTS.md` — Ghost vs AODV simülasyon sonuçları

---

## Simülasyon Sonuçları (Ghost vs AODV)

| Senaryo | Ghost SMP | AODV | Kazanan |
|---|---|---|---|
| 10 node | 67.6% | 3.4% | Ghost +64pp |
| 100 node | 54.4% | 2.0% | Ghost +52pp |
| 1000 node | 58.8% | 1.9% | Ghost +57pp |
| 10K node | 51.7% | 0.0% | Ghost mutlak |

---

## Lisans

MIT © 2026 Kaptan (Emirhan)
