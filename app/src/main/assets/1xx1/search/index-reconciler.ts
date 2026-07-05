/**
 * 1XX1 IndexReconciler — Anti-Drift Katmanı
 * Düzeltme 2: Index Tutarlılık Modeli
 *
 * Problem: Event lost durumunda index drift oluşabilir.
 *   - semantic index orphan token tutabilir
 *   - reverse index silinmiş projelere referans tutabilir
 *   - structural index stale path saklayabilir
 *
 * Çözüm: Periyodik reconciliation job
 *
 *   1. "Ground truth" set'i al (PathRegistry'deki canlı ProjectID'ler)
 *   2. Her indeksi tara
 *   3. Ground truth'ta olmayan entry'leri sil (orphan cleanup)
 *   4. Ground truth'ta olup indekste olmayan entry'leri tespit et (missing)
 *   5. Sonuçları "index:reconciled" olayıyla yayınla
 *
 * Önemli: Reconciler yalnızca INDEX scope olayı yayınlar.
 *         CORE/CUBE scope'a asla olay atmaz (Düzeltme 1 kuralı).
 */

import type { IEventBus, ILogger } from "../core/interfaces.ts";
import type { ProjectID } from "../core/identity.ts";
import { SemanticIndex } from "./semantic-index.ts";
import { ReverseIndex } from "./reverse-index.ts";
import { StructuralIndex } from "./structural-index.ts";

// ─── Reconciliation Sonucu ────────────────────────────────────────────────────

export interface ReconciliationResult {
  runAt:           Date;
  durationMs:      number;
  orphansRemoved:  number;
  missingDetected: number;
  drifted:         boolean;  // herhangi bir tutarsızlık bulundu mu?
  details: {
    semantic:   { orphans: number; missing: number };
    reverse:    { orphans: number; missing: number };
    structural: { orphans: number; missing: number };
  };
}

// ─── IndexReconciler ─────────────────────────────────────────────────────────

export class IndexReconciler {
  private _running            = false;
  private _intervalHandle?: ReturnType<typeof setInterval>;
  private _lastResult?: ReconciliationResult;
  private _runCount = 0;

  constructor(
    semantic:   SemanticIndex,
    reverse:    ReverseIndex,
    structural: StructuralIndex,
    eventBus?:  IEventBus,
    logger?:    ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.structural = structural;
    this.reverse = reverse;
    this.semantic = semantic;}

  // ─── Periyodik Çalıştırma ─────────────────────────────────────────────────

  start(intervalMs = 60_000): void {
    if (this._intervalHandle) return;
    this._intervalHandle = setInterval(() => {
      // Ground truth olarak reverse index'in proje kümesini kullan
      // (en yetkili ve en kolay erişilebilir kaynak)
      this.reconcile(this._groundTruthFromReverse());
    }, intervalMs);
    this.logger?.info(`IndexReconciler başlatıldı: her ${intervalMs}ms`);
  }

  stop(): void {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
      this.logger?.info("IndexReconciler durduruldu");
    }
  }

  isRunning(): boolean {
    return !!this._intervalHandle;
  }

  get lastResult(): ReconciliationResult | undefined {
    return this._lastResult;
  }

  // ─── Manuel Reconciliation ────────────────────────────────────────────────

  /**
   * Verilen ground truth set'ine göre indeksleri temizle.
   * @param liveProjectIds  Gerçekten var olan ProjectID'ler (kaynak: PathRegistry veya DB)
   */
  reconcile(liveProjectIds: Set<ProjectID>): ReconciliationResult {
    if (this._running) {
      this.logger?.warn("IndexReconciler: önceki çalışma tamamlanmadı, atlanıyor");
      return this._lastResult ?? this._emptyResult();
    }

    this._running = true;
    const start   = Date.now();
    this._runCount++;

    const semanticStats   = this._reconcileSemantic(liveProjectIds);
    const reverseStats    = this._reconcileReverse(liveProjectIds);
    const structuralStats = this._reconcileStructural(liveProjectIds);

    const orphansTotal  = semanticStats.orphans + reverseStats.orphans + structuralStats.orphans;
    const missingTotal  = semanticStats.missing + reverseStats.missing + structuralStats.missing;
    const drifted       = orphansTotal > 0 || missingTotal > 0;

    const result: ReconciliationResult = {
      runAt:           new Date(),
      durationMs:      Date.now() - start,
      orphansRemoved:  orphansTotal,
      missingDetected: missingTotal,
      drifted,
      details: {
        semantic:   semanticStats,
        reverse:    reverseStats,
        structural: structuralStats,
      },
    };

    this._lastResult = result;
    this._running    = false;

    if (drifted) {
      this.logger?.warn(
        `IndexReconciler: drift tespit edildi — ` +
        `${orphansTotal} orphan temizlendi, ${missingTotal} eksik`
      );
      // Düzeltme 1: INDEX scope olayı — CORE'a geri atmaz
      this.eventBus?.emit(
        "index:drift-detected",
        { result, runCount: this._runCount },
        `reconcile:${this._runCount}`
      );
    }

    // Her çalışmada yayınla (monitoring için)
    this.eventBus?.emit(
      "index:reconciled",
      { result, runCount: this._runCount },
      `reconcile-done:${this._runCount}`
    );

    this.logger?.info(
      `IndexReconciler #${this._runCount}: ${result.durationMs}ms, ` +
      `drift=${drifted}, orphans=${orphansTotal}`
    );

    return result;
  }

  // ─── Katman Bazlı Reconciliation ─────────────────────────────────────────

  /**
   * SemanticIndex: projectTokens map'ini kontrol et.
   * Ground truth'ta olmayan proje tokenleri temizle.
   */
  private _reconcileSemantic(live: Set<ProjectID>): { orphans: number; missing: number } {
    let orphans = 0;

    // SemanticIndex'te private _projectTokens'e erişmek için reflection
    const sem = this.semantic as unknown as {
      projectTokens: Map<ProjectID, Set<string>>;
    };

    const toRemove: ProjectID[] = [];
    for (const pid of sem.projectTokens.keys()) {
      if (!live.has(pid)) toRemove.push(pid);
    }

    for (const pid of toRemove) {
      this.semantic.remove(pid);
      orphans++;
    }

    // Missing: ground truth'ta var ama semanticte yok
    let missing = 0;
    for (const pid of live) {
      if (!sem.projectTokens.has(pid)) missing++;
    }

    return { orphans, missing };
  }

  /**
   * ReverseIndex: projectKeys map'ini kontrol et.
   */
  private _reconcileReverse(live: Set<ProjectID>): { orphans: number; missing: number } {
    let orphans = 0;

    const rev = this.reverse as unknown as {
      projectKeys: Map<ProjectID, Set<string>>;
    };

    const toRemove: ProjectID[] = [];
    for (const pid of rev.projectKeys.keys()) {
      if (!live.has(pid)) toRemove.push(pid);
    }

    for (const pid of toRemove) {
      this.reverse.remove(pid);
      orphans++;
    }

    let missing = 0;
    for (const pid of live) {
      if (!rev.projectKeys.has(pid)) missing++;
    }

    return { orphans, missing };
  }

  /**
   * StructuralIndex: byProject map'ini kontrol et.
   */
  private _reconcileStructural(live: Set<ProjectID>): { orphans: number; missing: number } {
    let orphans = 0;

    const str = this.structural as unknown as {
      byProject: Map<ProjectID, string>;
    };

    const toRemove: ProjectID[] = [];
    for (const pid of str.byProject.keys()) {
      if (!live.has(pid)) toRemove.push(pid);
    }

    for (const pid of toRemove) {
      this.structural.remove(pid);
      orphans++;
    }

    let missing = 0;
    for (const pid of live) {
      if (!str.byProject.has(pid)) missing++;
    }

    return { orphans, missing };
  }

  // ─── Ground Truth Üretimi ─────────────────────────────────────────────────

  /**
   * ReverseIndex'ten canlı ProjectID kümesi türet.
   * Periyodik reconciliation için yeterli; tam doğruluk için
   * Aşama 07'de PathRegistry veya veritabanına bağlanacak.
   */
  private _groundTruthFromReverse(): Set<ProjectID> {
    const rev = this.reverse as unknown as {
      projectKeys: Map<ProjectID, Set<string>>;
    };
    return new Set(rev.projectKeys.keys());
  }

  private _emptyResult(): ReconciliationResult {
    return {
      runAt: new Date(), durationMs: 0,
      orphansRemoved: 0, missingDetected: 0, drifted: false,
      details: {
        semantic:   { orphans: 0, missing: 0 },
        reverse:    { orphans: 0, missing: 0 },
        structural: { orphans: 0, missing: 0 },
      },
    };
  }
}
