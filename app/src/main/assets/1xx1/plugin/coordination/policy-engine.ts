/**
 * 1XX1 Policy Engine — FAZ 8 Block 3
 *
 * CB + Telemetry + Resolver tek policy engine altinda birlesiyor.
 *
 * MIMARI KURAL (FAZ 7'den gelen):
 *   CB (Circuit Breaker) = SAFETY   → her zaman override eder
 *   Intelligence         = OPTIMIZE → oneri verir
 *   Policy Engine        = FEDERATE → ikisini koordine eder
 *
 * Tek karar noktasi burasi.
 * Runtime bu motoru sorgular, kendi basina karar vermez.
 *
 * Core'a dokunmaz.
 */

import type { PluginHealth, RiskLevel } from "../runtime/plugin-telemetry.ts";

// ─── Policy Tipleri ───────────────────────────────────────────────────────────

export type PolicyAction =
  | "continue"
  | "throttle"
  | "rollback"
  | "quarantine"
  | "disable";

export type PolicyDecision = {
  pluginId:  string;
  action:    PolicyAction;
  layer:     "safety" | "optimization" | "policy";  // kim karar verdi
  reason:    string;
  priority:  number;   // 0-100 (yuksek = daha acil)
};

export type PolicyRule = {
  name:      string;
  layer:     "safety" | "optimization";
  evaluate:  (pluginId: string, health: PluginHealth, cbTripped: boolean) => PolicyDecision | null;
};

// ─── Varsayilan Kurallar ──────────────────────────────────────────────────────

const DEFAULT_RULES: PolicyRule[] = [
  // SAFETY: CB aciksa her zaman quarantine
  {
    name:  "cb_safety",
    layer: "safety",
    evaluate: (id, _h, cbTripped) => {
      if (!cbTripped) return null;
      return { pluginId: id, action: "quarantine", layer: "safety",
               reason: "circuit_breaker_open", priority: 100 };
    },
  },

  // SAFETY: critical health → rollback
  {
    name:  "critical_health",
    layer: "safety",
    evaluate: (id, h, cbTripped) => {
      if (cbTripped || h.riskLevel !== "critical") return null;
      return { pluginId: id, action: "rollback", layer: "safety",
               reason: `health_critical:${h.healthScore.toFixed(2)}`, priority: 90 };
    },
  },

  // OPTIMIZE: high risk → throttle
  {
    name:  "high_risk_throttle",
    layer: "optimization",
    evaluate: (id, h, cbTripped) => {
      if (cbTripped || h.riskLevel !== "high") return null;
      return { pluginId: id, action: "throttle", layer: "optimization",
               reason: `risk_high:${h.healthScore.toFixed(2)}`, priority: 60 };
    },
  },

  // OPTIMIZE: error burst → rollback oneri
  {
    name:  "burst_rollback",
    layer: "optimization",
    evaluate: (id, h, cbTripped) => {
      if (cbTripped || !h.errorBurst) return null;
      return { pluginId: id, action: "rollback", layer: "optimization",
               reason: "error_burst_detected", priority: 70 };
    },
  },
];

// ─── Policy Engine ────────────────────────────────────────────────────────────

export class PolicyEngine {
  private rules: PolicyRule[];

  constructor(extraRules: PolicyRule[] = []) {
    // Safety kurallar once, optimization sonra
    this.rules = [
      ...DEFAULT_RULES.filter(r => r.layer === "safety"),
      ...extraRules.filter(r => r.layer === "safety"),
      ...DEFAULT_RULES.filter(r => r.layer === "optimization"),
      ...extraRules.filter(r => r.layer === "optimization"),
    ];
  }

  /**
   * Plugin icin tek karar noktasi.
   * En yuksek priority'li karar kazanir.
   * Safety layer her zaman optimization'i override eder.
   */
  decide(pluginId: string, health: PluginHealth, cbTripped: boolean): PolicyDecision {
    const decisions: PolicyDecision[] = [];

    for (const rule of this.rules) {
      const d = rule.evaluate(pluginId, health, cbTripped);
      if (d) decisions.push(d);
    }

    if (decisions.length === 0) {
      return { pluginId, action: "continue", layer: "policy",
               reason: "all_clear", priority: 0 };
    }

    // Safety layer her zaman kazanir
    const safety = decisions.filter(d => d.layer === "safety");
    if (safety.length > 0) {
      return safety.sort((a, b) => b.priority - a.priority)[0];
    }

    // Optimization: en yuksek priority
    return decisions.sort((a, b) => b.priority - a.priority)[0];
  }

  /** Tum plugin'ler icin toplu karar */
  decideAll(
    plugins: Array<{ id: string; health: PluginHealth; cbTripped: boolean }>
  ): PolicyDecision[] {
    return plugins
      .map(p => this.decide(p.id, p.health, p.cbTripped))
      .filter(d => d.action !== "continue")
      .sort((a, b) => b.priority - a.priority);
  }

  /** Kural ekle (runtime'da policy guncelleme) */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  ruleCount(): number { return this.rules.length; }
}
