/**
 * 1XX1 Entity Mapper
 * Aşama 07 — Persistence Katmanı
 *
 * Sorumluluk: Veritabanı satırı ↔ Domain modeli dönüşümü
 *
 * Kural: Mapper iş mantığı içermez.
 *   - snake_case → camelCase
 *   - string → Date
 *   - string[] → typed array
 *   - JSONB string → object
 *
 * Her repository bu mapper'ı kullanır; SQL sorguları yazmaz, mapper okur.
 */

import type { Project, Developer, LicenseType, ProjectStatus } from "../core/types.ts";
import type { ProjectID, DeveloperID } from "../core/identity.ts";

// ─── DB Row Tipleri (raw PostgreSQL satırı) ───────────────────────────────────

export interface ProjectRow {
  id:               string;
  name:             string;
  description:      string;
  cube_x:           number;
  cube_y:           number;
  cube_z:           number;
  cube_path:        string;
  developer_id:     string;
  repo:             string;
  tags:             string[] | string;  // pg array veya JSON string
  license:          string;
  status:           string;
  donation_address: string | null;
  created_at:       Date | string;
  updated_at:       Date | string;
}

export interface DeveloperRow {
  id:               string;
  username:         string;
  display_name:     string;
  bio:              string | null;
  website:          string | null;
  donation_address: string | null;
  joined_at:        Date | string;
}

export interface EventRow {
  event_id:         string;
  scope:            string;
  event_type:       string;
  payload:          Record<string, unknown> | string;
  idempotency_key:  string | null;
  created_at:       Date | string;
}

export interface SnapshotRow {
  snapshot_id:  string;
  cube_path:    string;
  payload:      Record<string, unknown> | string;
  checksum:     string;
  created_at:   Date | string;
}

// ─── ProjectMapper ────────────────────────────────────────────────────────────

export class ProjectMapper {

  toModel(row: ProjectRow): Project {
    return {
      id:              row.id as ProjectID,
      name:            row.name,
      description:     row.description,
      cube: {
        x: Number(row.cube_x),
        y: Number(row.cube_y),
        z: Number(row.cube_z),
      },
      developer:       row.developer_id,
      repo:            row.repo,
      tags:            this._parseArray(row.tags),
      license:         row.license as LicenseType,
      status:          row.status as ProjectStatus,
      donationAddress: row.donation_address ?? undefined,
      createdAt:       this._toDate(row.created_at),
      updatedAt:       this._toDate(row.updated_at),
    };
  }

  toRow(project: Project): Omit<ProjectRow, "created_at" | "updated_at"> & {
    created_at: string;
    updated_at: string;
  } {
    return {
      id:               project.id,
      name:             project.name,
      description:      project.description,
      cube_x:           project.cube.x,
      cube_y:           project.cube.y,
      cube_z:           project.cube.z,
      cube_path:        `${project.cube.x}/${project.cube.y}/${project.cube.z}`,
      developer_id:     project.developer,
      repo:             project.repo,
      tags:             project.tags,
      license:          project.license,
      status:           project.status,
      donation_address: project.donationAddress ?? null,
      created_at:       project.createdAt.toISOString(),
      updated_at:       project.updatedAt.toISOString(),
    };
  }

  toInsertParams(project: Project): unknown[] {
    const row = this.toRow(project);
    return [
      row.id, row.name, row.description,
      row.cube_x, row.cube_y, row.cube_z, row.cube_path,
      row.developer_id, row.repo,
      row.tags,  // pg driver: string[] → text[]
      row.license, row.status,
      row.donation_address,
      row.created_at, row.updated_at,
    ];
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _parseArray(v: string[] | string): string[] {
    if (Array.isArray(v)) return v;
    // PostgreSQL array string: "{a,b,c}" → ["a","b","c"]
    if (typeof v === "string" && v.startsWith("{")) {
      return v.slice(1, -1).split(",").filter(Boolean);
    }
    // JSON string: '["a","b"]'
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private _toDate(v: Date | string): Date {
    if (v instanceof Date) return v;
    return new Date(v);
  }
}

// ─── DeveloperMapper ─────────────────────────────────────────────────────────

export class DeveloperMapper {

  toModel(row: DeveloperRow): Developer {
    return {
      id:              row.id as DeveloperID,
      username:        row.username,
      displayName:     row.display_name,
      bio:             row.bio ?? undefined,
      website:         row.website ?? undefined,
      donationAddress: row.donation_address ?? undefined,
      joinedAt:        row.joined_at instanceof Date
                         ? row.joined_at
                         : new Date(row.joined_at),
    };
  }

  toInsertParams(dev: Developer): unknown[] {
    return [
      dev.id,
      dev.username,
      dev.displayName,
      dev.bio ?? null,
      dev.website ?? null,
      dev.donationAddress ?? null,
      dev.joinedAt.toISOString(),
    ];
  }
}

export const projectMapper   = new ProjectMapper();
export const developerMapper = new DeveloperMapper();
