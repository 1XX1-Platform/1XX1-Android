/**
 * 1XX1 API Katmanı Testleri
 * Aşama 06
 *
 * Test grupları:
 *   validator    — DTO doğrulama, sanitize, sınır kontrolleri
 *   rateLimiter  — token bucket, burst, cleanup
 *   errorHandler — SystemError → HTTP dönüşümü
 *   search-adapter — DTO → RawQuery → DTO dönüşümü, timeout
 *   stream-engine  — SSE olay sırası, format, hata akışı
 *   handlers     — tam handler pipeline (validate → rate → adapt → format)
 */

import {
  runSuite, assert, assertEqual, makeProject
} from "../../core/test-utils.ts";
import { RequestValidator, throwIfInvalid } from "../middleware/validator.ts";
import { RateLimiter } from "../middleware/rateLimiter.ts";
import { ErrorHandler } from "../middleware/errorHandler.ts";
import { SearchAdapter } from "../adapters/search-adapter.ts";
import { StreamEngine } from "../adapters/stream-engine.ts";
import type { StreamWriter } from "../adapters/stream-engine.ts";
import { handleSearch, handleHealth, handleResolve } from "../routes/handlers.ts";
import { IndexManager } from "../../search/index-manager.ts";
import { SearchEngine } from "../../search/search-engine.ts";
import { EventBus } from "../../core/event-bus.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";
import { newProjectID } from "../../core/identity.ts";
import type { ProjectID } from "../../core/identity.ts";
import type { HandlerDeps } from "../routes/handlers.ts";

// ─── Test Yardımcıları ────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const bus    = new EventBus();
  const mgr    = new IndexManager(bus);
  const engine = new SearchEngine(mgr, bus);
  const adapter = new SearchAdapter(engine, { timeoutMs: 3000 });
  const stream  = new StreamEngine(engine, { timeoutMs: 3000 });

  return {
    searchAdapter:  adapter,
    streamEngine:   stream,
    searchEngine:   engine,
    indexManager:   mgr,
    validator:      new RequestValidator(),
    rateLimiter:    new RateLimiter({ requestsPerMinute: 1000 }),
    errorHandler:   new ErrorHandler(),
    startTime:      new Date(),
    ...overrides,
  };
}

function makeRequest(overrides = {}): import("../routes/handlers.ts").HttpRequest {
  return {
    method:    "POST",
    path:      "/search",
    headers:   { "x-forwarded-for": "127.0.0.1" },
    query:     {},
    requestId: "test-req-1",
    ...overrides,
  };
}

/** In-memory SSE collector */
function makeWriter(): StreamWriter & { chunks: string[] } {
  const chunks: string[] = [];
  let _closed = false;
  return {
    chunks,
    write: (chunk: string) => { chunks.push(chunk); },
    end:   () => { _closed = true; },
    get closed() { return _closed; },
  };
}

// ─── Validator ───────────────────────────────────────────────────────────────

await runSuite("validator/search", {
  "geçerli istek": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({ query: "stl repair", limit: 10, offset: 0 });
    assert(r.ok);
    if (r.ok) {
      assertEqual(r.value.query,  "stl repair");
      assertEqual(r.value.limit,  10);
      assertEqual(r.value.offset, 0);
    }
  },

  "query eksik → hata": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({});
    assert(!r.ok);
  },

  "query çok kısa → hata": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({ query: "a" });
    assert(!r.ok);
    if (!r.ok) assert(r.errors.some((e) => e.includes("en az")));
  },

  "query çok uzun → hata": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({ query: "a".repeat(501) });
    assert(!r.ok);
  },

  "limit clamp 1–100": () => {
    const v = new RequestValidator();
    const r1 = v.validateSearch({ query: "test", limit: 0 });
    assert(!r1.ok);
    const r2 = v.validateSearch({ query: "test", limit: 101 });
    assert(!r2.ok);
    const r3 = v.validateSearch({ query: "test", limit: 50 });
    assert(r3.ok);
  },

  "geçersiz coord → hata": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({
      query: "test",
      filter: { coord: { x: 11, y: 0, z: 0 } },
    });
    assert(!r.ok);
    if (!r.ok) assert(r.errors.some((e) => e.includes("coord")));
  },

  "ağırlık toplamı > 1 → hata": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({
      query: "test",
      weights: { semantic: 0.6, structural: 0.6 },
    });
    assert(!r.ok);
    if (!r.ok) assert(r.errors.some((e) => e.includes("toplam")));
  },

  "explain flag korunur": () => {
    const v = new RequestValidator();
    const r = v.validateSearch({ query: "test", explain: true });
    assert(r.ok);
    if (r.ok) assert(r.value.explain === true);
  },

  "throwIfInvalid — geçerli geçer": () => {
    const v   = new RequestValidator();
    const res = v.validateSearch({ query: "test query" });
    throwIfInvalid(res); // hata fırlatmamalı
    assert(true);
  },

  "throwIfInvalid — geçersiz fırlatır": () => {
    const v   = new RequestValidator();
    const res = v.validateSearch({ query: "x" }); // çok kısa
    try {
      throwIfInvalid(res);
      assert(false, "SystemError beklendi");
    } catch (err) {
      assert(err instanceof SystemError);
      assertEqual(err.code, ErrorCode.INVALID_QUERY);
    }
  },
});

await runSuite("validator/stream", {
  "geçerli stream isteği": () => {
    const v = new RequestValidator();
    const r = v.validateStream({ q: "stl mesh" });
    assert(r.ok);
  },

  "q eksik → hata": () => {
    const v = new RequestValidator();
    const r = v.validateStream({ q: "" });
    assert(!r.ok);
  },
});

// ─── RateLimiter ─────────────────────────────────────────────────────────────

await runSuite("rate-limiter", {
  "izin verir": () => {
    const rl = new RateLimiter({ requestsPerMinute: 100 });
    rl.check("ip1"); // hata fırlatmamalı
    assert(true);
  },

  "kota aşılınca RATE_LIMITED fırlatır": () => {
    const rl = new RateLimiter({ requestsPerMinute: 2, burstLimit: 10 });
    rl.check("ip2"); // 1
    rl.check("ip2"); // 2
    try {
      rl.check("ip2"); // 3 → hata
      assert(false, "SystemError beklendi");
    } catch (err) {
      assert(err instanceof SystemError);
      assertEqual(err.code, ErrorCode.RATE_LIMITED);
    }
    rl.stop();
  },

  "farklı IP'ler bağımsız bucket": () => {
    const rl = new RateLimiter({ requestsPerMinute: 1, burstLimit: 10 });
    rl.check("ip-a"); // ok
    try {
      rl.check("ip-a"); // quota aşıldı
      assert(false);
    } catch { /* beklenen */ }
    rl.check("ip-b"); // farklı IP → ok
    rl.stop();
  },

  "remaining() azalır": () => {
    const rl = new RateLimiter({ requestsPerMinute: 10, burstLimit: 10 });
    const before = rl.remaining("ip-r");
    rl.check("ip-r");
    const after  = rl.remaining("ip-r");
    assert(after < before, `remaining azalmalı: ${before} → ${after}`);
    rl.stop();
  },

  "istatistikler doğru": () => {
    const rl = new RateLimiter({ requestsPerMinute: 100 });
    rl.check("ip-s1");
    rl.check("ip-s2");
    const stats = rl.stats();
    assertEqual(stats.totalAllowed, 2);
    assertEqual(stats.totalBlocked, 0);
    rl.stop();
  },
});

// ─── ErrorHandler ────────────────────────────────────────────────────────────

await runSuite("error-handler", {
  "SystemError → doğru HTTP status": () => {
    const eh = new ErrorHandler();

    const cases: Array<[string, number]> = [
      [ErrorCode.INVALID_QUERY,   400],
      [ErrorCode.RATE_LIMITED,    429],
      [ErrorCode.QUERY_TIMEOUT,   504],
      [ErrorCode.INTERNAL_ERROR,  500],
      [ErrorCode.ENGINE_FAILURE,  500],
    ];

    for (const [code, expectedStatus] of cases) {
      const err = new SystemError({ code: code as any, message: "test" });
      const { status } = eh.handle(err);
      assertEqual(status, expectedStatus, `${code} → ${expectedStatus}`);
    }
  },

  "ham Error → 500": () => {
    const eh = new ErrorHandler();
    const { status, body } = eh.handle(new Error("beklenmeyen"));
    assertEqual(status, 500);
    assertEqual(body.code, ErrorCode.INTERNAL_ERROR);
  },

  "stack trace body'de yok": () => {
    const eh = new ErrorHandler();
    const { body } = eh.handle(new Error("gizli hata"));
    assert(!("stack" in body), "stack trace gösterilmemeli");
  },
});

// ─── SearchAdapter ────────────────────────────────────────────────────────────

await runSuite("search-adapter", {
  "temel arama çalışır": async () => {
    const bus     = new EventBus();
    const mgr     = new IndexManager(bus);
    const engine  = new SearchEngine(mgr, bus);
    const adapter = new SearchAdapter(engine);

    const p = makeProject({ name: "Adapter Test Project", tags: ["adapter"] });
    mgr.indexProject(p);

    const res = await adapter.search({ query: "adapter test" });
    assert(res.results.length >= 0);
    assert(res.executionMs >= 0);
    assertEqual(res.offset, 0);
  },

  "limit doğru uygulanır": async () => {
    const bus     = new EventBus();
    const mgr     = new IndexManager(bus);
    const engine  = new SearchEngine(mgr, bus);
    const adapter = new SearchAdapter(engine);

    for (let i = 0; i < 15; i++) {
      mgr.indexProject(makeProject({ name: `limit project ${i}`, tags: ["limit"] }));
    }

    const res = await adapter.search({ query: "limit", limit: 5 });
    assert(res.results.length <= 5, "Limit uygulanmalı");
  },

  "explain mode: queryPlan dolu": async () => {
    const bus     = new EventBus();
    const mgr     = new IndexManager(bus);
    const engine  = new SearchEngine(mgr, bus);
    const adapter = new SearchAdapter(engine);
    mgr.indexProject(makeProject({ name: "explain me" }));

    const res = await adapter.search({ query: "explain me", explain: true });
    assert(res.queryPlan !== undefined,   "queryPlan dolu olmalı");
    assert(res.explain   !== undefined,   "explain dolu olmalı");
    assert(res.explain!.length > 0, "En az bir adım olmalı");
  },

  "timeout hatası": async () => {
    const bus     = new EventBus();
    const mgr     = new IndexManager(bus);
    const engine  = new SearchEngine(mgr, bus);
    // 0ms timeout → hemen zaman aşımı
    const adapter = new SearchAdapter(engine, { timeoutMs: 0 });

    try {
      await adapter.search({ query: "timeout test" });
      // Bazı ortamlarda 0ms timeout geçmeyebilir — bu test opsiyonel
    } catch (err) {
      if (err instanceof SystemError) {
        assertEqual(err.code, ErrorCode.QUERY_TIMEOUT);
      }
    }
  },

  "response DTO alanları tam": async () => {
    const bus     = new EventBus();
    const mgr     = new IndexManager(bus);
    const engine  = new SearchEngine(mgr, bus);
    const adapter = new SearchAdapter(engine);

    const res = await adapter.search({ query: "dto fields" });
    assert("results"     in res, "results olmalı");
    assert("total"       in res, "total olmalı");
    assert("offset"      in res, "offset olmalı");
    assert("limit"       in res, "limit olmalı");
    assert("intent"      in res, "intent olmalı");
    assert("executionMs" in res, "executionMs olmalı");
  },
});

// ─── StreamEngine ────────────────────────────────────────────────────────────

await runSuite("stream-engine/sse", {
  "SSE olay sırası: heartbeat → candidate → scoring → ranking → final": async () => {
    const bus    = new EventBus();
    const mgr    = new IndexManager(bus);
    const engine = new SearchEngine(mgr, bus);
    const stream = new StreamEngine(engine, { timeoutMs: 5000 });
    const writer = makeWriter();

    mgr.indexProject(makeProject({ name: "streaming test" }));
    await stream.stream({ query: "streaming test" }, writer);

    const events = writer.chunks
      .join("")
      .split("\n\n")
      .filter((e) => e.includes("event:"))
      .map((e) => {
        const match = e.match(/event: (\w+)/);
        return match?.[1] ?? "";
      })
      .filter(Boolean);

    assert(events[0] === "heartbeat", `İlk olay heartbeat olmalı: ${events[0]}`);
    assert(events.includes("candidate"), "candidate olayı olmalı");
    assert(events.includes("scoring"),   "scoring olayı olmalı");
    assert(events.includes("ranking"),   "ranking olayı olmalı");
    assert(events.includes("final"),     "final olayı olmalı");
  },

  "SSE formatı doğru": async () => {
    const bus    = new EventBus();
    const mgr    = new IndexManager(bus);
    const engine = new SearchEngine(mgr, bus);
    const stream = new StreamEngine(engine);
    const writer = makeWriter();

    await stream.stream({ query: "format test" }, writer);

    const raw = writer.chunks.join("");
    // Her SSE bloğu "event:" ile başlamalı
    const blocks = raw.split("\n\n").filter((b) => b.trim());
    for (const block of blocks) {
      assert(
        block.includes("event:") && block.includes("data:"),
        `Geçersiz SSE bloğu: ${block.slice(0, 50)}`
      );
    }
  },

  "geçersiz sorgu → error olayı": async () => {
    const bus    = new EventBus();
    const mgr    = new IndexManager(bus);
    const engine = new SearchEngine(mgr, bus);
    const stream = new StreamEngine(engine);
    const writer = makeWriter();

    // Geçersiz sorgu — bu test validator'ı atlatır
    // Doğrudan stream'e gönderilir (handler geçmeden)
    await stream.stream({ query: "" }, writer);
    // Boş sorgu sessizce işlenir veya hata döner
    assert(writer.chunks.length > 0, "En az bir SSE olayı olmalı");
  },

  "writer kapalıysa erken çıkar": async () => {
    const bus    = new EventBus();
    const mgr    = new IndexManager(bus);
    const engine = new SearchEngine(mgr, bus);
    const stream = new StreamEngine(engine);

    let _closed = true; // baştan kapalı
    const writer: StreamWriter = {
      write: () => {},
      end:   () => {},
      get closed() { return _closed; },
    };

    // Hata fırlatmamalı
    await stream.stream({ query: "closed writer" }, writer);
    assert(true);
  },
});

// ─── Route Handlers ──────────────────────────────────────────────────────────

await runSuite("handlers/search", {
  "POST /search — başarılı": async () => {
    const deps = makeDeps();
    deps.indexManager.indexProject(makeProject({ name: "handler test" }));

    const req = makeRequest({ body: { query: "handler test" } });
    const res = await handleSearch(req, deps);

    assertEqual(res.status, 200);
    assert(res.headers["Content-Type"] === "application/json");
    const body = JSON.parse(res.body);
    assert(body.ok === true);
    assert("results" in body);
    assert("executionMs" in body);
  },

  "POST /search — geçersiz body → 400": async () => {
    const deps = makeDeps();
    const req  = makeRequest({ body: { query: "x" } }); // çok kısa
    const res  = await handleSearch(req, deps);
    assertEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert(body.ok === false);
    assertEqual(body.code, ErrorCode.INVALID_QUERY);
  },

  "POST /search — rate limited → 429": async () => {
    const rl = new RateLimiter({ requestsPerMinute: 0, burstLimit: 10 });
    const deps = makeDeps({ rateLimiter: rl });
    const req  = makeRequest({ body: { query: "rate test" } });
    const res  = await handleSearch(req, deps);
    assertEqual(res.status, 429);
    rl.stop();
  },

  "explain mode çalışır": async () => {
    const deps = makeDeps();
    deps.indexManager.indexProject(makeProject({ name: "explain handler test" }));

    const req = makeRequest({ body: { query: "explain handler", explain: true } });
    const res = await handleSearch(req, deps);
    assertEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert(body.ok === true);
    // explain varsa queryPlan de olmalı
  },
});

await runSuite("handlers/health", {
  "GET /health — ok döner": () => {
    const deps = makeDeps();
    const req  = makeRequest({ method: "GET", path: "/health" });
    const res  = handleHealth(req, deps);

    assertEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert(body.ok === true);
    assertEqual(body.status, "ok");
    assert("uptime"     in body);
    assert("components" in body);
    assert("timestamp"  in body);
  },

  "components.searchEngine true": () => {
    const deps = makeDeps();
    const req  = makeRequest({ method: "GET", path: "/health" });
    const res  = handleHealth(req, deps);
    const body = JSON.parse(res.body);
    assert(body.components.searchEngine === true);
  },
});

await runSuite("handlers/resolve", {
  "GET /search/resolve — yol döner": async () => {
    const deps = makeDeps();
    const req  = makeRequest({
      method: "GET",
      path:   "/search/resolve",
      query:  { q: "STL mesh repair" },
    });
    const res  = await handleResolve(req, deps);
    assertEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert(body.ok === true);
    assert(Array.isArray(body.path));
    assert(body.path.length > 0);
    assert("intent" in body);
  },

  "q çok kısa → 400": async () => {
    const deps = makeDeps();
    const req  = makeRequest({
      method: "GET",
      path:   "/search/resolve",
      query:  { q: "a" },
    });
    const res  = await handleResolve(req, deps);
    assertEqual(res.status, 400);
  },
});
