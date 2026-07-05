/**
 * 1XX1 Developer, Event ve Snapshot Repository'leri
 * Aşama 07 — Persistence Katmanı
 *
 * Üç repository tek dosyada — hepsi aynı CRUD-only kuralını izler.
 * SQL bu dosyadan yukarı sızmaz.
 */

import type { IDeveloperRepository } from "../../core/interfaces.ts";
import type { Developer } from "../../core/types.ts";
import type { DbPool } from "../connection.ts";
import type { Transaction } from "../transaction.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { developerMapper } from "../mapper/mapper.ts";
import type { DeveloperRow, EventRow, SnapshotRow } from "../mapper/mapper.ts";
import { TABLE } from "../schema/schema.ts";
import { newDeveloperID, newEventID } from "../../core/identity.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";
import type { SystemEventType } from "../../core/types.ts";

type QuerySource = DbPool | Transaction;
function isTransaction(s: QuerySource): s is Transaction { return "commit" in s; }
function runQuery<T>(src: QuerySource, sql: string, params?: unknown[]) {
  return isTransaction(src) ? src.query<T>(sql, params) : src.query<T>(sql, params);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DeveloperRepository
// ═══════════════════════════════════════════════════════════════════════════════

const DEV_SQL = {
  INSERT: `
    INSERT INTO ${TABLE.DEVELOPERS}
      (id, username, display_name, bio, website, donation_address, joined_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *
  `.trim(),
  FIND_BY_ID:   `SELECT * FROM ${TABLE.DEVELOPERS} WHERE id = $1 LIMIT 1`.trim(),
  FIND_BY_USER: `SELECT * FROM ${TABLE.DEVELOPERS} WHERE username = $1 LIMIT 1`.trim(),
  UPDATE: `
    UPDATE ${TABLE.DEVELOPERS}
    SET display_name=$2, bio=$3, website=$4, donation_address=$5
    WHERE id=$1 RETURNING *
  `.trim(),
  LIST_ALL: `SELECT * FROM ${TABLE.DEVELOPERS} ORDER BY joined_at DESC`.trim(),
};

export class DeveloperRepository implements IDeveloperRepository {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  async create(
    data: Omit<Developer, "id" | "joinedAt">,
    tx?:  Transaction
  ): Promise<Developer> {
    const dev: Developer = {
      ...data,
      id:       newDeveloperID(),
      joinedAt: new Date(),
    };
    const params = developerMapper.toInsertParams(dev);
    const result = await runQuery<DeveloperRow>(tx ?? this.pool, DEV_SQL.INSERT, params);
    if (!result.rows[0]) {
      throw new SystemError({ code: ErrorCode.INTERNAL_ERROR, message: "Geliştirici oluşturulamadı" });
    }
    this.logger?.debug(`Geliştirici oluşturuldu: ${dev.id}`);
    return developerMapper.toModel(result.rows[0]);
  }

  async findById(id: string, tx?: Transaction): Promise<Developer | null> {
    const r = await runQuery<DeveloperRow>(tx ?? this.pool, DEV_SQL.FIND_BY_ID, [id]);
    return r.rows[0] ? developerMapper.toModel(r.rows[0]) : null;
  }

  async findByUsername(username: string, tx?: Transaction): Promise<Developer | null> {
    const r = await runQuery<DeveloperRow>(tx ?? this.pool, DEV_SQL.FIND_BY_USER, [username]);
    return r.rows[0] ? developerMapper.toModel(r.rows[0]) : null;
  }

  async update(
    id:    string,
    patch: Partial<Developer>,
    tx?:   Transaction
  ): Promise<Developer | null> {
    const existing = await this.findById(id, tx);
    if (!existing) return null;
    const merged = { ...existing, ...patch, id };
    const r = await runQuery<DeveloperRow>(tx ?? this.pool, DEV_SQL.UPDATE, [
      id,
      merged.displayName,
      merged.bio ?? null,
      merged.website ?? null,
      merged.donationAddress ?? null,
    ]);
    return r.rows[0] ? developerMapper.toModel(r.rows[0]) : null;
  }

  async listAll(tx?: Transaction): Promise<Developer[]> {
    const r = await runQuery<DeveloperRow>(tx ?? this.pool, DEV_SQL.LIST_ALL);
    return r.rows.map((row) => developerMapper.toModel(row));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EventRepository — Event Store
// ═══════════════════════════════════════════════════════════════════════════════

export interface StoredEvent {
  eventId:         string;
  scope:           string;
  eventType:       string;
  payload:         Record<string, unknown>;
  idempotencyKey?: string;
  createdAt:       Date;
}

const EVT_SQL = {
  INSERT: `
    INSERT INTO ${TABLE.EVENTS}
      (event_id, scope, event_type, payload, idempotency_key, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
  `.trim(),
  FIND_BY_TYPE: `
    SELECT * FROM ${TABLE.EVENTS}
    WHERE scope = $1 AND event_type = $2
    ORDER BY created_at ASC
    LIMIT $3 OFFSET $4
  `.trim(),
  FIND_SINCE: `
    SELECT * FROM ${TABLE.EVENTS}
    WHERE created_at >= $1
    ORDER BY created_at ASC
    LIMIT $2
  `.trim(),
  BY_IKEY: `
    SELECT * FROM ${TABLE.EVENTS}
    WHERE idempotency_key = $1 LIMIT 1
  `.trim(),
  COUNT: `SELECT COUNT(*) FROM ${TABLE.EVENTS}`.trim(),
  PURGE_BEFORE: `DELETE FROM ${TABLE.EVENTS} WHERE created_at < $1`.trim(),
};

export class EventRepository {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  async store(
    scope:           string,
    type:            SystemEventType,
    payload:         Record<string, unknown>,
    idempotencyKey?: string,
    tx?:             Transaction
  ): Promise<StoredEvent | null> {
    const eventId = newEventID();
    const now     = new Date().toISOString();

    const result = await runQuery<EventRow>(tx ?? this.pool, EVT_SQL.INSERT, [
      eventId, scope, type,
      JSON.stringify(payload),
      idempotencyKey ?? null,
      now,
    ]);

    if (!result.rows[0]) {
      // ON CONFLICT DO NOTHING → idempotent, zaten var
      this.logger?.debug(`Event zaten var (idempotent): ${idempotencyKey}`);
      return null;
    }

    return this._toModel(result.rows[0]);
  }

  async findByType(
    scope:  string,
    type:   string,
    limit  = 100,
    offset = 0,
    tx?:   Transaction
  ): Promise<StoredEvent[]> {
    const r = await runQuery<EventRow>(
      tx ?? this.pool, EVT_SQL.FIND_BY_TYPE, [scope, type, limit, offset]
    );
    return r.rows.map((row) => this._toModel(row));
  }

  async findSince(since: Date, limit = 500, tx?: Transaction): Promise<StoredEvent[]> {
    const r = await runQuery<EventRow>(
      tx ?? this.pool, EVT_SQL.FIND_SINCE, [since.toISOString(), limit]
    );
    return r.rows.map((row) => this._toModel(row));
  }

  async wasProcessed(idempotencyKey: string, tx?: Transaction): Promise<boolean> {
    const r = await runQuery(tx ?? this.pool, EVT_SQL.BY_IKEY, [idempotencyKey]);
    return r.rowCount > 0;
  }

  async count(tx?: Transaction): Promise<number> {
    const r = await runQuery<{ count: string }>(tx ?? this.pool, EVT_SQL.COUNT);
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }

  /** Eski olayları temizle (veri saklama politikası) */
  async purgeBefore(date: Date, tx?: Transaction): Promise<number> {
    const r = await runQuery(tx ?? this.pool, EVT_SQL.PURGE_BEFORE, [date.toISOString()]);
    this.logger?.info(`EventStore: ${r.rowCount} eski olay silindi`);
    return r.rowCount;
  }

  private _toModel(row: EventRow): StoredEvent {
    const payload = typeof row.payload === "string"
      ? JSON.parse(row.payload)
      : row.payload;
    return {
      eventId:         row.event_id,
      scope:           row.scope,
      eventType:       row.event_type,
      payload,
      idempotencyKey:  row.idempotency_key ?? undefined,
      createdAt:       row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SnapshotRepository — Cube Engine Anlık Görüntüsü
// ═══════════════════════════════════════════════════════════════════════════════

export interface CubeSnapshot {
  snapshotId: string;
  cubePath:   string;
  payload:    Record<string, unknown>;
  checksum:   string;
  createdAt:  Date;
}

const SNAP_SQL = {
  INSERT: `
    INSERT INTO ${TABLE.CUBE_SNAPSHOTS}
      (snapshot_id, cube_path, payload, checksum, created_at)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
  `.trim(),
  LATEST: `
    SELECT * FROM ${TABLE.CUBE_SNAPSHOTS}
    WHERE cube_path = $1
    ORDER BY created_at DESC
    LIMIT 1
  `.trim(),
  LIST_RECENT: `
    SELECT * FROM ${TABLE.CUBE_SNAPSHOTS}
    ORDER BY created_at DESC
    LIMIT $1
  `.trim(),
  DELETE_OLD: `
    DELETE FROM ${TABLE.CUBE_SNAPSHOTS}
    WHERE cube_path = $1
      AND snapshot_id NOT IN (
        SELECT snapshot_id FROM ${TABLE.CUBE_SNAPSHOTS}
        WHERE cube_path = $1
        ORDER BY created_at DESC
        LIMIT $2
      )
  `.trim(),
  COUNT: `SELECT COUNT(*) FROM ${TABLE.CUBE_SNAPSHOTS}`.trim(),
};

/** Basit checksum: payload JSON uzunluğu + karakter toplamı (SHA-256 yerine) */
function simpleChecksum(payload: Record<string, unknown>): string {
  const json  = JSON.stringify(payload);
  let   hash  = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class SnapshotRepository {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  async save(
    cubePath: string,
    payload:  Record<string, unknown>,
    tx?:      Transaction
  ): Promise<CubeSnapshot> {
    const snapshotId = newEventID();
    const checksum   = simpleChecksum(payload);
    const now        = new Date().toISOString();

    const result = await runQuery<SnapshotRow>(tx ?? this.pool, SNAP_SQL.INSERT, [
      snapshotId, cubePath,
      JSON.stringify(payload),
      checksum, now,
    ]);

    this.logger?.debug(`Snapshot kaydedildi: ${cubePath} (${snapshotId})`);
    return this._toModel(result.rows[0]);
  }

  async latest(cubePath: string, tx?: Transaction): Promise<CubeSnapshot | null> {
    const r = await runQuery<SnapshotRow>(tx ?? this.pool, SNAP_SQL.LATEST, [cubePath]);
    return r.rows[0] ? this._toModel(r.rows[0]) : null;
  }

  async listRecent(n = 10, tx?: Transaction): Promise<CubeSnapshot[]> {
    const r = await runQuery<SnapshotRow>(tx ?? this.pool, SNAP_SQL.LIST_RECENT, [n]);
    return r.rows.map((row) => this._toModel(row));
  }

  /**
   * Eski snapshot'ları sil — her path için son N'i sakla.
   * Sonsuz büyümeyi önler.
   */
  async pruneOld(cubePath: string, keep = 3, tx?: Transaction): Promise<number> {
    const r = await runQuery(tx ?? this.pool, SNAP_SQL.DELETE_OLD, [cubePath, keep]);
    if (r.rowCount > 0) {
      this.logger?.debug(`Snapshot pruned: ${cubePath} (${r.rowCount} silindi, ${keep} kaldı)`);
    }
    return r.rowCount;
  }

  async count(tx?: Transaction): Promise<number> {
    const r = await runQuery<{ count: string }>(tx ?? this.pool, SNAP_SQL.COUNT);
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }

  private _toModel(row: SnapshotRow): CubeSnapshot {
    const payload = typeof row.payload === "string"
      ? JSON.parse(row.payload)
      : row.payload;
    return {
      snapshotId: row.snapshot_id,
      cubePath:   row.cube_path,
      payload,
      checksum:   row.checksum,
      createdAt:  row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }
}
