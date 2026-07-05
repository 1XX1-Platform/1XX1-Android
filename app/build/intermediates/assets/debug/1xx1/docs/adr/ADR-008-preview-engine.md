# ADR-008 — Web Önizleme Motoru (Preview Engine)

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 17

---

## 1. Problem

Platformda binlerce farklı türde içerik var: STL modeller, kaynak kodu, README,
PNG/SVG görseller, PDF döküman, WASM binary. Kullanıcı bir asset'e tıkladığında
ne göreceğini bilmeli — indirmeden önce.

Güçlükler:
- Her dosya türü farklı önizleme mantığı gerektiriyor
- Önizleme üretimi pahalı olabilir (3D render, syntax highlight)
- Aynı dosya tekrar tekrar önizlenmemeli (cache gerekli)
- Preview Engine veri yazmamalı — INVARIANTS.md kuralı

---

## 2. Kararlar

### Neden Extractor Pattern (Strategy)?
- Her dosya türü kendi `IPreviewExtractor` implementasyonuna sahip
- Yeni tür eklemek → yeni extractor, mevcut kod değişmez (Open/Closed)
- `canExtract()` + `extract()` ayrımı: seçim ve üretim ayrı sorumluluk
- Aşama 19 Plugin SDK'ya doğal geçiş: `IPreviewGenerator` arayüzü zaten var

### Neden CID Tabanlı Cache (Aşama 16 ile entegrasyon)?
- İçerik adresleme zaten var (Content-Addressed Storage)
- CID asla geçersiz olmaz — içerik değişirse CID değişir
- Cache invalidation problemi doğal olarak çözülür
- TTL yalnızca bellek yönetimi için, doğruluk için değil

### Neden Minimal Markdown Parser (full kütüphane değil)?
- Server-side önizleme: hızlı, bağımlılıksız, deterministik
- Tam render (syntax highlight, math, mermaid) → UI katmanında react-markdown
- Bu extractor: hızlı excerpt + TOC + metadata yeterli
- 200KB sınırı: büyük README'ler için makul kesim noktası

### Neden Sıfır Bağımlılık (Shiki/Sharp yerine stub)?
- Aşama 17 çekirdek mantığı kanıtlıyor — gerçek kütüphaneler entegrasyon detayı
- `SyntaxExtractor`: HTML escape + dil tespiti yeterli, gerçek highlight UI'da
- `ImageExtractor`: thumbnail placeholder, gerçek resize UI'da (Canvas/Sharp)
- `Model3DExtractor`: STL parse gerçek (triangle count doğru), thumbnail SVG placeholder

### Neden STL Parse Gerçek, Diğerleri Stub?
- STL formatı basit: ASCII `facet normal` sayımı veya binary header (byte 80-83)
- Gerçek 3D render (Three.js OffscreenCanvas) yalnızca tarayıcıda mantıklı
- Server-side: metadata (triangle count, bounds) yeterli — UI client-side render eder

### Neden PreviewService Salt Okunur?
- INVARIANTS.md I-9: "Index hiçbir zaman Persistence'a yazmaz"
- PreviewService bu kuralın genişlemesi: Preview hiçbir zaman Storage/Repository'ye yazmaz
- Yalnızca CID + binary alır, PreviewResult döndürür — yan etkisiz

### Neden Core/Renderer Ayrımı? (Mimari Düzeltme)
- İlk tasarımda `preview/` tek dizindi — extractor'lar zaten platform bağımsızdı
  ama bu garanti edilmiyordu, yeni biri yanlışlıkla `document` kullanabilirdi
- `preview/core/`: extractor, cache, service — `document`/`window`/`HTMLElement`
  asla bilmez. Node.js, Deno, edge, worker thread, herhangi bir SSR ortamında çalışır
- `preview/renderer/`: Browser/DOM bilir, Core'u tek yönlü import eder
- Her renderer **iki sözleşme** sunar:
  - `renderToHtml(preview): string` — ZORUNLU, her ortamda çalışır (SSR güvenli)
  - `render(preview): HTMLElement | null` — OPSİYONEL, yalnızca tarayıcıda
- `HtmlRendererRegistry`: Plugin SDK (Aşama 19) için hazır genişleme noktası
- Sonuç: aynı Preview Core; React, Vue, Svelte, Electron, Tauri, CLI, mobil
  istemciler tarafından yeniden kullanılabilir — yalnızca renderer değişir

### Neden html-renderer.ts (preview-dom-render.ts değil)?
- "dom-render" ismi DOM'a zorunlu bağımlılık izlenimi veriyordu
- Birincil sözleşme HTML STRING üretmek — DOM yalnızca opsiyonel kolaylık
- "html-renderer.ts" daha doğru: modülün asıl işi HTML üretmek, DOM ikincil

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Tüm önizlemeleri client-side üret | Server-side cache imkansız; her kullanıcı yeniden hesaplar |
| Headless browser (Puppeteer) screenshot | Ağır, yavaş, güvenlik riski (sandbox gerektirir) |
| Üçüncü parti preview API (Embedly) | Dış bağımlılık, ücretli, vendor lock |
| Tüm türler için tek generic extractor | Her format farklı mantık gerektirir, tek extractor şişer |
| Senkron önizleme üretimi | Büyük dosyalarda HTTP timeout riski |

---

## 4. Sonuçlar

**Artıları:**
- Yeni format eklemek: yeni `IPreviewExtractor`, sıfır mevcut kod değişikliği
- CID cache: aynı dosya iki kez önizlenmez
- Extractor'lar bağımsız test edilebilir (saf fonksiyonlar, I/O yok)
- `generateBatch()`: bir dosya hata verse diğerleri etkilenmez (Promise.allSettled)
- LRU + TTL kombinasyonu: bellek baskısı kontrol altında

**Eksileri:**
- Gerçek 3D thumbnail yok (placeholder SVG) — UI'da Three.js gerekli
- Syntax highlight gerçek değil (HTML escape only) — UI'da Shiki gerekli
- Markdown parser minimal — gelişmiş özellikler (mermaid, math) desteklenmiyor
- Image resize yok — orijinal boyutta data URI (büyük dosyalarda pahalı)

---

## 5. İleride Değiştirilebilir Noktalar

- `SyntaxExtractor` → Shiki entegrasyonu (gerçek highlight, tema desteği)
- `ImageExtractor` → Sharp/Canvas resize (gerçek thumbnail, 256×256)
- `Model3DExtractor` → Three.js OffscreenCanvas (gerçek 3D render, worker thread)
- `PreviewCache` → Redis/disk persistence (Aşama 18, restart sonrası cache kalıcı)
- `MarkdownExtractor` → mermaid/math desteği (gerekirse)
- `IPreviewExtractor` → `IPreviewGenerator` (Aşama 19 Plugin SDK'da resmi arayüz)

---

## İlgili Bileşenler

**Core (platform bağımsız):**
`preview/core/preview-types.ts` · `preview/core/extractors.ts` · `preview/core/preview-cache.ts` · `preview/core/preview-service.ts` · `preview/core/index.ts`

**Renderer (Browser/DOM):**
`preview/renderer/renderer-types.ts` · `preview/renderer/html-renderer.ts` · `preview/renderer/markdown-renderer.ts` · `preview/renderer/syntax-renderer.ts` · `preview/renderer/image-renderer.ts` · `preview/renderer/model3d-renderer.ts` · `preview/renderer/binary-renderer.ts` · `preview/renderer/opengraph-renderer.ts` · `preview/renderer/index.ts`

**Stil:**
`preview/styles/preview.css` (tema bağımsız, CSS custom property tabanlı)
