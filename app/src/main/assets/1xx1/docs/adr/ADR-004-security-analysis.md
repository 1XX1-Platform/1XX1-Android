# ADR-004 — Güvenlik Analizi ve Sandbox Ayrımı

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 12–13

---

## 1. Problem

Platform kullanıcı yüklemelerini güvenli hale getirmeli. Ancak:

- Antivirüs entegrasyonu → dış bağımlılık; ücretli API; offline çalışmaz
- Tam sanal makine → aşırı kaynak tüketimi; her yükleme için impratik
- AI/LLM analizi → non-deterministik; kara kutu sonuç
- Kural tabanlı statik → yeterince kapsamlı değil tek başına
- Sandbox → yalnız başına güvenlik değil

**Temel gerilim:** Statik analiz yanlış pozitif üretir. Çalıştırma riski taşır. İkisi nasıl birleştirilir?

---

## 2. Karar

**Üç bağımsız katman, her biri ayrı sorumluluk:**

```
Katman 1: Statik Analiz (Aşama 12)
  Dosyayı çalıştırmadan inceler.
  Kural tabanlı, deterministik.
  → "Bu kod ne yapabilir?"

Katman 2: Sandbox (Aşama 13)
  Dosyayı izole ortamda çalıştırır, davranışı gözlemler.
  Karar VERMEZ.
  → "Bu kod gerçekte ne yaptı?"

Katman 3: Policy Engine
  Her iki katmanın çıktısını alır, nihai kararı verir.
  → "approve / manual_review / reject"
```

**Temel kural:** Sandbox güvenlik sağlamaz — izolasyon sağlar. Güvenlik = izolasyon + analiz + politika.

**Adapter mimarisi:** `IAnalyzer` (statik), `ISandboxAdapter` (çalıştırma) → yeni motorlar drop-in.

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Sadece statik analiz | False positive yüksek; runtime davranış yakalanamaz |
| Sadece sandbox | Yavaş; her dosya için kaynak yoğun |
| Tek katman (her ikisi birlikte) | Sorumluluk karışıklığı; test edilemez |
| LLM tabanlı karar | Non-deterministik; kara kutu; vendor lock |
| Antivirüs API | Dış bağımlılık; offline çalışmaz; ücretli |

---

## 4. Sonuçlar

**Artıları:**
- Her katman bağımsız test edilebilir
- Yeni analizör → `IAnalyzer` implement et, pipeline'a ekle
- Yeni sandbox ortamı → `ISandboxAdapter` implement et
- Hiçbir analizör karar vermez → Policy Engine tek karar noktası
- Açıklanabilir: her bulgu `title + description + snippet + recommendation` taşır
- Deterministik: statik analiz aynı girdi → aynı rapor (test ile doğrulandı)

**Eksileri:**
- İki aşamalı analiz → latency artışı (statik + sandbox = 2 geçiş)
- Mock sandbox gerçek izolasyon sağlamıyor (Aşama 14: konteyner adaptörü)
- Kural kataloğu → yeni tehdit türlerine karşı elle güncellenmeli

---

## 5. İleride Değiştirilebilir Noktalar

- `StaticAnalyzer` kuralları → JSON/YAML konfigürasyona taşınabilir (hot reload)
- `MockSandboxAdapter` → `ContainerSandboxAdapter` (Docker, Aşama 14)
- Policy kuralları → UI'dan admin paneli aracılığıyla yapılandırılabilir
- CVE veritabanı → `DependencyAnalyzer` şu an statik; NVD API ile beslenilebilir
- `SecurityReport` → Asset Trust Score'unu otomatik güncelleme (Aşama 12↔11 entegrasyonu)

---

## İlgili Bileşenler

`security/pipeline/analysis-pipeline.ts` · `security/analyzers/static-analyzer.ts` · `security/analyzers/other-analyzers.ts` · `security/risk/risk-policy.ts` · `sandbox/service/sandbox-service.ts` · `sandbox/adapters/sandbox-adapters.ts` · `sandbox/monitor/behavior-monitor.ts`
