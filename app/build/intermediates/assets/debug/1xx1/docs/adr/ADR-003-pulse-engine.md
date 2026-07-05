# ADR-003 — Pulse Engine (Deterministik Adalet Zamanlayıcısı)

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 10

---

## 1. Problem

1XX1 reklam almaz, bağış sıralamayı etkilemez. Ancak projeler nasıl keşfedilecek?

- Algoritmik sıralama → manipüle edilebilir (SEO spam, fake star)
- Popülerlik sıralaması → köklü projeler hep üstte, yeniler görünmez
- Rastgele rotasyon → deterministik değil, dağıtık düğümlerde uyumsuz
- Zaman bazlı → "en yeni" her zaman üstte → spam güncellemeleri teşvik eder
- Fairness algoritması → adil ama nasıl hesaplanacak?

**Kısıt:** Tüm düğümler **aynı anda aynı listeyi** göstermeli (dağıtık deterministik).

---

## 2. Karar

**`pulseNumber = floor(unixTimeMs / intervalMs)`** formülü üzerine deterministik zamanlayıcı.

Skor:
```
score = pulseAge × 0.50  (sistemde ne kadar süredir aktif, log2 normalize)
      + fairness × 0.40  (ne kadar az görünmüş: ters orantılı)
      + trust × 0.10     (kanal güven skoru: küçük etki)
      - penalty × 1.00   (manipülasyon cezası)
```

Rotation: top pozisyon `maxConsecutiveTop=10` pulse (50 saniye) dolunca `demoteSteps=20` sıra aşağı.

Para/bağış → sıralamayı hiçbir şekilde etkilemez (test ile doğrulandı).

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Popülerlik (indirme sayısı) | Eski projeler avantajlı → yeni projeler görünmez |
| Zaman sıralaması (en yeni) | Spam güncelleme teşvik eder |
| Rastgele rotasyon | Dağıtık düğümlerde uyumsuz |
| Kullanıcı oyu | Manipülasyon kolaylığı; Sybil attack |
| Makine öğrenmesi | Kara kutu; açıklanamaz; LLM bağımlılığı |
| Alexa/PageRank benzeri | Harici veri gerektiriyor; merkezi |

---

## 4. Sonuçlar

**Artıları:**
- Deterministik: `aynı proje seti + aynı pulse = aynı sıralama` (tüm düğümler)
- Tamamen şeffaf: `explain()` ile skor bileşenleri görünür
- Adil: uzun süredir görünmeyen proje zamanla avantaj kazanır
- Restart recovery: snapshot ile pulse numarası kaldığı yerden devam eder
- Anti-manipülasyon: `applyPenalty()` + ban threshold

**Eksileri:**
- `fairness × 0.40` ağırlığı ampirik → uzun vadede ayarlanması gerekebilir
- Yeni proje fairness bonusu → kalitesiz yeni içeriği öne çıkarabilir (Trust Score dengeler)
- 5 saniyelik interval → düşük aktiviteli platformda anlamsız (ConfigManager ile ayarlanabilir)

---

## 5. İleride Değiştirilebilir Noktalar

- `intervalMs` → ConfigManager'dan okunuyor (`default: 5000`)
- Ağırlıklar parametrik: `RankingWeights` → constructor arg
- Snapshot → Aşama 07 DB'ye taşınabilir (şu an in-memory)
- `maxConsecutiveTop` → kanal tier'ına göre değişebilir (Aşama 14)
- Fairness algoritması → "Wilson skoru" benzeri istatistiksel yaklaşım ile iyileştirilebilir

---

## İlgili Bileşenler

`pulse/scheduler/pulse-scheduler.ts` · `pulse/ranking/ranking-engine.ts` · `pulse/rotation/rotation-engine.ts` · `pulse/eligibility/eligibility-engine.ts` · `pulse/clock/pulse-clock.ts` · `pulse/snapshot/pulse-snapshot.ts`
