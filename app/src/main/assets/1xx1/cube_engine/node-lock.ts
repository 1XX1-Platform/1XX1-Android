/**
 * 1XX1 Düğüm Kilidi (NodeLock)
 * Aşama 03 Risk Giderme — Risk 3
 *
 * Problem: Aynı node üzerinde paralel split/insert çakışması.
 *          JavaScript single-threaded ama async/await zincirlerinde
 *          iki farklı coroutine aynı node'u eş zamanlı değiştirebilir.
 *
 * Çözüm: Düğüm başına mantıksal kilit (logical mutex)
 *
 *   acquire(path) → Promise<Release>
 *   release()     → kilidi serbest bırak
 *
 *   Kilit sırasında gelen istekler kuyrukta bekler (FIFO).
 *   Deadlock riski: kilitler hiyerarşik (parent önce child sonra).
 *   Timeout: kilitlenen düğüm belirli ms'den fazla meşgul ise hata.
 *
 * Kullanım:
 *   const release = await nodeLock.acquire("4/7/2");
 *   try { await doSomething(); } finally { release(); }
 */

import type { ILogger } from "../core/interfaces.ts";

export type ReleaseFunction = () => void;

interface LockEntry {
  queue: Array<(release: ReleaseFunction) => void>;
  locked: boolean;
  acquiredAt?: number;
}

export class NodeLockManager {
  private readonly locks = new Map<string, LockEntry>();
  private readonly timeoutMs: number;

  constructor(
    logger?: ILogger,
    timeoutMs = 5000
  ) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Belirtilen path için kilit al.
   * Kilit meşgulse kuyrukta bekler (FIFO).
   * timeoutMs içinde kilit alınamazsa hata fırlatır.
   */
  async acquire(path: string): Promise<ReleaseFunction> {
    if (!this.locks.has(path)) {
      this.locks.set(path, { queue: [], locked: false });
    }

    const entry = this.locks.get(path)!;

    if (!entry.locked) {
      // Kilit boş — doğrudan al
      entry.locked = true;
      entry.acquiredAt = Date.now();
      this.logger?.debug(`Kilit alındı: ${path}`);
      return this._makeRelease(path);
    }

    // Kilit meşgul — kuyruğa ekle
    return new Promise<ReleaseFunction>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout: kuyruktan kaldır
        const idx = entry.queue.indexOf(resolve as never);
        if (idx !== -1) entry.queue.splice(idx, 1);
        const age = entry.acquiredAt ? Date.now() - entry.acquiredAt : 0;
        const msg = `Kilit timeout: ${path} (${age}ms beklendi, limit: ${this.timeoutMs}ms)`;
        this.logger?.warn(msg);
        reject(new Error(msg));
      }, this.timeoutMs);

      entry.queue.push((release: ReleaseFunction) => {
        clearTimeout(timer);
        resolve(release);
      });
    });
  }

  /** Kilit alınmadan güvenli kontrol (test/debug) */
  isLocked(path: string): boolean {
    return this.locks.get(path)?.locked ?? false;
  }

  /** Kuyruktaki istek sayısı */
  queueLength(path: string): number {
    return this.locks.get(path)?.queue.length ?? 0;
  }

  /** Aktif kilit sayısı */
  activeLocks(): number {
    let count = 0;
    for (const entry of this.locks.values()) {
      if (entry.locked) count++;
    }
    return count;
  }

  /** Beklenmedik bir şekilde kilitli kalan düğümleri temizle (watchdog) */
  releaseStale(maxAgeMs = 30_000): number {
    let released = 0;
    for (const [path, entry] of this.locks.entries()) {
      if (
        entry.locked &&
        entry.acquiredAt &&
        Date.now() - entry.acquiredAt > maxAgeMs
      ) {
        this.logger?.warn(`Stale kilit zorla serbest bırakıldı: ${path}`);
        this._doRelease(path);
        released++;
      }
    }
    return released;
  }

  private _makeRelease(path: string): ReleaseFunction {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      this._doRelease(path);
    };
  }

  private _doRelease(path: string): void {
    const entry = this.locks.get(path);
    if (!entry) return;

    const next = entry.queue.shift();
    if (next) {
      // Sıradaki bekleyeni uyandır
      entry.acquiredAt = Date.now();
      this.logger?.debug(`Kilit devredildi: ${path} (kuyruk: ${entry.queue.length})`);
      next(this._makeRelease(path));
    } else {
      // Kuyruk boş — kilidi serbest bırak
      entry.locked = false;
      entry.acquiredAt = undefined;
      this.logger?.debug(`Kilit serbest: ${path}`);
      // Bellek tasarrufu: boş entry'yi temizle
      if (entry.queue.length === 0) {
        this.locks.delete(path);
      }
    }
  }
}

/** Uygulama genelinde tek NodeLockManager */
export const nodeLock = new NodeLockManager();
