/**
 * 1XX1 Katman 1: Structural Index
 * Aşama 04 — Veri İndeksleme
 *
 * Küp ağacının anlık görüntüsü.
 * CubePath → proje sayısı, router mu, koordinat.
 *
 * Kaynaklar:
 *   cube:indexed     → proje eklendi
 *   cube:split       → router düğüm oluştu
 *   cube:merge       → router düğüm leaf'e döndü
 *   cube:path-changed → path güncellendi
 *
 * Arama motoru bu indeksi kullanarak:
 *   - koordinat bazlı filtreleme
 *   - yoğunluk haritası oluşturma
 *   - komşu küp sorgulaması yapar
 */

import type { IEventBus, ILogger } from "../core/interfaces.ts";
import type { CubeCoordinate } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { StructuralEntry } from "./index-types.ts";
import { parseCubePath, pathDepth } from "../cube_engine/cube-path.ts";

export class StructuralIndex {
  /** path → StructuralEntry */
  private readonly byPath = new Map<string, StructuralEntry>();
  /** projectId → path (hızlı ters arama) */
  private readonly byProject = new Map<ProjectID, string>();

  private _lastUpdated = new Date();

  constructor(
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this._subscribeToEvents();
  }

  // ─── Event Abonelikleri ───────────────────────────────────────────────────

  private _subscribeToEvents(): void {
    if (!this.eventBus) return;

    this.eventBus.on("cube:indexed", (event) => {
      const { path, projectId } = event.payload as { path: string; projectId: ProjectID };
      this._upsertPath(path, projectId, "upsert");
    });

    this.eventBus.on("cube:split", (event) => {
      const { path } = event.payload as { path: string };
      this._markRouter(path, true);
    });

    this.eventBus.on("cube:merge", (event) => {
      const { path } = event.payload as { path: string };
      this._markRouter(path, false);
    });

    // Risk 2'den gelen path değişim olayı
    this.eventBus.on("cube:path-changed" as never, (event) => {
      const { logicalId, oldPath, newPath } = event.payload as {
        logicalId: ProjectID; oldPath: string; newPath: string;
      };
      this._handlePathChange(logicalId, oldPath, newPath);
    });
  }

  // ─── Doğrudan Upsert (event dışı, test/bootstrap amaçlı) ─────────────────

  upsert(path: string, projectId: ProjectID): void {
    this._upsertPath(path, projectId, "upsert");
  }

  remove(projectId: ProjectID): void {
    const path = this.byProject.get(projectId);
    if (!path) return;
    this.byProject.delete(projectId);

    const entry = this.byPath.get(path);
    if (entry) {
      entry.projectCount = Math.max(0, entry.projectCount - 1);
      entry.updatedAt = new Date();
      if (entry.projectCount === 0 && !entry.isRouter) {
        this.byPath.delete(path);
      }
    }
    this._lastUpdated = new Date();
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  getByPath(path: string): StructuralEntry | undefined {
    return this.byPath.get(path);
  }

  getByProject(projectId: ProjectID): StructuralEntry | undefined {
    const path = this.byProject.get(projectId);
    return path ? this.byPath.get(path) : undefined;
  }

  /** Bir koordinat'a ait tüm path'leri (kök + alt küpler) döndür */
  getByCoord(coord: CubeCoordinate): StructuralEntry[] {
    const prefix = `${coord.x}/${coord.y}/${coord.z}`;
    const result: StructuralEntry[] = [];
    for (const [path, entry] of this.byPath) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Belirtilen derinlikteki tüm entry'leri döndür */
  getByDepth(depth: number): StructuralEntry[] {
    const result: StructuralEntry[] = [];
    for (const entry of this.byPath.values()) {
      if (entry.depth === depth) result.push(entry);
    }
    return result;
  }

  /** Yalnızca router olan entry'ler */
  getRouters(): StructuralEntry[] {
    return Array.from(this.byPath.values()).filter((e) => e.isRouter);
  }

  /**
   * Bir path'e kayıtlı ProjectID'leri döndür.
   * CandidateGenerator için — SearchEngine okuma katmanı.
   */
  getIdsByPath(path: string): ReadonlySet<ProjectID> {
    const ids = new Set<ProjectID>();
    for (const [pid, p] of this.byProject) {
      if (p === path) ids.add(pid);
    }
    return ids;
  }

  /**
   * Verilen prefix ile başlayan tüm path entry'lerini döndür.
   * "4/7/2" → "4/7/2", "4/7/2/3", "4/7/2/3/8" vb.
   */
  getByCoordPrefix(prefix: string): StructuralEntry[] {
    const result: StructuralEntry[] = [];
    for (const [path, entry] of this.byPath) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        result.push(entry);
      }
    }
    return result;
  }

  stats(): { totalPaths: number; routerPaths: number; leafPaths: number } {
    let routers = 0;
    for (const e of this.byPath.values()) {
      if (e.isRouter) routers++;
    }
    return {
      totalPaths:  this.byPath.size,
      routerPaths: routers,
      leafPaths:   this.byPath.size - routers,
    };
  }

  get lastUpdated(): Date { return this._lastUpdated; }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _upsertPath(path: string, projectId: ProjectID, _op: "upsert" | "remove"): void {
    let parsed: ReturnType<typeof parseCubePath>;
    try {
      parsed = parseCubePath(path);
    } catch {
      this.logger?.warn(`StructuralIndex: geçersiz path "${path}"`);
      return;
    }

    const existing = this.byPath.get(path);
    if (existing) {
      existing.projectCount++;
      existing.updatedAt = new Date();
    } else {
      const entry: StructuralEntry = {
        path,
        coord:        parsed.root,
        depth:        pathDepth(path),
        projectCount: 1,
        isRouter:     false,
        updatedAt:    new Date(),
      };
      this.byPath.set(path, entry);
    }

    this.byProject.set(projectId, path);
    this._lastUpdated = new Date();
  }

  private _markRouter(path: string, isRouter: boolean): void {
    const entry = this.byPath.get(path);
    if (entry) {
      entry.isRouter  = isRouter;
      entry.updatedAt = new Date();
      this._lastUpdated = new Date();
    }
  }

  private _handlePathChange(projectId: ProjectID, oldPath: string, newPath: string): void {
    // Eski path'ten çıkar
    const oldEntry = this.byPath.get(oldPath);
    if (oldEntry) {
      oldEntry.projectCount = Math.max(0, oldEntry.projectCount - 1);
      oldEntry.updatedAt = new Date();
    }
    this.byProject.delete(projectId);

    // Yeni path'e ekle
    this._upsertPath(newPath, projectId, "upsert");
    this.logger?.debug(`StructuralIndex: path güncellendi ${projectId} "${oldPath}" → "${newPath}"`);
  }
}
