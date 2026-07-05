/**
 * 1XX1 SSE Stream Engine
 * Aşama 06 — Adapter
 *
 * Server-Sent Events ile aşamalı arama sonucu iletimi.
 *
 * Olay sırası:
 *   heartbeat   → bağlantı kuruldu
 *   candidate   → aday seti hazır (count + sample)
 *   scoring     → skor hesaplama tamamlandı
 *   ranking     → sıralama tamamlandı
 *   final       → tam sonuç listesi
 *   error       → hata (bağlantı kapanır)
 *
 * SSE formatı (RFC 8895):
 *   event: <type>\n
 *   data: <json>\n
 *   id: <id>\n
 *   \n
 *
 * Performans hedefi: first-token < 10ms
 */

import type { SearchEngine } from "../search/search-engine.ts";
import type { StreamSearchRequestDTO, SSEEvent, SSEEventType } from "../types.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── SSE Formatter ────────────────────────────────────────────────────────────

let _sseCounter = 0;

function formatSSE(
  type: SSEEventType,
  data: unknown,
  id?: string
): string {
  const eventId = id ?? String(++_sseCounter);
  const json    = JSON.stringify(data);
  return `event: ${type}\ndata: ${json}\nid: ${eventId}\n\n`;
}

// ─── Stream Writer Arayüzü ────────────────────────────────────────────────────

/**
 * Platforma bağımsız yazıcı arayüzü.
 * Node: (res: ServerResponse) → { write, end, on }
 * Deno: (w: Deno.Writer) → wrap
 * Test: in-memory collector
 */
export interface StreamWriter {
  write(chunk: string): void;
  end(): void;
  /** Bağlantı kesildi mi? */
  closed: boolean;
}

// ─── StreamEngine ─────────────────────────────────────────────────────────────

export class StreamEngine {
  private readonly timeoutMs: number;

  constructor(
    engine: SearchEngine,
    opts: { timeoutMs?: number } = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.engine = engine;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Streaming arama yürüt.
   * Her aşama tamamlanınca writer'a SSE olayı yazar.
   *
   * Performans: candidate olayı mümkün olan en kısa sürede gönderilir (< 10ms hedef).
   */
  async stream(
    dto:    StreamSearchRequestDTO,
    writer: StreamWriter
  ): Promise<void> {
    const startMs = Date.now();

    // Zaman aşımı guard
    const timeoutId = setTimeout(() => {
      if (!writer.closed) {
        writer.write(formatSSE("error", {
          code:    ErrorCode.STREAM_ABORTED,
          message: `Stream ${this.timeoutMs}ms içinde tamamlanamadı`,
        }));
        writer.end();
      }
    }, this.timeoutMs);

    try {
      // ── Heartbeat: bağlantı kuruldu ──
      writer.write(formatSSE("heartbeat", {
        query: dto.query,
        ts:    new Date().toISOString(),
      }));

      if (writer.closed) { clearTimeout(timeoutId); return; }

      // ── explain mode ile tam search ──
      const response = await this.engine.search({
        term:    dto.query,
        filter:  dto.filter ? {
          tags:        dto.filter.tags,
          developerId: dto.filter.developerId,
        } : undefined,
        options: {
          limit:   dto.limit ?? 20,
          explain: true,
        },
      });

      if (writer.closed) { clearTimeout(timeoutId); return; }

      // ── candidate: aday sayısı ──
      const candidateStep = response.pipelineSteps?.find((s) =>
        s.name === "candidate-total"
      );
      writer.write(formatSSE("candidate", {
        count:     candidateStep?.outputCount ?? 0,
        sampleIds: response.projectIds.slice(0, 5),
        elapsedMs: Date.now() - startMs,
      }));

      if (writer.closed) { clearTimeout(timeoutId); return; }

      // ── scoring: üst skor ──
      const topScore = response.hits[0]?.finalScore ?? 0;
      writer.write(formatSSE("scoring", {
        scored:   response.hits.length,
        topScore: topScore,
        elapsedMs: Date.now() - startMs,
      }));

      if (writer.closed) { clearTimeout(timeoutId); return; }

      // ── ranking: ilk 3 sonuç ──
      writer.write(formatSSE("ranking", {
        ranked:  response.total,
        topHits: response.hits.slice(0, 3).map((h) => ({
          projectId: h.projectId,
          score:     h.finalScore,
          rank:      h.rank,
        })),
        elapsedMs: Date.now() - startMs,
      }));

      if (writer.closed) { clearTimeout(timeoutId); return; }

      // ── final: tam sonuç ──
      writer.write(formatSSE("final", {
        results: response.hits.map((h) => ({
          projectId:   h.projectId,
          rank:        h.rank,
          finalScore:  h.finalScore,
          resolvePath: h.resolvePath,
          matchedTokens: h.components.matchedTokens,
        })),
        total:       response.total,
        intent:      response.intent,
        executionMs: Date.now() - startMs,
      }));

    } catch (err) {
      this.logger?.error("Stream hatası", err instanceof Error ? err : undefined);
      if (!writer.closed) {
        const msg = err instanceof SystemError
          ? err.toApiError()
          : { code: ErrorCode.ENGINE_FAILURE, message: "Stream başarısız" };
        writer.write(formatSSE("error", msg));
      }
    } finally {
      clearTimeout(timeoutId);
      if (!writer.closed) writer.end();
    }
  }
}
