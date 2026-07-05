/**
 * 1XX1 OpenGraph Renderer
 * Aşama 17 — Web Preview Katmanı
 *
 * Sosyal medya OG kartı tarzında önizleme üretir.
 * Yalnızca "opengraph" tipi için değil, og metadata'sı olan
 * herhangi bir PreviewResult için fallback olarak da kullanılabilir
 * (HtmlRendererRegistry.resolve() bunu otomatik yapmaz; gerekirse
 * üst katman bilinçli olarak çağırabilir).
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class OpenGraphRenderer implements IPreviewRenderer {
  readonly name = "opengraph-renderer";
  readonly supports = ["opengraph"] as const;

  renderToHtml(preview: PreviewResult): string {
    const og    = preview.og;
    const title = escapeHtml(og.title ?? preview.fileName);
    const desc  = escapeHtml(og.description ?? "");
    const image = og.image
      ? `<img class="x1-og__image" src="${escapeHtml(og.image)}" alt="${title}" loading="lazy" />`
      : "";
    const site  = og.siteName
      ? `<span class="x1-og__site">${escapeHtml(og.siteName)}</span>`
      : "";

    const inner = `
      <a class="x1-og" href="${escapeHtml(og.url ?? "#")}" target="_blank" rel="noopener noreferrer">
        ${image}
        <div class="x1-og__body">
          ${site}
          <div class="x1-og__title">${title}</div>
          <div class="x1-og__desc">${desc}</div>
        </div>
      </a>
    `.trim();

    return wrapPreview(inner, "opengraph", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }
}
