# ADR-001 — Fraktal Küp Motoru (Fractal Cube Engine)

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 02–03

---

## 1. Problem

1XX1 platformunda milyonlarca proje barındırılacak. Proje konumlandırması için:

- Düz liste → O(n) arama, ölçeklenmez
- İlişkisel DB indeksi → arama motorundan bağımsız değil, platform kilitlenmesi
- Koordinat tabanlı sistem → anlamlı konumlandırma, ancak nasıl parçalanacak?

**Ek kısıt:** Sistem dağıtık çalışacak. Her düğüm aynı koordinat sistemini kullanmalı.

---

## 2. Karar

**11 × 11 × 11 = 1.331 kök küp**, fraktal bölünme ile alt küplere ayrılabilen bir 3 boyutlu koordinat sistemi.

```
CubeCoordinate { x: 0-10, y: 0-10, z: 0-10 }
CubePath: "4/7/2/3/8"  → köklü, hiyerarşik, sonsuz derinlikte
```

Küp dolunca split olur → iki küp. Boşalınca merge olur → tek küp.  
Bu karar `FractalCubeEngine` ve `SplitMergeEngine` ile uygulandı.

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Düz liste | O(n) arama, sıralama için yetersiz |
| R-Tree / KD-Tree | Dış bağımlılık; dağıtık senkronizasyon zor |
| Consistent Hashing | Anlamlı koordinat yok; konumsal arama desteklenmiyor |
| Quad/Octree | Sadece 2D/3D geometri — semantik anlam taşımıyor |
| Graf DB | Fazla karmaşık; izolasyon kaybı |

---

## 4. Sonuçlar

**Artıları:**
- Koordinat sorgular O(1): `getByCoord(4, 7, 2)`
- Fraktal bölünme ile sınırsız ölçekleme
- CubePath insan okunabilir: `"4/7/2/3/8"` → log/debug/UI'da anlamlı
- Tüm düğümler aynı determinik formülü çalıştırır → dağıtık uyumluluk
- SearchEngine structural score için doğal mesafe fonksiyonu: `1/(1 + manhattan)`

**Eksileri:**
- `x, y, z ∈ [0,10]` sınırı → koordinat alanı değiştirilemez (kırılıcı değişiklik)
- Split/merge atomiklik gerektirir (TransactionManager ile çözüldü)
- Derin fraktal path → performans profilleme gerektirebilir

---

## 5. İleride Değiştirilebilir Noktalar

- `maxDepth` yapılandırılabilir (şu an `config.maxDepth = 0 = sınırsız`)
- `SplitPolicy` adaptör: büyük kümeler için adaptive threshold
- Path Registry: LogicalID sabit, CubePath değişken (Aşama 03'te implemente edildi)
- Koordinat sistemi genişletmesi: 3D → 4D (zaman boyutu) teorik olarak mümkün ama kırılıcı değişiklik

---

## İlgili Bileşenler

`cube_engine/fractal-cube-engine.ts` · `cube_engine/split-merge.ts` · `cube_engine/cube-path.ts` · `cube_engine/path-registry.ts` · `cube_engine/node-lock.ts` · `cube_engine/recursion-guard.ts`
