/**
 * 1XX1 Ghost Cube — Zincir Oluşturucu
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * GhostChainBuilder:
 *   1. İki node koordinatı alır
 *   2. Fiziksel bağlam (LinkContext) alır
 *   3. ghostCount() ile kaç ghost gerektiğini hesaplar
 *   4. interpolateCoordinates() ile ara noktalar üretir
 *   5. fillChain() ile tam komşuluk zinciri oluşturur
 *   6. Her ghost'a TTL, sessionId, hopIndex atar
 *   7. GhostCube[] döndürür
 *
 * Bu sınıf routing, replikasyon veya receipt ile ilgilenmez.
 * Sadece zinciri inşa eder.
 */

import {
  DR, ghostCount, transferPriority, replicationFactor, routingSeed,
  interpolateCoordinates, fillChain, manhattanDistance, coordToKey,
} from "./ghost-math.ts";
import type {
  GhostCube, GhostLinkContext, GhostSession,
  GhostRoute, GhostReplication,
} from "./ghost-types.ts";
import {
  GHOST_DEFAULT_TTL_MS, GHOST_MAX_CHAIN,
} from "./ghost-types.ts";
import type { CubeCoordinate } from "../../core/types.ts";

// ─── Ghost ID Üretimi ─────────────────────────────────────────────────────────

let _ghostCounter = 0;

function generateGhostId(): string {
  const ts  = Date.now().toString(36);
  const cnt = (++_ghostCounter).toString(36).padStart(4, "0");
  return `ghost_${ts}_${cnt}`;
}

function generateSessionId(): string {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${rnd}`;
}

// ─── GhostChainBuilder ────────────────────────────────────────────────────────

export class GhostChainBuilder {
  /**
   * İki node arasında tam Ghost Küp zinciri oluştur.
   *
   * @param sourceNodeId  Kaynak node
   * @param targetNodeId  Hedef node
   * @param sourceCoord   Kaynak küp koordinatı
   * @param targetCoord   Hedef küp koordinatı
   * @param payloadHash   Taşınacak verinin SHA-256 hash'i
   * @param totalChunks   Toplam chunk sayısı
   * @param ctx           Fiziksel bağlam (bant genişliği, yoğunluk, kalite)
   * @param ttlMs         Ghost ömrü (varsayılan 10 dakika)
   */
  build(
    sourceNodeId: string,
    targetNodeId: string,
    sourceCoord:  CubeCoordinate,
    targetCoord:  CubeCoordinate,
    payloadHash:  string,
    totalChunks:  number,
    ctx:          GhostLinkContext,
    ttlMs:        number = GHOST_DEFAULT_TTL_MS
  ): GhostSession {
    const sessionId = generateSessionId();
    const now       = Date.now();

    // 1. Manhattan mesafesi
    const d = manhattanDistance(sourceCoord, targetCoord);

    // 2. Ghost sayısı (fiziksel faktörlerle)
    const count = ghostCount(d, ctx);

    // 3. Öncelik ve replikasyon (DR formülü)
    const priority = transferPriority(d);
    const replFactor = replicationFactor(d);
    const seed = routingSeed(sourceNodeId, targetNodeId, d);

    // 4. Interpolasyon → ham koordinatlar
    const rawCoords = interpolateCoordinates(sourceCoord, targetCoord, count);

    // 5. Zinciri tam komşuluk haline getir (fillChain)
    //    fillChain baş ve sona ihtiyaç duymuyor — sadece aradaki noktalar
    const filledCoords = fillChain(rawCoords);

    // 6. Toplam uzunluk kontrolü
    const chainCoords = filledCoords.slice(0, GHOST_MAX_CHAIN);
    const totalHops   = chainCoords.length;

    // 7. GhostCube[] oluştur
    const chain: GhostCube[] = chainCoords.map((coord, i) => ({
      id:          generateGhostId(),
      sessionId,
      coordinate:  coord,
      reservedBy:  sourceNodeId,
      hopIndex:    i,
      totalHops,
      createdAt:   now,
      expiresAt:   now + ttlMs,
      state:       "reserved" as const,
      payloadHash,
      chunkIndex:  0,      // TransferEngine günceller
      totalChunks,
    }));

    // 8. Visited set (döngü koruması için)
    const visited = new Set(chainCoords.map(coordToKey));

    // 9. Route
    const route: GhostRoute = {
      sessionId,
      chain,
      alternatives: [],  // GhostRouter alternatif üretirse buraya
      visited,
      priority,
      seed,
      sourceNodeId,
      targetNodeId,
      totalDistance: d,
    };

    // 10. Replication
    const replication: GhostReplication = {
      sessionId,
      payloadHash,
      factor:      replFactor,
      copies:      [],
      copyStatus:  {},
      satisfied:   false,
    };

    return {
      sessionId,
      route,
      replication,
      startedAt: now,
      status: "building",
    };
  }

  /**
   * Zincirde ardışık her çiftin komşu olduğunu doğrula.
   * Test ve pre-flight check için.
   */
  validateChain(chain: GhostCube[]): {
    valid:  boolean;
    gaps:   number[];  // komşu olmayan çiftlerin sol indeksi
    reason: string;
  } {
    const gaps: number[] = [];

    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i].coordinate;
      const b = chain[i + 1].coordinate;
      const d = manhattanDistance(a, b);
      if (d !== 1) gaps.push(i);
    }

    return {
      valid:  gaps.length === 0,
      gaps,
      reason: gaps.length === 0
        ? "Zincir geçerli — tüm ardışık çiftler komşu"
        : `${gaps.length} komşuluk açığı: indeksler [${gaps.join(", ")}]`,
    };
  }

  /**
   * Mevcut zincirine yeni chunk için indeks ata.
   * Her chunk aynı ghost zincirini kullanır, sadece chunkIndex değişir.
   */
  assignChunk(chain: GhostCube[], chunkIndex: number): GhostCube[] {
    return chain.map((g) => ({ ...g, chunkIndex }));
  }

  /**
   * TTL süresi dolan ghost'ları bul.
   */
  expiredGhosts(chain: GhostCube[]): GhostCube[] {
    const now = Date.now();
    return chain.filter((g) => g.expiresAt <= now);
  }

  /**
   * Özet rapor — debug ve observability için.
   */
  summary(session: GhostSession): {
    sessionId:    string;
    distance:     number;
    ghostCount:   number;
    priority:     number;
    replFactor:   number;
    seed:         number;
    chainValid:   boolean;
    expiresInMs:  number;
  } {
    const chain    = session.route.chain;
    const now      = Date.now();
    const earliest = Math.min(...chain.map((g) => g.expiresAt));

    return {
      sessionId:   session.sessionId,
      distance:    session.route.totalDistance,
      ghostCount:  chain.length,
      priority:    session.route.priority,
      replFactor:  session.replication.factor,
      seed:        session.route.seed,
      chainValid:  this.validateChain(chain).valid,
      expiresInMs: Math.max(0, earliest - now),
    };
  }
}
