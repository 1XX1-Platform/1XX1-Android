/**
 * 1XX1 Runtime Contract System — FAZ X
 *
 * Plugin'ler sadece interface degil, davranis sozlesmesi imzalar.
 * Sozlesme ihlali → PolicyEngine'e sinyal gider.
 *
 * 3 kontrat tipi:
 *   Behavioral  → beklenen davranis (latency, success rate)
 *   Performance → kaynak kullanimi (quota, throughput)
 *   Failure     → hata siniri ve kurtarma beklentisi
 */

export type BehavioralContract = {
  pluginId:          string;
  maxLatencyMs:      number;   // bu sure asilirsa ihlal
  minSuccessRate:    number;   // 0-1, bu altina duserse ihlal
  maxConsecutiveFail: number;  // arka arkaya hata siniri
};

export type PerformanceContract = {
  pluginId:          string;
  maxInvocationsPerMin: number;
  maxMemoryMb:       number;   // soft limit (enforcement optional)
  maxCpuPercent:     number;   // soft limit
};

export type FailureContract = {
  pluginId:          string;
  maxRollbackCount:  number;   // bu kadar rollback → contract ihlal
  maxQuarantineCount: number;
  recoveryWindowMs:  number;   // bu sure icinde toparlamazsa ihlal
};

export type ContractViolation = {
  pluginId:     string;
  contractType: "behavioral" | "performance" | "failure";
  field:        string;
  expected:     number;
  actual:       number;
  ts:           number;
  severity:     "warning" | "breach";
};

export class RuntimeContractSystem {
  private behavioral  = new Map<string, BehavioralContract>();
  private performance = new Map<string, PerformanceContract>();
  private failure     = new Map<string, FailureContract>();
  private _violations: ContractViolation[] = [];

  // ─── Sozlesme kayit ────────────────────────────────────────────────────────

  setBehavioral(c: BehavioralContract):  void { this.behavioral.set(c.pluginId, c); }
  setPerformance(c: PerformanceContract): void { this.performance.set(c.pluginId, c); }
  setFailure(c: FailureContract):        void { this.failure.set(c.pluginId, c); }

  // ─── Ihlal kontrolu ────────────────────────────────────────────────────────

  checkBehavioral(
    pluginId: string,
    latencyMs: number,
    successRate: number,
    consecutiveFail: number
  ): ContractViolation[] {
    const c = this.behavioral.get(pluginId);
    if (!c) return [];
    const viols: ContractViolation[] = [];
    const ts = Date.now();

    if (latencyMs > c.maxLatencyMs) {
      viols.push({ pluginId, contractType:"behavioral", field:"latency",
        expected:c.maxLatencyMs, actual:latencyMs, ts,
        severity: latencyMs > c.maxLatencyMs * 2 ? "breach" : "warning" });
    }
    if (successRate < c.minSuccessRate) {
      viols.push({ pluginId, contractType:"behavioral", field:"successRate",
        expected:c.minSuccessRate, actual:successRate, ts,
        severity: successRate < c.minSuccessRate * 0.5 ? "breach" : "warning" });
    }
    if (consecutiveFail > c.maxConsecutiveFail) {
      viols.push({ pluginId, contractType:"behavioral", field:"consecutiveFail",
        expected:c.maxConsecutiveFail, actual:consecutiveFail, ts, severity:"breach" });
    }

    this._record(viols);
    return viols;
  }

  checkFailure(
    pluginId: string,
    rollbackCount: number,
    quarantineCount: number
  ): ContractViolation[] {
    const c = this.failure.get(pluginId);
    if (!c) return [];
    const viols: ContractViolation[] = [];
    const ts = Date.now();

    if (rollbackCount > c.maxRollbackCount) {
      viols.push({ pluginId, contractType:"failure", field:"rollbackCount",
        expected:c.maxRollbackCount, actual:rollbackCount, ts, severity:"breach" });
    }
    if (quarantineCount > c.maxQuarantineCount) {
      viols.push({ pluginId, contractType:"failure", field:"quarantineCount",
        expected:c.maxQuarantineCount, actual:quarantineCount, ts, severity:"breach" });
    }

    this._record(viols);
    return viols;
  }

  // ─── Sorgulama ────────────────────────────────────────────────────────────

  violations(pluginId?: string): ContractViolation[] {
    return pluginId
      ? this._violations.filter(v => v.pluginId === pluginId)
      : this._violations;
  }

  breaches(pluginId?: string): ContractViolation[] {
    return this.violations(pluginId).filter(v => v.severity === "breach");
  }

  hasContract(pluginId: string): boolean {
    return this.behavioral.has(pluginId) ||
           this.performance.has(pluginId) ||
           this.failure.has(pluginId);
  }

  private _record(viols: ContractViolation[]): void {
    this._violations.push(...viols);
    if (this._violations.length > 500) this._violations.splice(0, 100);
  }
}
