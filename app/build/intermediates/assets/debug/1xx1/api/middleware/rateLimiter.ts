/**
 * 1XX1 Rate Limiter — Token Bucket
 * Aşama 06 — Middleware
 *
 * Token bucket algoritması:
 *   capacity:    100 token (maksimum birikebilecek)
 *   refillRate:  100 token / dakika (1.667 token/saniye)
 *   burstLimit:  10  (tek seferde harcanan maksimum)
 *
 * Her IP adresi bağımsız bir bucket'a sahiptir.
 * Bellek tasarrufu: 10 dakika boyunca isteğe katılmayan bucket'lar temizlenir.
 */

import { SystemError, ErrorCode } from "../../core/errors.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Bucket ──────────────────────────────────────────────────────────────────

interface Bucket {
  tokens:    number;
  lastRefill: number; // ms timestamp
  requestCount: number;
}

// ─── RateLimiter Config ───────────────────────────────────────────────────────

export interface RateLimiterConfig {
  /** Dakika başına maksimum istek */
  requestsPerMinute: number;
  /** Tek seferde harcanabilecek maksimum token */
  burstLimit: number;
  /** Aktif olmayan bucket'ları temizleme süresi (ms) */
  cleanupIntervalMs: number;
  /** Bucket yaşam süresi (ms) — bu kadar sessizse silinir */
  bucketTtlMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  requestsPerMinute: 100,
  burstLimit:        10,
  cleanupIntervalMs: 60_000,
  bucketTtlMs:       10 * 60_000, // 10 dakika
};

// ─── RateLimiter ─────────────────────────────────────────────────────────────

export class RateLimiter {
  private readonly buckets   = new Map<string, Bucket>();
  private readonly cfg:        RateLimiterConfig;
  private readonly tokenPerMs: number;
  private _cleanupHandle?: ReturnType<typeof setInterval>;
  private _totalBlocked = 0;
  private _totalAllowed = 0;

  constructor(
    cfg: Partial<RateLimiterConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg        = { ...DEFAULT_CONFIG, ...cfg };
    this.tokenPerMs = this.cfg.requestsPerMinute / 60_000;
    this._startCleanup();
  }

  /**
   * İsteği değerlendir.
   * İzin verildiyse true döner.
   * Reddedildiyse SystemError fırlatır.
   *
   * @param key  IP adresi veya API key
   * @param cost Harcanan token miktarı (streaming için daha yüksek)
   */
  check(key: string, cost = 1): void {
    const bucket = this._getBucket(key);
    this._refill(bucket);

    if (cost > this.cfg.burstLimit) {
      cost = this.cfg.burstLimit; // burst sınırını aşamazsın
    }

    if (bucket.tokens < cost) {
      this._totalBlocked++;
      const retryAfterMs = Math.ceil((cost - bucket.tokens) / this.tokenPerMs);
      this.logger?.warn(`Rate limit: ${key} (remaining: ${bucket.tokens.toFixed(1)})`, {
        key,
        remaining: bucket.tokens,
        retryAfterMs,
      });

      throw new SystemError({
        code:    ErrorCode.RATE_LIMITED,
        message: `Rate limit aşıldı. ${Math.ceil(retryAfterMs / 1000)} saniye bekleyin.`,
        severity: "low",
        context: { key, remaining: bucket.tokens, retryAfterMs },
      });
    }

    bucket.tokens -= cost;
    bucket.requestCount++;
    this._totalAllowed++;
  }

  /** Kaç token kaldığını sorgula (check etmeden) */
  remaining(key: string): number {
    const bucket = this._getBucket(key);
    this._refill(bucket);
    return Math.floor(bucket.tokens);
  }

  /** İstatistikler */
  stats(): {
    activeBuckets: number;
    totalAllowed:  number;
    totalBlocked:  number;
    blockRate:     number;
  } {
    const total = this._totalAllowed + this._totalBlocked;
    return {
      activeBuckets: this.buckets.size,
      totalAllowed:  this._totalAllowed,
      totalBlocked:  this._totalBlocked,
      blockRate:     total > 0 ? this._totalBlocked / total : 0,
    };
  }

  stop(): void {
    if (this._cleanupHandle) {
      clearInterval(this._cleanupHandle);
      this._cleanupHandle = undefined;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _getBucket(key: string): Bucket {
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        tokens:       this.cfg.requestsPerMinute, // tam dolu başlar
        lastRefill:   Date.now(),
        requestCount: 0,
      });
    }
    return this.buckets.get(key)!;
  }

  private _refill(bucket: Bucket): void {
    const now     = Date.now();
    const elapsed = now - bucket.lastRefill;
    const added   = elapsed * this.tokenPerMs;

    bucket.tokens    = Math.min(bucket.tokens + added, this.cfg.requestsPerMinute);
    bucket.lastRefill = now;
  }

  private _startCleanup(): void {
    this._cleanupHandle = setInterval(() => {
      const now     = Date.now();
      const cutoff  = now - this.cfg.bucketTtlMs;
      let cleaned   = 0;

      for (const [key, bucket] of this.buckets) {
        if (bucket.lastRefill < cutoff) {
          this.buckets.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.logger?.debug(`RateLimiter: ${cleaned} stale bucket temizlendi`);
      }
    }, this.cfg.cleanupIntervalMs);
  }
}

/** HTTP isteğinden IP adresini çıkar */
export function extractKey(headers: Record<string, string | undefined>): string {
  return (
    headers["x-forwarded-for"]?.split(",")[0].trim() ??
    headers["x-real-ip"] ??
    "unknown"
  );
}

export const rateLimiter = new RateLimiter();
