# Aşama-13 — Sandbox Çalıştırma Ortamı

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-14 — Dağıtık Düğüm Senkronizasyonu

---

## Temel Mimari Ayrım

> **Sandbox güvenlik sağlamaz — izolasyon sağlar.**  
> Güvenlik = izolasyon + statik analiz (Aşama 12) + davranış analizi + politika.

Sandbox'ın tek görevi: gözlem. Karar Policy Engine'e aittir.

---

## Bileşen Mimarisi

```
RunSandboxCommand
  ↓ SessionManager.register()       → eşzamanlı limit (max 5)
  ↓ ISandboxAdapter.run()           → izole çalıştırma
  ↓ BehaviorMonitor.analyze()       → ihlal tespiti
  ↓ TelemetryCollector.snapshot()   → kaynak kullanımı
  ↓ PolicyEngine (servis içi)       → approve/review/reject
→ SandboxResult
```

---

## ISandboxAdapter — 4 Implementasyon (şu an 2)

| Adaptör | Durum | Açıklama |
|---|---|---|
| `MockSandboxAdapter` | ✅ | Test ve CI — kod analizi simüle eder |
| `ProcessSandboxAdapter` | ✅ | Node.js child_process — wall-time timeout |
| `ContainerSandboxAdapter` | ⏳ | Docker/Firecracker — Aşama 14 |
| `WasmSandboxAdapter` | ⏳ | WASM runtime izolasyonu — Aşama 15 |

---

## Kaynak Limitleri (DEFAULT_LIMITS)

```typescript
{
  cpuTimeMs:       5_000,             // 5 saniye CPU
  maxMemoryBytes:  128 * 1024 * 1024, // 128 MB
  maxDiskBytes:    10  * 1024 * 1024, // 10 MB
  wallTimeMs:      30_000,            // 30 saniye duvar saati
  allowNetwork:    false,             // ağ kapalı
}
```

---

## Davranış İzleme

**BehaviorMonitor** ihlal kuralları:

| Kural | Tetikleyici | Şiddet |
|---|---|---|
| Ağ erişimi (`allowNetwork: false`) | `network_connect/listen` | violation |
| Alt süreç başlatma | `process_spawn` | violation |
| Kaynak limiti | `resource_limit` | violation |

---

## Policy Kararları

| Durum | Karar |
|---|---|
| Temiz çalışma | approve |
| Timeout | manual_review |
| Ağ girişimi / süreç başlatma | reject |
| Çöküş (crashed) | reject |
| Diğer ihlaller | manual_review |

---

## Statik Analiz Ön Kontrolü

```typescript
// Aşama 12 reddettiyse sandbox'a bile girilmez
if (staticReport.decision.decision === "reject") {
  return fail("PRE_REJECTED", reason);
}
```

---

## ADR Özeti (Aşama 13'te eklendi)

| ADR | Konu |
|---|---|
| ADR-001 | Fraktal Küp Motoru — 11³ koordinat sistemi |
| ADR-002 | Arama Motoru — hibrit semantik+yapısal |
| ADR-003 | Pulse Engine — deterministik adalet zamanlayıcısı |
| ADR-004 | Güvenlik + Sandbox katman ayrımı |

---

## Sonraki Aşamanın Amacı

**Aşama-14 — Dağıtık Düğüm Senkronizasyonu**

- `ContainerSandboxAdapter` → gerçek Docker izolasyonu
- Düğümler arası pulse senkronizasyonu (aynı `pulseNumber`)
- Merkezi olmayan metadata dağıtımı
- P2P gossip protokolü taslağı
