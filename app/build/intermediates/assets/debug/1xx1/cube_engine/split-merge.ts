/**
 * 1XX1 Bölünme ve Birleştirme Algoritmaları
 * Aşama 03 — Fraktal Alt Küpler
 *
 * Kural 5: Bölünme atomik — veri kaybı yok.
 * Kural 8: O(1)/O(log n) — tüm sistemi dolaşmıyor.
 *
 * SPLIT:
 *   1. Küpün proje listesini al
 *   2. Her projeyi yeni alt küplere dağıt (hash tabanlı)
 *   3. Parent'ı ROUTER'a yükselt
 *   4. Olay yayınla
 *
 * MERGE:
 *   1. Tüm çocukların projelerini topla
 *   2. Parent'ı LEAF'e döndür, projeleri ekle
 *   3. Çocukları sil
 *   4. Olay yayınla
 */

import type { IEventBus } from "../core/interfaces.ts";
import type { ILogger } from "../core/interfaces.ts";
import type { CubeCoordinate } from "../core/types.ts";
import type { ProjectID } from "../core/identity.ts";
import { FractalNode } from "./fractal-node.ts";
import { rootPath } from "./cube-path.ts";

// ─── Olay Yükleri ────────────────────────────────────────────────────────────

export interface SplitPayload {
  path: string;
  depth: number;
  projectsMoved: number;
  childrenCreated: number;
}

export interface MergePayload {
  path: string;
  depth: number;
  projectsAbsorbed: number;
  childrenRemoved: number;
}

export interface OverflowPayload {
  path: string;
  depth: number;
  count: number;
  threshold: number;
}

export interface SubcubeCreatedPayload {
  parentPath: string;
  childPath: string;
  childIndex: number;
  depth: number;
}

export interface SubcubeRemovedPayload {
  parentPath: string;
  childPath: string;
  depth: number;
}

// ─── Dağıtım Stratejisi ───────────────────────────────────────────────────────

/**
 * Bir ProjectID'yi kaç alt küpten birine eşler.
 * ProjectID string'inin karakter kodları toplamı mod bucketCount.
 * O(len(id)) — sabit küçük: ~15 karakter → pratik O(1).
 */
export function hashProjectToBucket(id: ProjectID, bucketCount: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0; // unsigned 32-bit
  }
  return hash % bucketCount;
}

// ─── Split Algoritması ────────────────────────────────────────────────────────

export interface SplitOptions {
  /** Alt küp sayısı (varsayılan: 8 — oktagruplu bölünme) */
  bucketCount?: number;
  /** Her alt küpe atanacak koordinat üretici */
  coordFactory?: (index: number, parent: CubeCoordinate) => CubeCoordinate;
  eventBus?: IEventBus;
  logger?: ILogger;
  maxDepth?: number; // 0 = sınırsız
}

/**
 * Verilen node'u alt küplere böler.
 * Atomik: hata olursa node değişmez.
 *
 * @returns Oluşturulan çocuk düğümler
 */
export function splitNode(node: FractalNode, options: SplitOptions = {}): FractalNode[] {
  const { bucketCount = 8, eventBus, logger, maxDepth = 0 } = options;

  // Derinlik sınırı kontrolü (0 = sınırsız, Kural 1)
  if (maxDepth > 0 && node.depth >= maxDepth) {
    logger?.warn(`Bölünme engellendi — maxDepth aşıldı: ${node.path} (depth=${node.depth})`);
    return [];
  }

  if (node.isRouter) {
    logger?.debug(`Zaten router, bölünme atlandı: ${node.path}`);
    return Array.from(node.getChildren().values());
  }

  // Snapshot — atomik garantisi için önce oku
  const projectIds = Array.from(node.getProjectIds());

  if (projectIds.length === 0) {
    return []; // boş düğüm bölünmez
  }

  const coordFn = options.coordFactory ?? defaultCoordFactory;

  // ── Çocukları oluştur (lazy: yalnızca proje düşen bucket'lar) ──
  const bucketMap = new Map<number, ProjectID[]>();
  for (const pid of projectIds) {
    const bucket = hashProjectToBucket(pid, bucketCount);
    if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
    bucketMap.get(bucket)!.push(pid);
  }

  // ── Atama başarılı — şimdi state'i değiştir (atomik bölüm) ──
  const createdChildren: FractalNode[] = [];

  try {
    // Projeleri çek (node artık boş leaf)
    node.drainProjects();

    for (const [bucketIdx, pids] of bucketMap) {
      const childCoord = coordFn(bucketIdx, node.coord);
      const child = node.getOrCreateChild(bucketIdx, childCoord);

      for (const pid of pids) {
        child.addProject(pid);
      }
      createdChildren.push(child);

      eventBus?.emit("cube:subcube-created", {
        parentPath: node.path,
        childPath: child.path,
        childIndex: bucketIdx,
        depth: child.depth,
      } satisfies SubcubeCreatedPayload);
    }

    // Parent'ı ROUTER'a yükselt
    node.promoteToRouter();

    eventBus?.emit("cube:split", {
      path: node.path,
      depth: node.depth,
      projectsMoved: projectIds.length,
      childrenCreated: createdChildren.length,
    } satisfies SplitPayload);

    logger?.info(
      `Küp bölündü: ${node.path} → ${createdChildren.length} alt küp (${projectIds.length} proje)`
    );
  } catch (err) {
    // Rollback: projeleri geri ekle
    logger?.error(`Split rollback: ${node.path}`, err instanceof Error ? err : new Error(String(err)));
    for (const pid of projectIds) {
      node.addProject(pid);
    }
    // Oluşturulan çocukları temizle
    for (const child of createdChildren) {
      const idx = Array.from(node.getChildren().entries()).find(([, c]) => c === child)?.[0];
      if (idx !== undefined) node.removeChild(idx);
    }
    throw err;
  }

  return createdChildren;
}

// ─── Merge Algoritması ────────────────────────────────────────────────────────

export interface MergeOptions {
  eventBus?: IEventBus;
  logger?: ILogger;
}

/**
 * Router node'un tüm çocuklarını geri birleştirir.
 * Yalnızca tüm çocuklar LEAF ise merge gerçekleşir.
 * Atomik garantisi: hata olursa state değişmez.
 */
export function mergeNode(node: FractalNode, options: MergeOptions = {}): boolean {
  const { eventBus, logger } = options;

  if (node.isLeaf) {
    logger?.debug(`Merge atlandı — zaten leaf: ${node.path}`);
    return false;
  }

  // Yalnızca yaprak çocukları merge edebiliriz
  for (const child of node.getChildren().values()) {
    if (child.isRouter) {
      logger?.debug(`Merge engelendi — router çocuk var: ${child.path}`);
      return false;
    }
  }

  // Tüm proje ID'lerini topla
  const allProjectIds: ProjectID[] = [];
  for (const child of node.getChildren().values()) {
    allProjectIds.push(...Array.from(child.getProjectIds()));
  }

  // Atomik bölüm
  const childEntries = Array.from(node.getChildren().entries());
  const childCount = childEntries.length;

  try {
    // Çocukları kaldır
    for (const [idx] of childEntries) {
      const child = node.getChild(idx)!;
      eventBus?.emit("cube:subcube-removed", {
        parentPath: node.path,
        childPath: child.path,
        depth: child.depth,
      } satisfies SubcubeRemovedPayload);
      node.removeChild(idx);
    }

    // Parent'ı LEAF'e dönüştür ve projeleri ekle
    // Not: FractalNode'da leaf'e geri dönme private — doğrudan erişim gerekiyor.
    // Çözüm: aşağıdaki internal API (sadece bu modülde kullanılır)
    _forceLeaf(node, allProjectIds);

    eventBus?.emit("cube:merge", {
      path: node.path,
      depth: node.depth,
      projectsAbsorbed: allProjectIds.length,
      childrenRemoved: childCount,
    } satisfies MergePayload);

    logger?.info(
      `Küpler birleştirildi: ${node.path} ← ${childCount} alt küp (${allProjectIds.length} proje)`
    );
    return true;
  } catch (err) {
    logger?.error(`Merge rollback: ${node.path}`, err instanceof Error ? err : new Error(String(err)));
    // Rollback — çocukları yeniden oluştur
    for (const [idx, child] of childEntries) {
      node.getOrCreateChild(idx, child.coord);
      // Projeleri geri ekle
      for (const pid of child.getProjectIds()) {
        node.getChild(idx)?.addProject(pid);
      }
    }
    throw err;
  }
}

// ─── Internal: LEAF zorlama ───────────────────────────────────────────────────

/**
 * FractalNode'u LEAF'e zorla ve projeleri ekle.
 * Bu fonksiyon yalnızca bu modül tarafından kullanılır.
 * Reflection yerine type assertion kullanır.
 */
function _forceLeaf(node: FractalNode, projectIds: ProjectID[]): void {
  // FractalNode'un private _role ve _projectIds alanlarına erişim
  // TypeScript'te bunu yapmak için any cast gereklidir.
  // Alternatif: FractalNode'a package-internal bir reset() metodu eklemek.
  const n = node as unknown as {
    _role: string;
    _projectIds: Set<ProjectID>;
  };
  n._role = "leaf";
  for (const pid of projectIds) {
    n._projectIds.add(pid);
  }
}

// ─── Varsayılan Koordinat Fabrikası ──────────────────────────────────────────

/**
 * Alt küp koordinatı üretir.
 * Index 0–7 için 3-bit oktagrup (x+dx, y+dy, z+dz):
 *   bit 0 → x, bit 1 → y, bit 2 → z
 * Bu, üst küpün koordinatına göre alt küpü konumlandırır.
 * Fraktal görselleştirme için tutarlı düzen sağlar.
 */
function defaultCoordFactory(index: number, parent: CubeCoordinate): CubeCoordinate {
  // index mod 8 → 3 boyutlu offset (0 veya 1)
  const i  = index % 8;
  const dx = (i & 1) ? 1 : 0;
  const dy = (i & 2) ? 1 : 0;
  const dz = (i & 4) ? 1 : 0;
  // Alt küp koordinatı parent'a bağlı ama bağımsız uzayda
  return {
    x: (parent.x * 2 + dx) % 11,
    y: (parent.y * 2 + dy) % 11,
    z: (parent.z * 2 + dz) % 11,
  };
}
