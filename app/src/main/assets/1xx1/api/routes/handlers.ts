/**
 * 1XX1 Route Handlers
 * Aşama 06 — Routes
 *
 * Her handler:
 *   1. Validate (validator middleware)
 *   2. Rate limit (rateLimiter middleware)
 *   3. Adapt (adapter katmanı)
 *   4. Format (response formatter)
 *   5. Error handling (errorHandler middleware)
 *
 * Handler'lar iş mantığı içermez.
 * Transport → Adapter → Engine → Response.
 *
 * Platform bağımsız: Node.js, Deno, Bun ile çalışır.
 * Test edilebilirlik için bağımlılıklar constructor'dan enjekte edilir.
 */

import type { SearchAdapter } from "../adapters/search-adapter.ts";
import type { StreamEngine } from "../adapters/stream-engine.ts";
import type { StreamWriter } from "../adapters/stream-engine.ts";
import { RequestValidator, throwIfInvalid } from "../middleware/validator.ts";
import { RateLimiter, extractKey } from "../middleware/rateLimiter.ts";
import { ErrorHandler } from "../middleware/errorHandler.ts";
import type { HealthResponseDTO } from "../types.ts";
import type { SearchEngine } from "../search/search-engine.ts";
import type { IndexManager } from "../search/index-manager.ts";
import { config } from "../../core/config.ts";

// ─── Minimal HTTP Soyutlaması ─────────────────────────────────────────────────

/** Platform bağımsız istek */
export interface HttpRequest {
  method:  string;
  path:    string;
  headers: Record<string, string | undefined>;
  query:   Record<string, string>;
  body?:   unknown;
  requestId?: string;
}

/** Platform bağımsız yanıt builder */
export interface HttpResponse {
  status:  number;
  headers: Record<string, string>;
  body:    string; // JSON string
}

// ─── Handler Bağımlılıkları ───────────────────────────────────────────────────

export interface HandlerDeps {
  searchAdapter:  SearchAdapter;
  streamEngine:   StreamEngine;
  searchEngine:   SearchEngine;
  indexManager:   IndexManager;
  validator:      RequestValidator;
  rateLimiter:    RateLimiter;
  errorHandler:   ErrorHandler;
  startTime:      Date;
}

// ─── POST /search ─────────────────────────────────────────────────────────────

export async function handleSearch(
  req:  HttpRequest,
  deps: HandlerDeps
): Promise<HttpResponse> {
  const key = extractKey(req.headers);

  try {
    deps.rateLimiter.check(key);

    const validated = deps.validator.validateSearch(req.body);
    throwIfInvalid(validated);

    const response = await deps.searchAdapter.search(validated.value);

    return {
      status: 200,
      headers: {
        "Content-Type":                "application/json",
        "X-Request-Id":                req.requestId ?? "",
        "X-Execution-Ms":              String(response.executionMs),
        "X-RateLimit-Remaining":       String(deps.rateLimiter.remaining(key)),
      },
      body: JSON.stringify({ ok: true, ...response }),
    };
  } catch (err) {
    const { status, body } = deps.errorHandler.handle(err, req.requestId);
    return {
      status,
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ok: false, ...body }),
    };
  }
}

// ─── GET /search/stream ───────────────────────────────────────────────────────

export async function handleStream(
  req:    HttpRequest,
  writer: StreamWriter,
  deps:   HandlerDeps
): Promise<void> {
  const key = extractKey(req.headers);

  try {
    // Streaming daha pahalı — 2 token harca
    deps.rateLimiter.check(key, 2);

    const validated = deps.validator.validateStream(req.query);
    throwIfInvalid(validated);

    await deps.streamEngine.stream(validated.value, writer);
  } catch (err) {
    if (!writer.closed) {
      const { body } = deps.errorHandler.handle(err, req.requestId);
      writer.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      writer.end();
    }
  }
}

// ─── GET /health ──────────────────────────────────────────────────────────────

export function handleHealth(
  req:  HttpRequest,
  deps: HandlerDeps
): HttpResponse {
  try {
    const engineStats = deps.searchEngine.engineStats();
    const indexStats  = deps.indexManager.stats();

    const uptime  = Math.floor((Date.now() - deps.startTime.getTime()) / 1000);
    const cacheHits = engineStats.cacheHits;
    const total   = engineStats.totalQueries;

    const body: HealthResponseDTO = {
      status:    "ok",
      version:   config.get().version,
      uptime,
      components: {
        searchEngine: true,
        indexManager: indexStats.totalProjects >= 0,
        eventBus:     true,
      },
      stats: {
        totalQueries:   total,
        avgExecutionMs: engineStats.avgExecutionMs,
        cacheHitRate:   total > 0 ? cacheHits / total : 0,
      },
      timestamp: new Date().toISOString(),
    };

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ok: true, ...body }),
    };
  } catch (err) {
    const { status, body } = deps.errorHandler.handle(err, req.requestId);
    return {
      status,
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ok: false, ...body }),
    };
  }
}

// ─── GET /search/resolve ──────────────────────────────────────────────────────

export async function handleResolve(
  req:  HttpRequest,
  deps: HandlerDeps
): Promise<HttpResponse> {
  const key = extractKey(req.headers);

  try {
    deps.rateLimiter.check(key);

    const term = (req.query["q"] ?? "").trim();
    if (term.length < 2) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          code: "INVALID_QUERY",
          message: '"q" parametresi en az 2 karakter olmalı',
        }),
      };
    }

    const path   = await deps.searchEngine.resolve(term);
    const intent = deps.searchEngine.detectIntent(term);

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, path, intent, term }),
    };
  } catch (err) {
    const { status, body } = deps.errorHandler.handle(err, req.requestId);
    return {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, ...body }),
    };
  }
}
