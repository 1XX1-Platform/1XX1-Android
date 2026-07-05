/**
 * 1XX1 Preview Renderer — Ortak Tipler ve Registry
 * Aşama 17 — Web Preview Katmanı
 *
 * MİMARİ KURAL:
 *   Renderer katmanı Browser/DOM bilir.
 *   Bu dosyalar `document`, `window`, `HTMLElement` kullanabilir
 *   ANCAK her renderer önce renderToHtml() (saf string) sunmak zorundadır.
 *   render() (DOM) yalnızca opsiyonel bir üst katmandır.
 *
 *   Renderer, Preview Core'u import eder (tek yönlü bağımlılık).
 *   Core asla Renderer'ı import etmez.
 *
 * Her IPreviewRenderer:
 *   renderToHtml(preview): string         → ZORUNLU, her ortamda çalışır
 *   render(preview): HTMLElement | null   → OPSİYONEL, yalnızca browser'da
 *
 * Bu ayrım sayesinde aynı renderer:
 *   - Node.js'te SSR (server-side render) için renderToHtml() kullanır
 *   - Tarayıcıda doğrudan DOM'a render() ile basılabilir
 *   - React/Vue/Svelte sarmalayıcıları renderToHtml() çıktısını
 *     dangerouslySetInnerHTML / v-html ile kullanabilir
 */

import type { PreviewResult, PreviewType } from "../core/preview-types.ts";

// ─── Renderer Arayüzü ─────────────────────────────────────────────────────────

export interface IPreviewRenderer {
  readonly name: string;
  /** Bu renderer hangi önizleme türlerini destekler? */
  readonly supports: PreviewType[];

  /**
   * Platform bağımsız HTML string üret.
   * Her ortamda çalışmak ZORUNDADIR (Node.js, Deno, tarayıcı, edge).
   */
  renderToHtml(preview: PreviewResult): string;

  /**
   * OPSİYONEL: Tarayıcıda gerçek DOM elemanı üret.
   * `document` yalnızca burada kullanılabilir.
   * Tarayıcı dışı ortamda çağrılırsa null döner.
   */
  render?(preview: PreviewResult): HTMLElement | null;
}

// ─── HTML Kaçış Yardımcısı (paylaşılan, platform bağımsız) ───────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Ortak Sarmalayıcı (her renderer için tutarlı dış kabuk) ─────────────────

export interface RenderWrapperOptions {
  className?: string;
  title?:     string;
}

export function wrapPreview(
  innerHtml: string,
  type:      PreviewType,
  opts:      RenderWrapperOptions = {}
): string {
  const cls = opts.className ? ` ${escapeHtml(opts.className)}` : "";
  const titleAttr = opts.title ? ` title="${escapeHtml(opts.title)}"` : "";
  return `<div class="x1-preview x1-preview--${type}${cls}"${titleAttr}>${innerHtml}</div>`;
}

// ─── HtmlRendererRegistry ─────────────────────────────────────────────────────

/**
 * Tüm renderer'ları tip bazında yönetir.
 * Plugin SDK (Aşama 19) geldiğinde yeni renderer'lar buraya kaydedilir.
 *
 * Öncelik sırası: sonradan kaydedilen renderer önceliklidir
 * (extractor seçim mantığıyla simetrik — bkz. PreviewService.registerExtractor).
 */
export class HtmlRendererRegistry {
  private readonly renderers: IPreviewRenderer[] = [];

  /** Yeni renderer kaydet — listenin başına eklenir (öncelikli) */
  register(renderer: IPreviewRenderer): void {
    this.renderers.unshift(renderer);
  }

  /** Bu önizleme türü için uygun renderer'ı bul */
  resolve(type: PreviewType): IPreviewRenderer | null {
    return this.renderers.find((r) => r.supports.includes(type)) ?? null;
  }

  /**
   * Platform bağımsız: her ortamda çalışır.
   * Uygun renderer yoksa varsayılan fallback HTML üretir.
   */
  renderToHtml(preview: PreviewResult): string {
    const renderer = this.resolve(preview.type);
    if (renderer) return renderer.renderToHtml(preview);
    return this._fallbackHtml(preview);
  }

  /**
   * OPSİYONEL: Tarayıcıda DOM elemanı üret.
   * Renderer `render()` sağlamıyorsa veya tarayıcı dışındaysak null döner.
   */
  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const renderer = this.resolve(preview.type);
    if (renderer?.render) return renderer.render(preview);

    // Fallback: renderToHtml çıktısını bir div'e bas
    const div = document.createElement("div");
    div.innerHTML = this.renderToHtml(preview);
    return div;
  }

  /** Kayıtlı renderer sayısı */
  count(): number { return this.renderers.length; }

  /** Desteklenen tüm türler */
  supportedTypes(): PreviewType[] {
    const set = new Set<PreviewType>();
    for (const r of this.renderers) for (const t of r.supports) set.add(t);
    return Array.from(set);
  }

  private _fallbackHtml(preview: PreviewResult): string {
    const title = escapeHtml(preview.og.title ?? preview.fileName);
    const desc  = escapeHtml(preview.og.description ?? "Önizleme mevcut değil");
    return wrapPreview(
      `<div class="x1-preview__fallback">
        <div class="x1-preview__title">${title}</div>
        <div class="x1-preview__desc">${desc}</div>
      </div>`,
      preview.type,
      { className: "x1-preview--fallback" }
    );
  }
}
