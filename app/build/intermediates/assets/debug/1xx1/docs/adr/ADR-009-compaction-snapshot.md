# ADR-009 — Snapshot + Log Compaction + Fast Join

**Tarih:** 2026-06-29  
**Durum:** Kabul Edildi  
**Aşama:** 18

---

## 1. Problem

Aşama 15'te `ILogCompactor` arayüzü ve `NoopLogCompactor` stub bırakılmıştı:
"Aşama 18'de gerçek implementasyon" notuyla. Bu borç şimdi ödeniyor.

Üç ayrı ama birbiriyle ilişkili sorun:

1. **Log sonsuz büyür**: Raft log append-only (Aşama 15). Sistem yıllarca
   çalışırsa bellek ve restart süresi katlanarak artar.
2. **Snapshot pahalı**: Aşama 14'ün `SnapshotManager.take()` her seferinde
   TÜM store içeriğini kopyalıyordu — 100K+ projeli store'da bu işlem
   O(n) bellek + CPU, her snapshot alımında tekrarlanıyor.
3. **Yeni düğüm yavaş katılır**: Aşama 14'ün orijinal recovery akışı
   (`snapshot + event log replay`) hâlâ TÜM event log'u replay ediyordu —
   sistem büyüdükçe yeni düğüm bootstrap süresi uzuyor.

---

## 2. Kararlar

### Neden IncrementalLogCompactor (NoopLogCompactor yerine gerçek implementasyon)?
- `retainTail` parametresi: commit edilmiş olsa bile son N girdi her zaman
  tutulur — debug/denetim kolaylığı için
- Commit edilmemiş girdiler **asla** silinmez (`upToIndex ≤ commitIndex - retainTail`
  garantisi) — veri kaybı riski matematiksel olarak imkansız
- `shouldTrigger()` politikası: boyut eşiği + minimum aralık — çok sık
  tetiklenip CPU israf etmeyi önler
- `truncatedDigest`: silinen girdilerin özet hash'i — denetim/forensics için

### Neden RaftEngine'de Index-Tabanlı Erişime Geçiş (kritik düzeltme)?
- Orijinal Aşama 15 implementasyonu `this.log[n]` ile **dizi pozisyonunu**
  `entry.index` ile **eşanlamlı** varsayıyordu
- Compaction sonrası bu varsayım çöker: `log[0].index` artık 0 değil,
  1000 olabilir (ilk 1000 girdi silindiyse)
- `_findByIndex()`, `_sliceFromIndex()` ile tüm erişimler `entry.index`
  alanına göre arama yapacak şekilde düzeltildi — compaction güvenli
- Bu düzeltme olmadan `IncrementalLogCompactor` kullanılamazdı (sessiz
  veri bozulması riski)

### Neden Incremental Snapshot (her zaman full değil)?
- İlk snapshot her zaman full (referans yok, delta hesaplanamaz)
- Sonraki snapshot'lar yalnızca DEĞİŞEN kayıtları taşır (`version > lastVersion`)
- `fullSnapshotInterval` (varsayılan 100): periyodik olarak yeniden full
  alınır — delta zincirinin sonsuza kadar uzamasını önler
- Restore: `full + delta_1 + delta_2 + ... + delta_n` sırayla `merge()`
  edilir — `DeterministicResolver` (Aşama 14) çakışmaları otomatik çözer

### Neden Ayrı Snapshot Streaming Protokolü (Aşama 16 ContentAddresser değil)?
- Aşama 16'nın `ContentAddresser` dosya binary'si için tasarlandı (asset transfer)
- Bu modül konsensüs STATE JSON'u için — farklı veri şekli, farklı boyut profili
  (256 KB chunk vs 2 MB asset chunk)
- Prensip aynı (chunk + hash doğrulama) ama implementasyon ayrı —
  INVARIANTS.md kuralı gereği `consensus/` modülü `asset/`'i import edemez
- `sha256Hex` paylaşılır (`distributed/security/signature.ts`) — kod tekrarı yok

### Neden Fast Join (Sponsor/Client ayrımı)?
- Yeni düğüm TÜM event log'u replay etmek yerine:
  1. Mevcut bir düğümden (sponsor) en son full+incremental zincirini ister
  2. Zinciri stream eder (chunk'lı, doğrulamalı)
  3. Zinciri uygular (store'ları doldurur)
  4. Yalnızca snapshot SONRASI event'leri replay eder (genellikle çok az)
- Karmaşıklık: O(log_size) → O(delta_since_snapshot)
- `FastJoinSponsor.evaluateJoinRequest()`: protokol versiyonu kontrolü,
  snapshot varlığı kontrolü — güvenlik kapısı

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Hiç compaction yapmamak | Sistem yıllarca çalışınca log devasa olur — kabul edilemez |
| Tüm log'u tek seferde silmek | Stop-the-world duraklama; "incremental" felsefesine aykırı |
| Snapshot'ı her zaman full almak | 100K+ kayıtta her snapshot O(n) — gereksiz CPU/bellek israfı |
| Aşama 16 ContentAddresser'ı yeniden kullanmak | `consensus/` → `p2p/`/`asset/` bağımlılığı INVARIANTS.md'yi ihlal eder |
| Yeni düğüm her zaman tam replay yapsın | Büyük sistemde dakikalar/saatler sürer — kullanıcı deneyimi kötü |
| Disk tabanlı log (RocksDB/LevelDB) | Bu aşamada in-memory yeterli; gerçek persistence Aşama 20'ye bırakıldı |

---

## 4. Sonuçlar

**Artıları:**
- Log artık sınırlı büyür — `triggerSize` + periyodik compaction ile kontrol altında
- Commit edilmemiş veri kaybı matematiksel olarak imkansız (`retainTail` garantisi)
- Incremental snapshot: değişmeyen kayıtlar tekrar tekrar kopyalanmaz
- Snapshot streaming: büyük state tek mesajda gönderilmez, chunk'lı + doğrulamalı
- Fast Join: yeni düğüm O(delta) sürede senkronize olur, O(tüm geçmiş) değil
- RaftEngine artık gerçek anlamda compaction-safe (kritik index-tabanlı düzeltme)

**Eksileri:**
- `IncrementalSnapshotBuilder` in-memory — disk persistence yok (Aşama 20)
- Snapshot streaming chunk boyutu (256 KB) ampirik — gerçek ağ koşullarında ayarlanmalı
- Fast Join şu an yalnızca tek sponsor'dan alır — paralel çoklu-sponsor (Aşama 16
  TransferEngine'deki gibi) henüz yok
- `_findByIndex()` lineer arama fallback'i büyük log'larda yavaş olabilir
  (pratikte ilk offset varsayımı çoğu zaman tutar, O(1))

---

## 5. İleride Değiştirilebilir Noktalar

- `IncrementalLogCompactor` → disk-backed persistence (Aşama 20)
- `SnapshotStreamer` → binary framing (protobuf/MessagePack, base64 yerine)
- `FastJoinSponsor` → çoklu-sponsor paralel indirme (Aşama 16 TransferEngine deseni)
- `_findByIndex()` → binary search (eğer log her zaman index-sıralıysa O(log n))
- Compaction tetikleme → adaptif (ağ/disk yüküne göre dinamik `triggerSize`)

---

## İlgili Bileşenler

`consensus/compaction/log-compactor.ts` · `consensus/compaction/incremental-snapshot.ts` · `consensus/compaction/snapshot-streamer.ts` · `consensus/join/fast-join.ts` · `consensus/raft/raft-engine.ts` (index-tabanlı erişim düzeltmesi)
