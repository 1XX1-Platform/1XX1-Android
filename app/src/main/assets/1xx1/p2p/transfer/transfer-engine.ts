/**
 * 1XX1 Transfer Engine
 * Aşama 16 — P2P Asset Transfer
 *
 * Paralel chunk indirme, doğrulama ve birleştirme.
 *
 * Akış:
 *   ContentRegistry.providers(cid) → peer listesi
 *   → paralel ChunkRequest (concurrency = 4)
 *   → her chunk: hash doğrula
 *   → isComplete? → assemble → tam CID doğrula
 *   → TransferProgress güncelle
 *
 * Retry: başarısız chunk → farklı peer'dan dene (max 3 deneme)
 */

import type {
  ContentId, ContentAddress, ChunkDescriptor, ChunkData,
  TransferProgress, TransferStatus, IP2PTransport, P2PMessage,
  ChunkRequestPayload, ChunkResponsePayload,
} from "../p2p-types.ts";
import type { IChunkStore } from "../p2p-types.ts";
import type { ContentRegistry } from "../content/chunk-store.ts";
import { ContentAddresser } from "../content/content-addresser.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Transfer Görev Takibi ────────────────────────────────────────────────────

export interface TransferTask {
  cid:        ContentId;
  address:    ContentAddress;
  status:     TransferStatus;
  startedAt:  number;
  updatedAt:  number;
  progress:   TransferProgress;
  /** Bekleyen chunk index'leri */
  pending:    Set<number>;
  /** Şu an indirilen chunk'lar */
  inflight:   Set<number>;
  /** Kaç kez başarısız */
  retries:    Map<number, number>;
}

// ─── Transfer Config ─────────────────────────────────────────────────────────

export interface TransferConfig {
  /** Eş zamanlı chunk indirme sayısı */
  concurrency:   number;
  /** Chunk başına max deneme */
  maxRetries:    number;
  /** Chunk yanıt bekleme (ms) */
  chunkTimeoutMs: number;
}

const DEFAULT_TRANSFER_CONFIG: TransferConfig = {
  concurrency:    4,
  maxRetries:     3,
  chunkTimeoutMs: 30_000,
};

// ─── TransferEngine ───────────────────────────────────────────────────────────

export class TransferEngine {
  private readonly addresser = new ContentAddresser();
  private readonly tasks     = new Map<ContentId, TransferTask>();
  private readonly cfg:       TransferConfig;

  /** Beklenen chunk yanıtları: `${cid}:${chunkIndex}` → resolve */
  private readonly pending = new Map<string, (data: ChunkData | null) => void>();

  constructor(
    transport: IP2PTransport,
    store:     IChunkStore,
    registry:  ContentRegistry,
    cfg:             Partial<TransferConfig> = {},
    logger?:   ILogger
  ) {
    this.transport = transport;
    this.store = store;
    this.registry = registry;
    this.logger = logger;
    this.cfg = { ...DEFAULT_TRANSFER_CONFIG, ...cfg };

    // Gelen P2P mesajlarını dinle
    this.transport.onMessage((msg, from) => this._handleMessage(msg, from));
  }

  // ─── İndirme ─────────────────────────────────────────────────────────────

  /**
   * Bir CID'yi indirmeye başla.
   * Provider peer'lar ContentRegistry'den alınır.
   * Paralel chunk indirme (concurrency=4).
   */
  async download(cid: ContentId): Promise<{
    ok:     boolean;
    data?:  Uint8Array;
    error?: string;
    durationMs: number;
  }> {
    const startMs = Date.now();
    const location = this.registry.find(cid);

    if (!location) {
      return { ok: false, error: "CID bulunamadı — provider yok", durationMs: 0 };
    }

    const { address } = location;

    // Zaten tamam mı?
    if (await this.store.isComplete(cid, address.chunks)) {
      const data = await this.store.assemble(cid, address.chunks);
      return { ok: !!data, data: data ?? undefined, durationMs: Date.now() - startMs };
    }

    const task: TransferTask = {
      cid,
      address,
      status:    "transferring",
      startedAt: startMs,
      updatedAt: startMs,
      progress: {
        cid, totalChunks: address.chunks, receivedChunks: 0,
        totalBytes: address.size, receivedBytes: 0,
        speedBytesPerSec: 0, estimatedSecs: 0, status: "transferring",
      },
      pending:  new Set(Array.from({ length: address.chunks }, (_, i) => i)),
      inflight: new Set(),
      retries:  new Map(),
    };
    this.tasks.set(cid, task);

    this.logger?.info(`Transfer başladı: ${cid.slice(0, 16)}... (${address.chunks} chunk)`);

    // Paralel chunk indirme
    await this._downloadChunks(task, location.peers);

    const durationMs = Date.now() - startMs;

    // Tamamlandı mı?
    if (!(await this.store.isComplete(cid, address.chunks))) {
      task.status = "failed";
      return { ok: false, error: "Bazı chunk'lar indirilemedi", durationMs };
    }

    // Birleştir ve tam CID doğrula
    task.status = "verifying";
    const assembled = await this.store.assemble(cid, address.chunks);
    if (!assembled) {
      task.status = "failed";
      return { ok: false, error: "Birleştirme başarısız", durationMs };
    }

    const actualCID = await this.addresser.computeCID(assembled);
    if (actualCID !== cid) {
      task.status = "failed";
      return { ok: false, error: "Tam CID doğrulama başarısız — veri bozulmuş", durationMs };
    }

    task.status = "completed";
    this.logger?.info(`Transfer tamamlandı: ${cid.slice(0, 16)}... (${durationMs}ms)`);
    return { ok: true, data: assembled, durationMs };
  }

  // ─── Yükleme (Announce) ──────────────────────────────────────────────────

  /**
   * Bir içeriği peer'lara duyur.
   * Dosya verisi yayılmaz — yalnızca CID + metadata.
   */
  async announce(cid: ContentId, address: ContentAddress): Promise<void> {
    const msg: P2PMessage = {
      type:      "content:announce",
      messageId: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      senderId:  this.transport.nodeId,
      cid,
      payload:   {
        cid, size: address.size, mimeType: address.mimeType,
        chunks: address.chunks, chunkSize: 2 * 1024 * 1024,
      },
    };

    // Tüm bilinen peer'lara duyur
    await Promise.all(this.transport.peers().map((p) => this.transport.send(p, msg)));
    this.logger?.debug(`Duyuruldu: ${cid.slice(0, 16)}... → ${this.transport.peers().length} peer`);
  }

  /** Transfer durumu */
  progress(cid: ContentId): TransferProgress | null {
    return this.tasks.get(cid)?.progress ?? null;
  }

  /** Aktif transfer sayısı */
  activeCount(): number {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === "transferring").length;
  }

  // ─── Private: Paralel Chunk İndirme ──────────────────────────────────────

  private async _downloadChunks(task: TransferTask, peers: string[]): Promise<void> {
    // Concurrency ile chunk'ları işle
    const semaphore = new Semaphore(this.cfg.concurrency);

    const downloadOne = async (chunkIndex: number): Promise<void> => {
      await semaphore.acquire();
      try {
        await this._downloadChunk(task, chunkIndex, peers);
      } finally {
        semaphore.release();
      }
    };

    const allChunks = Array.from(task.pending);
    await Promise.all(allChunks.map(downloadOne));
  }

  private async _downloadChunk(
    task:       TransferTask,
    chunkIndex: number,
    peers:      string[]
  ): Promise<void> {
    const maxRetries = this.cfg.maxRetries;
    let   attempt    = 0;

    while (attempt < maxRetries) {
      // Sıradaki peer'ı seç (round-robin)
      const peer = peers[(chunkIndex + attempt) % peers.length];
      if (!peer) break;

      try {
        const chunkData = await this._requestChunk(task.cid, chunkIndex, peer);
        if (!chunkData) { attempt++; continue; }

        // Chunk hash doğrula
        const valid = await this.addresser.verifyChunk(chunkData.data, chunkData.descriptor);
        if (!valid) {
          this.logger?.warn(`Chunk hash hatası: ${task.cid.slice(0, 12)} [${chunkIndex}]`);
          attempt++;
          continue;
        }

        // Chunk'u kaydet
        await this.store.putChunk(chunkData.descriptor, chunkData.data);
        task.pending.delete(chunkIndex);

        // Progress güncelle
        task.progress.receivedChunks++;
        task.progress.receivedBytes += chunkData.data.byteLength;
        const elapsedS = (Date.now() - task.startedAt) / 1000;
        task.progress.speedBytesPerSec = elapsedS > 0
          ? Math.round(task.progress.receivedBytes / elapsedS) : 0;
        const remaining = task.address.size - task.progress.receivedBytes;
        task.progress.estimatedSecs = task.progress.speedBytesPerSec > 0
          ? remaining / task.progress.speedBytesPerSec : 0;
        task.updatedAt = Date.now();
        return; // başarılı

      } catch (err) {
        this.logger?.debug(`Chunk ${chunkIndex} hata (attempt ${attempt}): ${err}`);
        attempt++;
      }
    }

    this.logger?.warn(`Chunk indirilemedi: ${task.cid.slice(0, 12)} [${chunkIndex}] (${maxRetries} deneme)`);
  }

  private async _requestChunk(
    cid:        ContentId,
    chunkIndex: number,
    peer:       string
  ): Promise<ChunkData | null> {
    const key     = `${cid}:${chunkIndex}`;
    const timeout = this.cfg.chunkTimeoutMs;

    const promise = new Promise<ChunkData | null>((resolve) => {
      this.pending.set(key, resolve);
      setTimeout(() => {
        if (this.pending.has(key)) {
          this.pending.delete(key);
          resolve(null);
        }
      }, timeout);
    });

    await this.transport.send(peer, {
      type:      "chunk:request",
      messageId: `req_${Date.now()}_${chunkIndex}`,
      senderId:  this.transport.nodeId,
      cid,
      payload:   { cid, chunkIndex } satisfies ChunkRequestPayload,
    });

    return promise;
  }

  // ─── Gelen Mesaj İşleme ───────────────────────────────────────────────────

  private async _handleMessage(msg: P2PMessage, from: string): Promise<void> {
    switch (msg.type) {
      case "content:announce":
        this._handleAnnounce(msg, from);
        break;

      case "chunk:request":
        await this._handleChunkRequest(msg, from);
        break;

      case "chunk:response":
        this._handleChunkResponse(msg);
        break;

      case "content:request":
        await this._handleContentRequest(msg, from);
        break;
    }
  }

  private _handleAnnounce(msg: P2PMessage, from: string): void {
    const p = msg.payload as {
      cid: ContentId; size: number; mimeType: string; chunks: number;
    };
    this.registry.announce(p.cid, from, {
      cid: p.cid, size: p.size, mimeType: p.mimeType, chunks: p.chunks,
    });
  }

  private async _handleChunkRequest(msg: P2PMessage, from: string): Promise<void> {
    const req = msg.payload as ChunkRequestPayload;
    const chunk = await this.store.getChunk(req.cid, req.chunkIndex);

    if (!chunk) {
      await this.transport.send(from, {
        type: "chunk:not_found", messageId: `nf_${Date.now()}`,
        senderId: this.transport.nodeId, cid: req.cid, payload: req,
      });
      return;
    }

    // Chunk verisini base64'e çevir (P2PMessage JSON safe)
    const b64 = Buffer.from(chunk.data).toString("base64");
    await this.transport.send(from, {
      type: "chunk:response", messageId: `res_${Date.now()}`,
      senderId: this.transport.nodeId, cid: req.cid,
      payload: {
        cid: req.cid, chunkIndex: req.chunkIndex,
        data: b64, chunkHash: chunk.descriptor.chunkHash,
      } satisfies ChunkResponsePayload,
    });
  }

  private _handleChunkResponse(msg: P2PMessage): void {
    const res  = msg.payload as ChunkResponsePayload;
    const key  = `${res.cid}:${res.chunkIndex}`;
    const resolve = this.pending.get(key);
    if (!resolve) return;

    this.pending.delete(key);
    try {
      const data = new Uint8Array(Buffer.from(res.data, "base64"));
      const descriptor: ChunkDescriptor = {
        cid: res.cid, chunkIndex: res.chunkIndex,
        chunkHash: res.chunkHash, offset: 0, size: data.byteLength,
      };
      resolve({ descriptor, data });
    } catch {
      resolve(null);
    }
  }

  private async _handleContentRequest(msg: P2PMessage, from: string): Promise<void> {
    const location = this.registry.find(msg.cid);
    if (!location) {
      await this.transport.send(from, {
        type: "content:not_found", messageId: `nf_${Date.now()}`,
        senderId: this.transport.nodeId, cid: msg.cid, payload: {},
      });
    }
  }
}

// ─── Semaphore ───────────────────────────────────────────────────────────────

class Semaphore {
  private _count: number;
  private readonly _queue: Array<() => void> = [];

  constructor(count: number) { this._count = count; }

  acquire(): Promise<void> {
    if (this._count > 0) { this._count--; return Promise.resolve(); }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._count++;
    }
  }
}
