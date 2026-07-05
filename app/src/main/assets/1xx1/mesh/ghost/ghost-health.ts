/**
 * 1XX1 Ghost Cube — Ghost Health Monitor
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Ghost'ların süreç içi sağlık metrikleri.
 * Receipt sonuç kaydıysa, Health aktif izleme.
 *
 * Her ghost için izlenen metrikler:
 *   packetsCarried   — kaç paket taşıdı
 *   failures         — kaç kez başarısız oldu
 *   avgLatencyMs     — ortalama gecikme
 *   lastActiveAt     — son aktif zaman
 *   successRate      — başarı oranı (0.0-1.0)
 *
 * Bu metrikler PathOptimizer'a ve ConfidenceScore hesabına beslenir.
 * GhostRouter karar verirken buradaki sağlık bilgisini kullanabilir.
 */

// ─── Tek Ghost Sağlık Kaydı ───────────────────────────────────────────────────

export interface GhostHealthRecord {
  ghostId:        string;
  sessionId:      string;
  /** Toplam taşınan paket */
  packetsCarried: number;
  /** Başarısız iletim sayısı */
  failures:       number;
  /** Gecikme örnekleri (ms) — p50/p99 için saklanır */
  latencySamples: number[];
  /** İlk aktif olduğu zaman */
  firstSeenAt:    number;
  /** Son aktif olduğu zaman */
  lastActiveAt:   number;
  /** Hesaplanan başarı oranı */
  successRate:    number;
  /** Hesaplanan ortalama gecikme */
  avgLatencyMs:   number;
}

// ─── Koordinat Bazlı Sağlık (topoloji birikimine beslenir) ────────────────────

export interface CoordHealthRecord {
  coordKey:       string;        // "x,y,z"
  totalPackets:   number;
  totalFailures:  number;
  successRate:    number;
  avgLatencyMs:   number;
  lastUsedAt:     number;
}

// ─── GhostHealthMonitor ───────────────────────────────────────────────────────

export class GhostHealthMonitor {
  /** ghostId → sağlık kaydı */
  private readonly _ghosts   = new Map<string, GhostHealthRecord>();
  /** koordinat → birikimli sağlık (eski ghost'lar silinse bile) */
  private readonly _coords   = new Map<string, CoordHealthRecord>();
  /** Gecikme örnekleri için maksimum saklama */
  private readonly MAX_SAMPLES = 50;
  /** Ghost sağlık kaydı için maksimum saklama */
  private readonly MAX_GHOSTS  = 10_000;

  // ─── Kayıt Başlatma ────────────────────────────────────────────────────────

  register(ghostId: string, sessionId: string): void {
    if (this._ghosts.size >= this.MAX_GHOSTS) this._evictOldest();

    this._ghosts.set(ghostId, {
      ghostId, sessionId,
      packetsCarried: 0, failures: 0,
      latencySamples: [], firstSeenAt: Date.now(),
      lastActiveAt: Date.now(),
      successRate: 1.0, avgLatencyMs: 0,
    });
  }

  // ─── Metrik Güncelleme ─────────────────────────────────────────────────────

  /**
   * Başarılı iletim kaydı.
   * @param ghostId      Ghost ID'si
   * @param coordKey     Ghost'un koordinat anahtarı ("x,y,z")
   * @param latencyMs    Bu iletimdeki gecikme
   */
  recordSuccess(ghostId: string, coordKey: string, latencyMs: number): void {
    this._updateGhost(ghostId, true, latencyMs);
    this._updateCoord(coordKey, true, latencyMs);
  }

  /**
   * Başarısız iletim kaydı.
   */
  recordFailure(ghostId: string, coordKey: string): void {
    this._updateGhost(ghostId, false, 0);
    this._updateCoord(coordKey, false, 0);
  }

  // ─── Sorgular ──────────────────────────────────────────────────────────────

  getGhost(ghostId: string): GhostHealthRecord | undefined {
    return this._ghosts.get(ghostId);
  }

  getCoord(coordKey: string): CoordHealthRecord | undefined {
    return this._coords.get(coordKey);
  }

  /**
   * Bir koordinatın güvenilirlik skoru (0.0-1.0).
   * PathOptimizer ve ConfidenceScore bu değeri kullanır.
   */
  coordScore(coordKey: string): number {
    const rec = this._coords.get(coordKey);
    if (!rec || rec.totalPackets === 0) return 0.5; // bilinmiyor → tarafsız
    return rec.successRate;
  }

  /**
   * Bir ghost'un p50 ve p99 gecikmeleri.
   */
  latencyPercentiles(ghostId: string): { p50: number; p99: number } | null {
    const rec = this._ghosts.get(ghostId);
    if (!rec || rec.latencySamples.length === 0) return null;

    const sorted = [...rec.latencySamples].sort((a, b) => a - b);
    return {
      p50: sorted[Math.floor(sorted.length * 0.50)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  /**
   * Sistem geneli özet.
   */
  systemStats(): {
    totalGhosts:   number;
    totalCoords:   number;
    avgSuccessRate: number;
    avgLatencyMs:  number;
  } {
    const ghosts = Array.from(this._ghosts.values());
    const coords  = Array.from(this._coords.values());

    const avgSR  = ghosts.length > 0
      ? ghosts.reduce((s, g) => s + g.successRate, 0) / ghosts.length : 0;
    const avgLat = ghosts.length > 0
      ? ghosts.reduce((s, g) => s + g.avgLatencyMs, 0) / ghosts.length : 0;

    return {
      totalGhosts:    ghosts.length,
      totalCoords:    coords.length,
      avgSuccessRate: avgSR,
      avgLatencyMs:   avgLat,
    };
  }

  /**
   * En sağlıklı koordinatlar (PathOptimizer için).
   */
  topCoords(n = 10): CoordHealthRecord[] {
    return Array.from(this._coords.values())
      .filter((r) => r.totalPackets > 0)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, n);
  }

  /**
   * En sorunlu koordinatlar (kaçınma listesi için).
   */
  worstCoords(n = 10): CoordHealthRecord[] {
    return Array.from(this._coords.values())
      .filter((r) => r.totalPackets >= 3) // yeterli örnekle
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, n);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _updateGhost(ghostId: string, success: boolean, latencyMs: number): void {
    const rec = this._ghosts.get(ghostId);
    if (!rec) return;

    rec.packetsCarried += success ? 1 : 0;
    rec.failures       += success ? 0 : 1;
    rec.lastActiveAt    = Date.now();

    if (success && latencyMs > 0) {
      rec.latencySamples.push(latencyMs);
      if (rec.latencySamples.length > this.MAX_SAMPLES) rec.latencySamples.shift();
      rec.avgLatencyMs = rec.latencySamples.reduce((s, v) => s + v, 0) / rec.latencySamples.length;
    }

    const total     = rec.packetsCarried + rec.failures;
    rec.successRate = total > 0 ? rec.packetsCarried / total : 1.0;
  }

  private _updateCoord(coordKey: string, success: boolean, latencyMs: number): void {
    const existing = this._coords.get(coordKey) ?? {
      coordKey, totalPackets: 0, totalFailures: 0,
      successRate: 1.0, avgLatencyMs: 0, lastUsedAt: 0,
    };

    const total   = existing.totalPackets + existing.totalFailures + 1;
    const packets = existing.totalPackets + (success ? 1 : 0);
    const fails   = existing.totalFailures + (success ? 0 : 1);

    // Üstel hareketli ortalama gecikme (son değerlere daha fazla ağırlık)
    const alpha  = 0.2;
    const newLat = success && latencyMs > 0
      ? existing.avgLatencyMs * (1 - alpha) + latencyMs * alpha
      : existing.avgLatencyMs;

    this._coords.set(coordKey, {
      coordKey,
      totalPackets:  packets,
      totalFailures: fails,
      successRate:   packets / total,
      avgLatencyMs:  newLat,
      lastUsedAt:    Date.now(),
    });
  }

  /** En eski ghost kaydını sil (bellek yönetimi) */
  private _evictOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, rec] of this._ghosts) {
      if (rec.lastActiveAt < oldestTime) {
        oldestTime = rec.lastActiveAt;
        oldest = id;
      }
    }
    if (oldest) this._ghosts.delete(oldest);
  }
}
