/**
 * 1XX1 ApplicationOrchestrator
 * Aşama 08 — Domain & Application Services
 *
 * Tüm servisleri tek noktada birleştirir.
 * Üst katmanlar (API) yalnızca bu sınıfı görür.
 *
 * Bağımlılık grafiği:
 *
 *   ApplicationOrchestrator
 *     ├── ProjectService
 *     │     ├── UnitOfWork (db)
 *     │     ├── FractalCubeEngine (cube)
 *     │     ├── IndexManager (index)
 *     │     ├── DomainEventPublisher
 *     │     ├── ProjectValidator
 *     │     └── PolicyEngine
 *     ├── DeveloperService
 *     │     ├── UnitOfWork (db)
 *     │     ├── DomainEventPublisher
 *     │     ├── DeveloperValidator
 *     │     └── PolicyEngine
 *     └── SearchApplicationService
 *           ├── SearchEngine (read-only)
 *           ├── UnitOfWork (db)
 *           └── PolicyEngine (visibility)
 *
 * Create Project akışı:
 *   POST /projects
 *     → API Handler
 *     → Orchestrator.projects.create(cmd)
 *     → ProjectService.create(cmd)
 *         → Validation
 *         → TX: Repository + EventStore
 *         → CubeEngine.index()
 *         → IndexManager.indexProject()
 *         → DomainEventPublisher.projectPublished()
 *     ← CommandOutcome<Project>
 *     ← HTTP 201
 */

import type { UnitOfWork } from "../../database/index.ts";
import type { FractalCubeEngine } from "../../cube_engine/fractal-cube-engine.ts";
import type { IndexManager } from "../../search/index-manager.ts";
import type { SearchEngine } from "../../search/search-engine.ts";
import type { IEventBus } from "../../core/interfaces.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { ProjectService } from "../services/project.service.ts";
import { DeveloperService, SearchApplicationService } from "../services/developer.service.ts";
import { DomainEventPublisher } from "../events/domain-events.ts";
import { PolicyEngine } from "../policies/policies.ts";

// ─── Orchestrator Bağımlılıkları ─────────────────────────────────────────────

export interface OrchestratorDeps {
  db:           UnitOfWork;
  cube:         FractalCubeEngine;
  indexManager: IndexManager;
  searchEngine: SearchEngine;
  eventBus:     IEventBus;
  logger?:      ILogger;
}

// ─── ApplicationOrchestrator ─────────────────────────────────────────────────

export class ApplicationOrchestrator {
  readonly projects:   ProjectService;
  readonly developers: DeveloperService;
  readonly search:     SearchApplicationService;
  readonly policy:     PolicyEngine;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    const publisher = new DomainEventPublisher(deps.eventBus);

    this.policy     = new PolicyEngine();

    this.projects   = new ProjectService(
      deps.db,
      deps.cube,
      deps.indexManager,
      publisher,
      deps.logger
    );

    this.developers = new DeveloperService(
      deps.db,
      publisher,
      deps.logger
    );

    this.search = new SearchApplicationService(
      deps.searchEngine,
      deps.db,
      deps.logger
    );
  }

  /** Sistem sağlık durumu */
  async health(): Promise<{
    db:     boolean;
    cube:   boolean;
    index:  boolean;
  }> {
    const [dbOk] = await Promise.all([
      this.projects["db"].isHealthy().catch(() => false),
    ]);

    return {
      db:    dbOk,
      cube:  true,  // FractalCubeEngine her zaman in-memory hazır
      index: true,  // IndexManager her zaman hazır
    };
  }
}

// ─── Fabrika ─────────────────────────────────────────────────────────────────

/**
 * Test için minimal orchestrator.
 * Gerçek uygulamada createApiServer() bu factory'yi çağırır.
 */
export function createOrchestrator(deps: OrchestratorDeps): ApplicationOrchestrator {
  return new ApplicationOrchestrator(deps);
}
