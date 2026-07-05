# 1XX1 Platform — Felaket Kurtarma Rehberi

**Sürüm:** 1.0.0  
**RTO Hedefi:** < 15 dakika (tek node kaybı)  
**RPO Hedefi:** < 1 dakika (snapshot interval'a bağlı)

---

## Yedekleme Stratejisi

1XX1 iki katmanlı yedekleme kullanır:

```
Snapshot (periyodik, tam durum)
  + Event Log (snapshot sonrası değişiklikler)
  = Tam yeniden yapılandırma
```

### Otomatik Snapshot

`X1_SNAPSHOT_INTERVAL_MS` (varsayılan: 60.000 = 1 dakika) aralığında
her node otomatik snapshot alır. Snapshot = JSON formatında tüm store
durumu + SHA-256 hash.

### Manuel Yedek Alma

```bash
# API üzerinden snapshot tetikle
curl -X POST http://localhost:8080/admin/snapshot

# Docker volume'u kopyala (node durdurulmadan önce)
docker cp x1-node1:/app/data ./backup/node1-$(date +%Y%m%d-%H%M%S)
```

---

## Kurtarma Senaryoları

### Senaryo 1: Tek Node Arızası (En Yaygın)

**Etki:** Cluster çalışmaya devam eder (Raft 3/3 → 2/3 çoğunluk yeterli)

```bash
# 1. Arızalı node'u yeniden başlat
docker compose restart node1
# veya Kubernetes için:
kubectl delete pod x1-node1 -n x1  # ReplicaSet otomatik yeniler

# 2. Fast Join protokolü devreye girer
#    Yeni node: snapshot + delta replay (tüm log değil)

# 3. Sağlık kontrolü
curl http://localhost:8080/health  # 200 ve "active" beklenir
```

**Süre:** Genellikle 15–30 saniye (Fast Join)

---

### Senaryo 2: Lider Arızası

**Etki:** Geçici hizmet kesintisi (~150–300ms, Raft election timeout)

Otomatik kurtarma — müdahale gerekmez:
1. Election timeout dolunca (`X1_ELECTION_TIMEOUT_MIN_MS`) yeni seçim
2. Follower'lardan biri lider olur
3. Lider, kaybedilen leader'ın commit edilmemiş log girdilerini kopyalar

---

### Senaryo 3: Tam Cluster Kaybı (En Kötü Durum)

**Etki:** Tüm data kaybı riski (snapshot'tan eski veriler kurtarılır)

```bash
# 1. En son snapshot'u bul
ls -lt ./backup/ | head -5

# 2. Yeni cluster başlat
X1_IS_BOOTSTRAP=true docker compose up -d

# 3. Snapshot yükle (API üzerinden)
curl -X POST http://localhost:8080/admin/restore \
  -H "Content-Type: application/json" \
  -d @./backup/node1-20260629-120000/snapshot.json

# 4. Diğer node'ları ekle — Fast Join ile senkronize olurlar
```

**RPO:** Son snapshot'tan bu yana yazılan veriler kayıp olabilir.
`X1_SNAPSHOT_INTERVAL_MS`'i düşürerek risk penceresi küçültülür.

---

### Senaryo 4: Bozuk Snapshot

Snapshot hash doğrulaması başarısız olursa (SnapshotStreamer.assemble()):

```bash
# 1. Önceki geçerli snapshot'u bul
for f in ./backup/*/snapshot.json; do
  echo -n "$f: "
  # Hash doğrulama (basit kontrol)
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$f'));
    console.log(s.hash ? 'VALID' : 'CORRUPT');
  "
done

# 2. Geçerli snapshot'tan restore et (bkz. Senaryo 3)
```

---

## Kurtarma Kontrol Listesi

```
[ ] Arızalı node belirlendi
[ ] Raft cluster'ı çoğunluk var mı? (en az 2/3 node ayakta)
[ ] Son geçerli snapshot belirlendi (hash doğrulaması geçti)
[ ] Fast Join ile yeni node senkronize edildi
[ ] /health endpoint 200 döndürüyor, role="active"
[ ] Pulse tick devam ediyor (x1_pulse_tick_total artıyor)
[ ] Arama sonuçları tutarlı (birden fazla node'da aynı sonuç)
[ ] Olay günlüğüne felaket notu eklendi (ne oldu, ne zaman, ne yapıldı)
```
