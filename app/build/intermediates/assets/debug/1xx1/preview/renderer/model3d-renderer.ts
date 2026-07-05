/**
 * 1XX1 Model3D Renderer
 * Aşama 17 — Web Preview Katmanı
 *
 * Core'dan gelen Model3DPreview yalnızca metadata + placeholder SVG taşır.
 * Gerçek 3D döndürme/interaktif görüntüleme (Three.js OffscreenCanvas)
 * UI katmanında bu renderer'ın ürettiği <canvas data-x1-model="..."> placeholder'ı
 * progressive enhancement ile ele geçirir.
 *
 * renderToHtml() her zaman çalışır (placeholder + metadata).
 * Tarayıcıda render() çağrıldığında data-cid attribute'u ile
 * UI katmanı Three.js'i lazy-load edip gerçek 3D sahneyi monte edebilir.
 */

import type { PreviewResult } from "../core/preview-types.ts";
import type { Model3DPreview } from "../core/preview-types.ts";
import type { IPreviewRenderer } from "./renderer-types.ts";
import { wrapPreview, escapeHtml } from "./renderer-types.ts";

export class Model3DRenderer implements IPreviewRenderer {
  readonly name = "model3d-renderer";
  readonly supports = ["model_3d"] as const;

  renderToHtml(preview: PreviewResult): string {
    if (preview.status !== "ready" || !preview.detail) {
      return this._errorHtml(preview);
    }

    const detail = preview.detail as Model3DPreview;
    const meta   = this._renderMeta(detail);

    // data-x1-model: UI katmanı bu attribute'u görüp Three.js viewer monte edebilir
    const inner = `
      <div class="x1-model3d" data-x1-model="${escapeHtml(preview.cid)}" data-x1-format="${escapeHtml(detail.format)}">
        <img class="x1-model3d__placeholder" src="${escapeHtml(detail.thumbnail)}" alt="3D Model" />
        ${meta}
      </div>
    `.trim();

    return wrapPreview(inner, "model_3d", { title: preview.fileName });
  }

  render(preview: PreviewResult): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const container = document.createElement("div");
    container.innerHTML = this.renderToHtml(preview);
    return container.firstElementChild as HTMLElement;
  }

  private _renderMeta(detail: Model3DPreview): string {
    const badges: string[] = [
      `<span class="x1-badge x1-badge--lang">${escapeHtml(detail.format.toUpperCase())}</span>`,
    ];
    if (detail.triangleCount !== undefined) {
      badges.push(`<span class="x1-badge x1-badge--muted">${detail.triangleCount.toLocaleString()} üçgen</span>`);
    }
    if (detail.bounds) {
      const { x, y, z } = detail.bounds;
      badges.push(`<span class="x1-badge x1-badge--muted">${(x[1]-x[0]).toFixed(1)}×${(y[1]-y[0]).toFixed(1)}×${(z[1]-z[0]).toFixed(1)}</span>`);
    }
    return `<div class="x1-model3d__meta">${badges.join("")}</div>`;
  }

  private _errorHtml(preview: PreviewResult): string {
    return wrapPreview(
      `<div class="x1-preview__error">${escapeHtml(preview.error ?? "3D model render edilemedi")}</div>`,
      "model_3d"
    );
  }
}
