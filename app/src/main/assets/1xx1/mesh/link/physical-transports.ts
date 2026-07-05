/**
 * 1XX1 Fiziksel Transport Adaptorleri
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * LANTransport  - UDP multicast, Termux dahil gercek calisir
 * BLETransport  - Bluetooth Low Energy stub
 * WiFiDirect    - Wi-Fi Direct stub
 */

import * as dgram from "node:dgram";
import type { ITransport, MessageHandler } from "../../distributed/transport/transport.ts";
import type { MessageEnvelope } from "../../distributed/envelope/message-envelope.ts";
import type { ILogger } from "../../core/interfaces.ts";

const LAN_MULTICAST_ADDR = "239.255.13.31";
const LAN_PORT           = 13310;
const LAN_BEACON_MS      = 3000;

// ─── LANTransport ─────────────────────────────────────────────────────────────

export class LANTransport implements ITransport {
  readonly name = "lan";
  readonly nodeId: string;
  private readonly _port: number;
  private readonly _logger: ILogger | undefined;
  private readonly _handlers: MessageHandler[] = [];
  private readonly _peers: Map<string, { address: string; port: number; lastSeen: number }> = new Map();
  private _socket: dgram.Socket | undefined;
  private _beacon: ReturnType<typeof setInterval> | undefined;
  private _started = false;

  constructor(nodeId: string, port: number = LAN_PORT, logger?: ILogger) {
    this.nodeId   = nodeId;
    this._port    = port;
    this._logger  = logger;
  }

  async start(): Promise<void> {
    const self = this;
    return new Promise((resolve, reject) => {
      self._socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      self._socket.on("error", (err) => {
        self._logger?.error("LANTransport hata: " + err.message);
        if (!self._started) reject(err);
      });

      self._socket.on("message", (buf, rinfo) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg._type === "beacon") {
            if (msg.nodeId && msg.nodeId !== self.nodeId) {
              self._peers.set(msg.nodeId, {
                address:  rinfo.address,
                port:     msg.port ?? self._port,
                lastSeen: Date.now(),
              });
              self._logger?.debug("LAN peer kesfedildi: " + msg.nodeId + " @ " + rinfo.address);
            }
            return;
          }
          for (const handler of self._handlers) {
            handler(msg as MessageEnvelope, msg.senderNodeId ?? rinfo.address);
          }
        } catch (_e) { /* gecersiz paket */ }
      });

      self._socket.bind(self._port, () => {
        try {
          self._socket!.addMembership(LAN_MULTICAST_ADDR);
          self._socket!.setMulticastLoopback(true);
        } catch (_e) { /* multicast desteklenmiyorsa atla */ }

        self._started = true;
        self._beacon  = setInterval(() => self._sendBeacon(), LAN_BEACON_MS);
        self._sendBeacon();
        self._logger?.info("LANTransport basladi: port=" + self._port);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this._beacon) clearInterval(this._beacon);
    const self = this;
    await new Promise<void>((r) => {
      if (self._socket) self._socket.close(r);
      else r();
    });
    this._started = false;
  }

  async send(toNodeId: string, envelope: MessageEnvelope): Promise<void> {
    const peer = this._peers.get(toNodeId);
    if (!peer) { await this._multicast(envelope); return; }
    await this._unicast(envelope, peer.address, peer.port);
  }

  async broadcast(envelope: MessageEnvelope, _exclude: string[] = []): Promise<void> {
    await this._multicast(envelope);
  }

  onMessage(handler: MessageHandler): void { this._handlers.push(handler); }

  addPeer(nodeId: string, address?: string): void {
    if (address) {
      const parts = address.split(":");
      this._peers.set(nodeId, {
        address:  parts[0],
        port:     parseInt(parts[1] ?? "13310"),
        lastSeen: Date.now(),
      });
    }
  }

  removePeer(nodeId: string): void { this._peers.delete(nodeId); }
  peers(): string[] { return Array.from(this._peers.keys()); }
  isConnected(): boolean { return this._started; }

  private _sendBeacon(): void {
    const beacon = JSON.stringify({ _type: "beacon", nodeId: this.nodeId, port: this._port });
    const buf    = Buffer.from(beacon);
    this._socket?.send(buf, 0, buf.length, this._port, LAN_MULTICAST_ADDR);
  }

  private async _unicast(msg: MessageEnvelope, addr: string, port: number): Promise<void> {
    const self = this;
    return new Promise((resolve) => {
      const buf = Buffer.from(JSON.stringify(msg));
      self._socket?.send(buf, 0, buf.length, port, addr, () => resolve());
    });
  }

  private async _multicast(msg: MessageEnvelope): Promise<void> {
    const self = this;
    return new Promise((resolve) => {
      const buf = Buffer.from(JSON.stringify(msg));
      self._socket?.send(buf, 0, buf.length, self._port, LAN_MULTICAST_ADDR, () => resolve());
    });
  }
}

// ─── BLETransport stub ────────────────────────────────────────────────────────

export class BLETransport implements ITransport {
  readonly name   = "ble";
  readonly nodeId: string;
  private readonly _logger: ILogger | undefined;
  private readonly _handlers: MessageHandler[] = [];
  private readonly _peers: Map<string, string> = new Map();
  private _started = false;

  constructor(nodeId: string, logger?: ILogger) {
    this.logger = logger;
    this.nodeId  = nodeId;
    this._logger = logger;
  }

  async start(): Promise<void> {
    this._started = true;
    this._logger?.warn("BLETransport: stub - gercek BLE yok");
  }
  async stop(): Promise<void> { this._started = false; }
  async send(toNodeId: string, _envelope: MessageEnvelope): Promise<void> {
    this._logger?.debug("BLE stub send -> " + toNodeId);
  }
  async broadcast(envelope: MessageEnvelope): Promise<void> {
    for (const id of this._peers.keys()) await this.send(id, envelope);
  }
  onMessage(handler: MessageHandler): void { this._handlers.push(handler); }
  addPeer(nodeId: string, address?: string): void { this._peers.set(nodeId, address ?? ""); }
  removePeer(nodeId: string): void { this._peers.delete(nodeId); }
  peers(): string[] { return Array.from(this._peers.keys()); }
  isConnected(): boolean { return this._started; }
}

// ─── WiFiDirectTransport stub ─────────────────────────────────────────────────

export class WiFiDirectTransport implements ITransport {
  readonly name   = "wifi-direct";
  readonly nodeId: string;
  private readonly _logger: ILogger | undefined;
  private readonly _handlers: MessageHandler[] = [];
  private readonly _peers: Map<string, string> = new Map();
  private _started = false;

  constructor(nodeId: string, logger?: ILogger) {
    this.logger = logger;
    this.nodeId  = nodeId;
    this._logger = logger;
  }

  async start(): Promise<void> {
    this._started = true;
    this._logger?.warn("WiFiDirectTransport: stub - gercek WiFi Direct yok");
  }
  async stop(): Promise<void> { this._started = false; }
  async send(toNodeId: string, _envelope: MessageEnvelope): Promise<void> {
    this._logger?.debug("WiFiDirect stub send -> " + toNodeId);
  }
  async broadcast(envelope: MessageEnvelope): Promise<void> {
    for (const id of this._peers.keys()) await this.send(id, envelope);
  }
  onMessage(handler: MessageHandler): void { this._handlers.push(handler); }
  addPeer(nodeId: string, address?: string): void { this._peers.set(nodeId, address ?? ""); }
  removePeer(nodeId: string): void { this._peers.delete(nodeId); }
  peers(): string[] { return Array.from(this._peers.keys()); }
  isConnected(): boolean { return this._started; }
}

// ─── registerAllTransports ────────────────────────────────────────────────────

export async function registerAllTransports(
  linkMgr: import("./link-manager.ts").LinkManager,
  nodeId:  string,
  logger?: ILogger
): Promise<void> {
  const { TRANSPORT_PROFILES } = await import("./link-manager.ts");
  const lan  = new LANTransport(nodeId, LAN_PORT, logger);
  const ble  = new BLETransport(nodeId, logger);
  const wifi = new WiFiDirectTransport(nodeId, logger);
  linkMgr.register({ transport: lan,  ...TRANSPORT_PROFILES.lan });
  linkMgr.register({ transport: ble,  ...TRANSPORT_PROFILES.ble });
  linkMgr.register({ transport: wifi, ...TRANSPORT_PROFILES["wifi-direct"] });
}
