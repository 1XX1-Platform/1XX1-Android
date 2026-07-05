# 1XX1 Platform — Mimari Dondurma (Architecture Freeze)

**Tarih:** 2026-06-29  
**Karar:** KESİN VE GERİ DÖNDÜRÜLEMEZ  
**Geçerlilik:** Aşama 20 boyunca ve sonrasında (yeni bir ADR ile açılana kadar)

---

## Dondurma Kararı

1XX1 Platform çekirdeği Aşama 1–19 ile tamamlandı.  
**Aşama 20 ve sonrasında yeni mimari ekleme, değiştirme veya genişletme yapılamaz.**

Bu karar, production hardening aşamasında "son aşamada yeni özellik ekleme" riskini
ve kapsam kaymasını (scope creep) önlemek için alınmıştır.

---

## Dondurulmuş Katmanlar (Aşama 1–19)

| Modül | Aşama | Durum |
|---|---|---|
| `core/` — Cube Engine, EventBus, Logger, Config, Identity | 01–03 | ✅ Dondurulmuş |
| `search/` — Semantic + Structural + Reverse Index | 04–05 | ✅ Dondurulmuş |
| `api/` — REST + SSE + Rate Limiting | 06 | ✅ Dondurulmuş |
| `database/` — UnitOfWork + Migrations | 07 | ✅ Dondurulmuş |
| `application/` — CQRS + Orchestrator + Validators | 08 | ✅ Dondurulmuş |
| `channel/` — Ada + Trust Score + Release | 09 | ✅ Dondurulmuş |
| `pulse/` — Pulse Engine + Ranking + Rotation | 10 | ✅ Dondurulmuş |
| `asset/` — Asset Bank + Dependency Graph + Storage | 11 | ✅ Dondurulmuş |
| `security/` — 4 Analyzer + PolicyEngine + Risk | 12 | ✅ Dondurulmuş |
| `sandbox/` — ISandboxAdapter + BehaviorMonitor | 13 | ✅ Dondurulmuş |
| `distributed/` — NodeRuntime + Gossip + Snapshot + Transport | 14 | ✅ Dondurulmuş |
| `consensus/` — Lightweight Raft + PulseSync + ValidatorSet | 15 | ✅ Dondurulmuş |
| `p2p/` — CID + Chunk + ContentRegistry + Transfer | 16 | ✅ Dondurulmuş |
| `preview/` — Core/Renderer ayrımı + 6 Extractor + 6 Renderer | 17 | ✅ Dondurulmuş |
| `consensus/compaction/` — IncrementalLogCompactor + FastJoin | 18 | ✅ Dondurulmuş |
| `plugin/` — SDK + 3 Risk Düzeltmesi + God-Object Refactor | 19 | ✅ Dondurulmuş |

---

## Aşama 20'de Ne YAPILIR

```
✅ Observability (metrik toplama, izleme, tracing)
✅ Deployment (Docker, K8s, Helm)
✅ Reliability (chaos testi, recovery doğrulama)
✅ Performance (benchmark, ölçüm, raporlama)
✅ Release Certification (operasyon belgeleri)
```

---

## Aşama 20'de Ne YAPILMAZ

```
❌ Yeni feature ekleme
❌ Yeni abstraction katmanı
❌ Yeni pattern veya paradigma
❌ Mevcut arayüzlerin imzasını değiştirme
❌ Yeni bağımlılık (external library) ekleme
❌ ADR numaraları 011+ (yeni mimari karar)
❌ INVARIANTS.md'ye yeni kural (kural sayısı kilitlendi: 21)
```

---

## Dondurma İstisnaları (Kabul Edilebilir)

Yalnızca şu durumlarda dokunulabilir:

1. **Güvenlik açığı** — zero-day fix, kapsam sadece etkilenen dosya
2. **Veri bozulması riski** — deterministik replay garantisini bozan bug
3. **Dependency uyumsuzluğu** — Node.js/Deno runtime zorunlu güncelleme

Her istisna ayrı bir commit ile belgelenmelidir. ADR numarası almaz —
`FREEZE_EXCEPTION_YYYY-MM-DD.md` formatında opsiyonel not belgesi yeterli.

---

## Bu Kararın Değeri

Platform çekirdeği 37.942 satır TypeScript, 169 dosya, 10 ADR, 20 stage
dokümanından oluşmaktadır. Bu noktada mimari ekleme yapmak:

- Mevcut testlerin geçerlilik garantisini zayıflatır
- Operasyon belgelerinin gerçeği yansıtmamasına yol açar
- Deployment stabilizasyonunu geciktirir
- "Bir şey daha ekleyelim" döngüsüne girerek hiç teslim edilemeyen bir
  sisteme dönüşme riskini tetikler

**Yazılım mühendisliğinde "bitti" diyebilmek de bir yetkinliktir.**

---

*Bu belge Kaptan (Emirhan) tarafından onaylanmıştır.*  
*Aşama 20 tamamlandıktan sonra bu dosya `docs/` dizinine taşınacaktır.*
