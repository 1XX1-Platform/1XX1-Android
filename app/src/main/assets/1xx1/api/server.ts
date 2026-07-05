/**
 * 1XX1 API Server
 * Aşama 06 — Server
 *
 * Minimal, platform bağımsız HTTP sunucusu.
 * Dış bağımlılık yoktur — Node.js 18+ built-in http modülü kullanılır.
 *
 * Mimari karar: API katmanı stateless'tır.
 *   - Her istek bağımsız işlenir
 *   - Hiçbir session state tutulmaz
 *   - Yalnızca RateLimiter bucket'ları in-memory tutulur (process bazlı)
 *
 * Route tablosu:
 *   POST /search          → handleSearch
 *   GET  /search/stream   → handleStream (SSE)
 *   GET  /search/resolve  → handleResolve
 *   GET  /health          → handleHealth
 *   *                     → 404
 */

import * as http from "node:http";
import type { HandlerDeps, HttpRequest } from "./routes/handlers.ts";
import {
  handleSearch,
  handleStream,
  handleHealth,
  handleResolve,
} from "./routes/handlers.ts";
import type { StreamWriter } from "./adapters/stream-engine.ts";
import type { ILogger } from "../core/interfaces.ts";
import { RequestValidator } from "./middleware/validator.ts";
import { RateLimiter } from "./middleware/rateLimiter.ts";
import { ErrorHandler } from "./middleware/errorHandler.ts";
import type { SearchAdapter } from "./adapters/search-adapter.ts";
import type { StreamEngine } from "./adapters/stream-engine.ts";
import type { SearchEngine as SE } from "../search/search-engine.ts";
import type { IndexManager } from "../search/index-manager.ts";

// ─── Server Config ────────────────────────────────────────────────────────────

export interface ServerConfig {
  port:        number;
  host:        string;
  corsOrigins: string[];
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port:        8080,
  host:        "0.0.0.0",
  corsOrigins: ["*"],
};

// ─── ApiServer ────────────────────────────────────────────────────────────────

export class ApiServer {
  private readonly server:    http.Server;
  private readonly deps:      HandlerDeps;
  private readonly cfg:       ServerConfig;
  private          _started:  boolean = false;

  constructor(
    searchAdapter:  SearchAdapter,
    streamEngineI:  StreamEngine,
    searchEngineI:  SE,
    indexManagerI:  IndexManager,
    cfg:            Partial<ServerConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.indexManagerI = indexManagerI;
    this.searchEngineI = searchEngineI;
    this.streamEngineI = streamEngineI;
    this.searchAdapter = searchAdapter;
    this.cfg  = { ...DEFAULT_SERVER_CONFIG, ...cfg };

    this.deps = {
      searchAdapter:  searchAdapter,
      streamEngine:   streamEngineI,
      searchEngine:   searchEngineI,
      indexManager:   indexManagerI,
      validator:      new RequestValidator(),
      rateLimiter:    new RateLimiter({}, logger),
      errorHandler:   new ErrorHandler(logger),
      startTime:      new Date(),
    };

    this.server = http.createServer((req, res) =>
      this._dispatch(req, res).catch((err) => {
        logger?.error("Dispatch hatası", err instanceof Error ? err : undefined);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "INTERNAL_ERROR" }));
        }
      })
    );
  }

  // ─── Yaşam Döngüsü ───────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.cfg.port, this.cfg.host, () => {
        this._started = true;
        this.logger?.info(
          `1XX1 API Server çalışıyor: http://${this.cfg.host}:${this.cfg.port}`
        );
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.deps.rateLimiter.stop();
      this.server.close((err) => {
        if (err) reject(err);
        else {
          this._started = false;
          this.logger?.info("API Server durduruldu");
          resolve();
        }
      });
    });
  }

  isRunning(): boolean {
    return this._started;
  }

  get port(): number { return this.cfg.port; }

  // ─── Dispatch ────────────────────────────────────────────────────────────

  private async _dispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const url       = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path      = url.pathname;
    const method    = (req.method ?? "GET").toUpperCase();

    this.logger?.debug(`${method} ${path}`, { requestId });

    // ── CORS ──
    const origin = req.headers.origin ?? "*";
    const allowed = this.cfg.corsOrigins.includes("*") ||
                    this.cfg.corsOrigins.includes(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
    }

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Query params ──
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    // ── Headers ──
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v[0] : v;
    }

    const httpReq: HttpRequest = {
      method, path, headers, query,
      requestId,
    };

    // ── Router ──
    if (method === "POST" && path === "/search") {
      const body = await this._readBody(req);
      httpReq.body = body;
      const response = await handleSearch(httpReq, this.deps);
      this._sendJSON(res, response.status, response.headers, response.body);

    } else if (method === "GET" && path === "/search/stream") {
      // SSE başlıkları
      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "Access-Control-Allow-Origin": allowed ? origin : "",
      });
      res.flushHeaders();

      const writer: StreamWriter = {
        write: (chunk: string) => { res.write(chunk); },
        end:   () => { res.end(); },
        get closed() { return res.destroyed; },
      };

      await handleStream(httpReq, writer, this.deps);

    } else if (method === "GET" && path === "/search/resolve") {
      const response = await handleResolve(httpReq, this.deps);
      this._sendJSON(res, response.status, response.headers, response.body);

    } else if (method === "GET" && path === "/health") {
      const response = handleHealth(httpReq, this.deps);
      this._sendJSON(res, response.status, response.headers, response.body);

    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false, code: "NOT_FOUND",
        message: `${method} ${path} bulunamadı`,
      }));
    }
  }

  // ─── Yardımcılar ─────────────────────────────────────────────────────────

  private _readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end",  () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text.length > 0 ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", reject);
    });
  }

  private _sendJSON(
    res:     http.ServerResponse,
    status:  number,
    headers: Record<string, string>,
    body:    string
  ): void {
    res.writeHead(status, {
      ...headers,
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ─── Fabrika ─────────────────────────────────────────────────────────────────

/**
 * Tam bağımlılık ağacıyla ApiServer oluştur.
 * Aşama 07'de bu fonksiyon veritabanı bağlantısını da başlatacak.
 */
export function createApiServer(cfg?: Partial<ServerConfig>): ApiServer {
  // Lazy import — circular dependency önlemek için runtime import
  const { IndexManager, indexManager } = require("../search/index-manager.ts");
  const { SearchEngine }               = require("../search/search-engine.ts");
  const { SearchAdapter }              = require("./adapters/search-adapter.ts");
  const { StreamEngine }               = require("./adapters/stream-engine.ts");
  const { eventBus }                   = require("../core/event-bus.ts");
  const { logger }                     = require("../core/logger.ts");

  const searchEngineInst = new SearchEngine(indexManager, eventBus, logger);
  const searchAdapter    = new SearchAdapter(searchEngineInst);
  const streamEngineInst = new StreamEngine(searchEngineInst, {}, logger);

  return new ApiServer(
    searchAdapter,
    streamEngineInst,
    searchEngineInst,
    indexManager,
    cfg,
    logger
  );
}
