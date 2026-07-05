/**
 * 1XX1 Link Manager
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Kaptan'ın mimari incelemesinden: "MeshTransportAdapter ile BLE arasına
 * LinkManager koyardım. Aynı anda BLE var, WiFi Direct var, LAN var —
 * hangisini kullanacağız?"
 *
 * LinkManager tek sorumluluk:
 *   Mevcut fiziksel transport'lardan EN İYİSİNİ SEÇ.
 *
 * Seçim kriterleri (öncelik sırasıyla):
 *   1. Bağlantı durumu (online mu?)
 *   2. Bant genişliği (LAN > WiFi Direct > BLE)
 *   3. Gecikme (düşük latency önce)
 *   4. Pil durumu (mobil cihazda BLE daha az pil yer)
 */

import type { ITransport, MessageHandler } from "../../distributed/transport/transport.ts";
import type { MessageEnvelope } from "../../distributed/envelope/message-envelope.ts";
import type { GhostLinkContext } from "../ghost/ghost-types.ts";

// ─── Transport Profili ────────────────────────────────────────────────────────

export interface TransportProfile {
  transport:         ITransport;
  /** Transport türü — seçim kararı için */
  type:              "ble" | "wifi-direct" | "lan" | "memory" | "quic";
  /** Teorik bant genişliği (Mbps) */
  bandwidthMbps:     number;
  /** Pil tüketim faktörü 0.0 (az) - 1.0 (çok) */
  batteryDrain:      number;
  /** Öncelik ağırlığı (yüksek = öncelikli) */
  priority:          number;
}

/** Varsayılan transport profilleri */
export const TRANSPORT_PROFILES: Record<string, Omit<TransportProfile, "transport">> = {
  lan:          { type: "lan",          bandwidthMbps: 100,  batteryDrain: 0.1, priority: 100 },
  "wifi-direct": { type: "wifi-direct", bandwidthMbps: 250,  batteryDrain: 0.4, priority: 90  },
  quic:         { type: "quic",         bandwidthMbps: 50,   batteryDrain: 0.3, priority: 80  },
  memory:       { type: "memory",       bandwidthMbps: 9999, batteryDrain: 0.0, priority: 70  }, // test
  ble:          { type: "ble",          bandwidthMbps: 1,    batteryDrain: 0.15, priority: 50 },
};

// ─── Seçim Skoru ──────────────────────────────────────────────────────────────

function score(profile: TransportProfile, payloadSizeBytes: number, batteryMode: boolean): number {
  if (!profile.transport.isConnected()) return -1; // kullanılamaz

  const bwScore      = Math.log2(profile.bandwidthMbps + 1) * 20;
  const batteryScore = batteryMode ? (1 - profile.batteryDrain) * 30 : 0;
  const prioScore    = profile.priority;

  // Büyük payload → yüksek bant genişliği daha önemli
  const sizeBonus = payloadSizeBytes > 1024 * 1024
    ? profile.bandwidthMbps * 0.5
    : 0;

  return bwScore + batteryScore + prioScore + sizeBonus;
}

// ─── LinkManager ─────────────────────────────────────────────────────────────

export class LinkManager implements ITransport {
  readonly name   = "link-manager";
  readonly nodeId: string;

  private readonly _profiles: TransportProfile[] = [];
  private readonly _handlers: MessageHandler[] = [];
  private _started = false;
  private _batteryMode = false; // pil tasarrufu modu

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /** Transport ekle */
  register(profile: TransportProfile): void {
    this._profiles.push(profile);
    // Her transport'tan gelen mesajları dinle
    profile.transport.onMessage(async (env, from) => {
      for (const h of this._handlers) await h(env, from);
    });
  }

  /** Pil tasarrufu modu aç/kapat */
  setBatteryMode(enabled: boolean): void {
    this._batteryMode = enabled;
  }

  /** Mevcut en iyi transport'u döndür */
  best(payloadSizeBytes = 0): TransportProfile | null {
    let best: TransportProfile | null = null;
    let bestScore = -Infinity;

    for (const p of this._profiles) {
      const s = score(p, payloadSizeBytes, this._batteryMode);
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    return best;
  }

  /** Ghost LinkContext — altındaki en iyi transport'a göre hesapla */
  linkContext(payloadSizeBytes = 0): GhostLinkContext {
    const b = this.best(payloadSizeBytes);
    if (!b) return { nodeDensity: 1, linkQuality: 0.3, bandwidthFactor: 0.1 };

    const factorMap: Record<string, number> = {
      lan: 1.0, "wifi-direct": 0.5, quic: 0.4, memory: 1.0, ble: 0.1,
    };
    return {
      nodeDensity:     this.peers().length,
      linkQuality:     b.transport.isConnected() ? 0.9 : 0.3,
      bandwidthFactor: factorMap[b.type] ?? 0.3,
    };
  }

  // ─── ITransport implementasyonu ────────────────────────────────────────────

  async start(): Promise<void> {
    await Promise.all(this._profiles.map((p) => p.transport.start()));
    this._started = true;
  }

  async stop(): Promise<void> {
    await Promise.all(this._profiles.map((p) => p.transport.stop()));
    this._started = false;
  }

  async send(toNodeId: string, envelope: MessageEnvelope): Promise<void> {
    const payloadSize = JSON.stringify(envelope).length;
    const b = this.best(payloadSize);
    if (!b) return;
    await b.transport.send(toNodeId, envelope);
  }

  async broadcast(envelope: MessageEnvelope, exclude: string[] = []): Promise<void> {
    const b = this.best();
    if (!b) return;
    await b.transport.broadcast(envelope, exclude);
  }

  onMessage(handler: MessageHandler): void {
    this._handlers.push(handler);
  }

  addPeer(nodeId: string, address?: string): void {
    for (const p of this._profiles) p.transport.addPeer(nodeId, address);
  }

  removePeer(nodeId: string): void {
    for (const p of this._profiles) p.transport.removePeer(nodeId);
  }

  peers(): string[] {
    const all = new Set<string>();
    for (const p of this._profiles) p.transport.peers().forEach((id) => all.add(id));
    return Array.from(all);
  }

  isConnected(): boolean {
    return this._started && this._profiles.some((p) => p.transport.isConnected());
  }

  /** Durum raporu */
  status(): Array<{ type: string; connected: boolean; bandwidthMbps: number; score: number }> {
    return this._profiles.map((p) => ({
      type:          p.type,
      connected:     p.transport.isConnected(),
      bandwidthMbps: p.bandwidthMbps,
      score:         score(p, 0, this._batteryMode),
    }));
  }
}
