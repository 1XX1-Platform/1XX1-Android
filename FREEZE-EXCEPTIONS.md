## Istisna 001 - 2026-07-10
Dosya: distributed/discovery/gossip-discovery.ts (_checkPeerHealth)
Gerekce: Health check kimlik dogrulamiyordu; endpoint devri sonrasi
hayalet peer'lar sonsuza dek canli tutuluyordu (sahada kanitlandi:
77EQcT.../android-6025 cift kayit). Duzeltme: health cevabindaki
nodeId kayitla uyusmazsa markSeen yerine remove.
Kapsam: ~7 satir, sadece discovery katmani. Onay: Kaptan.
Guncelleme 2026-07-10: Istisna 001 kontrolu cift kimlik uzayini (cihaz adi + Ed25519) tanir hale getirildi; sil-ekle dongusu kapatildi.
