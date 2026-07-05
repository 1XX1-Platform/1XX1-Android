# Aşama-01 — Çekirdek Mimari

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-02 — 1331 Cube Engine

---

## Tamamlanan Görevler

- [x] Proje dizin yapısı oluşturuldu
- [x] Ortak veri tipleri tanımlandı (`types.ts`)
- [x] Soyut arayüzler (portlar) tanımlandı (`interfaces.ts`)
- [x] Saf yardımcı fonksiyonlar yazıldı (`utils.ts`)
- [x] Olay veriyolu implementasyonu yazıldı (`event-bus.ts`)
- [x] Logger implementasyonu yazıldı (`logger.ts`)
- [x] Modül dışa aktarma dosyası oluşturuldu (`index.ts`)

---

## Yazılan Dosyalar

| Dosya | Açıklama |
|---|---|
| `core/types.ts` | Tüm veri tipleri: Project, Developer, CubeCoordinate, PulseEntry, SearchQuery, ... |
| `core/interfaces.ts` | Soyut portlar: IProjectRepository, ICubeEngine, ISearchEngine, IPulseEngine, IEventBus, ILogger |
| `core/utils.ts` | Saf yardımcı fonksiyonlar: ID üretimi, koordinat araçları, metin araçları |
| `core/event-bus.ts` | Modüller arası iletişim: EventBus sınıfı + uygulama geneli `eventBus` örneği |
| `core/logger.ts` | Renkli konsol logger: ConsoleLogger + uygulama geneli `logger` örneği |
| `core/index.ts` | Tek giriş noktası: tüm core dışa aktarmaları |

---

## Dizin Ağacı

```
1xx1/
├── core/
│   ├── types.ts          ← Veri modelleri
│   ├── interfaces.ts     ← Soyut portlar (Clean Architecture)
│   ├── utils.ts          ← Saf yardımcı fonksiyonlar
│   ├── event-bus.ts      ← Modüller arası olay kanalı
│   ├── logger.ts         ← Yapılandırılabilir logger
│   └── index.ts          ← Genel dışa aktarma
├── cube_engine/          ← Aşama 02'de doldurulacak
├── search/               ← Aşama 05'te doldurulacak
├── pulse_engine/         ← Aşama 10'da doldurulacak
├── user/                 ← Aşama 09'da doldurulacak
├── project/              ← Aşama 08'de doldurulacak
├── api/                  ← Aşama 06'da doldurulacak
└── docs/stages/          ← Bu belgeler
```

---

## Kullanılan Teknolojiler

- **Dil:** TypeScript (runtime-bağımsız; Deno, Node veya Bun ile çalışır)
- **Bağımlılık:** Sıfır — hiçbir dış paket kullanılmadı
- **Stil:** Clean Architecture, SOLID prensipleri, Dependency Inversion

---

## Mimari Kararlar

### 1. Bağımlılığı Tersine Çevirme (Dependency Inversion)
Tüm dış bağımlılıklar (veritabanı, ağ, dosya sistemi) `IProjectRepository`, `ICubeEngine` gibi soyut arayüzler arkasına saklandı. Bu sayede:
- Aşama 07'de PostgreSQL eklendiğinde hiçbir iş mantığı değişmez.
- Testlerde gerçek veritabanı yerine in-memory implementasyon kullanılabilir.

### 2. Olay Veriyolu (Event Bus)
Modüller birbirine doğrudan bağımlı olmak yerine olaylar aracılığıyla haberleşir:
- `cube:indexed` → search engine bu olayı dinler ve indeksini günceller
- `project:created` → pulse engine bu olayı dinler ve sıralamayı günceller

### 3. Saf Fonksiyonlar
`utils.ts` içindeki tüm fonksiyonlar saf (pure) ve yan etkisizdir. Unit test maliyeti sıfıra yakın.

### 4. Tek Sorumluluk
Her dosya tek bir sorumluluğa sahip. `types.ts` yalnızca tip tanımlar, `utils.ts` yalnızca hesaplar, `event-bus.ts` yalnızca olayları yönetir.

---

## Sonraki Aşamanın Amacı

**Aşama 02 — 1331 Cube Engine**

- `ICubeEngine` arayüzünün in-memory implementasyonunu yaz
- 11×11×11 = 1331 hücreli koordinat sistemi kur
- Proje ekleme, sorgulama, komşu bulma fonksiyonlarını uygula
- İstatistik (doluluk oranı, yoğunluk) hesaplamaları ekle
- Aşama 01'in EventBus'ını entegre et (`cube:indexed` olayı)

---

## Riskler

| Risk | Olasılık | Önlem |
|---|---|---|
| Tip uyumsuzluğu ileride eklenen modüllerde | Düşük | `types.ts` merkezi, tek kaynak |
| EventBus handler sızıntısı | Düşük | `off()` metodu her zaman çift kullanılmalı |
| Logger performansı prod'da | Düşük | Aşama 20'de yapılandırılmış JSON logger ile değiştirilecek |

---

## Geliştirme Notları

- `CubeCoordinate` değerleri 0–10 arası (11 seçenek × 3 eksen = 1331 küp).
- `generateId()` UUID yerine `timestamp+random` kullanır — dış bağımlılık yok, sıralama avantajı var.
- `EventBus` async handler hatalarını yutar ama loglar — sistem çökmez.
- Gelecekte Redis Pub/Sub veya NATS ile değiştirilebilir, arayüz değişmez.
