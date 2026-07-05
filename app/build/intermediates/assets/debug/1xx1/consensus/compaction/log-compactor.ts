/**
 * 1XX1 Log Compaction
 * Aşama 18 — Snapshot + Log Compaction
 *
 * Aşama 15'te ILogCompactor arayüzü ve NoopLogCompactor stub bırakılmıştı.
 * Bu dosya gerçek implementasyonu sağlar: IncrementalLogCompactor.
 *
 * Problem: Raft log append-only'dir (Aşama 15). Sistem yıllarca çalışırsa
 * log sonsuza kadar büyür — bellek ve restart süresi katlanarak artar.
 *
 * Çözüm: Snapshot alındıktan sonra, o snapshot'a kadar olan log girdileri
 * güvenle silinebilir çünkü state zaten snapshot içinde temsil ediliyor.
 *
 *   Log: [0, 1, 2, ..., 999, 1000, 1001, ...]
 *   Snapshot alındı (state @ index 999)
 *   Compact(999) → Log: [1000, 1001, ...]
 *   Restart: Snapshot(999) yükle + Log[1000..] replay et
 *
 * Kritik kural: Compaction yalnızca commitIndex'e kadar olan girdileri siler.
 * Henüz commit edilmemiş girdiler asla silinemez (veri kaybı riski).
 */

import type { ILogCompactor, LogIndex, RaftLogEntry } from "../consensus-types.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";

// ─── Compaction Politikası ────────────────────────────────────────────────────

export interface CompactionPolicy {
  /** Log bu boyutu aşınca otomatik compaction tetiklenir */
  triggerSize:        number;
  /** Compaction sonrası tutulacak minimum girdi sayısı (son N girdi, debug için) */
  retainTail:          number;
  /** Compaction işlemi arası minimum süre (ms) — çok sık tetiklenmeyi önler */
  minIntervalMs:       number;
}

const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  triggerSize:    10_000,
  retainTail:     100,
  minIntervalMs:  60_000, // 1 dakika
};

// ─── Compaction Sonucu ────────────────────────────────────────────────────────

export interface CompactionResult {
  /** Compaction öncesi log uzunluğu */
  beforeLength:   number;
  /** Compaction sonrası log uzunluğu */
  afterLength:    number;
  /** Kaç girdi silindi */
  truncated:      number;
  /** Bu index'e kadar (dahil) silindi */
  upToIndex:      LogIndex;
  /** Silinen girdilerin checksum özeti (denetim için) */
  truncatedDigest: string;
  /** İşlem süresi (ms) */
  durationMs:     number;
  /** Ne zaman yapıldı */
  compactedAt:    Date;
}

// ─── IncrementalLogCompactor ──────────────────────────────────────────────────

/**
 * Gerçek log compaction implementasyonu.
 *
 * Aşama 15'teki NoopLogCompactor'ın yerini alır.
 * RaftEngine.compact() bu sınıfı kullanarak log'u güvenle kısaltır.
 *
 * "Incremental" adlandırması: tüm log'u tek seferde silmek yerine,
 * her snapshot alımında küçük artımlı kesmeler yapılır — büyük
 * duraklamalar (stop-the-world) önlenir.
 */
export class IncrementalLogCompactor implements ILogCompactor {
  private _lastCompacted: LogIndex = -1;
  private _lastCompactionAt = 0;
  private readonly history: CompactionResult[] = [];
  private readonly cfg: CompactionPolicy;

  constructor(
    cfg: Partial<CompactionPolicy> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg = { ...DEFAULT_COMPACTION_POLICY, ...cfg };
  }

  /**
   * ILogCompactor sözleşmesi — RaftEngine.compact() tarafından çağrılır.
   * Gerçek log mutasyonu RaftEngine içinde yapılır; bu metot yalnızca
   * "bu index'e kadar compact edildi" bilgisini kaydeder ve metrik üretir.
   */
  async compact(upToIndex: LogIndex): Promise<void> {
    if (upToIndex <= this._lastCompacted) return; // zaten compact edilmiş
    this._lastCompacted = upToIndex;
    this._lastCompactionAt = Date.now();
    this.logger?.debug(`Log compaction kaydı: upToIndex=${upToIndex}`);
  }

  lastCompacted(): LogIndex {
    return this._lastCompacted;
  }

  /**
   * Bu compactor otomatik tetiklenmeli mi?
   * Politika: log boyutu eşiği aştı VE minimum aralık geçti.
   */
  shouldTrigger(currentLogLength: LogIndex, commitIndex: LogIndex): boolean {
    if (commitIndex <= this._lastCompacted) return false; // commit edilmemiş kısım yok
    if (currentLogLength < this.cfg.triggerSize) return false;
    if (Date.now() - this._lastCompactionAt < this.cfg.minIntervalMs) return false;
    return true;
  }

  /**
   * Gerçek log kesme işlemi — RaftEngine'in log dizisi üzerinde çalışır.
   * Yalnızca commitIndex'e kadar (retainTail kadar son girdi hariç) keser.
   *
   * @param log          Mevcut tam log
   * @param commitIndex  Commit edilmiş en yüksek index (bunun ötesi asla silinmez)
   * @returns            Kesilmiş yeni log + işlem raporu
   */
  async truncate(
    log:         RaftLogEntry[],
    commitIndex: LogIndex
  ): Promise<{ newLog: RaftLogEntry[]; result: CompactionResult }> {
    const t0 = Date.now();
    const beforeLength = log.length;

    // Güvenli kesme noktası: commitIndex - retainTail (asla commit edilmemişi silme)
    const safeUpTo = Math.min(commitIndex, log.length - 1) - this.cfg.retainTail;
    const upToIndex = Math.max(-1, safeUpTo);

    if (upToIndex <= this._lastCompacted || upToIndex < 0) {
      // Kesilecek bir şey yok
      return {
        newLog: log,
        result: {
          beforeLength, afterLength: beforeLength, truncated: 0,
          upToIndex: this._lastCompacted, truncatedDigest: "0".repeat(64),
          durationMs: Date.now() - t0, compactedAt: new Date(),
        },
      };
    }

    // Silinecek girdileri bul (index alanına göre, dizi pozisyonuna göre değil)
    const truncatedEntries = log.filter((e) => e.index <= upToIndex);
    const remainingEntries = log.filter((e) => e.index > upToIndex);

    // Denetim için silinen girdilerin özet hash'i
    const digest = await this._computeDigest(truncatedEntries);

    await this.compact(upToIndex);

    const result: CompactionResult = {
      beforeLength,
      afterLength:     remainingEntries.length,
      truncated:        truncatedEntries.length,
      upToIndex,
      truncatedDigest: digest,
      durationMs:      Date.now() - t0,
      compactedAt:     new Date(),
    };

    this.history.unshift(result);
    if (this.history.length > 50) this.history.pop();

    this.logger?.info(
      `Log compaction: ${beforeLength} → ${remainingEntries.length} ` +
      `(${truncatedEntries.length} girdi silindi, upToIndex=${upToIndex}, ${result.durationMs}ms)`
    );

    return { newLog: remainingEntries, result };
  }

  /** Compaction geçmişi (denetim/debug için) */
  getHistory(n = 10): CompactionResult[] {
    return this.history.slice(0, n);
  }

  /** Toplam silinen girdi sayısı (yaşam boyu) */
  totalTruncated(): number {
    return this.history.reduce((sum, r) => sum + r.truncated, 0);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async _computeDigest(entries: RaftLogEntry[]): Promise<string> {
    if (entries.length === 0) return "0".repeat(64);
    const last = entries.at(-1)!;
    return sha256Hex(`${entries.length}:${last.index}:${last.term}:${last.checksum}`);
  }
}

// ─── NoopLogCompactor Notu ────────────────────────────────────────────────────

/**
 * NoopLogCompactor zaten consensus-types.ts içinde tanımlı ve oradan
 * export edilir (consensus/index.ts → export * from "../consensus-types.ts").
 * Burada yeniden export EDİLMEZ — aksi halde index.ts'te isim çakışması
 * oluşur (iki farklı dosyadan aynı isim export edilemez).
 *
 * Kullanım: import { NoopLogCompactor } from "../consensus-types.ts";
 */
