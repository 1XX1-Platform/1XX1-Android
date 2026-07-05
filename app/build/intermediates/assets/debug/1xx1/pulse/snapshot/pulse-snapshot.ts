/**
 * 1XX1 Pulse Snapshot
 * Aşama 10 — Pulse Engine
 *
 * Sistem yeniden başlarsa son pulse kaldığı yerden devam eder.
 * Snapshot: pulse durumu + fairness kayıtları.
 *
 * Özellikler:
 *   - Her pulse tamamlanınca snapshot oluşturulur
 *   - maxHistory aşılınca eski snapshot'lar atılır
 *   - Checksum tutarsızlık tespiti sağlar
 *   - In-memory implementasyon; Aşama 07 DB katmanıyla değiştirilebilir
 */

import type { PulseSnapshot as PulseSnap, FairnessRecord } from "../pulse-types.ts";

export interface StoredPulseState {
  lastSnapshot:    PulseSnap;
  fairness:        Record<string, FairnessRecord>;  // Map serialize edilemiyor
  savedAt:         Date;
  checksum:        string;
}

function simpleChecksum(obj: unknown): string {
  const s    = JSON.stringify(obj);
  let   hash = 0;
  for (let i = 0; i < Math.min(s.length, 2000); i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class PulseSnapshotStore {
  private readonly history: StoredPulseState[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 10) {
    this.maxHistory = maxHistory;
  }

  /** Mevcut durumu kaydet */
  save(snapshot: PulseSnap, fairness: Map<string, FairnessRecord>): StoredPulseState {
    const fairnessObj: Record<string, FairnessRecord> = {};
    for (const [k, v] of fairness) fairnessObj[k] = v;

    const state: StoredPulseState = {
      lastSnapshot: snapshot,
      fairness:     fairnessObj,
      savedAt:      new Date(),
      checksum:     simpleChecksum({ snapshot, fairness: fairnessObj }),
    };

    this.history.push(state);
    if (this.history.length > this.maxHistory) {
      this.history.shift(); // eski olanı at
    }
    return state;
  }

  /** En son snapshot */
  latest(): StoredPulseState | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /** Snapshot'ı fairness Map'e dönüştür (restart recovery) */
  restoreFairness(state: StoredPulseState): Map<string, FairnessRecord> {
    return new Map(Object.entries(state.fairness));
  }

  /** Checksum doğrulama */
  verify(state: StoredPulseState): boolean {
    const expected = simpleChecksum({ snapshot: state.lastSnapshot, fairness: state.fairness });
    return expected === state.checksum;
  }

  /** Geçmiş snapshot sayısı */
  count(): number { return this.history.length; }

  /** Son N snapshot */
  recent(n = 5): StoredPulseState[] {
    return this.history.slice(-n);
  }
}
