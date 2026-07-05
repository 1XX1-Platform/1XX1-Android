# ADR-002 — Arama Motoru Mimarisi

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 04–05

---

## 1. Problem

Platform projeleri nasıl bulunabilir olacak?

- Tam metin arama → ElasticSearch/Solr → dış bağımlılık, platform kilitlenmesi
- SQL LIKE → O(n), büyük veri setinde yetersiz, fuzzy yok
- Vektör embedding → LLM bağımlılığı, deterministik değil
- Kural tabanlı + matematik → bağımlılıksız, açıklanabilir, deterministik

**Ek kısıt:** Küp koordinat sistemi arama sonuçlarını etkilemeli. "Yakın proje" kavramı olmalı.

---

## 2. Karar

**Çok katmanlı hibrit arama:** token tabanlı + yapısal (koordinat) + metadata + recency.

```
score = semanticScore × 0.55 +
        structuralScore × 0.30 +
        metadataScore × 0.10 +
        recencyBoost × 0.05
```

**3 index katmanı:**
- `SemanticIndex`: token → ters indeks (alan ağırlıkları: name:3.0, tag:2.5)
- `StructuralIndex`: CubePath → proje haritası
- `ReverseIndex`: `dev:`, `lic:`, `tag:`, `status:` filtreleme

**Query intent tespiti:** regex + heuristic → semantic / structural / hybrid

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| ElasticSearch | Dış bağımlılık; platform kilitlenmesi; dağıtık senkronizasyon |
| PostgreSQL FTS | SQL bağımlılığı; küp koordinatı entegrasyon zor |
| BM25 | İyi ama tek boyutlu; yapısal skor yok |
| Embedding/Vektör | LLM bağımlılığı; deterministik değil; offline çalışmaz |
| Trigram | Tek başına yetersiz; koordinat puanlaması yok |

---

## 4. Sonuçlar

**Artıları:**
- Sıfır dış bağımlılık
- Deterministik: `aynı girdi → aynı sıralama`
- Açıklanabilir: `explain=true` ile her skor bileşeni görünür
- Küp koordinatı doğal olarak entegre: `structuralScore = 1/(1+manhattan)`
- SSE streaming ile kademeli sonuç teslimi
- EventBus'a asla olay atmaz (READ-ONLY kuralı, test ile doğrulandı)

**Eksileri:**
- Semantik anlam eksik: "araba" ≠ "otomobil" (eş anlamlı arama yok)
- Fuzzy threshold optimize edilmeli (false positive riski)
- Büyük indeks (100K+ proje) → RAM kullanımı monitörlenmeli

---

## 5. İleride Değiştirilebilir Noktalar

- `ScoringWeights` yapılandırılabilir (şu an: 0.55/0.30/0.10/0.05)
- Fuzzy threshold parametrik (`tokenizer.ts`, şu an 0.75)
- Semantic katmana embedding opsiyonel olarak eklenebilir (`ISemanticEngine` adaptörü)
- IndexManager → veritabanı destekli implementasyon (Aşama 07 üzerine)

---

## İlgili Bileşenler

`search/search-engine.ts` · `search/scoring-engine.ts` · `search/query-parser.ts` · `search/query-planner.ts` · `search/candidate-generator.ts` · `search/ranker.ts` · `search/tokenizer.ts`
