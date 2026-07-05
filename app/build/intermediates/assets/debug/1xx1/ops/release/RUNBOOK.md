# 1XX1 Platform — Operasyon Kitabı (Runbook)

**Sürüm:** 1.0.0  
**Hedef:** Geliştirici olmayan operatörler sistemi bağımsız işletebilsin

---

## Alert Referansı

### 🔴 KRITIK

#### ALERT: `x1_node_status == 0` (Node OFFLINE)

```
Ne oldu: Bir node cevap vermiyor
Etki:    Cluster 3 node'dan 2'ye düştü (çoğunluk hâlâ var)
```

```bash
# 1. Node'u kontrol et
docker logs x1-nodeN --tail=100 | jq 'select(.level == "error")'

# 2. Yeniden başlat
docker compose restart nodeN

# 3. 30 saniye bekle, sağlık kontrolü
curl http://localhost:808N/health

# 4. Fast Join log'u izle
docker logs x1-nodeN --tail=50 | grep "Fast Join"
```

**Yükseltme:** 15 dakika içinde çözülmezse → ikinci node de düşerse cluster çalışmaz → Senaryo 3 (Felaket Kurtarma).

---

#### ALERT: Lider yok (tüm node'lar "follower")

```
Ne oldu: Raft seçimi başarısız veya split-brain
Etki:    Hiçbir yazma işlemi kabul edilemiyor
```

```bash
# 1. Tüm node'larda election log'a bak
for port in 8080 8081 8082; do
  docker logs x1-node${port##808} 2>&1 | grep -E "election|leader|term" | tail -5
done

# 2. Çözüm: En az 2 node ayakta ve birbirini görebiliyorsa
#    yeni election otomatik başlar (timeout: 150–300ms)
#    Müdahale gerekmez, 1 dakika bekle

# 3. Hâlâ lider yoksa: ağ bölünmesi kontrolü
ping x1-node2  # node1'den
ping x1-node3  # node1'den
```

---

### 🟡 UYARI

#### ALERT: `x1_node_status == 2` (DEGRADED)

```
Ne oldu: Node çalışıyor ama peer sayısı düşük
Etki:    Gossip yayılımı zayıf, sync gecikebilir
```

```bash
# Aktif peer sayısını kontrol et
curl -s http://localhost:8080/metrics | grep x1_node_active_peers

# Peer bağlantılarını yenile
curl -X POST http://localhost:8080/admin/reconnect-peers
```

---

#### ALERT: `x1_plugin_failures_total` artıyor

```
Ne oldu: Bir veya daha fazla plugin başarısız oluyor
Etki:    İlgili extension point (search/pulse vb.) katkısı yok
```

```bash
# Hangi plugin başarısız?
curl -s http://localhost:8080/admin/plugins | \
  jq '[.[] | select(.status == "failed")]'

# Plugin'i yeniden aktive et
curl -X POST http://localhost:8080/admin/plugins/PluginAdı/activate

# Hâlâ başarısız oluyorsa kaldır
curl -X DELETE http://localhost:8080/admin/plugins/PluginAdı
```

---

#### ALERT: `x1_search_latency_ms p99 > 100ms`

```
Ne oldu: Arama yavaşladı
Sebep:   Büyük ihtimalle indeks büyüdü (>10K kayıt)
```

```bash
# İndeks boyutunu kontrol et
curl -s http://localhost:8080/metrics | grep x1_search

# Çözüm seçenekleri:
# A) Arama limiti düşür (kısa vadeli)
# B) Shard planlama (uzun vadeli, Aşama 21+)
```

---

### 🟢 BİLGİ

#### `x1_log_compaction_total` artmıyor

```
Durum: Log compaction tetiklenmiyor
Sebep: Log boyutu eşiğe (10.000) ulaşmadı — normal
Aksiyon: Gerek yok
```

---

## Rutin Operasyonlar

### Haftalık

```bash
# Snapshot arşivle (eski olanları sil — 30 günden eski)
find ./backup -name "snapshot.json" -mtime +30 -delete

# Metrics trendi kontrol et (Grafana)
# - Search latency artıyor mu?
# - Memory footprint büyüyor mu?
# - Plugin failure rate?
```

### Aylık

```bash
# Chaos test çalıştır (canlı ortamda değil, staging'de)
node --import=tsx ops/reliability/chaos-tests.ts

# Performance cert çalıştır
node --import=tsx ops/performance/performance-cert.ts

# Sonuçları PERFORMANCE.md ile karşılaştır
```

---

## Yardımcı Komutlar

```bash
# Tüm node'ların özetini al
for port in 8080 8081 8082; do
  echo "=== Node $port ==="
  curl -s http://localhost:$port/health
done

# Prometheus'ta 1XX1 metrikleri
curl -s http://localhost:9080/api/v1/query?query=x1_node_status

# En son Raft commit index
curl -s http://localhost:8080/metrics | grep x1_raft_commit_index

# Log hata sayısı (son 5 dakika, varsayılan)
docker logs x1-node1 --since 5m | jq 'select(.level=="error")' | wc -l
```
