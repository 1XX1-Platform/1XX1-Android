/**
 * 1XX1 Message Envelope
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 *
 * Dağıtık sistemdeki her mesaj bu zarfı taşır.
 * payload:any yasaktır — her tür kendi envelope'una sahiptir.
 *
 * İşlem sırası (zorunlu):
 *   Checksum → Signature → ProtocolVersion → TTL → Deserialize → Validation → Dispatch
 *
 * Envelope immutable'dır. Oluşturulduktan sonra alanlar değiştirilemez.
 */

// ─── Protokol Versiyonu ───────────────────────────────────────────────────────

export const PROTOCOL_VERSION = "1.0.0" as const;

export type ProtocolVersion = string;

// ─── Mesaj Tipleri ────────────────────────────────────────────────────────────

export type MessageType =
  | "gossip:data"       // veri yayılımı
  | "gossip:ack"        // alındı onayı
  | "heartbeat:ping"    // sağlık denetimi
  | "heartbeat:pong"    // sağlık yanıtı
  | "sync:request"      // senkronizasyon isteği
  | "sync:response"     // senkronizasyon yanıtı
  | "sync:delta"        // artımlı güncelleme
  | "snapshot:offer"    // snapshot teklifi
  | "snapshot:request"  // snapshot isteği
  | "snapshot:chunk"    // snapshot parçası
  | "peer:announce"     // düğüm kendini tanıtıyor
  | "peer:leave"        // düğüm ayrılıyor
  | "event:log"         // event log kaydı
  | "conflict:notify";  // çakışma bildirimi

// ─── Topic Tipleri ────────────────────────────────────────────────────────────

export type Topic =
  | "projects"
  | "assets"
  | "releases"
  | "channels"
  | "pulse"
  | "policies"
  | "peers"
  | "system";

// ─── Envelope Payload Tipleri ─────────────────────────────────────────────────

/** Gossip data payload */
export interface GossipDataPayload {
  topic:   Topic;
  key:     string;
  value:   unknown;
  version: number;
  origin:  string; // node ID
}

/** Heartbeat payload */
export interface HeartbeatPayload {
  clockValue:   number;
  nodeVersion:  string;
  capabilities: string[];
  snapshotHash: string;
}

/** Sync delta payload */
export interface SyncDeltaPayload {
  topic:   Topic;
  entries: Array<{ key: string; value: unknown; version: number; deletedAt?: number }>;
  fromSeq: number;
  toSeq:   number;
}

/** Event log payload */
export interface EventLogPayload {
  topic:     Topic;
  eventType: string;
  seq:       number;
  data:      unknown;
}

export type EnvelopePayload =
  | GossipDataPayload
  | HeartbeatPayload
  | SyncDeltaPayload
  | EventLogPayload
  | Record<string, unknown>; // diğerleri için

// ─── MessageEnvelope ──────────────────────────────────────────────────────────

export interface MessageEnvelope {
  /** Benzersiz mesaj kimliği (UUID v4 formatında) */
  readonly messageId:       string;
  /** Protokol versiyonu — uyumsuz versiyon reddedilir */
  readonly protocolVersion: ProtocolVersion;
  /** Gönderen düğüm ID'si */
  readonly senderNodeId:    string;
  /** Mesaj tipi */
  readonly messageType:     MessageType;
  /** Konu (hangi veri deposuna ait) */
  readonly topic:           Topic;
  /** Lamport mantıksal saat değeri */
  readonly logicalClock:    number;
  /** Gönderim zamanı (Unix ms) */
  readonly timestamp:       number;
  /** Kalan atlama sayısı (0 olunca yayılmaz) */
  readonly ttl:             number;
  /** Payload SHA-256 checksum (hex) */
  readonly checksum:        string;
  /** Ed25519 imzası (base64) */
  readonly signature:       string;
  /** İçerik */
  readonly payload:         EnvelopePayload;
}

// ─── Envelope Builder ─────────────────────────────────────────────────────────

let _msgCounter = 0;

export function generateMessageId(): string {
  const ts  = Date.now().toString(36);
  const cnt = (++_msgCounter).toString(36).padStart(4, "0");
  const rnd = Math.floor(Math.random() * 0xFFFF).toString(36).padStart(3, "0");
  return `msg_${ts}_${cnt}_${rnd}`;
}

export function createEnvelope(params: {
  senderNodeId:  string;
  messageType:   MessageType;
  topic:         Topic;
  logicalClock:  number;
  ttl:           number;
  payload:       EnvelopePayload;
  checksum:      string;
  signature:     string;
}): MessageEnvelope {
  return Object.freeze({
    messageId:       generateMessageId(),
    protocolVersion: PROTOCOL_VERSION,
    timestamp:       Date.now(),
    ...params,
  });
}

// ─── Envelope Doğrulama ───────────────────────────────────────────────────────

export type ValidationError =
  | "invalid_protocol"
  | "expired_ttl"
  | "bad_checksum"
  | "bad_signature"
  | "missing_field"
  | "invalid_timestamp"
  | "unknown_type";

export interface EnvelopeValidation {
  ok:      boolean;
  errors:  ValidationError[];
}

export function validateEnvelopeStructure(env: unknown): EnvelopeValidation {
  const errors: ValidationError[] = [];

  if (!env || typeof env !== "object") {
    return { ok: false, errors: ["missing_field"] };
  }

  const e = env as Partial<MessageEnvelope>;

  if (!e.messageId || !e.senderNodeId || !e.messageType || !e.topic) {
    errors.push("missing_field");
  }
  if (!e.checksum || !e.signature) {
    errors.push("missing_field");
  }
  if (e.protocolVersion !== PROTOCOL_VERSION) {
    errors.push("invalid_protocol");
  }
  if (typeof e.ttl !== "number" || e.ttl < 0) {
    errors.push("expired_ttl");
  }
  if (typeof e.timestamp !== "number" || e.timestamp <= 0) {
    errors.push("invalid_timestamp");
  }

  return { ok: errors.length === 0, errors };
}
