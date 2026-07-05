# 1XX1 Platform — Güvenlik Rehberi

**Sürüm:** 1.0.0

---

## Güvenlik Modeli

1XX1'in güvenlik tasarımı şu prensipler üzerine kuruludur:

### 1. Deny-by-Default Yetki

- Plugin'ler varsayılan olarak hiçbir izne sahip değildir
- Her izin manifest'te açıkça beyan edilmeli ve registry tarafından onaylanmalıdır
- İzin dışı kaynak erişimi sessizce reddedilir, log'a düşer

### 2. Cryptographic Integrity

- Her düğüm mesajı Ed25519 imzalıdır (`distributed/security/signature.ts`)
- İmza doğrulaması olmayan mesajlar gossip katmanında reddedilir
- CID (Content ID) = SHA-256(içerik) — içerik adresli depolama bütünlük garantisi

### 3. Pulse Manipülasyon Koruması

- Para/bağış sıralamayı **hiçbir zaman** etkilemez (INVARIANTS II-1)
- Plugin'ler Pulse skorunu yalnızca `MAX_PLUGIN_PULSE_WEIGHT = 0.05` sınırıyla etkileyebilir
- Consensus write-ban: hiçbir plugin Raft'a komut öneremez

### 4. Sandbox Isolation

Üç seviye savunma:

```
Seviye 1 — Manifest Doğrulama  (kayıt öncesi)
Seviye 2 — IsolationLevel Kontrolü (aktivasyon öncesi)
Seviye 3 — PluginContext API Sınırı (çalışma zamanı)
```

Plugin'ler yalnızca `PluginContext` üzerinden, yalnızca izin verilen
kaynaklara erişebilir. Doğrudan Repository/Store erişimi yoktur.

---

## Tehdit Modeli

| Tehdit | Kontrol Mekanizması | Durum |
|---|---|---|
| Yetkisiz veri erişimi | Deny-by-default izin, PluginContext | ✅ Uygulandı |
| Pulse sıralama manipülasyonu | MAX_PLUGIN_PULSE_WEIGHT, consensus write-ban | ✅ Uygulandı |
| Sybil saldırısı (sahte validator) | Kapalı ValidatorSet, Raft propose-ban | ✅ Uygulandı |
| Circular plugin dependency | PluginDependencyGraph DAG doğrulama | ✅ Uygulandı |
| Kötü niyetli node mesajı | Ed25519 imza doğrulama | ✅ Uygulandı |
| Log replay bütünlüğü | Deterministik event log, SHA-256 checksum | ✅ Uygulandı |
| Plugin Sandbox drift | IsolationLevel zorunlu beyan + doğrulama | ✅ Uygulandı |
| DOS via gossip flood | LRU duplicate cache (10.000), TTL, anti-storm | ✅ Uygulandı |
| Gerçek kod izolasyonu (WASM/VM) | Aşama 19 kapsamında PluginSandboxRunner sözleşme katmanı | ⚠️ Kısmi (Aşama 21+ tam izolasyon) |
| TLS transit şifreleme | Transport-agnostic; TLS wrapper gerekli | ⚠️ Yapılandırmaya bağlı |

---

## Güvenlik Açığı Bildirme

Bir güvenlik açığı bulduysanız:

1. **Kamuya açıklamayın** — doğrudan Kaptan'a bildirin
2. Ayrıntılı açıklama: etkilenen bileşen, adımlar, etki
3. 7 gün içinde yanıt, 30 gün içinde yama hedeflenir

**E-posta:** [Kaptan iletişim bilgisi]

---

## Kriptografik Bileşenler

| Bileşen | Algoritma | Amaç |
|---|---|---|
| Mesaj imzalama | Ed25519 | Düğüm kimlik doğrulama |
| İçerik adresleme | SHA-256 | CID, chunk doğrulama |
| Checksum | SHA-256 + SHA-512 | Asset bütünlük |
| Snapshot hash | SHA-256(JSON) | Compaction bütünlük |
| Log digest | SHA-256 | Compaction denetim |

---

## Güvenlik Kontrol Listesi (Deployment)

```
[ ] Ed25519 özel anahtarları Kubernetes Secret olarak saklanıyor
[ ] X1_NODE_PRIVATE_KEY değişkeni değer dosyasına yazılmıyor
[ ] TLS terminasyonu ingress'te yapılıyor
[ ] Prometheus metrics endpoint'i iç ağa kısıtlı
[ ] Docker image non-root kullanıcıyla çalışıyor (x1user:x1group)
[ ] PodDisruptionBudget aktif (minAvailable: 2)
[ ] Network policy: node'lar arası X1 portları dışında tüm trafik reddedilmiş
```
