/**
 * 1XX1 Asset Service
 * Aşama 11 — Asset Bank
 *
 * Tüm asset operasyonlarını koordine eder:
 *   - Yükleme (metadata çıkarma + duplicate detection + storage)
 *   - Sürümleme
 *   - Lisans uyumluluk kontrolü
 *   - Bağımlılık yönetimi
 *   - Arama (kendi indeksi + SearchEngine)
 *   - İndirme sayacı
 *
 * Mimari karar: dosya içeriği Storage Adapter'e, metadata Repository'e.
 */

import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import type {
  Asset, AssetVersion, AssetDependency, AssetFile,
  AssetType, AssetLicenseType, AssetStatus,
} from "../entities/asset.entity.ts";
import { COPYLEFT_LICENSES, NON_COMMERCIAL_LICENSES } from "../entities/asset.entity.ts";
import type { IAssetRepository } from "../repository/asset.repository.ts";
import type { IStorageAdapter } from "../storage/storage-adapter.ts";
import { buildStorageKey } from "../storage/storage-adapter.ts";
import { MetadataEngine } from "../metadata/metadata-engine.ts";
import { DependencyGraph } from "../dependency/dependency-graph.ts";
import { succeed, fail } from "../../application/commands/commands.ts";
import type { CommandOutcome } from "../../application/commands/commands.ts";
import { generateId } from "../../core/utils.ts";

// ─── Yükleme Komutu ──────────────────────────────────────────────────────────

export interface UploadAssetCommand {
  ownerId:      string;
  channelId?:   string;
  projectId?:   string;
  releaseId?:   string;
  title:        string;
  description:  string;
  tags:         string[];
  license:      AssetLicenseType;
  type?:        AssetType;       // belirtilmezse metadata'dan tahmin edilir
  fileName:     string;
  data:         Uint8Array;
  versionStr?:  string;          // "1.0.0", belirtilmezse "1.0.0"
  changeLog?:   string;
}

export interface AddVersionCommand {
  assetId:     string;
  requesterId: string;
  versionStr:  string;
  fileName:    string;
  data:        Uint8Array;
  changeLog:   string;
}

// ─── Lisans Politikası ────────────────────────────────────────────────────────

export interface LicenseCompatibility {
  compatible: boolean;
  reason?:    string;
}

export function checkLicenseCompatibility(
  parentLicense: AssetLicenseType,
  childLicense:  AssetLicenseType
): LicenseCompatibility {
  // Proprietary hiçbir şeyle uyumlu değil
  if (parentLicense === "Proprietary" || childLicense === "Proprietary") {
    return { compatible: false, reason: "Proprietary lisanslı varlık birleştirilemez" };
  }

  // Copyleft: çocuk da copyleft olmalı
  if (COPYLEFT_LICENSES.has(parentLicense) && !COPYLEFT_LICENSES.has(childLicense)) {
    return {
      compatible: false,
      reason: `${parentLicense} copyleft lisansı — türevler de ${parentLicense} taşımalı`,
    };
  }

  // NC (non-commercial): ticari uygulamada kullanılamaz
  if (NON_COMMERCIAL_LICENSES.has(childLicense)) {
    return {
      compatible: true, // uyumlu ama uyarı
      reason:     `${childLicense} ticari kullanıma izin vermiyor`,
    };
  }

  return { compatible: true };
}

// ─── AssetService ─────────────────────────────────────────────────────────────

export class AssetService {
  private readonly metadata = new MetadataEngine();
  readonly depGraph = new DependencyGraph(); // public: testler doğrudan erişir

  constructor(
    repo:     IAssetRepository,
    storage:  IStorageAdapter,
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.storage = storage;
    this.repo = repo;}

  // ─── Yükleme ─────────────────────────────────────────────────────────────

  async upload(cmd: UploadAssetCommand): Promise<CommandOutcome<Asset>> {
    // Boyut kontrolü (512 MB)
    if (!this.metadata.checkSize(cmd.data.byteLength)) {
      return fail("FILE_TOO_LARGE", `Dosya çok büyük: ${cmd.data.byteLength} byte (max: 512MB)`);
    }

    // Metadata çıkar
    const meta = await this.metadata.extract(cmd.data, cmd.fileName);

    // Duplicate detection
    const existing = await this.repo.findByChecksum(meta.checksum.sha256);
    if (existing) {
      // Aynı içerik — yeni referans oluştur, yeniden yükleme
      await this.repo.incrementReference(existing.assetId);
      this.logger?.debug(`Duplicate tespit: ${cmd.fileName} → ${existing.assetId}`);
      return succeed(existing); // mevcut asset'i döndür
    }

    // Storage'a yükle
    const assetId   = `ast_${generateId()}`;
    const versionId = `ver_${generateId()}`;
    const storageKey = buildStorageKey(cmd.ownerId, assetId, versionId, cmd.fileName);

    try {
      await this.storage.put(storageKey, cmd.data, meta.mimeType);
    } catch (err) {
      return fail("STORAGE_ERROR", `Dosya depolanamadı: ${err instanceof Error ? err.message : "Bilinmeyen hata"}`);
    }

    // Dosya entity
    const file: AssetFile = {
      storageKey,
      fileName:  cmd.fileName,
      mimeType:  meta.mimeType,
      size:      meta.size,
      checksum:  meta.checksum,
      uploadedAt: new Date(),
    };

    // İlk sürüm
    const version: AssetVersion = {
      versionId,
      assetId,
      versionStr:  cmd.versionStr ?? "1.0.0",
      files:       [file],
      changeLog:   cmd.changeLog ?? "İlk sürüm",
      uploadedBy:  cmd.ownerId,
      uploadedAt:  new Date(),
      deprecated:  false,
    };

    // Asset oluştur
    try {
      const asset = await this.repo.create({
        ownerId:       cmd.ownerId,
        channelId:     cmd.channelId,
        projectId:     cmd.projectId,
        releaseId:     cmd.releaseId,
        type:          cmd.type ?? meta.assetType,
        format:        meta.format,
        title:         cmd.title,
        description:   cmd.description,
        tags:          cmd.tags,
        license:       cmd.license,
        status:        "active",
        versions:      [version],
        latestVersion: versionId,
        downloadCount: 0,
        referenceCount: 0,
      });

      this.eventBus?.emit("asset:created" as never, {
        assetId: asset.assetId,
        ownerId: asset.ownerId,
        type:    asset.type,
        title:   asset.title,
      });

      this.logger?.info(`Asset yüklendi: ${asset.assetId} (${cmd.fileName}, ${meta.size} byte)`);
      return succeed(asset);

    } catch (err) {
      // Storage'a yüklenen dosyayı temizle (atomik olmayan rollback)
      await this.storage.delete(storageKey).catch(() => {});
      return fail("CREATE_ERROR", `Asset oluşturulamadı: ${err instanceof Error ? err.message : ""}`);
    }
  }

  // ─── Sürüm Ekleme ────────────────────────────────────────────────────────

  async addVersion(cmd: AddVersionCommand): Promise<CommandOutcome<Asset>> {
    const asset = await this.repo.findById(cmd.assetId);
    if (!asset) return fail("ASSET_NOT_FOUND", `Asset bulunamadı: ${cmd.assetId}`);
    if (asset.ownerId !== cmd.requesterId) return fail("UNAUTHORIZED", "Yetkisiz");

    // Versiyon çakışması
    if (asset.versions.some((v) => v.versionStr === cmd.versionStr)) {
      return fail("VERSION_EXISTS", `Sürüm zaten var: ${cmd.versionStr}`);
    }

    // Metadata çıkar
    const meta = await this.metadata.extract(cmd.data, cmd.fileName);

    // Duplicate check
    const dup = await this.repo.findByChecksum(meta.checksum.sha256);
    if (dup && dup.assetId !== cmd.assetId) {
      return fail("DUPLICATE_CONTENT", `Bu içerik zaten başka bir asset'te var: ${dup.assetId}`);
    }

    // Storage'a yükle
    const versionId = `ver_${generateId()}`;
    const key = buildStorageKey(asset.ownerId, cmd.assetId, versionId, cmd.fileName);
    await this.storage.put(key, cmd.data, meta.mimeType);

    const file: AssetFile = {
      storageKey: key,
      fileName:   cmd.fileName,
      mimeType:   meta.mimeType,
      size:       meta.size,
      checksum:   meta.checksum,
      uploadedAt: new Date(),
    };

    const updated = await this.repo.addVersion(cmd.assetId, {
      assetId:    cmd.assetId,
      versionStr: cmd.versionStr,
      files:      [file],
      changeLog:  cmd.changeLog,
      uploadedBy: cmd.requesterId,
      uploadedAt: new Date(),
      deprecated: false,
    });

    if (!updated) return fail("UPDATE_ERROR", "Sürüm eklenemedi");

    this.eventBus?.emit("asset:versioned" as never, {
      assetId:    cmd.assetId,
      versionStr: cmd.versionStr,
    });

    return succeed(updated);
  }

  // ─── Bağımlılık Yönetimi ─────────────────────────────────────────────────

  async addDependency(
    dep:        AssetDependency,
    parentLicense?: AssetLicenseType,
    childLicense?:  AssetLicenseType
  ): Promise<CommandOutcome<void>> {
    // Lisans uyumluluğu
    if (parentLicense && childLicense) {
      const compat = checkLicenseCompatibility(parentLicense, childLicense);
      if (!compat.compatible) {
        return fail("LICENSE_INCOMPATIBLE", compat.reason ?? "Lisans uyumsuzluğu");
      }
    }

    const result = this.depGraph.addDependency(dep);
    if (!result.ok) {
      return fail("CIRCULAR_DEPENDENCY", result.reason ?? "Döngüsel bağımlılık");
    }

    this.logger?.debug(`Bağımlılık eklendi: ${dep.sourceId} → ${dep.targetId} (${dep.type})`);
    return succeed(undefined);
  }

  removeDependency(sourceId: string, targetId: string): void {
    this.depGraph.removeDependency(sourceId, targetId);
  }

  getDependencies(assetId: string) {
    return this.depGraph.directDependencies(assetId);
  }

  getDependents(assetId: string) {
    return this.depGraph.directDependents(assetId);
  }

  // ─── İndirme ─────────────────────────────────────────────────────────────

  async download(
    assetId:   string,
    versionId?: string
  ): Promise<{ data: Uint8Array; fileName: string; mimeType: string } | null> {
    const asset = await this.repo.findById(assetId);
    if (!asset || asset.status === "removed") return null;
    if (asset.license === "Proprietary") return null; // sadece metadata

    const ver = versionId
      ? asset.versions.find((v) => v.versionId === versionId)
      : asset.versions.find((v) => v.versionId === asset.latestVersion);

    if (!ver || ver.deprecated) return null;

    const file = ver.files[0];
    if (!file) return null;

    const data = await this.storage.get(file.storageKey);
    if (!data) return null;

    await this.repo.incrementDownload(assetId);
    return { data, fileName: file.fileName, mimeType: file.mimeType };
  }

  // ─── Arama ───────────────────────────────────────────────────────────────

  async search(opts: {
    term?:    string;
    type?:    string;
    license?: string;
    tags?:    string[];
    ownerId?: string;
    limit?:   number;
    offset?:  number;
  }): Promise<{ assets: Asset[]; total: number }> {
    return this.repo.search(opts);
  }

  // ─── Tekil Sorgular ──────────────────────────────────────────────────────

  async getById(id: string): Promise<Asset | null> {
    return this.repo.findById(id);
  }

  async getByOwner(ownerId: string, limit?: number, offset?: number): Promise<Asset[]> {
    return this.repo.findByOwner(ownerId, limit, offset);
  }

  async getDownloadUrl(assetId: string, versionId?: string): Promise<string | null> {
    const asset = await this.repo.findById(assetId);
    if (!asset || asset.license === "Proprietary") return null;

    const ver = versionId
      ? asset.versions.find((v) => v.versionId === versionId)
      : asset.versions.find((v) => v.versionId === asset.latestVersion);

    if (!ver) return null;
    const file = ver.files[0];
    if (!file) return null;

    return this.storage.getUrl(file.storageKey, 3600_000); // 1 saat geçerli URL
  }
}

// Re-export for convenience
export { buildStorageKey };
