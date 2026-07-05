# 1XX1 Core Manifest

**Versiyon:** 1.0  
**Tarih:** 2026-07-04  
**Durum:** ANAYASA — değiştirilemez, sadece ekleme yapılabilir

---

## 1. Core'un Amacı

> Core işletim sistemi değildir. Core, güven katmanıdır.

Core'un tek görevi: ağdaki her katmanın güvenebileceği ortak kuralları sağlamak.

Uygulama çalıştırmak Core'un görevi değildir.  
Kullanıcı arayüzü Core'un görevi değildir.  
İş mantığı Core'un görevi değildir.

---

## 2. Core'un Sorumlulukları

Sadece şunlar:

- **Kimlik:** Her node'un spoof edilemez, kalıcı kimliği
- **Zaman:** Monotonic logical clock, drift tolerance
- **Ağ:** Gerçek endpoint normalizasyonu (0.0.0.0 yasak)
- **Keşif:** Peer discovery, gossip propagation, failure detection
- **Konsensüs:** Raft — lider seçimi, log replikasyonu, hash-chain
- **Güvenlik:** Ed25519 imzalama, peer dedup, split-brain engeli
- **Taşıma:** ITransport abstraction

---

## 3. Core'un Asla Yapmayacakları

- Uygulama çalıştırmaz
- Kullanıcı verisi saklamaz
- Arayüz sunmaz
- AI veya ML işlem yapmaz
- Ücret veya ödeme işlemez
- İçerik moderasyonu yapmaz
- Merkezi karar vermez

---

## 4. Core'a Yeni Kod Ekleme Kuralı

Her Core değişikliği şu soruyu geçmeli:

> "Bu kod olmadan sistem yaşayamaz mı?"

**Cevap EVET → Core'a girebilir.**  
**Cevap HAYIR → Üst katmana çıkar.**

Ek koşullar:
- Test ile kanıtlanmış olmalı
- Geriye dönük uyumlu olmalı
- `PROTOCOL_V1.md` ile senkron tutulmalı
- En az 1 chaos testi geçmeli

---

## 5. Freeze Policy (Değişiklik Politikası)

Core Freeze v1.0 sonrası sadece şunlar yapılabilir:

| İzin Verilen | İzin Verilmeyen |
|---|---|
| Bug fix (test ile) | Yeni özellik |
| Güvenlik yaması | API değişikliği |
| Performans opt. | Davranış değişikliği |
| Belge güncellemesi | Core'a yeni modül |

---

## 6. Katman İlişkisi

```
Applications
  Browser · AI · Store · Chat · Games
                   │
           Service Layer
                   │
    Knowledge · Ghost · Spatial
                   │
───────────────────────────────────────
         OBSERVABILITY (FAZ 5)
   /raft/status · /cluster/state
───────────────────────────────────────
            CORE FREEZE v1.0
  Identity · Crypto · EventBus
  Gossip · PeerTable · Network
  Transport · Raft · Journal
───────────────────────────────────────
           Hardware Layer
  Phone · Raspberry Pi · Mini PC · Server
```

**Kritik kural:**
```
Core ─────► Observability   (tek yön)
Observability ───X──► Core  (yasak)
```

Observability Core'u okur, asla değiştirmez.

---

## 7. Tanım

> 1XX1, dağıtık dijital yaşamın güvenilir temelini sağlayan  
> bir protokoller bütünü ve onun etrafında oluşan ekosistemdir.

Bu tanım değişmez.
