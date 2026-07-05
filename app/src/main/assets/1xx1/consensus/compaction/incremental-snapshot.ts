/**
 * 1XX1 Incremental Snapshot Builder
 * Aşama 18 — Snapshot + Log Compaction
 *
 * Aşama 14'teki SnapshotManager.take() her çağrıda TÜM store verisini
 * kopyalıyordu (full snapshot). Büyük store'larda (100K+ proje) bu
 * pahalı hale gelir — her snapshot alımı O(n) bellek + CPU.
 *
 * IncrementalSnapshotBuilder: önceki snapshot ile karşılaştırarak
 * yalnızca DEĞİŞEN kayıtları taşır. Restore sırasında:
 *   baseSnapshot (full) + delta_1 + delta_2 + ... + delta_n = current state
 *
 * Periyodik olarak (örn. her 100 delta'da bir) yeni bir "full" snapshot
 * alınır — delta zincirinin sonsuza kadar uzamasını önlemek için.
 */

import type { StoreCollection, SyncStore, VersionedEntry, StoreType } from "../../distributed/sync/sync-engine.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";

// ─── Snapshot Tipleri ─────────────────────────────────────────────────────────

export type SnapshotKind = "full" | "incremental";

export interface IncrementalSnapshot {
  hash:              string;
  kind:              SnapshotKind;
  nodeId:            string;
  takenAt:           number;
  clockValue:        number;
  eventLogPosition:  number;
  /** Incremental ise hangi snapshot'ın üzerine inşa edildi */
  baseHash?:         string;
  /** Bu snapshot'tan önceki store versiyon numaraları (delta hesaplamak için) */
  baseVersions:      Record<StoreType, number>;
  /** Yalnızca değişen kayıtlar (incremental) veya tüm kayıtlar (full) */
  storeDeltas: Record<StoreType, Array<VersionedEntry<unknown>>>;
  storeChecksums: Record<StoreType, string>;
}

// ─── Builder Config ───────────────────────────────────────────────────────────

export interface IncrementalSnapshotConfig {
  /** Kaç incremental snapshot sonra otomatik full snapshot alınır */
  fullSnapshotInterval: number;
  /** Maksimum saklanan snapshot zinciri uzunluğu */
  maxChainLength: number;
}

const DEFAULT_INCREMENTAL_CONFIG: IncrementalSnapshotConfig = {
  fullSnapshotInterval: 100,
  maxChainLength:       200,
};

const STORE_TYPES: StoreType[] = ["projects", "assets", "releases", "channels", "pulse", "policies"];

// ─── IncrementalSnapshotBuilder ───────────────────────────────────────────────

export class IncrementalSnapshotBuilder {
  private readonly chain: IncrementalSnapshot[] = [];
  /** Her store için bilinen son versiyon numarası — delta hesaplamak için referans */
  private lastVersions: Record<StoreType, number> = {
    projects: 0, assets: 0, releases: 0, channels: 0, pulse: 0, policies: 0,
  };
  private incrementalCount = 0;
  private readonly cfg: IncrementalSnapshotConfig;

  constructor(
    stores: StoreCollection,
    cfg: Partial<IncrementalSnapshotConfig> = {}
  ) {
    this.stores = stores;
    this.cfg = { ...DEFAULT_INCREMENTAL_CONFIG, ...cfg };
  }

  /**
   * Snapshot al — otomatik olarak full veya incremental seçilir.
   * İlk çağrı her zaman full'dur (delta hesaplayacak referans yok).
   */
  async take(nodeId: string, clockValue: number, eventLogPosition: number): Promise<IncrementalSnapshot> {
    const needsFull = this.chain.length === 0 ||
      this.incrementalCount >= this.cfg.fullSnapshotInterval;

    const snapshot = needsFull
      ? await this._takeFull(nodeId, clockValue, eventLogPosition)
      : await this._takeIncremental(nodeId, clockValue, eventLogPosition);

    this.chain.push(snapshot);
    if (this.chain.length > this.cfg.maxChainLength) this.chain.shift();

    if (snapshot.kind === "full") this.incrementalCount = 0;
    else this.incrementalCount++;

    return snapshot;
  }

  /** Tam snapshot — tüm store içeriği */
  private async _takeFull(
    nodeId: string, clockValue: number, eventLogPosition: number
  ): Promise<IncrementalSnapshot> {
    const storeDeltas    = {} as IncrementalSnapshot["storeDeltas"];
    const storeChecksums = {} as IncrementalSnapshot["storeChecksums"];
    const baseVersions   = {} as Record<StoreType, number>;

    for (const type of STORE_TYPES) {
      const store = this.stores[type] as SyncStore<unknown>;
      storeDeltas[type]    = store.all();
      storeChecksums[type] = await store.checksum();
      baseVersions[type]   = store.seq();
    }

    this.lastVersions = { ...baseVersions };

    const hash = await this._computeHash("full", storeChecksums, clockValue, eventLogPosition);

    return {
      hash, kind: "full", nodeId,
      takenAt: Date.now(), clockValue, eventLogPosition,
      baseVersions, storeDeltas, storeChecksums,
    };
  }

  /** Artımlı snapshot — yalnızca son full/incremental'dan sonra değişenler */
  private async _takeIncremental(
    nodeId: string, clockValue: number, eventLogPosition: number
  ): Promise<IncrementalSnapshot> {
    const storeDeltas    = {} as IncrementalSnapshot["storeDeltas"];
    const storeChecksums = {} as IncrementalSnapshot["storeChecksums"];
    const baseVersions   = {} as Record<StoreType, number>;
    const prevVersions   = this.lastVersions;

    for (const type of STORE_TYPES) {
      const store = this.stores[type] as SyncStore<unknown>;
      // Yalnızca son bilinen versiyondan sonra değişen kayıtlar
      storeDeltas[type]    = this._diffSince(store, prevVersions[type]);
      storeChecksums[type] = await store.checksum();
      baseVersions[type]   = store.seq();
    }

    this.lastVersions = { ...baseVersions };

    const baseHash = this.chain.at(-1)?.hash;
    const hash = await this._computeHash("incremental", storeChecksums, clockValue, eventLogPosition);

    return {
      hash, kind: "incremental", nodeId,
      takenAt: Date.now(), clockValue, eventLogPosition,
      baseHash, baseVersions, storeDeltas, storeChecksums,
    };
  }

  /** Bir store'da belirli bir versiyondan sonra değişen kayıtları bul */
  private _diffSince(store: SyncStore<unknown>, sinceVersion: number): Array<VersionedEntry<unknown>> {
    return store.all().filter((e) => e.version > sinceVersion);
  }

  private async _computeHash(
    kind: SnapshotKind,
    checksums: Record<StoreType, string>,
    clockValue: number,
    eventLogPosition: number
  ): Promise<string> {
    const input = JSON.stringify({ kind, checksums, clockValue, eventLogPosition });
    return sha256Hex(input);
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  latest(): IncrementalSnapshot | null {
    return this.chain.at(-1) ?? null;
  }

  /** Zincirdeki tüm snapshot'lar (en son full'dan başlayarak restore için sıralı) */
  chainSince(fullHash?: string): IncrementalSnapshot[] {
    if (!fullHash) {
      // Son full snapshot'tan itibaren zinciri döndür
      const lastFullIdx = this.chain.findLastIndex((s) => s.kind === "full");
      return lastFullIdx >= 0 ? this.chain.slice(lastFullIdx) : [...this.chain];
    }
    const idx = this.chain.findIndex((s) => s.hash === fullHash);
    return idx >= 0 ? this.chain.slice(idx) : [];
  }

  /** Tam zincir uzunluğu */
  chainLength(): number { return this.chain.length; }

  /** Zincirdeki delta sayısı (bant genişliği tasarrufu metriği) */
  stats(): { fullCount: number; incrementalCount: number; totalEntries: number } {
    let fullCount = 0, incrementalCount = 0, totalEntries = 0;
    for (const s of this.chain) {
      if (s.kind === "full") fullCount++; else incrementalCount++;
      for (const type of STORE_TYPES) totalEntries += s.storeDeltas[type]?.length ?? 0;
    }
    return { fullCount, incrementalCount, totalEntries };
  }
}

// ─── Restore Yardımcısı ───────────────────────────────────────────────────────

/**
 * Bir snapshot zincirini (full + ardışık incremental'lar) sıralı uygulayarak
 * hedef store koleksiyonunu yeniden inşa eder.
 *
 * Deterministik: aynı zincir → aynı son state (DeterministicResolver merge kullanır).
 */
export async function restoreFromChain(
  targetStores: StoreCollection,
  chain:        IncrementalSnapshot[]
): Promise<{ restoredEntries: number; appliedSnapshots: number }> {
  let restoredEntries = 0;

  for (const snapshot of chain) {
    for (const type of STORE_TYPES) {
      const store   = targetStores[type] as SyncStore<unknown>;
      const entries = snapshot.storeDeltas[type] ?? [];
      for (const entry of entries) {
        store.merge(entry); // DeterministicResolver çakışmaları çözer
        restoredEntries++;
      }
    }
  }

  return { restoredEntries, appliedSnapshots: chain.length };
}
