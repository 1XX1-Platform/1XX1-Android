/**
 * 1XX1 Chunk Store + Content Registry
 * Aşama 16 — P2P Asset Transfer
 *
 * IChunkStore: chunk'ları saklar ve birleştirir.
 * ContentRegistry: hangi peer hangi CID'yi biliyor.
 *
 * In-memory implementasyon → Aşama 18'de disk/IPFS adaptörü.
 */

import type {
  ContentId, ContentAddress, ContentLocation,
  ChunkDescriptor, ChunkData, IChunkStore,
} from "../p2p-types.ts";

// ─── InMemoryChunkStore ───────────────────────────────────────────────────────

export class InMemoryChunkStore implements IChunkStore {
  /** cid → chunkIndex → ChunkData */
  private readonly chunks = new Map<ContentId, Map<number, ChunkData>>();
  /** Toplam saklanan byte */
  private _totalBytes = 0;

  async putChunk(descriptor: ChunkDescriptor, data: Uint8Array): Promise<void> {
    if (!this.chunks.has(descriptor.cid)) {
      this.chunks.set(descriptor.cid, new Map());
    }
    const cidMap = this.chunks.get(descriptor.cid)!;
    if (!cidMap.has(descriptor.chunkIndex)) {
      this._totalBytes += data.byteLength;
    }
    cidMap.set(descriptor.chunkIndex, { descriptor, data });
  }

  async getChunk(cid: ContentId, index: number): Promise<ChunkData | null> {
    return this.chunks.get(cid)?.get(index) ?? null;
  }

  async isComplete(cid: ContentId, totalChunks: number): Promise<boolean> {
    const cidMap = this.chunks.get(cid);
    if (!cidMap) return false;
    for (let i = 0; i < totalChunks; i++) {
      if (!cidMap.has(i)) return false;
    }
    return true;
  }

  async assemble(cid: ContentId, totalChunks: number): Promise<Uint8Array | null> {
    if (!(await this.isComplete(cid, totalChunks))) return null;

    const cidMap  = this.chunks.get(cid)!;
    const sorted  = Array.from(cidMap.values())
      .sort((a, b) => a.descriptor.chunkIndex - b.descriptor.chunkIndex);

    const totalSize = sorted.reduce((s, c) => s + c.data.byteLength, 0);
    const result    = new Uint8Array(totalSize);
    let offset      = 0;

    for (const chunk of sorted) {
      result.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    return result;
  }

  async chunkCount(cid: ContentId): Promise<number> {
    return this.chunks.get(cid)?.size ?? 0;
  }

  async delete(cid: ContentId): Promise<void> {
    const cidMap = this.chunks.get(cid);
    if (cidMap) {
      for (const { data } of cidMap.values()) this._totalBytes -= data.byteLength;
      this.chunks.delete(cid);
    }
  }

  async listCIDs(): Promise<ContentId[]> {
    return Array.from(this.chunks.keys());
  }

  totalBytes(): number { return this._totalBytes; }
  cidCount():   number { return this.chunks.size; }
}

// ─── ContentRegistry ─────────────────────────────────────────────────────────

/**
 * Hangi peer hangi CID'yi biliyor?
 * Gossip ile Content Announce mesajları alındıkça güncellenir.
 */
export class ContentRegistry {
  private readonly registry = new Map<ContentId, ContentLocation>();
  /** Peer başına sakladığı CID'ler */
  private readonly peerIndex = new Map<string, Set<ContentId>>();

  /** Peer'ın bir CID'yi sakladığını kaydet */
  announce(cid: ContentId, peerId: string, address: ContentAddress): void {
    const existing = this.registry.get(cid);
    if (existing) {
      if (!existing.peers.includes(peerId)) {
        existing.peers.push(peerId);
      }
      existing.seenAt = Date.now();
    } else {
      this.registry.set(cid, {
        cid, address, peers: [peerId], seenAt: Date.now(),
      });
    }

    if (!this.peerIndex.has(peerId)) this.peerIndex.set(peerId, new Set());
    this.peerIndex.get(peerId)!.add(cid);
  }

  /** Bu CID'yi sağlayabilecek peer'lar */
  providers(cid: ContentId): string[] {
    return this.registry.get(cid)?.peers ?? [];
  }

  /** Bu CID hakkında ne biliyoruz? */
  find(cid: ContentId): ContentLocation | null {
    return this.registry.get(cid) ?? null;
  }

  /** Bu peer hangi CID'leri biliyor? */
  peerCIDs(peerId: string): ContentId[] {
    return Array.from(this.peerIndex.get(peerId) ?? []);
  }

  /** Peer ayrıldığında temizle */
  removePeer(peerId: string): void {
    const cids = this.peerIndex.get(peerId) ?? new Set();
    for (const cid of cids) {
      const loc = this.registry.get(cid);
      if (loc) {
        loc.peers = loc.peers.filter((p) => p !== peerId);
        if (loc.peers.length === 0) this.registry.delete(cid);
      }
    }
    this.peerIndex.delete(peerId);
  }

  /** Yaşlı kayıtları temizle (TTL ms) */
  prune(ttlMs: number = 5 * 60_000): number {
    const cutoff = Date.now() - ttlMs;
    let pruned   = 0;
    for (const [cid, loc] of this.registry) {
      if (loc.seenAt < cutoff && loc.peers.length === 0) {
        this.registry.delete(cid);
        pruned++;
      }
    }
    return pruned;
  }

  stats() {
    return {
      knownCIDs:  this.registry.size,
      peerCount:  this.peerIndex.size,
    };
  }
}
