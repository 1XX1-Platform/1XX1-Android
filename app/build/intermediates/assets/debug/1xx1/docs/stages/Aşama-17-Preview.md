# Aşama-17 — Web Önizleme Motoru (Preview Engine)

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-18 — Snapshot + Log Compaction

---

## Bu Aşamada Ayrıca Eklendi

Bu aşama öncesinde üç mimari disiplin belgesi oluşturuldu (30.000+ satırlık
projede mimari tutarlılığı korumak için):

| Belge | İçerik |
|---|---|
| `docs/ARCHITECTURE.md` | Tüm sistemin katman diyagramı, veri akışları, sabitler |
| `docs/INVARIANTS.md` | 21 zorunlu kural (5 kategori): katman bağımlılığı, veri, güvenlik, performans, API |
| `docs/DEPENDENCY_RULES.md` | Hangi modül hangisini import edebilir — izin matrisi |

Bu belgeler kod değildir ama kod kadar bağlayıcıdır. Her yeni özellik önce
bu kurallara uyup uymadığı kontrol edilerek tasarlanır.

---

## Mimari Düzeltme — Core / Renderer Ayrımı

Aşama 17'nin ilk teslimi yalnızca platform bağımsız çekirdeği (extractor,
cache, service) içeriyordu. Web Preview katmanı (browser tarafından
tüketilebilecek resmi renderer) eksikti. Bu, Aşama 18/19/20'ye ertelenecek
bir konu değildi çünkü Preview Engine'in sorumluluğu tam olmadan tamamlanmış
sayılamazdı. Bu yüzden aynı aşama içinde dizin yapısı yeniden düzenlendi:

```
preview/
 ├── core/                    ← platform bağımsız (DOM bilmez)
 │   ├── preview-types.ts
 │   ├── extractors.ts
 │   ├── preview-cache.ts
 │   ├── preview-service.ts
 │   ├── __tests__/preview.test.ts
 │   └── index.ts             ← yalnızca Core API export eder
 │
 ├── renderer/                ← Browser/DOM bilir, Core'u import eder
 │   ├── renderer-types.ts    ← IPreviewRenderer, HtmlRendererRegistry
 │   ├── html-renderer.ts     ← üst düzey cephe: renderToHtml() + render()
 │   ├── markdown-renderer.ts
 │   ├── syntax-renderer.ts
 │   ├── image-renderer.ts
 │   ├── model3d-renderer.ts
 │   ├── binary-renderer.ts
 │   ├── opengraph-renderer.ts
 │   ├── __tests__/renderer.test.ts
 │   └── index.ts             ← yalnızca Renderer API export eder
 │
 ├── styles/
 │   └── preview.css          ← hafif, tema bağımsız (CSS custom property)
 │
 └── index.ts                  ← Core + Renderer'ı birlikte re-export eder
```

**Yeni invariant (I-11):** *Preview Core platform bağımsızdır. Renderer
Browser/DOM bilir. Core hiçbir zaman Renderer'ı import edemez.*

Her renderer iki sözleşme sunar:
- `renderToHtml(preview): string` — **zorunlu**, her ortamda çalışır (Node.js, Deno, edge, SSR)
- `render(preview): HTMLElement | null` — **opsiyonel**, yalnızca `document` mevcutsa

`HtmlRendererRegistry` tüm 6 renderer'ı tip bazında yönetir ve Plugin SDK
(Aşama 19) geldiğinde yeni renderer'ların `register()` ile eklenmesine izin
verir — mevcut kod değişmeden.

---

## Mimari

```
Asset/Proje Dosyası (Aşama 11 Asset Bank, Aşama 16 P2P CID)
    ↓
PreviewService.generate(cid, data, fileName, mimeType)   [preview/core/]
    │
    ├── PreviewCache.get(cid)  → varsa direkt döndür
    │
    ├── inferPreviewType()     → format tespiti
    │
    ├── Extractor Seçimi:
    │     MarkdownExtractor    → README.md, .mdx, .rst
    │     SyntaxExtractor      → .ts, .py, .rs, .go, ... (30+ dil)
    │     OpenGraphExtractor   → .html (OG meta tag ayrıştırma)
    │     Model3DExtractor     → .stl, .obj, .glb (triangle count, bounds)
    │     ImageExtractor       → .png, .svg, .jpg, .webp
    │     BinaryExtractor      → .wasm, .so, .exe (hex dump, format tespiti)
    │
    ├── extract() → PreviewResult
    │
    └── PreviewCache.set(cid, result, ttl)
              ↓
        renderToHtml(PreviewResult)                       [preview/renderer/]
              ↓
        HtmlRendererRegistry.resolve(type) → IPreviewRenderer
              ↓
        <div class="x1-preview x1-preview--markdown">...</div>
```

---

## Salt Okunur Prensibi (INVARIANTS.md I-9 genişlemesi)

Preview Engine **hiçbir zaman** veri yazmaz:
- Repository'ye yazmaz
- Storage Adapter'a yazmaz
- Yalnızca CID + binary veri → PreviewResult üretir

Bu, Search Engine'in READ-ONLY kuralıyla aynı disiplin.

---

## CID Tabanlı Cache (Aşama 16 entegrasyonu)

```
CID = SHA-256(içerik)   [Aşama 16 Content-Addressed Storage]
  ↓
PreviewCache: CID → PreviewResult

Avantaj: İçerik değişirse CID değişir → cache invalidation otomatik
```

---

## Extractor Detayları

### MarkdownExtractor
- Sıfır bağımlılık minimal parser
- Başlık (H1-H6), liste, kod bloğu, tablo tespiti
- TOC (table of contents) üretimi: `{ level, text, id }[]`
- Excerpt: ilk anlamlı paragraf (200 karakter)
- 200KB sınır

### SyntaxExtractor
- 30+ dil tespiti (uzantı haritası)
- HTML escape (XSS güvenli)
- İlk 50 satır preview (büyük dosyalar için)
- Gerçek highlight: UI katmanında Shiki (Aşama 18+)

### OpenGraphExtractor
- HTML `<meta property="og:*">` ayrıştırma (regex tabanlı)
- Fallback: `<title>` ve `<meta name="description">`
- Yalnızca `.html` dosyaları için

### Model3DExtractor
- **Gerçek STL parse**: ASCII (`facet normal` sayımı) + Binary (byte 80-83 uint32)
- Triangle count doğru hesaplanır (test ile doğrulandı)
- Thumbnail: SVG placeholder (gerçek 3D render UI'da Three.js ile)

### BinaryExtractor
- Hex dump (ilk 256 byte, offset + hex + ASCII format)
- Format tespiti: WASM, ELF, PE/EXE, PDF magic bytes

### ImageExtractor
- SVG: direkt data URI (XML güvenli)
- Raster: metadata + placeholder (gerçek resize UI'da)

---

## Test Kapsamı (11 grup, 50+ test — Core)

| Grup | Vurgu |
|---|---|
| Markdown | Başlık, kod bloğu, tablo, excerpt, OG title |
| Syntax | Dil tespiti (TS/Python), satır sayısı, HTML escape |
| OpenGraph | Meta tag ayrıştırma, title/description fallback |
| Binary | Hex dump, WASM/ELF/PE tespiti, 256 byte sınırı |
| Image | SVG data URI, PNG metadata |
| Model3D | ASCII/Binary STL triangle count (gerçek parse) |
| PreviewCache | TTL, LRU eviction, invalidate, stats |
| PreviewService | Tam akış, cache hit, oversized, fallback, batch |
| Determinizm | Aynı içerik → aynı önizleme (2× karşılaştırma) |
| Performans | 100KB markdown < 500ms, 100 dosya batch < 3s, 1000 cache op < 200ms |

## Test Kapsamı (10 grup, 35+ test — Renderer)

| Grup | Vurgu |
|---|---|
| renderer-types | escapeHtml XSS güvenliği, wrapPreview, registry öncelik sırası |
| MarkdownRenderer | TOC üretimi, badge (kod/tablo), boş heading durumu |
| SyntaxRenderer | Satır numarası, dil etiketi, kırpma uyarısı |
| ImageRenderer | figure/img üretimi, alt attribute XSS güvenliği |
| Model3DRenderer | `data-x1-model` attribute (UI Three.js entegrasyon noktası) |
| BinaryRenderer | Hex dump sarmalama, KB formatı |
| OpenGraphRenderer | Kart üretimi, eksik alan toleransı |
| html-renderer | defaultRegistry (6 renderer), SSR güvenliği |
| platform-bağımsızlık | `document` tanımsızken `render()` → null, çökme yok |
| Determinizm | Aynı PreviewResult → aynı HTML (byte-eşit) |

---

## Frontend Tasarım Yönü (Bu Aşamada Belirlendi, Uygulama Aşama 17+)

Üç sütunlu işletim sistemi hissi veren arayüz:

```
┌─────────────────────────────────────────────────────┐
│ LOGO   [ Arama: STL motor............... ]   Avatar │
├──────────┬─────────────────────────────┬─────────────┤
│ Explorer │                             │  Activity   │
│ 🏠 Ana    │                             │  (canlı     │
│ 🔥 Pulse  │       MAIN CONTENT          │   bilgiler) │
│ 🔍 Arama  │                             │             │
│ 📦 Proje  │                             │             │
│ 🏝 Kanal  │                             │             │
├──────────┴─────────────────────────────┴─────────────┤
│ Pulse | Downloads | Notifications | Network | Settings│
└─────────────────────────────────────────────────────┘
```

**Teknoloji yığını (planlanan):** React + TypeScript + Vite, TanStack Router/Query/Table/Virtual, Zustand, Radix UI, Tailwind CSS, Three.js (3D preview), Shiki (syntax), PDF.js, react-markdown.

**Renk paleti:** Background `#0E1116`, Panel `#171B22`, Accent `#5B8CFF`, Success `#27C46A`, Warning `#FFB020`, Danger `#E5484D`. Neon yok, ağır blur yok — sade.

Bu tasarım kararları dokümante edildi; gerçek UI implementasyonu ayrı bir frontend aşamasında (Aşama 17 sonrası istemci çalışması) ele alınacak.

---

## ADR

- **ADR-008**: Extractor pattern, CID cache, minimal parser kararları

---

## Sonraki Aşamanın Amacı

**Aşama-18 — Snapshot + Log Compaction**

- Raft log'un sonsuza kadar büyümesini önleme
- Incremental Snapshot (yalnızca değişen kısımlar)
- `ILogCompactor` gerçek implementasyonu (Aşama 15'te stub bırakılmıştı)
- Snapshot Streaming (büyük state transferi)
- Fast Join (yeni düğüm hızlı senkronizasyon)
