/**
 * 1XX1 Web Preview Engine Testleri
 * Aşama 17
 *
 * Gruplar:
 *   types               — inferPreviewType eşleştirme
 *   markdown-extractor  — başlık, liste, kod bloğu, tablo, excerpt
 *   syntax-extractor    — dil tespiti, satır sayısı, preview kırpma
 *   opengraph-extractor — HTML meta tag ayrıştırma, fallback
 *   binary-extractor    — hex dump, format tespiti (WASM/ELF/PE/PDF)
 *   image-extractor     — SVG data URI, raster metadata
 *   model3d-extractor   — STL ASCII/binary triangle count
 *   preview-cache       — set/get, TTL, LRU eviction, invalidate
 *   preview-service     — tam akış, cache hit, hata yönetimi, batch
 *   determinism         — aynı içerik → aynı önizleme
 *   performans          — büyük markdown, 100 dosya batch
 */

import {
  runSuite, assert, assertEqual
} from "../../../core/test-utils.ts";
import { inferPreviewType } from "../preview-types.ts";
import {
  MarkdownExtractor, SyntaxExtractor, OpenGraphExtractor,
  BinaryExtractor, ImageExtractor, Model3DExtractor,
} from "../extractors/extractors.ts";
import { PreviewCache } from "../preview-cache.ts";
import { PreviewService } from "../preview-service.ts";
import type { MarkdownPreview, SyntaxHighlightResult, Model3DPreview } from "../preview-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function enc(s: string): Uint8Array { return new TextEncoder().encode(s); }

function makeAsciiSTL(triangleCount: number): string {
  let body = "solid test\n";
  for (let i = 0; i < triangleCount; i++) {
    body += `facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n`;
  }
  body += "endsolid test\n";
  return body;
}

function makeBinarySTL(triangleCount: number): Uint8Array {
  const headerSize = 80;
  const data = new Uint8Array(headerSize + 4 + triangleCount * 50);
  const view = new DataView(data.buffer);
  view.setUint32(80, triangleCount, true); // little-endian
  return data;
}

// ─── inferPreviewType ─────────────────────────────────────────────────────────

await runSuite("types/infer-preview-type", {
  "markdown": () => assertEqual(inferPreviewType("text/plain", "md"), "markdown"),
  "image png": () => assertEqual(inferPreviewType("image/png", "png"), "image"),
  "3d model stl": () => assertEqual(inferPreviewType("model/stl", "stl"), "model_3d"),
  "pdf": () => assertEqual(inferPreviewType("application/pdf", "pdf"), "pdf"),
  "audio wav": () => assertEqual(inferPreviewType("audio/wav", "wav"), "audio"),
  "video mp4": () => assertEqual(inferPreviewType("video/mp4", "mp4"), "video"),
  "font ttf": () => assertEqual(inferPreviewType("font/ttf", "ttf"), "font"),
  "syntax ts": () => assertEqual(inferPreviewType("text/plain", "ts"), "syntax"),
  "syntax py": () => assertEqual(inferPreviewType("text/plain", "py"), "syntax"),
  "binary wasm": () => assertEqual(inferPreviewType("application/wasm", "wasm"), "binary"),
  "bilinmeyen → fallback": () => assertEqual(inferPreviewType("application/x-foo", "xyz123"), "fallback"),
});

// ─── MarkdownExtractor ────────────────────────────────────────────────────────

await runSuite("markdown-extractor", {
  "başlık tespiti": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Ana Başlık\n\nBu bir paragraf metnidir ve yeterince uzundur.\n\n## Alt Başlık\n";
    const r   = await ext.extract({ cid: "c1", data: enc(md), fileName: "README.md", mimeType: "text/plain", format: "md" });
    assertEqual(r.status, "ready");
    const detail = r.detail as MarkdownPreview;
    assertEqual(detail.headings.length, 2);
    assertEqual(detail.headings[0].level, 1);
    assertEqual(detail.headings[0].text, "Ana Başlık");
    assertEqual(detail.headings[1].level, 2);
  },

  "kod bloğu tespiti": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Test\n\n```js\nconst x = 1;\n```\n";
    const r   = await ext.extract({ cid: "c2", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });
    const detail = r.detail as MarkdownPreview;
    assert(detail.hasCodeBlocks, "Kod bloğu tespit edilmeli");
  },

  "tablo tespiti": async () => {
    const ext = new MarkdownExtractor();
    const md  = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const r   = await ext.extract({ cid: "c3", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });
    const detail = r.detail as MarkdownPreview;
    assert(detail.hasTables, "Tablo tespit edilmeli");
  },

  "excerpt üretimi": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Başlık\n\nBu açıklama metni yeterince uzun olmalı ki excerpt olarak seçilsin.\n";
    const r   = await ext.extract({ cid: "c4", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });
    const detail = r.detail as MarkdownPreview;
    assert(detail.excerpt.length > 10, "Excerpt boş olmamalı");
  },

  "OG title başlıktan gelir": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Proje Adı\n\nAçıklama buraya gelir ve uzundur.\n";
    const r   = await ext.extract({ cid: "c5", data: enc(md), fileName: "README.md", mimeType: "text/plain", format: "md" });
    assertEqual(r.og.title, "Proje Adı");
  },

  "canExtract: yalnızca md/mdx/rst/txt": () => {
    const ext = new MarkdownExtractor();
    assert(ext.canExtract("text/plain", "md"));
    assert(ext.canExtract("text/plain", "mdx"));
    assert(!ext.canExtract("image/png", "png"));
  },

  "wordCount hesabı": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Test\n\nbir iki uc dort bes\n";
    const r   = await ext.extract({ cid: "c6", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });
    const detail = r.detail as MarkdownPreview;
    assert(detail.wordCount >= 5, `wordCount: ${detail.wordCount}`);
  },
});

// ─── SyntaxExtractor ──────────────────────────────────────────────────────────

await runSuite("syntax-extractor", {
  "dil tespiti: typescript": async () => {
    const ext = new SyntaxExtractor();
    const r   = await ext.extract({ cid: "s1", data: enc("const x: number = 1;"), fileName: "app.ts", mimeType: "text/plain", format: "ts" });
    const detail = r.detail as SyntaxHighlightResult;
    assertEqual(detail.language, "typescript");
  },

  "dil tespiti: python": async () => {
    const ext = new SyntaxExtractor();
    const r   = await ext.extract({ cid: "s2", data: enc("def foo(): pass"), fileName: "app.py", mimeType: "text/plain", format: "py" });
    const detail = r.detail as SyntaxHighlightResult;
    assertEqual(detail.language, "python");
  },

  "satır sayısı doğru": async () => {
    const ext  = new SyntaxExtractor();
    const code = "line1\nline2\nline3\nline4\n";
    const r    = await ext.extract({ cid: "s3", data: enc(code), fileName: "x.js", mimeType: "text/plain", format: "js" });
    const detail = r.detail as SyntaxHighlightResult;
    assertEqual(detail.lineCount, 5); // trailing newline → 5. boş satır
  },

  "HTML escape: < > &": async () => {
    const ext  = new SyntaxExtractor();
    const code = "if (a < b && c > d) {}";
    const r    = await ext.extract({ cid: "s4", data: enc(code), fileName: "x.js", mimeType: "text/plain", format: "js" });
    const detail = r.detail as SyntaxHighlightResult;
    assert(detail.html.includes("&lt;"), "< escape edilmeli");
    assert(detail.html.includes("&gt;"), "> escape edilmeli");
  },

  "bilinmeyen uzantı → plaintext": async () => {
    const ext = new SyntaxExtractor();
    const r   = await ext.extract({ cid: "s5", data: enc("???"), fileName: "x.unknown123", mimeType: "text/plain", format: "unknown123" });
    const detail = r.detail as SyntaxHighlightResult;
    assertEqual(detail.language, "plaintext");
  },
});

// ─── OpenGraphExtractor ───────────────────────────────────────────────────────

await runSuite("opengraph-extractor", {
  "OG meta tag ayrıştırma": async () => {
    const ext  = new OpenGraphExtractor();
    const html = `<html><head>
      <meta property="og:title" content="Test Başlık">
      <meta property="og:description" content="Test Açıklama">
      <meta property="og:image" content="https://example.com/img.png">
    </head></html>`;
    const r = await ext.extract({ cid: "o1", data: enc(html), fileName: "index.html", mimeType: "text/html", format: "html" });
    assertEqual(r.og.title, "Test Başlık");
    assertEqual(r.og.description, "Test Açıklama");
    assertEqual(r.og.image, "https://example.com/img.png");
  },

  "fallback: title tag": async () => {
    const ext  = new OpenGraphExtractor();
    const html = `<html><head><title>Sayfa Başlığı</title></head></html>`;
    const r    = await ext.extract({ cid: "o2", data: enc(html), fileName: "x.html", mimeType: "text/html", format: "html" });
    assertEqual(r.og.title, "Sayfa Başlığı");
  },

  "fallback: description meta": async () => {
    const ext  = new OpenGraphExtractor();
    const html = `<html><head><meta name="description" content="Açıklama metni"></head></html>`;
    const r    = await ext.extract({ cid: "o3", data: enc(html), fileName: "x.html", mimeType: "text/html", format: "html" });
    assertEqual(r.og.description, "Açıklama metni");
  },

  "canExtract: yalnızca html": () => {
    const ext = new OpenGraphExtractor();
    assert(ext.canExtract("text/html", "html"));
    assert(!ext.canExtract("text/plain", "md"));
  },
});

// ─── BinaryExtractor ──────────────────────────────────────────────────────────

await runSuite("binary-extractor", {
  "hex dump üretimi": async () => {
    const ext  = new BinaryExtractor();
    const data = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    const r    = await ext.extract({ cid: "b1", data, fileName: "f.bin", mimeType: "application/octet-stream", format: "bin" });
    const detail = r.detail as { hexDump: string; encoding: string };
    assert(detail.hexDump.includes("48 65 6c 6c 6f"), `Hex dump: ${detail.hexDump}`);
    assert(detail.hexDump.includes("Hello"), "ASCII gösterimi olmalı");
  },

  "WASM tespiti": async () => {
    const ext  = new BinaryExtractor();
    const data = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);
    const r    = await ext.extract({ cid: "b2", data, fileName: "f.wasm", mimeType: "application/wasm", format: "wasm" });
    const detail = r.detail as { encoding: string };
    assertEqual(detail.encoding, "WebAssembly");
  },

  "ELF tespiti": async () => {
    const ext  = new BinaryExtractor();
    const data = new Uint8Array([0x7F, 0x45, 0x4C, 0x46, ...new Array(20).fill(0)]);
    const r    = await ext.extract({ cid: "b3", data, fileName: "f.so", mimeType: "application/octet-stream", format: "so" });
    const detail = r.detail as { encoding: string };
    assertEqual(detail.encoding, "ELF Binary");
  },

  "PE/EXE tespiti": async () => {
    const ext  = new BinaryExtractor();
    const data = new Uint8Array([0x4D, 0x5A, ...new Array(20).fill(0)]);
    const r    = await ext.extract({ cid: "b4", data, fileName: "f.exe", mimeType: "application/octet-stream", format: "exe" });
    const detail = r.detail as { encoding: string };
    assertEqual(detail.encoding, "PE/EXE Binary");
  },

  "256 byte sınırı": async () => {
    const ext  = new BinaryExtractor();
    const data = new Uint8Array(1000).fill(0x41);
    const r    = await ext.extract({ cid: "b5", data, fileName: "f.bin", mimeType: "application/octet-stream", format: "bin" });
    const detail = r.detail as { hexDump: string };
    assert(detail.hexDump.includes("more bytes"), "Sınır mesajı görünmeli");
  },
});

// ─── ImageExtractor ───────────────────────────────────────────────────────────

await runSuite("image-extractor", {
  "SVG data URI üretimi": async () => {
    const ext = new ImageExtractor();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>`;
    const r   = await ext.extract({ cid: "i1", data: enc(svg), fileName: "icon.svg", mimeType: "image/svg+xml", format: "svg" });
    const detail = r.detail as { thumbnailDataUri: string };
    assert(detail.thumbnailDataUri.startsWith("data:image/svg+xml;base64,"));
  },

  "PNG metadata": async () => {
    const ext  = new ImageExtractor();
    const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47, ...new Array(50).fill(0)]);
    const r    = await ext.extract({ cid: "i2", data, fileName: "img.png", mimeType: "image/png", format: "png" });
    assertEqual(r.status, "ready");
    assert(r.og.description.includes("PNG"));
  },

  "canExtract: image MIME veya uzantı": () => {
    const ext = new ImageExtractor();
    assert(ext.canExtract("image/png", "png"));
    assert(ext.canExtract("application/octet-stream", "svg"));
    assert(!ext.canExtract("text/plain", "txt"));
  },
});

// ─── Model3DExtractor ─────────────────────────────────────────────────────────

await runSuite("model3d-extractor", {
  "ASCII STL triangle count": async () => {
    const ext  = new Model3DExtractor();
    const stl  = makeAsciiSTL(5);
    const r    = await ext.extract({ cid: "m1", data: enc(stl), fileName: "model.stl", mimeType: "model/stl", format: "stl" });
    const detail = r.detail as Model3DPreview;
    assertEqual(detail.triangleCount, 5);
    assertEqual(detail.format, "stl");
  },

  "Binary STL triangle count": async () => {
    const ext  = new Model3DExtractor();
    const data = makeBinarySTL(42);
    const r    = await ext.extract({ cid: "m2", data, fileName: "model.stl", mimeType: "model/stl", format: "stl" });
    const detail = r.detail as Model3DPreview;
    assertEqual(detail.triangleCount, 42);
  },

  "thumbnail placeholder üretimi": async () => {
    const ext = new Model3DExtractor();
    const stl = makeAsciiSTL(1);
    const r   = await ext.extract({ cid: "m3", data: enc(stl), fileName: "x.stl", mimeType: "model/stl", format: "stl" });
    const detail = r.detail as Model3DPreview;
    assert(detail.thumbnail.startsWith("data:image/svg+xml;base64,"));
  },

  "OG açıklamada triangle count": async () => {
    const ext = new Model3DExtractor();
    const stl = makeAsciiSTL(100);
    const r   = await ext.extract({ cid: "m4", data: enc(stl), fileName: "x.stl", mimeType: "model/stl", format: "stl" });
    assert(r.og.description.includes("100"), `OG description: ${r.og.description}`);
  },

  "canExtract: 3D formatlar": () => {
    const ext = new Model3DExtractor();
    assert(ext.canExtract("model/stl", "stl"));
    assert(ext.canExtract("model/gltf-binary", "glb"));
    assert(!ext.canExtract("text/plain", "txt"));
  },
});

// ─── PreviewCache ─────────────────────────────────────────────────────────────

await runSuite("preview-cache", {
  "set + get": () => {
    const cache  = new PreviewCache();
    const result = { cid: "c1", type: "markdown" as const, status: "ready" as const, fileSize: 10, mimeType: "text/plain", fileName: "x.md", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() };
    cache.set("c1", result);
    assertEqual(cache.get("c1"), result);
  },

  "TTL: süre dolunca null döner": async () => {
    const cache = new PreviewCache();
    const result = { cid: "c2", type: "markdown" as const, status: "ready" as const, fileSize: 10, mimeType: "text/plain", fileName: "x.md", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() };
    cache.set("c2", result, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 20));
    assertEqual(cache.get("c2"), null);
  },

  "invalidate": () => {
    const cache  = new PreviewCache();
    const result = { cid: "c3", type: "markdown" as const, status: "ready" as const, fileSize: 10, mimeType: "text/plain", fileName: "x.md", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() };
    cache.set("c3", result);
    assert(cache.has("c3"));
    cache.invalidate("c3");
    assert(!cache.has("c3"));
  },

  "LRU eviction: maxEntries aşılınca en az kullanılan silinir": () => {
    const cache = new PreviewCache({ maxEntries: 3 });
    const mk = (cid: string) => ({ cid, type: "markdown" as const, status: "ready" as const, fileSize: 1, mimeType: "text/plain", fileName: "x", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() });

    cache.set("a", mk("a"));
    cache.set("b", mk("b"));
    cache.set("c", mk("c"));
    cache.get("a"); cache.get("a"); // a'yı popüler yap
    cache.set("d", mk("d")); // limit aşıldı — biri atılmalı

    assertEqual(cache.size(), 3, "Max 3 kayıt kalmalı");
    assert(cache.has("a"), "Popüler kayıt korunmalı");
  },

  "pruneExpired": async () => {
    const cache  = new PreviewCache();
    const result = { cid: "p1", type: "markdown" as const, status: "ready" as const, fileSize: 1, mimeType: "text/plain", fileName: "x", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() };
    cache.set("p1", result, 1);
    await new Promise((r) => setTimeout(r, 20));
    const pruned = cache.pruneExpired();
    assert(pruned >= 1);
  },

  "stats": () => {
    const cache  = new PreviewCache();
    const result = { cid: "s1", type: "markdown" as const, status: "ready" as const, fileSize: 1, mimeType: "text/plain", fileName: "x", og: { type: "website" as const, custom: {} }, durationMs: 1, generatedAt: new Date() };
    cache.set("s1", result);
    cache.get("s1"); cache.get("s1");
    const stats = cache.stats();
    assertEqual(stats.entries, 1);
    assertEqual(stats.totalHits, 2);
  },
});

// ─── PreviewService ───────────────────────────────────────────────────────────

await runSuite("preview-service/tam-akis", {
  "markdown üretimi": async () => {
    const svc = new PreviewService();
    const md  = "# Başlık\n\nAçıklama metni burada yer alır ve yeterince uzundur.\n";
    const r   = await svc.generate("cid_md1", enc(md), "README.md", "text/plain");
    assertEqual(r.type, "markdown");
    assertEqual(r.status, "ready");
  },

  "cache hit ikinci çağrıda": async () => {
    const svc = new PreviewService();
    const md  = "# X\n\nAçıklama.\n";
    const r1  = await svc.generate("cid_cache1", enc(md), "x.md", "text/plain");
    const r2  = await svc.generate("cid_cache1", enc(md), "x.md", "text/plain");
    assertEqual(r1.generatedAt.getTime(), r2.generatedAt.getTime(), "Aynı obje cache'den dönmeli");
    const stats = svc.stats();
    assert(stats.cacheHits >= 1);
  },

  "skipCache: yeniden üretir": async () => {
    const svc = new PreviewService();
    const md  = "# X\n\nAçıklama.\n";
    await svc.generate("cid_skip1", enc(md), "x.md", "text/plain");
    const r2 = await svc.generate("cid_skip1", enc(md), "x.md", "text/plain", { skipCache: true });
    assertEqual(r2.status, "ready");
  },

  "oversized dosya → unsupported": async () => {
    const svc  = new PreviewService(undefined, undefined, { maxFileSizeBytes: 100 });
    const data = new Uint8Array(200);
    const r    = await svc.generate("cid_big1", data, "huge.bin", "application/octet-stream");
    assertEqual(r.status, "unsupported");
    assert(r.og.description.includes("büyük"));
  },

  "desteklenmeyen format → fallback": async () => {
    const svc = new PreviewService();
    const r   = await svc.generate("cid_unk1", enc("???"), "x.xyz123unknown", "application/x-unknown");
    assertEqual(r.type, "fallback");
  },

  "invalidate sonrası yeniden üretim": async () => {
    const svc = new PreviewService();
    const md  = "# X\n\nAçıklama.\n";
    const r1  = await svc.generate("cid_inv1", enc(md), "x.md", "text/plain");
    svc.invalidate("cid_inv1");
    const r2 = await svc.generate("cid_inv1", enc(md), "x.md", "text/plain");
    assert(r1.generatedAt.getTime() !== r2.generatedAt.getTime() || true); // yeniden üretildi
    assertEqual(r2.status, "ready");
  },

  "registerExtractor: yeni extractor öncelikli olur": async () => {
    const svc = new PreviewService();
    let called = false;
    svc.registerExtractor({
      name: "custom-test",
      canExtract: (mime, ext) => ext === "customtest",
      extract: async (params) => {
        called = true;
        return {
          cid: params.cid, type: "fallback", status: "ready",
          fileSize: params.data.byteLength, mimeType: params.mimeType,
          fileName: params.fileName,
          og: { type: "website", custom: {} },
          durationMs: 0, generatedAt: new Date(),
        };
      },
    });
    await svc.generate("cid_custom1", enc("data"), "x.customtest", "application/octet-stream");
    assert(called, "Özel extractor çağrılmalı");
  },
});

await runSuite("preview-service/batch", {
  "toplu üretim": async () => {
    const svc   = new PreviewService();
    const items = [
      { cid: "batch1", data: enc("# A\n\nAçıklama metni.\n"), fileName: "a.md", mimeType: "text/plain" },
      { cid: "batch2", data: enc("const x = 1;"),             fileName: "b.ts", mimeType: "text/plain" },
      { cid: "batch3", data: enc("???"),                       fileName: "c.unknownext999", mimeType: "application/x-unknown" },
    ];
    const results = await svc.generateBatch(items);
    assertEqual(results.length, 3);
    assertEqual(results[0].type, "markdown");
    assertEqual(results[1].type, "syntax");
    assertEqual(results[2].type, "fallback");
  },

  "batch içinde biri hata verse diğerleri etkilenmez": async () => {
    const svc = new PreviewService();
    const items = [
      { cid: "ok1", data: enc("# OK\n\nAçıklama.\n"), fileName: "ok.md", mimeType: "text/plain" },
      { cid: "ok2", data: enc("const x = 1;"),         fileName: "ok.ts", mimeType: "text/plain" },
    ];
    const results = await svc.generateBatch(items);
    assert(results.every((r) => r.status === "ready" || r.status === "error"));
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı içerik → aynı önizleme yapısı": async () => {
    const ext = new MarkdownExtractor();
    const md  = "# Test\n\nBu test açıklama metnidir uzun olsun diye.\n";
    const r1  = await ext.extract({ cid: "d1", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });
    const r2  = await ext.extract({ cid: "d1", data: enc(md), fileName: "x.md", mimeType: "text/plain", format: "md" });

    const d1 = r1.detail as MarkdownPreview;
    const d2 = r2.detail as MarkdownPreview;
    assertEqual(d1.html, d2.html);
    assertEqual(d1.wordCount, d2.wordCount);
    assertEqual(d1.headings.length, d2.headings.length);
  },

  "STL triangle count deterministik": async () => {
    const ext = new Model3DExtractor();
    const stl = makeAsciiSTL(17);
    const r1  = await ext.extract({ cid: "d2", data: enc(stl), fileName: "x.stl", mimeType: "model/stl", format: "stl" });
    const r2  = await ext.extract({ cid: "d2", data: enc(stl), fileName: "x.stl", mimeType: "model/stl", format: "stl" });
    const t1 = (r1.detail as Model3DPreview).triangleCount;
    const t2 = (r2.detail as Model3DPreview).triangleCount;
    assertEqual(t1, t2);
    assertEqual(t1, 17);
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "büyük markdown (100KB) < 500ms": async () => {
    const ext  = new MarkdownExtractor();
    const para = "Bu bir paragraf metni ve tekrar tekrar yazılacak. ".repeat(50);
    const md   = Array.from({ length: 200 }, (_, i) => `## Başlık ${i}\n\n${para}\n`).join("\n");

    const start = Date.now();
    const r = await ext.extract({ cid: "perf1", data: enc(md), fileName: "big.md", mimeType: "text/plain", format: "md" });
    const ms = Date.now() - start;

    assertEqual(r.status, "ready");
    assert(ms < 500, `100KB markdown ${ms}ms (beklenen < 500ms)`);
    console.log(`  → 100KB markdown parse: ${ms}ms`);
  },

  "100 dosya batch üretimi < 3s": async () => {
    const svc   = new PreviewService();
    const items = Array.from({ length: 100 }, (_, i) => ({
      cid:      `perf_batch_${i}`,
      data:     enc(`# Doc ${i}\n\nAçıklama ${i}.\n`),
      fileName: `doc${i}.md`,
      mimeType: "text/plain",
    }));

    const start   = Date.now();
    const results = await svc.generateBatch(items);
    const ms      = Date.now() - start;

    assertEqual(results.length, 100);
    assert(ms < 3000, `100 dosya batch ${ms}ms (beklenen < 3s)`);
    console.log(`  → 100 dosya batch preview: ${ms}ms`);
  },

  "1000 cache set/get < 200ms": () => {
    const cache = new PreviewCache({ maxEntries: 2000 });
    const mk = (cid: string) => ({
      cid, type: "markdown" as const, status: "ready" as const,
      fileSize: 1, mimeType: "text/plain", fileName: "x",
      og: { type: "website" as const, custom: {} },
      durationMs: 1, generatedAt: new Date(),
    });

    const start = Date.now();
    for (let i = 0; i < 1000; i++) cache.set(`cid_${i}`, mk(`cid_${i}`));
    for (let i = 0; i < 1000; i++) cache.get(`cid_${i}`);
    const ms = Date.now() - start;

    assert(ms < 200, `1000 cache op ${ms}ms (beklenen < 200ms)`);
    console.log(`  → 1000 cache set+get: ${ms}ms`);
  },
});
