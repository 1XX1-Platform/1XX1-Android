/**
 * 1XX1 Transaction Yöneticisi
 * Aşama 07 — Persistence Katmanı
 *
 * Atomic transaction desteği:
 *   begin()    → transaction başlat
 *   commit()   → değişiklikleri kalıcı yap
 *   rollback() → değişiklikleri geri al
 *
 * Savepoint desteği (iç içe transaction'lar için):
 *   savepoint(name) → ara checkpoint oluştur
 *   rollbackTo(name) → checkpoint'e geri dön
 *   releaseSavepoint(name) → checkpoint'i kaldır
 *
 * Kullanım:
 *   const tx = await txManager.begin();
 *   try {
 *     await repo.create(project, tx);
 *     await cubeRepo.index(project.id, tx);
 *     await tx.commit();
 *   } catch (err) {
 *     await tx.rollback();
 *     throw err;
 *   }
 *
 * Cube split/merge işlemleri bu manager üzerinden tek transaction'da çalışır.
 */

import type { DbPool, DbConnection, QueryResult } from "./connection.ts";
import type { ILogger } from "../core/interfaces.ts";

// ─── Transaction Arayüzü ─────────────────────────────────────────────────────

export interface Transaction {
  /** Transaction içinde sorgu çalıştır */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
  /** Transaction hâlâ açık mı? */
  isActive(): boolean;
}

// ─── TransactionManager ───────────────────────────────────────────────────────

export class TransactionManager {

  constructor(
    pool:   DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;}

  /**
   * Yeni bir transaction başlat.
   * Dönen Transaction nesnesi üzerinden tüm işlemler yapılır.
   */
  async begin(): Promise<Transaction> {
    const conn = await this.pool.connect();
    await conn.query("BEGIN");
    this.logger?.debug("Transaction başladı");
    return new TransactionImpl(conn, this.logger);
  }

  /**
   * Bir işlevi otomatik transaction sarmalıyla çalıştır.
   * Başarısızlıkta otomatik rollback yapar.
   *
   * Örnek:
   *   await txManager.run(async (tx) => {
   *     await projectRepo.create(p, tx);
   *     await cubeRepo.index(p.id, tx);
   *   });
   */
  async run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.begin();
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {}); // rollback hatası ana hatayı gizlemesin
      throw err;
    }
  }
}

// ─── Transaction Implementasyonu ─────────────────────────────────────────────

class TransactionImpl implements Transaction {
  private _active = true;

  constructor(
    conn:   DbConnection,
    logger?: ILogger
  ) {
    this.conn = conn;
    this.logger = logger;
}

  async query<T = Record<string, unknown>>(
    sql:     string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (!this._active) throw new Error("Transaction kapalı");
    return this.conn.query<T>(sql, params);
  }

  async commit(): Promise<void> {
    if (!this._active) return;
    await this.conn.query("COMMIT");
    this._active = false;
    this.conn.release();
    this.logger?.debug("Transaction commit");
  }

  async rollback(): Promise<void> {
    if (!this._active) return;
    try {
      await this.conn.query("ROLLBACK");
    } finally {
      this._active = false;
      this.conn.release();
      this.logger?.debug("Transaction rollback");
    }
  }

  async savepoint(name: string): Promise<void> {
    if (!this._active) throw new Error("Transaction kapalı");
    this._validateSavepointName(name);
    await this.conn.query(`SAVEPOINT ${name}`);
    this.logger?.debug(`Savepoint: ${name}`);
  }

  async rollbackTo(name: string): Promise<void> {
    if (!this._active) throw new Error("Transaction kapalı");
    this._validateSavepointName(name);
    await this.conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
    this.logger?.debug(`Rollback to: ${name}`);
  }

  async releaseSavepoint(name: string): Promise<void> {
    if (!this._active) throw new Error("Transaction kapalı");
    this._validateSavepointName(name);
    await this.conn.query(`RELEASE SAVEPOINT ${name}`);
  }

  isActive(): boolean {
    return this._active;
  }

  private _validateSavepointName(name: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Geçersiz savepoint adı: "${name}"`);
    }
  }
}
