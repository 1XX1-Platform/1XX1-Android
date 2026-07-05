/**
 * 1XX1 Ghost Cube — Path Optimizer
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Kaptan'ın tespiti:
 *   "En kısa yol ile en iyi yol aynı değildir."
 *   GhostRouter rota üretir → PathOptimizer rota SEÇER.
 *
 * Örnek:
 *   A → B(BLE) → C(LAN) → D   : 3 hop, yavaş
 *   A → E(WiFi) → D            : 2 hop, hızlı
 *   PathOptimizer ikincisini seçer.
 *
 * Seçim kriterleri:
 *   1. Sağlık skoru (GhostHealthMonitor'dan koordinat başarı oranı)
 *   2. Tahmini gecikme (hop × avgLatency)
 *   3. Zincir uzunluğu (kısa tercih edilir ama tek kriter değil)
 *   4. Bant genişliği (LinkManager'dan bilinen transport tipi)
 *
 * GhostRouter'dan farkı:
 *   Router: "Bu paketle ne yapayım? İlet mi, sakla mı, düşür mü?"
 *   Optimizer: "Birden fazla olası zincir var — hangisini seç?"
 */

import { coordToKey } from "./ghost-math.ts";
import type { GhostRoute, GhostCube } from "./ghost-types.ts";
import type { GhostHealthMonitor } from "./ghost-health.ts";
import type { SpatialTopology }    from "./spatial-topology.ts";

// ─── Rota Skoru ───────────────────────────────────────────────────────────────

export interface RouteScore {
  route:              GhostRoute;
  totalScore:         number;    // yüksek = daha iyi
  healthScore:        number;    // koordinat sağlık ortalaması (0-1)
  latencyScore:       number;    // tahmini gecikme skoru (0-1, düşük gecikme = yüksek skor)
  hopScore:           number;    // zincir uzunluğu skoru (kısa = yüksek)
  availabilityScore:  number;    // koordinatların boş olup olmadığı (0-1)
}

// ─── PathOptimizer ────────────────────────────────────────────────────────────

export class PathOptimizer {
  private readonly _health:   GhostHealthMonitor;
  private readonly _topology: SpatialTopology;
  private readonly _weights: { health: number; latency: number; hops: number; availability: number };

  constructor(
    health:   GhostHealthMonitor,
    topology: SpatialTopology,
    weights = {
      health:       0.40,
      latency:      0.35,
      hops:         0.25,
      availability: 0.00,
    }
  ) {
    this.latency = latency;
    this.hops = hops;
    this.availability = availability;
    this._health   = health;
    this._topology = topology;
    this._weights  = weights;
  }

  /**
   * Birden fazla aday rota arasından en iyisini seç.
   * Tek rota varsa doğrudan döndürür.
   */
  selectBest(candidates: GhostRoute[]): GhostRoute | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const scored = candidates.map((r) => this._score(r));
    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored[0].route;
  }

  /**
   * Tüm adayları skorla — debug / observability için.
   */
  scoreAll(candidates: GhostRoute[]): RouteScore[] {
    return candidates
      .map((r) => this._score(r))
      .sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * Ana rota + alternatifler arasından en iyisini seç.
   * GhostRoute.alternatives kümesini de dahil eder.
   */
  selectBestWithAlternatives(primary: GhostRoute): GhostRoute {
    const candidates = [primary, ...primary.alternatives.map((chain) => ({
      ...primary,
      chain,
      alternatives: [],
    }))];
    return this.selectBest(candidates) ?? primary;
  }

  /**
   * Bir rotanın "kaçınılması gereken" koordinat içerip içermediğini kontrol et.
   * (GhostHealthMonitor'dan worstCoords ile beslenir)
   */
  hasBlacklistedCoord(route: GhostRoute, blacklist: Set<string>): boolean {
    return route.chain.some((g) => blacklist.has(coordToKey(g.coordinate)));
  }

  /**
   * En az sağlıklı koordinatları filtrele — kaçınma listesi üret.
   * Örn. successRate < 0.3 olan koordinatlar.
   */
  buildBlacklist(threshold = 0.3): Set<string> {
    const worst  = this._health.worstCoords(20);
    const result = new Set<string>();
    for (const rec of worst) {
      if (rec.successRate < threshold) result.add(rec.coordKey);
    }
    return result;
  }

  // ─── Private: Skor Hesaplama ──────────────────────────────────────────────

  private _score(route: GhostRoute): RouteScore {
    const chain = route.chain;
    if (chain.length === 0) {
      return {
        route,
        totalScore:        0,
        healthScore:       0,
        latencyScore:      0,
        hopScore:          0,
        availabilityScore: 0,
      };
    }

    // 1. Sağlık skoru: koordinat başarı oranı ortalaması
    const healthScore = this._avgCoordScore(chain);

    // 2. Gecikme skoru: toplam tahmini gecikme → normalize
    const estLatencyMs = this._estimateLatency(chain);
    // 200ms altı mükemmel, 2000ms üstü kötü
    const latencyScore = Math.max(0, 1 - estLatencyMs / 2000);

    // 3. Hop skoru: kısa zincir daha iyi (max 60 hop → normalize)
    const hopScore = Math.max(0, 1 - (chain.length - 1) / 60);

    // 4. Erişilebilirlik: koordinatların boş olup olmadığı
    const availabilityScore = this._availabilityScore(chain);

    const totalScore =
      this._weights.health       * healthScore +
      this._weights.latency      * latencyScore +
      this._weights.hops         * hopScore +
      this._weights.availability * availabilityScore;

    return {
      route, totalScore,
      healthScore, latencyScore, hopScore, availabilityScore,
    };
  }

  private _avgCoordScore(chain: GhostCube[]): number {
    if (chain.length === 0) return 0.5;
    const sum = chain.reduce((s, g) =>
      s + this._health.coordScore(coordToKey(g.coordinate)), 0
    );
    return sum / chain.length;
  }

  private _estimateLatency(chain: GhostCube[]): number {
    let total = 0;
    for (const g of chain) {
      const rec = this._health.getCoord(coordToKey(g.coordinate));
      total += rec?.avgLatencyMs ?? 20; // bilinmiyorsa 20ms varsayılan
    }
    return total;
  }

  private _availabilityScore(chain: GhostCube[]): number {
    let available = 0;
    for (const g of chain) {
      if (this._topology.isEmpty(g.coordinate)) available++;
    }
    return chain.length > 0 ? available / chain.length : 0;
  }
}
