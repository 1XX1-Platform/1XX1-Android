/**
 * 1XX1 TransportManager — FAZ T.2
 *
 * Uc sutun:
 *   DISCOVERY  : kaynaklar peer "gorusleri" (sighting) bildirir
 *   CONNECTION : oncelik merdivenine gore en iyi tasiyici secilir
 *   ROUTING    : gossip/raft'a tek kapi — "paketi gonder", nasil oldugu gizli
 *
 * Kurallar:
 *   - Cekirdek tasiyiciyi BILMEZ. Bu katman ITransport'lari yonetir.
 *   - Hayalet endpoint (0.0.0.0 / localhost / bos) ASLA kabul edilmez.  [Puruz#1]
 *   - Ayni cihazin farkli kimlikleri tekillestirilir (host:port anahtari). [Puruz#2]
 *   - Gonderim basarisiz olursa merdivenden bir alt tasiyiciya dusulur,
 *     iyilesme zamani dolunca ust tasiyici yeniden denenir.
 */

import type { TransportSpec } from "./transport-catalog.ts";
import { connectionLadder, getSpec } from "./transport-catalog.ts";

// ─── Ortak arayuz (mevcut ITransport ile uyumlu, bagimlilik olmadan) ─────────

export type Envelope = { type: string; from: string; payload: unknown; ts: number };
export type SendFn   = (toNodeId: string, env: Envelope) => Promise<void>;

export type ManagedTransport = {
  specId:    string;                       // katalogtaki id
  send:      SendFn;
  isUp:      () => boolean;                // tasiyici su an calisir durumda mi
  canReach?: (nodeId: string) => boolean;  // bu peer'a bu tasiyicidan ulasilir mi
};

// ─── Peer gorusleri (Discovery) ──────────────────────────────────────────────

export type PeerSighting = {
  nodeId?:   string;      // biliniyorsa kimlik (Ed25519 base58 tercih)
  endpoint?: string;      // http://ip:port — biliniyorsa
  medium:    string;      // hangi kaynaktan: subnet-sweep | ble | qr | nfc | ...
  hint?:     string;      // ör. BLE MAC — IP yoksa yakinlik bilgisi
  ts:        number;
};

export type KnownPeer = {
  canonicalId: string;              // tekil kimlik (en guclu bilinen)
  aliases:     Set<string>;         // ayni cihazin diger adlari (android-SM-... vb)
  endpoint:    string | null;       // dogrulanmis gercek endpoint
  media:       Set<string>;         // hangi kanallardan goruldu
  lastSeen:    number;
  activeTransport: string | null;   // su an kullanilan tasiyici (specId)
  downUntil:   Map<string, number>; // tasiyici -> ne zamana kadar cezali
};

// ─── Yardimcilar ─────────────────────────────────────────────────────────────

const GHOST_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::", "::1"]);

export function isGhostEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return true;
  try {
    const u = new URL(endpoint);
    return GHOST_HOSTS.has(u.hostname);
  } catch { return true; }
}

/** Ed25519 base58 kimlik mi, yoksa cihaz-adi takma adi mi? */
export function isStrongId(id: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(id);
}

function hostKey(endpoint: string): string {
  const u = new URL(endpoint);
  return `${u.hostname}:${u.port || "1331"}`;
}

// ─── TransportManager ────────────────────────────────────────────────────────

type Logger = { info(m: string): void; warn(m: string): void };

const DOWN_PENALTY_MS = 30_000;   // basarisiz tasiyici bu kadar sure cezali
const SIGHTING_TTL_MS = 5 * 60_000;

export class TransportManager {
  private selfId: string;
  private log:    Logger;
  private transports = new Map<string, ManagedTransport>();     // specId -> t
  private peers      = new Map<string, KnownPeer>();            // canonicalId -> peer
  private byHost     = new Map<string, string>();               // host:port -> canonicalId
  private onPeerCbs: Array<(p: KnownPeer, sighting: PeerSighting) => void> = [];

  constructor(selfId: string, log?: Logger) {
    this.selfId = selfId;
    this.log = log ?? { info(){}, warn(){} };
  }

  // ── Tasiyici kaydi ─────────────────────────────────────────────────────────

  register(t: ManagedTransport): void {
    if (!getSpec(t.specId)) {
      this.log.warn(`Katalogda olmayan tasiyici: ${t.specId} — yine de kaydedildi`);
    }
    this.transports.set(t.specId, t);
  }

  registered(): string[] { return [...this.transports.keys()]; }

  // ── DISCOVERY: gorus bildir ───────────────────────────────────────────────

  onPeer(cb: (p: KnownPeer, s: PeerSighting) => void): void { this.onPeerCbs.push(cb); }

  /**
   * Herhangi bir kesif kaynagi (sweep, multicast, Android koprusu, QR, BLE...)
   * buldugunu buraya bildirir. Tek kapi: hayalet reddi ve tekillestirme burada.
   */
  reportSighting(s: PeerSighting): KnownPeer | null {
    // 1. Kendini bildirme
    if (s.nodeId && (s.nodeId === this.selfId)) return null;

    // 2. Hayalet endpoint reddi [Puruz#1 cozumu]
    if (s.endpoint && isGhostEndpoint(s.endpoint)) {
      this.log.warn(`Hayalet endpoint reddedildi: ${s.endpoint} (${s.medium})`);
      s = { ...s, endpoint: undefined };
      if (!s.nodeId && !s.hint) return null;   // elimizde hicbir sey kalmadi
    }

    // 3. Tekillestirme [Puruz#2 cozumu]
    //    Ayni host:port = ayni cihaz. Guclu kimlik (base58) kanonik olur,
    //    cihaz-adi (android-SM-...) alias'a duser.
    let peer: KnownPeer | null = null;

    if (s.endpoint) {
      const hk = hostKey(s.endpoint);
      const existingId = this.byHost.get(hk);
      if (existingId) peer = this.peers.get(existingId) ?? null;
    }
    if (!peer && s.nodeId) {
      peer = this.peers.get(s.nodeId) ?? null;
      if (!peer) {
        // alias olarak kayitli mi?
        for (const p of this.peers.values()) {
          if (p.aliases.has(s.nodeId)) { peer = p; break; }
        }
      }
    }

    if (!peer) {
      const canonical = s.nodeId ?? (s.endpoint ? `ep:${hostKey(s.endpoint)}` : `hint:${s.hint}`);
      peer = {
        canonicalId: canonical, aliases: new Set(),
        endpoint: null, media: new Set(), lastSeen: 0,
        activeTransport: null, downUntil: new Map(),
      };
      this.peers.set(canonical, peer);
    }

    // Kimlik guclendirme: yeni id daha gucluyse kanonigi degistir
    if (s.nodeId && s.nodeId !== peer.canonicalId) {
      if (isStrongId(s.nodeId) && !isStrongId(peer.canonicalId)) {
        this.peers.delete(peer.canonicalId);
        peer.aliases.add(peer.canonicalId);
        peer.canonicalId = s.nodeId;
        this.peers.set(s.nodeId, peer);
      } else {
        peer.aliases.add(s.nodeId);
      }
    }

    // Endpoint guncelle (sadece gercek olani)
    if (s.endpoint && !isGhostEndpoint(s.endpoint)) {
      peer.endpoint = s.endpoint;
      this.byHost.set(hostKey(s.endpoint), peer.canonicalId);
    }

    peer.media.add(s.medium);
    peer.lastSeen = s.ts;

    for (const cb of this.onPeerCbs) cb(peer, s);
    return peer;
  }

  // ── CONNECTION: en iyi tasiyiciyi sec ─────────────────────────────────────

  /** Bu peer icin su an kullanilabilir en yuksek oncelikli tasiyici */
  pickTransport(peerId: string): ManagedTransport | null {
    const peer = this.resolve(peerId);
    if (!peer) return null;
    const now = Date.now();

    for (const spec of connectionLadder()) {
      const t = this.transports.get(spec.id);
      if (!t) continue;                                    // implementasyon yok
      if (!t.isUp()) continue;                             // tasiyici kapali
      const penalty = peer.downUntil.get(spec.id) ?? 0;
      if (penalty > now) continue;                         // cezali
      if (t.canReach && !t.canReach(peer.canonicalId)) continue;
      return t;
    }
    return null;
  }

  // ── ROUTING: tek kapi ─────────────────────────────────────────────────────

  /**
   * Cekirdegin gordugu TEK fonksiyon. Basarisizlikta otomatik merdiven:
   * mevcut tasiyici cezalandirilir, bir alttaki denenir.
   */
  async send(peerId: string, env: Envelope): Promise<{ ok: boolean; via: string | null }> {
    const peer = this.resolve(peerId);
    if (!peer) return { ok: false, via: null };

    let lastErr = "";
    // Merdiven: her turda pickTransport bir sonrakini verir (cezalar sayesinde)
    for (let attempt = 0; attempt < this.transports.size + 1; attempt++) {
      const t = this.pickTransport(peer.canonicalId);
      if (!t) break;
      try {
        await t.send(peer.canonicalId, env);
        if (peer.activeTransport !== t.specId) {
          this.log.info(`Peer ${short(peer.canonicalId)} icin tasiyici: ${t.specId}`);
          peer.activeTransport = t.specId;
        }
        return { ok: true, via: t.specId };
      } catch (e) {
        lastErr = String(e);
        peer.downUntil.set(t.specId, Date.now() + DOWN_PENALTY_MS);
        this.log.warn(`${t.specId} basarisiz (${short(peer.canonicalId)}), merdivenden dusuluyor: ${lastErr.slice(0, 80)}`);
      }
    }
    this.log.warn(`Hicbir tasiyici ulasamadi: ${short(peer.canonicalId)}`);
    return { ok: false, via: null };
  }

  // ── Sorgular ──────────────────────────────────────────────────────────────

  resolve(idOrAlias: string): KnownPeer | null {
    const direct = this.peers.get(idOrAlias);
    if (direct) return direct;
    for (const p of this.peers.values()) if (p.aliases.has(idOrAlias)) return p;
    return null;
  }

  /** Tekillestirilmis, hayaletlerden arinmis peer listesi */
  knownPeers(): KnownPeer[] {
    const now = Date.now();
    return [...this.peers.values()].filter(p => now - p.lastSeen < SIGHTING_TTL_MS);
  }

  /** Gozlem paneli icin ozet */
  status(): {
    transports: Array<{ id: string; up: boolean; spec: TransportSpec | null }>;
    peers: Array<{ id: string; aliases: string[]; endpoint: string | null;
                   media: string[]; via: string | null }>;
  } {
    return {
      transports: [...this.transports.entries()].map(([id, t]) => ({
        id, up: t.isUp(), spec: getSpec(id),
      })),
      peers: this.knownPeers().map(p => ({
        id: p.canonicalId, aliases: [...p.aliases], endpoint: p.endpoint,
        media: [...p.media], via: p.activeTransport,
      })),
    };
  }
}

function short(id: string): string { return id.length > 12 ? id.slice(0, 8) + "…" : id; }
