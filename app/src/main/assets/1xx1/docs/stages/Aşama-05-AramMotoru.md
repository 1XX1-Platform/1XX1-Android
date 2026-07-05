# Aşama-05 — Matematiksel Arama Motoru

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-06 — API Katmanı (onay bekliyor)

---

## Mimari

```
SearchEngine
│
├── QueryParser         → ham metin → ParsedQuery
│     normalize / tokenize / intent detection / coord extraction
│
├── QueryPlanner        → ParsedQuery → QueryPlan (A/B/C)
│     structural O(1) / semantic O(k) / hybrid O(log n)
│
├── CandidateGenerator  → QueryPlan → Set<Candidate>
│     semantic-lookup / structural-route / neighborhood-expand /
│     reverse-filter / merge-candidates
│
├── ScoringEngine       → Set<Candidate> → ScoreComponents[]
│     sem×0.55 + str×0.30 + meta×0.10 + rec×0.05
│     Levenshtein fuzzy / 1/(1+dist) / e^(-age/τ)
│
└── ResultRanker        → ScoreComponents[] → SearchHit[]
      tie-break / minScore / offset-limit / rank numarası
```

---

## Yeni Dosyalar

| Dosya | Satır | Açıklama |
|---|---|---|
| `search/search-types.ts`      | ~200 | Tüm Aşama 05 tipleri |
| `search/tokenizer.ts`         | ~130 | normalize, tokenize, Levenshtein, fuzzy |
| `search/query-parser.ts`      | ~150 | Ham metin → ParsedQuery, intent detection |
| `search/query-planner.ts`     | ~140 | ParsedQuery → QueryPlan (3 tip) |
| `search/candidate-generator.ts` | ~160 | Plan adımlarını çalıştır → Candidate pool |
| `search/scoring-engine.ts`    | ~190 | Çekirdek matematik: 4 bileşen |
| `search/ranker.ts`            | ~80  | Tie-break sıralaması, sayfalama |
| `search/search-engine.ts`     | ~220 | Pipeline orkestratörü, cache, read-only |
| `search/__tests__/search-engine.test.ts` | ~370 | 8 grup, 40+ test |
| `search/structural-index.ts`  | +25  | `getIdsByPath`, `getByCoordPrefix` eklendi |

---

## Skor Formülü

```
finalScore = semanticScore × 0.55 +
             structuralScore × 0.30 +
             metadataScore × 0.10 +
             recencyBoost × 0.05
```

| Bileşen | Hesaplama | Aralık |
|---|---|---|
| `semanticScore` | `rawHit / maxHit` (normalize) | 0–1 |
| `structuralScore` | `1 / (1 + manhattanDist)` | 0–1 |
| `metadataScore` | `(tagJaccard + devMatch + licMatch) / 3` | 0–1 |
| `recencyBoost` | `e^(-age / 7days)` | 0–1 |

Semantic ham skora şu çarpanlar uygulanır:
- Tam eşleşme: × 1.0 (ağırlıklı)
- Prefix eşleşme: × 1.3 (güçlendirilmiş)
- Fuzzy eşleşme: × 0.6 × similarity (azaltılmış)

---

## Query Pipeline — 3 Tip

### A) Semantic: `"video editing tool"`
`semantic-lookup → reverse-filter → merge → score → rank`  
Maliyet: O(k), k = token başına aday sayısı

### B) Structural: `"4/7/2"` veya `"cube:4/7/2"`
`structural-route → neighborhood-expand → merge → score → rank`  
Maliyet: O(1) — path doğrudan küp hücresine

### C) Hybrid: `"STL mesh repair 4/7/2"`
`semantic-lookup + structural-route → merge → score → rank`  
Maliyet: O(log n)

---

## Kritik Kural § 10: Read-Only

```
SearchEngine:
  ❌ eventBus.emit(...) — HİÇBİR ZAMAN
  ✔  eventBus.on("cube:indexed", ...) — cache invalidation
  ✔  eventBus.on("index:upserted", ...) — cache invalidation
  ✔  Yalnızca okur, skorlar, sıralar
```

Test ile doğrulandı: `"EventBus'a hiç olay atılmıyor"` — search sonrası emit listesi boş.

---

## Tie-Break Sırası

```
1. finalScore    (yüksek → düşük)
2. semanticScore (yüksek → düşük)
3. structuralScore (yüksek → düşük)
4. recencyBoost  (yüksek → düşük)
```

---

## Cache

- 30 saniyelik TTL
- LRU: 1000 entry limiti
- Anahtar: `{ term, filter, limit, offset }`
- Invalidation: `index:upserted`, `index:removed`, `cube:indexed`, `cube:split` olaylarında otomatik temizlenir

---

## Sonraki Aşamanın Amacı

**Aşama-06 — API Katmanı**

```
SearchEngine → REST/gRPC → Dış dünya

GET /search?q=STL+repair
GET /search?q=4/7/2&intent=structural
POST /search (body: RawQuery)
GET /search/explain?q=mesh
GET /search/resolve?q=STL+mesh

WebSocket: streaming search (chunk by chunk)
```

SearchEngine.search() → Response dönüştürme → HTTP handler  
Rate limiting, CORS, input validation bu katmanda yer alır.
