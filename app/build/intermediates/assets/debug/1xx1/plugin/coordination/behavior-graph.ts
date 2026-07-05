/**
 * 1XX1 Behavior Graph — FAZ 8 Block 1
 *
 * Plugin'lerin davranis iliskilerini modeller.
 * Tek plugin degil, GRUP davranisi yonetilir.
 *
 * Node = plugin
 * Edge = davranis bagimlilik (causal, cooperative, competitive)
 *
 * Core'a dokunmaz. FAZ 6/7 ustunde calisir.
 */

export type EdgeType =
  | "causal"       // A calıstıkca B etkileniyor
  | "cooperative"  // A ve B birlikte daha iyi
  | "competitive"  // A ve B ayni EP icin rekabet ediyor
  | "dependent";   // A calismak icin B gerekiyor (DAG edges)

export type BehaviorEdge = {
  from:     string;
  to:       string;
  type:     EdgeType;
  weight:   number;   // 0-1 etki gucu
  observed: number;   // kac kez gozlemlendi
};

export type BehaviorNode = {
  pluginId:   string;
  groupId:    string | null;  // hangi gruba ait
  healthTrend: "improving" | "stable" | "degrading";
  impactScore: number;        // sisteme toplam etkisi 0-1
};

export class BehaviorGraph {
  private nodes = new Map<string, BehaviorNode>();
  private edges: BehaviorEdge[] = [];

  // ─── Node yonetimi ─────────────────────────────────────────────────────────

  addNode(pluginId: string, groupId: string | null = null): void {
    if (this.nodes.has(pluginId)) return;
    this.nodes.set(pluginId, {
      pluginId, groupId,
      healthTrend: "stable",
      impactScore: 0.5,
    });
  }

  removeNode(pluginId: string): void {
    this.nodes.delete(pluginId);
    this.edges = this.edges.filter(e => e.from !== pluginId && e.to !== pluginId);
  }

  updateTrend(pluginId: string, trend: BehaviorNode["healthTrend"]): void {
    const n = this.nodes.get(pluginId);
    if (n) { n.healthTrend = trend; this._recalcImpact(pluginId); }
  }

  // ─── Edge yonetimi ─────────────────────────────────────────────────────────

  observeEdge(from: string, to: string, type: EdgeType, weight = 0.5): void {
    const existing = this.edges.find(e => e.from === from && e.to === to && e.type === type);
    if (existing) {
      existing.observed++;
      // EWMA weight guncelle
      existing.weight = 0.1 * weight + 0.9 * existing.weight;
    } else {
      this.edges.push({ from, to, type, weight, observed: 1 });
    }
  }

  // ─── Sorgu ────────────────────────────────────────────────────────────────

  /** Bir plugin'in etkiledigi diger plugin'ler */
  downstream(pluginId: string): BehaviorEdge[] {
    return this.edges.filter(e => e.from === pluginId);
  }

  /** Bir plugin'i etkileyen plugin'ler */
  upstream(pluginId: string): BehaviorEdge[] {
    return this.edges.filter(e => e.to === pluginId);
  }

  /** Ayni gruptaki plugin'ler */
  group(groupId: string): BehaviorNode[] {
    return [...this.nodes.values()].filter(n => n.groupId === groupId);
  }

  /** En yuksek etkiye sahip plugin'ler */
  topByImpact(n = 5): BehaviorNode[] {
    return [...this.nodes.values()]
      .sort((a, b) => b.impactScore - a.impactScore)
      .slice(0, n);
  }

  /** Rekabet eden plugin ciftleri (ayni EP icin competitive edge) */
  competitors(): Array<{ a: string; b: string; weight: number }> {
    return this.edges
      .filter(e => e.type === "competitive")
      .map(e => ({ a: e.from, b: e.to, weight: e.weight }));
  }

  node(pluginId: string): BehaviorNode | undefined {
    return this.nodes.get(pluginId);
  }

  allNodes(): BehaviorNode[] { return [...this.nodes.values()]; }
  edgeCount(): number        { return this.edges.length; }

  // ─── Impact hesaplama ─────────────────────────────────────────────────────

  private _recalcImpact(pluginId: string): void {
    const n = this.nodes.get(pluginId);
    if (!n) return;
    // Impact = downstream edge agirliklari toplami + trend bonus
    const downstreamWeight = this.downstream(pluginId)
      .reduce((s, e) => s + e.weight, 0);
    const trendBonus =
      n.healthTrend === "improving" ?  0.1 :
      n.healthTrend === "degrading" ? -0.2 : 0;
    n.impactScore = Math.min(1, Math.max(0, downstreamWeight * 0.5 + 0.5 + trendBonus));
  }
}
