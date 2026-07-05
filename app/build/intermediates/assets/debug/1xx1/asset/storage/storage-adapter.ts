/**
 * 1XX1 Storage Adapter
 * Aşama 11 — Asset Bank
 *
 * Dosya içeriği veritabanında saklanmaz.
 * Bu adapter: yerel disk | nesne depolama | IPFS | gelecekte dağıtık depolama
 * aralarında sorunsuz geçiş sağlar.
 *
 * Üst katmanlar IStorageAdapter arayüzünü görür; gerçek implementasyon değişebilir.
 *
 * Depolama anahtarı formatı:
 *   assets/{ownerId}/{assetId}/{versionId}/{fileName}
 *
 * Böylece:
 *   - Aynı dosya farklı versiyonlarda tekrar yüklenmez (checksum deduplicate)
 *   - Sahip/varlık/sürüm hiyerarşisi URL'ye yansır
 *   - CDN önbelleğe alma doğal olarak çalışır
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Depolama Arayüzü ────────────────────────────────────────────────────────

export interface StorageObject {
  key:         string;
  size:        number;
  mimeType:    string;
  uploadedAt:  Date;
  url?:        string;   // public erişim URL'si (CDN varsa)
}

export interface IStorageAdapter {
  /** Dosya yükle */
  put(key: string, data: Uint8Array, mimeType: string): Promise<StorageObject>;
  /** Dosya oku */
  get(key: string): Promise<Uint8Array | null>;
  /** Dosya var mı? */
  exists(key: string): Promise<boolean>;
  /** Dosya sil */
  delete(key: string): Promise<boolean>;
  /** Belirli prefix altındaki anahtarları listele */
  list(prefix: string): Promise<string[]>;
  /** İndirme URL'si oluştur (geçici veya kalıcı) */
  getUrl(key: string, expiresInMs?: number): Promise<string>;
  /** Depolama kullanım istatistikleri */
  stats(): Promise<{ totalObjects: number; totalBytes: number }>;
}

// ─── Depolama Anahtarı Üretici ────────────────────────────────────────────────

export function buildStorageKey(
  ownerId:   string,
  assetId:   string,
  versionId: string,
  fileName:  string
): string {
  // Güvenli: path traversal önleme
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `assets/${safe(ownerId)}/${safe(assetId)}/${safe(versionId)}/${safe(fileName)}`;
}

// ─── In-Memory Storage Adapter (Test + Geliştirme) ───────────────────────────

export class InMemoryStorageAdapter implements IStorageAdapter {
  private readonly store = new Map<string, {
    data:       Uint8Array;
    mimeType:   string;
    uploadedAt: Date;
  }>();

  async put(key: string, data: Uint8Array, mimeType: string): Promise<StorageObject> {
    this.store.set(key, { data, mimeType, uploadedAt: new Date() });
    return {
      key,
      size:       data.byteLength,
      mimeType,
      uploadedAt: new Date(),
      url:        `memory://${key}`,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.data ?? null;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  async getUrl(key: string, expiresInMs?: number): Promise<string> {
    const expiry = expiresInMs ? `?expires=${Date.now() + expiresInMs}` : "";
    return `memory://${key}${expiry}`;
  }

  async stats(): Promise<{ totalObjects: number; totalBytes: number }> {
    let totalBytes = 0;
    for (const { data } of this.store.values()) totalBytes += data.byteLength;
    return { totalObjects: this.store.size, totalBytes };
  }

  /** Test için: depolanmış dosya sayısı */
  objectCount(): number { return this.store.size; }
}

// ─── Yerel Disk Storage Adapter (Production isteği dışı) ─────────────────────

/**
 * Node.js dosya sistemi tabanlı storage.
 * Production için nesne depolama (S3, MinIO) ile değiştirilir.
 * API arayüzü değişmez.
 */
export class LocalDiskStorageAdapter implements IStorageAdapter {
  constructor(
    basePath: string,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.basePath = basePath;}

  private _fullPath(key: string): string {
    return `${this.basePath}/${key}`;
  }

  async put(key: string, data: Uint8Array, mimeType: string): Promise<StorageObject> {
    const fs   = await import("node:fs/promises");
    const path = await import("node:path");
    const full = this._fullPath(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    this.logger?.debug(`Storage PUT: ${key} (${data.byteLength} byte)`);
    return { key, size: data.byteLength, mimeType, uploadedAt: new Date() };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const fs = await import("node:fs/promises");
      const buf = await fs.readFile(this._fullPath(key));
      return new Uint8Array(buf);
    } catch { return null; }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fs = await import("node:fs/promises");
      await fs.access(this._fullPath(key));
      return true;
    } catch { return false; }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const fs = await import("node:fs/promises");
      await fs.unlink(this._fullPath(key));
      return true;
    } catch { return false; }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const fs   = await import("node:fs/promises");
      const path = await import("node:path");
      const dir  = path.dirname(this._fullPath(prefix));
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => `${prefix.split("/").slice(0, -1).join("/")}/${e.name}`)
        .filter((k) => k.startsWith(prefix));
    } catch { return []; }
  }

  async getUrl(key: string): Promise<string> {
    return `file://${this._fullPath(key)}`;
  }

  async stats(): Promise<{ totalObjects: number; totalBytes: number }> {
    return { totalObjects: 0, totalBytes: 0 }; // basit implementasyon
  }
}
