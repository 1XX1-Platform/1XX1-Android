/**
 * 1XX1 Plugin Intelligence — FAZ 7
 *
 * 1. Conflict Resolver    — ayni EP'e 2 plugin → priority scoring
 * 2. Adaptive Circuit Breaker v2 — EWMA threshold
 * 3. Auto-Rollback Engine — CB open → rollback evaluation
 *
 * Core'a dokunmaz.
 */

import type { PluginRecord } from "./plugin-runtime.ts";
import type { PluginHealth } from "./plugin-telemetry.ts";

// ─── 1. Conflict Resolver ────────────────────────────────────────────────────

export type ConflictResolution = {
  winner:   string;
  loser:    string;
  score:    { [pluginId: string]: number };
  strategy: "priority" | "health" | "hash_tiebreak";
};

export class ConflictResolver {
  /**
   * Ayni extension point'e bagli iki plugin arasinda kazanani sec.
   * score = priorityWeight + healthScore + recencyBonus - errorPenalty
   */
  resolve(
    pluginA: PluginRecord,
    pluginB: PluginRecord,
    healthA: PluginHealth,
    healthB: PluginHealth,
  ): ConflictResolution {
    const scoreA = this._score(pluginA, healthA);
    const scoreB = this._score(pluginB, healthB);

    let winner: string, loser: string, strategy: ConflictResolution["strategy"];

    if (scoreA > scoreB) {
      winner = pluginA.id; loser = pluginB.id; strategy = "priority";
    } else if (scoreB > scoreA) {
      winner = pluginB.id; loser = pluginA.id; strategy = "priority";
    } else {
      // Deterministic tiebreak: lexicographic hash
      strategy = "hash_tiebreak";
      const hashA = this._deterministicHash(pluginA.id);
      const hashB = this._deterministicHash(pluginB.id);
      winner = hashA >= hashB ? pluginA.id : pluginB.id;
      loser  = winner === pluginA.id ? pluginB.id : pluginA.id;
    }

    return {
      winner, loser,
      score: { [pluginA.id]: scoreA, [pluginB.id]: scoreB },
      strategy,
    };
  }

  private _score(plugin: PluginRecord, health: PluginHealth): number {
    const age          = (Date.now() - plugin.registeredAt) / 1000 / 3600; // saat
    const recencyBonus = Math.max(0, 1 - age / 24);   // 24 saatte 0'a iner
    const errorPenalty = Math.min(plugin.errors * 0.1, 0.5);
    return health.healthScore + recencyBonus - errorPenalty;
  }

  private _deterministicHash(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
    }
    return h >>> 0; // unsigned
  }
}

// ─── 2. Adaptive Circuit Breaker v2 ─────────────────────────────────────────

/**
 * MIMARI KURAL (FAZ 7 sonrasi):
 *   CB (Circuit Breaker) = SAFETY LAYER   → her zaman override eder
 *   Intelligence Layer   = OPTIMIZE LAYER → oneri verir, tetikler
 *
 * Cakisma durumunda: CB karari her zaman kazanir.
 * Intelligence sadece CB'nin tetiklemedigi durumlarda devreye girer.
 */

const ALPHA          = 0.15;  // EWMA smoothing
const BASE_THRESHOLD = 0.3;   // %30 hata base
const VARIANCE_CAP   = 0.5;   // maksimum threshold yukarı kayma

export class AdaptiveCircuitBreaker {
  private ewma     = new Map<string, number>(); // pluginId → error EWMA
  private variance = new Map<string, number>(); // pluginId → variance

  record(pluginId: string, error: boolean): void {
    const prev = this.ewma.get(pluginId) ?? 0;
    const curr = error ? 1 : 0;
    const newEwma = ALPHA * curr + (1 - ALPHA) * prev;
    this.ewma.set(pluginId, newEwma);

    // Variance (simplified — EWMA of squared diff)
    const prevVar = this.variance.get(pluginId) ?? 0;
    const diff    = curr - prev;
    this.variance.set(pluginId, ALPHA * diff * diff + (1 - ALPHA) * prevVar);
  }

  shouldTrip(pluginId: string): boolean {
    const errorRate   = this.ewma.get(pluginId) ?? 0;
    const varianceFac = Math.min(this.variance.get(pluginId) ?? 0, VARIANCE_CAP);
    const threshold   = BASE_THRESHOLD * (1 + varianceFac);
    return errorRate > threshold;
  }

  reset(pluginId: string): void {
    this.ewma.set(pluginId, 0);
    this.variance.set(pluginId, 0);
  }

  errorRate(pluginId: string): number {
    return this.ewma.get(pluginId) ?? 0;
  }

  threshold(pluginId: string): number {
    const v = Math.min(this.variance.get(pluginId) ?? 0, VARIANCE_CAP);
    return BASE_THRESHOLD * (1 + v);
  }
}

// ─── 3. Auto-Rollback Engine ─────────────────────────────────────────────────

export type RollbackAction =
  | { action: "restore_snapshot"; pluginId: string; snapshotId: string }
  | { action: "disable";          pluginId: string }
  | { action: "activate_fallback"; pluginId: string; fallbackId: string }
  | { action: "none" };

export type RollbackDecision = {
  pluginId:  string;
  triggered: boolean;
  action:    RollbackAction;
  reason:    string;
};

export class AutoRollbackEngine {
  // pluginId → { version, snapshotId } (son stabil versiyon)
  private stableVersions = new Map<string, { version: string; snapshotId: string }>();
  // pluginId → fallback plugin id
  private fallbacks      = new Map<string, string>();
  // Rollback gecmisi
  private history: Array<{ pluginId: string; ts: number; action: string }> = [];

  /** Son stabil versiyonu kaydet */
  markStable(pluginId: string, version: string, snapshotId: string): void {
    this.stableVersions.set(pluginId, { version, snapshotId });
  }

  /** Fallback plugin tanimla */
  registerFallback(pluginId: string, fallbackId: string): void {
    this.fallbacks.set(pluginId, fallbackId);
  }

  /**
   * Circuit breaker acilinca rollback karari ver.
   * Cagiran: PluginRuntime'in CB hook'u
   */
  evaluate(pluginId: string, health: PluginHealth): RollbackDecision {
    // Zaten son 5 dakikada rollback yapildiysa tekrar tetikleme
    const recent = this.history.filter(
      h => h.pluginId === pluginId && Date.now() - h.ts < 5 * 60_000
    );
    if (recent.length >= 2) {
      return { pluginId, triggered: false, action: { action: "none" }, reason: "rollback_cooldown" };
    }

    // Karar: snapshot var → restore, yoksa fallback veya disable
    const stable   = this.stableVersions.get(pluginId);
    const fallback = this.fallbacks.get(pluginId);

    let action: RollbackAction;
    let reason: string;

    if (stable) {
      action = { action: "restore_snapshot", pluginId, snapshotId: stable.snapshotId };
      reason = `restore_to_${stable.version}`;
    } else if (fallback) {
      action = { action: "activate_fallback", pluginId, fallbackId: fallback };
      reason = `fallback_to_${fallback}`;
    } else {
      action = { action: "disable", pluginId };
      reason = "no_stable_version";
    }

    // Gecmise kaydet
    this.history.push({ pluginId, ts: Date.now(), action: action.action });
    if (this.history.length > 100) this.history.shift();

    return { pluginId, triggered: true, action, reason };
  }

  rollbackHistory(pluginId: string): typeof this.history {
    return this.history.filter(h => h.pluginId === pluginId);
  }
}
