/**
 * 1XX1 Sybil Guard
 * FAZ 4.3 — Sybil Resistance
 *
 * Hafif Sybil direnci. Tam PoW yerine:
 *   1. Rate limiting (IP bazi)
 *   2. Ayni IP'den cok fazla farkli nodeId tespiti
 *   3. Anormal davranis paterni tespiti
 *
 * Not: Gercek Sybil direnci icin ek mekanizmalar gerekir
 * (PoW, stake, sosyal trust graph vs.)
 * Bu modul "minimum viable" koruma saglar.
 */

const MAX_NODES_PER_IP    = 5;
const RATE_WINDOW_MS      = 60_000;
const MAX_REQUESTS_PER_IP = 100;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

export class SybilGuard {
  private readonly ipRecords = new Map();
  private readonly flaggedNodes = new Set<string>();
  private _cleanupTimer?: ReturnType<typeof setInterval>;

  start(): void {
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }

  /**
   * Handshake istegi degerlendir.
   * true = izin ver, false = reddet (Sybil suphecesi)
   */
  checkHandshake(nodeId: string, sourceIp: string): {
    allowed: boolean;
    reason?: string;
  } {
    // Onceden isaretlenmis node
    if (this.flaggedNodes.has(nodeId)) {
      return { allowed: false, reason: "NODE_FLAGGED" };
    }

    const now = Date.now();
    let record = this.ipRecords.get(sourceIp);

    if (!record) {
      record = {
        nodeIds: new Set(), requests: 0,
        firstSeen: now, lastSeen: now, flagged: false,
      };
      this.ipRecords.set(sourceIp, record);
    }

    // IP isaretlenmis mi?
    if (record.flagged) {
      return { allowed: false, reason: "IP_FLAGGED" };
    }

    // Rate limit
    const windowAge = now - record.firstSeen;
    if (windowAge < RATE_WINDOW_MS) {
      record.requests++;
      if (record.requests > MAX_REQUESTS_PER_IP) {
        record.flagged = true;
        return { allowed: false, reason: "RATE_LIMITED" };
      }
    } else {
      // Yeni pencere
      record.requests = 1;
      record.firstSeen = now;
    }

    // Ayni IP'den cok fazla nodeId
    record.nodeIds.add(nodeId);
    if (record.nodeIds.size > MAX_NODES_PER_IP) {
      record.flagged = true;
      // Tum bu nodeId'leri de isaretleme
      for (const nid of record.nodeIds) {
        this.flaggedNodes.add(nid);
      }
      return { allowed: false, reason: "TOO_MANY_NODES_FROM_IP" };
    }

    record.lastSeen = now;
    return { allowed: true };
  }

  flagNode(nodeId: string): void {
    this.flaggedNodes.add(nodeId);
  }

  isFlagged(nodeId: string): boolean {
    return this.flaggedNodes.has(nodeId);
  }

  stats() {
    return {
      trackedIps:   this.ipRecords.size,
      flaggedNodes: this.flaggedNodes.size,
      flaggedIps:   Array.from(this.ipRecords.values()).filter(r => r.flagged).length,
    };
  }

  private _cleanup(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS * 5;
    for (const [ip, record] of this.ipRecords) {
      if (record.lastSeen < cutoff && !record.flagged) {
        this.ipRecords.delete(ip);
      }
    }
  }
}
