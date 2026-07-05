/**
 * 1XX1 Veritabanı Bağlantısı
 * Aşama 07 — Persistence Katmanı
 *
 * Mimari karar: Üst katmanlar SQL veya pg paketini ASLA doğrudan kullanmaz.
 * Tüm erişim bu adapter üzerinden geçer.
 *
 * Gerçek ortamda: pg (node-postgres) connection pool kullanılır.
 * Test ortamında: in-memory SQLite veya mock adapter kullanılır.
 *
 * Connection Pool:
 *   min: 2 bağlantı (her zaman hazır)
 *   max: 20 bağlantı
 *   idle timeout: 30 saniye
 *   connection timeout: 5 saniye
 *
 * Bu dosya dış bağımlılık içerir (pg paketi).
 * Diğer tüm dosyalar bu dosyadan pool alır, doğrudan pg import etmez.
 */

import type { ILogger } from "../core/interfaces.ts";

// ─── Soyut Sorgu Sonucu ───────────────────────────────────────────────────────

export interface QueryResult<T = Record<string, unknown>> {
  rows:         T[];
  rowCount:     number;
  command:      string; // "SELECT", "INSERT", vb.
  fields:       string[];
}

// ─── Bağlantı Arayüzü ────────────────────────────────────────────────────────

export interface DbConnection {
  query<T = Record<string, unknown>>(
    sql:    string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  release(): void;
}

// ─── Pool Arayüzü ─────────────────────────────────────────────────────────────

export interface DbPool {
  connect(): Promise<DbConnection>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
  isHealthy(): Promise<boolean>;
}

// ─── Pool Yapılandırması ──────────────────────────────────────────────────────

export interface DbConfig {
  host:             string;
  port:             number;
  database:         string;
  user:             string;
  password:         string;
  ssl?:             boolean;
  poolMin?:         number;  // varsayılan: 2
  poolMax?:         number;  // varsayılan: 20
  idleTimeoutMs?:   number;  // varsayılan: 30_000
  connectTimeoutMs?: number; // varsayılan: 5_000
}

// ─── In-Memory Mock Pool (Test + Geliştirme) ──────────────────────────────────

/**
 * Gerçek PostgreSQL olmadan çalışabilen in-memory implementasyon.
 * Tüm repository testleri bu pool üzerinde çalışır.
 *
 * Production'da bu sınıf yerine PgPool kullanılır.
 * Değişiklik yalnızca factory fonksiyonunda yapılır.
 */
export class InMemoryPool implements DbPool {
  /** Tablo adı → satır listesi */
  private readonly tables = new Map<string, Record<string, unknown>[]>();
  private _healthy = true;

  async connect(): Promise<DbConnection> {
    const self = this;
    return {
      query: <T>(sql: string, params?: unknown[]) =>
        self.query<T>(sql, params),
      release: () => {},
    };
  }

  async query<T = Record<string, unknown>>(
    sql:     string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    const normalized = sql.trim().toUpperCase();

    // ── CREATE TABLE ──
    if (normalized.startsWith("CREATE TABLE")) {
      const match = sql.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?/i);
      if (match) this.tables.set(match[1], []);
      return { rows: [], rowCount: 0, command: "CREATE", fields: [] };
    }

    // ── DROP TABLE ──
    if (normalized.startsWith("DROP TABLE")) {
      const match = sql.match(/DROP TABLE(?:\s+IF EXISTS)?\s+"?(\w+)"?/i);
      if (match) this.tables.delete(match[1]);
      return { rows: [], rowCount: 0, command: "DROP", fields: [] };
    }

    // ── CREATE INDEX ──
    if (normalized.startsWith("CREATE INDEX") || normalized.startsWith("CREATE UNIQUE INDEX")) {
      return { rows: [], rowCount: 0, command: "CREATE", fields: [] };
    }

    // ── INSERT ──
    if (normalized.startsWith("INSERT")) {
      const tableMatch = sql.match(/INSERT INTO\s+"?(\w+)"?/i);
      if (!tableMatch) return { rows: [], rowCount: 0, command: "INSERT", fields: [] };
      const table = tableMatch[1];
      if (!this.tables.has(table)) this.tables.set(table, []);

      // Basit parametre binding: $1, $2, ... → params dizisi
      const row = this._parseInsert(sql, params ?? []);
      this.tables.get(table)!.push(row);
      return { rows: [row as T], rowCount: 1, command: "INSERT", fields: Object.keys(row) };
    }

    // ── SELECT ──
    if (normalized.startsWith("SELECT")) {
      const tableMatch = sql.match(/FROM\s+"?(\w+)"?/i);
      if (!tableMatch) return { rows: [], rowCount: 0, command: "SELECT", fields: [] };
      const table = tableMatch[1];
      const rows  = this.tables.get(table) ?? [];

      // WHERE id = $1
      const filtered = this._applyWhere(sql, rows, params ?? []);
      const limited  = this._applyLimit(sql, filtered, params ?? []);
      const counted  = this._applyCount(sql, filtered);

      if (counted !== null) {
        return {
          rows:     [{ count: String(counted) } as T],
          rowCount: 1,
          command:  "SELECT",
          fields:   ["count"],
        };
      }

      return {
        rows:     limited as T[],
        rowCount: limited.length,
        command:  "SELECT",
        fields:   rows.length > 0 ? Object.keys(rows[0]) : [],
      };
    }

    // ── UPDATE ──
    if (normalized.startsWith("UPDATE")) {
      const tableMatch = sql.match(/UPDATE\s+"?(\w+)"?/i);
      if (!tableMatch) return { rows: [], rowCount: 0, command: "UPDATE", fields: [] };
      const table = tableMatch[1];
      const rows  = this.tables.get(table) ?? [];
      let   count = 0;

      const updated = rows.map((row) => {
        if (this._matchesWhere(sql, row, params ?? [])) {
          count++;
          return { ...row, ...this._parseUpdateSet(sql, params ?? []) };
        }
        return row;
      });
      this.tables.set(table, updated);
      const returnRow = updated.find((r) => this._matchesWhere(sql, r, params ?? []));
      return {
        rows:     returnRow ? [returnRow as T] : [],
        rowCount: count,
        command:  "UPDATE",
        fields:   returnRow ? Object.keys(returnRow) : [],
      };
    }

    // ── DELETE ──
    if (normalized.startsWith("DELETE")) {
      const tableMatch = sql.match(/DELETE FROM\s+"?(\w+)"?/i);
      if (!tableMatch) return { rows: [], rowCount: 0, command: "DELETE", fields: [] };
      const table  = tableMatch[1];
      const rows   = this.tables.get(table) ?? [];
      const before = rows.length;
      const kept   = rows.filter((row) => !this._matchesWhere(sql, row, params ?? []));
      this.tables.set(table, kept);
      return { rows: [], rowCount: before - kept.length, command: "DELETE", fields: [] };
    }

    return { rows: [], rowCount: 0, command: "UNKNOWN", fields: [] };
  }

  async end(): Promise<void> {
    this.tables.clear();
    this._healthy = false;
  }

  async isHealthy(): Promise<boolean> {
    return this._healthy;
  }

  /** Test için: tablonun tüm satırlarını döndür */
  _getTable(name: string): Record<string, unknown>[] {
    return this.tables.get(name) ?? [];
  }

  /** Test için: tabloyu sıfırla */
  _clearTable(name: string): void {
    this.tables.set(name, []);
  }

  // ─── Basit SQL Parser (yalnızca mock için) ───────────────────────────────

  private _parseInsert(sql: string, params: unknown[]): Record<string, unknown> {
    const colMatch  = sql.match(/\(([^)]+)\)\s*VALUES/i);
    const valMatch  = sql.match(/VALUES\s*\(([^)]+)\)/i);
    if (!colMatch || !valMatch) return {};

    const cols = colMatch[1].split(",").map((c) => c.trim().replace(/"/g, ""));
    const vals = valMatch[1].split(",").map((v) => v.trim());

    const row: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      const val = vals[i];
      if (val?.startsWith("$")) {
        const idx = parseInt(val.slice(1), 10) - 1;
        row[cols[i]] = params[idx] ?? null;
      } else if (val === "NOW()") {
        row[cols[i]] = new Date().toISOString();
      } else {
        row[cols[i]] = val?.replace(/'/g, "") ?? null;
      }
    }
    return row;
  }

  private _applyWhere(
    sql:    string,
    rows:   Record<string, unknown>[],
    params: unknown[]
  ): Record<string, unknown>[] {
    return rows.filter((row) => this._matchesWhere(sql, row, params));
  }

  private _matchesWhere(
    sql:    string,
    row:    Record<string, unknown>,
    params: unknown[]
  ): boolean {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+RETURNING|$)/is);
    if (!whereMatch) return true;

    const condition = whereMatch[1].trim();

    // "col = $N"
    const eqMatch = condition.match(/^(\w+)\s*=\s*\$(\d+)$/i);
    if (eqMatch) {
      const col = eqMatch[1];
      const idx = parseInt(eqMatch[2], 10) - 1;
      return String(row[col]) === String(params[idx]);
    }

    // "col = $N AND col2 = $M"
    const andParts = condition.split(/\s+AND\s+/i);
    return andParts.every((part) => {
      const m = part.trim().match(/(\w+)\s*=\s*\$(\d+)/i);
      if (!m) return true;
      const idx = parseInt(m[2], 10) - 1;
      return String(row[m[1]]) === String(params[idx]);
    });
  }

  private _applyLimit(
    sql:    string,
    rows:   Record<string, unknown>[],
    _params: unknown[]
  ): Record<string, unknown>[] {
    const limitMatch  = sql.match(/LIMIT\s+(\d+)/i);
    const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
    const limit  = limitMatch  ? parseInt(limitMatch[1],  10) : rows.length;
    const offset = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    return rows.slice(offset, offset + limit);
  }

  private _applyCount(sql: string, rows: Record<string, unknown>[]): number | null {
    if (/SELECT\s+COUNT\(\*\)/i.test(sql)) return rows.length;
    return null;
  }

  private _parseUpdateSet(
    sql:    string,
    params: unknown[]
  ): Record<string, unknown> {
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
    if (!setMatch) return {};

    const patch: Record<string, unknown> = {};
    for (const part of setMatch[1].split(",")) {
      const m = part.trim().match(/(\w+)\s*=\s*\$(\d+)/i);
      if (m) {
        const idx    = parseInt(m[2], 10) - 1;
        patch[m[1]] = params[idx];
      }
    }
    return patch;
  }
}

// ─── Gerçek PostgreSQL Pool Wrapper ──────────────────────────────────────────

/**
 * Production pool.
 * `pg` paketi yalnızca burada import edilir; diğer hiçbir dosya pg görmez.
 * Test ortamında bu sınıf kullanılmaz.
 */
export class PgPool implements DbPool {
  // dyn import kullanılır — paket yoksa test ortamı sorunsuz çalışır
  private _pool: unknown = null;

  constructor(
    cfg: DbConfig,
    logger?: ILogger
  ) {
    this.logger = logger;}

  async init(): Promise<void> {
    try {
      const { Pool } = await import("pg");
      this._pool = new Pool({
        host:              this.cfg.host,
        port:              this.cfg.port,
        database:          this.cfg.database,
        user:              this.cfg.user,
        password:          this.cfg.password,
        ssl:               this.cfg.ssl ? { rejectUnauthorized: false } : false,
        min:               this.cfg.poolMin            ?? 2,
        max:               this.cfg.poolMax            ?? 20,
        idleTimeoutMillis: this.cfg.idleTimeoutMs      ?? 30_000,
        connectionTimeoutMillis: this.cfg.connectTimeoutMs ?? 5_000,
      });
      this.logger?.info(`PostgreSQL pool bağlandı: ${this.cfg.host}:${this.cfg.port}/${this.cfg.database}`);
    } catch (err) {
      this.logger?.error("PostgreSQL bağlantı hatası", err instanceof Error ? err : undefined);
      throw err;
    }
  }

  async connect(): Promise<DbConnection> {
    if (!this._pool) throw new Error("Pool başlatılmamış. init() çağrın.");
    const pool   = this._pool as { connect: () => Promise<unknown> };
    const client = await pool.connect() as {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number; command: string; fields: Array<{ name: string }> }>;
      release: () => void;
    };
    return {
      query: async <T>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params);
        return {
          rows:     res.rows as T[],
          rowCount: res.rowCount,
          command:  res.command,
          fields:   res.fields.map((f) => f.name),
        };
      },
      release: () => client.release(),
    };
  }

  async query<T = Record<string, unknown>>(
    sql:    string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (!this._pool) throw new Error("Pool başlatılmamış.");
    const pool = this._pool as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number; command: string; fields: Array<{ name: string }> }> };
    const res  = await pool.query(sql, params);
    return {
      rows:     res.rows as T[],
      rowCount: res.rowCount,
      command:  res.command,
      fields:   res.fields.map((f) => f.name),
    };
  }

  async end(): Promise<void> {
    if (this._pool) {
      await (this._pool as { end: () => Promise<void> }).end();
      this.logger?.info("PostgreSQL pool kapatıldı");
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Fabrika ─────────────────────────────────────────────────────────────────

export type PoolMode = "memory" | "postgres";

export function createPool(
  mode: PoolMode = "memory",
  cfg?: DbConfig,
  logger?: ILogger
): DbPool {
  if (mode === "postgres") {
    if (!cfg) throw new Error("PostgreSQL modu için DbConfig zorunludur");
    return new PgPool(cfg, logger);
  }
  return new InMemoryPool();
}

/** Test ve geliştirme için hazır in-memory pool */
export const testPool = new InMemoryPool();
