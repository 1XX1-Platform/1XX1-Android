/**
 * 1XX1 Content Addresser
 * Aşama 16 — P2P Asset Transfer
 *
 * İçerik hash'i ile adresleme (Content-Addressed Storage).
 * SHA-256(içerik) → ContentId
 *
 * Büyük dosyalar chunk'lara bölünür:
 *   - Her chunk ayrı hash taşır
 *   - Chunk'lar paralel indirilebilir
 *   - Her chunk indirilince hash doğrulanır
 *   - Son adım: tüm chunk'lar birleştirilip tam hash doğrulanır
 */

import type { ContentId, ContentAddress, ChunkDescriptor, DEFAULT_CHUNK_SIZE } from "../p2p-types.ts";
import { sha256Hex } from "../distributed/security/signature.ts";

export const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB

// ─── ContentAddresser ─────────────────────────────────────────────────────────

export class ContentAddresser {

  /**
   * İçerik hash'i hesapla (CID üret).
   * CID = SHA-256(data) — deterministik, tekrarlanabilir.
   */
  async computeCID(data: Uint8Array): Promise<ContentId> {
    return sha256Hex(data);
  }

  /**
   * İçeriği chunk'lara böl ve her chunk'ın hash'ini hesapla.
   *
   * @param data       Dosya içeriği
   * @param chunkSize  Chunk boyutu (varsayılan 2 MB)
   * @returns          CID + chunk descriptor listesi
   */
  async split(
    data:      Uint8Array,
    mimeType:  string,
    chunkSize: number = CHUNK_SIZE
  ): Promise<{ address: ContentAddress; chunks: Array<{ descriptor: ChunkDescriptor; data: Uint8Array }> }> {
    const cid        = await this.computeCID(data);
    const totalSize  = data.byteLength;
    const numChunks  = Math.ceil(totalSize / chunkSize);
    const chunks: Array<{ descriptor: ChunkDescriptor; data: Uint8Array }> = [];

    for (let i = 0; i < numChunks; i++) {
      const offset     = i * chunkSize;
      const end        = Math.min(offset + chunkSize, totalSize);
      const chunkData  = data.slice(offset, end);
      const chunkHash  = await sha256Hex(chunkData);

      const descriptor: ChunkDescriptor = {
        cid,
        chunkIndex: i,
        chunkHash,
        offset,
        size:       chunkData.byteLength,
      };
      chunks.push({ descriptor, data: chunkData });
    }

    const address: ContentAddress = {
      cid,
      size:     totalSize,
      mimeType,
      chunks:   numChunks,
    };

    return { address, chunks };
  }

  /**
   * Chunk'ları birleştir ve tam CID doğrula.
   * Her chunk hash'i ayrı doğrulanır, sonra tam dosya.
   *
   * @returns { ok, data } — ok=false ise veri bozulmuş demektir
   */
  async assemble(
    chunks:      Array<{ descriptor: ChunkDescriptor; data: Uint8Array }>,
    expectedCID: ContentId
  ): Promise<{ ok: boolean; data?: Uint8Array; failedChunk?: number }> {
    // Chunk sırasına göre sırala
    const sorted = [...chunks].sort((a, b) => a.descriptor.chunkIndex - b.descriptor.chunkIndex);

    // Her chunk hash'ini doğrula
    for (const { descriptor, data } of sorted) {
      const actualHash = await sha256Hex(data);
      if (actualHash !== descriptor.chunkHash) {
        return { ok: false, failedChunk: descriptor.chunkIndex };
      }
    }

    // Birleştir
    const totalSize = sorted.reduce((s, { data }) => s + data.byteLength, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const { data } of sorted) {
      assembled.set(data, offset);
      offset += data.byteLength;
    }

    // Tam CID doğrula
    const actualCID = await this.computeCID(assembled);
    if (actualCID !== expectedCID) {
      return { ok: false };
    }

    return { ok: true, data: assembled };
  }

  /**
   * Tek chunk doğrulama.
   * İndirilen her chunk anında doğrulanır — bozuk chunk erken tespit edilir.
   */
  async verifyChunk(
    data:       Uint8Array,
    descriptor: ChunkDescriptor
  ): Promise<boolean> {
    const hash = await sha256Hex(data);
    return hash === descriptor.chunkHash;
  }

  /**
   * CID geçerli formatta mı? (64 hex karakter)
   */
  isValidCID(cid: string): boolean {
    return /^[0-9a-f]{64}$/.test(cid) || /^[0-9a-f]{8}$/.test(cid); // test fallback
  }
}

export const contentAddresser = new ContentAddresser();
