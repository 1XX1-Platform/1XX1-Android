# Aşama-12 — Güvenlik Analiz Motoru (Security Analysis Engine)

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-13 — Sandbox Çalıştırma Ortamı

---

## Temel Prensipler

1. **Hiçbir analiz motoru karar vermez** — karar Policy Engine'e aittir
2. **Kara kutu sonuç kabul edilmez** — her bulgu açıklanabilir (`title`, `description`, `snippet`, `recommendation`)
3. **Adaptör mimarisi** — `IAnalyzer` arayüzü: yeni analizörler drop-in eklenebilir
4. **Dosya çalıştırılmaz** — çalıştırma Aşama 13 Sandbox'a aittir
5. **Deterministik** — aynı girdi → aynı rapor

---

## Analiz Pipeline

```
Input
  ↓ MetadataAnalyzer   → MIME uyuşmazlığı, boyut, boş dosya
  ↓ StaticAnalyzer     → kaynak kodu (JS, TS, Py, Sh, vb.)
  ↓ BinaryAnalyzer     → WASM, DLL, EXE, SO
  ↓ DependencyAnalyzer → package.json, requirements.txt
  ↓ RiskEngine.aggregate()
  ↓ PolicyEngine.decide()
→ SecurityReport
```

Paralel çalışma desteklenir (`Promise.allSettled`). Bir analizör çökse pipeline durmaz.

---

## Static Analyzer — 15 Kural

| Kural | Kategori | Risk |
|---|---|---|
| S001: API Key pattern | secret | CRITICAL |
| S002: Gömülü şifre | secret | CRITICAL |
| S003: Token/auth key | secret | HIGH |
| S004: Sertifika/özel anahtar | secret | CRITICAL |
| S010: os.system / subprocess | shell_exec | HIGH |
| S011: Node child_process | shell_exec | HIGH |
| S012: Java Runtime.exec | shell_exec | HIGH |
| S020: eval() | dynamic_code | HIGH |
| S021: new Function() | dynamic_code | HIGH |
| S022: Python __import__ | dynamic_code | MEDIUM |
| S030: fetch/XMLHttpRequest | network_access | MEDIUM |
| S031: WebSocket | network_access | MEDIUM |
| S040: fs.writeFile | fs_access | MEDIUM |
| S050: atob/btoa base64 | obfuscated_code | MEDIUM |
| S051: Uzun hex string | obfuscated_code | LOW |

Her kategoriden max 3 bulgu (false positive baskısı). Snippet'te şifre/key otomatik redact edilir.

---

## Binary Analyzer

Magic bytes ile format doğrulama. Şüpheli API çağrıları (string tablosunda):
- `VirtualAlloc`, `WriteProcessMemory`, `CreateRemoteThread` → CRITICAL
- `ptrace`, `mprotect` → HIGH
- `WinExec`, `ShellExecute` → HIGH
- `UPX!`, `MPRESS` packer imzası → HIGH
- ZLIB/GZIP gömülü payload → MEDIUM

---

## Policy Engine — 6 Kural

| Kural | Tetikleyici | Karar |
|---|---|---|
| P001 | Herhangi CRITICAL | reject |
| P002 | 3+ HIGH bulgu | reject |
| P003 | SECRET kategorisi HIGH/CRITICAL | reject |
| P004 | MIME uyuşmazlığı HIGH | reject |
| P005 | 1–3 HIGH bulgu | manual_review |
| P006 | shell_exec MEDIUM | manual_review |
| (default) | Hiçbiri tetiklenmedi | approve |

---

## Risk Seviyeleri

`none → low → medium → high → critical`

Tek CRITICAL bulgu → kesin ret. Karar, tüm bulguların bileşimidir.

---

## Domain Events

`analysis:started` | `analysis:completed` | `analysis:failed` | `analysis:approved` | `analysis:rejected`

---

## Test Kapsamı (12 grup, 50+ test)

Types, Static (API key, shell, eval, ağ, temiz kod), Binary (VirtualAlloc, UPX, GZIP), Metadata (MIME mismatch), Dependency (CVE), Risk Engine, Policy Engine (P001-P006), Pipeline (tam akış, event, dosya değişmez), Determinizm, False positive azaltma, **100KB kaynak + 50 dosya paralel performans**

---

## Sonraki Aşamanın Amacı

**Aşama-13 — Sandbox Çalıştırma Ortamı**

- Dosyayı izole ortamda çalıştır
- Davranış gözlemi (sistem çağrıları, ağ, dosya sistemi)
- Güvenli çalıştırma sınırları (timeout, bellek, CPU)
- Sandbox raporu → Security Report'a ek katman
- Statik analiz + davranış analizi kombinasyonu
