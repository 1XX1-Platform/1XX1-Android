/**
 * 1XX1 Syntax Renderer
 * Aşama 17 — Web Preview Katmanı
 *
 * Core'un SyntaxExtractor'ı zaten HTML escape edilmiş kod üretti.
 * Bu renderer satır numarası ve dil etiketi ekler.
 * Gerçek syntax highlight (Shiki) UI entegrasyonunda eklenir —
 * bu renderer onun sonucunu da kabul edecek şekilde tasarlandı.
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { SyntaxHighlightResult } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class SyntaxRenderer implements IPreviewRenderer {
  readonly name = "syntax-renderer";
  readonly supports = ["syntax"] as const;

  renderToHtml(preview: PreviewResult): string {
    if (preview.status !== "ready" || !preview.detail) {
      return this._errorHtml(preview);
    }

    const detail = preview.detail as SyntaxHighlightResult;
    const header = this._renderHeader(preview.fileName, detail);
    const numbered = this._addLineNumbers(detail.html, detail.previewLines);
    const footer = detail.lineCount > detail.previewLines
      ? `<div class="x1-syntax__more">+ ${detail.lineCount - detail.previewLines} satır daha</div>`
      : "";

    const inner = `
      <div class="x1-syntax">
        ${header}
        ${numbered}
        ${footer}
      </div>
    `.trim();

    return wrapPreview(inner, "syntax", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }

  private _renderHeader(fileName: string, detail: SyntaxHighlightResult): string {
    return `<div class="x1-syntax__header">
      <span class="x1-syntax__filename">${escapeHtml(fileName)}</span>
      <span class="x1-badge x1-badge--lang">${escapeHtml(detail.language)}</span>
      <span class="x1-badge x1-badge--muted">${detail.lineCount} satır</span>
    </div>`;
  }

  /** detail.html zaten <pre><code>...</code></pre> formatında — satır numarası sarmalayıcısı ekle */
  private _addLineNumbers(html: string, lineCount: number): string {
    const numbers = Array.from({ length: lineCount }, (_, i) => i + 1)
      .map((n) => `<span class="x1-syntax__lineno">${n}</span>`)
      .join("\n");
    return `<div class="x1-syntax__code-wrap">
      <div class="x1-syntax__linenos">${numbers}</div>
      ${html}
    </div>`;
  }

  private _errorHtml(preview: PreviewResult): string {
    return wrapPreview(
      `<div class="x1-preview__error">${escapeHtml(preview.error ?? "Kod render edilemedi")}</div>`,
      "syntax"
    );
  }
}
