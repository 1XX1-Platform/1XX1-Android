/**
 * 1XX1 QueryPlanner
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Sorumluluk: ParsedQuery → QueryPlan
 *
 * Sorgu tipine göre optimal execution planı üretir:
 *
 *   A) Semantic  → semantic-lookup → reverse-filter → score → rank
 *   B) Structural → structural-route → neighborhood-expand → score → rank
 *   C) Hybrid    → [A + B paralel] → merge-candidates → score → rank
 *
 * Maliyet tahmini:
 *   Structural O(1): path doğrudan → küp hücresi
 *   Semantic   O(k): k = token başına aday sayısı
 *   Hybrid     O(log n + k): her ikisi birlikte
 *
 * Planner veriyi okumaz; yalnızca plan üretir (pure function).
 */

import type { ParsedQuery, QueryPlan, PlanStep } from "./search-types.ts";

// ─── QueryPlanner ─────────────────────────────────────────────────────────────

export class QueryPlanner {

  /**
   * Verilen ParsedQuery için optimal QueryPlan üret.
   * Maliyet tahmini intent'e göre seçilir.
   */
  plan(query: ParsedQuery): QueryPlan {
    switch (query.intent) {
      case "structural": return this._planStructural(query);
      case "semantic":   return this._planSemantic(query);
      case "hybrid":     return this._planHybrid(query);
    }
  }

  // ─── A) Structural Plan ───────────────────────────────────────────────────

  private _planStructural(query: ParsedQuery): QueryPlan {
    const steps: PlanStep[] = [];

    if (query.targetPath) {
      // Tam path → doğrudan küp hücresine git
      steps.push({ type: "structural-route", path: query.targetPath });
    } else if (query.targetCoord) {
      // Koordinat → kök path + komşu genişletme
      const rootPath = `${query.targetCoord.x}/${query.targetCoord.y}/${query.targetCoord.z}`;
      steps.push({ type: "structural-route", path: rootPath });
      steps.push({
        type:   "neighborhood-expand",
        coord:  query.targetCoord,
        radius: 1,
      });
    }

    // Reverse filtreler varsa ekle
    const filterKeys = this._filterKeys(query);
    if (filterKeys.length > 0) {
      steps.push({ type: "reverse-filter", keys: filterKeys });
    }

    steps.push({ type: "merge-candidates" });
    steps.push({ type: "score" });
    steps.push({
      type:   "rank-and-slice",
      limit:  query.options.limit,
      offset: query.options.offset,
    });

    return { intent: "structural", steps, estimatedCost: "O(1)" };
  }

  // ─── B) Semantic Plan ─────────────────────────────────────────────────────

  private _planSemantic(query: ParsedQuery): QueryPlan {
    const steps: PlanStep[] = [];

    // Token lookup
    steps.push({ type: "semantic-lookup", tokens: query.tokens });

    // Reverse filtreler
    const filterKeys = this._filterKeys(query);
    if (filterKeys.length > 0) {
      steps.push({ type: "reverse-filter", keys: filterKeys });
    }

    // Koordinat filtresi varsa komşuluk genişletme de yap
    if (query.filter.coord) {
      steps.push({
        type:   "neighborhood-expand",
        coord:  query.filter.coord,
        radius: 1,
      });
    }

    steps.push({ type: "merge-candidates" });
    steps.push({ type: "score" });
    steps.push({
      type:   "rank-and-slice",
      limit:  query.options.limit,
      offset: query.options.offset,
    });

    return { intent: "semantic", steps, estimatedCost: "O(k)" };
  }

  // ─── C) Hybrid Plan ───────────────────────────────────────────────────────

  private _planHybrid(query: ParsedQuery): QueryPlan {
    const steps: PlanStep[] = [];

    // Semantic kol
    steps.push({ type: "semantic-lookup", tokens: query.tokens });

    // Structural kol (ayrı eklenir, merge birleştirir)
    if (query.targetPath) {
      steps.push({ type: "structural-route", path: query.targetPath });
    } else if (query.targetCoord) {
      const rootPath = `${query.targetCoord.x}/${query.targetCoord.y}/${query.targetCoord.z}`;
      steps.push({ type: "structural-route", path: rootPath });
      steps.push({
        type:   "neighborhood-expand",
        coord:  query.targetCoord,
        radius: 2, // hybrid'de daha geniş komşuluk
      });
    }

    // Filtreler
    const filterKeys = this._filterKeys(query);
    if (filterKeys.length > 0) {
      steps.push({ type: "reverse-filter", keys: filterKeys });
    }

    steps.push({ type: "merge-candidates" });
    steps.push({ type: "score" });
    steps.push({
      type:   "rank-and-slice",
      limit:  query.options.limit,
      offset: query.options.offset,
    });

    return { intent: "hybrid", steps, estimatedCost: "O(log n)" };
  }

  // ─── Yardımcılar ─────────────────────────────────────────────────────────

  private _filterKeys(query: ParsedQuery): string[] {
    const keys: string[] = [];
    if (query.filter.developerId) keys.push(`dev:${query.filter.developerId}`);
    if (query.filter.license)     keys.push(`lic:${query.filter.license}`);
    if (query.filter.status)      keys.push(`status:${query.filter.status}`);
    if (query.filter.tags) {
      for (const t of query.filter.tags) keys.push(`tag:${t.toLowerCase().trim()}`);
    }
    return keys;
  }
}

export const queryPlanner = new QueryPlanner();
