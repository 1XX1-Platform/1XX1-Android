/**
 * 1XX1 Arama Motoru Tipleri
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Tüm SearchEngine bileşenlerinin ortak sözleşmesi.
 * Bu dosya yalnızca tip tanımlar; hiçbir işlem içermez.
 */

import type { CubeCoordinate, LicenseType, ProjectStatus } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";

// ─── Sorgu Niyeti ─────────────────────────────────────────────────────────────

/**
 * Sorgunun ne tür olduğunu belirler:
 *   semantic   → "video editing tool"           (kelime bazlı)
 *   structural → "4/7/2" veya "cube:4/7/2"      (koordinat bazlı)
 *   hybrid     → "STL mesh repair"              (her ikisi)
 */
export type QueryIntent = "semantic" | "structural" | "hybrid";

// ─── Ham Sorgu ────────────────────────────────────────────────────────────────

export interface RawQuery {
  /** Kullanıcının girdiği ham metin */
  term: string;
  /** İsteğe bağlı filtreler */
  filter?: QueryFilter;
  options?: QueryOptions;
}

export interface QueryFilter {
  developerId?: string;
  license?:     LicenseType;
  tags?:        string[];
  status?:      ProjectStatus;
  /** Koordinat filtresi veya başlangıç noktası */
  coord?:       CubeCoordinate;
  /** CubePath doğrudan filtre */
  path?:        string;
}

export interface QueryOptions {
  limit?:      number;  // varsayılan 20
  offset?:     number;  // sayfalama
  minScore?:   number;  // eşik altı elenir
  weights?:    Partial<ScoringWeights>;
  /** Arama yolunu sonuca dahil et */
  includePath?: boolean;
  /** Debug: pipeline adımlarını sonuca ekle */
  explain?:    boolean;
}

// ─── Ayrıştırılmış Sorgu ─────────────────────────────────────────────────────

export interface ParsedQuery {
  raw:        string;
  normalized: string;
  tokens:     string[];
  intent:     QueryIntent;
  /** Eğer structural veya hybrid ise çözümlenen koordinat */
  targetCoord?: CubeCoordinate;
  /** Eğer structural ise tam CubePath */
  targetPath?:  string;
  filter:     QueryFilter;
  options:    Required<QueryOptions>;
}

// ─── Sorgu Planı ─────────────────────────────────────────────────────────────

export type PlanStep =
  | { type: "semantic-lookup";   tokens: string[] }
  | { type: "reverse-filter";    keys: string[] }
  | { type: "structural-route";  path: string }
  | { type: "neighborhood-expand"; coord: CubeCoordinate; radius: number }
  | { type: "merge-candidates" }
  | { type: "score" }
  | { type: "rank-and-slice";    limit: number; offset: number };

export interface QueryPlan {
  intent: QueryIntent;
  steps:  PlanStep[];
  estimatedCost: "O(1)" | "O(log n)" | "O(k)" | "O(n)";
}

// ─── Aday ────────────────────────────────────────────────────────────────────

export interface Candidate {
  projectId: ProjectID;
  /** Nereden geldi */
  source:    "semantic" | "structural" | "reverse" | "neighborhood";
}

// ─── Skor Ağırlıkları ────────────────────────────────────────────────────────

export interface ScoringWeights {
  semantic:   number;  // 0.55
  structural: number;  // 0.30
  metadata:   number;  // 0.10
  recency:    number;  // 0.05
}

export const DEFAULT_WEIGHTS: Readonly<ScoringWeights> = Object.freeze({
  semantic:   0.55,
  structural: 0.30,
  metadata:   0.10,
  recency:    0.05,
});

// ─── Skor Bileşenleri ─────────────────────────────────────────────────────────

export interface ScoreComponents {
  projectId:       ProjectID;
  /** Ham semantic token skoru (0–∞, normalize edilmeden) */
  rawSemantic:     number;
  /** Normalize edilmiş semantic (0–1) */
  semanticScore:   number;
  /** Küp ağacı mesafesi skoru (0–1) */
  structuralScore: number;
  /** Metadata eşleşme skoru (0–1) */
  metadataScore:   number;
  /**
   * Recency boost: e^(-age/τ)
   * τ = 7 gün (haftalık çürüme sabitesi)
   */
  recencyBoost:    number;
  /** Ağırlıklı toplam */
  finalScore:      number;
  /** Eşleşen tokenlar */
  matchedTokens:   string[];
  /** Kaynaklar */
  sources:         Candidate["source"][];
}

// ─── Sıralama Kriteri ─────────────────────────────────────────────────────────

/**
 * Tie-break sırası:
 *   1. finalScore (yüksek → düşük)
 *   2. semanticScore (yüksek → düşük)
 *   3. structuralScore (yüksek → düşük)
 *   4. recencyBoost (yüksek → düşük)
 */
export type TieBreakCriteria = readonly [
  "finalScore",
  "semanticScore",
  "structuralScore",
  "recencyBoost",
];

// ─── Arama Sonucu ─────────────────────────────────────────────────────────────

export interface SearchHit {
  projectId:   ProjectID;
  finalScore:  number;
  components:  ScoreComponents;
  /** STL → CAD → Mesh → Repair gibi çözümleme yolu */
  resolvePath: string[];
  rank:        number;
}

export interface SearchResponse {
  hits:         SearchHit[];
  projectIds:   ProjectID[];
  total:        number;
  offset:       number;
  limit:        number;
  intent:       QueryIntent;
  /** Sorgunun çözümlediği CubePath (structural/hybrid) */
  resolvedPath?: string;
  executionMs:   number;
  /** explain=true ise dolu, yoksa boş */
  plan?:         QueryPlan;
  pipelineSteps?: ExplainStep[];
}

export interface ExplainStep {
  name:        string;
  inputCount:  number;
  outputCount: number;
  durationMs:  number;
  detail?:     string;
}

// ─── SearchEngine Arayüzü ─────────────────────────────────────────────────────

export interface ISearchEngine {
  /** Ana arama — tam pipeline */
  search(query: RawQuery): Promise<SearchResponse>;
  /** Kelimeyi CubePath'e çevir */
  resolve(term: string): Promise<string[]>;
  /** Sorgu niyetini tespit et */
  detectIntent(term: string): QueryIntent;
  /** Motor istatistikleri */
  engineStats(): SearchEngineStats;
}

export interface SearchEngineStats {
  totalQueries:    number;
  avgExecutionMs:  number;
  intentBreakdown: Record<QueryIntent, number>;
  cacheHits:       number;
}
