/**
 * 1XX1 Preview Renderer — Dışa Aktarma
 * Aşama 17 — Web Preview Katmanı (Browser/DOM Bilen Katman)
 *
 * MİMARİ KURAL (INVARIANTS.md):
 *   Bu katman Browser/DOM bilir (document, window, HTMLElement).
 *   Preview Core'u import EDER (tek yönlü bağımlılık).
 *   Core ASLA bu dosyayı import edemez.
 *
 * Birincil kullanım:
 *   import { renderToHtml } from "1xx1/preview/renderer";
 *   const html = renderToHtml(previewResult); // her ortamda çalışır
 *
 * Opsiyonel DOM kullanımı (yalnızca tarayıcıda):
 *   import { render } from "1xx1/preview/renderer";
 *   const el = render(previewResult); // HTMLElement | null
 */
export * from "./renderer-types.ts";
export * from "./html-renderer.ts";
export * from "./markdown-renderer.ts";
export * from "./syntax-renderer.ts";
export * from "./image-renderer.ts";
export * from "./model3d-renderer.ts";
export * from "./binary-renderer.ts";
export * from "./opengraph-renderer.ts";
