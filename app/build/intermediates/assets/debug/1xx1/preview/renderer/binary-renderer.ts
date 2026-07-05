/**
 * 1XX1 Binary Renderer
 * Aşama 17 — Web Preview Katmanı
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class BinaryRenderer implements IPreviewRenderer {
  readonly name = "binary-renderer";
  readonly supports = ["binary"] as const;

  renderToHtml(preview: PreviewResult): string {
    if (preview.status !== "ready" || !preview.detail) {
      return this._errorHtml(preview);
    }

    const detail = preview.detail as { hexDump: string; encoding: string };
    const sizeKb = (preview.fileSize / 1024).toFixed(1);

    const inner = `
      <div class="x1-binary">
        <div class="x1-binary__header">
          <span class="x1-badge x1-badge--lang">${escapeHtml(detail.encoding)}</span>
          <span class="x1-badge x1-badge--muted">${sizeKb} KB</span>
        </div>
        <pre class="x1-binary__hexdump">${escapeHtml(detail.hexDump)}</pre>
      </div>
    `.trim();

    return wrapPreview(inner, "binary", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }

  private _errorHtml(preview: PreviewResult): string {
    return wrapPreview(
      `<div class="x1-preview__error">${escapeHtml(preview.error ?? "Binary render edilemedi")}</div>`,
      "binary"
    );
  }
}
