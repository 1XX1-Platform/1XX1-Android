/**
 * 1XX1 Gossip Engine — Fan-out Gossip
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 *
 * Broadcast kaldırıldı — fan-out gossip kullanılır.
 * Varsayılan fanout: 6 (epidemik yayılım)
 *
 * Özellikler:
 *   - TTL (hop count): her geçişte -1, 0'da durur
 *   - Duplicate cache (LRU): aynı mesaj iki kez işlenmez
 *   - Message cache: replay için kısa süreli saklama
 *   - Anti-storm: flood ve loop koruması
 *
 * Matematiksel garanti (epidemik model):
 *   fanout=6, 1000 node → ~log6(1000)=4 hop → tam yayılım
 */

import type { MessageEnvelope, MessageType, Topic, GossipDataPayload } from "../envelope/message-envelope.ts";
import { createEnvelope } from "../envelope/message-envelope.ts";
import type { ITransport } from "../transport/transport.ts";
import type { LamportClock } from "../clock/lamport-clock.ts";
import type { ISignatureProvider } from "../security/signature.ts";
import { computePayloadChecksum } from "../security/signature.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── LRU Cache ────────────────────────────────────────────────────────────────

export class LRUCache<K, V> {
  private readonly map   = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(key: K): boolean { return this.map.has(key); }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key)!;
    // LRU: en son kullanılan başa al
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // Sınır aşıldıysa en eski sil
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  size(): number { return this.map.size; }
  clear(): void  { this.map.clear(); }
}

// ─── Gossip Engine Config ─────────────────────────────────────────────────────

export interface GossipConfig {
  /** Fan-out sayısı: kaç peer'a iletilir */
  fanout:            number;
  /** Başlangıç TTL (hop sayısı) */
  defaultTTL:        number;
  /** Görülen mesaj cache boyutu */
  seenCacheSize:     number;
  /** Mesaj cache süresi (ms) */
  messageCacheMs:    number;
  /** Anti-storm: saniye başına max gelen mesaj */
  maxMsgPerSecond:   number;
}

const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  fanout:            6,
  defaultTTL:        8,
  seenCacheSize:     10_000,
  messageCacheMs:    60_000,    // 1 dakika
  maxMsgPerSecond:   1_000,
};

// ─── Gossip Handler ───────────────────────────────────────────────────────────

export type GossipHandler = (envelope: MessageEnvelope, isNew: boolean) => void | Promise<void>;

// ─── GossipEngine ────────────────────────────────────────────────────────────

export class GossipEngine {
  private readonly seenMessages: LRUCache<string, true>;
  private readonly messageCache: Map<string, { env: MessageEnvelope; expiresAt: number }>;
  private readonly handlers:     GossipHandler[] = [];
  private readonly cfg:          GossipConfig;

  // Anti-storm: rate limiting
  private _msgCount    = 0;
  private _windowStart = Date.now();

  private _stats = {
    spread:    0,   // yayılan mesaj sayısı
    dropped:   0,   // TTL sıfır veya duplicate
    processed: 0,   // işlenen yeni mesaj
    antiStorm: 0,   // flood koruması ile atılan
  };

  constructor(
    transport: ITransport,
    clock:     LamportClock,
    signer:    ISignatureProvider,
    cfg: Partial<GossipConfig> = {},
    logger?: ILogger
  ) {
    this.transport = transport;
    this.clock = clock;
    this.signer = signer;
    this.logger = logger;
    this.cfg            = { ...DEFAULT_GOSSIP_CONFIG, ...cfg };
    this.seenMessages   = new LRUCache(this.cfg.seenCacheSize);
    this.messageCache   = new Map();

    // Transport'tan gelen mesajları işle
    this.transport.onMessage((env, from) => this._receive(env, from));
  }

  // ─── Yayınla ─────────────────────────────────────────────────────────────

  /**
   * Yeni mesaj üret ve fanout gossip ile yay.
   */
  async spread(params: {
    messageType: MessageType;
    topic:       Topic;
    payload:     GossipDataPayload;
    ttl?:        number;
  }): Promise<MessageEnvelope> {
    const clockVal = this.clock.tick();
    const checksum = await computePayloadChecksum(params.payload);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(params.payload));
    const signature    = await this.signer.sign(payloadBytes);

    const env = createEnvelope({
      senderNodeId:  this.transport.nodeId,
      messageType:   params.messageType,
      topic:         params.topic,
      logicalClock:  clockVal,
      ttl:           params.ttl ?? this.cfg.defaultTTL,
      payload:       params.payload,
      checksum,
      signature,
    });

    // Kendi gördüklerimize ekle (loop önleme)
    this.seenMessages.set(env.messageId, true);
    this._cacheMessage(env);

    await this._fanout(env, []);
    this._stats.spread++;
    return env;
  }

  /** Mesaj alındığında dinleyici kaydet */
  onMessage(handler: GossipHandler): void {
    this.handlers.push(handler);
  }

  // ─── İstatistikler ───────────────────────────────────────────────────────

  stats() {
    return {
      ...this._stats,
      seenCacheSize:    this.seenMessages.size(),
      messageCacheSize: this.messageCache.size,
    };
  }

  /** Son N mesajı döndür (replay için) */
  cachedMessages(since?: number): MessageEnvelope[] {
    const now    = Date.now();
    const result: MessageEnvelope[] = [];
    for (const { env, expiresAt } of this.messageCache.values()) {
      if (expiresAt > now) {
        if (!since || env.timestamp >= since) result.push(env);
      }
    }
    return result.sort((a, b) => a.logicalClock - b.logicalClock);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async _receive(env: MessageEnvelope, fromNodeId: string): Promise<void> {
    // Anti-storm rate limiting
    if (!this._checkRate()) {
      this._stats.antiStorm++;
      return;
    }

    // TTL kontrolü
    if (env.ttl <= 0) {
      this._stats.dropped++;
      return;
    }

    // Duplicate kontrolü
    if (this.seenMessages.has(env.messageId)) {
      this._stats.dropped++;
      return;
    }

    // Yeni mesaj
    this.seenMessages.set(env.messageId, true);
    this._cacheMessage(env);
    this.clock.merge(env.logicalClock);

    this._stats.processed++;

    // Handler'ları çağır
    for (const h of this.handlers) {
      await h(env, true);
    }

    // TTL azalt ve fanout ile ilet
    const forwarded = Object.freeze({
      ...env,
      ttl: env.ttl - 1,
    }) as MessageEnvelope;

    await this._fanout(forwarded, [fromNodeId]);
  }

  /** Fan-out: peers'dan fanout kadar rastgele seç ve gönder */
  private async _fanout(env: MessageEnvelope, exclude: string[]): Promise<void> {
    if (env.ttl <= 0) return;

    const peers    = this.transport.peers()
      .filter((p) => !exclude.includes(p) && p !== this.transport.nodeId);
    const selected = this._pickRandom(peers, this.cfg.fanout);

    await Promise.all(selected.map((p) => this.transport.send(p, env)));
  }

  /** Rastgele N eleman seç (Fisher-Yates partial shuffle) */
  private _pickRandom<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return arr;
    const copy = [...arr];
    for (let i = 0; i < n; i++) {
      const j  = i + Math.floor(Math.random() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  private _cacheMessage(env: MessageEnvelope): void {
    this.messageCache.set(env.messageId, {
      env,
      expiresAt: Date.now() + this.cfg.messageCacheMs,
    });
    // Eski mesajları temizle
    if (this.messageCache.size > this.cfg.seenCacheSize) {
      const now = Date.now();
      for (const [id, { expiresAt }] of this.messageCache) {
        if (expiresAt <= now) this.messageCache.delete(id);
      }
    }
  }

  private _checkRate(): boolean {
    const now = Date.now();
    if (now - this._windowStart >= 1000) {
      this._msgCount  = 0;
      this._windowStart = now;
    }
    this._msgCount++;
    return this._msgCount <= this.cfg.maxMsgPerSecond;
  }
}
