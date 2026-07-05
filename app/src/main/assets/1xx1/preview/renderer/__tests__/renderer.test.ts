/**
 * 1XX1 Preview Renderer Testleri
 * Aşama 17 — Web Preview Katmanı
 *
 * Gruplar:
 *   renderer-types     — escapeHtml, wrapPreview, registry temel davranış
 *   markdown-renderer  — TOC, badge, hata durumu
 *   syntax-renderer    — satır numarası, dil etiketi
 *   image-renderer     — figure/img üretimi
 *   model3d-renderer   — data-x1-model attribute, metadata badge
 *   binary-renderer    — hex dump sarmalama
 *   opengraph-renderer — kart üretimi, eksik alan toleransı
 *   html-renderer       — defaultRegistry, fallback, SSR güvenliği
 *   platform-bağımsızlık — document tanımsızken çökmemeli
 *   determinism         — aynı PreviewResult → aynı HTML
 */

import {
  runSuite, assert, assertEqual
} from "../../../core/test-utils.ts";
import {
  escapeHtml, wrapPreview, HtmlRendererRegistry,
} from "../renderer-types.ts";
import { MarkdownRenderer }  from "../markdown-renderer.ts";
import { SyntaxRenderer }    from "../syntax-renderer.ts";
import { ImageRenderer }     from "../image-renderer.ts";
import { Model3DRenderer }   from "../model3d-renderer.ts";
import { BinaryRenderer }    from "../binary-renderer.ts";
import { OpenGraphRenderer } from "../opengraph-renderer.ts";
import {
  createDefaultRegistry, defaultRegistry, renderToHtml, render, supportedPreviewTypes,
} from "../html-renderer.ts";
import type { PreviewResult } from "../../core/preview-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function makeMarkdownPreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    cid: "cid_md", type: "markdown", status: "ready",
    fileSize: 100, mimeType: "text/plain", fileName: "README.md",
    og: { title: "Test Başlık", description: "Açıklama", type: "website", custom: {} },
    detail: {
      html: "<h1>Başlık</h1><p>Metin</p>",
      excerpt: "Metin",
      headings: [{ level: 1, text: "Başlık", id: "baslik" }],
      wordCount: 10,
      hasCodeBlocks: false,
      hasTables: false,
    },
    durationMs: 1, generatedAt: new Date(),
    ...overrides,
  };
}

function makeSyntaxPreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    cid: "cid_syn", type: "syntax", status: "ready",
    fileSize: 50, mimeType: "text/plain", fileName: "app.ts",
    og: { title: "app.ts", description: "typescript — 3 satır", type: "website", custom: {} },
    detail: {
      html: "<pre><code>const x = 1;</code></pre>",
      language: "typescript",
      lineCount: 3,
      previewLines: 50,
    },
    durationMs: 1, generatedAt: new Date(),
    ...overrides,
  };
}

function makeImagePreview(): PreviewResult {
  return {
    cid: "cid_img", type: "image", status: "ready",
    fileSize: 200, mimeType: "image/png", fileName: "icon.png",
    og: { title: "icon.png", description: "PNG görsel", type: "website", custom: {} },
    detail: { thumbnailDataUri: "data:image/png;base64,AAAA" },
    durationMs: 1, generatedAt: new Date(),
  };
}

function makeModel3DPreview(): PreviewResult {
  return {
    cid: "cid_3d", type: "model_3d", status: "ready",
    fileSize: 1000, mimeType: "model/stl", fileName: "part.stl",
    og: { title: "part.stl", description: "3D Model — STL (42 üçgen)", type: "website", custom: {} },
    detail: {
      thumbnail: "data:image/svg+xml;base64,AAAA",
      format: "stl",
      triangleCount: 42,
    },
    durationMs: 1, generatedAt: new Date(),
  };
}

function makeBinaryPreview(): PreviewResult {
  return {
    cid: "cid_bin", type: "binary", status: "ready",
    fileSize: 4096, mimeType: "application/wasm", fileName: "mod.wasm",
    og: { title: "mod.wasm", description: "Binary", type: "website", custom: {} },
    detail: { hexDump: "00000000  00 61 73 6d", encoding: "WebAssembly" },
    durationMs: 1, generatedAt: new Date(),
  };
}

function makeOGPreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    cid: "cid_og", type: "opengraph", status: "ready",
    fileSize: 300, mimeType: "text/html", fileName: "index.html",
    og: { title: "Site Başlığı", description: "Site açıklaması", image: "https://x.com/i.png", siteName: "1XX1", type: "website", url: "https://x.com", custom: {} },
    durationMs: 1, generatedAt: new Date(),
    ...overrides,
  };
}

// ─── renderer-types ───────────────────────────────────────────────────────────

await runSuite("renderer-types", {
  "escapeHtml: temel kaçışlar": () => {
    const out = escapeHtml(`<script>alert("x")</script> & 'tek'`);
    assert(out.includes("&lt;script&gt;"));
    assert(out.includes("&amp;"));
    assert(out.includes("&quot;"));
    assert(out.includes("&#39;"));
    assert(!out.includes("<script>"), "Ham script tag kalmamalı");
  },

  "wrapPreview: tip sınıfı ve içerik": () => {
    const html = wrapPreview("<p>içerik</p>", "markdown");
    assert(html.includes("x1-preview"));
    assert(html.includes("x1-preview--markdown"));
    assert(html.includes("<p>içerik</p>"));
  },

  "wrapPreview: opsiyonel className ve title": () => {
    const html = wrapPreview("<p>x</p>", "image", { className: "custom", title: "Başlık" });
    assert(html.includes("custom"));
    assert(html.includes('title="Başlık"'));
  },

  "registry: register + resolve": () => {
    const reg = new HtmlRendererRegistry();
    reg.register(new MarkdownRenderer());
    const found = reg.resolve("markdown");
    assert(found !== null);
    assertEqual(found!.name, "markdown-renderer");
  },

  "registry: bilinmeyen tip → null": () => {
    const reg = new HtmlRendererRegistry();
    reg.register(new MarkdownRenderer());
    assertEqual(reg.resolve("pdf"), null);
  },

  "registry: sonradan kaydedilen öncelikli": () => {
    const reg = new HtmlRendererRegistry();
    const custom = {
      name: "custom-md",
      supports: ["markdown"] as const,
      renderToHtml: () => "<div>custom</div>",
    };
    reg.register(new MarkdownRenderer());
    reg.register(custom);
    const html = reg.renderToHtml(makeMarkdownPreview());
    assert(html.includes("custom"), "Son kaydedilen öncelikli olmalı");
  },

  "registry: fallback HTML üretir": () => {
    const reg = new HtmlRendererRegistry();
    const result = makeMarkdownPreview({ type: "pdf" as any }); // hiç renderer yok
    const html = reg.renderToHtml(result);
    assert(html.includes("x1-preview__fallback"));
  },

  "registry: count ve supportedTypes": () => {
    const reg = createDefaultRegistry();
    assertEqual(reg.count(), 6);
    const types = reg.supportedTypes();
    assert(types.includes("markdown"));
    assert(types.includes("model_3d"));
  },
});

// ─── MarkdownRenderer ─────────────────────────────────────────────────────────

await runSuite("markdown-renderer", {
  "TOC üretimi": () => {
    const r = new MarkdownRenderer();
    const html = r.renderToHtml(makeMarkdownPreview());
    assert(html.includes("x1-markdown__toc"));
    assert(html.includes("#baslik"));
    assert(html.includes("Başlık"));
  },

  "badge: kod ve tablo": () => {
    const r = new MarkdownRenderer();
    const preview = makeMarkdownPreview({
      detail: {
        html: "<p>x</p>", excerpt: "x", headings: [],
        wordCount: 1, hasCodeBlocks: true, hasTables: true,
      },
    });
    const html = r.renderToHtml(preview);
    assert(html.includes("Kod"));
    assert(html.includes("Tablo"));
  },

  "boş heading → TOC render edilmez": () => {
    const r = new MarkdownRenderer();
    const preview = makeMarkdownPreview({
      detail: { html: "<p>x</p>", excerpt: "x", headings: [], wordCount: 1, hasCodeBlocks: false, hasTables: false },
    });
    const html = r.renderToHtml(preview);
    assert(!html.includes("x1-markdown__toc"));
  },

  "hata durumu": () => {
    const r = new MarkdownRenderer();
    const preview = makeMarkdownPreview({ status: "error", detail: undefined, error: "Parse hatası" });
    const html = r.renderToHtml(preview);
    assert(html.includes("x1-preview__error"));
    assert(html.includes("Parse hatası"));
  },

  "supports yalnızca markdown": () => {
    const r = new MarkdownRenderer();
    assertEqual(r.supports.length, 1);
    assertEqual(r.supports[0], "markdown");
  },
});

// ─── SyntaxRenderer ───────────────────────────────────────────────────────────

await runSuite("syntax-renderer", {
  "dil etiketi ve dosya adı": () => {
    const r = new SyntaxRenderer();
    const html = r.renderToHtml(makeSyntaxPreview());
    assert(html.includes("typescript"));
    assert(html.includes("app.ts"));
  },

  "satır numarası üretimi": () => {
    const r = new SyntaxRenderer();
    const html = r.renderToHtml(makeSyntaxPreview());
    assert(html.includes("x1-syntax__linenos"));
    assert(html.includes(">1<") || html.includes(">1</span>"));
  },

  "kırpılmış satır uyarısı": () => {
    const r = new SyntaxRenderer();
    const preview = makeSyntaxPreview({
      detail: { html: "<pre><code>x</code></pre>", language: "js", lineCount: 100, previewLines: 50 },
    });
    const html = r.renderToHtml(preview);
    assert(html.includes("50 satır daha"));
  },

  "hata durumu": () => {
    const r = new SyntaxRenderer();
    const preview = makeSyntaxPreview({ status: "error", detail: undefined, error: "Decode hatası" });
    const html = r.renderToHtml(preview);
    assert(html.includes("x1-preview__error"));
  },
});

// ─── ImageRenderer ────────────────────────────────────────────────────────────

await runSuite("image-renderer", {
  "figure + img üretimi": () => {
    const r = new ImageRenderer();
    const html = r.renderToHtml(makeImagePreview());
    assert(html.includes("<figure"));
    assert(html.includes("<img"));
    assert(html.includes("data:image/png;base64,AAAA"));
    assert(html.includes("icon.png"));
  },

  "alt attribute XSS güvenli": () => {
    const r = new ImageRenderer();
    const preview = makeImagePreview();
    preview.og.title = `<script>alert(1)</script>`;
    const html = r.renderToHtml(preview);
    assert(!html.includes("<script>alert"), "Alt metin escape edilmeli");
  },
});

// ─── Model3DRenderer ──────────────────────────────────────────────────────────

await runSuite("model3d-renderer", {
  "data-x1-model attribute": () => {
    const r = new Model3DRenderer();
    const html = r.renderToHtml(makeModel3DPreview());
    assert(html.includes('data-x1-model="cid_3d"'));
    assert(html.includes('data-x1-format="stl"'));
  },

  "triangle count badge": () => {
    const r = new Model3DRenderer();
    const html = r.renderToHtml(makeModel3DPreview());
    assert(html.includes("42"));
    assert(html.includes("üçgen"));
  },

  "format badge büyük harf": () => {
    const r = new Model3DRenderer();
    const html = r.renderToHtml(makeModel3DPreview());
    assert(html.includes("STL"));
  },
});

// ─── BinaryRenderer ───────────────────────────────────────────────────────────

await runSuite("binary-renderer", {
  "hex dump ve encoding": () => {
    const r = new BinaryRenderer();
    const html = r.renderToHtml(makeBinaryPreview());
    assert(html.includes("WebAssembly"));
    assert(html.includes("00 61 73 6d"));
  },

  "dosya boyutu KB formatı": () => {
    const r = new BinaryRenderer();
    const html = r.renderToHtml(makeBinaryPreview());
    assert(html.includes("4.0 KB") || html.includes("KB"));
  },
});

// ─── OpenGraphRenderer ────────────────────────────────────────────────────────

await runSuite("opengraph-renderer", {
  "kart üretimi": () => {
    const r = new OpenGraphRenderer();
    const html = r.renderToHtml(makeOGPreview());
    assert(html.includes("Site Başlığı"));
    assert(html.includes("Site açıklaması"));
    assert(html.includes("https://x.com/i.png"));
    assert(html.includes("1XX1"));
  },

  "eksik image/site alanları toleranslı": () => {
    const r = new OpenGraphRenderer();
    const preview = makeOGPreview({
      og: { title: "Sade Başlık", description: "Açıklama", type: "website", custom: {} },
    });
    const html = r.renderToHtml(preview);
    assert(html.includes("Sade Başlık"));
    assert(!html.includes("undefined"));
  },

  "href fallback #": () => {
    const r = new OpenGraphRenderer();
    const preview = makeOGPreview({
      og: { title: "X", description: "Y", type: "website", custom: {} },
    });
    const html = r.renderToHtml(preview);
    assert(html.includes('href="#"'));
  },
});

// ─── html-renderer (üst düzey API) ────────────────────────────────────────────

await runSuite("html-renderer", {
  "defaultRegistry 6 renderer içerir": () => {
    assertEqual(defaultRegistry.count(), 6);
  },

  "renderToHtml: markdown": () => {
    const html = renderToHtml(makeMarkdownPreview());
    assert(html.includes("x1-markdown"));
  },

  "renderToHtml: syntax": () => {
    const html = renderToHtml(makeSyntaxPreview());
    assert(html.includes("x1-syntax"));
  },

  "renderToHtml: model_3d": () => {
    const html = renderToHtml(makeModel3DPreview());
    assert(html.includes("x1-model3d"));
  },

  "renderToHtml: özel registry kullanılabilir": () => {
    const custom = createDefaultRegistry();
    const html = renderToHtml(makeImagePreview(), custom);
    assert(html.includes("x1-image"));
  },

  "supportedPreviewTypes: 6 tip listelenir": () => {
    const types = supportedPreviewTypes();
    assertEqual(new Set(types).size, 6);
    assert(types.includes("opengraph"));
    assert(types.includes("binary"));
  },

  "render: document yokken null döner (SSR güvenli)": () => {
    // Bu test ortamında `document` global olarak tanımsız (Node.js)
    const el = render(makeMarkdownPreview());
    assertEqual(el, null, "Node.js ortamında render() null dönmeli");
  },
});

// ─── Platform Bağımsızlık ─────────────────────────────────────────────────────

await runSuite("platform-bağımsızlık", {
  "renderToHtml document olmadan çalışır": () => {
    // document tanımsız olsa bile renderToHtml asla erişmemeli
    assert(typeof document === "undefined", "Test ortamı document içermemeli (varsayım kontrolü)");
    const html = renderToHtml(makeMarkdownPreview());
    assert(html.length > 0, "HTML üretimi document olmadan başarılı olmalı");
  },

  "tüm renderer'lar renderToHtml zorunluluğunu karşılar": () => {
    const renderers = [
      new MarkdownRenderer(), new SyntaxRenderer(), new ImageRenderer(),
      new Model3DRenderer(), new BinaryRenderer(), new OpenGraphRenderer(),
    ];
    for (const r of renderers) {
      assert(typeof r.renderToHtml === "function", `${r.name} renderToHtml sağlamalı`);
    }
  },

  "render() opsiyoneldir ve document yokken null döner": () => {
    const renderers = [
      new MarkdownRenderer(), new SyntaxRenderer(), new ImageRenderer(),
      new Model3DRenderer(), new BinaryRenderer(), new OpenGraphRenderer(),
    ];
    for (const r of renderers) {
      if (r.render) {
        const result = r.render(makeMarkdownPreview());
        assertEqual(result, null, `${r.name}.render() document yokken null dönmeli`);
      }
    }
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı PreviewResult → aynı HTML (2 kez)": () => {
    const preview = makeMarkdownPreview();
    const h1 = renderToHtml(preview);
    const h2 = renderToHtml(preview);
    assertEqual(h1, h2);
  },

  "farklı CID → farklı data attribute": () => {
    const r1 = renderToHtml(makeModel3DPreview());
    const r2 = renderToHtml({ ...makeModel3DPreview(), cid: "farkli_cid" });
    assert(r1 !== r2, "Farklı CID farklı HTML üretmeli");
  },
});
