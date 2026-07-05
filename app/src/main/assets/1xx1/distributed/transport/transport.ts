/**
 * 1XX1 Transport Layer
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 *
 * Hiçbir üst katman transport tipini bilmez.
 * ITransport arayüzü tek kontrat.
 *
 * Mevcut: MemoryTransport (test), stubs (TCP, WS, QUIC, WebRTC, libp2p)
 * İleride: gerçek ağ implementasyonları adapter swap ile
 */

import type { MessageEnvelope } from "../envelope/message-envelope.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Transport Arayüzü ────────────────────────────────────────────────────────

export type MessageHandler = (envelope: MessageEnvelope, fromNodeId: string) => void | Promise<void>;

export interface ITransport {
  readonly name:   string;
  readonly nodeId: string;
  /** Transport'u başlat */
  start(): Promise<void>;
  /** Transport'u durdur */
  stop(): Promise<void>;
  /** Belirli düğüme mesaj gönder */
  send(toNodeId: string, envelope: MessageEnvelope): Promise<void>;
  /** Broadcast (bilinen tüm peer'lara) */
  broadcast(envelope: MessageEnvelope, exclude?: string[]): Promise<void>;
  /** Mesaj alındığında çağrılacak handler */
  onMessage(handler: MessageHandler): void;
  /** Peer ekle */
  addPeer(nodeId: string, address?: string): void;
  /** Peer çıkar */
  removePeer(nodeId: string): void;
  /** Bilinen peer'lar */
  peers(): string[];
  /** Sağlık durumu */
  isConnected(): boolean;
}

// ─── Transport Metrikleri ─────────────────────────────────────────────────────

export interface TransportMetrics {
  sent:     number;
  received: number;
  dropped:  number;
  errors:   number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MemoryTransport — Test ve Simülasyon
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mesajlar in-process Map üzerinden geçer.
 * Gerçek ağ I/O yok — 10.000 node simülasyonu için optimize.
 * Gecikme simülasyonu, paket kaybı ve partition desteği.
 */

const _registry = new Map<string, MemoryTransport>();

export class MemoryTransport implements ITransport {
  readonly name   = "memory";
  readonly nodeId: string;

  private _handlers: MessageHandler[] = [];
  private _peers    = new Set<string>();
  private _started  = false;
  private _metrics: TransportMetrics = { sent: 0, received: 0, dropped: 0, errors: 0 };

  /** Simülasyon: bu node'larla iletişimi kes (partition testi) */
  private _partitioned = new Set<string>();
  /** Yapay gecikme (ms) */
  private _latencyMs = 0;
  /** Paket kaybı oranı 0–1 */
  private _dropRate  = 0;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    _registry.set(nodeId, this);
  }

  async start(): Promise<void> { this._started = true; }
  async stop():  Promise<void> {
    this._started = false;
    _registry.delete(this.nodeId);
  }

  onMessage(handler: MessageHandler): void {
    this._handlers.push(handler);
  }

  addPeer(nodeId: string):    void { this._peers.add(nodeId); }
  removePeer(nodeId: string): void { this._peers.delete(nodeId); }
  peers():                  string[] { return Array.from(this._peers); }
  isConnected():           boolean { return this._started; }

  /** Mesaj kopyalama orani 0-1 (duplicate delivery) */
  private _duplicateRate = 0;
  /** Mesaj sirasi karistirma: true ise rastgele gecikme ile reorder */
  private _reorderEnabled = false;

  async send(toNodeId: string, envelope: MessageEnvelope): Promise<void> {
    if (!this._started) { this._metrics.dropped++; return; }
    if (this._partitioned.has(toNodeId)) { this._metrics.dropped++; return; }
    if (Math.random() < this._dropRate) { this._metrics.dropped++; return; }

    const target = _registry.get(toNodeId);
    if (!target) { this._metrics.errors++; return; }

    this._metrics.sent++;

    const dispatch = async (extraDelay = 0) => {
      // Reorder: rastgele 0-200ms ek gecikme
      const reorderMs = this._reorderEnabled ? Math.random() * 200 : 0;
      const totalMs   = this._latencyMs + extraDelay + reorderMs;
      if (totalMs > 0) {
        await new Promise((r) => setTimeout(r, totalMs));
      }
      await target._receive(envelope, this.nodeId);
    };

    // Non-blocking delivery
    void dispatch();

    // Duplicate: ayni mesaji bir kez daha gonder
    if (Math.random() < this._duplicateRate) {
      this._metrics.sent++;
      void dispatch(Math.random() * 50); // 0-50ms sonra duplicate
    }
  }

  async broadcast(envelope: MessageEnvelope, exclude: string[] = []): Promise<void> {
    const excluded = new Set(exclude);
    await Promise.all(
      Array.from(this._peers)
        .filter((p) => !excluded.has(p) && p !== this.nodeId)
        .map((p) => this.send(p, envelope))
    );
  }

  /** Gelen mesajı işle */
  private async _receive(envelope: MessageEnvelope, fromNodeId: string): Promise<void> {
    this._metrics.received++;
    for (const h of this._handlers) {
      await h(envelope, fromNodeId);
    }
  }

  // ── Simülasyon Kontrolleri ────────────────────────────────────────────────

  /** Network partition simülasyonu */
  partition(nodeIds: string[]): void {
    for (const id of nodeIds) this._partitioned.add(id);
  }

  /** Partition'ı kaldır */
  heal(nodeIds?: string[]): void {
    if (nodeIds) { for (const id of nodeIds) this._partitioned.delete(id); }
    else          this._partitioned.clear();
  }

  setLatency(ms: number):       void { this._latencyMs      = ms; }
  setDropRate(rate: number):    void { this._dropRate        = Math.max(0, Math.min(1, rate)); }
  setDuplicateRate(rate: number): void { this._duplicateRate = Math.max(0, Math.min(1, rate)); }
  setReorder(enabled: boolean): void { this._reorderEnabled  = enabled; }

  /** Tum chaos parametrelerini sifirla */
  resetChaos(): void {
    this._latencyMs      = 0;
    this._dropRate       = 0;
    this._duplicateRate  = 0;
    this._reorderEnabled = false;
    this._partitioned.clear();
  }

  metrics(): TransportMetrics { return { ...this._metrics }; }

  /** Test sonrası registry temizle */
  static clearRegistry(): void { _registry.clear(); }

  /** Tüm kayıtlı transport'lar */
  static registeredNodes(): string[] { return Array.from(_registry.keys()); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transport Stubs — İleride Gerçek Implementasyonla Değiştirilecek
// ═══════════════════════════════════════════════════════════════════════════════

export class TCPTransportStub implements ITransport {
  readonly name = "tcp";
  constructor(nodeId: string, address: string) {
    this.address = address;
    this.nodeId = nodeId;}
  async start(): Promise<void> {}
  async stop():  Promise<void> {}
  async send():  Promise<void> { throw new Error("TCPTransport: henüz implemente edilmedi"); }
  async broadcast(): Promise<void> {}
  onMessage(): void {}
  addPeer():   void {}
  removePeer(): void {}
  peers():     string[] { return []; }
  isConnected(): boolean { return false; }
}

export class WebSocketTransportStub implements ITransport {
  readonly name = "websocket";
  constructor(nodeId: string) {
    this.nodeId = nodeId;}
  async start(): Promise<void> {}
  async stop():  Promise<void> {}
  async send():  Promise<void> { throw new Error("WebSocketTransport: henüz implemente edilmedi"); }
  async broadcast(): Promise<void> {}
  onMessage(): void {}
  addPeer():   void {}
  removePeer(): void {}
  peers():     string[] { return []; }
  isConnected(): boolean { return false; }
}

export class QUICTransportStub implements ITransport {
  readonly name = "quic";
  constructor(nodeId: string) {
    this.nodeId = nodeId;}
  async start(): Promise<void> {}
  async stop():  Promise<void> {}
  async send():  Promise<void> { throw new Error("QUICTransport: stub"); }
  async broadcast(): Promise<void> {}
  onMessage(): void {}
  addPeer():   void {}
  removePeer(): void {}
  peers():     string[] { return []; }
  isConnected(): boolean { return false; }
}
