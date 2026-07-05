/**
 * 1XX1 Node Runtime — Dağıtık Düğüm Çalışma Ortamı
 * Aşama 14 — V2
 *
 * Tüm katmanları bağlar.
 * Hiçbir katman diğerinin implementasyonunu bilmez — yalnızca arayüzler.
 *
 * Katmanlar:
 *   Transport → Envelope (validate) → Gossip (fan-out) →
 *   Peer (trust) → Sync (conflict) → Snapshot + EventLog → App
 */

import type { ITransport } from "../transport/transport.ts";
import type { ISignatureProvider } from "../security/signature.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { LamportClock } from "../clock/lamport-clock.ts";
import { GossipEngine } from "../gossip/gossip-engine.ts";
import { PeerManager } from "../peer/peer-manager.ts";
import {
  createStoreCollection,
  DeterministicResolver,
  EventLog,
  SnapshotManager,
  type StoreType,
  type VersionedEntry,
} from "../sync/sync-engine.ts";
import { NodeHealthMonitor, MetricsCollector } from "../health/health-monitor.ts";
import { SignatureValidator, computePayloadChecksum } from "../security/signature.ts";
import {
  validateEnvelopeStructure,
  PROTOCOL_VERSION,
  type MessageEnvelope,
  type Topic,
  type GossipDataPayload,
} from "../envelope/message-envelope.ts";

// ─── NodeRuntime Config ───────────────────────────────────────────────────────

export interface NodeRuntimeConfig {
  /** Heartbeat gönderim aralığı (ms) */
  heartbeatIntervalMs:  number;
  /** Snapshot alma aralığı (ms) */
  snapshotIntervalMs:   number;
  /** Health kontrol aralığı (ms) */
  healthCheckIntervalMs: number;
  /** Mesaj TTL */
  defaultTTL:           number;
  /** Gossip fan-out */
  fanout:               number;
}

const DEFAULT_NODE_CONFIG: NodeRuntimeConfig = {
  heartbeatIntervalMs:   5_000,
  snapshotIntervalMs:    60_000,
  healthCheckIntervalMs: 10_000,
  defaultTTL:            8,
  fanout:                6,
};

// ─── NodeRuntime ──────────────────────────────────────────────────────────────

export class NodeRuntime {
  readonly nodeId:   string;
  readonly clock:    LamportClock;
  readonly gossip:   GossipEngine;
  readonly peers:    PeerManager;
  readonly stores:   ReturnType<typeof createStoreCollection>;
  readonly eventLog: EventLog;
  readonly snapshots: SnapshotManager;
  readonly health:   NodeHealthMonitor;
  readonly metrics:  MetricsCollector;

  private readonly transport: ITransport;
  private readonly signer:    ISignatureProvider;
  private readonly validator: SignatureValidator;
  private readonly cfg:       NodeRuntimeConfig;
  private readonly logger:    ILogger | undefined;
  private readonly knownKeys  = new Map<string, string>();

  private _running = false;
  private _heartbeatTimer?: ReturnType<typeof setInterval>;
  private _snapshotTimer?:  ReturnType<typeof setInterval>;
  private _healthTimer?:    ReturnType<typeof setInterval>;

  constructor(
    transport: ITransport,
    signer:    ISignatureProvider,
    cfg:  Partial<NodeRuntimeConfig> = {},
    logger?: ILogger
  ) {
    this.transport = transport;
    this.signer    = signer;
    this.logger    = logger;
    this.nodeId  = transport.nodeId;
    this.cfg     = { ...DEFAULT_NODE_CONFIG, ...cfg };

    this.clock   = new LamportClock();
    this.stores  = createStoreCollection();
    this.eventLog = new EventLog();
    this.snapshots = new SnapshotManager(this.stores, this.eventLog);
    this.health  = new NodeHealthMonitor(logger);
    this.metrics = new MetricsCollector();
    this.peers   = new PeerManager(this.nodeId, {}, logger);

    // Kendi public key'imizi ekle
    this.knownKeys.set(this.nodeId, this.signer.publicKey());
    this.validator = new SignatureValidator(this.signer, this.knownKeys);

    this.gossip  = new GossipEngine(
      this.transport,
      this.clock,
      this.signer,
      { fanout: this.cfg.fanout, defaultTTL: this.cfg.defaultTTL },
      logger
    );

    // Gossip handler: gelen mesajları işle
    this.gossip.onMessage((env) => this._processEnvelope(env));
  }

  // ─── Yaşam Döngüsü ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;
    await this.transport.start();
    this._running = true;

    this._heartbeatTimer = setInterval(
      () => this._sendHeartbeat(),
      this.cfg.heartbeatIntervalMs
    );
    this._snapshotTimer = setInterval(
      () => this._takeSnapshot(),
      this.cfg.snapshotIntervalMs
    );
    this._healthTimer = setInterval(
      () => this._checkHealth(),
      this.cfg.healthCheckIntervalMs
    );

    this.logger?.info(`NodeRuntime başladı: ${this.nodeId}`);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    clearInterval(this._heartbeatTimer);
    clearInterval(this._snapshotTimer);
    clearInterval(this._healthTimer);
    await this.transport.stop();
    this._running = false;
    this.logger?.info(`NodeRuntime durduruldu: ${this.nodeId}`);
  }

  isRunning(): boolean { return this._running; }

  // ─── Peer Yönetimi ───────────────────────────────────────────────────────

  addPeer(nodeId: string, publicKey: string, address?: string): void {
    this.knownKeys.set(nodeId, publicKey);
    this.transport.addPeer(nodeId, address);
    this.peers.addPeer({
      nodeId,
      publicKey,
      protocolVersion: PROTOCOL_VERSION,
      userAgent:       "1XX1/0.1.0",
    });
  }

  removePeer(nodeId: string): void {
    this.transport.removePeer(nodeId);
    this.peers.removePeer(nodeId);
    this.knownKeys.delete(nodeId);
  }

  // ─── Veri Yayma ──────────────────────────────────────────────────────────

  async publishData(topic: Topic, key: string, value: unknown): Promise<void> {
    const clockVal = this.clock.tick();
    const payload  = this.stores[topic as StoreType];
    const sig      = await this.signer.sign(new TextEncoder().encode(JSON.stringify({ key, value })));

    (payload as any).put(key, value, this.nodeId, clockVal, sig);

    this.eventLog.append({
      timestamp:  Date.now(),
      clockValue: clockVal,
      nodeId:     this.nodeId,
      storeName:  topic as StoreType,
      eventType:  "put",
      key,
      data:       value,
    });

    const gossipPayload: GossipDataPayload = {
      topic: topic as any,
      key,
      value,
      version: 1,
      origin:  this.nodeId,
    };

    await this.gossip.spread({
      messageType: "gossip:data",
      topic:       topic as any,
      payload:     gossipPayload,
    });

    this.metrics.recordMessage();
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────

  async takeSnapshot(): Promise<ReturnType<SnapshotManager["latest"]>> {
    const t0 = Date.now();
    const snap = await this.snapshots.take(this.nodeId, this.clock.current());
    this.metrics.recordSnapshot(Date.now() - t0);
    return snap;
  }

  // ─── Recovery ────────────────────────────────────────────────────────────

  async recover(snapshot: NonNullable<ReturnType<SnapshotManager["latest"]>>): Promise<void> {
    const t0 = Date.now();
    const restored = this.snapshots.restore(snapshot);
    this.clock.restore(snapshot.clockValue);

    // Event log replay
    const remaining = this.eventLog.since(snapshot.eventLogPosition);
    for (const entry of remaining) {
      this.clock.merge(entry.clockValue);
    }

    this.metrics.recordReplay(Date.now() - t0);
    this.logger?.info(`Recovery: ${restored} kayıt, ${remaining.length} event replay (${Date.now() - t0}ms)`);
  }

  // ─── İstatistikler ───────────────────────────────────────────────────────

  runtimeStats() {
    return {
      nodeId:      this.nodeId,
      running:     this._running,
      clock:       this.clock.current(),
      peers:       this.peers.count(),
      gossip:      this.gossip.stats(),
      health:      this.health.status(),
      stores: {
        projects: this.stores.projects.count(),
        assets:   this.stores.assets.count(),
        channels: this.stores.channels.count(),
        pulse:    this.stores.pulse.count(),
      },
      eventLog:    this.eventLog.count(),
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async _processEnvelope(env: MessageEnvelope): Promise<void> {
    // 1. Yapı doğrulama
    const structOk = validateEnvelopeStructure(env);
    if (!structOk.ok) {
      this.logger?.warn(`Geçersiz envelope: ${structOk.errors.join(", ")}`);
      this.peers.adjustReputation(env.senderNodeId, -5);
      return;
    }

    // 2. Checksum + Signature
    const { checksumOk, signatureOk } = await this.validator.validateEnvelope({
      payload:      env.payload,
      checksum:     env.checksum,
      signature:    env.signature,
      senderNodeId: env.senderNodeId,
    });

    if (!checksumOk) {
      this.logger?.warn(`Checksum hatası: ${env.messageId}`);
      this.peers.adjustReputation(env.senderNodeId, -10);
      return;
    }
    if (!signatureOk && this.knownKeys.has(env.senderNodeId)) {
      this.logger?.warn(`Signature hatası: ${env.senderNodeId}`);
      this.peers.adjustReputation(env.senderNodeId, -20);
      return;
    }

    // 3. Protocol version
    if (env.protocolVersion !== PROTOCOL_VERSION) {
      this.logger?.debug(`Eski protokol: ${env.protocolVersion}`);
      return;
    }

    // 4. TTL
    if (env.ttl <= 0) return;

    // 5. Clock merge
    this.clock.merge(env.logicalClock);

    // 6. Mesaj tipine göre dispatch
    if (env.messageType === "gossip:data") {
      await this._handleGossipData(env);
    } else if (env.messageType === "heartbeat:ping") {
      await this._handleHeartbeat(env);
    }

    this.metrics.recordMessage();
  }

  private async _handleGossipData(env: MessageEnvelope): Promise<void> {
    const payload = env.payload as GossipDataPayload;
    const store   = this.stores[payload.topic as StoreType];
    if (!store) return;

    const clockVal = this.clock.tick();
    const sig      = await this.signer.sign(new TextEncoder().encode(JSON.stringify(payload)));

    const remote: VersionedEntry<unknown> = {
      key:       payload.key,
      value:     payload.value,
      version:   payload.version,
      timestamp: env.timestamp,
      nodeId:    env.senderNodeId,
      clockValue: env.logicalClock,
      signature: env.signature,
    };

    const { accepted } = (store as any).merge(remote);

    if (!accepted) {
      this.metrics.recordConflict();
    }

    this.eventLog.append({
      timestamp:  env.timestamp,
      clockValue: env.logicalClock,
      nodeId:     env.senderNodeId,
      storeName:  payload.topic as StoreType,
      eventType:  "gossip:data",
      key:        payload.key,
      data:       payload.value,
    });
  }

  private async _handleHeartbeat(env: MessageEnvelope): Promise<void> {
    const payload  = env.payload as { snapshotHash: string; clockValue: number };
    const latency  = Date.now() - env.timestamp;
    this.peers.recordHeartbeat(env.senderNodeId, payload.snapshotHash, env.logicalClock, latency);

    // Pong gönder
    const checksum = await computePayloadChecksum({ type: "pong" });
    const sig      = await this.signer.sign(new TextEncoder().encode("pong"));
    const pong     = await import("../envelope/message-envelope.ts")
      .then(({ createEnvelope }) => createEnvelope({
        senderNodeId: this.nodeId,
        messageType:  "heartbeat:pong",
        topic:        "system",
        logicalClock: this.clock.tick(),
        ttl:          1,
        payload:      { type: "pong" },
        checksum,
        signature: sig,
      }));

    await this.transport.send(env.senderNodeId, pong);
  }

  private async _sendHeartbeat(): Promise<void> {
    if (!this._running || this.transport.peers().length === 0) return;
    const snap     = this.snapshots.latest();
    const checksum = await computePayloadChecksum({ type: "ping" });
    const payload  = { snapshotHash: snap?.hash ?? "", clockValue: this.clock.current() };
    const sig      = await this.signer.sign(new TextEncoder().encode(JSON.stringify(payload)));

    const { createEnvelope } = await import("../envelope/message-envelope.ts");
    const env = createEnvelope({
      senderNodeId: this.nodeId,
      messageType:  "heartbeat:ping",
      topic:        "system",
      logicalClock: this.clock.tick(),
      ttl:          1,
      payload,
      checksum,
      signature:    sig,
    });

    await this.transport.broadcast(env);
  }

  private async _takeSnapshot(): Promise<void> {
    if (!this._running) return;
    await this.takeSnapshot();
  }

  private _checkHealth(): void {
    const active = this.peers.activePeers().length;
    const total  = this.peers.count();
    const gossipStats = this.gossip.stats();

    this.health.update({
      activePeers:      active,
      totalPeers:       total,
      queueLength:      gossipStats.messageCacheSize,
      clockDriftMs:     0, // tick farkı Aşama 15'te gelecek
      avgLatencyMs:     0,
      missedHeartbeats: this.peers.checkHeartbeats().length,
    });
  }
}
