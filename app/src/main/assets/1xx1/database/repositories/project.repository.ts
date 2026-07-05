/**
 * 1XX1 ProjectRepository
 * Aşama 07 — Persistence Katmanı
 *
 * IProjectRepository arayüzünün veritabanı implementasyonu.
 *
 * Kural: Yalnızca CRUD — iş mantığı yok.
 * SQL bu dosyadan yukarı sızmaz.
 * Üst katmanlar yalnızca IProjectRepository arayüzünü görür.
 */

import type { IProjectRepository } from "../../core/interfaces.ts";
import type { Project, CubeCoordinate } from "../../core/types.ts";
import type { DbPool } from "../connection.ts";
import type { Transaction } from "../transaction.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { projectMapper } from "../mapper/mapper.ts";
import type { ProjectRow } from "../mapper/mapper.ts";
import { TABLE } from "../schema/schema.ts";
import { newProjectID } from "../../core/identity.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";

// ─── Sorgu Kaynağı ────────────────────────────────────────────────────────────

/** Havuz veya transaction üzerinden sorgu çalıştır */
type QuerySource = DbPool | Transaction;

function isTransaction(s: QuerySource): s is Transaction {
  return "commit" in s;
}

async function runQuery<T>(
  source:  QuerySource,
  sql:     string,
  params?: unknown[]
) {
  return isTransaction(source)
    ? source.query<T>(sql, params)
    : source.query<T>(sql, params);
}

// ─── SQL Şablonları ───────────────────────────────────────────────────────────

const SQL = {
  INSERT: `
    INSERT INTO ${TABLE.PROJECTS}
      (id, name, description, cube_x, cube_y, cube_z, cube_path,
       developer_id, repo, tags, license, status, donation_address,
       created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *
  `.trim(),

  FIND_BY_ID: `
    SELECT * FROM ${TABLE.PROJECTS} WHERE id = $1 LIMIT 1
  `.trim(),

  FIND_BY_CUBE: `
    SELECT * FROM ${TABLE.PROJECTS}
    WHERE cube_x = $1 AND cube_y = $2 AND cube_z = $3
    ORDER BY created_at DESC
  `.trim(),

  FIND_BY_DEVELOPER: `
    SELECT * FROM ${TABLE.PROJECTS}
    WHERE developer_id = $1
    ORDER BY created_at DESC
  `.trim(),

  FIND_BY_TAG: `
    SELECT * FROM ${TABLE.PROJECTS}
    WHERE $1 = ANY(tags)
    ORDER BY created_at DESC
  `.trim(),

  UPDATE: `
    UPDATE ${TABLE.PROJECTS}
    SET name=$2, description=$3, repo=$4, tags=$5, license=$6,
        status=$7, donation_address=$8, updated_at=$9
    WHERE id=$1
    RETURNING *
  `.trim(),

  ARCHIVE: `
    UPDATE ${TABLE.PROJECTS}
    SET status='archived', updated_at=$2
    WHERE id=$1
    RETURNING id
  `.trim(),

  LIST_ALL: `
    SELECT * FROM ${TABLE.PROJECTS}
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `.trim(),

  COUNT: `
    SELECT COUNT(*) FROM ${TABLE.PROJECTS}
  `.trim(),

  EXISTS: `
    SELECT id FROM ${TABLE.PROJECTS} WHERE id = $1 LIMIT 1
  `.trim(),
};

// ─── ProjectRepository ────────────────────────────────────────────────────────

export class ProjectRepository implements IProjectRepository {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  async create(
    data: Omit<Project, "id" | "createdAt" | "updatedAt">,
    tx?:  Transaction
  ): Promise<Project> {
    const now     = new Date();
    const project: Project = {
      ...data,
      id:        newProjectID(),
      createdAt: now,
      updatedAt: now,
    };

    const params = projectMapper.toInsertParams(project);
    const source = tx ?? this.pool;

    try {
      const result = await runQuery<ProjectRow>(source, SQL.INSERT, params);
      if (result.rows.length === 0) {
        throw new SystemError({
          code:    ErrorCode.INTERNAL_ERROR,
          message: "Proje oluşturulamadı: satır dönmedi",
        });
      }
      this.logger?.debug(`Proje oluşturuldu: ${project.id}`);
      return projectMapper.toModel(result.rows[0]);
    } catch (err) {
      if (err instanceof SystemError) throw err;
      throw new SystemError({
        code:    ErrorCode.INTERNAL_ERROR,
        message: "Proje oluşturma hatası",
        cause:   err instanceof Error ? err : undefined,
      });
    }
  }

  async findById(id: string, tx?: Transaction): Promise<Project | null> {
    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(source, SQL.FIND_BY_ID, [id]);
    return result.rows.length > 0 ? projectMapper.toModel(result.rows[0]) : null;
  }

  async findByCube(coord: CubeCoordinate, tx?: Transaction): Promise<Project[]> {
    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(
      source, SQL.FIND_BY_CUBE, [coord.x, coord.y, coord.z]
    );
    return result.rows.map((r) => projectMapper.toModel(r));
  }

  async findByDeveloper(developerId: string, tx?: Transaction): Promise<Project[]> {
    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(source, SQL.FIND_BY_DEVELOPER, [developerId]);
    return result.rows.map((r) => projectMapper.toModel(r));
  }

  async findByTag(tag: string, tx?: Transaction): Promise<Project[]> {
    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(source, SQL.FIND_BY_TAG, [tag]);
    return result.rows.map((r) => projectMapper.toModel(r));
  }

  async update(
    id:    string,
    patch: Partial<Project>,
    tx?:   Transaction
  ): Promise<Project | null> {
    const existing = await this.findById(id, tx);
    if (!existing) return null;

    const merged: Project = {
      ...existing,
      ...patch,
      id,
      updatedAt: new Date(),
    };

    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(source, SQL.UPDATE, [
      id,
      merged.name,
      merged.description,
      merged.repo,
      merged.tags,
      merged.license,
      merged.status,
      merged.donationAddress ?? null,
      merged.updatedAt.toISOString(),
    ]);

    return result.rows.length > 0 ? projectMapper.toModel(result.rows[0]) : null;
  }

  async archive(id: string, tx?: Transaction): Promise<boolean> {
    const source = tx ?? this.pool;
    const result = await runQuery(
      source, SQL.ARCHIVE, [id, new Date().toISOString()]
    );
    return result.rowCount > 0;
  }

  async listAll(
    limit  = 50,
    offset = 0,
    tx?:   Transaction
  ): Promise<Project[]> {
    const source = tx ?? this.pool;
    const result = await runQuery<ProjectRow>(source, SQL.LIST_ALL, [limit, offset]);
    return result.rows.map((r) => projectMapper.toModel(r));
  }

  async count(tx?: Transaction): Promise<number> {
    const source = tx ?? this.pool;
    const result = await runQuery<{ count: string }>(source, SQL.COUNT);
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async exists(id: string, tx?: Transaction): Promise<boolean> {
    const source = tx ?? this.pool;
    const result = await runQuery(source, SQL.EXISTS, [id]);
    return result.rowCount > 0;
  }
}
