/**
 * 1XX1 Fast Join Protokolü
 * Aşama 18 — Snapshot + Log Compaction
 *
 * Yeni bir düğüm ağa katıldığında, tüm Event Log'u baştan replay etmek
 * (Aşama 14'ün orijinal recovery akışı) sistem yıllarca çalıştıysa
 * dakikalar/saatler sürebilir. Fast Join bunun yerine:
 *
 *   1. Mevcut bir validator'dan en son FULL snapshot iste
 *   2. Snapshot'ı stream et (SnapshotStreamer ile chunk'lı)
 *   3. Snapshot'ı uygula (store'ları doldur)
 *   4. Yalnızca snapshot SONRASI log girdilerini replay et (genellikle çok az)
 *   5. Validator setine katıl (Raft propose ile)
 *
 * Bu akış: O(log_size) yerine O(delta_since_snapshot) karmaşıklığına iner.
 */

import type { IncrementalSnapshot } from "../compaction/incremental-snapshot.ts";
import { IncrementalSnapshotBuilder, restoreFromChain } from "../compaction/incremental-snapshot.ts";
import { SnapshotStreamer, type SnapshotChunk } from "../compaction/snapshot-streamer.ts";
import type { StoreCollection, EventLog, EventLogEntry } from "../../distributed/sync/sync-engine.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Join İsteği/Yanıtı ───────────────────────────────────────────────────────

export interface JoinRequest {
  requestingNodeId: string;
  publicKey:        string;
  /** İstemci protokol versiyonu — uyumluluk kontrolü için */
  protocolVersion:  string;
}

export type JoinDecision = "accept" | "reject";

export interface JoinOffer {
  decision:        JoinDecision;
  reason?:         string;
  /** Kabul edildiyse: en son full snapshot'ın hash'i (stream başlangıcı) */
  snapshotHash?:   string;
  /** Snapshot sonrası kaç event log girdisi replay edilmesi gerekecek */
  pendingLogCount?: number;
}

// ─── Fast Join Sonucu ─────────────────────────────────────────────────────────

export interface FastJoinResult {
  ok:              boolean;
  error?:          string;
  /** Toplam senkronize edilen kayıt sayısı */
  syncedEntries:   number;
  /** Replay edilen event log girdisi sayısı */
  replayedEvents:  number;
  /** Toplam süre (ms) */
  durationMs:      number;
  /** Kaç chunk transfer edildi */
  chunksTransferred: number;
}

// ─── FastJoinSponsor (Mevcut Düğüm Tarafı) ────────────────────────────────────

/**
 * Ağdaki mevcut bir düğüm, yeni katılan düğüme bu sınıf aracılığıyla
 * snapshot + log delta sağlar ("sponsor" rolü).
 */
export class FastJoinSponsor {
  private readonly streamer = new SnapshotStreamer();

  constructor(
    snapshotBuilder: IncrementalSnapshotBuilder,
    eventLog:        EventLog,
    logger?:         ILogger
  ) {
    this.logger = logger;
    this.eventLog = eventLog;
    this.snapshotBuilder = snapshotBuilder;}

  /**
   * Katılım isteğini değerlendir.
   * Gerçek bir sistemde burada validator izinleri, ban listesi vb. kontrol edilir.
   */
  evaluateJoinRequest(req: JoinRequest, expectedProtocolVersion: string): JoinOffer {
    if (req.protocolVersion !== expectedProtocolVersion) {
      return { decision: "reject", reason: `Protokol uyumsuz: ${req.protocolVersion}` };
    }

    const latest = this.snapshotBuilder.latest();
    if (!latest) {
      return { decision: "reject", reason: "Henüz snapshot alınmadı" };
    }

    const pendingLogCount = this.eventLog.since(latest.eventLogPosition).length;

    return {
      decision: "accept",
      snapshotHash: latest.hash,
      pendingLogCount,
    };
  }

  /**
   * Kabul edilen istek için: en son full snapshot zincirini chunk'lara böl.
   * Yeni düğüm bu chunk'ları transport üzerinden (Aşama 14 gossip veya
   * doğrudan transport) sırayla alır.
   */
  async prepareSnapshotChunks(): Promise<{
    chain: IncrementalSnapshot[];
    chunksPerSnapshot: SnapshotChunk[][];
  }> {
    const chain = this.snapshotBuilder.chainSince();
    const chunksPerSnapshot: SnapshotChunk[][] = [];

    for (const snapshot of chain) {
      const { chunks } = await this.streamer.split(snapshot);
      chunksPerSnapshot.push(chunks);
    }

    this.logger?.info(
      `Fast Join hazırlığı: ${chain.length} snapshot, ` +
      `${chunksPerSnapshot.reduce((s, c) => s + c.length, 0)} toplam chunk`
    );

    return { chain, chunksPerSnapshot };
  }

  /** Snapshot sonrası event log delta'sını döndür (replay için) */
  pendingEvents(sinceLogPosition: number): EventLogEntry[] {
    return this.eventLog.since(sinceLogPosition);
  }
}

// ─── FastJoinClient (Yeni Düğüm Tarafı) ───────────────────────────────────────

/**
 * Ağa yeni katılan düğümün bootstrap akışını yönetir.
 */
export class FastJoinClient {
  private readonly streamer = new SnapshotStreamer();

  constructor(
    targetStores: StoreCollection,
    logger?:      ILogger
  ) {
    this.logger = logger;
    this.targetStores = targetStores;}

  /**
   * Sponsor'dan alınan chunk'ları sırayla işleyip store'ları doldurur,
   * ardından kalan event log girdilerini replay eder.
   *
   * @param chunksPerSnapshot  Sponsor.prepareSnapshotChunks() çıktısı
   * @param pendingEvents      Sponsor.pendingEvents() çıktısı
   * @param applyEvent         Event'i uygulayacak fonksiyon (üst katman state machine)
   */
  async join(
    chunksPerSnapshot: SnapshotChunk[][],
    pendingEvents:     EventLogEntry[],
    applyEvent:        (entry: EventLogEntry) => Promise<void>
  ): Promise<FastJoinResult> {
    const t0 = Date.now();
    let syncedEntries = 0;
    let chunksTransferred = 0;
    const chain: IncrementalSnapshot[] = [];

    // 1. Her snapshot'ı chunk'lardan yeniden inşa et
    for (const chunks of chunksPerSnapshot) {
      const result = await this.streamer.assemble(chunks);
      if (!result.ok || !result.snapshot) {
        return {
          ok: false, error: result.error ?? "Snapshot birleştirme hatası",
          syncedEntries, replayedEvents: 0,
          durationMs: Date.now() - t0, chunksTransferred,
        };
      }
      chain.push(result.snapshot);
      chunksTransferred += chunks.length;
    }

    // 2. Zinciri sırayla uygula (full → incremental → incremental ...)
    const { restoredEntries } = await restoreFromChain(this.targetStores, chain);
    syncedEntries = restoredEntries;

    // 3. Snapshot sonrası kalan event'leri replay et (deterministik sıra)
    let replayedEvents = 0;
    for (const event of pendingEvents) {
      await applyEvent(event);
      replayedEvents++;
    }

    const durationMs = Date.now() - t0;

    this.logger?.info(
      `Fast Join tamamlandı: ${syncedEntries} kayıt + ${replayedEvents} event replay ` +
      `(${chunksTransferred} chunk, ${durationMs}ms)`
    );

    return { ok: true, syncedEntries, replayedEvents, durationMs, chunksTransferred };
  }
}
