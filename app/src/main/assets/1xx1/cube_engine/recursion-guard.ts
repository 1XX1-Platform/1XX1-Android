/**
 * 1XX1 Sınırlı Özyineleme Koruması
 * Aşama 03 Risk Giderme — Risk 5
 *
 * Problem:
 *   - Fraktal traversal ve recursive query teorik olarak sınırsız derinlik.
 *   - Split/merge bug'larında döngüsel referans oluşabilir (A→B→A).
 *   - Stack overflow ve sonsuz döngü riski.
 *
 * Çözüm:
 *   1. RecursionGuard: her özyinelemeli çağrı derinliğini izler,
 *      sınır aşılınca RecursionLimitError fırlatır.
 *   2. CycleDetector: ziyaret edilen path'leri takip eder,
 *      aynı path ikinci kez görülünce CycleError fırlatır.
 *   3. BoundedCollector: recursive ID toplama için güvenli wrapper.
 */

import type { ILogger } from "../core/interfaces.ts";
import type { ProjectID } from "../core/identity.ts";
import { FractalNode } from "./fractal-node.ts";

// ─── Özel Hata Tipleri ───────────────────────────────────────────────────────

export class RecursionLimitError extends Error {
  constructor(
    depth: number,
    limit: number,
    path: string
  ) {
    this.depth = depth;
    this.path = path;
    this.limit = limit;
    super(`Özyineleme sınırı aşıldı: derinlik ${depth} > limit ${limit} (path: ${path})`);
    this.name = "RecursionLimitError";
  }
}

export class CycleDetectedError extends Error {
  constructor(path: string, visitedPaths: string[]) {
    this.visitedPaths = visitedPaths;
    this.path = path;
    super(`Döngüsel referans tespit edildi: ${path} (ziyaret geçmişi: ${visitedPaths.join(" → ")})`);
    this.name = "CycleDetectedError";
  }
}

// ─── Özyineleme Koruması ─────────────────────────────────────────────────────

export class RecursionGuard {
  private depth = 0;

  constructor(
    limit: number,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.limit = limit;}

  /** Özyinelemeli çağrı öncesi çağır */
  enter(path: string): void {
    this.depth++;
    if (this.depth > this.limit) {
      const err = new RecursionLimitError(this.depth, this.limit, path);
      this.logger?.warn(err.message);
      this.depth = 0; // sıfırla, bir sonraki çağrı çalışsın
      throw err;
    }
  }

  /** Özyinelemeli çağrı sonrası çağır */
  exit(): void {
    if (this.depth > 0) this.depth--;
  }

  /** Güvenli özyinelemeli çağrı wrapper */
  wrap<T>(path: string, fn: () => T): T {
    this.enter(path);
    try {
      return fn();
    } finally {
      this.exit();
    }
  }

  currentDepth(): number {
    return this.depth;
  }
}

// ─── Döngü Dedektörü ─────────────────────────────────────────────────────────

export class CycleDetector {
  private readonly visited: string[] = [];

  /** Path'i ziyaret et — daha önce görüldüyse hata */
  visit(path: string): void {
    if (this.visited.includes(path)) {
      throw new CycleDetectedError(path, [...this.visited]);
    }
    this.visited.push(path);
  }

  /** Geri dön (DFS'de kullanılır) */
  unvisit(path: string): void {
    const idx = this.visited.lastIndexOf(path);
    if (idx !== -1) this.visited.splice(idx, 1);
  }

  reset(): void {
    this.visited.length = 0;
  }

  getVisited(): Readonly<string[]> {
    return this.visited;
  }
}

// ─── Güvenli Recursive Toplayıcı ─────────────────────────────────────────────

export interface BoundedCollectOptions {
  /** Maksimum toplam sonuç sayısı */
  maxResults?: number;
  /** Maksimum özyineleme derinliği (0 = sınırsız, politika yönetir) */
  maxDepth?: number;
  /** Döngü tespiti aktif mi? */
  detectCycles?: boolean;
  logger?: ILogger;
}

/**
 * FractalNode ağacından proje ID'lerini güvenli şekilde toplar.
 *
 * Korumaları:
 *   - maxResults: sonuç listesi bu sayıya ulaşınca durur
 *   - maxDepth: bu derinlikten fazla inmez
 *   - detectCycles: döngüsel referansları tespit eder
 *   - RecursionGuard: stack overflow'u engeller
 */
export function boundedCollect(
  root: FractalNode,
  options: BoundedCollectOptions = {}
): { ids: ProjectID[]; truncated: boolean; maxDepthReached: number } {
  const {
    maxResults   = 10_000,
    maxDepth     = 0,
    detectCycles = true,
    logger,
  } = options;

  const guard   = new RecursionGuard(maxDepth > 0 ? maxDepth + 1 : 10_000, logger);
  const cycle   = detectCycles ? new CycleDetector() : null;
  const results: ProjectID[] = [];
  let truncated      = false;
  let maxDepthReached = 0;

  function collect(node: FractalNode, depth: number): void {
    if (truncated) return;
    if (maxDepth > 0 && depth > maxDepth) return;
    if (depth > maxDepthReached) maxDepthReached = depth;

    try {
      guard.enter(node.path);
      cycle?.visit(node.path);
    } catch (err) {
      if (err instanceof RecursionLimitError || err instanceof CycleDetectedError) {
        logger?.warn(err.message);
        truncated = true;
        return;
      }
      throw err;
    }

    try {
      // Leaf ise projeleri topla
      if (node.isLeaf) {
        for (const id of node.getProjectIds()) {
          if (results.length >= maxResults) {
            truncated = true;
            return;
          }
          results.push(id);
        }
      }

      // Çocuklara in
      for (const child of node.getChildren().values()) {
        if (truncated) break;
        collect(child, depth + 1);
      }
    } finally {
      guard.exit();
      cycle?.unvisit(node.path);
    }
  }

  collect(root, 0);

  return { ids: results, truncated, maxDepthReached };
}
