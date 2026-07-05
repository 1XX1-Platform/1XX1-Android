# Aşama-04-Düzeltmeler — 5 Kritik Rötuş

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-05 — Matematiksel Arama Motoru (onay bekliyor)

---

## Düzeltilen 5 Sorun

### Düzeltme 1 — Event Storm → Scope Separation

**Dosyalar:** `core/types.ts`, `core/event-bus.ts`

Olay tipleri 3 scope'a ayrıldı:

| Scope | Tipler | Kim yayınlar | Kim dinler |
|---|---|---|---|
| `core` | `project:*`, `pulse:tick`, `search:executed` | Herkes | Herkes |
| `cube` | `cube:*`, `cube:path-changed` | Yalnızca CubeEngine | Herkes |
| `index` | `index:*` | Yalnızca IndexManager/Reconciler | Yalnızca index katmanı |

**Korunma mekanizması:** `EventBus._currentScope` değişkeni, dispatch sırasında o anki scope'u tutar. `INDEX` scope işlenirken `CORE` veya `CUBE` emit çağrısı sessizce reddedilir ve loglanır. Sistem çalışmaya devam eder.

```
INDEX handler içinde:
  bus.emit("project:created", ...) → ENGELLENDI (scope violation)
  bus.emit("index:reconciled", ...) → İZİN VERİLDİ
```

---

### Düzeltme 2 — Index Drift → IndexReconciler

**Dosya:** `search/index-reconciler.ts`

Event kaybında indeks drifti önlemek için periyodik reconciliation job:

1. Ground truth kümesi al (PathRegistry veya reverse index'teki canlı ProjectID'ler)
2. Her katmanı tara — ground truth'ta olmayan entry'ler "orphan"
3. Orphanları temizle
4. Ground truth'ta olup indekste olmayan entry'leri "missing" olarak raporla
5. `index:reconciled` (her çalışma) ve `index:drift-detected` (drift varsa) yayınla

**Kritik:** Reconciler yalnızca `INDEX` scope olay yayınlar. Hiçbir zaman `CORE`/`CUBE`'e geri atmaz.

---

### Düzeltme 3 — Katman Bağımsızlığı

**Dosyalar:** `search/index-types.ts`, `search/index-manager.ts`

Net ayrım tanımlandı ve belgelendi:

```
Structural = routing   → "nerede?"  — CubePath bilir, proje adını bilmez
Semantic   = meaning   → "ne demek?" — token bilir, path bilmez
Reverse    = metadata  → "kim, ne?"  — lisans/tag bilir, token bilmez
```

**Kanıt:** Her katman birbirini import etmez. Path değişirse semantic etkilenmez (test ile doğrulandı). Lisans değişirse structural etkilenmez.

---

### Düzeltme 4 — Scoring Modeli

**Dosya:** `search/index-manager.ts`, `search/index-types.ts`

```
finalScore = semanticMatch × 0.6 +
             structuralProximity × 0.3 +
             recencyBoost × 0.1
```

| Bileşen | Hesaplama |
|---|---|
| `semanticMatch` | `rawScore / maxScore` (0–1, normalize) |
| `structuralProximity` | `1 - manhattanDistance/30` (0–1) |
| `recencyBoost` | `1 - ageMs/30days` (0–1, son 30 gün) |

`ScoreBreakdown` tipi 3 bileşeni ayrı ayrı döndürür — debug ve audit için şeffaf.

---

### Düzeltme 5 — Query Execution Pipeline

**Dosya:** `search/index-manager.ts` → `executePipeline()`

```
Query
  ↓ Normalize (lowercase, trim)
  ↓ Tokenize (split + original term)
  ↓ Semantic Fan-out (limit × 5 geniş aday)
  ↓ Candidate Filter (reverse AND + structural coord)
  ↓ Scoring (Düzeltme 4 formülü)
  ↓ Ranking (finalScore azalan)
  ↓ Return (limit, minScore)
```

Her adım `PipelineStep` üretir: `name`, `inputCount`, `outputCount`, `durationMs`.  
Toplam `executionMs` ölçülür. Debug ve performans takibi için tam şeffaflık.

---

## Dosya Değişimleri

| Dosya | Değişim |
|---|---|
| `core/types.ts` | `CoreEventType`, `CubeEventType`, `IndexEventType` ayrımı; `SystemEvent.scope` alanı |
| `core/event-bus.ts` | `_currentScope` tracker; scope violation guard; INDEX→CORE engeli |
| `search/index-types.ts` | `ScoringModel`, `DEFAULT_SCORING_MODEL`, `StructuralEntry.projectUpdatedAt` |
| `search/index-reconciler.ts` | YENİ — anti-drift periyodik temizlik |
| `search/index-manager.ts` | Scope izolasyon; `executePipeline()`; `ScoreBreakdown`; `_structuralProximity`, `_recencyScore` |
| `search/index.ts` | `index-reconciler` eklendi |
| `search/__tests__/indexing.test.ts` | 5 düzeltme odaklı 30+ yeni test |

---

## Aşama 05 Zemini

Tüm düzeltmeler tamamlandı. Sistem şu an:

✅ Event cascade yoktur — scope guard aktif  
✅ Index drift önlenebilir — reconciler hazır  
✅ Katmanlar birbirinden bağımsız — import zinciri yok  
✅ Scoring formülü tanımlı — `0.6/0.3/0.1` ağırlıkları  
✅ Pipeline belgelenmiş — 5 adım, ölçümlü  

**Aşama 05'te yapılacaklar:**

- `ISearchEngine` implementasyonu
- Kelime → CubePath yol çözümleyici (`STL → CAD → Mesh → Repair`)
- `executePipeline()` üzerine oturan tam arama servisi
- Öneri motoru (yakın koordinat + tag benzerliği)
- Arama yolu görselleştirme (kullanıcıya `path: ["STL", "Mesh", "Repair"]` göster)
