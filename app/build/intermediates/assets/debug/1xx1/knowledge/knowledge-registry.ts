/**
 * 1XX1 Knowledge Registry — FAZ 10 Block 1
 *
 * Runtime'in gecmis deneyimlerinden yararlanmasini saglar.
 * PolicyEngine'in yerine GECMEZ — sadece veri saglar.
 *
 * Deterministik kalir:
 *   Kendini degistiren kural YOK
 *   Otomatik policy uretimi YOK
 *   Model egitimi YOK
 */

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type PluginKnowledge = {
  pluginId:          string;
  name:              string;
  version:           string;
  capabilities:      string[];          // ne yapabilir
  compatibleWith:    string[];          // hangi plugin'lerle uyumlu
  knownIssues:       string[];          // bilinen sorunlar
  preferredPolicies: string[];          // tercih edilen policy'ler
  statistics: {
    totalRuns:       number;
    successRate:     number;            // 0-1
    avgLatencyMs:    number;
    rollbackCount:   number;
    quarantineCount: number;
    conflictCount:   number;
    lastUpdated:     number;
  };
  knowledgeScore:    number;            // 0-1, bilgi temelli guven
};

export type KnowledgeSnapshot = {
  snapshotId:   string;
  takenAt:      number;
  pluginCount:  number;
  summary:      Record<string, { score: number; state: string }>;
};

// ─── Knowledge Registry ───────────────────────────────────────────────────────

export class KnowledgeRegistry {
  private records   = new Map<string, PluginKnowledge>();
  private snapshots: KnowledgeSnapshot[] = [];

  // ─── Kayit yonetimi ──────────────────────────────────────────────────────

  upsert(pluginId: string, partial: Partial<PluginKnowledge>): void {
    const existing = this.records.get(pluginId) ?? this._default(pluginId);
    const merged   = { ...existing, ...partial, pluginId };
    merged.statistics = { ...existing.statistics, ...(partial.statistics ?? {}) };
    merged.knowledgeScore = this._calcScore(merged);
    this.records.set(pluginId, merged);
  }

  /** Runtime'dan gelen telemetry ile istatistik guncelle */
  recordRun(pluginId: string, success: boolean, latencyMs: number): void {
    const k = this.records.get(pluginId) ?? this._default(pluginId);
    const s = k.statistics;
    s.totalRuns++;
    // EWMA success rate
    s.successRate   = 0.05 * (success ? 1 : 0) + 0.95 * s.successRate;
    s.avgLatencyMs  = 0.1 * latencyMs + 0.9 * s.avgLatencyMs;
    s.lastUpdated   = Date.now();
    k.knowledgeScore = this._calcScore(k);
    this.records.set(pluginId, k);
  }

  recordRollback(pluginId: string): void {
    const k = this.records.get(pluginId) ?? this._default(pluginId);
    k.statistics.rollbackCount++;
    k.statistics.lastUpdated = Date.now();
    k.knowledgeScore = this._calcScore(k);
    this.records.set(pluginId, k);
  }

  recordQuarantine(pluginId: string): void {
    const k = this.records.get(pluginId) ?? this._default(pluginId);
    k.statistics.quarantineCount++;
    k.statistics.lastUpdated = Date.now();
    k.knowledgeScore = this._calcScore(k);
    this.records.set(pluginId, k);
  }

  get(pluginId: string): PluginKnowledge | null {
    return this.records.get(pluginId) ?? null;
  }

  all(): PluginKnowledge[] { return [...this.records.values()]; }

  // ─── Snapshot ────────────────────────────────────────────────────────────

  takeSnapshot(): KnowledgeSnapshot {
    const snap: KnowledgeSnapshot = {
      snapshotId:  `snap-${Date.now()}`,
      takenAt:     Date.now(),
      pluginCount: this.records.size,
      summary:     {},
    };
    for (const [id, k] of this.records) {
      snap.summary[id] = { score: k.knowledgeScore, state: this._stateFromScore(k.knowledgeScore) };
    }
    this.snapshots.push(snap);
    if (this.snapshots.length > 50) this.snapshots.shift();
    return snap;
  }

  latestSnapshot(): KnowledgeSnapshot | null {
    return this.snapshots.at(-1) ?? null;
  }

  /** Restart sonrasi hizli yukleme */
  restoreFromSnapshot(snap: KnowledgeSnapshot): void {
    for (const [id, s] of Object.entries(snap.summary)) {
      if (!this.records.has(id)) {
        const k = this._default(id);
        k.knowledgeScore = s.score;
        this.records.set(id, k);
      }
    }
  }

  // ─── Knowledge Scoring ────────────────────────────────────────────────────

  private _calcScore(k: PluginKnowledge): number {
    const s = k.statistics;
    if (s.totalRuns === 0) return 0.5; // bilgi yok → neutral

    // Pozitif sinyaller
    const success   = s.successRate * 0.5;
    const latency   = Math.max(0, 1 - s.avgLatencyMs / 1000) * 0.2;

    // Negatif sinyaller (decay with run count)
    const rollbackPenalty   = Math.min(0.3, s.rollbackCount   / Math.max(s.totalRuns, 1) * 2);
    const quarantinePenalty = Math.min(0.2, s.quarantineCount / Math.max(s.totalRuns, 1) * 3);

    return Math.max(0, Math.min(1, success + latency - rollbackPenalty - quarantinePenalty));
  }

  private _stateFromScore(score: number): string {
    return score >= 0.8 ? "trusted" : score >= 0.5 ? "neutral" : "suspect";
  }

  private _default(pluginId: string): PluginKnowledge {
    return {
      pluginId, name: pluginId, version: "unknown",
      capabilities: [], compatibleWith: [], knownIssues: [], preferredPolicies: [],
      statistics: { totalRuns: 0, successRate: 0.8, avgLatencyMs: 100, rollbackCount: 0, quarantineCount: 0, conflictCount: 0, lastUpdated: Date.now() },
      knowledgeScore: 0.5,
    };
  }
}
