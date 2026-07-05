/**
 * 1XX1 Ghost Cube — Replikasyon + Receipt Motoru
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * İki servis tek dosyada (küçük, bağımlılar):
 *
 *   GhostReplicationEngine → DR(d) × kopya sayısı yönetimi
 *   GhostReceiptEngine     → transfer izi, parçalı saklama, hash kanıtı
 */

import { sha256Hex } from "../../distributed/security/signature.ts";
import { DR, coordToKey } from "./ghost-math.ts";
import type {
  GhostCube, GhostReplication, GhostReceipt, GhostRoute, GhostSession,
} from "./ghost-types.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// GhostReplicationEngine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Replikasyon mantığı:
 *   factor = DR(totalDistance) → kaç kopya tutulsun
 *   copies = hangi node'larda kopya var
 *   satisfied = yeterli kopya var mı?
 *
 * Ghost sayısını BELİRLEMEZ — sadece kaç kopya gerektiğini belirler.
 */
export class GhostReplicationEngine {
  /**
   * Yeni replikasyon başlat.
   * factor = DR(d) → offline sistemde veri kaybına karşı kopya sayısı.
   */
  create(sessionId: string, payloadHash: string, distance: number): GhostReplication {
    return {
      sessionId,
      payloadHash,
      factor:     DR(distance),   // 1-9 arası
      copies:     [],
      copyStatus: {},
      satisfied:  false,
    };
  }

  /**
   * Bir node başarıyla kopya aldı → kaydet.
   */
  confirmCopy(rep: GhostReplication, nodeId: string): GhostReplication {
    const copies = [...new Set([...rep.copies, nodeId])];
    const copyStatus = { ...rep.copyStatus, [nodeId]: "confirmed" as const };
    return {
      ...rep,
      copies,
      copyStatus,
      satisfied: copies.filter((id) => copyStatus[id] === "confirmed").length >= rep.factor,
    };
  }

  /**
   * Bir node kopya kaybetti → güncelle.
   */
  reportLoss(rep: GhostReplication, nodeId: string): GhostReplication {
    const copyStatus = { ...rep.copyStatus, [nodeId]: "lost" as const };
    const activeCopies = rep.copies.filter((id) => copyStatus[id] === "confirmed");
    return {
      ...rep,
      copyStatus,
      satisfied: activeCopies.length >= rep.factor,
    };
  }

  /**
   * Daha fazla kopya gerekiyor mu?
   */
  needsMoreCopies(rep: GhostReplication): boolean {
    return !rep.satisfied;
  }

  /**
   * Kaç kopya eksik?
   */
  missingCount(rep: GhostReplication): number {
    const confirmed = rep.copies.filter((id) => rep.copyStatus[id] === "confirmed").length;
    return Math.max(0, rep.factor - confirmed);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GhostReceiptEngine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Receipt oluşturma ve doğrulama.
 *
 * Her cihaz zincirin YALNIZCA kendi gördüğü kısmını saklar.
 * Bu "parçalı saklama" tasarımı kasıtlıdır:
 *   - Hiçbir cihaz tam rotayı bilmez (gizlilik)
 *   - Her cihaz kendi parçasını kanıtlayabilir (bütünlük)
 *   - Parçalar birleştirilirse tam rota yeniden oluşturulabilir (denetim)
 */
export class GhostReceiptEngine {
  private readonly receipts = new Map<string, GhostReceipt>();

  /**
   * Transfer tamamlandığında receipt oluştur.
   */
  async create(
    session: GhostSession,
    success:      boolean,
    failReason?:  string,
    /** Opsiyonel: koordinat sağlık skorları (GhostHealthMonitor'dan) */
    coordScores?: Map<string, number>
  ): Promise<GhostReceipt> {
    const chain       = session.route.chain;
    const spatialLog  = chain.map((g) => g.coordinate);
    const routeHash   = await this._computeRouteHash(spatialLog);
    const confidence  = this._computeConfidence(session, success, coordScores);

    const receipt: GhostReceipt = {
      sessionId:    session.sessionId,
      sourceNodeId: session.route.sourceNodeId,
      targetNodeId: session.route.targetNodeId,
      routeHash,
      payloadHash:  session.route.chain[0]?.payloadHash ?? "",
      spatialLog,
      ghostCount:   chain.length,
      priority:     session.route.priority,
      distance:     session.route.totalDistance,
      completedAt:  Date.now(),
      success,
      failReason,
      confidenceScore: confidence,
    };

    this.receipts.set(session.sessionId, receipt);
    return receipt;
  }

  /**
   * Confidence Score hesabı (0.0–1.0).
   *
   * Başarılı transfer:   temel 0.70
   * Koordinat sağlığı:  +0.00 – +0.20 (coordScores ortalaması)
   * Replikasyon bonus:  +0.10 (replication.satisfied ise)
   * Başarısız transfer:  temel 0.10 + kısmi katkılar
   */
  private _computeConfidence(
    session:      GhostSession,
    success:      boolean,
    coordScores?: Map<string, number>
  ): number {
    const base = success ? 0.70 : 0.10;

    // Koordinat sağlık katkısı
    let healthBonus = 0;
    if (coordScores && session.route.chain.length > 0) {
      const scores = session.route.chain.map((g) => {
        const key = `${g.coordinate.x},${g.coordinate.y},${g.coordinate.z}`;
        return coordScores.get(key) ?? 0.5;
      });
      const avg   = scores.reduce((s, v) => s + v, 0) / scores.length;
      healthBonus = avg * 0.20; // max +0.20
    }

    // Replikasyon bonusu
    const replBonus = session.replication.satisfied ? 0.10 : 0;

    return Math.min(1.0, base + healthBonus + replBonus);
  }

  /**
   * Belirli bir transfer için receipt'i bul.
   */
  get(sessionId: string): GhostReceipt | undefined {
    return this.receipts.get(sessionId);
  }

  /**
   * Tüm receipt'leri sırala (en yeni önce).
   */
  all(limit = 100): GhostReceipt[] {
    return Array.from(this.receipts.values())
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, limit);
  }

  /**
   * Başarısız transferler — yeniden gönderim için.
   */
  failed(): GhostReceipt[] {
    return Array.from(this.receipts.values()).filter((r) => !r.success);
  }

  /**
   * Receipt doğrulama — routeHash'in ghost koordinatlarıyla uyuştuğunu doğrula.
   */
  async verify(receipt: GhostReceipt): Promise<boolean> {
    const expectedHash = await this._computeRouteHash(receipt.spatialLog);
    return expectedHash === receipt.routeHash;
  }

  /**
   * Eski receipt'leri temizle (günden eski).
   */
  prune(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, r] of this.receipts) {
      if (r.completedAt < cutoff) {
        this.receipts.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * İstatistikler — observability için.
   */
  stats(): {
    total:      number;
    successful: number;
    failed:     number;
    avgGhosts:  number;
    avgDist:    number;
  } {
    const all = Array.from(this.receipts.values());
    const ok  = all.filter((r) => r.success);

    return {
      total:      all.length,
      successful: ok.length,
      failed:     all.length - ok.length,
      avgGhosts:  all.length > 0 ? all.reduce((s, r) => s + r.ghostCount, 0) / all.length : 0,
      avgDist:    all.length > 0 ? all.reduce((s, r) => s + r.distance, 0) / all.length : 0,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async _computeRouteHash(
    coords: Array<{ x: number; y: number; z: number }>
  ): Promise<string> {
    const input = coords.map((c) => `${c.x},${c.y},${c.z}`).join("|");
    return sha256Hex(input);
  }
}
