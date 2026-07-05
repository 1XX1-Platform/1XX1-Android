# 1XX1 Network Protocol — v1

**Versiyon:** 1.0.0  
**Tarih:** 2026-07-04  
**Durum:** FROZEN (bu belgeden sonra geriye donuk uyumluluk zorunludur)

---

## Genel Kurallar

- Tum RPC'ler HTTP/1.1 uzerinden JSON ile calisir
- Her istek `Content-Type: application/json` gerektirir
- Her yanit `{"ok": true|false, ...}` yapısını izler
- Hata yanıtı: `{"ok": false, "error": "ERROR_CODE", "message": "aciklama"}`
- Timeout: tum RPC'ler 8 saniye icinde cevaplanmali
- Versiyon: URL prefix'i `v1` — ileride `v2` eklenebilir

---

## Katman 1 — Identity (FAZ 0)

### GET /identity

Node kimlik bilgisi. Public key dahil, private key asla.

**Yanit:**
```json
{
  "nodeId":      "CitsyiAY65NGgsBT8w7c3viQdvGsqP98bMxSR7F7L9CP",
  "publicKey":   "<base64 DER SPKI>",
  "algorithm":   "ed25519",
  "createdAt":   1783100000000,
  "uptime":      3600.5,
  "role":        "leader",
  "logicalTime": 1783100003600
}
```

**Notlar:**
- `nodeId` = `base58(SHA256(publicKey))` — her zaman deterministik
- `algorithm` su an sadece `ed25519`
- `logicalTime` Lamport saatini gosterir

---

## Katman 2 — Health & Observability (FAZ 5)

### GET /health

Sistem saglik durumu.

**Yanit:**
```json
{
  "status":  "active",
  "nodeId":  "...",
  "role":    "leader",
  "peers":   1,
  "uptime":  3600.5,
  "version": "1.0.0",
  "pulse":   356619090,
  "plugins": {"total": 0, "byStatus": {}}
}
```

**`status` degerleri:**
- `active` — tam calisir
- `degraded` — kismi sorun var
- `starting` — henuz hazir degil

### GET /ready

Kubernetes readiness probe.

**Yanit:** `{"ready": true}` veya HTTP 503

### GET /metrics

Prometheus metrikleri (text/plain).

### GET /nodes

Cluster topolojisi.

**Yanit:**
```json
{
  "self":  {"nodeId": "...", "endpoint": "http://...", "role": "leader"},
  "peers": [
    {"nodeId": "...", "endpoint": "http://...", "lastSeen": 1783100000000, "source": "gossip"}
  ],
  "total": 2
}
```

---

## Katman 3 — Discovery (FAZ 1)

### POST /gossip/handshake

Peer kesif握手. Node aga katilirken cagrilir.

**Istek:**
```json
{
  "nodeId":      "...",
  "publicKey":   "<base64>",
  "endpoint":    "http://10.0.0.2:1331",
  "term":        3,
  "logicalTime": 1783100000000
}
```

**Yanit:**
```json
{
  "nodeId": "...",
  "peers": [
    {"nodeId": "...", "endpoint": "http://...", "lastSeen": 1783100000000, "term": 3}
  ],
  "term":        3,
  "clusterTime": 1783100000500
}
```

**Notlar:**
- Yanit `peers` listesi maksimum 16 eleman icerir
- `clusterTime` Lamport saati icin kullanilir
- Transitive peer propagation: A -> B -> C, A eventually C'yi ogrenir

### GET /gossip/peers

Bilinen tum peerlar.

**Yanit:**
```json
{
  "nodeId": "...",
  "peers": [
    {
      "nodeId":     "...",
      "endpoint":   "http://...",
      "lastSeen":   1783100000000,
      "reputation": 75,
      "source":     "gossip"
    }
  ],
  "count": 1
}
```

**`source` degerleri:** `seed` | `gossip` | `manual` | `lan`

---

## Katman 4 — DHT (FAZ 3)

### POST /dht/find-node

Kademlia FindNode RPC. Verilen ID'ye en yakin K node'u dondurur.

**Istek:**
```json
{
  "fromNodeId": "...",
  "targetId":   "..."
}
```

**Yanit:**
```json
{
  "contacts": [
    {"nodeId": "...", "endpoint": "http://...", "lastSeen": 1783100000000}
  ]
}
```

**Notlar:**
- Maksimum K=8 contact doner
- XOR distance metric ile siralanir
- `fromNodeId` routing table'a eklenir

### POST /dht/store

DHT key-value store.

**Istek:**
```json
{
  "key":   "peer-record-nodeId",
  "value": "<JSON string>",
  "ttlMs": 3600000
}
```

**Yanit:** `{"ok": true}`

### GET /dht/stats

DHT routing table durumu.

**Yanit:**
```json
{
  "routingTableSize": 8,
  "storeSize":        3,
  "selfNodeId":       "..."
}
```

---

## Katman 5 — Consensus (FAZ 2)

Raft RPC'leri internal transport uzerinden gider (HTTP degil).
Dis API olarak sadece durum sorgulanabilir:

### GET /raft/status *(FAZ 5.1 — henuz yok)*

```json
{
  "role":        "leader",
  "term":        3,
  "commitIndex": 247,
  "logLength":   250,
  "leaderId":    "..."
}
```

### GET /cluster/state *(FAZ 5.1 — henuz yok)*

```json
{
  "phase":       "steady-state",
  "leaderCount": 1,
  "nodes":       [...]
}
```

---

## Katman 6 — Application (FAZ 4+)

### GET /search?q=...

Arama sonuclari.

**Yanit:**
```json
{
  "query": "kaptan",
  "results": {
    "projects": [...],
    "channels": [...]
  }
}
```

### GET /api/projects

Proje listesi.

**Yanit:**
```json
{
  "projects": [...],
  "total": 5
}
```

### GET /api/pulse

Guncel Pulse siralamasi.

**Yanit:**
```json
{
  "pulseNumber": 356619090,
  "timestamp":   1783100000000,
  "ranked": [
    {"projectId": "p1", "score": 0.94, "name": "1XX1 Core Engine"}
  ]
}
```

### GET /events

SSE stream. Canli guncelleme.

**Event tipleri:**
```
data: {"type": "pulse", "data": {"number": 356619090}}
data: {"type": "peer",  "data": {"nodeId": "...", "status": "connected"}}
data: {"type": "log",   "data": {"level": "info", "message": "..."}}
```

### POST /admin/snapshot

Manuel yedek al.

**Yanit:**
```json
{
  "ok":      true,
  "hash":    "167e8c62...",
  "takenAt": "2026-07-04T07:57:50.732Z"
}
```

---

## Hata Kodlari

| Kod | HTTP | Anlam |
|-----|------|-------|
| `NOT_LEADER` | 503 | Bu node lider degil |
| `NODE_NOT_FOUND` | 404 | Hedef node bulunamadi |
| `INVALID_SIGNATURE` | 401 | Ed25519 dogrulama basarisiz |
| `TERM_CONFLICT` | 409 | Raft term catismasi |
| `HASH_MISMATCH` | 422 | Log hash dogrulamasi basarisiz |
| `PEER_UNKNOWN` | 404 | Peer bilgisi yok |
| `TIMEOUT` | 408 | RPC timeout (>8s) |
| `RATE_LIMITED` | 429 | Cok fazla istek |
| `INTERNAL` | 500 | Sunucu hatasi |

---

## Mesaj Versiyonlama

Geri donuk uyumluluk kurallari:

1. Mevcut alanlar kaldirilmaz — deprecated isaretlenir
2. Yeni alan eklemek her zaman guvenli (optional)
3. Alan tipi degistirilemez — yeni alan eklenir
4. URL degistirilemez — yeni endpoint eklenir (`/v2/...`)
5. Hata kodlari genisletilebilir, ama mevcut kodlar degistirilemez

---

## Guvenlik

- Tum public key'ler base64 DER SPKI formatinda
- Private key asla network'e cikmaz
- Gelecekte: Gossip handshake Ed25519 imzalanacak (FAZ 4.3)
- Gelecekte: DHT mesajlari imzalanacak (FAZ 4.3)
- Su an: Transport guven modeli (LAN/seed node guvenilir kabul edilir)
