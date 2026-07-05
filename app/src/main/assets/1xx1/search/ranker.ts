/**
 * 1XX1 ResultRanker
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Sorumluluk: ScoreComponents[] → sıralı SearchHit[]
 *
 * Tie-break sırası (Bölüm 7):
 *   1. finalScore    (yüksek → düşük)
 *   2. semanticScore (yüksek → düşük)
 *   3. structuralScore (yüksek → düşük)
 *   4. recencyBoost  (yüksek → düşük)
 *
 * Ek:
 *   - minScore filtresi (eşik altını ele)
 *   - offset/limit ile sayfalama
 *   - resolvePath (token → CubePath yol zinciri)
 *
 * Bu modül yalnızca sıralar — hiçbir şey yazmaz.
 */

import type { ScoreComponents, SearchHit } from "./search-types.ts";

// ─── Sıralama Karşılaştırıcı ─────────────────────────────────────────────────

function compareScores(a: ScoreComponents, b: ScoreComponents): number {
  // 1. finalScore
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  // 2. semanticScore
  if (b.semanticScore !== a.semanticScore) return b.semanticScore - a.semanticScore;
  // 3. structuralScore
  if (b.structuralScore !== a.structuralScore) return b.structuralScore - a.structuralScore;
  // 4. recencyBoost
  return b.recencyBoost - a.recencyBoost;
}

// ─── ResultRanker ─────────────────────────────────────────────────────────────

export class ResultRanker {

  /**
   * Puanlanmış adayları sırala, filtrele, sayfalandır.
   *
   * @param scored      ScoringEngine'den gelen bileşenler
   * @param resolvePath token → CubePath yol zinciri
   * @param options     limit, offset, minScore
   * @returns           Sayfalandırılmış SearchHit[]
   */
  rank(
    scored:      ScoreComponents[],
    resolvePath: string[],
    options: {
      limit:    number;
      offset:   number;
      minScore: number;
    }
  ): { hits: SearchHit[]; total: number } {
    // Eşik filtresi
    const filtered = options.minScore > 0
      ? scored.filter((s) => s.finalScore >= options.minScore)
      : scored;

    // Tie-break sıralaması
    const sorted = [...filtered].sort(compareScores);

    const total = sorted.length;

    // Sayfalandırma
    const page = sorted.slice(options.offset, options.offset + options.limit);

    // SearchHit üret
    const hits: SearchHit[] = page.map((s, idx) => ({
      projectId:   s.projectId,
      finalScore:  s.finalScore,
      components:  s,
      resolvePath: resolvePath,
      rank:        options.offset + idx + 1,
    }));

    return { hits, total };
  }

  /**
   * Hızlı sıralama — yalnızca proje ID listesi lazım ise.
   * Tam SearchHit oluşturmadan önce kullanılabilir.
   */
  rankIds(
    scored:  ScoreComponents[],
    minScore = 0,
    limit    = 20,
    offset   = 0
  ): Array<{ projectId: ScoreComponents["projectId"]; score: number }> {
    return scored
      .filter((s) => s.finalScore >= minScore)
      .sort(compareScores)
      .slice(offset, offset + limit)
      .map((s) => ({ projectId: s.projectId, score: s.finalScore }));
  }
}

export const resultRanker = new ResultRanker();
