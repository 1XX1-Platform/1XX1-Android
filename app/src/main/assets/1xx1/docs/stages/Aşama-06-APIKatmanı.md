# Aşama-06 — API Katmanı

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-07 — Veritabanı Katmanı

---

## Mimari

```
HTTP / WS Layer (ApiServer)
    ↓
Request Validator    — DTO doğrulama, sanitize
    ↓
Rate Limiter         — Token bucket per IP
    ↓
Route Handler        — stateless dispatch
    ↓
Search Adapter       — DTO → RawQuery → DTO
    ↓
SearchEngine (Aşama 05) — read-only
    ↓
Response Formatter   — SearchResponse → DTO
    ↓
JSON / SSE Output
```

---

## Endpoint'ler

### POST /search
```json
Request:  { "query": "stl mesh repair", "limit": 20, "explain": true }
Response: { "ok": true, "results": [...], "executionMs": 12, "intent": "semantic" }
```

### GET /search/stream (SSE)
```
event: heartbeat  → bağlantı kuruldu
event: candidate  → aday seti hazır (count + sampleIds)
event: scoring    → skor hesaplama (topScore)
event: ranking    → ilk 3 hit
event: final      → tam sonuç listesi
event: error      → hata (bağlantı kapanır)
```

### GET /search/resolve?q=STL+mesh
```json
{ "ok": true, "path": ["3D", "Mesh"], "intent": "semantic", "term": "STL mesh" }
```

### GET /health
```json
{ "ok": true, "status": "ok", "version": "0.1.0", "uptime": 120,
  "components": { "searchEngine": true, "indexManager": true, "eventBus": true },
  "stats": { "totalQueries": 42, "avgExecutionMs": 8, "cacheHitRate": 0.3 } }
```

---

## Dosyalar

| Dosya | Satır | Açıklama |
|---|---|---|
| `api/types.ts` | ~110 | DTO'lar, SSEEventType, HTTP status map |
| `api/middleware/validator.ts` | ~180 | RequestValidator, throwIfInvalid |
| `api/middleware/rateLimiter.ts` | ~130 | Token bucket, cleanup, stats |
| `api/middleware/errorHandler.ts` | ~70 | SystemError → HttpError |
| `api/adapters/search-adapter.ts` | ~120 | DTO ↔ RawQuery, timeout wrapper |
| `api/adapters/stream-engine.ts` | ~130 | SSE, 5 olay tipi |
| `api/routes/handlers.ts` | ~160 | 4 handler, platform bağımsız |
| `api/server.ts` | ~160 | ApiServer, router, CORS, body parser |
| `api/__tests__/api.test.ts` | ~380 | 8 grup, 40+ test |

---

## Mimari Kural: Stateless

```
API katmanı:
  ✔ stateless — her istek bağımsız
  ✔ no business logic
  ✔ no indexing
  ✔ no scoring
  ✔ transport + orchestration only
  ✗ hiçbir zaman SearchEngine.index() veya IndexManager çağırmaz
```

---

## Rate Limiter: Token Bucket

- 100 istek / dakika / IP
- Burst: 10 (tek seferde harcanan maksimum)
- Streaming: 2 token maliyet
- 10 dakika sessiz bucket → otomatik temizlik
- `X-RateLimit-Remaining` header'ı her yanıtta

---

## Error Model

| Durum | HTTP | ErrorCode |
|---|---|---|
| Geçersiz query | 400 | INVALID_QUERY |
| Kısa query | 400 | INVALID_QUERY |
| Geçersiz koordinat | 400 | INVALID_COORDINATE |
| Rate limited | 429 | RATE_LIMITED |
| Timeout | 504 | QUERY_TIMEOUT |
| Engine hatası | 500 | ENGINE_FAILURE |
| Beklenmeyen | 500 | INTERNAL_ERROR |

---

## Performans Mimarisi

- `p95 < 50ms`: SearchEngine cache + IndexManager Map lookups
- `first-token < 10ms`: SSE heartbeat anında yayınlanır, candidate batch hemen ardından
- Timeout guard: hem search adapter (5s) hem stream engine (30s) ayrı timeout taşır

---

## Sonraki Aşamanın Amacı

**Aşama-07 — Veritabanı Katmanı**

Kritik dönüşüm:
```
in-memory Map → PostgreSQL persistent storage
IProjectRepository → PostgreSQL implementation
PathRegistry.replay() → event log tablosundan
```

Yeni bileşenler:
- `db/connection.ts` — bağlantı havuzu
- `db/project-repository.ts` — IProjectRepository implementasyonu
- `db/event-store.ts` — EventLog tablosu (replay için)
- `db/snapshot.ts` — FractalCubeEngine anlık görüntüsü
- `db/migrations/` — Şema versiyonlama
