/**
 * 1XX1 Database — Dışa Aktarma ve UnitOfWork
 * Aşama 07 — Persistence Katmanı
 *
 * UnitOfWork: Tüm repository'leri tek noktadan yönetir.
 * Üst katmanlar yalnızca UnitOfWork'u görür; repository'leri doğrudan oluşturmaz.
 *
 * Kullanım:
 *   const db = new UnitOfWork(pool);
 *   const project = await db.projects.create(data);
 *   const dev     = await db.developers.findById(id);
 */

export * from "./connection.ts";
export * from "./transaction.ts";
export * from "./schema/schema.ts";
export * from "./mapper/mapper.ts";
export * from "./repositories/project.repository.ts";
export * from "./repositories/other.repositories.ts";
export * from "./migrations/runner.ts";
export * from "./seed/seeder.ts";

import type { DbPool } from "./connection.ts";
import type { ILogger } from "../core/interfaces.ts";
import { TransactionManager } from "./transaction.ts";
import { ProjectRepository } from "./repositories/project.repository.ts";
import {
  DeveloperRepository,
  EventRepository,
  SnapshotRepository,
} from "./repositories/other.repositories.ts";
import { MigrationRunner } from "./migrations/runner.ts";
import { DatabaseSeeder } from "./seed/seeder.ts";
import { InMemoryPool } from "./connection.ts";

// ─── UnitOfWork ───────────────────────────────────────────────────────────────

export class UnitOfWork {
  readonly projects:    ProjectRepository;
  readonly developers:  DeveloperRepository;
  readonly events:      EventRepository;
  readonly snapshots:   SnapshotRepository;
  readonly tx:          TransactionManager;
  readonly migrations:  MigrationRunner;
  readonly seeder:      DatabaseSeeder;

  constructor(
    pool: DbPool,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.pool = pool;
    this.projects   = new ProjectRepository(pool, logger);
    this.developers = new DeveloperRepository(pool, logger);
    this.events     = new EventRepository(pool, logger);
    this.snapshots  = new SnapshotRepository(pool, logger);
    this.tx         = new TransactionManager(pool, logger);
    this.migrations = new MigrationRunner(pool, logger);
    this.seeder     = new DatabaseSeeder(this.projects, this.developers, logger);
  }

  /** Sağlık kontrolü */
  async isHealthy(): Promise<boolean> {
    return this.pool.isHealthy();
  }

  /** Bağlantıyı kapat */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Test için hazır in-memory UnitOfWork */
export function createTestDb(): UnitOfWork {
  return new UnitOfWork(new InMemoryPool());
}
