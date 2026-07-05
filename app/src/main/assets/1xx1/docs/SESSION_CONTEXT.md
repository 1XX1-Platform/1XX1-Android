# 1XX1 — Oturum Bağlamı (Her Yeni Sohbette Oku)

## Proje
1XX1: Merkeziyetsiz, reklamsız, açık kaynak uygulama ekosistemi.
"Para sıralamayı hiçbir zaman etkilemez." — temel değişmez.

## Geliştirici
Kaptan (Emirhan) — Vienna, Samsung S23, Termux, tek cihaz geliştirme ortamı.

## Teknik Özet
- 44.000+ satır TypeScript, 189+ dosya
- Node.js --experimental-strip-types ile çalışır (derleme yok)
- Termux'ta test edildi, iki telefon LAN testinden geçti
- ZIP: /mnt/user-data/outputs/1XX1-v1.0.0.zip

## FAZ Durumu
| FAZ | İçerik | Durum |
|-----|--------|-------|
| 0 | Identity (Ed25519, base58 nodeId, persist) | TAMAM |
| 1 | Gossip Discovery (transitive, dedup, failure detect) | TAMAM |
| 2 | Raft (hash-chain, split-brain, commitIndex monoton) | TAMAM |
| 3 | DHT Kademlia-lite + NAT traversal | TAMAM |
| 4 | Reputation (EWMA) + Sybil Guard | TAMAM |
| 5 | Observability (/raft/status, /cluster/state) | TAMAM |
| 6 | Plugin Runtime (EPR 8 EP, DAG, CB, lifecycle) | TAMAM |
| 7 | Plugin Intelligence (Telemetry, CB v2, Rollback, HotSwap) | TAMAM |
| 8 | System Coordination (BehaviorGraph, CausalTracer, PolicyEngine) | TAMAM |
| 9 | Bounded Autonomy (EBM, InteractionGuard, Governor, CAL) | TAMAM |
| 10 | Knowledge Layer (KR, Catalog, Matrix, Recommendations) | TAMAM |
| FAZ X | System Stabilization (RuntimeContract, DriftDetector) | TAMAM |

## Core Freeze v1.0
Core donduruldu. Yeni özellik Core'a girmez, üst katmana çıkar.
Kural: "Bu kod olmadan sistem yaşayamaz mı?" → Evet ise Core, Hayır ise üst katman.

## Mimari
```
Applications (Browser, AI, Store, Chat)
        |
FAZ 9  Bounded Autonomy (Governor, CAL, EBM)
        |
FAZ 8  System Coordination (BehaviorGraph, Policy)
        |
FAZ 7  Plugin Intelligence (Telemetry, Rollback)
        |
FAZ 6  Plugin Runtime (EPR, DAG, Lifecycle)
        |
Observability (FAZ 5)
        |
CORE FREEZE v1.0
(Identity, Gossip, Raft, DHT, Trust, Transport)
        |
Hardware (Phone, RPi, Mini PC, Server)
```

## Mimari Kurallar
1. CB (Circuit Breaker) = SAFETY  → her zaman override eder
2. Intelligence = OPTIMIZE         → sadece oneri verir
3. PolicyEngine = tek karar noktasi
4. CAL sadece izin verilen eylemler: degrade/throttle/isolate/recommend_rollback
5. CB override YASAK

## Calisma Kurallari
1. Her faz sonunda Python/Node ile otomatik test yap
2. Syntax kontrolu yap (tum plugin/ dizini)
3. Test gecince ZIP ver
4. Core'a dokunma
5. Constructor'da private readonly kullanma (Node.js 26 desteklemiyor)
6. interface yerine type = kullan (strip-types uyumlulugu)
7. Test kodunda TypeScript cast (as const, as any) kullanma

## Test Komutu
```bash
python3 -c "
import subprocess, os
root = '/home/claude/1xx1'
errors = []
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in ('node_modules','__tests__','.git')]
    for fn in fns:
        if not fn.endswith('.ts'): continue
        fp = os.path.join(dp, fn)
        r = subprocess.run(['node','--experimental-strip-types','--check',fp],
                          capture_output=True, text=True)
        if 'ERR_UNSUPPORTED' in r.stderr or 'Script parameter' in r.stderr:
            errors.append(fp.replace(root+'/',''))
print('Temiz' if not errors else f'HATA: {errors}')
"
```

## Termux Baslatma
```bash
cd ~/1XX1-v1.0.0
node --experimental-strip-types main.ts
# http://localhost:1331/app
# http://localhost:1331/cluster/state
# http://localhost:1331/raft/status
```

## Sonraki Adim
FAZ 10 — Knowledge Layer
GPT'den plan al, buraya getir, uygulayalim.
