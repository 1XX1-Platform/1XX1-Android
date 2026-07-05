/**
 * 1XX1 Image Renderer
 * Aşama 17 — Web Preview Katmanı
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class ImageRenderer implements IPreviewRenderer {
  readonly name = "image-renderer";
  readonly supports = ["image"] as const;

  renderToHtml(preview: PreviewResult): string {
    if (preview.status !== "ready" || !preview.detail) {
      return this._errorHtml(preview);
    }

    const detail = preview.detail as { thumbnailDataUri: string };
    const alt    = escapeHtml(preview.og.title ?? preview.fileName);

    const inner = `
      <figure class="x1-image">
        <img class="x1-image__thumb" src="${escapeHtml(detail.thumbnailDataUri)}" alt="${alt}" loading="lazy" />
        <figcaption class="x1-image__caption">${escapeHtml(preview.fileName)}</figcaption>
      </figure>
    `.trim();

    return wrapPreview(inner, "image", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }

  private _errorHtml(preview: PreviewResult): string {
    return wrapPreview(
      `<div class="x1-preview__error">${escapeHtml(preview.error ?? "Görsel render edilemedi")}</div>`,
      "image"
    );
  }
}
