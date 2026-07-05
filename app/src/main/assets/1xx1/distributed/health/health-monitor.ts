/**
 * 1XX1 Node Health Monitor + Metrics Telemetry
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Node Health Durumları ────────────────────────────────────────────────────

export type NodeHealthStatus = "ACTIVE" | "DEGRADED" | "ISOLATED" | "OFFLINE";

export interface NodeHealthSnapshot {
  status:          NodeHealthStatus;
  timestamp:       Date;
  peerCount:       number;
  activePeers:     number;
  queueLength:     number;
  clockDriftMs:    number;
  avgLatencyMs:    number;
  missedHeartbeats: number;
  issues:          string[];
}

// ─── NodeHealthMonitor ────────────────────────────────────────────────────────

export class NodeHealthMonitor {
  private _status:          NodeHealthStatus = "ACTIVE";
  private _queueLength      = 0;
  private _clockDrift       = 0;
  private _avgLatency       = 0;
  private _missedHeartbeats = 0;
  private _activePeers      = 0;
  private _totalPeers       = 0;
  private readonly history: NodeHealthSnapshot[] = [];
  private readonly maxHistory = 20;

  constructor(logger?: ILogger) {
    this.logger = logger;}

  update(params: {
    activePeers:     number;
    totalPeers:      number;
    queueLength:     number;
    clockDriftMs:    number;
    avgLatencyMs:    number;
    missedHeartbeats: number;
  }): NodeHealthSnapshot {
    Object.assign(this, {
      _activePeers:      params.activePeers,
      _totalPeers:       params.totalPeers,
      _queueLength:      params.queueLength,
      _clockDrift:       params.clockDriftMs,
      _avgLatency:       params.avgLatencyMs,
      _missedHeartbeats: params.missedHeartbeats,
    });

    const issues: string[] = [];
    let status: NodeHealthStatus = "ACTIVE";

    if (params.activePeers === 0 && params.totalPeers > 0) {
      status = "ISOLATED";
      issues.push("Aktif peer yok — izole edilmiş");
    } else if (params.activePeers === 0) {
      status = "OFFLINE";
      issues.push("Peer bağlantısı yok");
    } else if (params.clockDriftMs > 5000) {
      status = "DEGRADED";
      issues.push(`Saat kayması yüksek: ${params.clockDriftMs}ms`);
    } else if (params.queueLength > 10_000) {
      status = "DEGRADED";
      issues.push(`Kuyruk doldu: ${params.queueLength} mesaj`);
    } else if (params.avgLatencyMs > 1000) {
      status = "DEGRADED";
      issues.push(`Yüksek gecikme: ${params.avgLatencyMs}ms`);
    }

    this._status = status;

    const snap: NodeHealthSnapshot = {
      status, timestamp: new Date(),
      peerCount: params.totalPeers,
      activePeers: params.activePeers,
      queueLength: params.queueLength,
      clockDriftMs: params.clockDriftMs,
      avgLatencyMs: params.avgLatencyMs,
      missedHeartbeats: params.missedHeartbeats,
      issues,
    };

    this.history.unshift(snap);
    if (this.history.length > this.maxHistory) this.history.pop();

    if (status !== "ACTIVE") {
      this.logger?.warn(`Node health: ${status} — ${issues.join("; ")}`);
    }

    return snap;
  }

  status():  NodeHealthStatus  { return this._status; }
  isActive(): boolean           { return this._status === "ACTIVE"; }
  recent(n = 5): NodeHealthSnapshot[] { return this.history.slice(0, n); }
}

// ─── Metrics Telemetry ────────────────────────────────────────────────────────

export interface NodeMetrics {
  /** Saniye başına mesaj */
  messagesPerSec:  number;
  /** Saniye başına sync */
  syncPerSec:      number;
  /** Toplam conflict sayısı */
  conflictCount:   number;
  /** Toplam replay süresi (ms) */
  totalReplayMs:   number;
  /** Son snapshot süresi (ms) */
  lastSnapshotMs:  number;
  /** Ortalama gecikme (ms) */
  avgLatencyMs:    number;
  /** Fan-out */
  fanout:          number;
  /** Kuyruk uzunluğu */
  queueLength:     number;
  /** Bellek kullanımı (byte) */
  memoryBytes:     number;
  /** CPU süresi (ms) */
  cpuMs:           number;
  /** Ölçüm zamanı */
  sampledAt:       Date;
}

export class MetricsCollector {
  private _msgCount       = 0;
  private _syncCount      = 0;
  private _conflictCount  = 0;
  private _totalReplayMs  = 0;
  private _lastSnapshotMs = 0;
  private _window         = Date.now();
  private readonly snapshots: NodeMetrics[] = [];

  recordMessage():                   void { this._msgCount++; }
  recordSync():                      void { this._syncCount++; }
  recordConflict():                  void { this._conflictCount++; }
  recordReplay(ms: number):          void { this._totalReplayMs += ms; }
  recordSnapshot(ms: number):        void { this._lastSnapshotMs = ms; }

  sample(extras: Partial<NodeMetrics> = {}): NodeMetrics {
    const now    = Date.now();
    const elapsedS = (now - this._window) / 1000;

    const metrics: NodeMetrics = {
      messagesPerSec:  elapsedS > 0 ? this._msgCount  / elapsedS : 0,
      syncPerSec:      elapsedS > 0 ? this._syncCount / elapsedS : 0,
      conflictCount:   this._conflictCount,
      totalReplayMs:   this._totalReplayMs,
      lastSnapshotMs:  this._lastSnapshotMs,
      avgLatencyMs:    extras.avgLatencyMs ?? 0,
      fanout:          extras.fanout       ?? 6,
      queueLength:     extras.queueLength  ?? 0,
      memoryBytes:     extras.memoryBytes  ?? 0,
      cpuMs:           extras.cpuMs        ?? 0,
      sampledAt:       new Date(),
    };

    this.snapshots.unshift(metrics);
    if (this.snapshots.length > 60) this.snapshots.pop();

    // Pencereyi sıfırla
    this._msgCount  = 0;
    this._syncCount = 0;
    this._window    = now;

    return metrics;
  }

  history(n = 10): NodeMetrics[] { return this.snapshots.slice(0, n); }
  conflictCount(): number         { return this._conflictCount; }
}
