/**
 * 1XX1 Markdown Renderer
 * Aşama 17 — Web Preview Katmanı
 *
 * Preview Core'un ürettiği MarkdownPreview.html zaten HTML'dir
 * (core/extractors.ts içinde minimal parser tarafından üretildi).
 * Bu renderer onu sarmalar: TOC ekler, CSS sınıfı uygular.
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { MarkdownPreview } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class MarkdownRenderer implements IPreviewRenderer {
  readonly name = "markdown-renderer";
  readonly supports = ["markdown"] as const;

  renderToHtml(preview: PreviewResult): string {
    if (preview.status !== "ready" || !preview.detail) {
      return this._errorHtml(preview);
    }

    const detail = preview.detail as MarkdownPreview;
    const toc    = this._renderTOC(detail.headings);
    const badges = this._renderBadges(detail);

    const inner = `
      <div class="x1-markdown">
        ${toc}
        <div class="x1-markdown__body">${detail.html}</div>
        ${badges}
      </div>
    `.trim();

    return wrapPreview(inner, "markdown", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }

  private _renderTOC(headings: MarkdownPreview["headings"]): string {
    if (headings.length === 0) return "";
    const items = headings
      .map((h) => `<li class="x1-toc__item x1-toc__item--h${h.level}">
        <a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>
      </li>`)
      .join("");
    return `<nav class="x1-markdown__toc"><ul>${items}</ul></nav>`;
  }

  private _renderBadges(detail: MarkdownPreview): string {
    const badges: string[] = [];
    if (detail.hasCodeBlocks) badges.push(`<span class="x1-badge">Kod</span>`);
    if (detail.hasTables)     badges.push(`<span class="x1-badge">Tablo</span>`);
    badges.push(`<span class="x1-badge x1-badge--muted">${detail.wordCount} kelime</span>`);
    return `<div class="x1-markdown__badges">${badges.join("")}</div>`;
  }

  private _errorHtml(preview: PreviewResult): string {
    return wrapPreview(
      `<div class="x1-preview__error">${escapeHtml(preview.error ?? "Markdown render edilemedi")}</div>`,
      "markdown"
    );
  }
}
