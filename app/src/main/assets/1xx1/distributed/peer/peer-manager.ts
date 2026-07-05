/**
 * 1XX1 Peer Manager
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 *
 * Peer yalnızca public key değildir.
 * PeerState tüm düğüm bilgilerini taşır.
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Node Identity ────────────────────────────────────────────────────────────

export interface NodeIdentity {
  nodeId:          string;
  publicKey:       string;
  protocolVersion: string;
  /** "1XX1/0.1.0" gibi ajan tanımlayıcısı */
  userAgent:       string;
}

// ─── Node Capabilities ───────────────────────────────────────────────────────

export interface NodeCapabilities {
  /** Snapshot sunabilir mi? */
  canServeSnapshot:   boolean;
  /** Sync delta sunabilir mi? */
  canServeDelta:      boolean;
  /** Sandbox çalıştırabiliyor mu? */
  hasSandbox:         boolean;
  /** Desteklenen protokol versiyonları */
  supportedVersions:  string[];
}

// ─── Trust Level ─────────────────────────────────────────────────────────────

export type TrustLevel =
  | "unknown"    // henüz bilinmiyor
  | "observed"   // gözlemlendi, doğrulanmadı
  | "verified"   // imza doğrulandı
  | "trusted"    // uzun süreli güvenilir
  | "banned";    // yasaklı

// ─── Peer State ───────────────────────────────────────────────────────────────

export interface PeerState {
  identity:          NodeIdentity;
  capabilities:      NodeCapabilities;
  trustLevel:        TrustLevel;
  firstSeen:         Date;
  lastSeen:          Date;
  lastHeartbeat:     Date | null;
  lastSnapshotHash:  string;
  observedClock:     number;
  latencyMs:         number | null;      // son ölçülen gecikme
  avgLatencyMs:      number | null;      // hareketli ortalama
  reputation:        number;             // -100..100
  missedHeartbeats:  number;
  banReason?:        string;
  banExpiresAt?:     Date;
}

// ─── Peer Manager ────────────────────────────────────────────────────────────

export interface PeerManagerConfig {
  /** Kalp atışı zaman aşımı (ms) */
  heartbeatTimeoutMs:    number;
  /** Ardışık kaçırılan kalp atışı → DEGRADED */
  maxMissedHeartbeats:   number;
  /** Bant genişliği ölçümü penceresi (sample sayısı) */
  latencySamples:        number;
  /** İtibar puanı sınırı: altında → ban */
  banThreshold:          number;
}

const DEFAULT_PEER_CONFIG: PeerManagerConfig = {
  heartbeatTimeoutMs:  15_000,  // 15 saniye
  maxMissedHeartbeats: 3,
  latencySamples:      10,
  banThreshold:        -80,
};

export class PeerManager {
  private readonly peers = new Map<string, PeerState>();
  private readonly latencyHistory = new Map<string, number[]>();
  private readonly cfg: PeerManagerConfig;

  constructor(
    localNodeId: string,
    cfg: Partial<PeerManagerConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.localNodeId = localNodeId;
    this.cfg = { ...DEFAULT_PEER_CONFIG, ...cfg };
  }

  // ─── Peer Yönetimi ───────────────────────────────────────────────────────

  addPeer(identity: NodeIdentity, caps?: Partial<NodeCapabilities>): PeerState {
    const existing = this.peers.get(identity.nodeId);
    if (existing) {
      const updated: PeerState = {
        ...existing,
        identity,
        capabilities: { ...existing.capabilities, ...caps },
        lastSeen: new Date(),
      };
      this.peers.set(identity.nodeId, updated);
      return updated;
    }

    const state: PeerState = {
      identity,
      capabilities: {
        canServeSnapshot:  caps?.canServeSnapshot  ?? false,
        canServeDelta:     caps?.canServeDelta      ?? false,
        hasSandbox:        caps?.hasSandbox         ?? false,
        supportedVersions: caps?.supportedVersions ?? ["1.0.0"],
      },
      trustLevel:        "observed",
      firstSeen:         new Date(),
      lastSeen:          new Date(),
      lastHeartbeat:     null,
      lastSnapshotHash:  "",
      observedClock:     0,
      latencyMs:         null,
      avgLatencyMs:      null,
      reputation:        0,
      missedHeartbeats:  0,
    };

    this.peers.set(identity.nodeId, state);
    this.logger?.info(`Yeni peer: ${identity.nodeId} (${identity.protocolVersion})`);
    return state;
  }

  removePeer(nodeId: string): void {
    this.peers.delete(nodeId);
    this.latencyHistory.delete(nodeId);
    this.logger?.info(`Peer kaldırıldı: ${nodeId}`);
  }

  // ─── Heartbeat ───────────────────────────────────────────────────────────

  recordHeartbeat(
    nodeId:       string,
    snapshotHash: string,
    clockValue:   number,
    latencyMs:    number
  ): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;

    this._updateLatency(nodeId, latencyMs);

    const updated: PeerState = {
      ...peer,
      lastHeartbeat:    new Date(),
      lastSeen:         new Date(),
      lastSnapshotHash: snapshotHash,
      observedClock:    clockValue,
      latencyMs,
      avgLatencyMs:     this._avgLatency(nodeId),
      missedHeartbeats: 0,
    };
    this.peers.set(nodeId, updated);
  }

  /** Periyodik çalışır: heartbeat timeout kontrolü */
  checkHeartbeats(): string[] {
    const timedOut: string[] = [];
    const cutoff  = Date.now() - this.cfg.heartbeatTimeoutMs;

    for (const [id, peer] of this.peers) {
      if (peer.trustLevel === "banned") continue;
      const lastHb = peer.lastHeartbeat?.getTime() ?? 0;
      if (lastHb < cutoff) {
        const missed = peer.missedHeartbeats + 1;
        this.peers.set(id, { ...peer, missedHeartbeats: missed });
        if (missed >= this.cfg.maxMissedHeartbeats) {
          timedOut.push(id);
          this.logger?.warn(`Peer timeout: ${id} (${missed} kalp atışı kaçırıldı)`);
        }
      }
    }
    return timedOut;
  }

  // ─── Trust ve Reputation ─────────────────────────────────────────────────

  promote(nodeId: string, to: TrustLevel): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    this.peers.set(nodeId, { ...peer, trustLevel: to });
    this.logger?.debug(`Peer trust: ${nodeId} → ${to}`);
  }

  adjustReputation(nodeId: string, delta: number): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    const newRep = Math.max(-100, Math.min(100, peer.reputation + delta));
    this.peers.set(nodeId, { ...peer, reputation: newRep });

    if (newRep <= this.cfg.banThreshold) {
      this.ban(nodeId, `İtibar puanı sınırın altında: ${newRep}`, 60 * 60_000);
    }
  }

  ban(nodeId: string, reason: string, durationMs = 60 * 60_000): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    this.peers.set(nodeId, {
      ...peer,
      trustLevel:  "banned",
      banReason:   reason,
      banExpiresAt: new Date(Date.now() + durationMs),
    });
    this.logger?.warn(`Peer yasaklandı: ${nodeId} — ${reason}`);
  }

  isBanned(nodeId: string): boolean {
    const peer = this.peers.get(nodeId);
    if (!peer || peer.trustLevel !== "banned") return false;
    // Süre dolduysa otomatik kaldır
    if (peer.banExpiresAt && peer.banExpiresAt < new Date()) {
      this.peers.set(nodeId, { ...peer, trustLevel: "observed", banReason: undefined });
      return false;
    }
    return true;
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  get(nodeId: string): PeerState | undefined { return this.peers.get(nodeId); }
  all(): PeerState[] { return Array.from(this.peers.values()); }
  count(): number    { return this.peers.size; }

  /** Snapshot sunabilecek ve güvenilen peer'lar */
  snapshotProviders(): PeerState[] {
    return this.all().filter((p) =>
      p.capabilities.canServeSnapshot &&
      p.trustLevel !== "banned" &&
      p.trustLevel !== "unknown"
    );
  }

  /** Aktif peer'lar (son heartbeat timeout içinde) */
  activePeers(): PeerState[] {
    const cutoff = Date.now() - this.cfg.heartbeatTimeoutMs;
    return this.all().filter((p) =>
      p.trustLevel !== "banned" &&
      (p.lastHeartbeat?.getTime() ?? 0) >= cutoff
    );
  }

  // ─── Latency ─────────────────────────────────────────────────────────────

  private _updateLatency(nodeId: string, ms: number): void {
    if (!this.latencyHistory.has(nodeId)) this.latencyHistory.set(nodeId, []);
    const hist = this.latencyHistory.get(nodeId)!;
    hist.push(ms);
    if (hist.length > this.cfg.latencySamples) hist.shift();
  }

  private _avgLatency(nodeId: string): number | null {
    const hist = this.latencyHistory.get(nodeId);
    if (!hist || hist.length === 0) return null;
    return hist.reduce((a, b) => a + b, 0) / hist.length;
  }
}
