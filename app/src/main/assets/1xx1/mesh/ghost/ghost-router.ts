/**
 * 1XX1 Ghost Cube — Router
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * GhostRouter'ın tek sorumluluğu:
 *   - Verilen zincir mi yoksa alternatif mi kullanılmalı?
 *   - Döngü tespiti ve önleme
 *   - Multi-hop iletim kararı (A→B doğrudan mı, A→C→B mi?)
 *   - TTL azaltma
 *
 * Routing kararını etkileyen faktörler:
 *   - Zincirdeki ghost'ların durumu (active/failed/expired)
 *   - Hedef node biliniyor mu? (doğrudan gönder)
 *   - Multi-hop: hangi ara node en iyi yol?
 */

import { manhattanDistance, coordToKey } from "./ghost-math.ts";
import type { GhostCube, GhostRoute, GhostSession } from "./ghost-types.ts";
import { GHOST_MAX_HOPS } from "./ghost-types.ts";
import type { CubeCoordinate } from "../../core/types.ts";

// ─── Routing Kararı ───────────────────────────────────────────────────────────

export type RoutingDecision =
  | { action: "direct";   targetNodeId: string }                  // Hedef görünüyor — direkt gönder
  | { action: "hop";      nextGhost: GhostCube; reason: string }  // Bir sonraki ghost'a ilet
  | { action: "store";    reason: string }                        // Hedef görünmüyor — sakla
  | { action: "drop";     reason: string };                       // TTL doldu, döngü vb.

export interface HopContext {
  /** Bu node'un bildiği canlı peer'lar */
  knownPeers:       Set<string>;
  /** Bu ghost'a kaç kez uğrandı (döngü tespiti) */
  visitCount:       Map<string, number>;
  /** Şu anki zaman */
  now:              number;
  /** Peer koordinatları — hibrit mod kısayol tespiti için (opsiyonel) */
  peerCoords?:      Map<string, import("../../core/types.ts").CubeCoordinate>;
}

// ─── GhostRouter ─────────────────────────────────────────────────────────────

export class GhostRouter {
  /**
   * Bir ghost paket bu node'a geldiğinde ne yapılmalı?
   *
   * Karar sırası:
   *   1. Hedef bu node mu? → teslim et
   *   2. Hedef bilinen peer mi? → doğrudan gönder
   *   3. TTL sıfır mı? → düşür
   *   4. Döngü var mı? → düşür
   *   5. Ghost expired mi? → düşür
   *   6. Sonraki ghost'u seç → hop
   *   7. Hiç peer yok → store-and-forward
   */
  /**
   * Yönlendirme kararı.
   *
   * Hibrit Mod (küçük ağ optimizasyonu):
   *   Hedef veya hedefe 1-hop uzaklıkta bir peer varsa
   *   ghost zinciri ATLANIR — doğrudan gönderilir.
   *   Bu, 10-100 node dense ağlarda gecikme ve enerji sorununu çözer.
   *
   * Ghost zinciri yalnızca şu durumlarda devreye girer:
   *   - Hedef veya komşuları görünmüyorsa (seyrek ağ)
   *   - Hop sayısı eşiği aşılmışsa (DTN senaryosu)
   */
  decide(
    currentNodeId: string,
    ghost:         GhostCube,
    route:         GhostRoute,
    ctx:           HopContext
  ): RoutingDecision {
    const { now, knownPeers, visitCount } = ctx;

    // 1. Hedef bu node mu?
    if (route.targetNodeId === currentNodeId) {
      return { action: "direct", targetNodeId: currentNodeId };
    }

    // 2. HİBRİT MOD: Hedef doğrudan biliniyor mu?
    if (knownPeers.has(route.targetNodeId)) {
      return { action: "direct", targetNodeId: route.targetNodeId };
    }

    // 3. HİBRİT MOD: Peer'lardan biri hedefe çok yakın mı?
    //    (Manhattan d ≤ 1 → neredeyse komşu)
    //    Küçük dense ağda ghost zincirine gerek yok.
    const shortcut = this._findShortcutPeer(route.targetNodeId, knownPeers, ctx.peerCoords);
    if (shortcut) {
      return { action: "direct", targetNodeId: shortcut };
    }

    // 4. TTL kontrolü
    if (ghost.expiresAt <= now) {
      return { action: "drop", reason: "Ghost TTL doldu" };
    }

    // 5. Döngü tespiti
    const ghostKey = ghost.id;
    const visits   = (visitCount.get(ghostKey) ?? 0) + 1;
    if (visits > 3) {
      return { action: "drop", reason: `Döngü tespit edildi: ${ghostKey} ${visits} kez ziyaret edildi` };
    }
    visitCount.set(ghostKey, visits);

    // 6. Hop sayısı kontrolü
    if (ghost.hopIndex >= GHOST_MAX_HOPS) {
      return { action: "drop", reason: `Maksimum hop aşıldı: ${ghost.hopIndex}` };
    }

    // 7. Zincirde sonraki ghost var mı?
    const nextGhost = this._findNextGhost(ghost, route);
    if (nextGhost) {
      const nextPeer = this._findPeerForGhost(nextGhost, knownPeers, route);
      if (nextPeer) {
        return { action: "hop", nextGhost, reason: `Zincir ilerliyor: hop ${ghost.hopIndex} → ${nextGhost.hopIndex}` };
      }
    }

    // 8. Alternatif rota var mı?
    const altDecision = this._tryAlternative(currentNodeId, route, ctx);
    if (altDecision) return altDecision;

    // 9. Hiçbir yol yok → store
    return { action: "store", reason: "Hedef veya sonraki hop görünmüyor — sakla ve bekle" };
  }

  /**
   * Multi-hop: A, C'yi bilmiyor ama B'yi biliyor.
   * B, C'yi biliyor mu bilmiyoruz ama B'yi bir "carrier" olarak seç.
   *
   * Greedy: hedef koordinatına Manhattan mesafesi en az olan peer'ı seç.
   */
  findBestCarrier(
    targetCoord:  CubeCoordinate,
    knownPeers:   Set<string>,
    peerCoords:   Map<string, CubeCoordinate>  // peer → koordinat
  ): string | null {
    let best: string | null = null;
    let bestDist = Infinity;

    for (const peerId of knownPeers) {
      const coord = peerCoords.get(peerId);
      if (!coord) continue;

      const d = manhattanDistance(coord, targetCoord);
      if (d < bestDist) {
        bestDist = d;
        best     = peerId;
      }
    }

    return best;
  }

  /**
   * Hibrit mod kısayol: peer'lardan biri hedefin koordinatına
   * Manhattan d ≤ 1 uzaklıkta mı? Varsa ghost atla, direkt gönder.
   * Dense küçük ağlarda (10-100 node) gecikmeyi dramatik düşürür.
   */
  private _findShortcutPeer(
    targetNodeId: string,
    knownPeers:   Set<string>,
    peerCoords?:  Map<string, import("../../core/types.ts").CubeCoordinate>
  ): string | null {
    if (!peerCoords || peerCoords.size === 0) return null;
    const targetCoord = peerCoords.get(targetNodeId);
    if (!targetCoord) return null;

    for (const peerId of knownPeers) {
      if (peerId === targetNodeId) continue;
      const pc = peerCoords.get(peerId);
      if (!pc) continue;
      if (manhattanDistance(pc, targetCoord) <= 1) return peerId;
    }
    return null;
  }

  /** Zincirdeki bu ghost'tan sonrakini bul */
  private _findNextGhost(current: GhostCube, route: GhostRoute): GhostCube | null {
    const nextIndex = current.hopIndex + 1;
    return route.chain.find((g) => g.hopIndex === nextIndex) ?? null;
  }

  /**
   * Sonraki ghost'u taşıyabilecek bir peer bul.
   * Peer, sonraki ghost'un koordinatına yakınsa seç.
   */
  private _findPeerForGhost(
    nextGhost:   GhostCube,
    knownPeers:  Set<string>,
    route:       GhostRoute
  ): string | null {
    // Hedef node doğrudan ulaşılabilir mi?
    if (knownPeers.has(route.targetNodeId)) return route.targetNodeId;

    // Sonraki ghost koordinatına en yakın peer
    // (peer koordinatları bilinmiyorsa herhangi bir peer yeterli)
    return knownPeers.size > 0 ? Array.from(knownPeers)[0] : null;
  }

  /**
   * Ana zincir çalışmıyorsa alternatif rota dene.
   */
  private _tryAlternative(
    currentNodeId: string,
    route:         GhostRoute,
    ctx:           HopContext
  ): RoutingDecision | null {
    for (const altChain of route.alternatives) {
      const firstGhost = altChain.find((g) => !route.visited.has(coordToKey(g.coordinate)));
      if (firstGhost) {
        const altRoute: GhostRoute = { ...route, chain: altChain };
        const altDecision = this.decide(currentNodeId, firstGhost, altRoute, ctx);
        if (altDecision.action === "hop" || altDecision.action === "direct") {
          return { ...altDecision, ...(altDecision.action === "hop" ? { reason: `Alternatif rota: ${altDecision.reason}` } : {}) };
        }
      }
    }
    return null;
  }

  /**
   * TTL azalt — her hop'ta bir birim düşer.
   * 0'a ulaşırsa ghost "expired" olarak işaretlenir.
   */
  decrementTTL(ghost: GhostCube): GhostCube {
    const remaining = ghost.expiresAt - Date.now();
    if (remaining <= 0) {
      return { ...ghost, state: "expired" };
    }
    return ghost; // TTL zaman bazlı, hop bazlı değil
  }

  /**
   * Zincirin durumu özeti — hata ayıklama için.
   */
  chainStatus(route: GhostRoute): {
    total:     number;
    active:    number;
    expired:   number;
    delivered: number;
    failed:    number;
  } {
    const now = Date.now();
    const st  = { total: 0, active: 0, expired: 0, delivered: 0, failed: 0 };

    for (const g of route.chain) {
      st.total++;
      if (g.expiresAt <= now || g.state === "expired") st.expired++;
      else if (g.state === "delivered") st.delivered++;
      else if (g.state === "failed")    st.failed++;
      else                              st.active++;
    }
    return st;
  }
}
