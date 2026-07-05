/**
 * 1XX1 System Drift Detector — FAZ X
 *
 * "Sistem zamanla ayni davranmiyor mu?" sorusunu cevaplar.
 *
 * Detection:
 *   same input → different decision trend
 *   policy deviation over time
 *   plugin behavior drift
 *
 * Deterministik kalir — ML yok, heuristic var.
 */

const DRIFT_WINDOW_MS   = 5 * 60_000;  // 5 dakika pencere
const DRIFT_THRESHOLD   = 0.25;         // %25 sapma = drift
const MIN_SAMPLES       = 5;            // en az bu kadar ornek gerekli

export type DriftSignal = {
  pluginId:      string;
  metric:        "latency" | "success_rate" | "policy_action";
  baselineMean:  number;
  recentMean:    number;
  driftRatio:    number;   // (recent - baseline) / baseline
  isDrifting:    boolean;
  severity:      "none" | "mild" | "significant" | "critical";
  detectedAt:    number;
};

export type PolicyDrift = {
  pluginId:   string;
  baseline:   Record<string, number>;  // action → count (ilk pencere)
  recent:     Record<string, number>;  // action → count (son pencere)
  isDrifting: boolean;
  detectedAt: number;
};

export class DriftDetector {
  // Sliding windows: pluginId → samples
  private latency     = new Map<string, number[]>();
  private successRate = new Map<string, number[]>();
  private policyActions = new Map<string, string[]>(); // son N aksiyon

  private baselines   = new Map<string, { latency: number; successRate: number }>();
  private driftHistory: DriftSignal[] = [];

  // ─── Veri kayit ───────────────────────────────────────────────────────────

  recordInvocation(pluginId: string, latencyMs: number, success: boolean): void {
    this._push(this.latency,     pluginId, latencyMs);
    this._push(this.successRate, pluginId, success ? 1 : 0);

    // Baseline yoksa kur (ilk 10 sample)
    if (!this.baselines.has(pluginId)) {
      const latencies = this.latency.get(pluginId) ?? [];
      const rates     = this.successRate.get(pluginId) ?? [];
      if (latencies.length >= 10) {
        this.baselines.set(pluginId, {
          latency:     this._mean(latencies.slice(0, 10)),
          successRate: this._mean(rates.slice(0, 10)),
        });
      }
    }
  }

  recordPolicyAction(pluginId: string, action: string): void {
    if (!this.policyActions.has(pluginId)) this.policyActions.set(pluginId, []);
    const actions = this.policyActions.get(pluginId)!;
    actions.push(action);
    if (actions.length > 100) actions.shift();
  }

  // ─── Drift analizi ────────────────────────────────────────────────────────

  analyzePlugin(pluginId: string): DriftSignal[] {
    const signals: DriftSignal[] = [];
    const baseline = this.baselines.get(pluginId);
    if (!baseline) return [];

    const latencies = this.latency.get(pluginId) ?? [];
    const rates     = this.successRate.get(pluginId) ?? [];

    if (latencies.length >= MIN_SAMPLES) {
      const recent = this._mean(latencies.slice(-MIN_SAMPLES));
      const drift  = this._driftRatio(baseline.latency, recent);
      const signal: DriftSignal = {
        pluginId, metric:"latency",
        baselineMean: baseline.latency, recentMean: recent,
        driftRatio: drift, isDrifting: Math.abs(drift) > DRIFT_THRESHOLD,
        severity: this._severity(drift), detectedAt: Date.now(),
      };
      if (signal.isDrifting) {
        signals.push(signal);
        this.driftHistory.push(signal);
        if (this.driftHistory.length > 200) this.driftHistory.shift();
      }
    }

    if (rates.length >= MIN_SAMPLES) {
      const recent = this._mean(rates.slice(-MIN_SAMPLES));
      const drift  = this._driftRatio(baseline.successRate, recent);
      const signal: DriftSignal = {
        pluginId, metric:"success_rate",
        baselineMean: baseline.successRate, recentMean: recent,
        driftRatio: drift, isDrifting: Math.abs(drift) > DRIFT_THRESHOLD,
        severity: this._severity(Math.abs(drift)), detectedAt: Date.now(),
      };
      if (signal.isDrifting) {
        signals.push(signal);
        this.driftHistory.push(signal);
        if (this.driftHistory.length > 200) this.driftHistory.shift();
      }
    }

    return signals;
  }

  /** Policy action dagiliminun drift'i */
  analyzePolicyDrift(pluginId: string): PolicyDrift | null {
    const actions = this.policyActions.get(pluginId) ?? [];
    if (actions.length < MIN_SAMPLES * 2) return null;

    const half     = Math.floor(actions.length / 2);
    const baseline = this._countActions(actions.slice(0, half));
    const recent   = this._countActions(actions.slice(-half));

    // Dagilim farki
    const allKeys  = new Set([...Object.keys(baseline), ...Object.keys(recent)]);
    let maxDiff    = 0;
    for (const k of allKeys) {
      const bRate = (baseline[k] ?? 0) / half;
      const rRate = (recent[k] ?? 0) / half;
      maxDiff     = Math.max(maxDiff, Math.abs(rRate - bRate));
    }

    return {
      pluginId, baseline, recent,
      isDrifting: maxDiff > DRIFT_THRESHOLD,
      detectedAt: Date.now(),
    };
  }

  /** Tum plugin'lerde drift var mi? */
  systemDriftReport(): { drifting: string[]; stable: string[]; unknown: string[] } {
    const drifting: string[] = [], stable: string[] = [], unknown: string[] = [];
    const allPlugins = new Set([
      ...this.latency.keys(), ...this.successRate.keys()
    ]);

    for (const id of allPlugins) {
      if (!this.baselines.has(id)) { unknown.push(id); continue; }
      const signals = this.analyzePlugin(id);
      if (signals.some(s => s.isDrifting)) drifting.push(id);
      else stable.push(id);
    }

    return { drifting, stable, unknown };
  }

  recentDrift(pluginId?: string): DriftSignal[] {
    return pluginId
      ? this.driftHistory.filter(d => d.pluginId === pluginId)
      : this.driftHistory;
  }

  resetBaseline(pluginId: string): void {
    this.baselines.delete(pluginId);
    this.latency.delete(pluginId);
    this.successRate.delete(pluginId);
  }

  // ─── Yardimci ─────────────────────────────────────────────────────────────

  private _push(map: Map<string, number[]>, id: string, val: number): void {
    if (!map.has(id)) map.set(id, []);
    const arr = map.get(id)!;
    arr.push(val);
    if (arr.length > 50) arr.shift();
  }

  private _mean(arr: number[]): number {
    return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  private _driftRatio(baseline: number, recent: number): number {
    if (baseline === 0) return 0;
    return (recent - baseline) / baseline;
  }

  private _severity(ratio: number): DriftSignal["severity"] {
    const abs = Math.abs(ratio);
    return abs < DRIFT_THRESHOLD ? "none" :
           abs < 0.5 ? "mild" :
           abs < 1.0 ? "significant" : "critical";
  }

  private _countActions(actions: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const a of actions) counts[a] = (counts[a] ?? 0) + 1;
    return counts;
  }
}
