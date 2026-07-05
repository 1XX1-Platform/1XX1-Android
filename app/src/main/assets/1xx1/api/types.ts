/**
 * 1XX1 API Tipleri
 * Aşama 06 — API Katmanı
 *
 * Transport katmanının sözleşmesi.
 * SearchEngine tiplerine doğrudan bağımlı değildir —
 * aradaki adapter katmanı dönüşümü yapar.
 *
 * Kural: API tipleri sade, serileştirilebilir (JSON-safe) tutulur.
 * Date → ISO string, Set → Array, Map → Record.
 */

// ─── Request DTO'ları ─────────────────────────────────────────────────────────

export interface SearchRequestDTO {
  query:    string;
  limit?:   number;    // 1–100, varsayılan 20
  offset?:  number;    // ≥ 0, varsayılan 0
  explain?: boolean;   // varsayılan false
  filter?: {
    license?:     string;
    tags?:        string[];
    developerId?: string;
    status?:      string;
    coord?:       { x: number; y: number; z: number };
  };
  weights?: {
    semantic?:   number;  // 0–1
    structural?: number;
    metadata?:   number;
    recency?:    number;
  };
}

export interface StreamSearchRequestDTO {
  query:   string;
  limit?:  number;
  filter?: SearchRequestDTO["filter"];
}

// ─── Response DTO'ları ────────────────────────────────────────────────────────

export interface SearchHitDTO {
  projectId:       string;
  rank:            number;
  finalScore:      number;
  semanticScore:   number;
  structuralScore: number;
  metadataScore:   number;
  recencyBoost:    number;
  matchedTokens:   string[];
  resolvePath:     string[];
}

export interface SearchResponseDTO {
  results:      SearchHitDTO[];
  total:        number;
  offset:       number;
  limit:        number;
  intent:       string;
  resolvedPath?: string;
  executionMs:  number;
  queryPlan?:   QueryPlanDTO;
  explain?:     ExplainStepDTO[];
}

export interface QueryPlanDTO {
  intent:        string;
  estimatedCost: string;
  steps:         string[];  // adım tipi listesi
}

export interface ExplainStepDTO {
  name:        string;
  inputCount:  number;
  outputCount: number;
  durationMs:  number;
  detail?:     string;
}

// ─── SSE Olay Tipleri (Streaming) ────────────────────────────────────────────

export type SSEEventType =
  | "candidate"   // aday seti hazır
  | "scoring"     // skor hesaplama tamamlandı
  | "ranking"     // sıralama tamamlandı
  | "final"       // son sonuç
  | "error"       // hata
  | "heartbeat";  // bağlantı canlı

export interface SSEEvent<T = unknown> {
  event:   SSEEventType;
  data:    T;
  id?:     string;   // olay ID (client reconnect için)
}

export interface SSECandidatePayload {
  count:       number;
  sampleIds:   string[];
}

export interface SSEScoringPayload {
  scored:    number;
  topScore:  number;
}

export interface SSERankingPayload {
  ranked:    number;
  topHits:   Array<{ projectId: string; score: number }>;
}

// ─── Health Response ─────────────────────────────────────────────────────────

export interface HealthResponseDTO {
  status:       "ok" | "degraded" | "down";
  version:      string;
  uptime:       number;    // saniye
  components: {
    searchEngine: boolean;
    indexManager: boolean;
    eventBus:     boolean;
  };
  stats?: {
    totalQueries:   number;
    avgExecutionMs: number;
    cacheHitRate:   number;
  };
  timestamp: string; // ISO
}

// ─── API Error DTO ────────────────────────────────────────────────────────────

export interface ApiErrorDTO {
  code:    string;
  message: string;
  status:  number;   // HTTP status code
}

// ─── HTTP Status Map ──────────────────────────────────────────────────────────

/** ErrorCode → HTTP status kodu */
export const ERROR_STATUS_MAP: Record<string, number> = {
  INVALID_QUERY:             400,
  VALIDATION_FAILED:         400,
  INVALID_COORDINATE:        400,
  SEARCH_TERM_TOO_SHORT:     400,
  LIMIT_EXCEEDED:            400,
  UNAUTHORIZED:              401,
  RATE_LIMITED:              429,
  PROJECT_NOT_FOUND:         404,
  DEVELOPER_NOT_FOUND:       404,
  QUERY_TIMEOUT:             504,
  ENGINE_FAILURE:            500,
  STREAM_ABORTED:            500,
  INTERNAL_ERROR:            500,
};

export function errorToStatus(code: string): number {
  return ERROR_STATUS_MAP[code] ?? 500;
}
