/**
 * 1XX1 Katman 3: Reverse Index
 * Aşama 04 — Veri İndeksleme
 *
 * Metadata tabanlı ters indeks.
 * Anahtarlar:
 *   "dev:{developerId}"   → o geliştiricinin projeleri
 *   "lic:{LicenseType}"  → o lisanstaki projeler
 *   "tag:{tagName}"       → o etiketteki projeler
 *   "status:{status}"     → o durumdaki projeler
 *
 * O(1) lookup her anahtar için.
 * Arama motoru (Aşama 05) bu indeksi filtre katmanı olarak kullanır.
 */

import type { ProjectID, DeveloperID } from "../core/identity.ts";
import type { Project, LicenseType, ProjectStatus } from "../core/types.ts";
import type { ILogger } from "../core/interfaces.ts";
import type { ReverseIndexKey } from "./index-types.ts";

export class ReverseIndex {
  /** key → Set<ProjectID> */
  private readonly index = new Map<string, Set<ProjectID>>();
  /** ProjectID → Set<key> (temizleme için) */
  private readonly projectKeys = new Map<ProjectID, Set<string>>();

  private _lastUpdated = new Date();

  constructor(logger?: ILogger) {
    this.logger = logger;}

  // ─── Güncelleme ───────────────────────────────────────────────────────────

  upsert(project: Project): void {
    this.remove(project.id as ProjectID);

    const keys: string[] = [
      `dev:${project.developer}`,
      `lic:${project.license}`,
      `status:${project.status}`,
      ...project.tags.map((t) => `tag:${t.toLowerCase().trim()}`),
    ];

    for (const key of keys) {
      this._addEntry(key, project.id as ProjectID);
    }

    this.projectKeys.set(project.id as ProjectID, new Set(keys));
    this._lastUpdated = new Date();

    this.logger?.debug(
      `ReverseIndex upsert: ${project.id} → ${keys.length} anahtar`
    );
  }

  remove(projectId: ProjectID): void {
    const keys = this.projectKeys.get(projectId);
    if (!keys) return;

    for (const key of keys) {
      const set = this.index.get(key);
      if (set) {
        set.delete(projectId);
        if (set.size === 0) this.index.delete(key);
      }
    }
    this.projectKeys.delete(projectId);
    this._lastUpdated = new Date();
  }

  // ─── Sorgular ─────────────────────────────────────────────────────────────

  getByDeveloper(developerId: string): ReadonlySet<ProjectID> {
    return this.index.get(`dev:${developerId}`) ?? new Set();
  }

  getByLicense(license: LicenseType): ReadonlySet<ProjectID> {
    return this.index.get(`lic:${license}`) ?? new Set();
  }

  getByTag(tag: string): ReadonlySet<ProjectID> {
    return this.index.get(`tag:${tag.toLowerCase().trim()}`) ?? new Set();
  }

  getByStatus(status: ProjectStatus): ReadonlySet<ProjectID> {
    return this.index.get(`status:${status}`) ?? new Set();
  }

  /** Ham anahtar ile sorgula */
  getByKey(key: string): ReadonlySet<ProjectID> {
    return this.index.get(key) ?? new Set();
  }

  /**
   * Birden fazla anahtarın kesişimini döndür (AND filtresi).
   * Örn: getIntersection(["tag:STL", "lic:MIT"]) → her ikisini de taşıyan projeler
   */
  getIntersection(keys: string[]): Set<ProjectID> {
    if (keys.length === 0) return new Set();

    const sets = keys
      .map((k) => this.index.get(k))
      .filter((s): s is Set<ProjectID> => s !== undefined && s.size > 0);

    if (sets.length === 0) return new Set();

    // En küçük setten başla (optimizasyon)
    const sorted = sets.sort((a, b) => a.size - b.size);
    const result = new Set(sorted[0]);

    for (let i = 1; i < sorted.length; i++) {
      for (const id of result) {
        if (!sorted[i].has(id)) result.delete(id);
      }
    }
    return result;
  }

  /**
   * Birden fazla anahtarın birleşimini döndür (OR filtresi).
   */
  getUnion(keys: string[]): Set<ProjectID> {
    const result = new Set<ProjectID>();
    for (const key of keys) {
      for (const id of (this.index.get(key) ?? [])) {
        result.add(id);
      }
    }
    return result;
  }

  /** Belirli bir projenin anahtarları */
  getKeysFor(projectId: ProjectID): ReadonlySet<string> {
    return this.projectKeys.get(projectId) ?? new Set();
  }

  /** En fazla proje içeren anahtarlar */
  topKeys(n = 10): Array<{ key: string; count: number }> {
    return Array.from(this.index.entries())
      .map(([key, set]) => ({ key, count: set.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  stats() {
    return {
      totalEntries: Array.from(this.index.values()).reduce((s, set) => s + set.size, 0),
      uniqueKeys:   this.index.size,
      topKeys:      this.topKeys(5),
    };
  }

  get lastUpdated(): Date { return this._lastUpdated; }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _addEntry(key: string, projectId: ProjectID): void {
    if (!this.index.has(key)) {
      this.index.set(key, new Set());
    }
    this.index.get(key)!.add(projectId);
  }
}
