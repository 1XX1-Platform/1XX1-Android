/**
 * 1XX1 Ranking Engine — Adil Sıralama
 * Aşama 10 — Pulse Engine
 *
 * Skor formülü:
 *   score = pulseAge × W_age
 *         + fairnessScore × W_fair
 *         + trustWeight × W_trust
 *         - penalty × W_penalty
 *
 * W_age:     0.50 — sistemde ne kadar süredir aktif
 * W_fair:    0.40 — ne kadar az görünmüş (ters orantılı)
 * W_trust:   0.10 — kanal güven skoru (küçük etki)
 * W_penalty: 1.00 — manipülasyon cezası
 *
 * Kritik kural: Para/bağış sıralamayı hiçbir şekilde etkilemez.
 *
 * Determinizm garantisi:
 *   Aynı girdi → aynı çıktı. Rastgele sayı yok.
 *   Eşit skor durumunda: projectId string sıralaması (sabit, öngörülebilir).
 */

import type { Project } from "../../core/types.ts";
import type { FairnessRecord, PulseEntry } from "../pulse-types.ts";

// ─── Ağırlıklar ───────────────────────────────────────────────────────────────

export interface RankingWeights {
  age:     number;  // 0.50
  fair:    number;  // 0.40
  trust:   number;  // 0.10
  penalty: number;  // 1.00
}

const DEFAULT_WEIGHTS: RankingWeights = {
  age:     0.50,
  fair:    0.40,
  trust:   0.10,
  penalty: 1.00,
};

// ─── RankingEngine ────────────────────────────────────────────────────────────

export class RankingEngine {
  private readonly weights: RankingWeights;

  constructor(weights: Partial<RankingWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Proje listesini sırala.
   *
   * @param projects      Uygun projeler
   * @param fairness      Fairness kayıtları
   * @param trustScores   Kanal trust skorları (projectId → 0–100)
   * @param currentPulse  Mevcut pulse numarası
   * @returns             Sıralı PulseEntry dizisi
   */
  rank(
    projects:    Project[],
    fairness:    Map<string, FairnessRecord>,
    trustScores: Map<string, number>,
    currentPulse: number
  ): PulseEntry[] {
    const entries: PulseEntry[] = projects.map((project) => {
      const record = fairness.get(project.id);
      const score  = this._computeScore(project, record, trustScores.get(project.id) ?? 0, currentPulse);
      return score;
    });

    // Deterministik sıralama: skor (azalan), eşit ise projectId (artan)
    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.projectId.localeCompare(b.projectId); // deterministik tie-break
    });

    // Sıra numarası ata
    entries.forEach((e, i) => { e.rank = i + 1; });

    return entries;
  }

  // ─── Skor Hesaplama ──────────────────────────────────────────────────────

  private _computeScore(
    project:      Project,
    record:       FairnessRecord | undefined,
    trustScore:   number,   // 0–100
    currentPulse: number
  ): PulseEntry {
    // ── Pulse yaşı ──
    const firstPulse = record?.firstPulse ?? currentPulse;
    const pulseAge   = currentPulse - firstPulse; // 0'dan başlar, büyür

    // Normalize: log scale (büyük sayıları baskıla, küçükleri öne çıkar)
    const normalizedAge = pulseAge > 0 ? Math.log2(pulseAge + 1) / 20 : 0;
    // Maksimum: log2(1_000_001)/20 ≈ 1 → [0, 1]

    // ── Fairness skoru ──
    // Daha az görünmüş proje → yüksek fairness
    // topCount: ne kadar çok üstte kaldı → ceza
    const topCount     = record?.topCount ?? 0;
    const lastTopGap   = record?.lastTopPulse
      ? currentPulse - record.lastTopPulse
      : currentPulse - firstPulse + 1;

    // Uzun süre üstte görünmemişse bonus
    const fairnessByGap    = Math.min(1, lastTopGap / 100);
    // Çok fazla üstte görünmüşse ceza
    const fairnessByCount  = Math.max(0, 1 - topCount / 50);
    const fairness         = (fairnessByGap + fairnessByCount) / 2;

    // ── Trust skoru ──
    const trust = trustScore / 100; // 0–1

    // ── Ceza ──
    const penalty = record?.penalty ?? 0;

    // ── Nihai skor ──
    const rawScore =
      normalizedAge * this.weights.age +
      fairness      * this.weights.fair +
      trust         * this.weights.trust -
      penalty       * this.weights.penalty;

    // Skor negatif olamaz
    const score = Math.max(0, rawScore);

    return {
      rank:      0, // sonra atanır
      projectId: project.id,
      score:     Math.round(score * 100_000) / 100_000, // 5 ondalık basamak
      pulseAge,
      fairness:  Math.round(fairness * 1000) / 1000,
      trust:     Math.round(trust   * 1000) / 1000,
      penalty,
      promoted:  false, // rotation engine tarafından işaretlenir
      demoted:   false,
    };
  }

  /**
   * Skor bileşenlerini açıkla (debug/transparency).
   */
  explain(
    project:      Project,
    record:       FairnessRecord | undefined,
    trustScore:   number,
    currentPulse: number
  ): Record<string, number> {
    const firstPulse   = record?.firstPulse ?? currentPulse;
    const pulseAge     = currentPulse - firstPulse;
    const normalizedAge = pulseAge > 0 ? Math.log2(pulseAge + 1) / 20 : 0;
    const topCount     = record?.topCount ?? 0;
    const lastTopGap   = record?.lastTopPulse
      ? currentPulse - record.lastTopPulse
      : currentPulse - firstPulse + 1;
    const fairnessByGap   = Math.min(1, lastTopGap / 100);
    const fairnessByCount = Math.max(0, 1 - topCount / 50);
    const fairness        = (fairnessByGap + fairnessByCount) / 2;
    const trust           = trustScore / 100;
    const penalty         = record?.penalty ?? 0;

    return {
      pulseAge,
      normalizedAge:    Math.round(normalizedAge * 1000) / 1000,
      ageContribution:  Math.round(normalizedAge * this.weights.age * 1000) / 1000,
      fairness:         Math.round(fairness * 1000) / 1000,
      fairnessContrib:  Math.round(fairness * this.weights.fair * 1000) / 1000,
      trust:            Math.round(trust * 1000) / 1000,
      trustContrib:     Math.round(trust * this.weights.trust * 1000) / 1000,
      penalty,
      penaltyContrib:   Math.round(penalty * this.weights.penalty * 1000) / 1000,
    };
  }
}
