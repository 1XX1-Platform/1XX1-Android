/**
 * 1XX1 ScoringEngine — Çekirdek Matematik
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Skor formülü:
 *   finalScore = semanticScore × 0.55 +
 *                structuralScore × 0.30 +
 *                metadataScore × 0.10 +
 *                recencyBoost × 0.05
 *
 * 4.1 Semantic Score:
 *   - token overlap (tam eşleşme)
 *   - prefix match (güçlendirilmiş)
 *   - fuzzy match / Levenshtein (azaltılmış)
 *   semanticScore ∈ [0, 1]
 *
 * 4.2 Structural Score:
 *   distance = Manhattan(queryCube, resultCube)
 *   structuralScore = 1 / (1 + distance)
 *
 * 4.3 Metadata Score:
 *   - tag overlap (Jaccard benzeri)
 *   - developer match (0 veya 1)
 *   - license uyumluluğu
 *
 * 4.4 Recency Boost:
 *   recencyBoost = e^(−age / τ)
 *   τ = 7 gün (haftalık çürüme sabitesi)
 *
 * Bu modül yalnızca hesaplar — hiçbir şey yazmaz.
 */

import type { ScoreComponents, ScoringWeights, Candidate } from "./search-types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { CubeCoordinate } from "../core/types.ts";
import type { StructuralEntry } from "./index-types.ts";
import { fuzzyMatch, similarity } from "./tokenizer.ts";
import type { SemanticIndex } from "./semantic-index.ts";
import type { ReverseIndex } from "./reverse-index.ts";
import type { StructuralIndex } from "./structural-index.ts";
import { DEFAULT_WEIGHTS } from "./search-types.ts";

// ─── Sabitler ────────────────────────────────────────────────────────────────

/** Recency çürüme sabitesi: 7 gün (ms) */
const TAU_MS = 7 * 24 * 60 * 60 * 1000;

/** Maksimum Manhattan mesafesi: 3 × 10 = 30 */
const MAX_MANHATTAN = 30;

/** Prefix eşleşme için ağırlık çarpanı */
const PREFIX_BOOST = 1.3;

/** Fuzzy eşleşme için ağırlık çarpanı */
const FUZZY_FACTOR = 0.6;

/** Fuzzy eşleşme eşiği */
const FUZZY_THRESHOLD = 0.75;

// ─── ScoringEngine ───────────────────────────────────────────────────────────

export class ScoringEngine {

  constructor(
    semantic:   SemanticIndex,
    reverse:    ReverseIndex,
    structural: StructuralIndex,
  ) {
    this.structural = structural;
    this.reverse = reverse;
    this.semantic = semantic;}

  /**
   * Aday kümesini puan.
   *
   * @param candidates  ProjectID → kaynak haritası
   * @param queryTokens Normalize edilmiş query token'ları
   * @param refCoord    Structural scoring için referans koordinat
   * @param queryFilter Metadata scoring için filtre bilgisi
   * @param weights     Ağırlık yapılandırması
   * @returns           Sıralanmamış ScoreComponents dizisi
   */
  scoreAll(
    candidates: Map<ProjectID, Candidate>,
    queryTokens: string[],
    refCoord?: CubeCoordinate,
    queryFilter?: {
      developerId?: string;
      tags?:        string[];
      license?:     string;
    },
    weights: ScoringWeights = DEFAULT_WEIGHTS
  ): ScoreComponents[] {
    if (candidates.size === 0) return [];

    // Semantic ham skorları toplu al (normalize için max lazım)
    const rawSemanticMap = this._bulkSemanticScores(queryTokens, candidates);
    const maxRaw = rawSemanticMap.size > 0
      ? Math.max(...Array.from(rawSemanticMap.values()).map((v) => v.raw))
      : 1;

    const results: ScoreComponents[] = [];

    for (const [pid, candidate] of candidates) {
      const semData  = rawSemanticMap.get(pid) ?? { raw: 0, tokens: [] };

      const semanticScore   = maxRaw > 0 ? semData.raw / maxRaw : 0;
      const structuralScore = this._structuralScore(pid, refCoord);
      const metadataScore   = this._metadataScore(pid, queryFilter);
      const recencyBoost    = this._recencyBoost(pid);

      const finalScore =
        semanticScore   * weights.semantic   +
        structuralScore * weights.structural +
        metadataScore   * weights.metadata   +
        recencyBoost    * weights.recency;

      results.push({
        projectId:       pid,
        rawSemantic:     semData.raw,
        semanticScore:   this._round(semanticScore),
        structuralScore: this._round(structuralScore),
        metadataScore:   this._round(metadataScore),
        recencyBoost:    this._round(recencyBoost),
        finalScore:      this._round(finalScore),
        matchedTokens:   semData.tokens,
        sources:         [candidate.source],
      });
    }

    return results;
  }

  // ─── 4.1 Semantic Score ───────────────────────────────────────────────────

  /**
   * Tüm adaylar için semantic ham skoru toplu hesapla.
   * SemanticIndex.search()'ten daha verimli: tek geçiş.
   */
  private _bulkSemanticScores(
    queryTokens: string[],
    candidates: Map<ProjectID, Candidate>
  ): Map<ProjectID, { raw: number; tokens: string[] }> {
    const result = new Map<ProjectID, { raw: number; tokens: string[] }>();

    for (const pid of candidates.keys()) {
      const tokenWeights = this.semantic.getTokensFor(pid);
      if (!tokenWeights) continue;

      let score       = 0;
      const matched: string[] = [];

      for (const qToken of queryTokens) {
        // Tam eşleşme
        if (tokenWeights.has(qToken)) {
          score += tokenWeights.get(qToken)!;
          matched.push(qToken);
          continue;
        }

        // Prefix eşleşme
        for (const [docToken, weight] of tokenWeights) {
          if (docToken.startsWith(qToken) && qToken.length >= 3) {
            score += weight * PREFIX_BOOST;
            matched.push(`~${qToken}`);
            break;
          }
        }

        // Fuzzy eşleşme (yalnızca kısa tokenlar için)
        if (qToken.length >= 4) {
          for (const [docToken, weight] of tokenWeights) {
            if (fuzzyMatch(qToken, docToken, FUZZY_THRESHOLD)) {
              const sim = similarity(qToken, docToken);
              score += weight * FUZZY_FACTOR * sim;
              matched.push(`≈${docToken}`);
              break;
            }
          }
        }
      }

      if (score > 0) {
        result.set(pid, { raw: score, tokens: [...new Set(matched)] });
      }
    }

    return result;
  }

  // ─── 4.2 Structural Score ────────────────────────────────────────────────

  /**
   * structuralScore = 1 / (1 + distance)
   * distance = Manhattan mesafesi (0–30)
   */
  private _structuralScore(pid: ProjectID, refCoord?: CubeCoordinate): number {
    if (!refCoord) return 0.5; // nötr

    const entry = this.structural.getByProject(pid);
    if (!entry) return 0.0;

    const c        = entry.coord;
    const distance = Math.abs(c.x - refCoord.x) +
                     Math.abs(c.y - refCoord.y) +
                     Math.abs(c.z - refCoord.z);
    return 1 / (1 + distance);
  }

  // ─── 4.3 Metadata Score ──────────────────────────────────────────────────

  /**
   * metadataScore = (tagOverlap + devMatch + licenseMatch) / 3
   * Her bileşen 0–1 aralığında.
   */
  private _metadataScore(
    pid: ProjectID,
    filter?: { developerId?: string; tags?: string[]; license?: string }
  ): number {
    if (!filter) return 0.5; // nötr

    const scores: number[] = [];

    // Tag overlap (Jaccard benzeri)
    if (filter.tags && filter.tags.length > 0) {
      const docTags = this._tagsOf(pid);
      const filterTags = new Set(filter.tags.map((t) => t.toLowerCase()));
      let overlap = 0;
      for (const t of filterTags) {
        if (docTags.has(t)) overlap++;
      }
      scores.push(overlap / filterTags.size);
    }

    // Developer match
    if (filter.developerId) {
      const inDev = this.reverse.getByDeveloper(filter.developerId).has(pid);
      scores.push(inDev ? 1.0 : 0.0);
    }

    // License match
    if (filter.license) {
      const licKey = `lic:${filter.license}` as const;
      const inLic  = this.reverse.getByKey(licKey).has(pid);
      scores.push(inLic ? 1.0 : 0.5); // uyuşmama tam sıfır değil (lisans bilgisi eksik olabilir)
    }

    if (scores.length === 0) return 0.5;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // ─── 4.4 Recency Boost ───────────────────────────────────────────────────

  /**
   * recencyBoost = e^(−age / τ)
   * τ = 7 gün
   * age = şu an − son güncelleme zamanı
   */
  private _recencyBoost(pid: ProjectID): number {
    const entry = this.structural.getByProject(pid);
    if (!entry) return 0.5; // nötr

    const updatedAt = entry.projectUpdatedAt ?? entry.updatedAt;
    const ageMs     = Date.now() - updatedAt.getTime();
    return Math.exp(-ageMs / TAU_MS);
  }

  // ─── Yardımcılar ─────────────────────────────────────────────────────────

  private _tagsOf(pid: ProjectID): Set<string> {
    const keys = this.reverse.getKeysFor(pid);
    const tags = new Set<string>();
    for (const key of keys) {
      if (key.startsWith("tag:")) tags.add(key.slice(4));
    }
    return tags;
  }

  private _round(n: number): number {
    return Math.round(n * 10_000) / 10_000;
  }
}
