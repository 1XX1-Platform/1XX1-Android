/**
 * 1XX1 Peer Table
 * FAZ 1.4 — Kritik ic durum
 *
 * Her peer kaydi:
 *   nodeId    → base58 kimlik (spooflanamaz)
 *   endpoint  → http://ip:port
 *   lastSeen  → unix ms
 *   term      → Raft termi (staleness icin)
 *   reputation → 0-100
 */

export interface PeerRecord {
  nodeId:     string;
  endpoint:   string;
  lastSeen:   number;
  term:       number;
  reputation: number;
  source:     "seed" | "gossip" | "manual" | "lan";
}

const DEAD_THRESHOLD_MS   = 180_000;  // 3 dakika gormezse oldu
const MAX_PEERS           = 256;

export class PeerTable {
  private readonly _peers = new Map<string, PeerRecord>();

  has(nodeId: string): boolean {
    return this._peers.has(nodeId);
  }

  upsert(record: Omit<PeerRecord, "reputation"> & { reputation?: number }): void {
    const existing = this._peers.get(record.nodeId);

    // Endpoint spoof koruması: mevcut kayıt varsa ve endpoint değiştiyse
    // sadece daha yüksek reputation'da güncelle
    if (existing && existing.endpoint !== record.endpoint) {
      if ((record.reputation ?? 50) < existing.reputation) {
        // Düşük reputasyonlu farklı endpoint — sadece lastSeen güncelle
        this._peers.set(record.nodeId, { ...existing, lastSeen: Math.max(record.lastSeen, existing.lastSeen) });
        this._evictIfNeeded();
        return;
      }
    }

    this._peers.set(record.nodeId, {
      reputation: existing?.reputation ?? 50,
      ...existing,
      ...record,
      lastSeen: Math.max(record.lastSeen, existing?.lastSeen ?? 0),
    });
    this._evictIfNeeded();
  }

  get(nodeId: string): PeerRecord | undefined {
    return this._peers.get(nodeId);
  }

  alive(): PeerRecord[] {
    const cutoff = Date.now() - DEAD_THRESHOLD_MS;
    return Array.from(this._peers.values()).filter(p => p.lastSeen >= cutoff);
  }

  all(): PeerRecord[] {
    return Array.from(this._peers.values());
  }

  markDead(nodeId: string): void {
    const p = this._peers.get(nodeId);
    if (p) {
      this._peers.set(nodeId, { ...p, reputation: Math.max(0, p.reputation - 20) });
    }
  }

  markSeen(nodeId: string): void {
    const p = this._peers.get(nodeId);
    if (p) {
      this._peers.set(nodeId, {
        ...p,
        lastSeen:   Date.now(),
        reputation: Math.min(100, p.reputation + 5),
      });
    }
  }

  remove(nodeId: string): void {
    this._peers.delete(nodeId);
  }

  size(): number { return this._peers.size; }

  /** En iyi N peer: reputation + lastSeen sirali */
  best(n = 8): PeerRecord[] {
    return this.alive()
      .sort((a, b) => (b.reputation * 1000 + b.lastSeen) - (a.reputation * 1000 + a.lastSeen))
      .slice(0, n);
  }

  /** Gossip icin rastgele peer sec */
  random(): PeerRecord | null {
    const alive = this.alive();
    if (alive.length === 0) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  /** Conflict-free merge: iki peer tablosunu birlestir, kendi nodeId'yi dahil etme */
  merge(remote: PeerRecord[], selfNodeId?: string): number {
    let added = 0;
    for (const r of remote) {
      if (selfNodeId && r.nodeId === selfNodeId) continue; // kendini ekleme
      const existing = this._peers.get(r.nodeId);
      if (!existing || r.lastSeen > existing.lastSeen) {
        this.upsert(r);
        added++;
      }
    }
    return added;
  }

  toJSON(): PeerRecord[] {
    return this.all();
  }

  private _evictIfNeeded(): void {
    if (this._peers.size <= MAX_PEERS) return;
    // En dusuk reputation + en eski lastSeen'i cikart
    const sorted = Array.from(this._peers.entries())
      .sort(([, a], [, b]) => (a.reputation + a.lastSeen / 1e10) - (b.reputation + b.lastSeen / 1e10));
    for (const [nodeId] of sorted.slice(0, this._peers.size - MAX_PEERS)) {
      this._peers.delete(nodeId);
    }
  }
}
