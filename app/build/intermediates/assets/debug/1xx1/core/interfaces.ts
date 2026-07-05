/**
 * 1XX1 Core Interfaces (Portlar)
 * Aşama 01 + Aşama 03 Güncelleme — Fraktal ICubeEngine
 */

import type {
  Project,
  Developer,
  CubeCoordinate,
  SearchQuery,
  SearchResult,
  PulseEntry,
  PulseSnapshot,
  SystemEvent,
  SystemEventType,
} from "./types.ts";

// ─── Depo Arayüzleri ─────────────────────────────────────────────────────────

export interface IProjectRepository {
  create(project: Omit<Project, "id" | "createdAt" | "updatedAt">): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  findByCube(coord: CubeCoordinate): Promise<Project[]>;
  findByDeveloper(developerId: string): Promise<Project[]>;
  update(id: string, patch: Partial<Project>): Promise<Project | null>;
  archive(id: string): Promise<boolean>;
  listAll(limit?: number, offset?: number): Promise<Project[]>;
  count(): Promise<number>;
}

export interface IDeveloperRepository {
  create(dev: Omit<Developer, "id" | "joinedAt">): Promise<Developer>;
  findById(id: string): Promise<Developer | null>;
  findByUsername(username: string): Promise<Developer | null>;
  update(id: string, patch: Partial<Developer>): Promise<Developer | null>;
  listAll(): Promise<Developer[]>;
}

// ─── Küp Motoru Arayüzü (Fraktal) ───────────────────────────────────────────

/**
 * ICubeEngine — Aşama 03 güncellendi.
 *
 * Tüm operasyonlar CubePath tabanlıdır.
 * Derinlik motora değil, sisteme ait bir karardır (Kural 1).
 */
export interface ICubeEngine {
  /** Koordinatın geçerli olup olmadığını doğrula */
  validate(coord: CubeCoordinate): boolean;

  /** Bir projeyi verilen path'e yerleştir (Kural 4) */
  index(project: Project, path?: string): Promise<void>;

  /** Verilen path'teki projeleri getir — recursive seçeneği ile alt küplere iner */
  query(coord: CubeCoordinate, options?: QueryOptions): Promise<Project[]>;

  /** Komşu küpleri getir */
  neighbors(coord: CubeCoordinate, radius?: number): Promise<Map<string, Project[]>>;

  /** Dolu koordinatları listele */
  occupiedCells(): Promise<CubeCoordinate[]>;

  /** Özet istatistikler */
  stats(): Promise<{ total: number; occupied: number; density: number }>;

  /** CubePath'ten düğüm bilgisini al */
  getNode(path: string): CubeTreeNode | undefined;

  /** Tüm ağacı gezin (BFS/DFS) */
  traverse(visitor: NodeVisitor, order?: TraversalOrder): void;
}

export interface QueryOptions {
  /** true ise tüm alt küplere özyinelemeli iner */
  recursive?: boolean;
  /** Maksimum derinlik (0 = sınırsız) */
  maxDepth?: number;
}

export type TraversalOrder = "bfs" | "dfs";

export type NodeVisitor = (node: CubeTreeNode, depth: number) => boolean | void;

/** Küp ağacındaki bir düğümün görünümü (okuma amaçlı) */
export interface CubeTreeNode {
  path: string;
  coord: CubeCoordinate;
  depth: number;
  projectCount: number;
  childCount: number;
  isLeaf: boolean;
  isRouter: boolean; // bölündükten sonra yalnızca yönlendirme yapıyor
}

// ─── Arama Motoru Arayüzü ─────────────────────────────────────────────────────

export interface ISearchEngine {
  resolve(term: string): Promise<string[]>;
  search(query: SearchQuery): Promise<SearchResult>;
  index(project: Project): Promise<void>;
  deindex(projectId: string): Promise<void>;
}

// ─── Nabız Motoru Arayüzü ────────────────────────────────────────────────────

export interface IPulseEngine {
  start(intervalMs?: number): void;
  stop(): void;
  snapshot(): PulseSnapshot;
  touch(projectId: string): void;
  isRunning(): boolean;
}

// ─── Olay Veriyolu ───────────────────────────────────────────────────────────

export type EventHandler<T = unknown> = (event: SystemEvent<T>) => void | Promise<void>;

export interface IEventBus {
  emit<T>(type: SystemEventType, payload: T): void;
  on<T>(type: SystemEventType, handler: EventHandler<T>): void;
  off(type: SystemEventType, handler: EventHandler): void;
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}
