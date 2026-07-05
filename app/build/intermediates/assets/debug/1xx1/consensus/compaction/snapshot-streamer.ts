/**
 * 1XX1 Snapshot Streaming
 * Aşama 18 — Snapshot + Log Compaction
 *
 * Büyük state'i (örn. 100K projeli full snapshot) tek mesajda göndermek
 * Aşama 14'ün MessageEnvelope/Gossip katmanını tıkar. Bu modül, Aşama 16'daki
 * Content-Addressed chunk mantığıyla simetrik bir streaming protokolü sağlar:
 *
 *   IncrementalSnapshot → JSON serialize → chunk'lara böl (CID + checksum)
 *   → SnapshotChunk[] sırayla/paralel transfer
 *   → alıcı tarafta chunk'lar toplanır + doğrulanır + deserialize edilir
 *
 * Bu, Aşama 16'nın ContentAddresser'ından FARKLIDIR: o dosya binary'si
 * için, bu ise konsensüs state JSON'u için tasarlandı. Ancak chunk/hash
 * doğrulama prensibi aynıdır — kod tekrarını önlemek için sha256Hex
 * paylaşılır.
 */

import type { IncrementalSnapshot } from "./incremental-snapshot.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Snapshot Chunk ───────────────────────────────────────────────────────────

export const SNAPSHOT_CHUNK_SIZE = 256 * 1024; // 256 KB (state JSON için, asset'ten daha küçük)

export interface SnapshotChunkMeta {
  snapshotHash: string;
  chunkIndex:   number;
  totalChunks:  number;
  chunkHash:    string;
  size:         number;
}

export interface SnapshotChunk {
  meta: SnapshotChunkMeta;
  data: string; // JSON string parçası
}

// ─── Stream Durumu ────────────────────────────────────────────────────────────

export type StreamStatus = "pending" | "streaming" | "assembling" | "completed" | "failed";

export interface StreamProgress {
  snapshotHash:   string;
  totalChunks:    number;
  receivedChunks: number;
  status:         StreamStatus;
}

// ─── SnapshotStreamer ─────────────────────────────────────────────────────────

export class SnapshotStreamer {
  constructor(logger?: ILogger) {
    this.logger = logger;}

  // ─── Gönderen Taraf: Böl ──────────────────────────────────────────────────

  /**
   * Bir IncrementalSnapshot'ı JSON'a çevirip chunk'lara böler.
   * Her chunk kendi hash'ini taşır — Aşama 16'daki ChunkDescriptor ile
   * aynı doğrulama prensibi.
   */
  async split(snapshot: IncrementalSnapshot): Promise<{
    snapshotHash: string;
    chunks: SnapshotChunk[];
  }> {
    const json = JSON.stringify(snapshot);
    const totalChunks = Math.ceil(json.length / SNAPSHOT_CHUNK_SIZE);
    const chunks: SnapshotChunk[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * SNAPSHOT_CHUNK_SIZE;
      const end   = Math.min(start + SNAPSHOT_CHUNK_SIZE, json.length);
      const data  = json.slice(start, end);
      const chunkHash = await sha256Hex(data);

      chunks.push({
        meta: {
          snapshotHash: snapshot.hash,
          chunkIndex:   i,
          totalChunks,
          chunkHash,
          size:         data.length,
        },
        data,
      });
    }

    this.logger?.debug(
      `Snapshot bölündü: ${snapshot.hash.slice(0, 12)}... → ${totalChunks} chunk`
    );

    return { snapshotHash: snapshot.hash, chunks };
  }

  // ─── Alıcı Taraf: Topla ───────────────────────────────────────────────────

  /**
   * Chunk'ları doğrulayıp birleştirir, orijinal IncrementalSnapshot'ı
   * deserialize eder. Sıra karışık gelse bile chunkIndex'e göre sıralar.
   */
  async assemble(chunks: SnapshotChunk[]): Promise<{
    ok: boolean;
    snapshot?: IncrementalSnapshot;
    error?: string;
  }> {
    if (chunks.length === 0) return { ok: false, error: "Boş chunk listesi" };

    const expectedTotal = chunks[0].meta.totalChunks;
    if (chunks.length !== expectedTotal) {
      return { ok: false, error: `Eksik chunk: ${chunks.length}/${expectedTotal}` };
    }

    // Her chunk'ı doğrula
    for (const chunk of chunks) {
      const actualHash = await sha256Hex(chunk.data);
      if (actualHash !== chunk.meta.chunkHash) {
        return { ok: false, error: `Chunk ${chunk.meta.chunkIndex} bozuk` };
      }
    }

    // Sırala ve birleştir
    const sorted = [...chunks].sort((a, b) => a.meta.chunkIndex - b.meta.chunkIndex);
    const json   = sorted.map((c) => c.data).join("");

    try {
      const snapshot = JSON.parse(json) as IncrementalSnapshot;
      // Bütünlük: birleştirilmiş JSON'dan üretilen snapshot.hash, chunk meta'sındaki
      // snapshotHash ile eşleşmeli (chunk üretimi sırasında snapshot zaten hash'liydi)
      if (snapshot.hash !== chunks[0].meta.snapshotHash) {
        return { ok: false, error: "Snapshot hash uyuşmazlığı — bütünlük ihlali" };
      }
      return { ok: true, snapshot };
    } catch {
      return { ok: false, error: "JSON deserialize hatası" };
    }
  }

  // ─── İlerleme Takibi ──────────────────────────────────────────────────────

  /**
   * Akış sırasında alınan chunk'lardan ilerleme durumu hesapla.
   * Gerçek transfer mantığı (peer seçimi, retry) Aşama 16'nın
   * TransferEngine'i ile aynı desende üst katmanda uygulanabilir;
   * bu metot yalnızca durum hesaplaması sağlar.
   */
  progress(received: SnapshotChunk[], expectedTotal: number): StreamProgress {
    const snapshotHash = received[0]?.meta.snapshotHash ?? "";
    const receivedChunks = received.length;
    const status: StreamStatus =
      receivedChunks === 0 ? "pending" :
      receivedChunks < expectedTotal ? "streaming" :
      "assembling";

    return { snapshotHash, totalChunks: expectedTotal, receivedChunks, status };
  }
}
