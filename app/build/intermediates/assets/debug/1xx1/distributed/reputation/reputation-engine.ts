/**
 * 1XX1 Reputation Engine
 * FAZ 4.2 — Node Trust Scoring
 *
 * Her node icin gozlemlenen davranisa gore guven puani (0-100).
 *
 * Metrikler:
 *   rpc_success_rate  — basarili RPC orani
 *   uptime_ratio      — online kalma orani
 *   log_consistency   — Raft log tutarliligi
 *   response_time     — ortalama gecikme (dusuk = iyi)
 *   sybil_flag        — Sybil tespiti
 */

export interface NodeReputation {
  nodeId:          string;
  score:           number;   // 0-100
  rpcSuccessRate:  number;   // 0-1
  uptimeRatio:     number;   // 0-1
  logConsistency:  number;   // 0-1
  avgLatencyMs:    number;
  sybilFlag:       boolean;
  lastUpdated:     number;
  observations:    number;
}

export class ReputationEngine {
  private readonly scores = new Map<string, NodeReputation>();

  /** RPC basarili tamamlandi */
  recordSuccess(nodeId: string, latencyMs: number): void {
    const r = this._get(nodeId);
    r.rpcSuccessRate = this._ewma(r.rpcSuccessRate, 1.0, 0.1);
    r.avgLatencyMs   = this._ewma(r.avgLatencyMs, latencyMs, 0.2);
    r.observations++;
    r.lastUpdated = Date.now();
    this._recalculate(r);
  }

  /** RPC basarisiz oldu */
  recordFailure(nodeId: string): void {
    const r = this._get(nodeId);
    r.rpcSuccessRate = this._ewma(r.rpcSuccessRate, 0.0, 0.2);  // daha hizli dusus
    r.observations++;
    r.lastUpdated = Date.now();
    this._recalculate(r);
  }

  /** Node online goruldu */
  recordOnline(nodeId: string): void {
    const r = this._get(nodeId);
    r.uptimeRatio = this._ewma(r.uptimeRatio, 1.0, 0.05);
    r.lastUpdated = Date.now();
    this._recalculate(r);
  }

  /** Node offline */
  recordOffline(nodeId: string): void {
    const r = this._get(nodeId);
    r.uptimeRatio = this._ewma(r.uptimeRatio, 0.0, 0.05);
    r.lastUpdated = Date.now();
    this._recalculate(r);
  }

  /** Log tutarsizligi tespit edildi */
  recordLogInconsistency(nodeId: string): void {
    const r = this._get(nodeId);
    r.logConsistency = this._ewma(r.logConsistency, 0.0, 0.3);
    r.lastUpdated = Date.now();
    this._recalculate(r);
  }

  /** Sybil tespiti */
  flagSybil(nodeId: string): void {
    const r = this._get(nodeId);
    r.sybilFlag = true;
    r.score     = 0;
    this.scores.set(nodeId, r);
  }

  get(nodeId: string): NodeReputation | undefined {
    return this.scores.get(nodeId);
  }

  all(): NodeReputation[] {
    return Array.from(this.scores.values());
  }

  trusted(minScore = 50): NodeReputation[] {
    return this.all().filter(r => !r.sybilFlag && r.score >= minScore);
  }

  /** Skor 0-100 hesapla */
  private _recalculate(r: NodeReputation): void {
    if (r.sybilFlag) { r.score = 0; return; }

    // Agirliklar
    const rpc     = r.rpcSuccessRate  * 40;
    const uptime  = r.uptimeRatio     * 30;
    const log     = r.logConsistency  * 20;
    const latency = Math.max(0, 10 - (r.avgLatencyMs / 100)); // 0-10 puan

    r.score = Math.round(Math.min(100, rpc + uptime + log + latency));
    this.scores.set(r.nodeId, r);
  }

  /** Exponential weighted moving average */
  private _ewma(prev: number, sample: number, alpha: number): number {
    return prev * (1 - alpha) + sample * alpha;
  }

  private _get(nodeId: string): NodeReputation {
    if (!this.scores.has(nodeId)) {
      this.scores.set(nodeId, {
        nodeId, score: 50,
        rpcSuccessRate: 0.8,  // Yeni node'a makul baslangic
        uptimeRatio:    0.8,
        logConsistency: 1.0,
        avgLatencyMs:   100,
        sybilFlag: false, lastUpdated: Date.now(), observations: 0,
      });
    }
    return this.scores.get(nodeId)!;
  }
}
