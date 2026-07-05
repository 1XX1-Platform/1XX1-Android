/**
 * 1XX1 Ghost Cube — Route Cache
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Mimari konum:
 *   GhostRouter → RouteCache → PathOptimizer → SpatialTopology
 *
 * Neden gerekli?
 *   Her paket için A→B rotasını sıfırdan hesaplamak:
 *     interpolateCoordinates() + fillChain() + PathOptimizer.score() = pahalı
 *   Aynı (src, dst) çifti sık tekrarlanır (büyük transfer → çok paket).
 *   Cache ile hesaplama tek seferlik, sonraki paketler anında.
 *
 * Geçersizleştirme (invalidation):
 *   - TTL: her route girişi en fazla ROUTE_CACHE_TTL_MS kadar yaşar
 *   - Topoloji değişimi: SpatialTopology'den gelen peer ekle/çıkar sinyali
 *   - Confidence eşiği: confidenceScore belirli eşiğin altına düşerse sil
 *   - Kapasite: LRU ile MAX_ENTRIES aşılınca en eski silinir
 *
 * Thread safety: JavaScript single-threaded → lock gerekmez.
 */

import type { GhostRoute } from "./ghost-types.ts";

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** Bir route kaydının maksimum yaşı (5 dakika) */
export const ROUTE_CACHE_TTL_MS    = 5 * 60 * 1000;
/** Maksimum önbelleklenen route sayısı */
export const ROUTE_CACHE_MAX       = 1_000;
/** Bu confidence altındaki route'lar cache'e alınmaz */
export const ROUTE_CACHE_MIN_CONF  = 0.40;

// ─── Cache Girişi ─────────────────────────────────────────────────────────────

export interface CacheEntry {
  route:          GhostRoute;
  cachedAt:       number;      // unixMs
  expiresAt:      number;      // unixMs
  hitCount:       number;      // kaç kez kullanıldı
  confidenceScore: number;     // son bilinen confidence (düşerse çıkar)
  sourceNodeId:   string;
  targetNodeId:   string;
}

// ─── Cache İstatistikleri ─────────────────────────────────────────────────────

export interface CacheStats {
  size:      number;
  hits:      number;
  misses:    number;
  evictions: number;
  hitRate:   number;           // hits / (hits + misses)
}

// ─── RouteCache ───────────────────────────────────────────────────────────────

export class RouteCache {
  /** Anahtar: `${sourceNodeId}→${targetNodeId}` */
  private readonly _cache  = new Map<string, CacheEntry>();
  private _hits    = 0;
  private _misses  = 0;
  private _evictions = 0;

  // ─── Temel CRUD ────────────────────────────────────────────────────────────

  /**
   * Cache'e route ekle.
   * confidence eşiğinin altındaysa eklenmez (zayıf route saklanmaz).
   */
  set(
    sourceNodeId:   string,
    targetNodeId:   string,
    route:          GhostRoute,
    confidenceScore: number,
    ttlMs:          number = ROUTE_CACHE_TTL_MS
  ): boolean {
    if (confidenceScore < ROUTE_CACHE_MIN_CONF) return false; // zayıf route → reddet

    // Kapasite kontrolü — LRU eviction
    if (this._cache.size >= ROUTE_CACHE_MAX) {
      this._evictLRU();
    }

    const key = this._key(sourceNodeId, targetNodeId);
    const now = Date.now();

    this._cache.set(key, {
      route, cachedAt: now, expiresAt: now + ttlMs,
      hitCount: 0, confidenceScore, sourceNodeId, targetNodeId,
    });

    return true;
  }

  /**
   * Cache'den route al.
   * Süresi dolmuşsa null döner ve girişi siler.
   */
  get(sourceNodeId: string, targetNodeId: string): GhostRoute | null {
    const key   = this._key(sourceNodeId, targetNodeId);
    const entry = this._cache.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this._cache.delete(key);
      this._misses++;
      return null;
    }

    // Hit — sayacı artır
    entry.hitCount++;
    this._hits++;
    return entry.route;
  }

  /**
   * Belirli bir route'u geçersiz kıl.
   * Topoloji değişince çağrılır (peer geldi/gitti).
   */
  invalidate(sourceNodeId: string, targetNodeId: string): boolean {
    return this._cache.delete(this._key(sourceNodeId, targetNodeId));
  }

  /**
   * Belirli bir node içeren tüm route'ları geçersiz kıl.
   * Bir node offline olduğunda çağrılır.
   */
  invalidateNode(nodeId: string): number {
    let removed = 0;
    for (const [key, entry] of this._cache) {
      if (entry.sourceNodeId === nodeId || entry.targetNodeId === nodeId) {
        this._cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Confidence skoru düşen route'ları geçersiz kıl.
   * GhostReceipt oluştukça çağrılabilir.
   */
  updateConfidence(
    sourceNodeId: string,
    targetNodeId: string,
    newScore:     number
  ): void {
    const key   = this._key(sourceNodeId, targetNodeId);
    const entry = this._cache.get(key);
    if (!entry) return;

    if (newScore < ROUTE_CACHE_MIN_CONF) {
      this._cache.delete(key);   // artık güvenilmez → çıkar
      this._evictions++;
    } else {
      entry.confidenceScore = newScore;
    }
  }

  /**
   * Süresi dolmuş tüm girişleri temizle.
   * Periyodik çağrı için (örn. her 60 saniyede bir).
   */
  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this._cache) {
      if (entry.expiresAt <= now) {
        this._cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Cache'i tamamen temizle (topoloji büyük değişimde) */
  clear(): void {
    this._cache.clear();
  }

  // ─── İstatistikler ─────────────────────────────────────────────────────────

  stats(): CacheStats {
    return {
      size:      this._cache.size,
      hits:      this._hits,
      misses:    this._misses,
      evictions: this._evictions,
      hitRate:   this._hits + this._misses > 0
        ? this._hits / (this._hits + this._misses)
        : 0,
    };
  }

  /**
   * En çok kullanılan route'lar (debug/observability için).
   */
  hotRoutes(n = 10): CacheEntry[] {
    return Array.from(this._cache.values())
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, n);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _key(src: string, dst: string): string {
    return `${src}→${dst}`;
  }

  /** LRU eviction: en az kullanılan + en eski girişi sil */
  private _evictLRU(): void {
    let lruKey:   string | null = null;
    let lruScore  = Infinity;

    for (const [key, entry] of this._cache) {
      // Skor: hitCount yüksekse öncelikli kalsın; eski + az kullanılan çıksın
      const age   = Date.now() - entry.cachedAt;
      const score = entry.hitCount * 1000 - age; // yüksek hit + genç → yüksek skor
      if (score < lruScore) {
        lruScore = score;
        lruKey   = key;
      }
    }

    if (lruKey) {
      this._cache.delete(lruKey);
      this._evictions++;
    }
  }
}
