/**
 * 1XX1 Queries (CQRS — Okuma Tarafı)
 * Aşama 08 — Domain & Application Services
 *
 * Query: sistemi değiştirmeden veri isteyen sorgular.
 *   - Yan etkisiz (pure reads)
 *   - Repository'den doğrudan okur veya SearchEngine kullanır
 *   - Command akışından tamamen ayrı
 *
 * Ayrım garantisi:
 *   Query handler'lar ASLA yazma yapmaz.
 *   Command handler'lar ASLA doğrudan okuma sonucu döndürmez
 *   (yalnızca ID döndürür, fetch ayrı query ile yapılır).
 */

import type { CubeCoordinate, LicenseType, ProjectStatus } from "../core/types.ts";
import type { Project, Developer } from "../core/types.ts";

// ─── Proje Sorguları ──────────────────────────────────────────────────────────

export interface GetProjectQuery {
  readonly projectId: string;
}

export interface ListDeveloperProjectsQuery {
  readonly developerId: string;
  readonly status?:     ProjectStatus;
  readonly limit?:      number;
  readonly offset?:     number;
}

export interface SearchProjectsQuery {
  readonly term:       string;
  readonly filter?: {
    license?:      LicenseType;
    tags?:         string[];
    developerId?:  string;
    status?:       ProjectStatus;
    cube?:         CubeCoordinate;
  };
  readonly limit?:     number;
  readonly offset?:    number;
  readonly explain?:   boolean;
}

export interface GetProjectsByCubeQuery {
  readonly cube:      CubeCoordinate;
  readonly recursive?: boolean;
}

export interface ListAllProjectsQuery {
  readonly limit?:  number;
  readonly offset?: number;
}

// ─── Geliştirici Sorguları ────────────────────────────────────────────────────

export interface GetDeveloperQuery {
  readonly developerId: string;
}

export interface GetDeveloperByUsernameQuery {
  readonly username: string;
}

export interface ListDevelopersQuery {
  readonly limit?:  number;
  readonly offset?: number;
}

// ─── Küp Sorguları ───────────────────────────────────────────────────────────

export interface GetCubeStatsQuery {
  readonly path?: string;  // belirtilmezse tüm sistem
}

// ─── Query Sonuçları ─────────────────────────────────────────────────────────

export interface QueryResult<T> {
  ok:    true;
  data:  T;
  meta?: QueryMeta;
}

export interface QueryError {
  ok:      false;
  code:    string;
  message: string;
}

export interface QueryMeta {
  total?:       number;
  limit?:       number;
  offset?:      number;
  executionMs?: number;
}

export type QueryOutcome<T> = QueryResult<T> | QueryError;

export function queryOk<T>(data: T, meta?: QueryMeta): QueryResult<T> {
  return { ok: true, data, meta };
}

export function queryErr(code: string, message: string): QueryError {
  return { ok: false, code, message };
}

// ─── Proje Özeti (API yanıtı için) ───────────────────────────────────────────

export interface ProjectSummary {
  id:          string;
  name:        string;
  cube:        CubeCoordinate;
  cubePath:    string;
  developerId: string;
  tags:        string[];
  license:     LicenseType;
  status:      ProjectStatus;
  createdAt:   string;  // ISO
}

export function toProjectSummary(p: Project): ProjectSummary {
  return {
    id:          p.id,
    name:        p.name,
    cube:        p.cube,
    cubePath:    `${p.cube.x}/${p.cube.y}/${p.cube.z}`,
    developerId: p.developer,
    tags:        p.tags,
    license:     p.license,
    status:      p.status,
    createdAt:   p.createdAt.toISOString(),
  };
}
