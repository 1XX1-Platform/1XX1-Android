/**
 * 1XX1 IndexManager — Production-Grade Orkestratör
 * Düzeltme 3: Path/Semantic bağımsızlığı
 * Düzeltme 4: Scoring modeli
 * Düzeltme 5: Query execution pipeline
 *
 * Düzeltme 3: Üç katman birbirinden tamamen bağımsız.
 *   Structural = routing (nerede?)
 *   Semantic   = meaning  (ne anlama geliyor?)
 *   Reverse    = metadata (kim, ne zaman, hangi lisans?)
 *   Hiçbiri diğerini import etmez.
 *
 * Düzeltme 4: Tanımlı scoring modeli
 *   score = semanticMatch × 0.6 +
 *           structuralProximity × 0.3 +
 *           recencyBoost × 0.1
 *
 * Düzeltme 5: Query execution pipeline
 *   Query → Normalize → Tokenize → Index Fan-out →
 *   Candidate Set → Scoring → Ranking → Return
 *
 * Düzeltme 1 (Event Storm): IndexManager yalnızca INDEX scope
 *   olayları yayınlar; CORE/CUBE'e olay atmaz.
 */

import type { IEventBus, ILogger } from "../core/interfaces.ts";
import type { Project } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { CubeCoordinate, LicenseType, ProjectStatus } from "../core/types.ts";
import { StructuralIndex } from "./structural-index.ts";
import { SemanticIndex } from "./semantic-index.ts";
import { ReverseIndex } from "./reverse-index.ts";
import { IndexReconciler } from "./index-reconciler.ts";
import { normalizeText, tokenize } from "../core/utils.ts";
import type { IndexStats } from "./index-types.ts";

// ─── Scoring Modeli (Düzeltme 4) ─────────────────────────────────────────────

export interface ScoringWeights {
  /** Semantic eşleşme ağırlığı */
  semantic:   number; // 0.6
  /** Küp konumu yakınlık ağırlığı */
  structural: number; // 0.3
  /** Yenilik (recency) ağırlığı */
  recency:    number; // 0.1
}

export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = Object.freeze({
  semantic:   0.6,
  structural: 0.3,
  recency:    0.1,
});

/** Ham bileşenler (debug için döndürülür) */
export interface ScoreBreakdown {
  projectId:          ProjectID;
  semanticScore:      number;  // 0–∞ (semantic ağırlık × token eşleşme)
  structuralScore:    number;  // 0–1 (koordinat yakınlığı)
  recencyScore:       number;  // 0–1 (son güncelleme tarihine göre)
  finalScore:         number;  // ağırlıklı toplam
  matchedTokens:      string[];
}

// ─── Query Pipeline (Düzeltme 5) ─────────────────────────────────────────────

export interface PipelineQuery {
  term: string;
  filter?: {
    developerId?: string;
    license?:     LicenseType;
    tags?:        string[];
    status?:      ProjectStatus;
    coord?:       CubeCoordinate;
  };
  options?: {
    limit?:     number;
    minScore?:  number;
    weights?:   Partial<ScoringWeights>;
    /** Structural proximity için referans koordinat */
    refCoord?:  CubeCoordinate;
  };
}

export interface PipelineResult {
  results:      ScoreBreakdown[];
  projectIds:   ProjectID[];
  total:        number;
  /** Pipeline hangi adımlardan geçti */
  pipeline:     PipelineStep[];
  executionMs:  number;
}

export interface PipelineStep {
  name:         string;
  inputCount:   number;
  outputCount:  number;
  durationMs:   number;
}

// ─── Filtre (geriye uyumluluk) ────────────────────────────────────────────────

export interface IndexFilter {
  developerId?: string;
  license?:     LicenseType;
  tags?:        string[];
  status?:      ProjectStatus;
  coord?:       CubeCoordinate;
}

export interface IndexQueryResult {
  projectIds:    ProjectID[];
  scoredResults: ScoreBreakdown[];
  total:         number;
  filters:       IndexFilter;
}

// ─── IndexManager ─────────────────────────────────────────────────────────────

export class IndexManager {
  /** Düzeltme 3: Her katman tamamen bağımsız */
  readonly structural:  StructuralIndex;
  readonly semantic:    SemanticIndex;
  readonly reverse:     ReverseIndex;
  readonly reconciler:  IndexReconciler;

  private _totalProjects = 0;
  private _lastUpdated   = new Date();

  constructor(
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    // Düzeltme 3: Katmanlar birbirini tanımaz — yalnızca IndexManager bağlar
    this.structural = new StructuralIndex(eventBus, logger);
    this.semantic   = new SemanticIndex(logger);
    this.reverse    = new ReverseIndex(logger);
    this.reconciler = new IndexReconciler(
      this.semantic, this.reverse, this.structural, eventBus, logger
    );

    this._subscribeToProjectEvents();
  }

  // ─── Proje Güncelleme API ─────────────────────────────────────────────────

  indexProject(project: Project): void {
    const pid    = project.id as ProjectID;
    const isNew  = !this.reverse.getKeysFor(pid).size;

    // Düzeltme 3: Her katman kendi bağımsız mantığıyla güncellenir
    this.semantic.upsert(project);   // meaning katmanı
    this.reverse.upsert(project);    // metadata katmanı
    // structural, cube:indexed event'iyle kendi güncellenir (bağımsız)

    if (isNew) this._totalProjects++;
    this._lastUpdated = new Date();

    // Düzeltme 1: INDEX scope olayı — CORE'a geri atmaz
    this.eventBus?.emit(
      "index:upserted",
      { projectId: pid },
      `idx-upsert:${pid}:${Date.now()}`
    );

    this.logger?.debug(`IndexManager: proje indekslendi → ${project.id}`);
  }

  removeProject(projectId: ProjectID): void {
    const wasPresent = !!this.reverse.getKeysFor(projectId).size;
    this.semantic.remove(projectId);
    this.reverse.remove(projectId);
    this.structural.remove(projectId);
    if (wasPresent) this._totalProjects = Math.max(0, this._totalProjects - 1);
    this._lastUpdated = new Date();

    // Düzeltme 1: INDEX scope
    this.eventBus?.emit(
      "index:removed",
      { projectId },
      `idx-remove:${projectId}:${Date.now()}`
    );
  }

  // ─── Query Execution Pipeline (Düzeltme 5) ────────────────────────────────

  /**
   * Pipeline akışı:
   *   Query → Normalize → Tokenize → Index Fan-out →
   *   Candidate Set → Scoring → Ranking → Return
   */
  executePipeline(query: PipelineQuery): PipelineResult {
    const pipelineStart = Date.now();
    const steps: PipelineStep[] = [];
    const weights: ScoringWeights = {
      ...DEFAULT_SCORING_WEIGHTS,
      ...query.options?.weights,
    };
    const limit    = query.options?.limit    ?? 50;
    const minScore = query.options?.minScore ?? 0;
    const refCoord = query.options?.refCoord ?? query.filter?.coord;

    // ── Adım 1: Normalize + Tokenize ──
    const step1Start = Date.now();
    const normalized = normalizeText(query.term);
    const tokens     = tokenize(normalized);
    // Orijinal terimi de ekle (prefix eşleşme için)
    if (normalized.length >= 2 && !tokens.includes(normalized)) {
      tokens.push(normalized);
    }
    steps.push({
      name: "normalize+tokenize",
      inputCount: 1,
      outputCount: tokens.length,
      durationMs: Date.now() - step1Start,
    });

    if (tokens.length === 0) {
      return { results: [], projectIds: [], total: 0, pipeline: steps, executionMs: Date.now() - pipelineStart };
    }

    // ── Adım 2: Index Fan-out (Semantic) ──
    const step2Start = Date.now();
    const semanticHits = this.semantic.search(tokens, {
      limit:    limit * 5, // geniş aday seti
      minScore: 0,
    });
    steps.push({
      name: "semantic-fanout",
      inputCount: tokens.length,
      outputCount: semanticHits.length,
      durationMs: Date.now() - step2Start,
    });

    // ── Adım 3: Candidate Set (Reverse Filter) ──
    const step3Start = Date.now();
    let candidates = semanticHits.map((h) => h.projectId);

    if (query.filter) {
      const filterKeys: string[] = [];
      if (query.filter.developerId) filterKeys.push(`dev:${query.filter.developerId}`);
      if (query.filter.license)     filterKeys.push(`lic:${query.filter.license}`);
      if (query.filter.status)      filterKeys.push(`status:${query.filter.status}`);
      if (query.filter.tags) {
        for (const t of query.filter.tags) filterKeys.push(`tag:${t.toLowerCase().trim()}`);
      }

      if (filterKeys.length > 0) {
        const filterSet = this.reverse.getIntersection(filterKeys);
        candidates      = candidates.filter((id) => filterSet.has(id));
      }

      if (query.filter.coord) {
        const coordEntries = this.structural.getByCoord(query.filter.coord);
        const coordPaths   = new Set(coordEntries.map((e) => e.path));
        candidates = candidates.filter((id) => {
          const entry = this.structural.getByProject(id);
          return entry ? coordPaths.has(entry.path) : false;
        });
      }
    }

    steps.push({
      name: "candidate-filter",
      inputCount: semanticHits.length,
      outputCount: candidates.length,
      durationMs: Date.now() - step3Start,
    });

    // ── Adım 4: Scoring (Düzeltme 4) ──
    const step4Start = Date.now();
    const candidateSet = new Set(candidates);
    const scoredMap    = new Map(semanticHits.map((h) => [h.projectId, h]));

    const scored: ScoreBreakdown[] = candidates.map((pid) => {
      const hit           = scoredMap.get(pid);
      const rawSemantic   = hit?.score ?? 0;

      // Semantic: normalize et (0–1 aralığına çek)
      const maxSemantic   = semanticHits[0]?.score ?? 1;
      const normSemantic  = maxSemantic > 0 ? rawSemantic / maxSemantic : 0;

      // Structural: koordinat yakınlığı
      const structScore   = this._structuralProximity(pid, refCoord);

      // Recency: son güncelleme (structural entry'den timestamp)
      const recencyScore  = this._recencyScore(pid);

      const finalScore =
        normSemantic  * weights.semantic +
        structScore   * weights.structural +
        recencyScore  * weights.recency;

      return {
        projectId:       pid,
        semanticScore:   Math.round(normSemantic * 1000) / 1000,
        structuralScore: Math.round(structScore  * 1000) / 1000,
        recencyScore:    Math.round(recencyScore * 1000) / 1000,
        finalScore:      Math.round(finalScore   * 1000) / 1000,
        matchedTokens:   hit?.matchedTokens ?? [],
      };
    });

    steps.push({
      name: "scoring",
      inputCount: candidates.length,
      outputCount: scored.length,
      durationMs: Date.now() - step4Start,
    });

    // ── Adım 5: Ranking + Return ──
    const step5Start = Date.now();
    const ranked = scored
      .filter((s) => s.finalScore >= minScore)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);

    steps.push({
      name: "ranking",
      inputCount: scored.length,
      outputCount: ranked.length,
      durationMs: Date.now() - step5Start,
    });

    return {
      results:     ranked,
      projectIds:  ranked.map((r) => r.projectId),
      total:       scored.filter((s) => s.finalScore >= minScore).length,
      pipeline:    steps,
      executionMs: Date.now() - pipelineStart,
    };
  }

  // ─── Geriye Uyumlu Query API ─────────────────────────────────────────────

  query(
    queryTokens: string[],
    filter: IndexFilter = {},
    options: { limit?: number; minScore?: number } = {}
  ): IndexQueryResult {
    const result = this.executePipeline({
      term:    queryTokens.join(" "),
      filter,
      options: { limit: options.limit, minScore: options.minScore },
    });
    return {
      projectIds:    result.projectIds,
      scoredResults: result.results,
      total:         result.total,
      filters:       filter,
    };
  }

  filterOnly(filter: IndexFilter, limit = 50): ProjectID[] {
    const keys: string[] = [];
    if (filter.developerId) keys.push(`dev:${filter.developerId}`);
    if (filter.license)     keys.push(`lic:${filter.license}`);
    if (filter.status)      keys.push(`status:${filter.status}`);
    if (filter.tags) {
      for (const t of filter.tags) keys.push(`tag:${t.toLowerCase().trim()}`);
    }
    if (keys.length === 0) return [];
    return Array.from(this.reverse.getIntersection(keys)).slice(0, limit);
  }

  // ─── İstatistikler ────────────────────────────────────────────────────────

  stats(): IndexStats {
    return {
      structural:    this.structural.stats(),
      semantic:      this.semantic.stats(),
      reverse:       this.reverse.stats(),
      totalProjects: this._totalProjects,
      lastUpdated:   this._lastUpdated,
    };
  }

  // ─── Scoring Yardımcıları (Düzeltme 4) ───────────────────────────────────

  /**
   * Yapısal yakınlık skoru (0–1).
   * Proje bir referans koordinata ne kadar yakın?
   * refCoord yoksa 0.5 (nötr) döner.
   */
  private _structuralProximity(projectId: ProjectID, refCoord?: CubeCoordinate): number {
    if (!refCoord) return 0.5; // nötr

    const entry = this.structural.getByProject(projectId);
    if (!entry) return 0;

    const c = entry.coord;
    // Manhattan mesafesi, maksimum 30 (3 × 10)
    const distance = Math.abs(c.x - refCoord.x) +
                     Math.abs(c.y - refCoord.y) +
                     Math.abs(c.z - refCoord.z);
    return 1 - (distance / 30);
  }

  /**
   * Yenilik skoru (0–1).
   * Structural index'teki updatedAt'e göre.
   * 24 saat içinde = 1.0, 30 gün+ = 0.0
   */
  private _recencyScore(projectId: ProjectID): number {
    const entry = this.structural.getByProject(projectId);
    if (!entry) return 0.5; // nötr

    const ageMs   = Date.now() - entry.updatedAt.getTime();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 gün
    return Math.max(0, 1 - ageMs / maxAgeMs);
  }

  // ─── Event Abonelikleri (Düzeltme 1: INDEX tetiklemez CORE) ──────────────

  private _subscribeToProjectEvents(): void {
    if (!this.eventBus) return;

    // CORE olaylarını DİNLEYEBİLİRİZ ama geri CORE olay ATMAYIZ
    this.eventBus.on("project:created", (event) => {
      this.indexProject(event.payload as Project);
      // ❌ Yasak: eventBus.emit("project:*", ...) — scope violation
    });

    this.eventBus.on("project:updated", (event) => {
      this.indexProject(event.payload as Project);
    });

    this.eventBus.on("project:archived", (event) => {
      const { id } = event.payload as { id: ProjectID };
      this.removeProject(id);
    });
  }
}

import { eventBus } from "../core/event-bus.ts";
import { logger }   from "../core/logger.ts";
export const indexManager = new IndexManager(eventBus, logger);
