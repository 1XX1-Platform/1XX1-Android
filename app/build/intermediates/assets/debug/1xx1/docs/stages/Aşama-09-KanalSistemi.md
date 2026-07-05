# Aşama-09 — Kanal (Ada) Sistemi 2.0

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-10 — 5 Saniyelik Pulse Engine

---

## Mimari: Mikro Ekosistem

```
Developer
  └── Channel (Ada)
        ├── Projects         (mevcut Aşama 08)
        ├── Releases         (sürüm yönetimi)
        │     ├── Version    (semver: major.minor.patch[-prerelease])
        │     └── Artifacts  (platform bazlı + checksum + GPG imza)
        ├── Wallets          (BTC, ETH, Monero, LTC, custom)
        ├── Followers        (bildirim tercihli)
        └── TrustScore       (açıklanabilir metrikler)
```

---

## Entity'ler

### Channel
`id | ownerId | slug | mask | title | description | visibility | wallets | verified | tags | socialLinks | stats | createdAt | updatedAt`

Görünürlük: `public | unlisted | private`

### Release
`id | projectId | channelId | version(semver) | title | notes | status | artifacts[] | isLatest | isPrerelease | publishedAt`

Durumlar: `draft → published → deprecated | yanked`

### ReleaseArtifact
`id | name | platform | size | downloadUrl | checksums(sha256/sha512/blake3) | signedBy | uploadedAt`

Platform'lar: `windows-x64 | linux-x64 | linux-arm64 | macos-arm64 | wasm | android | ios | source | universal`

### Wallet
`id | network | address | label | addedAt`

Network'ler: `bitcoin | ethereum | monero | litecoin | custom`

### ChannelFollow
`followerId | channelId | followedAt | notify{onRelease, onDeprecated}`

---

## Trust Score Metrikleri

| Metrik | Puan | Açıklama |
|---|---|---|
| `openSource` | 20 | Tüm aktif projeler OSI lisansı |
| `verified` | 20 | En az bir proje doğrulandı |
| `reproducibleBuild` | 15 | #reproducible etiketi veya blake3/sha512 |
| `signedRelease` | 20 | En az bir artifact GPG imzalı |
| `securityScan` | 15 | Aşama 12'de doldurulacak |
| `maintainerActivity` | 10 | Son 90 günde güncelleme |
| **Toplam** | **100** | |

**Kara kutu yok.** Kullanıcı her metriği görür ve `explain(metric)` metoduyla açıklama alır.

---

## Servisler

**ChannelService**: oluşturma (slug otomatik, limit 3), güncelleme, cüzdan ekleme/kaldırma, trust score yenileme

**ReleaseService**: semver doğrulama, yayınlama, isLatest yönetimi, deprecate, semver sıralı listeleme

**FollowService**: takip et/bırak, bildirim tercihleri, `notifyOnRelease()` listesi, özel kanal koruması

---

## İş Kuralları

- Maks 3 kanal per geliştirici
- Maks 8 cüzdan per kanal
- Kendi kanalı takip edilemez
- Özel kanal (`private`) yabancı tarafından takip edilemez
- Aynı `projectId + version` çakışması → hata
- Platform ödeme işlemez — cüzdanlar yalnızca görüntülenir

---

## Domain Events

`channel:created` | `channel:updated` | `release:published` | `release:deprecated` | `wallet:added` | `wallet:removed` | `channel:followed` | `channel:unfollowed`

---

## Dosyalar

| Dosya | Satır |
|---|---|
| `channel/entities/channel.entity.ts` | ~160 |
| `channel/repositories/channel.repository.ts` | ~200 |
| `channel/trust/trust-score.ts` | ~120 |
| `channel/services/channel.services.ts` | ~280 |
| `channel/index.ts` | ~55 |
| `channel/__tests__/channel.test.ts` | ~390 |

---

## Sonraki Aşamanın Amacı

**Aşama-10 — 5 Saniyelik Pulse Engine**

Her 5 saniyede:
- Aktif proje listesini döndür
- En üstteki projeyi sona al (döngüsel adalet)
- Yeni projeyi yukarı çıkar
- Kanal güven skoru pulse'u etkiler
- `pulse:tick` olayı yayınla

Pulse Engine, aramanın ötesinde keşif mekanizmasıdır.
