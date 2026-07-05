/**
 * 1XX1 Recommendation Engine — FAZ 10 Block 4
 *
 * Yeni karar URETMEZ. Sadece oneri uretir.
 * Karar yine PolicyEngine'dedir.
 *
 * Knowledge API: salt okunur
 *   queryCapabilities()
 *   queryCompatibility()
 *   queryHistory()
 *   queryHealthTrend()
 *   queryRecommendations()
 */

import type { KnowledgeRegistry } from "./knowledge-registry.ts";
import type { CapabilityCatalog, CompatibilityMatrix } from "./capability-catalog.ts";

// ─── Oneri Tipleri ────────────────────────────────────────────────────────────

export type RecommendationType =
  | "prefer_alternative"   // baska plugin daha iyi
  | "version_warning"      // bu surum sorunlu
  | "rollback_discouraged" // rollback tarihte basarisiz
  | "compatibility_risk"   // uyumluluk sorunu
  | "performance_suggest"  // performans onerisi
  | "stability_note";      // kararlilik notu

export type Recommendation = {
  pluginId:    string;
  type:        RecommendationType;
  message:     string;
  confidence:  number;   // 0-1 (bu oneri ne kadar guvenilir)
  alternative?: string;  // alternatif plugin id
  source:      "knowledge_registry" | "capability_catalog" | "compatibility_matrix";
};

// ─── Knowledge API ────────────────────────────────────────────────────────────

export class RecommendationEngine {
  private registry: KnowledgeRegistry;
  private catalog:  CapabilityCatalog;
  private matrix:   CompatibilityMatrix;

  constructor(
    registry: KnowledgeRegistry,
    catalog:  CapabilityCatalog,
    matrix:   CompatibilityMatrix,
  ) {
    this.registry = registry;
    this.catalog  = catalog;
    this.matrix   = matrix;
  }

  // ─── Salt okunur API ───────────────────────────────────────────────────────

  queryCapabilities(pluginId: string) {
    return this.catalog.get(pluginId);
  }

  queryCompatibility(pluginA: string, pluginB: string) {
    return this.matrix.check(pluginA, pluginB);
  }

  queryHistory(pluginId: string) {
    return this.registry.get(pluginId);
  }

  queryHealthTrend(pluginId: string): "improving" | "stable" | "degrading" | "unknown" {
    const k = this.registry.get(pluginId);
    if (!k || k.statistics.totalRuns < 5) return "unknown";
    if (k.knowledgeScore >= 0.7 && k.statistics.successRate >= 0.85) return "improving";
    if (k.knowledgeScore < 0.4 || k.statistics.rollbackCount > 2)    return "degrading";
    return "stable";
  }

  queryRecommendations(pluginId: string, existingPlugins: string[] = []): Recommendation[] {
    const recs: Recommendation[] = [];
    const k = this.registry.get(pluginId);

    // 1. Rollback gecmisi varsa uyar
    if (k && k.statistics.rollbackCount >= 2) {
      recs.push({
        pluginId, type: "rollback_discouraged",
        message: `${k.statistics.rollbackCount} gecmis rollback tespit edildi. Bu surum kararli olmayabilir.`,
        confidence: Math.min(1, k.statistics.rollbackCount / 5),
        source: "knowledge_registry",
      });
    }

    // 2. Quarantine gecmisi varsa uyar
    if (k && k.statistics.quarantineCount >= 1) {
      recs.push({
        pluginId, type: "stability_note",
        message: `Plugin ${k.statistics.quarantineCount} kez karantinaya alindi.`,
        confidence: 0.8,
        source: "knowledge_registry",
      });
    }

    // 3. Uyumluluk riski
    const risk = this.matrix.installRisk(pluginId, existingPlugins);
    if (risk.conflicts.length > 0) {
      recs.push({
        pluginId, type: "compatibility_risk",
        message: `Uyumsuz plugin'ler tespit edildi: ${risk.conflicts.join(", ")}`,
        confidence: 0.95,
        source: "compatibility_matrix",
      });
    }
    if (risk.warnings.length > 0) {
      recs.push({
        pluginId, type: "version_warning",
        message: `Uyumluluk uyarilari: ${risk.warnings.join("; ")}`,
        confidence: 0.7,
        source: "compatibility_matrix",
      });
    }

    // 4. Alternatif oneri: ayni kategori, daha yuksek skor
    const cap = this.catalog.get(pluginId);
    if (cap && k) {
      for (const category of cap.categories) {
        const alternatives = this.catalog.byCategory(category)
          .filter(e => e.pluginId !== pluginId && !e.deprecated);

        for (const alt of alternatives) {
          const altK = this.registry.get(alt.pluginId);
          if (altK && altK.knowledgeScore > k.knowledgeScore + 0.2) {
            recs.push({
              pluginId, type: "prefer_alternative",
              message: `${alt.pluginId} bu kategori icin daha yuksek bilgi skoruna sahip (${altK.knowledgeScore.toFixed(2)} vs ${k.knowledgeScore.toFixed(2)}).`,
              confidence: 0.6,
              alternative: alt.pluginId,
              source: "capability_catalog",
            });
            break;
          }
        }
      }
    }

    // Confidence'a gore sirala
    return recs.sort((a, b) => b.confidence - a.confidence);
  }

  /** Tum plugin'ler icin ozet */
  summaryAll(): Array<{ pluginId: string; score: number; trend: string; recCount: number }> {
    return this.registry.all().map(k => ({
      pluginId: k.pluginId,
      score:    k.knowledgeScore,
      trend:    this.queryHealthTrend(k.pluginId),
      recCount: this.queryRecommendations(k.pluginId).length,
    }));
  }
}
