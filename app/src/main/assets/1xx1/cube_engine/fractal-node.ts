/**
 * 1XX1 FractalNode — Fraktal Ağaç Düğümü
 * Aşama 03 — Fraktal Alt Küpler
 *
 * Kural 2: Lazy Subcube — alt küpler yalnızca gerektiğinde oluşturulur.
 * Kural 3: Tree yapısı — parent-child ilişkisi.
 * Kural 5: Bölünme atomik, parent routing node olur.
 *
 * Her FractalNode ya LEAF (yaprak) ya da ROUTER (yönlendirici) dur.
 * LEAF: proje referanslarını tutar.
 * ROUTER: yalnızca çocuklarını gösterir, kendi proje listesi boştur.
 */

import type { CubeCoordinate } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";
import type { CubePath } from "./cube-path.ts";
import { childPath } from "./cube-path.ts";

// ─── Düğüm Tipi ──────────────────────────────────────────────────────────────

export type NodeRole = "leaf" | "router";

// ─── FractalNode ─────────────────────────────────────────────────────────────

export class FractalNode {
  readonly path: CubePath;
  readonly coord: CubeCoordinate;
  readonly depth: number;

  private _role: NodeRole = "leaf";
  private readonly _projectIds = new Set<ProjectID>();
  /** Çocuklar: childIndex → FractalNode (Kural 2: lazy, sadece var olanlar) */
  private readonly _children = new Map<number, FractalNode>();

  private _createdAt = new Date();
  private _updatedAt = new Date();

  constructor(path: CubePath, coord: CubeCoordinate, depth: number) {
    this.path  = path;
    this.coord = { ...coord };
    this.depth = depth;
  }

  // ─── Rol ─────────────────────────────────────────────────────────────────

  get role(): NodeRole { return this._role; }
  get isLeaf(): boolean { return this._role === "leaf"; }
  get isRouter(): boolean { return this._role === "router"; }

  /** Leaf → Router'a geç (bölünme sonrası, Kural 5) */
  promoteToRouter(): void {
    this._role = "leaf" === this._role ? "router" : this._role;
    this._updatedAt = new Date();
  }

  // ─── Proje Yönetimi (yalnızca LEAF'lerde) ────────────────────────────────

  addProject(id: ProjectID): boolean {
    if (this._role === "router") {
      throw new Error(`Router düğümüne proje eklenemez: ${this.path}`);
    }
    if (this._projectIds.has(id)) return false;
    this._projectIds.add(id);
    this._updatedAt = new Date();
    return true;
  }

  removeProject(id: ProjectID): boolean {
    const removed = this._projectIds.delete(id);
    if (removed) this._updatedAt = new Date();
    return removed;
  }

  hasProject(id: ProjectID): boolean {
    return this._projectIds.has(id);
  }

  getProjectIds(): ReadonlySet<ProjectID> {
    return this._projectIds;
  }

  projectCount(): number {
    return this._projectIds.size;
  }

  /** Tüm proje ID'lerini array olarak al (bölünme için) */
  drainProjects(): ProjectID[] {
    const ids = Array.from(this._projectIds);
    this._projectIds.clear();
    this._updatedAt = new Date();
    return ids;
  }

  // ─── Çocuk Yönetimi ──────────────────────────────────────────────────────

  /**
   * Lazy: çocuk yoksa oluştur, varsa döndür (Kural 2).
   * childIndex: alt küpü numaralandırır (0, 1, 2, ...)
   */
  getOrCreateChild(childIndex: number, childCoord: CubeCoordinate): FractalNode {
    if (!this._children.has(childIndex)) {
      const cp = childPath(this.path, childIndex);
      const child = new FractalNode(cp, childCoord, this.depth + 1);
      this._children.set(childIndex, child);
      this._updatedAt = new Date();
    }
    return this._children.get(childIndex)!;
  }

  getChild(childIndex: number): FractalNode | undefined {
    return this._children.get(childIndex);
  }

  hasChild(childIndex: number): boolean {
    return this._children.has(childIndex);
  }

  removeChild(childIndex: number): boolean {
    const removed = this._children.delete(childIndex);
    if (removed) this._updatedAt = new Date();
    return removed;
  }

  getChildren(): ReadonlyMap<number, FractalNode> {
    return this._children;
  }

  childCount(): number {
    return this._children.size;
  }

  /** Yaprak mı ve boş mu? */
  isEmpty(): boolean {
    return this._role === "leaf" && this._projectIds.size === 0;
  }

  // ─── Toplam proje sayısı (recursive) ─────────────────────────────────────

  totalProjectCount(): number {
    if (this._role === "leaf") return this._projectIds.size;
    let total = 0;
    for (const child of this._children.values()) {
      total += child.totalProjectCount();
    }
    return total;
  }

  // ─── Meta ─────────────────────────────────────────────────────────────────

  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  /** ICubeTreeNode görünümü */
  toNodeView() {
    return {
      path:         this.path,
      coord:        this.coord,
      depth:        this.depth,
      projectCount: this._projectIds.size,
      childCount:   this._children.size,
      isLeaf:       this.isLeaf,
      isRouter:     this.isRouter,
    };
  }
}
