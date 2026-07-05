# 1XX1 Platform — Değişmezler (INVARIANTS)

**Sürüm:** Aşama 17  
**Durum:** Zorunlu — Bu kurallar hiçbir zaman ihlal edilmez.

---

## Neden Değişmezler?

30.000+ satırlık projelerde en büyük risk özellik eksikliği değil,  
**mimari tutarlılığın zamanla bozulmasıdır.**

Bu dosyadaki her kural test edilebilir ve otomatik doğrulanabilir olmalıdır.  
Yeni bir özellik bu kuralları ihlal ediyorsa, kural değiştirilmez — özellik yeniden tasarlanır.

---

## I. Katman Bağımlılıkları

### I-1: Çekirdek katman hiçbir üst katmanı import etmez.
```
// ✅ İzin verilir
import type { ILogger } from "../../core/interfaces.ts";

// ❌ Yasaktır
import { PulseEngine } from "../../pulse/pulse-scheduler.ts"; // core içinde
```

### I-2: Search Engine hiçbir zaman Repository'ye yazmaz.
```
// ✅ İzin verilir
searchIndex.index(project);     // okur, indeksler

// ❌ Yasaktır
projectRepo.create(project);    // Search içinde repository yazma
```

### I-3: Pulse Engine hiçbir zaman Consensus'u import etmez.
```
// ✅ İzin verilir
// PulseScheduler sadece PulseSnapshot üretir
// ConsensusNode.commitPulse(snapshot) dışarıdan çağrılır

// ❌ Yasaktır
import { RaftEngine } from "../../consensus/raft/raft-engine.ts"; // pulse içinde
```

### I-4: Consensus hiçbir zaman Asset modülünü import etmez.
```
// ✅ Doğru yol
// asset:publish komutu konsensüse gider → applyCmd → EventBus

// ❌ Yasaktır
import { AssetService } from "../../asset/service/asset.service.ts"; // consensus içinde
```

### I-5: Transport hiçbir zaman Domain modülünü import etmez.
```
// ✅ Transport sadece byte/envelope taşır
// Domain logic transport'a dokunmaz

// ❌ Yasaktır
import { Channel } from "../../channel/entities/channel.entity.ts"; // transport içinde
```

### I-6: Domain hiçbir zaman HTTP'yi bilmez.
```
// ✅ Domain service — HTTP agnostik
class ChannelService {
  async create(data: CreateChannelData): Promise<CommandOutcome<Channel>> { ... }
}

// ❌ Yasaktır
class ChannelService {
  async handleRequest(req: Request, res: Response) { ... } // Domain'de HTTP
}
```

### I-7: EventBus hiçbir zaman Storage'ı bilmez.
```
// ✅ EventBus sadece event yayar
eventBus.emit("project:created", { projectId });

// ❌ Yasaktır
eventBus.on("project:created", () => db.query(...)); // EventBus içinde storage
```

### I-8: Gossip hiçbir zaman ham asset binary taşımaz.
```
// ✅ Gossip: metadata + CID
gossip.spread({ type: "gossip:data", payload: { cid, size, mimeType } });

// ❌ Yasaktır
gossip.spread({ type: "gossip:data", payload: { data: binaryBuffer } }); // ham veri
```

### I-9: Index hiçbir zaman Persistence'a yazmaz.
```
// ✅ Index okur, sıralar, döndürür
searchIndex.query("stl motor");

// ❌ Yasaktır
searchIndex.persist(result); // Index katmanında DB yazma
```

### I-10: Çevrimsel bağımlılık (circular import) yasaktır.
```
// ❌ Yasaktır
// a.ts → b.ts → a.ts
import { B } from "./b.ts"; // a.ts'de
import { A } from "./a.ts"; // b.ts'de — circular!
```

### I-11: Preview Core platform bağımsızdır. Renderer Browser/DOM bilir. Core hiçbir zaman Renderer'ı import edemez.
```typescript
// ✅ İzin verilir — Renderer, Core'u import eder (tek yönlü)
// preview/renderer/markdown-renderer.ts
import type { PreviewResult } from "../core/preview-types.ts";

// ❌ Yasaktır — Core, Renderer'ı import edemez
// preview/core/preview-service.ts
import { HtmlRendererRegistry } from "../renderer/renderer-types.ts"; // YASAK

// ✅ Her renderer renderToHtml() sağlamak ZORUNDADIR (platform bağımsız)
interface IPreviewRenderer {
  renderToHtml(preview: PreviewResult): string;      // her ortamda çalışır
  render?(preview: PreviewResult): HTMLElement|null; // opsiyonel, yalnızca tarayıcı
}

// ❌ Yasaktır — Core içinde document/window/HTMLElement kullanımı
function extractMarkdown(data: Uint8Array) {
  const div = document.createElement("div"); // YASAK — Core'da DOM erişimi
}
```
Bu ayrım sayesinde aynı Preview Core; React, Vue, Svelte, Electron, Tauri,
CLI ve mobil istemciler tarafından yeniden kullanılabilir — yalnızca
renderer katmanı değişir.

---

## II. Veri Değişmezleri

### II-1: Para/bağış sıralamayı hiçbir zaman etkilemez.
Pulse skoru: `pulseAge × 0.50 + fairness × 0.40 + trust × 0.10 - penalty`  
Ödeme bilgisi bu formülde yer almaz. Cüzdanlar yalnızca görüntülenir.

### II-2: payload:any yasaktır.
```typescript
// ❌ Yasaktır
interface MessageEnvelope { payload: any; }

// ✅ Her payload tipli
type EnvelopePayload = GossipDataPayload | HeartbeatPayload | SyncDeltaPayload | ...;
```

### II-3: MessageEnvelope immutable'dır.
```typescript
// ✅ Object.freeze kullanılır
const env = Object.freeze(createEnvelope({ ... }));

// ❌ Yasaktır
env.ttl = 0; // mutation
```

### II-4: Log deterministik replay garantisi
Aynı EventLog + aynı başlangıç state → her zaman aynı sonuç.  
Replay sırasında dış sistem çağrısı yapılamaz.

### II-5: Conflict resolution rastgele seçim yapamaz.
DeterministicResolver: Clock → Version → Timestamp → Signature → NodeId  
`Math.random()` bu sırada kullanılamaz.

### II-6: Pulse sıralaması için seçim timeout deterministik.
`seededRandom(nodeId:attempt)` — test tekrarlanabilirliği için.

---

## III. Güvenlik Değişmezleri

### III-1: Node doğrulanmamış mesajı işlemez.
```
Checksum → Signature → ProtocolVersion → TTL → Deserialize → Dispatch
```
Bu sıra kısaltılamaz.

### III-2: Sandbox karar vermez — yalnızca gözlemler.
```
// ✅ Sandbox: davranış raporu döndürür
sandboxService.run(cmd) → BehaviorReport

// ❌ Yasaktır
sandboxService.approve(assetId); // Sandbox içinde karar
```

### III-3: Policy Engine tek karar noktasıdır.
`approve | manual_review | reject` yalnızca `PolicyEngine.decide()` üretir.

### III-4: Proprietary lisanslı asset indirilemez.
```typescript
if (asset.license === "Proprietary") return null; // download() içinde
```

### III-5: Çocuk güvenliği — içerik filtresi.
Herhangi bir içerik tarama katmanı devre dışı bırakılamaz.

---

## IV. Performans Değişmezleri

### IV-1: Search Engine EventBus'a yazmaz (READ-ONLY).
Arama isteği hiçbir yan etki üretmez.

### IV-2: Pulse tick bloke olamaz (eşzamanlı tick koruması).
`_ticking` bayrağı: ikinci tick birincisi bitmeden başlamaz.

### IV-3: 1000 Pulse projesi < 5 saniyede sıralanmalı.
`RankingEngine.rank(100_000 projects)` < 5000ms

### IV-4: 1000 düğüm Gossip yayılımı < 5 saniye.
Fan-out k=6, TTL=8 → log6(1000)≈4 hop

---

## V. API Değişmezleri

### V-1: API hiçbir zaman domain nesnesi döndürmez — DTO döndürür.
```typescript
// ❌ Yasaktır
return channel; // domain entity

// ✅ İzin verilir
return toChannelSummary(channel, trustScore); // DTO
```

### V-2: Hassas veri hiçbir zaman API yanıtında yer almaz.
Private key, seed, şifre → asla serialize edilmez.

### V-3: Rate limiting atlatılamaz.
Token bucket her endpoint için bağımsız çalışır.

---

## VI. Plugin Değişmezleri (Aşama 19)

### VI-1: Hiçbir plugin sistem çekirdeğini doğrudan import edemez.
```typescript
// ❌ Yasaktır — plugin domain modülüne doğrudan erişir
import { ChannelService } from "../../channel/services/channel.services.ts";

// ✅ İzin verilir — yalnızca PluginContext üzerinden, izin dahilinde
async init(ctx: PluginContext) {
  const data = await ctx.readResource("read:pulse_snapshot");
}
```

### VI-2: Plugin'in Pulse sıralamasına etkisi matematiksel olarak sınırlıdır (MAX_PLUGIN_PULSE_WEIGHT).
```typescript
// Kötü niyetli veya hatalı bir plugin bile sıralamayı domine edemez
const maliciousValue = 9999;
const safeEffect = clampPulseAdjustment(maliciousValue); // her zaman ≤ 0.05
```
Bu, II-1 ("Para/bağış sıralamayı hiçbir zaman etkilemez") değişmezinin
plugin ekosistemine genişletilmiş halidir.

### VI-3: Event interceptor'lar event akışını asla durduramaz veya mutasyona uğratamaz.
```typescript
// ✅ Doğru sözleşme — dönüş değeri YOK (fire-and-forget)
onEvent(eventType: string, payload: Record<string, unknown>): Promise<void>;

// ❌ Yasaktır — event'i değiştirip geri döndürme imkanı
onEvent(event): Promise<ModifiedEvent>; // YASAK tasarım
```

### VI-4: Plugin'ler asla Consensus'a komut öneremez veya validator olamaz.
```typescript
// IConsensusExtension yalnızca salt-okunur callback sağlar
onStateChange?(state: ConsensusState): Promise<void>;
onPulseBlockCommitted?(block: PulseBlock): Promise<void>;
// "propose()" veya "vote()" metodu KASITLI OLARAK arayüzde yoktur
```
Bu, ADR-006'daki Sybil-direnç garantisini (yalnızca bilinen validator'lar
oy kullanabilir) plugin ekosisteminde de korur.

### VI-5: Plugin sandbox'ı varsayılan olarak hiçbir izin vermez (deny-by-default).
```typescript
// Manifest'te belirtilmeyen her izin reddedilir
permissions: PluginPermission[]; // boş dizi = sıfır yetki
```

---

## Değişmez İhlali Protokolü

Bir değişmez ihlali tespit edilirse:

1. Derhal bir GitHub Issue aç (etiket: `invariant-violation`)
2. Kodu `// INVARIANT VIOLATION: I-X` yorumuyla işaretle
3. PR'da sadece düzeltme — yeni özellik ekleme
4. Reviewer onayı zorunlu — tek kişi merge edemez

---

## Güncelleme Kuralı

Bu dosyaya yeni kural eklenebilir.  
Mevcut kural **hiçbir zaman** zayıflatılamaz.  
Yalnızca daha güçlü veya daha spesifik hale getirilebilir.
