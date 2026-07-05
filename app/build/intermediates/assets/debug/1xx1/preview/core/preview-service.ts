/**
 * 1XX1 Preview Service — Ana Orkestratör
 * Aşama 17 — Web Preview Engine
 *
 * Akış:
 *   generate(cid, data, fileName, mimeType)
 *     → cache.get(cid) varsa döndür
 *     → inferPreviewType() ile tür tespiti
 *     → uygun IPreviewExtractor seç
 *     → extract() çalıştır
 *     → cache.set(cid, result)
 *     → PreviewResult döndür
 *
 * Preview Engine SALT OKUNUR'dur (INVARIANTS.md kuralı).
 * Hiçbir zaman Repository'ye veya Storage'a yazmaz.
 * Yalnızca CID + binary veri alır, PreviewResult üretir.
 */

import type {
  IPreviewExtractor, PreviewResult, PreviewType, ExtractParams,
} from "./preview-types.ts";
import { inferPreviewType } from "./preview-types.ts";
import { PreviewCache } from "./preview-cache.ts";
import {
  MarkdownExtractor, SyntaxExtractor, OpenGraphExtractor,
  BinaryExtractor, ImageExtractor, Model3DExtractor,
} from "./extractors.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Preview Service Config ───────────────────────────────────────────────────

export interface PreviewServiceConfig {
  /** Maksimum işlenecek dosya boyutu (byte) */
  maxFileSizeBytes: number;
  /** Cache TTL (ms) */
  cacheTTLMs: number;
}

const DEFAULT_SERVICE_CONFIG: PreviewServiceConfig = {
  maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
  cacheTTLMs:        24 * 60 * 60_000, // 24 saat
};

// ─── PreviewService ───────────────────────────────────────────────────────────

export class PreviewService {
  private readonly cache: PreviewCache;
  private readonly extractors: IPreviewExtractor[];
  private readonly cfg: PreviewServiceConfig;

  private _generatedCount = 0;
  private _cacheHitCount  = 0;
  private _errorCount     = 0;

  constructor(
    extractors?: IPreviewExtractor[],
    cache?:      PreviewCache,
    cfg:         Partial<PreviewServiceConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg = { ...DEFAULT_SERVICE_CONFIG, ...cfg };
    this.cache = cache ?? new PreviewCache({ defaultTTLMs: this.cfg.cacheTTLMs });
    this.extractors = extractors ?? [
      new MarkdownExtractor(),
      new SyntaxExtractor(),
      new OpenGraphExtractor(),
      new Model3DExtractor(),
      new ImageExtractor(),
      new BinaryExtractor(),
    ];
  }

  // ─── Ana Üretim Metodu ────────────────────────────────────────────────────

  async generate(
    cid:      string,
    data:     Uint8Array,
    fileName: string,
    mimeType: string,
    opts:     { skipCache?: boolean; ttlMs?: number } = {}
  ): Promise<PreviewResult> {
    // 1. Cache kontrolü
    if (!opts.skipCache) {
      const cached = this.cache.get(cid);
      if (cached) {
        this._cacheHitCount++;
        this.logger?.debug(`Preview cache hit: ${cid.slice(0, 16)}...`);
        return cached;
      }
    }

    // 2. Boyut kontrolü
    if (data.byteLength > this.cfg.maxFileSizeBytes) {
      const result = this._oversizedResult(cid, fileName, mimeType, data.byteLength);
      this.cache.set(cid, result, opts.ttlMs);
      return result;
    }

    // 3. Format tespiti
    const ext  = fileName.split(".").pop()?.toLowerCase() ?? "";
    const type = inferPreviewType(mimeType, ext);

    // 4. Extractor seç
    const extractor = this._selectExtractor(mimeType, ext, type);

    const params: ExtractParams = { cid, data, fileName, mimeType, format: ext };

    // 5. Önizleme üret
    let result: PreviewResult;
    try {
      result = extractor
        ? await extractor.extract(params)
        : this._fallbackResult(params, type);

      this._generatedCount++;
    } catch (err) {
      this._errorCount++;
      result = this._errorResult(params, type, err instanceof Error ? err.message : "Bilinmeyen hata");
      this.logger?.warn(`Preview hatası: ${cid.slice(0, 16)}... — ${result.error}`);
    }

    // 6. Cache'e yaz
    this.cache.set(cid, result, opts.ttlMs);

    this.logger?.debug(
      `Preview üretildi: ${cid.slice(0, 16)}... (${type}, ${result.durationMs}ms)`
    );

    return result;
  }

  // ─── Toplu Üretim ────────────────────────────────────────────────────────

  /**
   * Birden fazla dosya için paralel önizleme üret.
   * Her dosya bağımsız hata yönetimine sahiptir — biri başarısız olsa diğerleri devam eder.
   */
  async generateBatch(
    items: Array<{ cid: string; data: Uint8Array; fileName: string; mimeType: string }>
  ): Promise<PreviewResult[]> {
    const results = await Promise.allSettled(
      items.map((item) => this.generate(item.cid, item.data, item.fileName, item.mimeType))
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return this._errorResult(
        { cid: items[i].cid, data: new Uint8Array(0), fileName: items[i].fileName, mimeType: items[i].mimeType, format: "" },
        "fallback",
        r.reason instanceof Error ? r.reason.message : "Toplu işlem hatası"
      );
    });
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  /** Cache'den oku (üretmeden) */
  getCached(cid: string): PreviewResult | null {
    return this.cache.get(cid);
  }

  /** Cache'i geçersiz kıl (asset güncellenince çağrılır) */
  invalidate(cid: string): boolean {
    return this.cache.invalidate(cid);
  }

  /** Yeni extractor ekle (Plugin SDK hazırlığı — Aşama 19) */
  registerExtractor(extractor: IPreviewExtractor): void {
    this.extractors.unshift(extractor); // öncelikli — listenin başına
    this.logger?.info(`Preview extractor kaydedildi: ${extractor.name}`);
  }

  stats() {
    return {
      generated:  this._generatedCount,
      cacheHits:  this._cacheHitCount,
      errors:     this._errorCount,
      cache:      this.cache.stats(),
      hitRate:    this._generatedCount + this._cacheHitCount > 0
        ? this._cacheHitCount / (this._generatedCount + this._cacheHitCount)
        : 0,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _selectExtractor(
    mimeType: string,
    ext:      string,
    type:     PreviewType
  ): IPreviewExtractor | null {
    // Önce tip eşleşmesine göre, sonra canExtract ile doğrula
    for (const extractor of this.extractors) {
      if (extractor.canExtract(mimeType, ext)) return extractor;
    }
    return null;
  }

  private _fallbackResult(params: ExtractParams, type: PreviewType): PreviewResult {
    return {
      cid:         params.cid,
      type:        "fallback",
      status:      "unsupported",
      fileSize:    params.data.byteLength,
      mimeType:    params.mimeType,
      fileName:    params.fileName,
      og: {
        title:       params.fileName,
        description: `${params.format.toUpperCase() || "Bilinmeyen"} dosyası — önizleme desteklenmiyor`,
        type:        "website",
        custom:      {},
      },
      durationMs:  0,
      generatedAt: new Date(),
    };
  }

  private _errorResult(params: ExtractParams, type: PreviewType, error: string): PreviewResult {
    return {
      cid:         params.cid,
      type,
      status:      "error",
      fileSize:    params.data.byteLength,
      mimeType:    params.mimeType,
      fileName:    params.fileName,
      og: {
        title:       params.fileName,
        description: "Önizleme oluşturulamadı",
        type:        "website",
        custom:      {},
      },
      durationMs:  0,
      generatedAt: new Date(),
      error,
    };
  }

  private _oversizedResult(
    cid: string, fileName: string, mimeType: string, size: number
  ): PreviewResult {
    return {
      cid, type: "fallback", status: "unsupported",
      fileSize: size, mimeType, fileName,
      og: {
        title:       fileName,
        description: `Dosya çok büyük (${(size / 1024 / 1024).toFixed(1)} MB) — önizleme oluşturulmadı`,
        type:        "website",
        custom:      {},
      },
      durationMs:  0,
      generatedAt: new Date(),
    };
  }
}
