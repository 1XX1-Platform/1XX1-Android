/**
 * 1XX1 CandidateGenerator
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Sorumluluk: QueryPlan adımlarını çalıştır → Set<Candidate>
 *
 * Adım yürütme sırası:
 *   semantic-lookup     → SemanticIndex'ten aday çek
 *   reverse-filter      → ReverseIndex AND kesişimi
 *   structural-route    → StructuralIndex'ten path içeriği
 *   neighborhood-expand → CubePath komşuları
 *   merge-candidates    → tüm kaynakları birleştir
 *
 * Kritik kural (Aşama 05 — 10):
 *   ❌ Hiçbir zaman veri yazmaz.
 *   ✔  Yalnızca okur.
 */

import type { QueryPlan, PlanStep, Candidate, ExplainStep } from "./search-types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import type { ReverseIndex } from "./reverse-index.ts";
import type { StructuralIndex } from "./structural-index.ts";
import { getNeighbors } from "../core/utils.ts";
import { rootPath } from "../cube_engine/cube-path.ts";

// ─── Aday Havuzu ─────────────────────────────────────────────────────────────

export interface CandidatePool {
  candidates: Map<ProjectID, Candidate>;
  explain:    ExplainStep[];
}

// ─── CandidateGenerator ──────────────────────────────────────────────────────

export class CandidateGenerator {

  constructor(
    semantic:   SemanticIndex,
    reverse:    ReverseIndex,
    structural: StructuralIndex,
  ) {
    this.structural = structural;
    this.reverse = reverse;
    this.semantic = semantic;}

  /**
   * QueryPlan'ı yürüt, aday havuzu üret.
   * Herbir adımın çıktısı sonraki adıma girdi olur.
   * merge-candidates adımı tüm ara sonuçları birleştirir.
   */
  generate(plan: QueryPlan, explain = false): CandidatePool {
    // Ara havuzlar: her kaynaktan gelen adaylar
    const pools: Map<Candidate["source"], Set<ProjectID>> = new Map([
      ["semantic",     new Set()],
      ["structural",   new Set()],
      ["reverse",      new Set()],
      ["neighborhood", new Set()],
    ]);

    const explainSteps: ExplainStep[] = [];

    // Reverse filter kümesi (AND — birden fazla filter-step birleşir)
    let reverseFilterSet: Set<ProjectID> | null = null;

    for (const step of plan.steps) {
      const stepStart = Date.now();

      switch (step.type) {

        // ── Semantic Lookup ──
        case "semantic-lookup": {
          const hits = this.semantic.search(step.tokens, { limit: 500 });
          const pool = pools.get("semantic")!;
          for (const h of hits) pool.add(h.projectId);

          if (explain) explainSteps.push({
            name:        "semantic-lookup",
            inputCount:  step.tokens.length,
            outputCount: pool.size,
            durationMs:  Date.now() - stepStart,
            detail:      `tokens: [${step.tokens.slice(0, 5).join(", ")}]`,
          });
          break;
        }

        // ── Reverse Filter (AND) ──
        case "reverse-filter": {
          const filterResult = this.reverse.getIntersection(step.keys);
          if (reverseFilterSet === null) {
            reverseFilterSet = new Set(filterResult);
          } else {
            // Birden fazla filter-step → AND
            for (const pid of reverseFilterSet) {
              if (!filterResult.has(pid)) reverseFilterSet.delete(pid);
            }
          }
          const pool = pools.get("reverse")!;
          for (const pid of filterResult) pool.add(pid);

          if (explain) explainSteps.push({
            name:        "reverse-filter",
            inputCount:  step.keys.length,
            outputCount: filterResult.size,
            durationMs:  Date.now() - stepStart,
            detail:      `keys: [${step.keys.join(", ")}]`,
          });
          break;
        }

        // ── Structural Route ──
        case "structural-route": {
          const pool = pools.get("structural")!;
          // Path'teki tüm projeleri al
          const ids = this.structural.getIdsByPath(step.path);
          for (const id of ids) pool.add(id);

          // Alt path'lerde de proje olabilir
          const subEntries = this._subEntries(step.path);
          for (const id of subEntries) pool.add(id);

          if (explain) explainSteps.push({
            name:        "structural-route",
            inputCount:  1,
            outputCount: pool.size,
            durationMs:  Date.now() - stepStart,
            detail:      `path: ${step.path}`,
          });
          break;
        }

        // ── Neighborhood Expand ──
        case "neighborhood-expand": {
          const pool = pools.get("neighborhood")!;
          const neighbors = getNeighbors(step.coord, step.radius);

          for (const nc of neighbors) {
            const nPath = rootPath(nc);
            const ids   = this.structural.getIdsByPath(nPath);
            for (const id of ids) pool.add(id);
          }

          if (explain) explainSteps.push({
            name:        "neighborhood-expand",
            inputCount:  neighbors.length,
            outputCount: pool.size,
            durationMs:  Date.now() - stepStart,
            detail:      `coord: ${step.coord.x},${step.coord.y},${step.coord.z} r=${step.radius}`,
          });
          break;
        }

        // ── Merge Candidates ──
        case "merge-candidates": {
          // Tüm havuzları birleştir (union)
          // Reverse filter varsa uygula (AND)
          break; // merge aşağıda yapılır
        }

        // score ve rank-and-slice bu katmanda işlenmez
        case "score":
        case "rank-and-slice":
          break;
      }
    }

    // ── Havuzları Birleştir ──
    const merged = new Map<ProjectID, Candidate>();

    const addAll = (pool: Set<ProjectID>, source: Candidate["source"]) => {
      for (const pid of pool) {
        if (!merged.has(pid)) {
          merged.set(pid, { projectId: pid, source });
        }
      }
    };

    addAll(pools.get("structural")!,   "structural");
    addAll(pools.get("neighborhood")!, "neighborhood");
    addAll(pools.get("semantic")!,     "semantic");
    addAll(pools.get("reverse")!,      "reverse");

    // Reverse filter AND uygula: yalnızca filtre kümesindekiler kalır
    if (reverseFilterSet !== null && reverseFilterSet.size > 0) {
      for (const pid of merged.keys()) {
        if (!reverseFilterSet.has(pid)) merged.delete(pid);
      }
    }

    if (explain) {
      explainSteps.push({
        name:        "merge-candidates",
        inputCount:  Array.from(pools.values()).reduce((s, p) => s + p.size, 0),
        outputCount: merged.size,
        durationMs:  0,
      });
    }

    return { candidates: merged, explain: explainSteps };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /** Verilen path ile başlayan tüm alt path'lerdeki proje ID'leri */
  private _subEntries(basePath: string): ProjectID[] {
    const entries = this.structural.getByCoordPrefix(basePath);
    return entries.flatMap((e) =>
      Array.from(this.structural.getIdsByPath(e.path))
    );
  }
}
