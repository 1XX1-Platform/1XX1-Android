# ADR-006 — Dağıtık Konsensüs Tasarımı

**Tarih:** 2026-06-28  
**Durum:** Kabul Edildi  
**Aşama:** 15

---

## 1. Problem

Dağıtık düğümler eventual consistency (Aşama 14 Gossip) ile çalışır.  
Ancak bazı kritik veriler kesin tutarlılık gerektirir:

- **Pulse listesi**: tüm düğümlerde aynı sıralama → deterministik keşif
- **Validator seti**: kim oy kullanabilir?
- **Policy değişiklikleri**: hangi kurallar geçerli?

Gossip ile "belki tutarlı" olur, ama "kesinlikle tutarlı" olamaz.

---

## 2. Kararlar

### Neden Raft (Paxos değil)?
- Raft anlaşılabilir: Ongaro'nun tezi "daha anlaşılabilir konsensüs" üzerine
- Lider seçimi + log replikasyon net ayrılmış
- Test edilebilir: `RpcSender` mock → birim test
- Paxos: multi-phase, karmaşık, tarihsel bağımlılıklar

### Neden Lightweight Raft (tam değil)?
- Tam Raft: log compaction, disk persistence, membership change
- 1XX1 için yalnızca **Pulse, validator, policy** konsensüse tabi
- Diğer veri (projeler, assetler) → gossip/eventual consistency
- Disk persistence → Aşama 07 UnitOfWork zaten var (ileride bağlanır)
- Log compaction → Snapshot + EventLog (Aşama 14) ile çözülüyor

### Neden Pulse Bloğu + Zincir?
- Sadece `pulseNumber → entries` yeterli olabilirdi
- Zincir: her blok öncekinin hash'ini içerir → geçmişin değiştirilemezliği
- Hash deterministik: aynı entries → aynı hash → iki düğüm karşılaştırabilir
- Signatures: quorum imzalar → blok kabul

### Neden Validator Seti?
- Herkes Raft'a katılırsa: Sybil attack (sahte düğümler çoğunluğu alır)
- Validator = bilinen, güvenilen, imzası doğrulanmış düğüm
- Validator değişikliği konsensüsle → validator seti tüm düğümlerde aynı
- İleride: stake veya güvenilirlik skoru eklenebilir

---

## 3. Değerlendirilen Alternatifler

| Alternatif | Neden Reddedildi |
|---|---|
| Tam Raft | Log compaction + disk persistence overengineering |
| PBFT | Quadratic message complexity O(n²); byzantine fault tolerance gerekmiyor (şimdilik) |
| Tendermint | External dependency; Cosmos ekosistemi kilitlenmesi |
| Sadece Gossip | Eventual consistency → Pulse tutarsızlığı |
| Blockchain | Her işlem için proof → çok ağır |
| Centralized Coordinator | Single point of failure; 1XX1'in değerleriyle çelişiyor |

---

## 4. Sonuçlar

**Artıları:**
- Pulse listesi tüm düğümlerde deterministik → adalet garantisi
- Validator seti konsensüsle değişir → Sybil protection
- RaftEngine bağımsız test edilebilir (RpcSender mock)
- PulseBlock zinciri geçmişi değiştirilemez kılar
- Gossip + Raft katman ayrımı: kritik ≠ kritik olmayan

**Eksileri:**
- Lider gereksinimi → lider çöküşünde seçim süresi (150-300ms)
- Log compaction yapılmıyor → uzun çalışmada log büyür (Aşama 16'da çözülecek)
- Byzantine fault tolerance yok → kötü niyetli validator seti bozabilir (şimdilik itimat güvenlik)
- Ed25519 validator imzası tam implemente değil (MockSignatureProvider test için)

---

## 5. İleride Değiştirilebilir Noktalar

- `RaftEngine.restoreLog()` → Aşama 07 UnitOfWork persistence
- `ValidatorSetManager` → stake mekanizması (Aşama 18)
- `PulseBlockChain` → LevelDB veya IPFS CAR formatı
- Byzantine fault → PBFT veya BLS imzası (ihtiyaç olursa)
- Log compaction → snapshot tabanlı (Aşama 16)
- Validator election → reputation score (Aşama 18)

---

## İlgili Bileşenler

`consensus/raft/raft-engine.ts` · `consensus/pulse-sync/pulse-synchronizer.ts` · `consensus/validator/validator-set.ts` · `consensus/node/consensus-node.ts`
