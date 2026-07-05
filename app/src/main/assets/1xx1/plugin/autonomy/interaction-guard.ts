/**
 * 1XX1 Cross-Plugin Interaction Guard (CPIG) — FAZ 9 Block 2
 *
 * Behavior Graph uzerinden cascading failure'i onler.
 * Plugin A, plugin B'yi kac kez etkiledi → throttle/isolate.
 *
 * HIBRIT STRATEJI:
 *   Guvenlik  → cascading failure hard block
 *   Performans → normal interaksiyonlar geciktirilmez
 */

import type { BehaviorGraph } from "../coordination/behavior-graph.ts";

const CASCADE_WINDOW_MS   = 30_000;  // 30 saniye pencere
const CASCADE_THRESHOLD   = 5;       // bu kadar propagation → guard aktif
const ISOLATION_WINDOW_MS = 60_000;  // 60 saniye izolasyon

export type InteractionEvent = {
  fromPlugin: string;
  toPlugin:   string;
  ts:         number;
  triggered:  boolean;  // to plugin'de hata tetiklendi mi?
};

export type GuardDecision = {
  allowed:    boolean;
  fromPlugin: string;
  toPlugin:   string;
  reason:     "ok" | "cascade_risk" | "isolated" | "rate_limited";
};

export class InteractionGuard {
  private events:   InteractionEvent[] = [];
  private isolated: Map<string, number> = new Map(); // pluginId → isolate bitisi
  private graph:    BehaviorGraph | null;

  constructor(behaviorGraph?: BehaviorGraph) {
    this.graph = behaviorGraph ?? null;
  }

  /** Interaksiyonu kaydet */
  record(fromPlugin: string, toPlugin: string, triggered: boolean): void {
    this.events.push({ fromPlugin, toPlugin, ts: Date.now(), triggered });
    // Eski eventleri temizle
    const cutoff = Date.now() - CASCADE_WINDOW_MS * 2;
    this.events = this.events.filter(e => e.ts > cutoff);

    // Cascade tespit: from → to zincirine cok fazla triggered var mi?
    if (triggered) this._checkCascade(fromPlugin, toPlugin);

    // Behavior graph'i guncelle
    if (this.graph) {
      this.graph.observeEdge(fromPlugin, toPlugin, "causal", triggered ? 0.8 : 0.2);
    }
  }

  /** Interaksiyona izin var mi? */
  check(fromPlugin: string, toPlugin: string): GuardDecision {
    // Izolasyon kontrolu
    if (this._isIsolated(fromPlugin)) {
      return { allowed: false, fromPlugin, toPlugin, reason: "isolated" };
    }

    // Cascade risk: bu cift son pencerede cok fazla hata tetikledi mi?
    const cascadeCount = this._cascadeCount(fromPlugin, toPlugin, CASCADE_WINDOW_MS);
    if (cascadeCount >= CASCADE_THRESHOLD) {
      return { allowed: false, fromPlugin, toPlugin, reason: "cascade_risk" };
    }

    return { allowed: true, fromPlugin, toPlugin, reason: "ok" };
  }

  /** Plugin'i izole et */
  isolate(pluginId: string, durationMs = ISOLATION_WINDOW_MS): void {
    this.isolated.set(pluginId, Date.now() + durationMs);
  }

  /** Izolasyon kaldir */
  release(pluginId: string): void {
    this.isolated.delete(pluginId);
  }

  cascadeRisk(fromPlugin: string): number {
    const total     = this.events.filter(e => e.fromPlugin === fromPlugin).length;
    const triggered = this.events.filter(e => e.fromPlugin === fromPlugin && e.triggered).length;
    return total === 0 ? 0 : triggered / total;
  }

  private _isIsolated(pluginId: string): boolean {
    const until = this.isolated.get(pluginId);
    if (!until) return false;
    if (Date.now() >= until) { this.isolated.delete(pluginId); return false; }
    return true;
  }

  private _cascadeCount(from: string, to: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.events.filter(
      e => e.fromPlugin === from && e.toPlugin === to && e.triggered && e.ts > cutoff
    ).length;
  }

  private _checkCascade(from: string, to: string): void {
    const count = this._cascadeCount(from, to, CASCADE_WINDOW_MS);
    if (count >= CASCADE_THRESHOLD) {
      // Otomatik cascade isolasyon — guvenlik garantisi
      this.isolate(from, ISOLATION_WINDOW_MS);
    }
  }
}
