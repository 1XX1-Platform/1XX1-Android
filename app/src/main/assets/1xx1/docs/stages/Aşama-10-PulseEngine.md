# Aşama-10 — Pulse Engine (Deterministik Zamanlayıcı)

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-11 — Asset Bank

---

## Temel Denklem

```
pulseNumber = floor(unixTimeMs / intervalMs)
```

Tüm düğümler UTC saati üzerinden aynı pulse numarasını hesaplar.
Sunucu yeniden başlatılsa pulse numarası kaldığı yerden devam eder.
Rastgele sayı kullanılmaz.

---

## Mimari

```
Clock (IClock / MockClock)
    ↓ pulseNumber
EligibilityEngine    → archived, banned, spam koruması
    ↓ eligible projects
RankingEngine        → score = pulseAge×0.50 + fairness×0.40 + trust×0.10 - penalty
    ↓ sorted PulseEntry[]
RotationEngine       → top → bottom (maxConsecutiveTop=10)
    ↓ rotated entries + fairness update
PulseSnapshotStore   → kaydet (checksum), yükle (restart recovery)
    ↓
EventBus             → pulse:tick, pulse:completed, project:promoted, project:demoted
```

---

## Skor Formülü

```
score = pulseAge       × 0.50   (ne kadar süredir sistemde: log2 normalize)
      + fairnessScore  × 0.40   (ne az görünmüş: ters orantılı)
      + trustWeight    × 0.10   (kanal güven skoru: küçük etki)
      - penalty        × 1.00   (manipülasyon cezası)
```

**Para/bağış sıralamayı hiçbir şekilde etkilemez.**

---

## Fairness Metrikleri

Her proje için fairness kaydı:

| Alan | Açıklama |
|---|---|
| `lastTopPulse` | En son üst sırada görüldüğü pulse |
| `topCount` | Toplam üst sırada kalma sayısı |
| `lastSeenPulse` | En son görüldüğü pulse |
| `firstPulse` | Sisteme ilk girdiği pulse |
| `penalty` | Manuel ceza toplamı |
| `lastSignificantUpdate` | Son anlamlı güncelleme pulse'u (spam koruması) |

---

## Rotation Kuralı

- `maxConsecutiveTop = 10` (50 saniye × 5s interval)
- Top pozisyonu bu sınırı aşınca proje `demoteSteps = 20` sıra aşağı gider
- En yüksek fairness skoru olan proje yukarı çıkar (promote)
- Tüm işlem deterministik

---

## Anti-Manipülasyon

- Sadece versiyon numarası değiştirmek Pulse'u sıfırlamaz
- `lastSignificantUpdate` kontrolü (minimum 12 pulse arası)
- Manuel ceza: `applyPenalty(projectId, amount)`
- Ceza eşiği (100) aşılınca geçici ban: `eligibility.reason = "banned"`

---

## Snapshot ve Recovery

```typescript
// Kaydet (her tick'te otomatik)
snapshotStore.save(snapshot, fairnessMap);

// Recovery (start() çağrısında)
const saved = snapshotStore.latest();
if (saved && snapshotStore.verify(saved)) {
  this.fairness = snapshotStore.restoreFairness(saved);
}
```

Checksum tutarsızlığında snapshot yok sayılır, sıfırdan başlar.

---

## Domain Events

| Olay | Tetikleyici |
|---|---|
| `pulse:tick` | Her tick |
| `pulse:completed` | Tick tamamlandı |
| `pulse:started` | Scheduler başladı |
| `project:promoted` | Proje yukarı çıktı |
| `project:demoted` | Proje aşağı gönderildi |

---

## Test Kapsamı

| Test | Açıklama |
|---|---|
| Deterministik sıralama | Aynı girdi → aynı çıktı (2× çalıştırma) |
| Restart recovery | İki bağımsız scheduler aynı sonucu üretir |
| 100.000 eligibility | < 2000ms |
| 100.000 ranking | < 5000ms |
| 1000 proje tam tick | < 500ms |
| Eşzamanlı tick koruması | Paralel tick → biri atlanır |
| Anti-manipülasyon | Ceza → skor düşüşü, ban |
| Fairness | Az görünmüş proje zamanla avantaj kazanır |

---

## Sonraki Aşamanın Amacı

**Aşama-11 — Asset Bank**

- 3D varlık (STL, OBJ, GLTF) depolama
- Asset → Proje bağlantısı
- İndirme sayacı (Pulse Engine'in totalDownloads kaynağı)
- Checksum doğrulama
- CDN URL oluşturma
