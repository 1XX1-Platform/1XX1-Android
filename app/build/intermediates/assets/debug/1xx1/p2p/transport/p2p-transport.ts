/**
 * 1XX1 P2P Transport Adaptörleri
 * Aşama 16 — P2P Asset Transfer
 *
 * IP2PTransport arayüzü — üst katman transport tipini bilmez.
 *
 * Aşama 14 ITransport'tan ayrı tutulur: P2P yalnızca asset/chunk trafiği.
 * Gossip metadata → Aşama 14 transport
 * Asset binary chunk → P2P transport (bu dosya)
 *
 * Ayrım nedeni: QoS. Asset transferi büyük, bant genişliği yoğun.
 * Gossip küçük, hızlı, öncelikli.
 */

import type { IP2PTransport, P2PMessage, P2PMessageHandler } from "../p2p-types.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Memory P2P Transport ────────────────────────────────────────────────────

const _p2pRegistry = new Map<string, MemoryP2PTransport>();

export class MemoryP2PTransport implements IP2PTransport {
  readonly name   = "memory-p2p";
  readonly nodeId: string;

  private _handlers:  P2PMessageHandler[] = [];
  private _peers      = new Set<string>();
  private _started    = false;
  private _sent       = 0;
  private _received   = 0;
  private _dropped    = 0;
  /** Simülasyon: partition */
  private _partitioned = new Set<string>();
  /** Simülasyon: gecikme (ms) */
  private _latencyMs  = 0;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    _p2pRegistry.set(nodeId, this);
  }

  async start(): Promise<void> { this._started = true; }
  async stop():  Promise<void> { this._started = false; _p2pRegistry.delete(this.nodeId); }

  onMessage(h: P2PMessageHandler): void { this._handlers.push(h); }
  addPeer(id: string):    void { this._peers.add(id); }
  removePeer(id: string): void { this._peers.delete(id); }
  peers():       string[]  { return Array.from(this._peers); }
  isConnected(): boolean   { return this._started; }

  async send(toPeerId: string, msg: P2PMessage): Promise<boolean> {
    if (!this._started)                   { this._dropped++; return false; }
    if (this._partitioned.has(toPeerId))  { this._dropped++; return false; }

    const target = _p2pRegistry.get(toPeerId);
    if (!target) { this._dropped++; return false; }

    this._sent++;
    void (async () => {
      if (this._latencyMs > 0) await new Promise((r) => setTimeout(r, this._latencyMs));
      target._deliver(msg, this.nodeId);
    })();
    return true;
  }

  private async _deliver(msg: P2PMessage, from: string): Promise<void> {
    this._received++;
    for (const h of this._handlers) await h(msg, from);
  }

  partition(ids: string[]): void   { for (const id of ids) this._partitioned.add(id); }
  heal(ids?: string[]):     void   { if (ids) ids.forEach((id) => this._partitioned.delete(id)); else this._partitioned.clear(); }
  setLatency(ms: number):  void   { this._latencyMs = ms; }

  metrics() { return { sent: this._sent, received: this._received, dropped: this._dropped }; }

  static clearRegistry(): void { _p2pRegistry.clear(); }
}

// ─── QUIC Transport Stub ──────────────────────────────────────────────────────

/**
 * QUIC stub — Aşama 18'de gerçek implementasyon.
 * QUIC avantajları: 0-RTT, çoklu stream, UDP tabanlı, NAT traversal.
 * node:quic veya @cloudflare/workerd gibi runtime gerektirir.
 */
export class QUICTransportStub implements IP2PTransport {
  readonly name = "quic-p2p";
  constructor(nodeId: string) {
    this.nodeId = nodeId;}

  async start(): Promise<void> {
    // TODO Aşama 18: QUIC listener başlat
  }
  async stop(): Promise<void> {
    // TODO Aşama 18: QUIC connection'ları kapat
  }

  async send(_to: string, _msg: P2PMessage): Promise<boolean> {
    throw new Error("QUICTransport henüz implemente edilmedi. Aşama 18'de aktif olacak.");
  }

  onMessage(_h: P2PMessageHandler): void {}
  addPeer():    void {}
  removePeer(): void {}
  peers():      string[] { return []; }
  isConnected(): boolean { return false; }
}

// ─── libp2p Transport Stub ────────────────────────────────────────────────────

/**
 * libp2p stub — gerçek P2P ağ katmanı.
 * Özellikler: Noise handshake, Yamux multiplexing, DHT peer discovery.
 * Dependency: @libp2p/core — Aşama 18'e ertelendi.
 */
export class LibP2PTransportStub implements IP2PTransport {
  readonly name = "libp2p";
  constructor(nodeId: string) {
    this.nodeId = nodeId;}

  async start(): Promise<void> {
    // TODO Aşama 18: createLibp2p({ ... }).start()
  }
  async stop(): Promise<void> {
    // TODO Aşama 18: libp2p.stop()
  }

  async send(_to: string, _msg: P2PMessage): Promise<boolean> {
    throw new Error("LibP2PTransport henüz implemente edilmedi. Aşama 18'de aktif olacak.");
  }

  onMessage(_h: P2PMessageHandler): void {}
  addPeer():    void {}
  removePeer(): void {}
  peers():      string[] { return []; }
  isConnected(): boolean { return false; }
}
