/**
 * 1XX1 Dependency Graph — Yönlü Döngüsüz Graf (DAG)
 * Aşama 11 — Asset Bank
 *
 * Bir Asset başka Asset'lere bağımlı olabilir.
 * Örnek: Scene → Mesh → Texture → Shader
 *
 * Kural: Döngüsel bağımlılık kabul edilmez.
 * DFS ile döngü tespiti: O(V + E) — tüm grafı dolaşır.
 *
 * Bağımlılık türleri:
 *   "uses"    → A, B'yi kullanıyor (gevşek bağ)
 *   "extends" → A, B'yi genişletiyor (güçlü bağ)
 *   "bundles" → A, B'yi paket içine alıyor
 */

import type { AssetDependency } from "../entities/asset.entity.ts";

// ─── Graf Sonuçları ───────────────────────────────────────────────────────────

export interface DependencyCheckResult {
  ok:     boolean;
  reason?: string;
  cycle?: string[];   // döngü varsa path
}

export interface DependencyPath {
  path:    string[];
  types:   Array<AssetDependency["type"]>;
  depth:   number;
}

// ─── DependencyGraph ─────────────────────────────────────────────────────────

export class DependencyGraph {
  /** source → Set<target> (yönlü kenarlar) */
  private readonly edges = new Map<string, Set<string>>();
  /** source → target → type */
  private readonly edgeTypes = new Map<string, Map<string, AssetDependency["type"]>>();

  // ─── Kenar Ekleme ────────────────────────────────────────────────────────

  /**
   * Bağımlılık ekle.
   * Döngü oluşturuyorsa reddedilir.
   */
  addDependency(dep: AssetDependency): DependencyCheckResult {
    const { sourceId, targetId, type } = dep;

    if (sourceId === targetId) {
      return { ok: false, reason: "Kendine bağımlılık tanımlanamaz" };
    }

    // Döngü kontrolü: targetId'den sourceId'ye yol var mı?
    const cycle = this._findPath(targetId, sourceId);
    if (cycle) {
      return {
        ok: false,
        reason: `Döngüsel bağımlılık: ${[...cycle, sourceId].join(" → ")}`,
        cycle:  [...cycle, sourceId],
      };
    }

    // Kenarı ekle
    if (!this.edges.has(sourceId)) this.edges.set(sourceId, new Set());
    this.edges.get(sourceId)!.add(targetId);

    if (!this.edgeTypes.has(sourceId)) this.edgeTypes.set(sourceId, new Map());
    this.edgeTypes.get(sourceId)!.set(targetId, type);

    return { ok: true };
  }

  removeDependency(sourceId: string, targetId: string): boolean {
    const removed = this.edges.get(sourceId)?.delete(targetId) ?? false;
    this.edgeTypes.get(sourceId)?.delete(targetId);
    if (this.edges.get(sourceId)?.size === 0) this.edges.delete(sourceId);
    return removed;
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  /** Doğrudan bağımlılıklar (source → targets) */
  directDependencies(assetId: string): string[] {
    return Array.from(this.edges.get(assetId) ?? []);
  }

  /** Doğrudan bağımlılar (bu asset'i kullananlar) */
  directDependents(assetId: string): string[] {
    const result: string[] = [];
    for (const [src, targets] of this.edges) {
      if (targets.has(assetId)) result.push(src);
    }
    return result;
  }

  /** Tüm geçişli bağımlılıklar (DFS) */
  allDependencies(assetId: string): Set<string> {
    const visited = new Set<string>();
    const stack   = [assetId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dep of (this.edges.get(current) ?? [])) {
        if (!visited.has(dep)) {
          visited.add(dep);
          stack.push(dep);
        }
      }
    }
    return visited;
  }

  /** A'dan B'ye tam yol (BFS — en kısa) */
  findPath(from: string, to: string): DependencyPath | null {
    const path = this._findPath(from, to);
    if (!path) return null;
    const types = path.slice(0, -1).map((node, i) =>
      this.edgeTypes.get(node)?.get(path[i + 1]) ?? "uses"
    );
    return { path, types, depth: path.length - 1 };
  }

  /** Kenar tipi */
  edgeType(source: string, target: string): AssetDependency["type"] | undefined {
    return this.edgeTypes.get(source)?.get(target);
  }

  /** Graf istatistikleri */
  stats(): { nodes: number; edges: number; maxDepth: number } {
    const nodes   = new Set<string>();
    let   edges   = 0;
    let   maxD    = 0;

    for (const [src, targets] of this.edges) {
      nodes.add(src);
      for (const t of targets) { nodes.add(t); edges++; }
    }

    for (const node of nodes) {
      const d = this.allDependencies(node).size;
      if (d > maxD) maxD = d;
    }

    return { nodes: nodes.size, edges, maxDepth: maxD };
  }

  // ─── Private: BFS Yol Bul ────────────────────────────────────────────────

  private _findPath(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      for (const neighbor of (this.edges.get(id) ?? [])) {
        const newPath = [...path, neighbor];
        if (neighbor === to) return newPath;
        queue.push({ id: neighbor, path: newPath });
      }
    }
    return null;
  }
}
