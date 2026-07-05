/**
 * 1XX1 HTML Renderer — Üst Düzey Cephe (Facade)
 * Aşama 17 — Web Preview Katmanı
 *
 * Bu dosya, tüm tip-bazlı renderer'ları (Markdown, Syntax, Image, Model3D,
 * Binary, OpenGraph) varsayılan bir HtmlRendererRegistry içinde toplar
 * ve platform bağımsız iki temel fonksiyon sunar:
 *
 *   renderToHtml(preview): string          → her ortamda çalışır (SSR dahil)
 *   render(preview): HTMLElement | null     → yalnızca tarayıcıda
 *
 * Bu, modülün dışa açılan ana kapısıdır — diğer dosyalar (markdown-renderer.ts,
 * syntax-renderer.ts, vb.) doğrudan değil, genellikle bu dosya üzerinden kullanılır.
 *
 * İsimlendirme notu: önceki "preview-dom-render.ts" ismi DOM'a bağımlıymış
 * izlenimi veriyordu. "html-renderer.ts" ismi daha doğru çünkü birincil
 * sözleşme HTML STRING üretmektir; DOM yalnızca opsiyonel bir kolaylıktır.
 */

import type { PreviewResult, PreviewType } from "../core/preview-types.ts";
import { HtmlRendererRegistry } from "./renderer-types.ts";
import { MarkdownRenderer }   from "./markdown-renderer.ts";
import { SyntaxRenderer }     from "./syntax-renderer.ts";
import { ImageRenderer }      from "./image-renderer.ts";
import { Model3DRenderer }    from "./model3d-renderer.ts";
import { BinaryRenderer }     from "./binary-renderer.ts";
import { OpenGraphRenderer }  from "./opengraph-renderer.ts";

// ─── Varsayılan Registry ──────────────────────────────────────────────────────

/**
 * Önceden yapılandırılmış registry — tüm 6 yerleşik renderer kayıtlı.
 * Plugin SDK (Aşama 19) geldiğinde `defaultRegistry.register(yeniRenderer)`
 * ile genişletilebilir; mevcut hiçbir kod değişmez.
 */
export function createDefaultRegistry(): HtmlRendererRegistry {
  const registry = new HtmlRendererRegistry();
  // Kayıt sırası önemli değil — her renderer kendi `supports` türünü bildirir.
  registry.register(new MarkdownRenderer());
  registry.register(new SyntaxRenderer());
  registry.register(new ImageRenderer());
  registry.register(new Model3DRenderer());
  registry.register(new BinaryRenderer());
  registry.register(new OpenGraphRenderer());
  return registry;
}

/** Modül seviyesinde paylaşılan varsayılan registry — çoğu kullanım için yeterli */
export const defaultRegistry = createDefaultRegistry();

// ─── Üst Düzey API ────────────────────────────────────────────────────────────

/**
 * Platform bağımsız: Node.js, Deno, edge, tarayıcı — her yerde çalışır.
 * SSR (server-side render) için birincil API.
 */
export function renderToHtml(
  preview:  PreviewResult,
  registry: HtmlRendererRegistry = defaultRegistry
): string {
  return registry.renderToHtml(preview);
}

/**
 * OPSİYONEL: yalnızca tarayıcıda gerçek DOM elemanı üretir.
 * `document` tanımsızsa (Node.js/SSR) null döner — güvenli.
 */
export function render(
  preview:  PreviewResult,
  registry: HtmlRendererRegistry = defaultRegistry
): HTMLElement | null {
  return registry.render(preview);
}

/** Hangi türler bu registry ile render edilebiliyor? */
export function supportedPreviewTypes(
  registry: HtmlRendererRegistry = defaultRegistry
): PreviewType[] {
  return registry.supportedTypes();
}
