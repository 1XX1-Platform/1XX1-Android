/**
 * 1XX1 SearchAdapter
 * Aşama 06 — Adapter
 *
 * Sorumluluk: SearchRequestDTO → RawQuery → SearchResponse → SearchResponseDTO
 *
 * API katmanı SearchEngine'e doğrudan bağlanmaz.
 * Bu adapter:
 *   1. DTO'yu RawQuery'ye çevirir (input sanitize)
 *   2. Timeout kontrolü uygular
 *   3. SearchEngine çıktısını DTO'ya çevirir
 *   4. Hiçbir iş mantığı içermez
 *
 * Kural: Bu modül hiçbir şey yazmaz, skorlamaz, sıralamaz.
 */

import type { SearchEngine } from "../search/search-engine.ts";
import type { RawQuery, SearchResponse, SearchHit } from "../search/search-types.ts";
import type {
  SearchRequestDTO,
  SearchResponseDTO,
  SearchHitDTO,
  QueryPlanDTO,
  ExplainStepDTO,
} from "../types.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";
import { DEFAULT_WEIGHTS } from "../search/search-types.ts";
import type { ScoringWeights } from "../search/search-types.ts";
import type { LicenseType, ProjectStatus } from "../../core/types.ts";
import type { CubeCoordinate } from "../../core/types.ts";

// ─── Timeout Wrapper ─────────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SystemError({
        code:    ErrorCode.QUERY_TIMEOUT,
        message: `${label} ${ms}ms içinde tamamlanamadı.`,
        severity: "medium",
        context: { timeoutMs: ms },
      }));
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

// ─── SearchAdapter ────────────────────────────────────────────────────────────

export class SearchAdapter {
  private readonly timeoutMs: number;

  constructor(
    engine: SearchEngine,
    opts: { timeoutMs?: number } = {}
  ) {
    this.engine = engine;
    this.timeoutMs = opts.timeoutMs ?? 5_000; // 5 saniyelik varsayılan timeout
  }

  // ─── Ana Arama ──────────────────────────────────────────────────────────

  async search(dto: SearchRequestDTO): Promise<SearchResponseDTO> {
    const raw = this._toRawQuery(dto);

    const response = await withTimeout(
      this.engine.search(raw),
      this.timeoutMs,
      "search"
    );

    return this._toResponseDTO(response, dto);
  }

  // ─── DTO → RawQuery ────────────────────────────────────────────────────

  private _toRawQuery(dto: SearchRequestDTO): RawQuery {
    // Ağırlık normalizasyonu
    const weights: Partial<ScoringWeights> = {};
    if (dto.weights) {
      const w = dto.weights;
      if (w.semantic   !== undefined) weights.semantic   = this._clamp(w.semantic,   0, 1);
      if (w.structural !== undefined) weights.structural = this._clamp(w.structural, 0, 1);
      if (w.metadata   !== undefined) weights.metadata   = this._clamp(w.metadata,   0, 1);
      if (w.recency    !== undefined) weights.recency    = this._clamp(w.recency,    0, 1);
    }

    return {
      term: dto.query,
      filter: dto.filter ? {
        license:     dto.filter.license as LicenseType | undefined,
        tags:        dto.filter.tags,
        developerId: dto.filter.developerId,
        status:      dto.filter.status as ProjectStatus | undefined,
        coord:       dto.filter.coord as CubeCoordinate | undefined,
      } : undefined,
      options: {
        limit:       this._clamp(dto.limit  ?? 20,  1, 100),
        offset:      this._clamp(dto.offset ?? 0,   0, 10_000),
        minScore:    0,
        weights:     Object.keys(weights).length > 0 ? weights : undefined,
        includePath: true,
        explain:     dto.explain ?? false,
      },
    };
  }

  // ─── SearchResponse → DTO ──────────────────────────────────────────────

  private _toResponseDTO(
    response: SearchResponse,
    originalDto: SearchRequestDTO
  ): SearchResponseDTO {
    const results: SearchHitDTO[] = response.hits.map((h) => this._hitToDTO(h));

    const dto: SearchResponseDTO = {
      results,
      total:        response.total,
      offset:       response.offset,
      limit:        response.limit,
      intent:       response.intent,
      resolvedPath: response.resolvedPath,
      executionMs:  response.executionMs,
    };

    if (originalDto.explain && response.plan) {
      dto.queryPlan = this._planToDTO(response);
      dto.explain   = (response.pipelineSteps ?? []).map((s) => ({
        name:        s.name,
        inputCount:  s.inputCount,
        outputCount: s.outputCount,
        durationMs:  s.durationMs,
        detail:      s.detail,
      } satisfies ExplainStepDTO));
    }

    return dto;
  }

  private _hitToDTO(hit: SearchHit): SearchHitDTO {
    return {
      projectId:       hit.projectId,
      rank:            hit.rank,
      finalScore:      hit.finalScore,
      semanticScore:   hit.components.semanticScore,
      structuralScore: hit.components.structuralScore,
      metadataScore:   hit.components.metadataScore,
      recencyBoost:    hit.components.recencyBoost,
      matchedTokens:   hit.components.matchedTokens,
      resolvePath:     hit.resolvePath,
    };
  }

  private _planToDTO(response: SearchResponse): QueryPlanDTO {
    return {
      intent:        response.intent,
      estimatedCost: response.plan?.estimatedCost ?? "O(k)",
      steps:         (response.plan?.steps ?? []).map((s) => s.type),
    };
  }

  private _clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }
}
