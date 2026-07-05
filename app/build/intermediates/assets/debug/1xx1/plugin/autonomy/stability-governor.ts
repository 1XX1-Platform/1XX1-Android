/**
 * 1XX1 Stability Governor + Controlled Autonomy Layer — FAZ 9 Block 3+4
 *
 * FAZ 9'un kalbi. Tum sinyalleri birlestirip sistem kararini verir.
 *
 * HIBRIT STRATEJI:
 *   Guvenlik  → soft mode (cluster degradation) tam koruma saglar
 *   Performans → normal modda maksimum throughput
 *
 * "No new decision source rule":
 *   PolicyEngine'e yeni signal saglar, kendi basina karar vermez.
 *   CAL sadece izin verilen eylemler arasindan secer.
 *
 * Bounded autonomy:
 *   degrade plugin     ✅
 *   throttle execution ✅
 *   isolate group      ✅
 *   recommend rollback ✅ (CB final karar verir)
 *   override CB        ❌ YASAK
 */

import type { PolicyDecision } from "../coordination/policy-engine.ts";

// ─── Sistem Modu ──────────────────────────────────────────────────────────────

export type SystemMode = "normal" | "cautious" | "soft" | "recovery";

const MODE_THRESHOLDS = {
  cautious: 0.3,  // %30 plugin degraded → cautious
  soft:     0.5,  // %50 plugin degraded → soft mode
};

// ─── Governor Signal ──────────────────────────────────────────────────────────

export type GovernorSignal = {
  pluginId:      string;
  cbTripped:     boolean;
  riskScore:     number;    // 0-1, telemetridan
  cascadeRisk:   number;    // 0-1, interaction guard'dan
  budgetUsage:   number;    // 0-1, EBM'den
};

// ─── Governor Karari ──────────────────────────────────────────────────────────

export type GovernorDecision = {
  pluginId:    string;
  allowed:     boolean;
  action:      "allow" | "throttle" | "isolate" | "degrade" | "recommend_rollback";
  systemMode:  SystemMode;
  reason:      string;
  latencyBudgetMs: number;  // bu invokasyon icin max sure
};

// ─── Stability Governor ───────────────────────────────────────────────────────

export class StabilityGovernor {
  private systemMode:     SystemMode = "normal";
  private degradedCount   = 0;
  private totalPlugins    = 0;
  private modeHistory: Array<{ mode: SystemMode; ts: number }> = [];

  updateSystemState(total: number, degraded: number): void {
    this.totalPlugins  = total;
    this.degradedCount = degraded;
    const ratio = total > 0 ? degraded / total : 0;

    const prev = this.systemMode;
    this.systemMode =
      ratio >= MODE_THRESHOLDS.soft     ? "soft"     :
      ratio >= MODE_THRESHOLDS.cautious ? "cautious" :
      this.systemMode === "soft"        ? "recovery" :
      "normal";

    if (this.systemMode !== prev) {
      this.modeHistory.push({ mode: this.systemMode, ts: Date.now() });
      if (this.modeHistory.length > 50) this.modeHistory.shift();
    }
  }

  /**
   * Her invokasyon oncesi governor karari.
   * HIBRIT: guvenlik garantisi + performans optimizasyonu
   */
  evaluate(signal: GovernorSignal): GovernorDecision {
    // 1. CB trigged → gov onay gerekmiyor ama bilgi verir
    if (signal.cbTripped) {
      return this._decision(signal.pluginId, false, "isolate",
        "cb_triggered_safety_override", 0);
    }

    // 2. Cascade risk yuksek → izole et
    if (signal.cascadeRisk >= 0.7) {
      return this._decision(signal.pluginId, false, "isolate",
        `cascade_risk:${signal.cascadeRisk.toFixed(2)}`, 0);
    }

    // 3. Soft mode: tum plugin'lere throttle
    if (this.systemMode === "soft") {
      if (signal.riskScore >= 0.5) {
        return this._decision(signal.pluginId, false, "degrade",
          "system_soft_mode_high_risk", 0);
      }
      return this._decision(signal.pluginId, true, "throttle",
        "system_soft_mode", this._latencyBudget(signal));
    }

    // 4. Budget tuketildi → throttle
    if (signal.budgetUsage >= 1.0) {
      return this._decision(signal.pluginId, false, "throttle",
        "budget_exhausted", 0);
    }

    // 5. Risk yuksek → rollback onerisinde bulun (CB karar verir)
    if (signal.riskScore >= 0.8) {
      return this._decision(signal.pluginId, true, "recommend_rollback",
        `risk_score:${signal.riskScore.toFixed(2)}`,
        this._latencyBudget(signal));
    }

    // 6. Normal + cautious: izin ver, latency budget ile
    return this._decision(signal.pluginId, true, "allow",
      `mode:${this.systemMode}`, this._latencyBudget(signal));
  }

  getSystemMode(): SystemMode     { return this.systemMode; }
  getDegradedRatio(): number      { return this.totalPlugins > 0 ? this.degradedCount / this.totalPlugins : 0; }
  getModeHistory()                { return [...this.modeHistory]; }

  private _latencyBudget(signal: GovernorSignal): number {
    // Hibrit: risk yukselince latency budget kucuktur
    // normal=5s, cautious=3s, soft=1s
    const modeMs = this.systemMode === "soft" ? 1000 :
                   this.systemMode === "cautious" ? 3000 : 5000;
    const riskFactor = 1 - signal.riskScore * 0.5;
    return Math.round(modeMs * riskFactor);
  }

  private _decision(
    pluginId: string, allowed: boolean,
    action: GovernorDecision["action"],
    reason: string, latencyMs: number
  ): GovernorDecision {
    return { pluginId, allowed, action, systemMode: this.systemMode, reason, latencyBudgetMs: latencyMs };
  }
}

// ─── Controlled Autonomy Layer (CAL) ─────────────────────────────────────────

export type AutonomyAction = {
  pluginId:  string;
  action:    "degrade" | "throttle" | "isolate_group" | "recommend_rollback";
  groupId?:  string;
  reason:    string;
  automated: boolean;  // true = otomatik, false = insan onayladi
};

export class ControlledAutonomyLayer {
  private governor: StabilityGovernor;
  private history:  AutonomyAction[] = [];

  // CAL'in yapabilecekleri (bounded)
  private readonly ALLOWED_ACTIONS = new Set([
    "degrade", "throttle", "isolate_group", "recommend_rollback"
  ]);

  constructor(governor: StabilityGovernor) {
    this.governor = governor;
  }

  /**
   * Governor kararindan CAL aksiyonu uret.
   * Sadece izin verilen eylemler.
   * CB override YASAK.
   */
  act(decision: GovernorDecision): AutonomyAction | null {
    if (decision.allowed && decision.action === "allow") return null;

    const action = this._mapAction(decision.action);
    if (!this.ALLOWED_ACTIONS.has(action)) return null;  // guvenlik siniri

    const autonomyAction: AutonomyAction = {
      pluginId:  decision.pluginId,
      action:    action as AutonomyAction["action"],
      reason:    decision.reason,
      automated: true,
    };

    this.history.push(autonomyAction);
    if (this.history.length > 200) this.history.shift();
    return autonomyAction;
  }

  /** Grup izolasyonu */
  isolateGroup(groupId: string, pluginIds: string[]): AutonomyAction[] {
    return pluginIds.map(id => {
      const a: AutonomyAction = {
        pluginId: id, action: "isolate_group", groupId,
        reason: `group_isolation:${groupId}`, automated: true,
      };
      this.history.push(a);
      return a;
    });
  }

  recentActions(pluginId?: string, limit = 20): AutonomyAction[] {
    const h = pluginId ? this.history.filter(a => a.pluginId === pluginId) : this.history;
    return h.slice(-limit);
  }

  private _mapAction(govAction: GovernorDecision["action"]): string {
    const map: Record<string, string> = {
      allow:             "allow",
      throttle:          "throttle",
      isolate:           "isolate_group",
      degrade:           "degrade",
      recommend_rollback:"recommend_rollback",
    };
    return map[govAction] ?? "throttle";
  }
}
