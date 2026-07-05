# Aşama-03-RiskGiderme + Aşama-04 — Veri İndeksleme

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-05 — Matematiksel Arama Motoru

---

## Aşama 03 Risk Giderme

### Risk 1 — Sonsuz Derinlik → Self-Braking Infinity

**Problem:** `maxDepth = 0` tek başına kontrolsüz node büyümesi demekti.

**Çözüm:** `SplitPolicy` sınıfı (`split-policy.ts`)

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `softDepthLimit` | 12 | Uyarı: log + event, split devam eder |
| `hardDepthLimit` | 64 | Mutlak tavan: split durur |
| `adaptive` | true | Threshold derinlikle büyür |
| `adaptiveFactor` | 1.5 | `threshold(d) = base × 1.5^d` |
| `maxPathSegments` | 70 | Path explosion koruması |

Örnek: `base=64, factor=1.5` → d=5'te threshold=486, d=10'da 3700. Derin düğümler daha az bölünür.

---

### Risk 2 — CubePath Invalidation → PathRegistry

**Problem:** Path değişince (split/merge) tüm referanslar stale olurdu.

**Çözüm:** `PathRegistry` sınıfı (`path-registry.ts`)

- `LogicalID` (ProjectID) sabit, değişmez
- `CubePath` değişken — `changePath()` / `bulkChangePath()`
- Değişim log'u tutar (son 1000 kayıt)
- `idempotencyKey` ile tekrar işlem güvenliği
- `replay()` ile crash recovery
- `"cube:path-changed"` olayını EventBus'a yayınlar

---

### Risk 3 — Concurrency → NodeLockManager

**Problem:** Async/await zincirlerinde aynı node üzerinde paralel split/insert.

**Çözüm:** `NodeLockManager` sınıfı (`node-lock.ts`)

- FIFO kilit kuyruğu: her path için bağımsız mutex
- `acquire(path)` → `Promise<ReleaseFunction>`
- Timeout: `timeoutMs` (varsayılan 5000ms)
- Idempotent `release()` — iki kez çağrılabilir
- `releaseStale(maxAgeMs)` watchdog
- Bellek tasarrufu: boş entry'ler otomatik silinir

---

### Risk 4 — EventBus → FIFO + Idempotency + Replay

**Problem:** Ordering yok, tekrar işlem riski, crash sonrası recovery yok.

**Çözüm:** `EventBus` tamamen yeniden yazıldı (`event-bus.ts`)

- **FIFO kuyruğu:** `_drainQueue()` ile sıralı işleme
- **Idempotency key:** aynı key → tek işlem, set'te saklanır
- **Processed key temizleme:** 10.000 limit aşılınca ¼'ü silinir
- **Event log:** son 500 olay saklanır
- **Replay:** `replay(n)` ile son N olayı yeniden yayınla
- **History:** `history(type)` ile tip bazlı sorgulama

---

### Risk 5 — Bounded Recursion → RecursionGuard

**Problem:** Sınırsız traversal ve recursive query → stack overflow + sonsuz döngü.

**Çözüm:** `recursion-guard.ts`

- `RecursionGuard`: derinlik sayacı, limit aşılınca `RecursionLimitError`
- `CycleDetector`: ziyaret listesi, tekrar görülünce `CycleDetectedError`
- `boundedCollect()`: güvenli recursive ID toplama
  - `maxResults`: sonuç listesi sınırı
  - `maxDepth`: derinlik sınırı
  - `detectCycles`: döngü tespiti
  - `truncated` bayrağı: sonuçlar kırpıldı mı?
- Traverse'de 100.000 düğüm limiti (BFS + DFS)

---

## Aşama 04 — Veri İndeksleme

### Üç Katmanlı Mimari Kararı

> **"Search index gerçekten cube yapısının içinde mi kalacak,
>    yoksa ayrı bir indexing subsystem mi olacak?"**

**Karar: Ayrı subsystem.**

Cube Engine yalnızca konum yönetir. IndexManager ayrı yaşar, EventBus üzerinden senkronize olur. Bu ayrım:

- Test edilebilirlik: her katman bağımsız
- Ölçeklenebilirlik: Aşama 07'de PostgreSQL full-text search eklenebilir
- Performans: indeks sorgular direkt Map'ten — küp ağacına inmez

---

### Katman 1: Structural Index

`structural-index.ts` — CubePath tabanlı konum haritası.

- `upsert(path, projectId)` → path entry'si oluşturur/günceller
- `getByCoord(coord)` → o koordinattaki tüm path'ler (kök + alt küpler)
- `getByDepth(d)` → belirli derinlikteki entry'ler
- `getRouters()` → router düğümlerin listesi
- EventBus abonelikleri: `cube:indexed`, `cube:split`, `cube:merge`, `cube:path-changed`

---

### Katman 2: Semantic Index

`semantic-index.ts` — Token tabanlı ters metin indeksi.

Alan ağırlıkları: `name(3.0) > tag(2.5) > description(1.5) > repo(1.0)`

- `upsert(project)` → tokenize, ağırlıkla indeksle
- `search(tokens)` → skor sıralı `ScoredProject[]`
- Tam eşleşme + prefix eşleşme (3+ karakter, 0.6 çarpanı)
- `topTokens(n)` → en sık token'lar (sıcak indeks görünümü)

---

### Katman 3: Reverse Index

`reverse-index.ts` — Metadata ters indeksi.

Anahtar formatları: `dev:`, `lic:`, `tag:`, `status:`

- `getByDeveloper/License/Tag/Status` → O(1)
- `getIntersection(keys)` → AND filtresi (en küçük setten başla)
- `getUnion(keys)` → OR filtresi
- `topKeys(n)` → en kalabalık anahtarlar

---

### IndexManager: Orkestratör

`index-manager.ts` — Tüm katmanları yönetir.

```
query(tokens, filter) akışı:
  1. semantic.search(tokens)     → skor listesi
  2. reverse.getIntersection()   → AND filtresi
  3. structural.getByCoord()     → koordinat filtresi
  4. birleştir, say, döndür
```

EventBus abonelikleri: `project:created`, `project:updated`, `project:archived`

---

## Yazılan / Güncellenen Dosyalar

| Dosya | İşlem | Açıklama |
|---|---|---|
| `cube_engine/split-policy.ts` | YENİ | Risk 1: Adaptive split |
| `cube_engine/path-registry.ts` | YENİ | Risk 2: Immutable ID + path |
| `cube_engine/node-lock.ts` | YENİ | Risk 3: FIFO mutex |
| `cube_engine/recursion-guard.ts` | YENİ | Risk 5: Bounded recursion |
| `core/event-bus.ts` | YENİDEN | Risk 4: FIFO + idempotency + replay |
| `cube_engine/fractal-cube-engine.ts` | YENİDEN | 5 risk entegre |
| `cube_engine/index.ts` | GÜNCELLENDİ | Yeni factory API |
| `search/index-types.ts` | YENİ | Üç katman tipleri |
| `search/structural-index.ts` | YENİ | Katman 1 |
| `search/semantic-index.ts` | YENİ | Katman 2 |
| `search/reverse-index.ts` | YENİ | Katman 3 |
| `search/index-manager.ts` | YENİ | Orkestratör + tekil örnek |
| `search/index.ts` | YENİ | Dışa aktarma |
| `search/__tests__/indexing.test.ts` | YENİ | 45+ test |

---

## Risk Durumu (Güncelleme)

| Risk | Önceki | Sonra |
|---|---|---|
| Sonsuz derinlik kontrolsüz | ⚠️ | ✅ SplitPolicy |
| Path invalidation stratejisi eksik | ⚠️ | ✅ PathRegistry |
| Concurrency tanımsız | ⚠️ | ✅ NodeLockManager |
| Event ordering yok | ⚠️ | ✅ FIFO + idempotency |
| Bounded recursion yok | ⚠️ | ✅ RecursionGuard |

---

## Sonraki Aşamanın Amacı

**Aşama 05 — Matematiksel Arama Motoru**

- `ISearchEngine` implementasyonu
- Token çözümleme: kelime → koordinat yolu (`STL → CAD → Mesh → Repair`)
- Semantic index + Structural index + Reverse index birleşik sorgu
- Sonuç sıralama: skor × konum ağırlığı
- Küp hiyerarşisi boyunca özyinelemeli arama
- Öneri motoru (yakın koordinat komşuları)
