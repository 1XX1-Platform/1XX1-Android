/**
 * 1XX1 Migration Sistemi
 * Aşama 07 — Persistence Katmanı
 *
 * Her migration tek yönlü (up-only):
 *   - 001_create_projects
 *   - 002_create_developers
 *   - 003_create_events
 *   - 004_create_snapshots
 *   - 005_create_cube_index
 *   - 006_create_indexes
 *
 * Migration geçmişi "schema_migrations" tablosunda saklanır.
 * Aynı migration iki kez çalıştırılmaz (idempotent).
 * Hata olursa transaction rollback ile tutarlı kalınır.
 */

import type { DbPool } from "../connection.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { TABLE } from "../schema/schema.ts";

// ─── Migration Tanımı ─────────────────────────────────────────────────────────

export interface Migration {
  id:   string;   // "001_create_projects"
  up:   string;   // SQL
  description: string;
}

// ─── Migration Listesi ────────────────────────────────────────────────────────

export const MIGRATIONS: Migration[] = [
  {
    id:          "001_create_projects",
    description: "Proje tablosu",
    up: `
      CREATE TABLE IF NOT EXISTS ${TABLE.PROJECTS} (
        id               TEXT         PRIMARY KEY NOT NULL,
        name             VARCHAR(255) NOT NULL,
        description      TEXT         NOT NULL DEFAULT '',
        cube_x           INTEGER      NOT NULL,
        cube_y           INTEGER      NOT NULL,
        cube_z           INTEGER      NOT NULL,
        cube_path        TEXT         NOT NULL,
        developer_id     TEXT         NOT NULL,
        repo             TEXT         NOT NULL DEFAULT '',
        tags             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
        license          VARCHAR(255) NOT NULL DEFAULT 'Unknown',
        status           VARCHAR(255) NOT NULL DEFAULT 'active',
        donation_address TEXT,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `.trim(),
  },
  {
    id:          "002_create_developers",
    description: "Geliştirici tablosu",
    up: `
      CREATE TABLE IF NOT EXISTS ${TABLE.DEVELOPERS} (
        id               TEXT         PRIMARY KEY NOT NULL,
        username         VARCHAR(255) NOT NULL UNIQUE,
        display_name     VARCHAR(255) NOT NULL,
        bio              TEXT,
        website          TEXT,
        donation_address TEXT,
        joined_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `.trim(),
  },
  {
    id:          "003_create_events",
    description: "Event Store tablosu",
    up: `
      CREATE TABLE IF NOT EXISTS ${TABLE.EVENTS} (
        event_id         TEXT        PRIMARY KEY NOT NULL,
        scope            VARCHAR(255) NOT NULL,
        event_type       VARCHAR(255) NOT NULL,
        payload          JSONB        NOT NULL DEFAULT '{}'::jsonb,
        idempotency_key  TEXT         UNIQUE,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `.trim(),
  },
  {
    id:          "004_create_snapshots",
    description: "Cube snapshot tablosu",
    up: `
      CREATE TABLE IF NOT EXISTS ${TABLE.CUBE_SNAPSHOTS} (
        snapshot_id TEXT        PRIMARY KEY NOT NULL,
        cube_path   TEXT        NOT NULL,
        payload     JSONB       NOT NULL,
        checksum    TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.trim(),
  },
  {
    id:          "005_create_cube_index",
    description: "Küp-Proje indeks tablosu",
    up: `
      CREATE TABLE IF NOT EXISTS ${TABLE.CUBE_INDEX} (
        cube_path  TEXT        NOT NULL,
        project_id TEXT        NOT NULL REFERENCES ${TABLE.PROJECTS}(id) ON DELETE CASCADE,
        depth      INTEGER     NOT NULL DEFAULT 0,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (cube_path, project_id)
      )
    `.trim(),
  },
  {
    id:          "006_create_indexes",
    description: "Performans indeksleri",
    up: `
      CREATE INDEX IF NOT EXISTS idx_projects_developer_id  ON ${TABLE.PROJECTS}  (developer_id);
      CREATE INDEX IF NOT EXISTS idx_projects_cube_path     ON ${TABLE.PROJECTS}  (cube_path);
      CREATE INDEX IF NOT EXISTS idx_projects_status        ON ${TABLE.PROJECTS}  (status);
      CREATE INDEX IF NOT EXISTS idx_projects_license       ON ${TABLE.PROJECTS}  (license);
      CREATE INDEX IF NOT EXISTS idx_projects_created_at    ON ${TABLE.PROJECTS}  (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_cube_xyz      ON ${TABLE.PROJECTS}  (cube_x, cube_y, cube_z);
      CREATE INDEX IF NOT EXISTS idx_projects_tags          ON ${TABLE.PROJECTS}  USING GIN(tags);
      CREATE INDEX IF NOT EXISTS idx_events_scope_type      ON ${TABLE.EVENTS}    (scope, event_type);
      CREATE INDEX IF NOT EXISTS idx_events_created_at      ON ${TABLE.EVENTS}    (created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_cube_path    ON ${TABLE.CUBE_SNAPSHOTS} (cube_path);
      CREATE INDEX IF NOT EXISTS idx_snapshots_created_at   ON ${TABLE.CUBE_SNAPSHOTS} (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cube_index_path        ON ${TABLE.CUBE_INDEX} (cube_path);
      CREATE INDEX IF NOT EXISTS idx_cube_index_project     ON ${TABLE.CUBE_INDEX} (project_id)
    `.trim(),
  },
];

// ─── MigrationRunner ─────────────────────────────────────────────────────────

export class MigrationRunner {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  /**
   * Tüm bekleyen migration'ları çalıştır.
   * Çalıştırılmış olanlar atlanır.
   * Hata olunca durur (partial migration durumu korunur).
   */
  async runAll(): Promise<{ ran: string[]; skipped: string[] }> {
    await this._ensureHistoryTable();
    const ran: string[]     = [];
    const skipped: string[] = [];

    for (const migration of MIGRATIONS) {
      const already = await this._alreadyRan(migration.id);
      if (already) {
        skipped.push(migration.id);
        continue;
      }

      await this._runOne(migration);
      ran.push(migration.id);
    }

    this.logger?.info(
      `Migration: ${ran.length} çalıştı, ${skipped.length} atlandı`
    );
    return { ran, skipped };
  }

  /** Belirli bir migration'ı çalıştır */
  async runOne(id: string): Promise<boolean> {
    await this._ensureHistoryTable();
    const migration = MIGRATIONS.find((m) => m.id === id);
    if (!migration) return false;

    const already = await this._alreadyRan(id);
    if (already) return false;

    await this._runOne(migration);
    return true;
  }

  /** Çalıştırılmış migration'ları listele */
  async history(): Promise<Array<{ id: string; ranAt: Date }>> {
    await this._ensureHistoryTable();
    const result = await this.pool.query<{ migration_id: string; ran_at: string }>(
      "SELECT migration_id, ran_at FROM schema_migrations ORDER BY ran_at ASC"
    );
    return result.rows.map((r) => ({
      id:    r.migration_id,
      ranAt: new Date(r.ran_at),
    }));
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async _ensureHistoryTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT        PRIMARY KEY NOT NULL,
        ran_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async _alreadyRan(id: string): Promise<boolean> {
    const r = await this.pool.query(
      "SELECT migration_id FROM schema_migrations WHERE migration_id = $1 LIMIT 1",
      [id]
    );
    return r.rowCount > 0;
  }

  private async _runOne(migration: Migration): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.query("BEGIN");

      // Migration SQL'i çalıştır (birden fazla statement olabilir: ";" ile ayrılmış)
      const statements = migration.up
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        await conn.query(stmt);
      }

      // Geçmişe kaydet
      await conn.query(
        "INSERT INTO schema_migrations (migration_id, ran_at) VALUES ($1, $2)",
        [migration.id, new Date().toISOString()]
      );

      await conn.query("COMMIT");
      this.logger?.info(`Migration çalıştı: ${migration.id} — ${migration.description}`);
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      this.logger?.error(
        `Migration başarısız: ${migration.id}`,
        err instanceof Error ? err : undefined
      );
      throw err;
    } finally {
      conn.release();
    }
  }
}
