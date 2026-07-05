/**
 * 1XX1 P2P Asset Transfer — Tipler
 * Aşama 16 — P2P Asset Transfer & Content-Addressed Storage
 *
 * Temel prensipler:
 *   1. İçerik hash'i ile adreslenir (SHA-256 = Content ID)
 *   2. Gossip yalnızca metadata ve CID taşır (dosya verisi değil)
 *   3. Büyük dosyalar chunk'lara bölünür (1–4 MB)
 *   4. Chunk indirme paralel ve doğrulamalı
 *   5. Transfer tamamlanınca tam dosya hash yeniden hesaplanır
 *   6. Transport adapter (QUIC stub, libp2p stub, Memory gerçek)
 */

// ─── Content ID ───────────────────────────────────────────────────────────────

/** Content-Addressed ID: sha256(içerik) */
export type ContentId = string;

export interface ContentAddress {
  cid:      ContentId;  // SHA-256 hex
  size:     number;     // toplam byte
  mimeType: string;
  chunks:   number;     // kaç chunk
}

// ─── Chunk ───────────────────────────────────────────────────────────────────

export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB

export interface ChunkDescriptor {
  cid:        ContentId;  // parent CID
  chunkIndex: number;
  chunkHash:  string;     // SHA-256(chunk data)
  offset:     number;     // dosyadaki başlangıç byte
  size:       number;     // chunk byte boyutu
}

export interface ChunkData {
  descriptor: ChunkDescriptor;
  data:       Uint8Array;
}

// ─── Transfer Durumu ─────────────────────────────────────────────────────────

export type TransferStatus =
  | "pending"       // başlamadı
  | "connecting"    // peer'a bağlanılıyor
  | "transferring"  // chunk'lar alınıyor
  | "verifying"     // hash doğrulanıyor
  | "completed"     // tamamlandı
  | "failed"        // hata
  | "cancelled";    // iptal

export interface TransferProgress {
  cid:           ContentId;
  totalChunks:   number;
  receivedChunks: number;
  totalBytes:    number;
  receivedBytes: number;
  speedBytesPerSec: number;
  estimatedSecs:  number;
  status:        TransferStatus;
}

// ─── P2P Mesaj Tipleri ───────────────────────────────────────────────────────

export type P2PMessageType =
  | "content:announce"    // "Bu CID'yi saklıyorum"
  | "content:request"     // "Bu CID'yi istiyorum"
  | "content:not_found"   // "Bu CID'yi bilmiyorum"
  | "chunk:request"       // "Chunk N'yi ver"
  | "chunk:response"      // "Chunk N budur"
  | "chunk:not_found"     // "Bu chunk yok"
  | "transfer:cancel"     // "Transfer iptal"
  | "transfer:complete";  // "Transfer onay"

export interface P2PMessage {
  type:      P2PMessageType;
  messageId: string;
  senderId:  string;
  cid:       ContentId;
  payload:   unknown;
}

export interface ContentAnnouncePayload {
  cid:       ContentId;
  size:      number;
  mimeType:  string;
  chunks:    number;
  chunkSize: number;
}

export interface ChunkRequestPayload {
  cid:        ContentId;
  chunkIndex: number;
}

export interface ChunkResponsePayload {
  cid:        ContentId;
  chunkIndex: number;
  data:       string;   // base64 encoded (JSON safe)
  chunkHash:  string;
}

// ─── P2P Transport Arayüzü ───────────────────────────────────────────────────

export type P2PMessageHandler = (msg: P2PMessage, fromPeerId: string) => void | Promise<void>;

export interface IP2PTransport {
  readonly name:   string;
  readonly nodeId: string;
  start(): Promise<void>;
  stop():  Promise<void>;
  send(toPeerId: string, msg: P2PMessage): Promise<boolean>;
  onMessage(handler: P2PMessageHandler): void;
  peers(): string[];
  addPeer(peerId: string, address?: string): void;
  removePeer(peerId: string): void;
  isConnected(): boolean;
}

// ─── Content Registry ────────────────────────────────────────────────────────

/** Hangi peer hangi CID'yi biliyor */
export interface ContentLocation {
  cid:      ContentId;
  peers:    string[];  // bu CID'yi sağlayabilecek peer'lar
  address:  ContentAddress;
  seenAt:   number;   // son görülme (unix ms)
}

// ─── Chunk Store Arayüzü ─────────────────────────────────────────────────────

export interface IChunkStore {
  /** Chunk kaydet */
  putChunk(descriptor: ChunkDescriptor, data: Uint8Array): Promise<void>;
  /** Chunk al */
  getChunk(cid: ContentId, index: number): Promise<ChunkData | null>;
  /** Tüm chunk'lar tamam mı? */
  isComplete(cid: ContentId, totalChunks: number): Promise<boolean>;
  /** Tam içeriği birleştir */
  assemble(cid: ContentId, totalChunks: number): Promise<Uint8Array | null>;
  /** Chunk sayısı */
  chunkCount(cid: ContentId): Promise<number>;
  /** Bu CID'ye ait chunk'ları sil */
  delete(cid: ContentId): Promise<void>;
  /** Saklanan tüm CID'ler */
  listCIDs(): Promise<ContentId[]>;
}
