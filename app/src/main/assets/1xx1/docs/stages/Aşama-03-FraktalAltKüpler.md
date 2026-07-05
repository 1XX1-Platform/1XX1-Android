# Aşama-03 — Fraktal Alt Küpler

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-04 — Veri İndeksleme

---

## Mimari Kural Uyumu

| Kural | Açıklama | Durum |
|---|---|---|
| Kural 1 | `maxDepth = 0` → sınırsız derinlik, Cube Engine hard-code etmez | ✅ |
| Kural 2 | Lazy subcube — yalnızca proje eklenince oluşturulur | ✅ |
| Kural 3 | Tree yapısı — parent-child, global liste yok | ✅ |
| Kural 4 | CubePath tabanlı adresleme (`"4/7/2/3/8/5"`) | ✅ |
| Kural 5 | Split atomik; rollback ile veri kaybı yok | ✅ |
| Kural 6 | `query(recursive:true)` → arama motoru hazır | ✅ |
| Kural 7 | 5 yeni olay: split, merge, overflow, subcube-created, subcube-removed | ✅ |
| Kural 8 | Split O(proje/bucket), Query O(n), Traverse O(node) — sistemi dolaşmaz | ✅ |

---

## Tamamlanan Görevler

- [x] **CubePath sistemi** — hiyerarşik adresleme, parse, ata/torun karşılaştırma
- [x] **FractalNode** — LEAF/ROUTER rolleri, lazy child, drain/addProject
- [x] **Split algoritması** — hash tabanlı dağıtım, atomik, rollback
- [x] **Merge algoritması** — ters split, router → leaf, atomik
- [x] **FractalCubeEngine** — tam `ICubeEngine` implementasyonu
- [x] **Lazy kök** — 1331 kök hücre önceden oluşturulmaz
- [x] **Otomatik split** — splitThreshold aşılınca tetiklenir
- [x] **Otomatik merge** — mergeThreshold altına düşünce tetiklenir
- [x] **Recursive traversal** — BFS + DFS, visitor pruning
- [x] **Recursive query** — `{ recursive: true, maxDepth }` desteği
- [x] **EventBus entegrasyonu** — 5 yeni olay türü
- [x] **Proje taşıma** — `move(projectId, newPath)`
- [x] **62 birim testi** — path, node, split, merge, engine, traverse, performans
- [x] **config.ts güncellendi** — `maxSubcubeDepth` → `maxDepth=0` (sınırsız)
- [x] **types.ts güncellendi** — 5 yeni `SystemEventType`
- [x] **interfaces.ts güncellendi** — `ICubeEngine` fraktal API

---

## Yazılan / Güncellenen Dosyalar

| Dosya | İşlem | Satır |
|---|---|---|
| `cube_engine/cube-path.ts` | YENİ | ~130 |
| `cube_engine/fractal-node.ts` | YENİ | ~145 |
| `cube_engine/split-merge.ts` | YENİ | ~200 |
| `cube_engine/fractal-cube-engine.ts` | YENİ | ~280 |
| `cube_engine/index.ts` | GÜNCELLENDİ | ~40 |
| `cube_engine/__tests__/fractal.test.ts` | YENİ | ~370 |
| `core/config.ts` | GÜNCELLENDİ | ~130 |
| `core/interfaces.ts` | GÜNCELLENDİ | ~110 |
| `core/types.ts` | GÜNCELLENDİ | +5 olay türü |

---

## Dizin Ağacı

```
1xx1/
├── core/
│   ├── types.ts           ← +5 SystemEventType
│   ├── interfaces.ts      ← ICubeEngine fraktal API
│   ├── config.ts          ← maxDepth=0 (sınırsız)
│   └── ...
├── cube_engine/
│   ├── cube-cell.ts       (Aşama 02, korundu)
│   ├── cube-engine.ts     (Aşama 02, korundu)
│   ├── cube-path.ts       ← YENİ
│   ├── fractal-node.ts    ← YENİ
│   ├── split-merge.ts     ← YENİ
│   ├── fractal-cube-engine.ts ← YENİ
│   ├── index.ts           ← GÜNCELLENDİ
│   └── __tests__/
│       ├── cube-engine.test.ts (Aşama 02)
│       └── fractal.test.ts    ← YENİ (62 test)
└── docs/stages/
    └── Aşama-03-FraktalAltKüpler.md ← BU DOSYA
```

---

## Mimari Kararlar

### 1. Sonsuz Fraktal — `maxDepth = 0`
`ConfigManager.isDepthAllowed(depth)` metodu eklendi. `maxDepth === 0` ise her derinlik kabul edilir. Split algoritması bu metodu çağırır. Engine hard-coded sınır içermez.

### 2. Çift Katman Lazy
- **Kök lazy**: 1331 kök hücre başlangıçta oluşturulmaz. Bellek: 0 → yalnızca kullanılan kökler.
- **Alt küp lazy**: `FractalNode.getOrCreateChild()` yalnızca projeler hash'lendiğinde çağrılır.

### 3. LEAF / ROUTER İki-Rol Modeli
Bölünme sonrası parent `router` olur. Router düğümleri:
- Kendi proje listesi boş (`projectIds.size === 0`)
- Sorgulamada atlanır, alt küplere yönlendirilir
- Merge başarılıysa tekrar leaf'e döner

### 4. CubePath — Tek Gerçek Adres
`"4/7/2/3/8/5"` = derinlik-3 alt küp. `CubeID` yalnızca görüntüleme. `projectIndex: Map<ProjectID, string>` O(1) path lookup sağlar.

### 5. Atomik Split
Split 3 adımda gerçekleşir:
1. `drainProjects()` — tüm projeleri al
2. Çocukları oluştur + dağıt
3. `promoteToRouter()` — parent'ı yükselt

Herhangi bir adımda hata → rollback (projeler geri eklenir, çocuklar silinir).

### 6. Hash Tabanlı Dağıtım
`hashProjectToBucket(pid, bucketCount)` — ProjectID string'inden unsigned-32 hash, `bucketCount` ile mod. Deterministik ve O(len(id)) ≈ O(1). Yalnızca proje düşen bucket'lar (lazy) oluşturulur.

---

## Sonraki Aşamanın Amacı

**Aşama 04 — Veri İndeksleme**

- Tag-tabanlı indeks (`tag → [CubePath, ...]`)
- Geliştirici indeksi (`developerId → [ProjectID, ...]`)
- Lisans indeksi
- Ters indeks güncelleme (EventBus: `cube:indexed` dinlenir)
- İndeks istatistikleri ve ısınma (warm-up) desteği

---

## Riskler

| Risk | Olasılık | Önlem |
|---|---|---|
| Çok derin split zinciri bellek baskısı | Düşük | `maxDepth` > 0 ile sınırlanabilir |
| `_forceLeaf` any cast | Orta | Aşama 07'de `FractalNode.reset()` metodu ile temizlenecek |
| Router'a yanlış proje eklemesi | Düşük | `_indexIntoRouter` her zaman çocuğa yönlendirir |
| Merge sonrası projectIndex uyumsuzluğu | Düşük | Merge sonrası indeks güncelleme adımı mevcut |

---

## Performans Ölçümleri (Test Sonuçları)

| Test | Hedef | Gerçekleşen |
|---|---|---|
| 1000 proje ekleme | < 2000ms | ✓ |
| 200 proje tek küpe (split zinciri) | < 500ms | ✓ |
| 100 proje recursive query | < 100ms | ✓ |
