/**
 * 1XX1 Cube Engine — Hücre Modeli
 * Aşama 02 — 1331 Cube Engine
 *
 * CubeCell yalnızca bir mantıksal indeks birimidir.
 * İçinde gerçek dosya veya büyük veri barındırmaz;
 * yalnızca ProjectID referansları tutar.
 * Bu tasarım sistemi ölçeklenebilir kılar:
 * veriler ileride ayrı depolama katmanına taşınabilir.
 */

import type { CubeCoordinate } from "../core/types.ts";
import type { CubeID, ProjectID } from "../core/identity.ts";
import { cubeIDFromCoord } from "../core/identity.ts";
import { coordToKey } from "../core/utils.ts";

export interface CubeCellData {
  id: CubeID;
  coord: CubeCoordinate;
  key: string;                // "x,y,z" — hızlı arama için
  projectIds: Set<ProjectID>; // referanslar, gerçek veri değil
  createdAt: Date;
  updatedAt: Date;
  /** Alt küplere bağlantı (Aşama 03'te aktif olacak) */
  subcubeId?: string;
}

export class CubeCell {
  readonly id: CubeID;
  readonly coord: CubeCoordinate;
  readonly key: string;
  private readonly projectIds: Set<ProjectID>;
  readonly createdAt: Date;
  private _updatedAt: Date;
  subcubeId?: string;

  constructor(coord: CubeCoordinate) {
    this.id         = cubeIDFromCoord(coord);
    this.coord      = { ...coord };          // immutable copy
    this.key        = coordToKey(coord);
    this.projectIds = new Set();
    this.createdAt  = new Date();
    this._updatedAt = new Date();
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Projeyi ekle. Zaten varsa false döner. */
  addProject(id: ProjectID): boolean {
    if (this.projectIds.has(id)) return false;
    this.projectIds.add(id);
    this._updatedAt = new Date();
    return true;
  }

  /** Projeyi kaldır. Yoksa false döner. */
  removeProject(id: ProjectID): boolean {
    const removed = this.projectIds.delete(id);
    if (removed) this._updatedAt = new Date();
    return removed;
  }

  /** ID listesinin salt okunur kopyası */
  getProjectIds(): ReadonlySet<ProjectID> {
    return this.projectIds;
  }

  /** Kaç proje referansı var */
  size(): number {
    return this.projectIds.size;
  }

  /** Belirli proje bu hücrede mi? */
  has(id: ProjectID): boolean {
    return this.projectIds.has(id);
  }

  /** Seri hale getirme (kaydetme/log amaçlı) */
  toJSON(): CubeCellData {
    return {
      id:         this.id,
      coord:      this.coord,
      key:        this.key,
      projectIds: new Set(this.projectIds),
      createdAt:  this.createdAt,
      updatedAt:  this._updatedAt,
      subcubeId:  this.subcubeId,
    };
  }
}
