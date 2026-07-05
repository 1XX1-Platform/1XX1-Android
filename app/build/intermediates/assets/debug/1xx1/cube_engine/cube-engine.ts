/**
 * 1XX1 Cube Engine — Ana Implementasyon
 * Aşama 02 — 1331 Cube Engine
 *
 * ICubeEngine arayüzünün in-memory implementasyonu.
 *
 * Mimari karar:
 *   Küpler yalnızca mantıksal indeks birimidir.
 *   ProjectID referansları tutar, gerçek proje verisi tutmaz.
 *   Bu katman tamamen veritabanından bağımsızdır.
 *
 * Koordinat sistemi:
 *   x, y, z ∈ [0, dimension-1]   (varsayılan: 0–10)
 *   Toplam hücre: dimension³       (varsayılan: 11³ = 1331)
 */

import type { ICubeEngine } from "../core/interfaces.ts";
import type { Project, CubeCoordinate } from "../core/types.ts";
import type { IEventBus } from "../core/interfaces.ts";
import type { ILogger } from "../core/interfaces.ts";
import type { ProjectID, CubeID } from "../core/identity.ts";
import { cubeIDFromCoord } from "../core/identity.ts";
import { coordToKey, getNeighbors, isValidCoord } from "../core/utils.ts";
import { Errors } from "../core/errors.ts";
import { CubeCell } from "./cube-cell.ts";

// ─── Olay Yükleri ────────────────────────────────────────────────────────────

export interface CubeIndexedPayload {
  cubeId:    CubeID;
  coord:     CubeCoordinate;
  projectId: ProjectID;
  cellSize:  number;
}

export interface CubeUpdatedPayload {
  cubeId:    CubeID;
  coord:     CubeCoordinate;
  projectId: ProjectID;
  action:    "added" | "removed" | "moved";
}

export interface CubeRemovedPayload {
  cubeId:    CubeID;
  coord:     CubeCoordinate;
  projectId: ProjectID;
}

// ─── İstatistik Tipi ─────────────────────────────────────────────────────────

export interface CubeEngineStats {
  totalCells:       number;  // 1331
  occupiedCells:    number;  // proje olan hücre sayısı
  totalProjects:    number;  // toplam kayıtlı proje referansı
  density:          number;  // occupiedCells / totalCells (0–1)
  maxCellLoad:      number;  // en kalabalık hücredeki proje sayısı
  avgCellLoad:      number;  // dollu hücre başına ortalama proje
}

// ─── CubeEngine ──────────────────────────────────────────────────────────────

export class CubeEngine implements ICubeEngine {
  private readonly cells = new Map<string, CubeCell>(); // key → CubeCell
  private readonly projectIndex = new Map<ProjectID, CubeCoordinate>(); // proje → koordinat

  constructor(
    dimension: number,
    maxPerCell: number,
    eventBus?: IEventBus,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.maxPerCell = maxPerCell;
    this.dimension = dimension;
    this.initializeCells();
  }

  // ─── Başlangıç ───────────────────────────────────────────────────────────

  /**
   * Tüm 1331 hücreyi oluştur (boş olarak).
   * Bellek: 1331 CubeCell nesnesi — her biri ~100 byte → ~133 KB.
   * Büyük ölçekte lazy initialization tercih edilebilir (Aşama 07).
   */
  private initializeCells(): void {
    const max = this.dimension - 1;
    for (let x = 0; x <= max; x++) {
      for (let y = 0; y <= max; y++) {
        for (let z = 0; z <= max; z++) {
          const coord = { x, y, z };
          const key   = coordToKey(coord);
          this.cells.set(key, new CubeCell(coord));
        }
      }
    }
    this.logger?.info(
      `CubeEngine başlatıldı: ${this.cells.size} hücre (${this.dimension}³)`
    );
  }

  // ─── ICubeEngine implementasyonu ─────────────────────────────────────────

  validate(coord: CubeCoordinate): boolean {
    return (
      isValidCoord(coord) &&
      coord.x < this.dimension &&
      coord.y < this.dimension &&
      coord.z < this.dimension
    );
  }

  async index(project: Project): Promise<void> {
    if (!this.validate(project.cube)) {
      throw Errors.invalidCoordinate(project.cube);
    }

    const key  = coordToKey(project.cube);
    const cell = this.cells.get(key)!;

    if (cell.size() >= this.maxPerCell) {
      throw Errors.cubeFull(project.cube, this.maxPerCell);
    }

    // Proje başka bir hücredeyse önce oradan kaldır
    const existing = this.projectIndex.get(project.id as ProjectID);
    if (existing) {
      const oldKey  = coordToKey(existing);
      const oldCell = this.cells.get(oldKey);
      oldCell?.removeProject(project.id as ProjectID);
    }

    cell.addProject(project.id as ProjectID);
    this.projectIndex.set(project.id as ProjectID, { ...project.cube });

    const payload: CubeIndexedPayload = {
      cubeId:    cell.id,
      coord:     project.cube,
      projectId: project.id as ProjectID,
      cellSize:  cell.size(),
    };

    this.eventBus?.emit("cube:indexed", payload);
    this.logger?.debug(`Proje indekslendi: ${project.id} → (${key})`);
  }

  async query(coord: CubeCoordinate): Promise<Project[]> {
    if (!this.validate(coord)) {
      throw Errors.invalidCoordinate(coord);
    }
    // Bu katman yalnızca ID döndürür.
    // Gerçek proje nesneleri IProjectRepository'den alınır.
    // Burada placeholder dönüyoruz; gerçek entegrasyon Aşama 07'de.
    const cell = this.cells.get(coordToKey(coord));
    if (!cell) return [];

    // ID listesini Project şeklinde sarmala (ID'ler dolu, diğer alanlar boş)
    return Array.from(cell.getProjectIds()).map((id) => ({
      id,
      name: "",
      description: "",
      cube: coord,
      developer: "",
      repo: "",
      tags: [],
      license: "Unknown" as const,
      status: "active" as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
  }

  async neighbors(
    coord: CubeCoordinate,
    radius = 1
  ): Promise<Map<string, Project[]>> {
    if (!this.validate(coord)) {
      throw Errors.invalidCoordinate(coord);
    }

    const result = new Map<string, Project[]>();
    const neighborCoords = getNeighbors(coord, radius);

    for (const nc of neighborCoords) {
      const key  = coordToKey(nc);
      const cell = this.cells.get(key);
      if (cell && cell.size() > 0) {
        const projects = await this.query(nc);
        result.set(key, projects);
      }
    }

    return result;
  }

  async occupiedCells(): Promise<CubeCoordinate[]> {
    const result: CubeCoordinate[] = [];
    for (const cell of this.cells.values()) {
      if (cell.size() > 0) {
        result.push({ ...cell.coord });
      }
    }
    return result;
  }

  async stats(): Promise<{ total: number; occupied: number; density: number }> {
    const s = this.fullStats();
    return {
      total:    s.totalCells,
      occupied: s.occupiedCells,
      density:  s.density,
    };
  }

  // ─── Ek Metotlar (ICubeEngine'in ötesinde) ───────────────────────────────

  /** Projeyi indeksten kaldır */
  async remove(projectId: ProjectID): Promise<boolean> {
    const coord = this.projectIndex.get(projectId);
    if (!coord) return false;

    const key  = coordToKey(coord);
    const cell = this.cells.get(key);
    const removed = cell?.removeProject(projectId) ?? false;

    if (removed) {
      this.projectIndex.delete(projectId);
      const payload: CubeRemovedPayload = {
        cubeId:    cubeIDFromCoord(coord),
        coord,
        projectId,
      };
      this.eventBus?.emit("cube:indexed", payload); // güncelleme olarak
      this.logger?.debug(`Proje indeksten kaldırıldı: ${projectId}`);
    }

    return removed;
  }

  /** Projeyi başka bir koordinata taşı */
  async move(projectId: ProjectID, newCoord: CubeCoordinate): Promise<void> {
    if (!this.validate(newCoord)) {
      throw Errors.invalidCoordinate(newCoord);
    }

    const oldCoord = this.projectIndex.get(projectId);
    if (!oldCoord) {
      throw Errors.projectNotFound(projectId);
    }

    // Önce kaldır
    const oldCell = this.cells.get(coordToKey(oldCoord));
    oldCell?.removeProject(projectId);

    // Yeni hücreye ekle
    const newCell = this.cells.get(coordToKey(newCoord))!;
    if (newCell.size() >= this.maxPerCell) {
      // Rollback
      oldCell?.addProject(projectId);
      throw Errors.cubeFull(newCoord, this.maxPerCell);
    }

    newCell.addProject(projectId);
    this.projectIndex.set(projectId, { ...newCoord });

    const payload: CubeUpdatedPayload = {
      cubeId:    cubeIDFromCoord(newCoord),
      coord:     newCoord,
      projectId,
      action:    "moved",
    };
    this.eventBus?.emit("cube:indexed", payload);
    this.logger?.debug(
      `Proje taşındı: ${projectId} → (${coordToKey(newCoord)})`
    );
  }

  /** Belirli bir projenin koordinatını döndür */
  coordOf(projectId: ProjectID): CubeCoordinate | undefined {
    const coord = this.projectIndex.get(projectId);
    return coord ? { ...coord } : undefined;
  }

  /** Hücreyi doğrudan getir (test/debug amaçlı) */
  getCell(coord: CubeCoordinate): CubeCell | undefined {
    return this.cells.get(coordToKey(coord));
  }

  /** Detaylı istatistikler */
  fullStats(): CubeEngineStats {
    let occupied    = 0;
    let totalProj   = 0;
    let maxLoad     = 0;

    for (const cell of this.cells.values()) {
      const s = cell.size();
      if (s > 0) {
        occupied++;
        totalProj += s;
        if (s > maxLoad) maxLoad = s;
      }
    }

    return {
      totalCells:    this.cells.size,
      occupiedCells: occupied,
      totalProjects: totalProj,
      density:       occupied / this.cells.size,
      maxCellLoad:   maxLoad,
      avgCellLoad:   occupied > 0 ? totalProj / occupied : 0,
    };
  }

  /** Alt küp altyapısı — Aşama 03'te aktif edilecek */
  async createSubcube(_coord: CubeCoordinate): Promise<void> {
    throw Errors.notImplemented("createSubcube (Aşama 03'te gelecek)");
  }
}
