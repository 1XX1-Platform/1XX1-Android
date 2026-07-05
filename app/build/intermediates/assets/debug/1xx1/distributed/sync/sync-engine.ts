/**
 * 1XX1 Conflict Resolver + Sync Stores + Event Log + Snapshot Manager
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 */

import type { IClock } from "../clock/lamport-clock.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { sha256Hex } from "../security/signature.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict Resolver
// ═══════════════════════════════════════════════════════════════════════════════

export interface VersionedEntry<T> {
  key:         string;
  value:       T;
  version:     number;
  timestamp:   number;
  nodeId:      string;
  clockValue:  number;
  signature:   string;
  deletedAt?:  number;
}

export interface IConflictResolver<T> {
  resolve(local: VersionedEntry<T>, remote: VersionedEntry<T>): VersionedEntry<T>;
}

/**
 * Deterministik çözüm — hiçbir zaman rastgele seçim yapılmaz.
 * Karar sırası:
 *   1. Lamport Clock (yüksek → kazanır)
 *   2. Version numarası (yüksek → kazanır)
 *   3. Timestamp (yüksek → kazanır)
 *   4. Signature string karşılaştırması (deterministik tiebreak)
 *   5. NodeId string karşılaştırması (sabit tiebreak)
 */
export class DeterministicResolver<T> implements IConflictResolver<T> {
  resolve(local: VersionedEntry<T>, remote: VersionedEntry<T>): VersionedEntry<T> {
    // 1. Logical Clock
    if (remote.clockValue > local.clockValue) return remote;
    if (local.clockValue  > remote.clockValue) return local;
    // 2. Version
    if (remote.version > local.version) return remote;
    if (local.version  > remote.version) return local;
    // 3. Timestamp
    if (remote.timestamp > local.timestamp) return remote;
    if (local.timestamp  > remote.timestamp) return local;
    // 4. Signature (deterministik string karşılaştırması)
    if (remote.signature > local.signature) return remote;
    if (local.signature  > remote.signature) return local;
    // 5. NodeId (son kale — her zaman farklı)
    return remote.nodeId > local.nodeId ? remote : local;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Typed Sync Stores
// ═══════════════════════════════════════════════════════════════════════════════

export type StoreType = "projects" | "assets" | "releases" | "channels" | "pulse" | "policies";

export class SyncStore<T> {
  private readonly entries = new Map<string, VersionedEntry<T>>();
  private _seq = 0;

  constructor(
    storeName: StoreType,
    resolver: IConflictResolver<T> = new DeterministicResolver()
  ) {}

  /**
   * Yerel güncelleme — kendi node'umuzdan
   */
  put(
    key:       string,
    value:     T,
    nodeId:    string,
    clockVal:  number,
    signature: string
  ): VersionedEntry<T> {
    const existing = this.entries.get(key);
    const entry: VersionedEntry<T> = {
      key,
      value,
      version:   (existing?.version ?? 0) + 1,
      timestamp: Date.now(),
      nodeId,
      clockValue: clockVal,
      signature,
    };
    this.entries.set(key, entry);
    this._seq++;
    return entry;
  }

  /**
   * Uzak güncelleme — conflict resolver karar verir
   */
  merge(remote: VersionedEntry<T>): { accepted: boolean; winner: VersionedEntry<T> } {
    const local  = this.entries.get(remote.key);
    if (!local) {
      this.entries.set(remote.key, remote);
      this._seq++;
      return { accepted: true, winner: remote };
    }
    const winner = this.resolver.resolve(local, remote);
    const accepted = winner === remote;
    if (accepted) {
      this.entries.set(remote.key, remote);
      this._seq++;
    }
    return { accepted, winner };
  }

  delete(key: string, nodeId: string, clockVal: number, sig: string): void {
    const ex = this.entries.get(key);
    if (ex) {
      this.entries.set(key, {
        ...ex, deletedAt: Date.now(),
        nodeId, clockValue: clockVal, signature: sig,
      });
      this._seq++;
    }
  }

  get(key: string): VersionedEntry<T> | undefined { return this.entries.get(key); }

  /** seq > fromSeq olan tüm kayıtlar (delta sync) */
  delta(fromVersion: number): VersionedEntry<T>[] {
    return Array.from(this.entries.values())
      .filter((e) => e.version > fromVersion)
      .sort((a, b) => a.version - b.version);
  }

  all(): VersionedEntry<T>[] { return Array.from(this.entries.values()); }
  count(): number             { return this.entries.size; }
  seq(): number               { return this._seq; }

  /** Store checksum (deterministik — sıralı keys) */
  async checksum(): Promise<string> {
    const sorted = Array.from(this.entries.entries())
      .filter(([, v]) => !v.deletedAt)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v.version}:${v.clockValue}`);
    return sha256Hex(sorted.join("|"));
  }
}

// ─── Store Collection ─────────────────────────────────────────────────────────

export interface StoreCollection {
  projects:  SyncStore<unknown>;
  assets:    SyncStore<unknown>;
  releases:  SyncStore<unknown>;
  channels:  SyncStore<unknown>;
  pulse:     SyncStore<unknown>;
  policies:  SyncStore<unknown>;
}

export function createStoreCollection(): StoreCollection {
  return {
    projects: new SyncStore("projects"),
    assets:   new SyncStore("assets"),
    releases: new SyncStore("releases"),
    channels: new SyncStore("channels"),
    pulse:    new SyncStore("pulse"),
    policies: new SyncStore("policies"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Append-Only Event Log
// ═══════════════════════════════════════════════════════════════════════════════

export interface EventLogEntry {
  seq:        number;
  timestamp:  number;
  clockValue: number;
  nodeId:     string;
  storeName:  StoreType;
  eventType:  string;
  key:        string;
  data:       unknown;
}

/**
 * Append-only event log.
 * Snapshot tek başına recovery için yeterli değildir.
 * Recovery = Snapshot + Replay Event Log
 * Replay deterministik: aynı log → aynı state.
 */
export class EventLog {
  private readonly entries: EventLogEntry[] = [];
  private _seq = 0;

  append(params: Omit<EventLogEntry, "seq">): EventLogEntry {
    const entry: EventLogEntry = { seq: ++this._seq, ...params };
    this.entries.push(entry);
    return entry;
  }

  /** seq > after olan tüm kayıtlar */
  since(after: number): EventLogEntry[] {
    return this.entries.filter((e) => e.seq > after);
  }

  /** Son N kayıt */
  tail(n: number): EventLogEntry[] {
    return this.entries.slice(-n);
  }

  /** Tüm kayıtlar (replay için) */
  all(): EventLogEntry[] { return [...this.entries]; }

  currentSeq(): number { return this._seq; }
  count():      number { return this.entries.length; }

  /** Log checksum */
  async checksum(): Promise<string> {
    const last = this.entries.at(-1);
    if (!last) return "0".repeat(64);
    return sha256Hex(`${last.seq}:${last.clockValue}:${last.nodeId}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Snapshot Manager
// ═══════════════════════════════════════════════════════════════════════════════

export interface DistributedSnapshot {
  /** Deterministik hash */
  hash:              string;
  nodeId:            string;
  takenAt:           number;
  clockValue:        number;
  eventLogPosition:  number;
  /** Her store'un checksum'u */
  storeChecksums: {
    projects:  string;
    assets:    string;
    releases:  string;
    channels:  string;
    pulse:     string;
    policies:  string;
  };
  /** Store içerikleri (tam veri) */
  storeData: {
    projects:  unknown[];
    assets:    unknown[];
    releases:  unknown[];
    channels:  unknown[];
    pulse:     unknown[];
    policies:  unknown[];
  };
}

export class SnapshotManager {
  private readonly history: DistributedSnapshot[] = [];
  private readonly maxHistory: number;

  constructor(
    stores:  StoreCollection,
    eventLog: EventLog,
    opts: { maxHistory?: number } = {}
  ) {
    this.eventLog = eventLog;
    this.stores = stores;
    this.maxHistory = opts.maxHistory ?? 5;
  }

  /** Mevcut durumun snapshot'ını al */
  async take(nodeId: string, clockValue: number): Promise<DistributedSnapshot> {
    const [pCs, aCs, rCs, chCs, puCs, poCs] = await Promise.all([
      this.stores.projects.checksum(),
      this.stores.assets.checksum(),
      this.stores.releases.checksum(),
      this.stores.channels.checksum(),
      this.stores.pulse.checksum(),
      this.stores.policies.checksum(),
    ]);

    const storeChecksums = {
      projects: pCs, assets: aCs, releases: rCs,
      channels: chCs, pulse: puCs, policies: poCs,
    };

    const storeData = {
      projects: this.stores.projects.all(),
      assets:   this.stores.assets.all(),
      releases: this.stores.releases.all(),
      channels: this.stores.channels.all(),
      pulse:    this.stores.pulse.all(),
      policies: this.stores.policies.all(),
    };

    // Deterministik hash
    const hashInput = JSON.stringify({ storeChecksums, clockValue, eventLogPosition: this.eventLog.currentSeq() });
    const hash      = await sha256Hex(hashInput);

    const snapshot: DistributedSnapshot = {
      hash,
      nodeId,
      takenAt:          Date.now(),
      clockValue,
      eventLogPosition: this.eventLog.currentSeq(),
      storeChecksums,
      storeData,
    };

    this.history.unshift(snapshot);
    if (this.history.length > this.maxHistory) this.history.pop();

    return snapshot;
  }

  /** En son snapshot */
  latest(): DistributedSnapshot | null {
    return this.history[0] ?? null;
  }

  /** Hash ile bul */
  findByHash(hash: string): DistributedSnapshot | null {
    return this.history.find((s) => s.hash === hash) ?? null;
  }

  /** Snapshot'tan geri yükle */
  restore(snapshot: DistributedSnapshot): number {
    let restored = 0;

    const toStore = (store: SyncStore<unknown>, data: unknown[], storeN: StoreType) => {
      for (const entry of data as Array<VersionedEntry<unknown>>) {
        store.merge(entry);
        restored++;
      }
    };

    toStore(this.stores.projects, snapshot.storeData.projects, "projects");
    toStore(this.stores.assets,   snapshot.storeData.assets,   "assets");
    toStore(this.stores.releases, snapshot.storeData.releases, "releases");
    toStore(this.stores.channels, snapshot.storeData.channels, "channels");
    toStore(this.stores.pulse,    snapshot.storeData.pulse,    "pulse");
    toStore(this.stores.policies, snapshot.storeData.policies, "policies");

    return restored;
  }

  history(): DistributedSnapshot[] { return [...this.history]; }
}
