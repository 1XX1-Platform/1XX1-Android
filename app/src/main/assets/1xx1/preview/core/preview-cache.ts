/**
 * 1XX1 Preview Cache
 * Aşama 17 — Web Preview Engine
 *
 * CID → PreviewResult eşlemesi.
 * İçerik adresli olduğu için cache anahtarı asla geçersiz olmaz
 * (CID değişirse zaten farklı bir içeriktir).
 *
 * TTL yalnızca bellek baskısını azaltmak için var — doğruluk için değil.
 * LRU + TTL kombinasyonu: az kullanılan + eski kayıtlar önce atılır.
 */

import type { PreviewResult, PreviewCacheEntry } from "./preview-types.ts";

export interface PreviewCacheConfig {
  /** Maksimum kayıt sayısı */
  maxEntries: number;
  /** Varsayılan TTL (ms) */
  defaultTTLMs: number;
}

const DEFAULT_CACHE_CONFIG: PreviewCacheConfig = {
  maxEntries:   10_000,
  defaultTTLMs: 24 * 60 * 60_000, // 24 saat
};

export class PreviewCache {
  private readonly store = new Map<string, PreviewCacheEntry>();
  private readonly cfg:   PreviewCacheConfig;

  constructor(cfg: Partial<PreviewCacheConfig> = {}) {
    this.cfg = { ...DEFAULT_CACHE_CONFIG, ...cfg };
  }

  /** Önizleme sonucunu cache'e koy */
  set(cid: string, result: PreviewResult, ttlMs?: number): void {
    const now = Date.now();

    // LRU: dolu ve yeni anahtar ise en eski/az kullanılanı at
    if (!this.store.has(cid) && this.store.size >= this.cfg.maxEntries) {
      this._evictOne();
    }

    this.store.set(cid, {
      result,
      cachedAt:  now,
      expiresAt: now + (ttlMs ?? this.cfg.defaultTTLMs),
      hitCount:  0,
    });
  }

  /** Cache'den oku — süresi dolmuşsa null döner ve kayıt silinir */
  get(cid: string): PreviewResult | null {
    const entry = this.store.get(cid);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(cid);
      return null;
    }

    entry.hitCount++;
    return entry.result;
  }

  /** Cache'de var mı (süre kontrolü dahil) */
  has(cid: string): boolean {
    return this.get(cid) !== null;
  }

  /** Belirli bir CID'yi temizle */
  invalidate(cid: string): boolean {
    return this.store.delete(cid);
  }

  /** Tüm süresi dolmuş kayıtları temizle */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [cid, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(cid);
        pruned++;
      }
    }
    return pruned;
  }

  /** En az kullanılan / en eski kaydı at (LRU benzeri) */
  private _evictOne(): void {
    let victim: string | null = null;
    let victimScore = Infinity;

    for (const [cid, entry] of this.store) {
      // Skor: az hit + eski cachedAt → önce atılır
      const score = entry.hitCount * 1000 - entry.cachedAt;
      if (score < victimScore) {
        victimScore = score;
        victim = cid;
      }
    }

    if (victim) this.store.delete(victim);
  }

  size(): number { return this.store.size; }

  stats(): { entries: number; totalHits: number; avgHits: number } {
    let totalHits = 0;
    for (const entry of this.store.values()) totalHits += entry.hitCount;
    return {
      entries:   this.store.size,
      totalHits,
      avgHits:   this.store.size > 0 ? totalHits / this.store.size : 0,
    };
  }

  clear(): void { this.store.clear(); }
}
