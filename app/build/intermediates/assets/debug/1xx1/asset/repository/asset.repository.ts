/**
 * 1XX1 Asset Repository
 * Aşama 11 — Asset Bank
 *
 * In-memory implementasyon — Aşama 07 veritabanına bağlanmaya hazır.
 * Yalnızca CRUD — iş mantığı yok.
 *
 * Duplicate detection: SHA-256 → existing asset ID haritası
 * Versiyon geçmişi: Asset içinde tutulur (silinmez)
 */

import type { Asset, AssetVersion, AssetDependency } from "../entities/asset.entity.ts";
import type { Checksum } from "../entities/asset.entity.ts";
import { generateId } from "../../core/utils.ts";

// ─── Repository Arayüzü ───────────────────────────────────────────────────────

export interface IAssetRepository {
  create(data: Omit<Asset, "assetId" | "createdAt" | "updatedAt">): Promise<Asset>;
  findById(id: string): Promise<Asset | null>;
  findByOwner(ownerId: string, limit?: number, offset?: number): Promise<Asset[]>;
  findByProject(projectId: string): Promise<Asset[]>;
  findByChannel(channelId: string): Promise<Asset[]>;
  findByChecksum(sha256: string): Promise<Asset | null>;
  update(id: string, patch: Partial<Asset>): Promise<Asset | null>;
  addVersion(assetId: string, version: Omit<AssetVersion, "versionId">): Promise<Asset | null>;
  incrementDownload(assetId: string): Promise<void>;
  incrementReference(assetId: string, delta?: number): Promise<void>;
  search(opts: AssetSearchOpts): Promise<{ assets: Asset[]; total: number }>;
  count(): Promise<number>;
}

export interface AssetSearchOpts {
  type?:    string;
  license?: string;
  tags?:    string[];
  ownerId?: string;
  term?:    string;   // title/description içinde arama
  limit?:   number;
  offset?:  number;
}

// ─── In-Memory Asset Repository ──────────────────────────────────────────────

export class InMemoryAssetRepository implements IAssetRepository {
  private readonly store      = new Map<string, Asset>();
  /** SHA-256 → assetId (duplicate detection) */
  private readonly checksumIndex = new Map<string, string>();

  async create(data: Omit<Asset, "assetId" | "createdAt" | "updatedAt">): Promise<Asset> {
    const now   = new Date();
    const asset: Asset = {
      ...data,
      assetId:   `ast_${generateId()}`,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(asset.assetId, asset);

    // Checksum indeksine ekle
    for (const version of asset.versions) {
      for (const file of version.files) {
        if (file.checksum.sha256) {
          this.checksumIndex.set(file.checksum.sha256, asset.assetId);
        }
      }
    }

    return { ...asset, versions: asset.versions.map((v) => ({ ...v })) };
  }

  async findById(id: string): Promise<Asset | null> {
    const a = this.store.get(id);
    return a ? { ...a } : null;
  }

  async findByOwner(ownerId: string, limit = 50, offset = 0): Promise<Asset[]> {
    return Array.from(this.store.values())
      .filter((a) => a.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((a) => ({ ...a }));
  }

  async findByProject(projectId: string): Promise<Asset[]> {
    return Array.from(this.store.values())
      .filter((a) => a.projectId === projectId)
      .map((a) => ({ ...a }));
  }

  async findByChannel(channelId: string): Promise<Asset[]> {
    return Array.from(this.store.values())
      .filter((a) => a.channelId === channelId)
      .map((a) => ({ ...a }));
  }

  async findByChecksum(sha256: string): Promise<Asset | null> {
    const id = this.checksumIndex.get(sha256);
    return id ? this.findById(id) : null;
  }

  async update(id: string, patch: Partial<Asset>): Promise<Asset | null> {
    const a = this.store.get(id);
    if (!a) return null;
    const updated = { ...a, ...patch, assetId: id, updatedAt: new Date() };
    this.store.set(id, updated);
    return { ...updated };
  }

  async addVersion(
    assetId:  string,
    versionData: Omit<AssetVersion, "versionId">
  ): Promise<Asset | null> {
    const asset = this.store.get(assetId);
    if (!asset) return null;

    const version: AssetVersion = {
      ...versionData,
      versionId: `ver_${generateId()}`,
    };

    // Checksum indeksine ekle
    for (const file of version.files) {
      if (file.checksum.sha256) {
        this.checksumIndex.set(file.checksum.sha256, assetId);
      }
    }

    const updated: Asset = {
      ...asset,
      versions:      [...asset.versions, version],
      latestVersion: version.versionId,
      updatedAt:     new Date(),
    };
    this.store.set(assetId, updated);
    return { ...updated };
  }

  async incrementDownload(assetId: string): Promise<void> {
    const a = this.store.get(assetId);
    if (a) { a.downloadCount++; a.updatedAt = new Date(); }
  }

  async incrementReference(assetId: string, delta = 1): Promise<void> {
    const a = this.store.get(assetId);
    if (a) { a.referenceCount += delta; a.updatedAt = new Date(); }
  }

  async search(opts: AssetSearchOpts): Promise<{ assets: Asset[]; total: number }> {
    const limit  = opts.limit  ?? 20;
    const offset = opts.offset ?? 0;

    let results = Array.from(this.store.values()).filter((a) => {
      if (a.status === "removed") return false;
      if (opts.type    && a.type    !== opts.type)    return false;
      if (opts.license && a.license !== opts.license) return false;
      if (opts.ownerId && a.ownerId !== opts.ownerId) return false;
      if (opts.tags?.length) {
        const aTags = new Set(a.tags.map((t) => t.toLowerCase()));
        if (!opts.tags.some((t) => aTags.has(t.toLowerCase()))) return false;
      }
      if (opts.term) {
        const term  = opts.term.toLowerCase();
        const inTitle = a.title.toLowerCase().includes(term);
        const inDesc  = a.description.toLowerCase().includes(term);
        if (!inTitle && !inDesc) return false;
      }
      return true;
    });

    results.sort((a, b) => b.downloadCount - a.downloadCount);

    return {
      assets: results.slice(offset, offset + limit).map((a) => ({ ...a })),
      total:  results.length,
    };
  }

  async count(): Promise<number> { return this.store.size; }
}
