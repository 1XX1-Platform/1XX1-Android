/**
 * 1XX1 İndeks Tipleri
 * Aşama 04 + Düzeltme 3 (Katman Bağımsızlığı) + Düzeltme 4 (Scoring)
 *
 * Üç katman tamamen bağımsız:
 *   Structural = routing  (nerede?)     — CubePath bilir
 *   Semantic   = meaning  (ne demek?)   — token bilir
 *   Reverse    = metadata (kim, ne?)    — proje meta bilir
 *   Hiçbiri diğerini import etmez.
 *
 * Scoring modeli (Düzeltme 4):
 *   finalScore = semanticMatch × 0.6 +
 *                structuralProximity × 0.3 +
 *                recencyBoost × 0.1
 */

import type { CubeCoordinate } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { LicenseType, ProjectStatus } from "../core/types.ts";

// ─── Katman 1: Structural Index ───────────────────────────────────────────────

export interface StructuralEntry {
  path:         string;
  coord:        CubeCoordinate;
  depth:        number;
  projectCount: number;
  isRouter:     boolean;
  /** Projenin gerçek güncelleme zamanı — recency scoring için */
  projectUpdatedAt?: Date;
  /** Entry son güncellenme zamanı */
  updatedAt:    Date;
}

// ─── Katman 2: Semantic Index ─────────────────────────────────────────────────

export interface TokenEntry {
  token:     string;
  projectId: ProjectID;
  field:     SemanticField;
  weight:    number;
}

export type SemanticField = "name" | "description" | "tag" | "repo";

export interface ProjectTokenMap {
  projectId: ProjectID;
  tokens:    Map<string, number>;
  updatedAt: Date;
}

/** Semantic arama sonucu (scoring pipeline'ı için de kullanılır) */
export interface ScoredProject {
  projectId:     ProjectID;
  score:         number;
  matchedTokens: string[];
}

// ─── Katman 3: Reverse Index ──────────────────────────────────────────────────

export interface ReverseEntry {
  key:       string;
  projectId: ProjectID;
  addedAt:   Date;
}

export type ReverseIndexKey =
  | `dev:${string}`
  | `lic:${LicenseType}`
  | `tag:${string}`
  | `status:${ProjectStatus}`;

// ─── İndeks Değişim Olayı ─────────────────────────────────────────────────────

export type IndexOperation = "upsert" | "remove";

export interface IndexChangeEvent {
  operation:      IndexOperation;
  projectId:      ProjectID;
  affectedKeys:   string[];
  timestamp:      Date;
  idempotencyKey: string;
}

// ─── Scoring Modeli (Düzeltme 4) ─────────────────────────────────────────────

/**
 * finalScore = semanticMatch × 0.6 +
 *              structuralProximity × 0.3 +
 *              recencyBoost × 0.1
 *
 * semanticMatch:      normalized token hit score (0–1)
 * structuralProximity: Manhattan distance to ref coord (0–1)
 * recencyBoost:       son 30 gün içinde güncellenme (0–1)
 */
export interface ScoringModel {
  weights: {
    semantic:   0.6;
    structural: 0.3;
    recency:    0.1;
  };
  normalization: "linear" | "log";
}

export const DEFAULT_SCORING_MODEL: ScoringModel = {
  weights: {
    semantic:   0.6,
    structural: 0.3,
    recency:    0.1,
  },
  normalization: "linear",
};

// ─── İndeks İstatistikleri ────────────────────────────────────────────────────

export interface IndexStats {
  structural: {
    totalPaths:  number;
    routerPaths: number;
    leafPaths:   number;
  };
  semantic: {
    totalTokens:         number;
    uniqueTokens:        number;
    avgTokensPerProject: number;
  };
  reverse: {
    totalEntries: number;
    uniqueKeys:   number;
    topKeys:      Array<{ key: string; count: number }>;
  };
  totalProjects: number;
  lastUpdated:   Date;
}
