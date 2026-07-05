/**
 * 1XX1 Plugin Telemetry Brain — FAZ 7
 *
 * Her plugin icin surekli analiz:
 *   moving average latency
 *   error burst detection (sliding window)
 *   health score = successRate*0.6 + latencyScore*0.4
 *
 * Core'a dokunmaz. PluginRuntime'dan okur, yazamaz.
 */

const WINDOW_SIZE   = 20;   // Son 20 invokasyon
const BURST_WINDOW  = 10;   // Son 10'da burst detect
const BURST_THRESH  = 0.5;  // %50 hata = burst

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PluginHealth = {
  pluginId:       string;
  healthScore:    number;      // 0-1
  riskLevel:      RiskLevel;
  successRate:    number;      // 0-1
  latencyScore:   number;      // 0-1 (dusuk gecikme = yuksek skor)
  avgLatencyMs:   number;
  errorBurst:     boolean;
  recommendation: "ok" | "throttle" | "rollback" | "quarantine";
  samples:        number;
};

export class PluginTelemetry {
  // Her plugin icin sliding window
  private windows = new Map<string, Array<{ success: boolean; latencyMs: number; ts: number }>>();

  record(pluginId: string, success: boolean, latencyMs: number): void {
    if (!this.windows.has(pluginId)) this.windows.set(pluginId, []);
    const w = this.windows.get(pluginId)!;
    w.push({ success, latencyMs, ts: Date.now() });
    if (w.length > WINDOW_SIZE) w.shift();
  }

  analyze(pluginId: string): PluginHealth {
    const w = this.windows.get(pluginId) ?? [];

    if (w.length === 0) {
      return this._default(pluginId);
    }

    // Success rate
    const successRate = w.filter(x => x.success).length / w.length;

    // Moving average latency
    const avgLatencyMs = w.reduce((s, x) => s + x.latencyMs, 0) / w.length;

    // Latency score: 0ms=1.0, 1000ms=0.0, lineer
    const latencyScore = Math.max(0, 1 - avgLatencyMs / 1000);

    // Health score
    const healthScore = successRate * 0.6 + latencyScore * 0.4;

    // Error burst: son BURST_WINDOW'da BURST_THRESH'ten fazla hata
    const recent    = w.slice(-BURST_WINDOW);
    const errorBurst = recent.length >= BURST_WINDOW &&
      recent.filter(x => !x.success).length / recent.length > BURST_THRESH;

    // Risk level
    const riskLevel: RiskLevel =
      healthScore >= 0.8 ? "low"      :
      healthScore >= 0.6 ? "medium"   :
      healthScore >= 0.4 ? "high"     :
      "critical";

    // Recommendation
    const recommendation =
      errorBurst && riskLevel === "critical" ? "quarantine" :
      riskLevel === "critical"               ? "rollback"   :
      riskLevel === "high"                   ? "throttle"   :
      "ok";

    return {
      pluginId, healthScore, riskLevel, successRate,
      latencyScore, avgLatencyMs, errorBurst,
      recommendation, samples: w.length,
    };
  }

  analyzeAll(): PluginHealth[] {
    return [...this.windows.keys()].map(id => this.analyze(id));
  }

  clear(pluginId: string): void { this.windows.delete(pluginId); }

  private _default(pluginId: string): PluginHealth {
    return {
      pluginId, healthScore: 1, riskLevel: "low",
      successRate: 1, latencyScore: 1, avgLatencyMs: 0,
      errorBurst: false, recommendation: "ok", samples: 0,
    };
  }
}
