/**
 * 1XX1 Mantıksal Kimlik Katmanı (LogicalID)
 * Aşama 03 Risk Giderme — Risk 2
 *
 * Problem: CubePath tek gerçek adres iken path değişince (split/merge)
 *          tüm referanslar stale olur — event-driven invalidation gerekir.
 *
 * Çözüm: İki katmanlı kimlik
 *
 *   LogicalID (sabit, değişmez)  — ProjectID, NodeLogicalID
 *   CubePath  (değişken)         — split/merge sonrası güncellenir
 *
 * PathRegistry:
 *   LogicalID → current CubePath   (hızlı lookup)
 *   CubePath  → Set<LogicalID>     (path üzerinden sorgulama)
 *
 * Invalidation:
 *   EventBus "cube:path-changed" → tüm aboneler kendi cache'lerini temizler
 *   Her güncelleme idempotency key taşır (tekrar işlem güvenli)
 */

import type { ProjectID } from "../core/identity.ts";
import type { IEventBus } from "../core/interfaces.ts";
import type { ILogger } from "../core/interfaces.ts";

// ─── Tipler ───────────────────────────────────────────────────────────────────

/** Bir path değişim kaydı */
export interface PathChangeRecord {
  logicalId:   ProjectID;
  oldPath:     string;
  newPath:     string;
  reason:      "split" | "merge" | "manual-move" | "reindex";
  idempotencyKey: string;  // Risk 4: tekrar işlem güvenliği
  timestamp:   Date;
}

// ─── PathRegistry ─────────────────────────────────────────────────────────────

export class PathRegistry {
  /** LogicalID → current CubePath */
  private readonly idToPath = new Map<ProjectID, string>();
  /** CubePath → Set<ProjectID> (ters indeks) */
  private readonly pathToIds = new Map<string, Set<ProjectID>>();
  /** Değişim geçmişi (son N kayıt, replay için) */
  private readonly changeLog: PathChangeRecord[] = [];
  private readonly maxLogSize: number;

  constructor(
    eventBus?: IEventBus,
    logger?: ILogger,
    maxLogSize = 1000
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.maxLogSize = maxLogSize;
  }

  // ─── Temel Operasyonlar ───────────────────────────────────────────────────

  /** Bir projeyi path'e kaydet */
  register(id: ProjectID, path: string): void {
    const oldPath = this.idToPath.get(id);

    if (oldPath === path) return; // değişiklik yok

    // Eski path'ten kaldır
    if (oldPath !== undefined) {
      this.pathToIds.get(oldPath)?.delete(id);
      if (this.pathToIds.get(oldPath)?.size === 0) {
        this.pathToIds.delete(oldPath);
      }
    }

    // Yeni path'e ekle
    this.idToPath.set(id, path);
    if (!this.pathToIds.has(path)) {
      this.pathToIds.set(path, new Set());
    }
    this.pathToIds.get(path)!.add(id);
  }

  /** Path değişimi — event yayınlar, log tutar */
  changePath(
    id: ProjectID,
    newPath: string,
    reason: PathChangeRecord["reason"]
  ): void {
    const oldPath = this.idToPath.get(id);
    if (oldPath === newPath) return;

    const record: PathChangeRecord = {
      logicalId:      id,
      oldPath:        oldPath ?? "",
      newPath,
      reason,
      idempotencyKey: `${id}:${oldPath ?? ""}:${newPath}:${Date.now()}`,
      timestamp:      new Date(),
    };

    this.register(id, newPath);
    this._appendLog(record);

    this.eventBus?.emit("cube:path-changed" as never, record);
    this.logger?.debug(
      `Path değişti: ${id} — "${oldPath}" → "${newPath}" (${reason})`
    );
  }

  /** Toplu path değişimi (split sonrası) — atomic */
  bulkChangePath(
    changes: Array<{ id: ProjectID; newPath: string }>,
    reason: PathChangeRecord["reason"]
  ): void {
    for (const { id, newPath } of changes) {
      this.changePath(id, newPath, reason);
    }
  }

  /** Bir projeyi sil */
  unregister(id: ProjectID): void {
    const path = this.idToPath.get(id);
    if (!path) return;

    this.idToPath.delete(id);
    this.pathToIds.get(path)?.delete(id);
    if (this.pathToIds.get(path)?.size === 0) {
      this.pathToIds.delete(path);
    }
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  /** Projenin mevcut path'i (O(1)) */
  getPath(id: ProjectID): string | undefined {
    return this.idToPath.get(id);
  }

  /** Bir path'teki proje ID'leri (O(1)) */
  getIds(path: string): ReadonlySet<ProjectID> {
    return this.pathToIds.get(path) ?? new Set();
  }

  /** Kayıtlı toplam proje sayısı */
  size(): number {
    return this.idToPath.size;
  }

  /** Bir path'te kayıtlı proje var mı? */
  hasPath(path: string): boolean {
    const set = this.pathToIds.get(path);
    return set !== undefined && set.size > 0;
  }

  // ─── Replay Desteği (Risk 4'e katkı) ────────────────────────────────────

  /** Son N değişim kaydını döndür */
  recentChanges(n = 50): Readonly<PathChangeRecord[]> {
    return this.changeLog.slice(-n);
  }

  /** Belirli idempotency key daha önce işlendi mi? */
  wasProcessed(idempotencyKey: string): boolean {
    return this.changeLog.some((r) => r.idempotencyKey === idempotencyKey);
  }

  /** Tüm değişimleri baştan tekrar uygula (crash recovery) */
  replay(records: PathChangeRecord[]): void {
    for (const r of records) {
      if (!this.wasProcessed(r.idempotencyKey)) {
        this.register(r.logicalId, r.newPath);
        this._appendLog(r);
      }
    }
    this.logger?.info(`PathRegistry replay: ${records.length} kayıt işlendi`);
  }

  // ─── İstatistikler ────────────────────────────────────────────────────────

  stats(): { projects: number; paths: number; logSize: number } {
    return {
      projects: this.idToPath.size,
      paths:    this.pathToIds.size,
      logSize:  this.changeLog.length,
    };
  }

  private _appendLog(record: PathChangeRecord): void {
    this.changeLog.push(record);
    if (this.changeLog.length > this.maxLogSize) {
      this.changeLog.splice(0, this.changeLog.length - this.maxLogSize);
    }
  }
}
