# Aşama-11 — Asset Bank (Özgür Varlık Bankası)

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-12 — AI Güvenlik ve Kod Analizi

---

## Temel Tasarım Kararı

Asset Bank bir dosya deposu değildir.  
Platform hiçbir varlığın sahibi değildir; yalnızca indeksler ve erişimi organize eder.

```
Dosya içeriği → Storage Adapter (disk, S3, IPFS, dağıtık)
Metadata      → Repository (veritabanı)
```

Bu ayrım sayesinde: depolama katmanı değiştiğinde hiçbir iş mantığı değişmez.

---

## Mimari

```
Application
    ↓
AssetService
    ├── MetadataEngine  — checksum + MIME + format
    ├── DependencyGraph — DAG + döngü tespiti
    └── ↓
    AssetRepository   — in-memory → Aşama 07 DB
    StorageAdapter    — in-memory → disk → S3/MinIO/IPFS
```

---

## Asset Entity

```typescript
Asset {
  assetId, ownerId, channelId?, projectId?, releaseId?
  type: AssetType      // 3d_model | mesh | texture | audio | ...
  format: string       // "stl", "png", "glsl", vb.
  title, description, tags
  license: AssetLicenseType
  status: "pending" | "active" | "flagged" | "removed"
  versions: AssetVersion[]
  latestVersion: string
  downloadCount, referenceCount
}
```

---

## Desteklenen 13 Tür

`3d_model` | `mesh` | `texture` | `audio` | `video` | `image` | `font` | `cad` | `document` | `dataset` | `script` | `plugin` | `shader`

Her türün desteklediği formatlar `SUPPORTED_FORMATS` sabitinde tanımlıdır.

---

## Duplicate Detection

```
upload(file)
  → computeChecksum(SHA-256)
  → repo.findByChecksum(sha256)
  → mevcut? → referenceCount++ → existing asset döndür
  → yeni?   → storage.put() → repo.create()
```

Aynı içerik asla iki kez depolanmaz.

---

## Dependency Graph (DAG)

```
Scene → Mesh → Texture → Shader
```

- Yönlü Döngüsüz Graf (DAG)
- BFS ile döngü tespiti
- `directDependencies(id)` — doğrudan bağımlılıklar
- `directDependents(id)` — bu asset'i kullananlar
- `allDependencies(id)` — tüm geçişli bağımlılıklar
- `findPath(from, to)` — en kısa yol

---

## Lisans Matrisi

| Parent \ Child | MIT | GPL-3.0 | CC0 | Proprietary |
|---|---|---|---|---|
| **MIT** | ✅ | ✅ | ✅ | ❌ |
| **GPL-3.0** | ❌ | ✅ | ✅ | ❌ |
| **CC0** | ✅ | ✅ | ✅ | ❌ |
| **Proprietary** | ❌ | ❌ | ❌ | ❌ |

Copyleft lisans türevlerini de copyleft olmaya zorlar.

---

## Storage Adapter Arayüzü

```typescript
interface IStorageAdapter {
  put(key, data, mimeType)  → StorageObject
  get(key)                  → Uint8Array | null
  exists(key)               → boolean
  delete(key)               → boolean
  list(prefix)              → string[]
  getUrl(key, expiresInMs)  → string
  stats()                   → { totalObjects, totalBytes }
}
```

Production'da tek satır değişiklikle S3, MinIO veya IPFS'e geçilir.

---

## Depolama Anahtarı Formatı

```
assets/{ownerId}/{assetId}/{versionId}/{fileName}
```

CDN önbelleğe alma + yetki kontrolü + sürüm izolasyonu doğal olarak çalışır.

---

## Domain Events

`asset:created` | `asset:updated` | `asset:versioned` | `asset:indexed` | `asset:deleted`

---

## Test Kapsamı (10 grup, 45+ test)

Entities, Storage, Metadata (checksum, MIME, magic bytes), Dependency Graph, Repository, Service (upload, duplicate, versioning, dependency, download), License Policy, **10.000 asset performans testi**

---

## Sonraki Aşamanın Amacı

**Aşama-12 — AI Güvenlik ve Kod Analizi**

- Yüklenen dosyalar için statik analiz
- Zararlı yazılım tespiti (pattern matching)
- Kod kalite metrikleri
- Asset Trust Score'unu güncellemek
- `asset.status: "pending" → "active" | "flagged"` akışı
