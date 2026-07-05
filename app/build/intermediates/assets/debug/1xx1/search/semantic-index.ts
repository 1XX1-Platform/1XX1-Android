/**
 * 1XX1 Katman 2: Semantic Index
 * Aşama 04 — Veri İndeksleme
 *
 * Token tabanlı ters metin indeksi.
 * Alan ağırlıkları:
 *   name        → 3.0  (en yüksek)
 *   tag         → 2.5
 *   description → 1.5
 *   repo        → 1.0
 *
 * Operasyonlar:
 *   upsert(project) → token'ları çıkar, ağırlıkla indeksle
 *   remove(id)      → tüm token eşlemelerini sil
 *   search(tokens)  → skorlu proje ID listesi döndür
 *
 * Arama motoru (Aşama 05) bu indeksten sorgu yapar,
 * token çıkarma veya normalizasyon içermez.
 */

import type { ProjectID } from "../core/identity.ts";
import type { Project } from "../core/types.ts";
import type { ILogger } from "../core/interfaces.ts";
import type { ProjectTokenMap, SemanticField } from "./index-types.ts";
import { normalizeText, tokenize } from "../core/utils.ts";

// ─── Alan Ağırlıkları ─────────────────────────────────────────────────────────

const FIELD_WEIGHTS: Record<SemanticField, number> = {
  name:        3.0,
  tag:         2.5,
  description: 1.5,
  repo:        1.0,
};

// ─── Arama Sonucu ────────────────────────────────────────────────────────────

export interface ScoredProject {
  projectId: ProjectID;
  score:     number;
  matchedTokens: string[];
}

// ─── SemanticIndex ────────────────────────────────────────────────────────────

export class SemanticIndex {
  /** token → Map<ProjectID, ağırlık toplamı> */
  private readonly tokenIndex = new Map<string, Map<ProjectID, number>>();
  /** ProjectID → token seti (temizleme için) */
  private readonly projectTokens = new Map<ProjectID, Set<string>>();

  private _totalTokens = 0;
  private _lastUpdated = new Date();

  constructor(logger?: ILogger) {
    this.logger = logger;}

  // ─── Güncelleme ───────────────────────────────────────────────────────────

  upsert(project: Project): ProjectTokenMap {
    // Önce mevcut kayıtları temizle
    this.remove(project.id as ProjectID);

    const tokenWeights = new Map<string, number>();

    // Ad
    for (const t of tokenize(project.name)) {
      this._addToken(t, project.id as ProjectID, FIELD_WEIGHTS.name, tokenWeights);
    }

    // Taglar
    for (const tag of project.tags) {
      for (const t of tokenize(tag)) {
        this._addToken(t, project.id as ProjectID, FIELD_WEIGHTS.tag, tokenWeights);
      }
      // Tam tag (birleşik)
      const fullTag = normalizeText(tag);
      if (fullTag.length > 1) {
        this._addToken(fullTag, project.id as ProjectID, FIELD_WEIGHTS.tag * 1.2, tokenWeights);
      }
    }

    // Açıklama
    for (const t of tokenize(project.description)) {
      this._addToken(t, project.id as ProjectID, FIELD_WEIGHTS.description, tokenWeights);
    }

    // Repo (son path segmenti)
    const repoName = project.repo.split("/").pop() ?? "";
    for (const t of tokenize(repoName)) {
      this._addToken(t, project.id as ProjectID, FIELD_WEIGHTS.repo, tokenWeights);
    }

    // Proje token setini kaydet
    this.projectTokens.set(project.id as ProjectID, new Set(tokenWeights.keys()));
    this._lastUpdated = new Date();

    this.logger?.debug(
      `SemanticIndex upsert: ${project.id} → ${tokenWeights.size} token`
    );

    return {
      projectId: project.id as ProjectID,
      tokens:    tokenWeights,
      updatedAt: this._lastUpdated,
    };
  }

  remove(projectId: ProjectID): void {
    const tokens = this.projectTokens.get(projectId);
    if (!tokens) return;

    for (const token of tokens) {
      const map = this.tokenIndex.get(token);
      if (map) {
        map.delete(projectId);
        this._totalTokens--;
        if (map.size === 0) this.tokenIndex.delete(token);
      }
    }
    this.projectTokens.delete(projectId);
    this._lastUpdated = new Date();
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  /**
   * Verilen token listesiyle proje ara.
   * Her token için ilgili projelerin skorlarını topla.
   * Sonuçlar skor azalan sıraya göre döner.
   */
  search(
    queryTokens: string[],
    options: { limit?: number; minScore?: number } = {}
  ): ScoredProject[] {
    const { limit = 50, minScore = 0 } = options;
    const scores   = new Map<ProjectID, number>();
    const matched  = new Map<ProjectID, Set<string>>();

    for (const qToken of queryTokens) {
      const norm = normalizeText(qToken);
      if (!norm || norm.length < 2) continue;

      // Tam eşleşme
      const exact = this.tokenIndex.get(norm);
      if (exact) {
        for (const [pid, weight] of exact) {
          scores.set(pid, (scores.get(pid) ?? 0) + weight);
          if (!matched.has(pid)) matched.set(pid, new Set());
          matched.get(pid)!.add(norm);
        }
      }

      // Prefix eşleşme (fuzzy-lite)
      for (const [token, map] of this.tokenIndex) {
        if (token !== norm && token.startsWith(norm) && norm.length >= 3) {
          const partialWeight = 0.6; // prefix eşleşme için azaltılmış ağırlık
          for (const [pid, weight] of map) {
            scores.set(pid, (scores.get(pid) ?? 0) + weight * partialWeight);
            if (!matched.has(pid)) matched.set(pid, new Set());
            matched.get(pid)!.add(`~${norm}`);
          }
        }
      }
    }

    return Array.from(scores.entries())
      .filter(([, s]) => s >= minScore)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([pid, score]) => ({
        projectId:     pid,
        score:         Math.round(score * 100) / 100,
        matchedTokens: Array.from(matched.get(pid) ?? []),
      }));
  }

  /** Verilen proje ID'si için token → ağırlık haritası */
  getTokensFor(projectId: ProjectID): Map<string, number> | undefined {
    const tokens = this.projectTokens.get(projectId);
    if (!tokens) return undefined;
    const result = new Map<string, number>();
    for (const t of tokens) {
      const w = this.tokenIndex.get(t)?.get(projectId) ?? 0;
      result.set(t, w);
    }
    return result;
  }

  /** En çok belge içeren token'lar (sıcak indeks) */
  topTokens(n = 10): Array<{ token: string; count: number }> {
    return Array.from(this.tokenIndex.entries())
      .map(([token, map]) => ({ token, count: map.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  stats() {
    return {
      totalTokens:  this._totalTokens,
      uniqueTokens: this.tokenIndex.size,
      avgTokensPerProject: this.projectTokens.size > 0
        ? this._totalTokens / this.projectTokens.size
        : 0,
    };
  }

  get lastUpdated(): Date { return this._lastUpdated; }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _addToken(
    token: string,
    projectId: ProjectID,
    weight: number,
    accumulator: Map<string, number>
  ): void {
    if (!token || token.length < 2) return;

    const norm = normalizeText(token);
    if (!norm || norm.length < 2) return;

    if (!this.tokenIndex.has(norm)) {
      this.tokenIndex.set(norm, new Map());
    }
    const map = this.tokenIndex.get(norm)!;
    const prev = map.get(projectId) ?? 0;
    map.set(projectId, prev + weight);

    accumulator.set(norm, (accumulator.get(norm) ?? 0) + weight);
    this._totalTokens++;
  }
}
