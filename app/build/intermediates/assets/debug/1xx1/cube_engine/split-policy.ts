/**
 * 1XX1 Adaptif Bölünme Politikası
 * Aşama 03 Risk Giderme — Risk 1
 *
 * Problem: "maxDepth = 0 → sınırsız derinlik" kontrolsüz node büyümesine,
 *          path explosion'a ve bellek fragmentasyonuna yol açar.
 *
 * Çözüm: "Kendini frenleyen sonsuzluk" (self-braking infinity)
 *
 *   softLimit  = uyarı eşiği (log + event, split devam eder)
 *   hardLimit  = mutlak tavan (split durur, overflow modu)
 *   adaptive   = yük/bellek baskısına göre dinamik splitThreshold
 *
 * maxDepth kavramı kaldırılmaz ama tek belirleyici olmaktan çıkar.
 * Politika katmanı gerçek kararı verir.
 */

import type { ILogger } from "../core/interfaces.ts";
import type { IEventBus } from "../core/interfaces.ts";

// ─── Politika Yapılandırması ──────────────────────────────────────────────────

export interface SplitPolicyConfig {
  /**
   * Teorik maksimum derinlik.
   * 0 = politika tarafından yönetilen sonsuzluk.
   * Engine bu değeri hard-code etmez; politika karar verir.
   */
  maxDepth: number;

  /**
   * Yumuşak derinlik sınırı: bu değerin üstünde log + event,
   * ama split devam eder (sistem kendini uyarır).
   */
  softDepthLimit: number;

  /**
   * Mutlak derinlik tavanı: bu değerin üstünde split durur.
   * 0 = sınırsız (softDepthLimit hâlâ çalışır).
   */
  hardDepthLimit: number;

  /**
   * Adaptif splitThreshold: true ise derinlik arttıkça
   * eşik büyür (derin düğümlerde daha az bölünme).
   */
  adaptive: boolean;

  /**
   * Adaptif büyüme faktörü.
   * splitThreshold(depth) = base * (factor ^ depth)
   * Varsayılan: 1.5
   */
  adaptiveFactor: number;

  /** Temel splitThreshold */
  baseSplitThreshold: number;

  /**
   * Tek bir path'in maksimum segment sayısı.
   * "4/7/2/0/1/2/3/..." → bu uzunlukta kesilir.
   * 0 = sınırsız
   */
  maxPathSegments: number;
}

export const DEFAULT_SPLIT_POLICY: Readonly<SplitPolicyConfig> = Object.freeze({
  maxDepth:            0,      // politika yönetir
  softDepthLimit:      12,     // 12+ derinlikte uyar
  hardDepthLimit:      64,     // 64+ derinlikte dur
  adaptive:            true,
  adaptiveFactor:      1.5,
  baseSplitThreshold:  64,
  maxPathSegments:     70,     // path explosion koruması
});

// ─── Politika Kararı ─────────────────────────────────────────────────────────

export type SplitDecision =
  | { allow: true;  threshold: number; reason?: string }
  | { allow: false; reason: string };

// ─── SplitPolicy Sınıfı ──────────────────────────────────────────────────────

export class SplitPolicy {
  private readonly cfg: SplitPolicyConfig;

  constructor(
    cfg: Partial<SplitPolicyConfig> = {},
    eventBus?: IEventBus,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.cfg = { ...DEFAULT_SPLIT_POLICY, ...cfg };
  }

  /**
   * Verilen derinlik için split yapılabilir mi ve eşik nedir?
   *
   * Karar sırası:
   * 1. path segment koruması
   * 2. hardDepthLimit
   * 3. softDepthLimit (uyar, izin ver)
   * 4. adaptif threshold hesapla
   */
  decide(depth: number, path: string, currentCount: number): SplitDecision {
    // ── Path explosion koruması ──
    if (this.cfg.maxPathSegments > 0) {
      const segments = path.split("/").length;
      if (segments > this.cfg.maxPathSegments) {
        const reason = `Path explosion engellendi: ${segments} segment > limit ${this.cfg.maxPathSegments}`;
        this.logger?.warn(reason, { path, depth });
        return { allow: false, reason };
      }
    }

    // ── Hard limit ──
    if (this.cfg.hardDepthLimit > 0 && depth >= this.cfg.hardDepthLimit) {
      const reason = `Hard derinlik sınırı: derinlik ${depth} ≥ hardLimit ${this.cfg.hardDepthLimit}`;
      this.logger?.warn(reason, { path, depth });
      this.eventBus?.emit("cube:overflow", {
        path,
        depth,
        count:     currentCount,
        threshold: this.effectiveThreshold(depth),
        reason:    "hard_depth_limit",
      });
      return { allow: false, reason };
    }

    // ── Soft limit (uyar ama izin ver) ──
    if (depth >= this.cfg.softDepthLimit) {
      const reason = `Soft derinlik uyarısı: derinlik ${depth} ≥ softLimit ${this.cfg.softDepthLimit}`;
      this.logger?.warn(reason, { path, depth });
      this.eventBus?.emit("cube:overflow", {
        path,
        depth,
        count:     currentCount,
        threshold: this.effectiveThreshold(depth),
        reason:    "soft_depth_warning",
      });
      // İzin ver ama threshold'u artır
    }

    const threshold = this.effectiveThreshold(depth);
    return { allow: true, threshold };
  }

  /**
   * Derinliğe göre etkin splitThreshold.
   *
   * adaptive = false → sabit `baseSplitThreshold`
   * adaptive = true  → threshold(d) = base * factor^d
   *
   * Örnek (base=64, factor=1.5):
   *   d=0: 64
   *   d=1: 96
   *   d=2: 144
   *   d=3: 216
   *   d=5: 486
   *
   * Derin düğümler daha fazla proje taşır → daha az bölünür.
   */
  effectiveThreshold(depth: number): number {
    if (!this.cfg.adaptive) return this.cfg.baseSplitThreshold;
    return Math.ceil(this.cfg.baseSplitThreshold * Math.pow(this.cfg.adaptiveFactor, depth));
  }

  /** Mevcut derinlik sınır durumu */
  depthStatus(depth: number): "normal" | "soft_warning" | "hard_blocked" {
    if (this.cfg.hardDepthLimit > 0 && depth >= this.cfg.hardDepthLimit) return "hard_blocked";
    if (depth >= this.cfg.softDepthLimit) return "soft_warning";
    return "normal";
  }

  get config(): Readonly<SplitPolicyConfig> {
    return this.cfg;
  }
}
