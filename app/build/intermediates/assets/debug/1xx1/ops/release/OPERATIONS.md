# 1XX1 Platform — Operasyon Rehberi

**Sürüm:** 1.0.0  
**Hedef Kitle:** Platform operatörleri, DevOps mühendisleri

---

## Genel Bakış

1XX1, 3 veya daha fazla düğümden oluşan bir Raft cluster olarak çalışır.
Her düğüm aynı kodun aynı konfigürasyonla çalıştırılmasıyla oluşur.
Küme boyutu tek sayı olmalıdır (3, 5, 7...) — Raft'ın çoğunluk garantisi için.

---

## Başlatma

### Geliştirme Ortamı (Docker Compose)

```bash
# 3 node cluster başlat
docker compose up

# Observability ile
docker compose --profile monitoring up

# Yalnızca tek node (geliştirme)
docker compose up node1
```

### Prodüksiyon (Kubernetes)

```bash
helm install x1 ./ops/deployment/helm \
  -f ops/deployment/helm-values.yaml \
  --set image.tag=1.0.0
```

---

## Sağlık Kontrolü

### HTTP Endpoints

```
GET /health    → {"status": "ok", "nodeId": "...", "role": "leader|follower"}
GET /ready     → Yük dengeleyici için; cluster'a bağlı değilse 503
GET /metrics   → Prometheus text format (ops/observability/)
```

### Hızlı Komutlar

```bash
# Node durumu
curl http://localhost:8080/health

# Metrics
curl http://localhost:9090/metrics | grep x1_

# Raft durumu
curl http://localhost:8080/debug/raft
```

---

## Günlük Operasyon

### Log İzleme

Yapılandırılmış JSON log. Önemli alanlar:

```json
{
  "timestamp": "2026-06-29T10:00:00.000Z",
  "level": "info",
  "service": "x1-node1",
  "message": "Plugin aktif: \"fuzzy-search\"",
  "correlationId": "req_abc123"
}
```

```bash
# Hata loglarını filtrele
docker logs x1-node1 | jq 'select(.level == "error")'

# Belirli correlation ID izle
docker logs x1-node1 | jq 'select(.correlationId == "req_abc123")'
```

### Raft Lider Takibi

```bash
# Lider kim?
for port in 8080 8081 8082; do
  echo -n "Port $port: "
  curl -s http://localhost:$port/health | jq .role
done
```

---

## Ölçeklendirme

### Düğüm Ekleme (Kubernetes)

```bash
helm upgrade x1 ./ops/deployment/helm \
  --set replicaCount=5
```

**Not:** 3→5 geçişinde Fast Join protokolü devreye girer (Aşama 18).
Yeni düğüm tüm log replay yerine snapshot + delta ile senkronize olur.

### Düğüm Kaldırma

1. `graceful-shutdown` sinyali gönder (SIGTERM)
2. Cluster 30 saniye içinde yeniden lider seçer
3. Kubernetes kaldırılan pod'u otomatik değiştirir (PodDisruptionBudget min=2)

---

## Yedekleme

Snapshot otomatik alınır (`X1_SNAPSHOT_INTERVAL_MS` konfigürasyonuna göre).
Manuel yedek için bkz. `DISASTER_RECOVERY.md`.

---

## Konfigürasyon Referansı

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `X1_NODE_ID` | zorunlu | Benzersiz düğüm kimliği |
| `X1_API_PORT` | 8080 | HTTP API portu |
| `X1_METRICS_PORT` | 9090 | Prometheus metrics portu |
| `X1_PEERS` | "" | Virgülle ayrılmış peer adresleri |
| `X1_LOG_LEVEL` | info | debug/info/warn/error |
| `X1_LOG_FORMAT` | json | json/text |
| `X1_PULSE_INTERVAL_MS` | 5000 | Pulse tick aralığı |
| `X1_SNAPSHOT_INTERVAL_MS` | 60000 | Otomatik snapshot aralığı |
| `X1_ELECTION_TIMEOUT_MIN_MS` | 150 | Raft seçim timeout minimum |
| `X1_ELECTION_TIMEOUT_MAX_MS` | 300 | Raft seçim timeout maksimum |
| `X1_GOSSIP_FANOUT` | 6 | Gossip yayılım sayısı (k) |
| `X1_GOSSIP_TTL` | 8 | Gossip TTL (hop) |
