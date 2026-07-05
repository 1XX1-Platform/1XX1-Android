/**
 * 1XX1 Event Bus — Scope-Aware, FIFO, Idempotent
 * Aşama 01 + Düzeltme 1 (Event Storm) + Düzeltme 4 (Risk 4)
 *
 * Düzeltme 1: Event Scope Separation
 *   Emit sırasında scope kontrolü yapılır.
 *   INDEX scope'tan CORE/CUBE scope'a olay atılamaz.
 *   → cascade amplification önlenir.
 *
 * FIFO kuyruğu, idempotency key, replay, history korunur.
 */

import type { IEventBus, EventHandler } from "./interfaces.ts";
import type { SystemEvent, SystemEventType, CoreEventType, CubeEventType, IndexEventType } from "./types.ts";
import { toError } from "./utils.ts";

// ─── Scope Sınıflandırma ─────────────────────────────────────────────────────

const CORE_EVENTS = new Set<string>([
  "project:created", "project:updated", "project:archived",
  "pulse:tick", "search:executed",
]);
const CUBE_EVENTS = new Set<string>([
  "cube:indexed", "cube:split", "cube:merge", "cube:overflow",
  "cube:subcube-created", "cube:subcube-removed", "cube:path-changed",
]);
const INDEX_EVENTS = new Set<string>([
  "index:upserted", "index:removed", "index:reconciled", "index:drift-detected",
]);

export type EventScope = "core" | "cube" | "index";

function eventScope(type: string): EventScope {
  if (CORE_EVENTS.has(type))  return "core";
  if (CUBE_EVENTS.has(type))  return "cube";
  if (INDEX_EVENTS.has(type)) return "index";
  return "core"; // bilinmeyen → core olarak işle (güvenli taraf)
}

// ─── Genişletilmiş Olay ───────────────────────────────────────────────────────

export interface EnrichedEvent<T = unknown> extends SystemEvent<T> {
  idempotencyKey?: string;
  attempt: number;
}

// ─── EventBus ────────────────────────────────────────────────────────────────

export class EventBus implements IEventBus {
  private readonly handlers = new Map<SystemEventType, Set<EventHandler>>();
  private readonly fifoQueue: Array<EnrichedEvent> = [];
  private _processing = false;
  private _currentScope: EventScope | null = null; // şu an işlenen olayın scope'u

  private readonly processedKeys = new Set<string>();
  private readonly maxProcessedKeys: number;

  private readonly eventLog: EnrichedEvent[] = [];
  private readonly maxLogSize: number;

  private readonly logger?: {
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  constructor(options: {
    logger?: { warn: (msg: string) => void; debug?: (msg: string) => void };
    maxLogSize?: number;
    maxProcessedKeys?: number;
  } = {}) {
    this.logger          = options.logger;
    this.maxLogSize      = options.maxLogSize      ?? 500;
    this.maxProcessedKeys = options.maxProcessedKeys ?? 10_000;
  }

  // ─── IEventBus ───────────────────────────────────────────────────────────

  on<T>(type: SystemEventType, handler: EventHandler<T>): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler as EventHandler);
  }

  off(type: SystemEventType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Olay yayınla.
   *
   * Düzeltme 1: Scope guard
   *   INDEX scope işlenirken CORE veya CUBE olay atılamaz.
   *   Bu kuralı ihlal eden emit() çağrısı reddedilir ve loglanır.
   *
   * @param type         Olay türü
   * @param payload      Olay verisi
   * @param idempotencyKey  Opsiyonel tekrar önleme anahtarı
   */
  emit<T>(type: SystemEventType, payload: T, idempotencyKey?: string): void {
    const targetScope = eventScope(type as string);

    // ── Düzeltme 1: Cycle prevention ──
    if (this._currentScope === "index" && targetScope !== "index") {
      this.logger?.warn(
        `EventBus: SCOPE VIOLATION engellendi — ` +
        `INDEX handler içinden "${type}" (${targetScope}) yayınlanamaz. ` +
        `INDEX → CORE/CUBE döngüsü önlendi.`
      );
      return; // sessizce reddet, sistem çalışmaya devam eder
    }

    // ── Idempotency ──
    if (idempotencyKey && this.processedKeys.has(idempotencyKey)) {
      this.logger?.debug?.(`Idempotent olay atlandı: ${type} [${idempotencyKey}]`);
      return;
    }

    const event: EnrichedEvent<T> = {
      type,
      payload,
      timestamp:      new Date(),
      scope:          targetScope,
      idempotencyKey,
      attempt:        1,
    };

    this.fifoQueue.push(event as EnrichedEvent);
    this._drainQueue();
  }

  // ─── Gelişmiş Özellikler ─────────────────────────────────────────────────

  replay(n = 50): void {
    const slice = this.eventLog.slice(-n);
    for (const event of slice) {
      this.fifoQueue.push({
        ...event,
        idempotencyKey: undefined, // replay'de idempotency bypass
        attempt:        event.attempt + 1,
        timestamp:      new Date(),
      });
    }
    this._drainQueue();
  }

  history(type?: SystemEventType, n = 20): Readonly<EnrichedEvent[]> {
    const filtered = type
      ? this.eventLog.filter((e) => e.type === type)
      : this.eventLog;
    return filtered.slice(-n);
  }

  registeredTypes(): SystemEventType[] {
    return Array.from(this.handlers.keys());
  }

  queueLength(): number {
    return this.fifoQueue.length;
  }

  // ─── FIFO ────────────────────────────────────────────────────────────────

  private _drainQueue(): void {
    if (this._processing) return;
    this._processing = true;
    while (this.fifoQueue.length > 0) {
      const event = this.fifoQueue.shift()!;
      this._dispatch(event);
    }
    this._processing = false;
  }

  private _dispatch(event: EnrichedEvent): void {
    if (event.idempotencyKey) {
      if (this.processedKeys.has(event.idempotencyKey)) return;
      this.processedKeys.add(event.idempotencyKey);
      if (this.processedKeys.size > this.maxProcessedKeys) {
        const iter = this.processedKeys.values();
        for (let i = 0; i < Math.floor(this.maxProcessedKeys / 4); i++) {
          this.processedKeys.delete(iter.next().value);
        }
      }
    }

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) this.eventLog.shift();

    const set = this.handlers.get(event.type as SystemEventType);
    if (!set || set.size === 0) return;

    // ── Düzeltme 1: scope'u işaretle ──
    const prevScope       = this._currentScope;
    this._currentScope    = event.scope as EventScope;

    for (const handler of set) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            this.logger?.warn(
              `EventBus: "${event.type}" handler hatası — ${toError(err).message}`
            );
          });
        }
      } catch (err) {
        this.logger?.warn(
          `EventBus: "${event.type}" handler hatası — ${toError(err).message}`
        );
      }
    }

    this._currentScope = prevScope; // önceki scope'u geri yükle (nested emit desteği)
  }
}

export const eventBus = new EventBus();
