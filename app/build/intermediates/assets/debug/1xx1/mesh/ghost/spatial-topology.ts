/**
 * 1XX1 Ghost Cube — Spatial Topology
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * KAPSAM: Her node yalnızca kendi k-hop komşuluğunu tutar.
 * Global harita yok — "partial knowledge" prensibi (DTN ile uyumlu).
 *
 * Topologinin tuttuğu bilgi:
 *   - Koordinat → hangi node orada (gerçek veya ghost)
 *   - Ghost rezervasyonları: koordinat geçici olarak işgal altında mı?
 *   - Node varlığı: kim ne zaman son görüldü
 *   - k-hop komşular: hangi fiziksel nodelar kaç hop uzakta
 *
 * Mimari kural: Bu sınıf GhostTransport veya GhostRouter'ı import etmez.
 * Bağımlılık yönü: GhostTransport → SpatialTopology (tek yön).
 */

import {
  manhattanDistance, coordToKey, getNeighbors,
} from "./ghost-math.ts";
import type { CubeCoordinate } from "../../core/types.ts";

// ─── Koordinat Girişi ─────────────────────────────────────────────────────────

export type CoordOccupant =
  | { kind: "node";  nodeId: string;   lastSeen: number }
  | { kind: "ghost"; sessionId: string; expiresAt: number; reservedBy: string }
  | { kind: "empty" };

// ─── Node Kaydı ───────────────────────────────────────────────────────────────

export interface TopologyNodeRecord {
  nodeId:     string;
  coordinate: CubeCoordinate;
  hops:       number;       // bu node'dan kaç hop uzakta
  lastSeen:   number;       // unixMs
  online:     boolean;
}

// ─── SpatialTopology ──────────────────────────────────────────────────────────

export class SpatialTopology {
  /** koordinat anahtarı → işgalci */
  private readonly _grid    = new Map<string, CoordOccupant>();
  /** nodeId → kayıt */
  private readonly _nodes   = new Map<string, TopologyNodeRecord>();

  private readonly _selfNodeId: string;
  private readonly _selfCoord:  CubeCoordinate;
  private readonly _kHop:       number;

  constructor(
    selfNodeId: string,
    selfCoord:  CubeCoordinate,
    kHop:       number = 3
  ) {
    this.kHop = kHop;
    this.selfCoord = selfCoord;
    this.selfNodeId = selfNodeId;
    this._selfNodeId = selfNodeId;
    this._selfCoord  = selfCoord;
    this._kHop       = kHop;
    // Kendi koordinatımızı işaretle
    this._grid.set(coordToKey(selfCoord), {
      kind:     "node",
      nodeId:   selfNodeId,
      lastSeen: Date.now(),
    });
  }

  // ─── Ghost Rezervasyon ────────────────────────────────────────────────────

  /**
   * Bir koordinatı ghost için rezerve et.
   * "Ghost o koordinatı geçici olarak işgal ediyor."
   */
  reserveGhost(
    coord:     CubeCoordinate,
    sessionId: string,
    reservedBy: string,
    expiresAt: number
  ): boolean {
    const key      = coordToKey(coord);
    const existing = this._grid.get(key);

    // Gerçek node varsa rezerve edilemez
    if (existing?.kind === "node") return false;

    // Başka aktif ghost varsa rezerve edilemez
    if (existing?.kind === "ghost" && existing.expiresAt > Date.now()) return false;

    this._grid.set(key, { kind: "ghost", sessionId, expiresAt, reservedBy });
    return true;
  }

  /**
   * Ghost rezervasyonunu serbest bırak (iş bittiğinde veya TTL dolduğunda).
   */
  releaseGhost(coord: CubeCoordinate, sessionId: string): boolean {
    const key      = coordToKey(coord);
    const existing = this._grid.get(key);
    if (existing?.kind === "ghost" && existing.sessionId === sessionId) {
      this._grid.set(key, { kind: "empty" });
      return true;
    }
    return false;
  }

  /**
   * Süresi dolmuş tüm ghost rezervasyonlarını temizle.
   */
  pruneExpiredGhosts(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, occ] of this._grid) {
      if (occ.kind === "ghost" && occ.expiresAt <= now) {
        this._grid.set(key, { kind: "empty" });
        pruned++;
      }
    }
    return pruned;
  }

  // ─── Node Varlığı ─────────────────────────────────────────────────────────

  /**
   * Bir node'un varlığını kaydet / güncelle.
   * k-hop dışındaysa kaydedilmez.
   */
  seeNode(nodeId: string, coord: CubeCoordinate): void {
    const hops = manhattanDistance(this._selfCoord, coord);
    if (hops > this._kHop) return; // k-hop dışı → ihmal et

    const existing = this._nodes.get(nodeId);
    const record: TopologyNodeRecord = {
      nodeId, coordinate: coord, hops,
      lastSeen: Date.now(), online: true,
    };
    this._nodes.set(nodeId, record);

    // Grid'de de işaretle
    const key = coordToKey(coord);
    this._grid.set(key, { kind: "node", nodeId, lastSeen: Date.now() });
  }

  /**
   * Bir node'u offline olarak işaretle.
   */
  loseNode(nodeId: string): void {
    const rec = this._nodes.get(nodeId);
    if (rec) {
      this._nodes.set(nodeId, { ...rec, online: false });
      // Grid'den düşür (koordinat tekrar boş)
      const key = coordToKey(rec.coordinate);
      this._grid.set(key, { kind: "empty" });
    }
  }

  // ─── Sorgular ─────────────────────────────────────────────────────────────

  /** Bir koordinat boş mu? (ghost veya node yok) */
  isEmpty(coord: CubeCoordinate): boolean {
    const key = coordToKey(coord);
    const occ = this._grid.get(key);
    if (!occ || occ.kind === "empty") return true;
    if (occ.kind === "ghost" && occ.expiresAt <= Date.now()) return true;
    return false;
  }

  /** Bir koordinattaki işgalci */
  occupantAt(coord: CubeCoordinate): CoordOccupant {
    const key = coordToKey(coord);
    return this._grid.get(key) ?? { kind: "empty" };
  }

  /** Hedefe en yakın online node'u bul (PathOptimizer için) */
  nearestNodeTo(target: CubeCoordinate): TopologyNodeRecord | null {
    let best: TopologyNodeRecord | null = null;
    let bestDist = Infinity;

    for (const rec of this._nodes.values()) {
      if (!rec.online) continue;
      const d = manhattanDistance(rec.coordinate, target);
      if (d < bestDist) {
        bestDist = d;
        best     = rec;
      }
    }
    return best;
  }

  /** k-hop içindeki tüm online node'lar */
  onlineNodes(): TopologyNodeRecord[] {
    return Array.from(this._nodes.values()).filter((r) => r.online);
  }

  /** Belirli hop sayısındaki node'lar */
  nodesAtHop(hop: number): TopologyNodeRecord[] {
    return Array.from(this._nodes.values()).filter((r) => r.hops === hop && r.online);
  }

  /** Aktif ghost rezervasyonları */
  activeGhosts(): Array<{ coord: CubeCoordinate; sessionId: string; expiresAt: number }> {
    const now = Date.now();
    const result: Array<{ coord: CubeCoordinate; sessionId: string; expiresAt: number }> = [];

    for (const [key, occ] of this._grid) {
      if (occ.kind === "ghost" && occ.expiresAt > now) {
        const [x, y, z] = key.split(",").map(Number);
        result.push({ coord: { x, y, z }, sessionId: occ.sessionId, expiresAt: occ.expiresAt });
      }
    }
    return result;
  }

  /** Topoloji özeti — observability */
  stats(): {
    totalCoords:    number;
    emptyCoords:    number;
    nodeCoords:     number;
    ghostCoords:    number;
    onlineNodes:    number;
    offlineNodes:   number;
    kHop:           number;
  } {
    let empty = 0, nodes = 0, ghosts = 0;
    const now = Date.now();

    for (const occ of this._grid.values()) {
      if (occ.kind === "empty") empty++;
      else if (occ.kind === "node") nodes++;
      else if (occ.kind === "ghost" && occ.expiresAt > now) ghosts++;
      else empty++; // süresi dolmuş ghost → boş sayılır
    }

    const allNodes   = Array.from(this._nodes.values());
    const onlineCount  = allNodes.filter((r) => r.online).length;

    return {
      totalCoords:  this._grid.size,
      emptyCoords:  empty,
      nodeCoords:   nodes,
      ghostCoords:  ghosts,
      onlineNodes:  onlineCount,
      offlineNodes: allNodes.length - onlineCount,
      kHop:         this._kHop,
    };
  }

  /** Debug: koordinatların ASCII görünümü (z=0 dilimi) */
  debugSlice(z = 0, size = 11): string {
    const rows: string[] = [];
    for (let y = size - 1; y >= 0; y--) {
      let row = "";
      for (let x = 0; x < size; x++) {
        const occ = this.occupantAt({ x, y, z });
        if (occ.kind === "node")  row += occ.nodeId === this._selfNodeId ? "★" : "●";
        else if (occ.kind === "ghost") row += "◌";
        else row += "·";
        row += " ";
      }
      rows.push(`y${y} ${row}`);
    }
    return rows.join("\n");
  }
}
