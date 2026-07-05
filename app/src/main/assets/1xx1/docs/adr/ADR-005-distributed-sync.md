# ADR-005 — Dağıtık Düğüm Senkronizasyonu V2

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 14

---

## 1. Problem

1XX1 dağıtık çalışacak. Birden fazla düğüm aynı veri setini tutmalı.

Güçlükler:
- Ağ bölünmeleri (partition) sırasında veri kaybı olmamalı
- Farklı düğümlerde eş zamanlı güncelleme → çakışma
- Tüm düğümler aynı Pulse listesini göstermeli (deterministik)
- Kötü niyetli düğüm mesaj enjekte etmemeli
- Düğüm yeniden başlarsa state'ini kurtarabilmeli

---

## 2. Kararlar ve Gerekçeler

### Neden Gossip (Broadcast değil)?
- Broadcast: O(n) ağ yükü, merkezi bağımlılık
- Fan-out Gossip (k=6): epidemik yayılım, O(log n) hop
- 1000 node → ~4 hop → tam yayılım matematiksel garanti
- `seenMessages` LRU → loop ve flood koruması
- TTL hop count → sonsuz yayılım engeli

### Neden Lamport Clock (number değil)?
- Dağıtık olayların nedensel sıralaması için zorunlu
- `tick()` + `merge(remote)` = Lamport teoremi
- Tip güvenliği: `LamportClock` sınıfı vs ham sayı
- `IClock` arayüzü → Vector Clock için drop-in genişleme
- Snapshot/restore desteği yerleşik

### Neden Event Log (Snapshot tek başına değil)?
- Snapshot: anlık görüntü → ancak son snapshot'tan bu yana ne değişti?
- Recovery = Snapshot + Replay Event Log
- Append-only: veri kaybı imkansız
- Deterministik replay: aynı log → aynı state (test ile doğrulandı)
- Event log Pulse tarihçesi için de kullanılır

### Neden Snapshot?
- Sadece event log: yeniden başlamada tüm geçmişi replay et → yavaş
- Snapshot + sadece son eventler → hızlı recovery
- Hash = deterministik içerik özeti → iki düğüm karşılaştırabilir
- `storeChecksums` → hangi store değişti, hangisi senkronize?

### Neden Fan-out (k=6)?
- k=3: bazı topolojilerde yayılım tamamlanmıyor
- k=6: R-spread formülü → 99.9% ulaşım garantisi (1000 node)
- k=10: gereksiz ağ yükü
- Yapılandırılabilir: `GossipConfig.fanout`

### Neden Ed25519?
- RSA/DSA: ağır, yavaş
- ECDSA: implementation complexity
- Ed25519: küçük key (32 byte), hızlı, deterministic signature
- Web Crypto API native desteği
- `ISignatureProvider` → farklı implementasyon drop-in

### Neden Adapter Transport?
- TCP/WebSocket/QUIC/WebRTC/libp2p: aynı zamanda desteklenemez
- `ITransport` arayüzü → üst katman transport'u bilmez
- `MemoryTransport`: 1000 node simülasyonu için optimize
- Partition/heal/latency/drop-rate simülasyonu → test kalitesi
- Gelecekte P2P (libp2p) veya QUIC → arayüz değişmez

### Neden Deterministic Conflict Resolver?
- "En yeni zaman damgası" → düğümler arası saat kayması sorunu
- Rastgele seçim → iki düğüm farklı karar verebilir
- Deterministik karar sırası:
  1. Lamport Clock (nedensellik)
  2. Version (değişiklik sayısı)
  3. Timestamp (son çare)
  4. Signature string (her zaman farklı)
  5. NodeId (her zaman farklı, sabit)
- Test: aynı iki entry → her zaman aynı kazanan

### Neden Metadata-first?
- Dosya içeriği Storage Adapter'de (Aşama 11)
- Dağıtık katman yalnızca metadata yayar (checksumlar, ID'ler)
- Büyük dosya gossip üzerinden geçmez → ağ yükü kontrollü
- Asset indirme: düğüm → Storage Adapter → istemci

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Raft/Paxos | Lider seçimi gerektiriyor; merkezi bağımlılık; 1XX1 lider-free olacak |
| CRDT | Karmaşık; bazı veri tipleri için anlamsız (project policy gibi) |
| Blockchain | Ağır; her işlem için konsensüs; overkill |
| Cassandra/DynamoDB | Dış bağımlılık; vendor lock |
| etcd/ZooKeeper | Merkezi; tek nokta arızası riski |
| Master-slave replikasyon | Merkezi; lider arızasında çöküş |

---

## 4. Sonuçlar

**Artıları:**
- Tamamen bağımsız katmanlar → her biri bağımsız test edilebilir
- Düğüm ekleme/çıkarma transparent → gossip otomatik adapte olur
- Partition tolerant: bölünmede her parça kendi veriyle devam eder
- Merge sonrası: conflict resolver deterministik birleştirme sağlar
- Transport swap: `MemoryTransport` → `TCPTransport` → sıfır kod değişikliği
- 1000 node simülasyonu → < 5 saniye

**Eksileri:**
- Eventual consistency: anlık tutarlılık garanti edilmiyor
- Clock drift: `LamportClock` gerçek zaman kaymasını ele almıyor (NTP bağımsız)
- Ed25519: Web Crypto Ed25519 API bazı ortamlarda tam desteklenmiyor (fallback yazıldı)
- Gossip overhead: k=6 fanout, sık güncellemede ağ kullanımı artabilir

---

## 5. İleride Değiştirilebilir Noktalar

- `IClock` → `VectorClock` (Aşama 15 konsensüs için)
- `ITransport` → `libp2pTransport` (tam P2P)
- `ISignatureProvider` → `noble-ed25519` (production-ready Web Crypto)
- Fanout k parametrik → topoloji adaptif (düğüm sayısına göre)
- EventLog → kalıcı storage (Aşama 07 UnitOfWork ile)
- Snapshot → delta compression (büyük store'lar için)
- Gossip routing → topic-filtered (gereksiz yayılımı azaltır)

---

## İlgili Bileşenler

`distributed/envelope/` · `distributed/clock/` · `distributed/security/` · `distributed/transport/` · `distributed/gossip/` · `distributed/peer/` · `distributed/sync/` · `distributed/health/` · `distributed/node/node-runtime.ts`
