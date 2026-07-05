/**
 * 1XX1 SearchEngine — Ana Arama Motoru
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Tam pipeline:
 *   INPUT → QueryParser → QueryPlanner → CandidateGenerator →
 *   ScoringEngine → ResultRanker → OUTPUT
 *
 * Kritik mimari kural (Aşama 05 § 10):
 *   ❌ ASLA veri yazmaz
 *   ✔  Yalnızca okur, skorlar, sıralar
 *   ✔  EventBus'u READ-ONLY dinler (cube:indexed, cube:split, index:upserted)
 *   ✔  EventBus'a ASLA olay atmaz
 *
 * Arama motoru INDEX veya CUBE scope'una olay atmaz.
 * Tüm read operasyonları IndexManager üzerinden geçer.
 */

import type { ISearchEngine, RawQuery, SearchResponse, QueryIntent, SearchEngineStats, ExplainStep } from "./search-types.ts";
import type { IEventBus, ILogger } from "../core/interfaces.ts";
import { QueryParser } from "./query-parser.ts";
import { QueryPlanner } from "./query-planner.ts";
import { CandidateGenerator } from "./candidate-generator.ts";
import { ScoringEngine } from "./scoring-engine.ts";
import { ResultRanker } from "./ranker.ts";
import { tokenize } from "./tokenizer.ts";
import type { IndexManager } from "./index-manager.ts";
import { DEFAULT_WEIGHTS } from "./search-types.ts";
import type { ScoringWeights } from "./search-types.ts";

// ─── CubePath Route Çözümleyici ───────────────────────────────────────────────

/**
 * Token zincirini CubePath yol olarak çözümler.
 * "STL repair tool" → ["STL", "Mesh", "Repair"]
 *
 * Şu an kural tabanlı çalışır; Aşama 07'de veritabanı ile zenginleştirilecek.
 * Temel mantık: token'ların hangisinin yapısal kategoriye girdiğini belirle.
 */
function resolvePathFromTokens(tokens: string[]): string[] {
  if (tokens.length === 0) return [];

  // Bilinen kategori → alt kategori zincirleri
  const CATEGORY_CHAINS: Record<string, string[]> = {
    stl:       ["3D", "Mesh"],
    mesh:      ["3D", "Geometry"],
    cad:       ["Design", "3D"],
    repair:    ["Maintenance"],
    viewer:    ["Display"],
    export:    ["IO"],
    import:    ["IO"],
    render:    ["Graphics", "3D"],
    animation: ["Graphics", "3D"],
    physics:   ["Simulation"],
    audio:     ["Media", "Sound"],
    video:     ["Media", "Video"],
    image:     ["Media", "Image"],
    web:       ["Network", "Frontend"],
    api:       ["Network", "Backend"],
    database:  ["Storage", "Data"],
    ml:        ["AI", "Learning"],
    ai:        ["AI"],
    game:      ["Interactive", "Graphics"],
  };

  const path: string[] = [];
  const seen  = new Set<string>();

  for (const token of tokens) {
    const chain = CATEGORY_CHAINS[token.toLowerCase()];
    if (chain) {
      for (const segment of chain) {
        if (!seen.has(segment)) {
          path.push(segment);
          seen.add(segment);
        }
      }
    } else {
      // Tanınmayan token: capitalize edip yola ekle
      const cap = token.charAt(0).toUpperCase() + token.slice(1);
      if (!seen.has(cap)) {
        path.push(cap);
        seen.add(cap);
      }
    }
  }

  return path;
}

// ─── SearchEngine ─────────────────────────────────────────────────────────────

export class SearchEngine implements ISearchEngine {
  private readonly parser:    QueryParser;
  private readonly planner:   QueryPlanner;
  private readonly generator: CandidateGenerator;
  private readonly scorer:    ScoringEngine;
  private readonly ranker:    ResultRanker;

  // ── İstatistikler ──
  private _totalQueries     = 0;
  private _totalMs          = 0;
  private _intentCounts: Record<QueryIntent, number> = {
    semantic: 0, structural: 0, hybrid: 0,
  };
  private _cacheHits = 0;

  /** Basit query cache: normalized term → SearchResponse */
  private readonly _cache = new Map<string, { response: SearchResponse; ts: number }>();
  private readonly _cacheTtlMs: number;

  constructor(
    indexManager: IndexManager,
    eventBus?:    IEventBus,
    logger?:      ILogger,
    cacheTtlMs = 30_000  // 30 saniyelik cache
  ) {
    this.indexManager = indexManager;
    this.eventBus = eventBus;
    this.logger = logger;
    this._cacheTtlMs = cacheTtlMs;

    this.parser    = new QueryParser();
    this.planner   = new QueryPlanner();
    this.generator = new CandidateGenerator(
      indexManager.semantic,
      indexManager.reverse,
      indexManager.structural
    );
    this.scorer = new ScoringEngine(
      indexManager.semantic,
      indexManager.reverse,
      indexManager.structural
    );
    this.ranker = new ResultRanker();

    // Kural § 10: EventBus'u READ-ONLY dinle, asla olay atma
    this._subscribeReadOnly();

    this.logger?.info("SearchEngine başlatıldı (read-only mode)");
  }

  // ─── ISearchEngine: search ────────────────────────────────────────────────

  async search(raw: RawQuery): Promise<SearchResponse> {
    const startMs = Date.now();
    this._totalQueries++;

    // ── Cache kontrolü ──
    const cacheKey = this._cacheKey(raw);
    const cached   = this._getCache(cacheKey);
    if (cached) {
      this._cacheHits++;
      this.logger?.debug(`Cache hit: "${raw.term}"`);
      return cached;
    }

    const explainSteps: ExplainStep[] = [];
    const explain = raw.options?.explain ?? false;

    // ── Adım 1: Parse ──
    const t1      = Date.now();
    const parsed  = this.parser.parse(raw);
    if (explain) explainSteps.push({
      name:        "parse",
      inputCount:  1,
      outputCount: parsed.tokens.length,
      durationMs:  Date.now() - t1,
      detail:      `intent=${parsed.intent}, tokens=[${parsed.tokens.join(",")}]`,
    });

    this._intentCounts[parsed.intent]++;

    // ── Adım 2: Plan ──
    const t2   = Date.now();
    const plan = this.planner.plan(parsed);
    if (explain) explainSteps.push({
      name:        "plan",
      inputCount:  1,
      outputCount: plan.steps.length,
      durationMs:  Date.now() - t2,
      detail:      `cost=${plan.estimatedCost}, steps=${plan.steps.length}`,
    });

    // ── Adım 3: Candidate Generation ──
    const t3   = Date.now();
    const pool = this.generator.generate(plan, explain);
    if (explain) {
      for (const s of pool.explain) explainSteps.push(s);
    }
    explainSteps.push({
      name:        "candidate-total",
      inputCount:  plan.steps.length,
      outputCount: pool.candidates.size,
      durationMs:  Date.now() - t3,
    });

    // ── Adım 4: Scoring ──
    const t4 = Date.now();
    const weights: ScoringWeights = {
      ...DEFAULT_WEIGHTS,
      ...parsed.options.weights,
    };
    const scored = this.scorer.scoreAll(
      pool.candidates,
      parsed.tokens,
      parsed.targetCoord ?? parsed.filter.coord,
      {
        developerId: parsed.filter.developerId,
        tags:        parsed.filter.tags,
        license:     parsed.filter.license,
      },
      weights
    );
    if (explain) explainSteps.push({
      name:        "scoring",
      inputCount:  pool.candidates.size,
      outputCount: scored.length,
      durationMs:  Date.now() - t4,
      detail:      `weights=${JSON.stringify(weights)}`,
    });

    // ── Adım 5: Ranking ──
    const t5  = Date.now();
    const resolvePath = resolvePathFromTokens(parsed.tokens);
    const { hits, total } = this.ranker.rank(scored, resolvePath, {
      limit:    parsed.options.limit,
      offset:   parsed.options.offset,
      minScore: parsed.options.minScore,
    });
    if (explain) explainSteps.push({
      name:        "ranking",
      inputCount:  scored.length,
      outputCount: hits.length,
      durationMs:  Date.now() - t5,
      detail:      `minScore=${parsed.options.minScore}`,
    });

    // ── Sonuç ──
    const executionMs = Date.now() - startMs;
    this._totalMs += executionMs;

    const response: SearchResponse = {
      hits,
      projectIds:    hits.map((h) => h.projectId),
      total,
      offset:        parsed.options.offset,
      limit:         parsed.options.limit,
      intent:        parsed.intent,
      resolvedPath:  parsed.targetPath,
      executionMs,
      plan:          explain ? plan : undefined,
      pipelineSteps: explain ? explainSteps : undefined,
    };

    this._setCache(cacheKey, response);
    this.logger?.debug(`Arama: "${raw.term}" → ${hits.length} sonuç (${executionMs}ms)`);

    return response;
  }

  // ─── ISearchEngine: resolve ───────────────────────────────────────────────

  /**
   * Kelimeyi CubePath yoluna çevir.
   * "STL repair" → ["STL", "Mesh", "Repair"]
   */
  async resolve(term: string): Promise<string[]> {
    const { tokens } = tokenize(term, { removeStops: true });
    return resolvePathFromTokens(tokens);
  }

  // ─── ISearchEngine: detectIntent ──────────────────────────────────────────

  detectIntent(term: string): QueryIntent {
    return this.parser.detectIntent(term);
  }

  // ─── ISearchEngine: engineStats ──────────────────────────────────────────

  engineStats(): SearchEngineStats {
    return {
      totalQueries:    this._totalQueries,
      avgExecutionMs:  this._totalQueries > 0
        ? Math.round(this._totalMs / this._totalQueries)
        : 0,
      intentBreakdown: { ...this._intentCounts },
      cacheHits:       this._cacheHits,
    };
  }

  // ─── Cache ────────────────────────────────────────────────────────────────

  private _cacheKey(raw: RawQuery): string {
    return JSON.stringify({
      t: raw.term?.toLowerCase().trim(),
      f: raw.filter,
      o: { limit: raw.options?.limit, offset: raw.options?.offset },
    });
  }

  private _getCache(key: string): SearchResponse | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._cacheTtlMs) {
      this._cache.delete(key);
      return null;
    }
    return entry.response;
  }

  private _setCache(key: string, response: SearchResponse): void {
    // Basit LRU: 1000'den fazla entry varsa en eskiyi sil
    if (this._cache.size >= 1000) {
      const firstKey = this._cache.keys().next().value;
      if (firstKey) this._cache.delete(firstKey);
    }
    this._cache.set(key, { response, ts: Date.now() });
  }

  /** Cache'i temizle (test veya invalidation sonrası) */
  clearCache(): void {
    this._cache.clear();
  }

  // ─── Read-Only EventBus Aboneliği ─────────────────────────────────────────

  /**
   * Kural § 10: SearchEngine yalnızca dinler, asla emit etmez.
   * Cache invalidation için ilgili olayları izler.
   */
  private _subscribeReadOnly(): void {
    if (!this.eventBus) return;

    // Index değişince cache geçersiz olur
    const invalidate = () => {
      if (this._cache.size > 0) {
        this._cache.clear();
        this.logger?.debug("SearchEngine: cache invalidated");
      }
    };

    // ✔ Dinle — INDEX scope (index değişince aramalar stale)
    this.eventBus.on("index:upserted",  invalidate);
    this.eventBus.on("index:removed",   invalidate);
    this.eventBus.on("index:reconciled", invalidate);

    // ✔ Dinle — CUBE scope (küp değişince structural skorlar stale)
    this.eventBus.on("cube:indexed",     invalidate);
    this.eventBus.on("cube:split",       invalidate);
    this.eventBus.on("cube:merge",       invalidate);
    this.eventBus.on("cube:path-changed", invalidate);

    // ❌ ASLA emit etme — bu metotta hiçbir eventBus.emit() çağrısı yok
  }
}
