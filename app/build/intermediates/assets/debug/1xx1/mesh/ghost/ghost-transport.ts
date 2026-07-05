/**
 * 1XX1 Ghost Transport
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * ITransport implementasyonu — tek entegrasyon noktası.
 * NodeRuntime ve GossipEngine bu sınıfı kullanırken
 * Ghost Cube sisteminin farkında değildir.
 *
 * Kullanım (NodeRuntime kurucusu — TEK satır değişiklik):
 *
 *   // ÖNCE:
 *   new NodeRuntime(new MemoryTransport(nodeId), signer, cfg)
 *
 *   // SONRA:
 *   new NodeRuntime(
 *     new GhostTransport(nodeId, nodeCoord, physicalTransport, linkCtx),
 *     signer, cfg
 *   )
 *
 * Ghost Transport dahili olarak:
 *   1. send() çağrısını Ghost zinciri üzerinden yönlendirir
 *   2. Hedef bilinmiyorsa StoreAndForward kuyruğuna alır
 *   3. Mesaj alındığında Ghost receipt oluşturur
 *   4. Mevcut sisteme MessageEnvelope olarak iletir
 */

import type { ITransport, MessageHandler } from "../../distributed/transport/transport.ts";
import type { MessageEnvelope } from "../../distributed/envelope/message-envelope.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";
import { GhostChainBuilder }   from "./ghost-chain.ts";
import { GhostRouter }         from "./ghost-router.ts";
import { GhostReplicationEngine, GhostReceiptEngine } from "./ghost-replication-receipt.ts";
import type { GhostLinkContext, GhostSession } from "./ghost-types.ts";
import type { CubeCoordinate }  from "../../core/types.ts";
import { manhattanDistance }    from "./ghost-math.ts";
import type { ILogger }         from "../../core/interfaces.ts";

// ─── Peer Kaydı ───────────────────────────────────────────────────────────────

interface PeerRecord {
  nodeId:    string;
  address?:  string;
  coordinate?: CubeCoordinate;
  lastSeen:  number;
  online:    boolean;
}

// ─── GhostTransport ──────────────────────────────────────────────────────────

export class GhostTransport implements ITransport {
  readonly name = "ghost-smp";

  private readonly _peers    = new Map<string, PeerRecord>();
  private readonly _handlers: MessageHandler[] = [];
  private readonly _builder  = new GhostChainBuilder();
  private readonly _router   = new GhostRouter();
  private readonly _repEngine = new GhostReplicationEngine();
  private readonly _receipts  = new GhostReceiptEngine();
  private readonly _queue    = new Map<string, MessageEnvelope[]>(); // nodeId → bekleyen mesajlar
  private readonly _sessions = new Map<string, GhostSession>();
  private readonly _visitCount = new Map<string, number>();
  private _started = false;

  /** Metrikler */
  private _sent = 0;
  private _received = 0;
  private _stored = 0;
  private _dropped = 0;

  readonly nodeId: string;
  private readonly _coord: CubeCoordinate;
  private readonly _physical: ITransport;
  private readonly _defaultCtx: GhostLinkContext;
  private readonly _logger: ILogger | undefined;

  constructor(
    nodeId: string,
    coord: CubeCoordinate,
    physical: ITransport,
    defaultCtx: GhostLinkContext = {
      nodeDensity:     1,
      linkQuality:     0.8,
      bandwidthFactor: 0.5,
    },
    logger?: ILogger
  ) {
    this.nodeId       = nodeId;
    this._coord       = coord;
    this._physical    = physical;
    this._defaultCtx  = defaultCtx;
    this._logger      = logger;
  }

  // ─── ITransport API ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this._physical.start();

    // Fiziksel transport'tan gelen mesajları yakala
    this._physical.onMessage(async (env, from) => {
      await this._onPhysicalMessage(env, from);
    });

    this._started = true;
    this._logger?.info(`GhostTransport başlatıldı: ${this.nodeId} @ (${this._coord.x},${this._coord.y},${this._coord.z})`);
  }

  async stop(): Promise<void> {
    await this._physical.stop();
    this._started = false;
  }

  /**
   * Mesaj gönder.
   * Hedef biliniyorsa doğrudan, bilinmiyorsa Ghost zinciri üzerinden.
   */
  async send(toNodeId: string, envelope: MessageEnvelope): Promise<void> {
    if (!this._started) return;

    const peer = this._peers.get(toNodeId);

    if (peer?.online) {
      // Doğrudan gönder (peer görünür)
      await this._physical.send(toNodeId, envelope);
      this._sent++;
      return;
    }

    // Ghost zinciri oluştur ve yönlendir
    const targetCoord = peer?.coordinate ?? this._estimateCoord(toNodeId);
    const d = manhattanDistance(this._coord, targetCoord);

    if (d === 0) {
      // Aynı koordinat — fiziksel görünmese de deneme
      await this._storeForForward(toNodeId, envelope);
      return;
    }

    const payloadHash = await sha256Hex(JSON.stringify(envelope));

    const session = this._builder.build(
      this.nodeId, toNodeId,
      this._coord, targetCoord,
      payloadHash, 1,
      this._defaultCtx
    );

    this._sessions.set(session.sessionId, { ...session, status: "routing" });

    // Router kararı
    const firstGhost = session.route.chain[0];
    if (!firstGhost) {
      await this._storeForForward(toNodeId, envelope);
      return;
    }

    const decision = this._router.decide(this.nodeId, firstGhost, session.route, {
      knownPeers:  new Set(Array.from(this._peers.keys()).filter((id) => this._peers.get(id)?.online)),
      visitCount:  this._visitCount,
      now:         Date.now(),
    });

    if (decision.action === "direct") {
      await this._physical.send(decision.targetNodeId, envelope);
      this._sent++;
      await this._receipts.create({ ...session, status: "completed" }, true);
    } else if (decision.action === "hop") {
      // Multi-hop: bir sonraki bilinen peer'a ilet
      const carrier = this._findCarrier();
      if (carrier) {
        await this._physical.send(carrier, this._wrapForHop(envelope, session.sessionId, decision.nextGhost.hopIndex));
        this._sent++;
      } else {
        await this._storeForForward(toNodeId, envelope);
      }
    } else if (decision.action === "store") {
      await this._storeForForward(toNodeId, envelope);
    } else {
      this._dropped++;
      this._logger?.warn(`Ghost mesaj düşürüldü: ${decision.reason}`);
    }
  }

  async broadcast(envelope: MessageEnvelope, exclude: string[] = []): Promise<void> {
    const targets = Array.from(this._peers.keys()).filter(
      (id) => !exclude.includes(id) && this._peers.get(id)?.online
    );
    await Promise.all(targets.map((id) => this.send(id, envelope)));
  }

  onMessage(handler: MessageHandler): void {
    this._handlers.push(handler);
  }

  addPeer(nodeId: string, address?: string): void {
    const existing = this._peers.get(nodeId);
    this._peers.set(nodeId, {
      nodeId, address,
      coordinate: existing?.coordinate,
      lastSeen:   Date.now(),
      online:     true,
    });
    // Bekleyen mesajları gönder
    void this._flushQueue(nodeId);
  }

  removePeer(nodeId: string): void {
    const peer = this._peers.get(nodeId);
    if (peer) this._peers.set(nodeId, { ...peer, online: false });
  }

  peers(): string[] {
    return Array.from(this._peers.keys());
  }

  isConnected(): boolean {
    return this._started && this._physical.isConnected();
  }

  // ─── Ghost Sistemine Özgü API ─────────────────────────────────────────────

  /** Peer koordinatını güncelle (MeshDiscovery kullanır) */
  updatePeerCoordinate(nodeId: string, coord: CubeCoordinate): void {
    const peer = this._peers.get(nodeId) ?? {
      nodeId, lastSeen: Date.now(), online: true,
    };
    this._peers.set(nodeId, { ...peer, coordinate: coord });
  }

  /** Metrikleri al */
  metrics() {
    return {
      sent: this._sent, received: this._received,
      stored: this._stored, dropped: this._dropped,
      queueSize: Array.from(this._queue.values()).reduce((s, q) => s + q.length, 0),
      activeSessions: this._sessions.size,
      receipts: this._receipts.stats(),
    };
  }

  /** Receipt engine'i dışarıya aç */
  get receipts() { return this._receipts; }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async _onPhysicalMessage(env: MessageEnvelope, from: string): Promise<void> {
    this._received++;
    // Peer'ı online olarak işaretle
    if (this._peers.has(from)) {
      this._peers.get(from)!.online = true;
      this._peers.get(from)!.lastSeen = Date.now();
    }

    // Üst katmanlara ilet
    for (const handler of this._handlers) {
      await handler(env, from);
    }

    // Bu peer için bekleyen mesaj var mı?
    void this._flushQueue(from);
  }

  private async _storeForForward(toNodeId: string, envelope: MessageEnvelope): Promise<void> {
    const queue = this._queue.get(toNodeId) ?? [];
    queue.push(envelope);
    if (queue.length > 100) queue.shift(); // sınır
    this._queue.set(toNodeId, queue);
    this._stored++;
    this._logger?.debug(`Store-and-forward: ${toNodeId} için ${queue.length} mesaj kuyrukta`);
  }

  private async _flushQueue(nodeId: string): Promise<void> {
    const queue = this._queue.get(nodeId);
    if (!queue || queue.length === 0) return;
    if (!this._peers.get(nodeId)?.online) return;

    this._queue.delete(nodeId);
    for (const env of queue) {
      await this._physical.send(nodeId, env);
      this._sent++;
    }
    this._logger?.info(`Store-and-forward: ${queue.length} mesaj iletildi → ${nodeId}`);
  }

  private _findCarrier(): string | null {
    for (const [id, peer] of this._peers) {
      if (peer.online && id !== this.nodeId) return id;
    }
    return null;
  }

  /** Koordinatı bilinmeyen node için tahmin — hash bazlı deterministik */
  private _estimateCoord(nodeId: string): CubeCoordinate {
    let h = 0;
    for (const c of nodeId) h = (h * 31 + c.charCodeAt(0)) % 1331;
    return {
      x: Math.floor(h / 121) % 11,
      y: Math.floor(h / 11) % 11,
      z: h % 11,
    };
  }

  /** Hop wrapper — bir sonraki node'un Ghost bilgisini anlayabilmesi için */
  private _wrapForHop(
    original: MessageEnvelope,
    sessionId: string,
    hopIndex: number
  ): MessageEnvelope {
    // MessageEnvelope immutable — yeni envelope oluşturamayız (checksum kırılır)
    // Gerçek implementasyonda Ghost routing metadata, envelope TTL azaltılarak iletilir.
    // Bu stub: orijinal envelope'u aynen ilet + hop bilgisi loglanır.
    this._logger?.debug(`Ghost hop: session=${sessionId} hop=${hopIndex}`);
    return original;
  }
}
