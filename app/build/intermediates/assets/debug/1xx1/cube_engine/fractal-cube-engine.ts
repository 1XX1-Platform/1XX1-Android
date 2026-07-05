/**
 * 1XX1 FractalCubeEngine — Production-Grade Fraktal Motor
 * Aşama 03 Risk Giderme
 *
 * Risk 1: Adaptive split policy (SplitPolicy)
 * Risk 2: Immutable LogicalID + PathRegistry (event-driven invalidation)
 * Risk 3: Node-level mutex (NodeLockManager)
 * Risk 4: EventBus FIFO + idempotency (EventBus upgrade)
 * Risk 5: Bounded recursion + cycle detection (RecursionGuard)
 */

import type { ICubeEngine, QueryOptions, TraversalOrder, NodeVisitor } from "../core/interfaces.ts";
import type { Project, CubeCoordinate } from "../core/types.ts";
import type { IEventBus, ILogger } from "../core/interfaces.ts";
import type { ProjectID } from "../core/identity.ts";
import { coordToKey, isValidCoord, getNeighbors } from "../core/utils.ts";
import { Errors } from "../core/errors.ts";
import { FractalNode } from "./fractal-node.ts";
import { rootPath, parseCubePath } from "./cube-path.ts";
import { splitNode, mergeNode } from "./split-merge.ts";
import type { OverflowPayload } from "./split-merge.ts";
import { SplitPolicy, DEFAULT_SPLIT_POLICY } from "./split-policy.ts";
import type { SplitPolicyConfig } from "./split-policy.ts";
import { PathRegistry } from "./path-registry.ts";
import { NodeLockManager } from "./node-lock.ts";
import { boundedCollect } from "./recursion-guard.ts";

// ─── İstatistikler ────────────────────────────────────────────────────────────

export interface FractalStats {
  rootCells:        number;
  occupiedRoots:    number;
  totalNodes:       number;
  totalProjects:    number;
  maxDepthReached:  number;
  routerNodes:      number;
  leafNodes:        number;
  density:          number;
  activeLocks:      number;
  pathRegistrySize: number;
}

// ─── Engine Yapılandırması ────────────────────────────────────────────────────

export interface FractalEngineConfig {
  dimension:      number;
  mergeThreshold: number;
  splitPolicy?:   Partial<SplitPolicyConfig>;
  lockTimeoutMs?: number;
  maxCollectResults?: number;
}

// ─── FractalCubeEngine ───────────────────────────────────────────────────────

export class FractalCubeEngine implements ICubeEngine {
  private readonly roots        = new Map<string, FractalNode>();
  private readonly pathRegistry: PathRegistry;
  private readonly splitPolicy:  SplitPolicy;
  private readonly lockManager:  NodeLockManager;
  private readonly dimension:    number;
  private readonly mergeThreshold: number;
  private readonly maxCollectResults: number;

  constructor(
    cfg: FractalEngineConfig,
    eventBus?: IEventBus,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.dimension          = cfg.dimension;
    this.mergeThreshold     = cfg.mergeThreshold;
    this.maxCollectResults  = cfg.maxCollectResults ?? 10_000;

    // Risk 1: Adaptive split policy
    this.splitPolicy = new SplitPolicy(
      cfg.splitPolicy ?? DEFAULT_SPLIT_POLICY,
      eventBus,
      logger
    );

    // Risk 2: PathRegistry — immutable LogicalID + mutable path
    this.pathRegistry = new PathRegistry(eventBus, logger);

    // Risk 3: Node-level mutex
    this.lockManager = new NodeLockManager(logger, cfg.lockTimeoutMs ?? 5000);

    this.logger?.info(
      `FractalCubeEngine başlatıldı: dim=${cfg.dimension}, ` +
      `softLimit=${this.splitPolicy.config.softDepthLimit}, ` +
      `hardLimit=${this.splitPolicy.config.hardDepthLimit}, ` +
      `adaptive=${this.splitPolicy.config.adaptive}`
    );
  }

  // ─── ICubeEngine: validate ────────────────────────────────────────────────

  validate(coord: CubeCoordinate): boolean {
    return (
      isValidCoord(coord) &&
      coord.x < this.dimension &&
      coord.y < this.dimension &&
      coord.z < this.dimension
    );
  }

  // ─── ICubeEngine: index ───────────────────────────────────────────────────

  async index(project: Project, path?: string): Promise<void> {
    const targetPath = path ?? rootPath(project.cube);
    const parsed     = parseCubePath(targetPath);

    if (!this.validate(parsed.root)) {
      throw Errors.invalidCoordinate(parsed.root);
    }

    // Risk 3: Kilit al (FIFO)
    const release = await this.lockManager.acquire(targetPath);
    try {
      const existingPath = this.pathRegistry.getPath(project.id as ProjectID);
      if (existingPath && existingPath !== targetPath) {
        const oldRelease = await this.lockManager.acquire(existingPath);
        try {
          await this._removeFromPath(project.id as ProjectID, existingPath);
        } finally {
          oldRelease();
        }
      }

      const node = this._getOrCreateNode(targetPath);

      if (node.isRouter) {
        await this._indexIntoRouter(project, node);
        return;
      }

      node.addProject(project.id as ProjectID);

      // Risk 2: PathRegistry güncelle
      this.pathRegistry.register(project.id as ProjectID, targetPath);

      this.logger?.debug(`Proje eklendi: ${project.id} → ${targetPath}`);

      // Risk 1: Adaptif split kararı
      const policyDecision = this.splitPolicy.decide(
        node.depth,
        targetPath,
        node.projectCount()
      );

      if (node.projectCount() > policyDecision.allow
        ? (policyDecision as { allow: true; threshold: number }).threshold
        : Infinity
      ) {
        this.eventBus?.emit("cube:overflow", {
          path:      node.path,
          depth:     node.depth,
          count:     node.projectCount(),
          threshold: (policyDecision as { allow: true; threshold: number }).threshold,
        } satisfies OverflowPayload);

        if (policyDecision.allow) {
          await this._split(node);
        }
      }

      // Risk 4: idempotency key ile event
      this.eventBus?.emit(
        "cube:indexed",
        { path: targetPath, projectId: project.id },
        `idx:${project.id}:${targetPath}`
      );
    } finally {
      release();
    }
  }

  // ─── ICubeEngine: query ───────────────────────────────────────────────────

  async query(coord: CubeCoordinate, options: QueryOptions = {}): Promise<Project[]> {
    if (!this.validate(coord)) throw Errors.invalidCoordinate(coord);

    const { recursive = false, maxDepth: qDepth = 0 } = options;
    const key  = coordToKey(coord);
    const root = this.roots.get(key);
    if (!root) return [];

    let ids: ProjectID[];

    if (recursive) {
      // Risk 5: bounded collection
      const { ids: collected, truncated, maxDepthReached } = boundedCollect(root, {
        maxResults:   this.maxCollectResults,
        maxDepth:     qDepth,
        detectCycles: true,
        logger:       this.logger,
      });
      if (truncated) {
        this.logger?.warn(
          `Query sonuçları kırpıldı: ${coord.x},${coord.y},${coord.z} ` +
          `(maxResults=${this.maxCollectResults}, maxDepth=${maxDepthReached})`
        );
      }
      ids = collected;
    } else {
      ids = Array.from(root.getProjectIds());
    }

    return ids.map((id) => this._stubProject(id, coord));
  }

  // ─── ICubeEngine: neighbors ──────────────────────────────────────────────

  async neighbors(coord: CubeCoordinate, radius = 1): Promise<Map<string, Project[]>> {
    if (!this.validate(coord)) throw Errors.invalidCoordinate(coord);
    const result = new Map<string, Project[]>();
    for (const nc of getNeighbors(coord, radius)) {
      const key = coordToKey(nc);
      if (this.roots.has(key)) {
        const projects = await this.query(nc, { recursive: true });
        if (projects.length > 0) result.set(key, projects);
      }
    }
    return result;
  }

  // ─── ICubeEngine: occupiedCells ──────────────────────────────────────────

  async occupiedCells(): Promise<CubeCoordinate[]> {
    const result: CubeCoordinate[] = [];
    for (const root of this.roots.values()) {
      if (root.totalProjectCount() > 0) result.push({ ...root.coord });
    }
    return result;
  }

  // ─── ICubeEngine: stats ───────────────────────────────────────────────────

  async stats(): Promise<{ total: number; occupied: number; density: number }> {
    const s = this.fullStats();
    return { total: s.rootCells, occupied: s.occupiedRoots, density: s.density };
  }

  // ─── ICubeEngine: getNode ────────────────────────────────────────────────

  getNode(path: string): ReturnType<FractalNode["toNodeView"]> | undefined {
    return this._findNode(path)?.toNodeView();
  }

  // ─── ICubeEngine: traverse ───────────────────────────────────────────────

  traverse(visitor: NodeVisitor, order: TraversalOrder = "bfs"): void {
    if (order === "bfs") {
      const queue: Array<{ node: FractalNode; depth: number }> = [];
      for (const root of this.roots.values()) queue.push({ node: root, depth: 0 });
      let visited = 0;
      // Risk 5: traversal limit
      while (queue.length > 0 && visited < 100_000) {
        const { node, depth } = queue.shift()!;
        visited++;
        const prune = visitor(node.toNodeView(), depth);
        if (prune === false) continue;
        for (const child of node.getChildren().values()) {
          queue.push({ node: child, depth: depth + 1 });
        }
      }
    } else {
      for (const root of this.roots.values()) {
        this._dfs(root, visitor, 0, 100_000, { count: 0 });
      }
    }
  }

  // ─── Ek Public API ────────────────────────────────────────────────────────

  async remove(projectId: ProjectID): Promise<boolean> {
    const path = this.pathRegistry.getPath(projectId);
    if (!path) return false;
    const release = await this.lockManager.acquire(path);
    try {
      await this._removeFromPath(projectId, path);
      return true;
    } finally {
      release();
    }
  }

  async move(projectId: ProjectID, newPath: string): Promise<void> {
    const parsed = parseCubePath(newPath);
    if (!this.validate(parsed.root)) throw Errors.invalidCoordinate(parsed.root);

    const oldPath = this.pathRegistry.getPath(projectId);
    if (!oldPath) throw Errors.projectNotFound(projectId);

    // Risk 3: her iki path için kilit
    const [r1, r2] = await Promise.all([
      this.lockManager.acquire(oldPath),
      this.lockManager.acquire(newPath),
    ]);
    try {
      await this._removeFromPath(projectId, oldPath);
      const node = this._getOrCreateNode(newPath);
      if (node.isRouter) throw new Error(`Hedef router: ${newPath}`);
      node.addProject(projectId);

      // Risk 2: path değişimini kayıt altına al
      this.pathRegistry.changePath(projectId, newPath, "manual-move");

      const threshold = this.splitPolicy.effectiveThreshold(node.depth);
      if (node.projectCount() > threshold) await this._split(node);
    } finally {
      r1(); r2();
    }
  }

  pathOf(projectId: ProjectID): string | undefined {
    return this.pathRegistry.getPath(projectId);
  }

  getProjectIds(path: string): ReadonlySet<ProjectID> | undefined {
    return this._findNode(path)?.getProjectIds();
  }

  /** Stale kilitleri temizle (watchdog) */
  releaseStale(maxAgeMs = 30_000): number {
    return this.lockManager.releaseStale(maxAgeMs);
  }

  fullStats(): FractalStats {
    let occupiedRoots   = 0;
    let totalNodes      = 0;
    let totalProjects   = 0;
    let maxDepthReached = 0;
    let routerNodes     = 0;
    let leafNodes       = 0;

    this.traverse((node, depth) => {
      totalNodes++;
      if (depth > maxDepthReached) maxDepthReached = depth;
      if (node.isRouter) routerNodes++;
      else {
        leafNodes++;
        totalProjects += node.projectCount;
      }
    });

    for (const root of this.roots.values()) {
      if (root.totalProjectCount() > 0) occupiedRoots++;
    }

    const dim = this.dimension;
    const reg = this.pathRegistry.stats();

    return {
      rootCells:        dim * dim * dim,
      occupiedRoots,
      totalNodes,
      totalProjects,
      maxDepthReached,
      routerNodes,
      leafNodes,
      density:          occupiedRoots / (dim * dim * dim),
      activeLocks:      this.lockManager.activeLocks(),
      pathRegistrySize: reg.projects,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _getOrCreateNode(path: string): FractalNode {
    const parsed  = parseCubePath(path);
    const rootKey = coordToKey(parsed.root);

    if (!this.roots.has(rootKey)) {
      this.roots.set(rootKey, new FractalNode(rootPath(parsed.root), parsed.root, 0));
    }

    let current = this.roots.get(rootKey)!;
    for (const idx of parsed.childIndices) {
      const childCoord: CubeCoordinate = {
        x: (current.coord.x + idx) % this.dimension,
        y: current.coord.y,
        z: current.coord.z,
      };
      current = current.getOrCreateChild(idx, childCoord);
    }
    return current;
  }

  private _findNode(path: string): FractalNode | undefined {
    try {
      const parsed  = parseCubePath(path);
      const rootKey = coordToKey(parsed.root);
      let current   = this.roots.get(rootKey);
      if (!current) return undefined;
      for (const idx of parsed.childIndices) {
        current = current.getChild(idx);
        if (!current) return undefined;
      }
      return current;
    } catch { return undefined; }
  }

  private async _indexIntoRouter(project: Project, router: FractalNode): Promise<void> {
    const bucket     = parseInt(project.id.slice(-2), 36) % 8;
    const childCoord: CubeCoordinate = {
      x: (router.coord.x + bucket) % this.dimension,
      y: router.coord.y,
      z: router.coord.z,
    };
    const child = router.getOrCreateChild(bucket, childCoord);
    child.addProject(project.id as ProjectID);
    this.pathRegistry.register(project.id as ProjectID, child.path);

    const threshold = this.splitPolicy.effectiveThreshold(child.depth);
    if (child.projectCount() > threshold) await this._split(child);
  }

  private async _split(node: FractalNode): Promise<void> {
    const decision = this.splitPolicy.decide(node.depth, node.path, node.projectCount());
    if (!decision.allow) {
      this.logger?.warn(`Split engellendi: ${decision.reason}`);
      return;
    }

    const children = splitNode(node, {
      bucketCount: 8,
      eventBus:    this.eventBus,
      logger:      this.logger,
    });

    // Risk 2: PathRegistry toplu güncelle
    const changes = children.flatMap((c) =>
      Array.from(c.getProjectIds()).map((id) => ({ id, newPath: c.path }))
    );
    this.pathRegistry.bulkChangePath(changes, "split");
  }

  private async _removeFromPath(projectId: ProjectID, path: string): Promise<void> {
    const node = this._findNode(path);
    if (!node) return;
    node.removeProject(projectId);
    this.pathRegistry.unregister(projectId);

    if (this.mergeThreshold > 0 && node.depth > 0) {
      const segs      = path.split("/");
      const parentStr = segs.slice(0, -1).join("/");
      if (parentStr.split("/").length >= 3) {
        const parent = this._findNode(parentStr);
        if (parent?.isRouter) {
          const total = Array.from(parent.getChildren().values())
            .reduce((s, c) => s + c.projectCount(), 0);
          if (total < this.mergeThreshold) {
            const merged = mergeNode(parent, { eventBus: this.eventBus, logger: this.logger });
            if (merged) {
              // Risk 2: Merge sonrası indeks güncelle
              for (const pid of parent.getProjectIds()) {
                this.pathRegistry.changePath(pid, parent.path, "merge");
              }
            }
          }
        }
      }
    }
  }

  private _dfs(
    node: FractalNode,
    visitor: NodeVisitor,
    depth: number,
    limit: number,
    counter: { count: number }
  ): void {
    if (counter.count >= limit) return; // Risk 5
    counter.count++;
    const prune = visitor(node.toNodeView(), depth);
    if (prune === false) return;
    for (const child of node.getChildren().values()) {
      this._dfs(child, visitor, depth + 1, limit, counter);
    }
  }

  private _stubProject(id: ProjectID, coord: CubeCoordinate): Project {
    return {
      id, name: "", description: "", cube: coord,
      developer: "", repo: "", tags: [],
      license: "Unknown" as const, status: "active" as const,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
  }
}
