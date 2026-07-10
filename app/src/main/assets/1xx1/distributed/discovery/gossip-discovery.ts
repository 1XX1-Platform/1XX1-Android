/**
 * 1XX1 Gossip Discovery
 * FAZ 1.2-1.6 — Bootstrap + Gossip Core
 *
 * Mimari: Hibrit Model A
 *   Gossip → discovery layer (kim var, nerede)
 *   Raft   → consensus layer (ne dogru, kim lider)
 *   Ikisi ayni state'i YONETMEZ.
 *
 * Startup sequence:
 *   1. identity load
 *   2. seed node'lara baglan
 *   3. peer listesi al
 *   4. cache'e yaz
 *   5. gossip loop baslat
 *   6. keepalive + failure detection
 */

import { PeerTable } from "./peer-table.ts";
import { getSeedNodes } from "./seed-nodes.ts";
import { updateLogicalTime } from "../../core/logical-time.ts";
import type { NodeIdentity } from "../../core/identity.ts";

// ─── Gossip Mesaji ────────────────────────────────────────────────────────────

export interface GossipHandshakeRequest {
  nodeId:      string;
  publicKey:   string;
  endpoint:    string;
  term:        number;
  logicalTime: number;
}

export interface GossipHandshakeResponse {
  nodeId:      string;
  peers:       Array<{ nodeId: string; endpoint: string; lastSeen: number; term: number }>;
  term:        number;
  clusterTime: number;
}

// ─── GossipDiscovery ─────────────────────────────────────────────────────────

export class GossipDiscovery {
  private readonly _peers     = new PeerTable();
  private _gossipTimer?:      ReturnType<typeof setInterval>;
  private _keepaliveTimer?:   ReturnType<typeof setInterval>;
  private _running            = false;

  private readonly _identity:  NodeIdentity;
  private readonly _endpoint:  string;
  private readonly _getTerm:   () => number;
  private readonly _onNewPeer: (nodeId: string, endpoint: string) => void;
  private readonly _logger:    { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void } | undefined;

  constructor(
    identity:  NodeIdentity,
    endpoint:  string,
    getTerm:   () => number,
    onNewPeer: (nodeId: string, endpoint: string) => void = () => {},
    logger?:   { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void }
  ) {
    this._identity  = identity;
    this._endpoint  = endpoint;
    this._getTerm   = getTerm;
    this._onNewPeer = onNewPeer;
    this._logger    = logger;
  }

  // ─── Baslatma ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this._running = true;

    // 1. Seed node'lara baglan
    await this._bootstrapFromSeeds();

    // 2. Gossip loop (her 30 saniye)
    this._gossipTimer = setInterval(() => this._gossipRound(), 30_000);

    // 3. Failure detection (her 15 saniye)
    this._keepaliveTimer = setInterval(() => this._checkPeerHealth(), 15_000);

    this._logger?.info(`GossipDiscovery baslatildi: ${this._endpoint}`);
  }

  stop(): void {
    this._running = false;
    if (this._gossipTimer)    clearInterval(this._gossipTimer);
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
  }

  // ─── Manuel Peer Ekle (LAN discovery'den gelir) ──────────────────────────

  addPeer(nodeId: string, endpoint: string, source: "lan" | "gossip" | "manual" = "manual"): void {
    this._peers.upsert({
      nodeId, endpoint, lastSeen: Date.now(),
      term: this._getTerm(), source,
    });
    this._logger?.debug(`Peer eklendi [${source}]: ${nodeId.slice(0,12)} @ ${endpoint}`);
  }

  // ─── Handshake Handler (gelen istek) ─────────────────────────────────────

  handleHandshake(req: GossipHandshakeRequest): GossipHandshakeResponse {
    updateLogicalTime(req.logicalTime);

    // Gelen node'u kaydet (kendimiz değilsek)
    if (req.nodeId !== this._identity.nodeId) {
      this._peers.upsert({
        nodeId:    req.nodeId,
        endpoint:  req.endpoint,
        lastSeen:  Date.now(),
        term:      req.term,
        source:    "gossip",
      });
      this._onNewPeer(req.nodeId, req.endpoint);
    }

    // Kendi bildiğimiz peer'ları don (kendimizi ve karşıyı hariç tut)
    const peersToSend = this._peers.best(16)
      .filter(p => p.nodeId !== req.nodeId && p.nodeId !== this._identity.nodeId);

    return {
      nodeId:      this._identity.nodeId,
      peers:       peersToSend.map(p => ({
        nodeId:   p.nodeId,
        endpoint: p.endpoint,
        lastSeen: p.lastSeen,
        term:     p.term,
      })),
      term:        this._getTerm(),
      clusterTime: updateLogicalTime(),
    };
  }

  // ─── Peer Tablosu Erisimi ─────────────────────────────────────────────────

  peers(): PeerTable { return this._peers; }
  alivePeers() { return this._peers.alive(); }
  peerCount() { return this._peers.alive().length; }

  // ─── /gossip/peers handler ────────────────────────────────────────────────

  getPeersResponse() {
    return {
      nodeId: this._identity.nodeId,
      peers:  this._peers.best(32).map(p => ({
        nodeId:     p.nodeId,
        endpoint:   p.endpoint,
        lastSeen:   p.lastSeen,
        reputation: p.reputation,
        source:     p.source,
      })),
      count:  this._peers.size(),
    };
  }

  // ─── Private: Bootstrap ───────────────────────────────────────────────────

  private async _bootstrapFromSeeds(): Promise<void> {
    const seeds = getSeedNodes();
    if (seeds.length === 0) {
      this._logger?.info("Seed node tanimlanmamis — sadece LAN modu");
      return;
    }

    for (const seed of seeds) {
      try {
        const res = await this._doHandshake(seed);
        if (res) {
          this._logger?.info(`Seed baglandı: ${seed} → ${res.peers.length} peer alindi`);
          this._peers.merge(res.peers.map(p => ({
            ...p, source: "gossip" as const, reputation: 50,
          })), this._identity.nodeId);
        }
      } catch (e) {
        this._logger?.warn(`Seed hatasi [${seed}]: ${String(e).slice(0, 80)}`);
      }
    }
  }

  // ─── Private: Gossip Round ────────────────────────────────────────────────

  private async _gossipRound(): Promise<void> {
    if (!this._running) return;
    const peer = this._peers.random();
    if (!peer) return;

    try {
      const res = await this._doHandshake(peer.endpoint);
      if (res) {
        this._peers.markSeen(peer.nodeId);
        // Transitif peer ogrenme: B'den A'nin bildigi C'yi de ogren
        const added = this._peers.merge(res.peers.map(p => ({
          ...p, source: "gossip" as const, reputation: 40,
        })), this._identity.nodeId);
        updateLogicalTime(res.clusterTime);
        if (added > 0) {
          this._logger?.debug(`Gossip [transitif]: ${peer.nodeId.slice(0,12)} → ${added} yeni peer`);
          for (const p of res.peers.slice(0, added)) {
            this._onNewPeer(p.nodeId, p.endpoint);
          }
        }
      }
    } catch {
      this._peers.markDead(peer.nodeId);
    }
  }

  // ─── Private: Failure Detection ───────────────────────────────────────────

  private async _checkPeerHealth(): Promise<void> {
    if (!this._running) return;
    const alive = this._peers.alive();

    for (const peer of alive) {
      const age = Date.now() - peer.lastSeen;
      if (age < 30_000) continue; // 30 saniyeden yeni → atla

      // Health check
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(`${peer.endpoint}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (r.ok) {
          const hb = ((await r.json().catch(() => ({}))) as { nodeId?: string; identity?: string });
          const known = [hb.nodeId, hb.identity].filter(Boolean);
          if (known.length > 0 && !known.includes(peer.nodeId)) {
            this._peers.remove(peer.nodeId);
            this._logger?.warn(`Hayalet peer temizlendi (kimlik degisti): ${peer.nodeId.slice(0,12)} -> ${(hb.identity ?? hb.nodeId ?? "?").slice(0,12)}`);
          } else {
            this._peers.markSeen(peer.nodeId);
          }
        } else {
          this._peers.markDead(peer.nodeId);
        }
      } catch {
        // 3 kez ardarda basarisiz → cikart
        if (peer.reputation <= 0) {
          this._peers.remove(peer.nodeId);
          this._logger?.warn(`Peer silindi (dead): ${peer.nodeId.slice(0,12)}`);
        } else {
          this._peers.markDead(peer.nodeId);
        }
      }
    }
  }

  // ─── Private: HTTP Handshake ──────────────────────────────────────────────

  private async _doHandshake(endpoint: string): Promise<GossipHandshakeResponse | null> {
    const body: GossipHandshakeRequest = {
      nodeId:      this._identity.nodeId,
      publicKey:   this._identity.publicKeyB64,
      endpoint:    this._endpoint,
      term:        this._getTerm(),
      logicalTime: updateLogicalTime(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const r = await fetch(`${endpoint}/gossip/handshake`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      return await r.json() as GossipHandshakeResponse;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }
}
