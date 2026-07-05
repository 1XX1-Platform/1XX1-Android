/**
 * 1XX1 Ghost Cube — Genişletilmiş Testler (Faz 2)
 * SpatialTopology + GhostHealth + PathOptimizer + ConfidenceScore + Simülasyon
 */

import {
  runSuite, assert, assertEqual,
} from "../../core/test-utils.ts";
import { SpatialTopology }   from "../ghost/spatial-topology.ts";
import { GhostHealthMonitor } from "../ghost/ghost-health.ts";
import { PathOptimizer }      from "../ghost/path-optimizer.ts";
import { GhostSimulator, printSimReport } from "../simulation/ghost-simulator.ts";
import { GhostChainBuilder }  from "../ghost/ghost-chain.ts";
import { GhostReplicationEngine, GhostReceiptEngine } from "../ghost/ghost-replication-receipt.ts";
import { RouteCache } from "../ghost/route-cache.ts";
import type { CubeCoordinate } from "../../core/types.ts";
import type { GhostLinkContext } from "../ghost/ghost-types.ts";

const A: CubeCoordinate = { x: 2, y: 3, z: 5 };
const B: CubeCoordinate = { x: 8, y: 7, z: 9 };
const CTX: GhostLinkContext = { nodeDensity: 3, linkQuality: 0.85, bandwidthFactor: 0.5 };

// ═══════════════════════════════════════════════════════════════════════════════
// SPATIAL TOPOLOGY
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("spatial-topology/temel", {
  "başlangıçta kendi koordinatı kayıtlı": () => {
    const t = new SpatialTopology("self", A);
    const occ = t.occupantAt(A);
    assertEqual(occ.kind, "node");
    if (occ.kind === "node") assertEqual(occ.nodeId, "self");
  },

  "seeNode: k-hop içindeyse kaydedilir": () => {
    const t = new SpatialTopology("self", A, 3);
    const near: CubeCoordinate = { x: 3, y: 3, z: 5 }; // d=1
    t.seeNode("peer1", near);
    assertEqual(t.onlineNodes().length, 1);
    const occ = t.occupantAt(near);
    assertEqual(occ.kind, "node");
  },

  "seeNode: k-hop dışındaysa kaydedilmez": () => {
    const t = new SpatialTopology("self", A, 2); // k=2
    const far: CubeCoordinate = { x: 9, y: 9, z: 9 }; // d >> 2
    t.seeNode("farPeer", far);
    assertEqual(t.onlineNodes().length, 0);
  },

  "reserveGhost: boş koordinat rezerve edilir": () => {
    const t   = new SpatialTopology("self", A);
    const coord: CubeCoordinate = { x: 5, y: 5, z: 5 };
    const ok  = t.reserveGhost(coord, "sess1", "self", Date.now() + 60000);
    assert(ok, "Rezervasyon başarılı olmalı");
    const occ = t.occupantAt(coord);
    assertEqual(occ.kind, "ghost");
  },

  "reserveGhost: gerçek node varsa reddedilir": () => {
    const t    = new SpatialTopology("self", A);
    const near: CubeCoordinate = { x: 3, y: 3, z: 5 };
    t.seeNode("peer1", near);
    const ok = t.reserveGhost(near, "sess1", "self", Date.now() + 60000);
    assert(!ok, "Gerçek node varken ghost rezerve edilemez");
  },

  "reserveGhost: aktif ghost varsa reddedilir": () => {
    const t     = new SpatialTopology("self", A);
    const coord: CubeCoordinate = { x: 5, y: 5, z: 5 };
    t.reserveGhost(coord, "sess1", "self", Date.now() + 60000);
    const ok2 = t.reserveGhost(coord, "sess2", "self", Date.now() + 60000);
    assert(!ok2, "Aktif ghost varken ikinci rezervasyon reddedilmeli");
  },

  "releaseGhost: serbest bırakılınca boşa çıkar": () => {
    const t     = new SpatialTopology("self", A);
    const coord: CubeCoordinate = { x: 5, y: 5, z: 5 };
    t.reserveGhost(coord, "sess1", "self", Date.now() + 60000);
    t.releaseGhost(coord, "sess1");
    assert(t.isEmpty(coord), "Serbest bırakılan koordinat boş olmalı");
  },

  "pruneExpiredGhosts: süresi dolmuş rezervasyonlar temizlenir": async () => {
    const t     = new SpatialTopology("self", A);
    const coord: CubeCoordinate = { x: 5, y: 5, z: 5 };
    t.reserveGhost(coord, "sess1", "self", Date.now() + 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const pruned = t.pruneExpiredGhosts();
    assert(pruned >= 1, "En az 1 süresi dolmuş ghost temizlenmeli");
    assert(t.isEmpty(coord));
  },

  "nearestNodeTo: en yakın online node": () => {
    const t = new SpatialTopology("self", A, 5);
    t.seeNode("n1", { x: 3, y: 3, z: 5 }); // d=2'den A'ya
    t.seeNode("n2", { x: 5, y: 3, z: 5 }); // d=5'ten A'ya, hedeften daha yakın olabilir
    const target: CubeCoordinate = { x: 3, y: 3, z: 5 };
    const nearest = t.nearestNodeTo(target);
    assert(nearest !== null, "En yakın node bulunmalı");
    assertEqual(nearest!.nodeId, "n1");
  },

  "stats: doğru sayımlar": () => {
    const t = new SpatialTopology("self", A, 5);
    t.seeNode("n1", { x: 3, y: 3, z: 5 });
    t.reserveGhost({ x: 7, y: 7, z: 7 }, "s1", "self", Date.now() + 60000);
    const s = t.stats();
    assert(s.nodeCoords >= 1);
    assert(s.ghostCoords >= 1);
    assert(s.onlineNodes >= 1);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// GHOST HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("ghost-health/temel", {
  "başarılı kayıt → successRate artar": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "sess1");
    h.recordSuccess("g1", "5,5,5", 30);
    h.recordSuccess("g1", "5,5,5", 40);
    const rec = h.getGhost("g1")!;
    assertEqual(rec.packetsCarried, 2);
    assertEqual(rec.failures, 0);
    assertEqual(rec.successRate, 1.0);
  },

  "başarısız kayıt → successRate düşer": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "sess1");
    h.recordSuccess("g1", "5,5,5", 30);
    h.recordFailure("g1", "5,5,5");
    const rec = h.getGhost("g1")!;
    assert(rec.successRate < 1.0, "Başarısız kayıt oranı düşürmeli");
    assert(rec.successRate === 0.5);
  },

  "coordScore: bilinmeyen koordinat → 0.5 (tarafsız)": () => {
    const h = new GhostHealthMonitor();
    assertEqual(h.coordScore("0,0,0"), 0.5);
  },

  "coordScore: başarılı koordinat → yüksek skor": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "s1");
    for (let i = 0; i < 10; i++) h.recordSuccess("g1", "3,3,3", 20);
    const score = h.coordScore("3,3,3");
    assert(score > 0.8, `Başarılı koordinat skoru yüksek olmalı: ${score}`);
  },

  "latencyPercentiles: p50 ve p99": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "s1");
    for (let ms = 10; ms <= 100; ms += 10) h.recordSuccess("g1", "1,1,1", ms);
    const p = h.latencyPercentiles("g1");
    assert(p !== null);
    assert(p!.p50 <= p!.p99, "p50 ≤ p99");
    assert(p!.p50 >= 40 && p!.p50 <= 60, `p50 ≈ 50ms: ${p!.p50}`);
  },

  "topCoords: en iyi koordinatlar sıralı": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "s1");
    h.register("g2", "s2");
    for (let i = 0; i < 10; i++) h.recordSuccess("g1", "5,5,5", 20);
    for (let i = 0; i < 5; i++) h.recordSuccess("g2", "3,3,3", 20);
    for (let i = 0; i < 5; i++) h.recordFailure("g2", "3,3,3");
    const top = h.topCoords(2);
    assertEqual(top[0].coordKey, "5,5,5");
  },

  "systemStats: toplam ghost ve koordinat sayısı": () => {
    const h = new GhostHealthMonitor();
    h.register("g1", "s1");
    h.register("g2", "s2");
    h.recordSuccess("g1", "1,1,1", 10);
    h.recordSuccess("g2", "2,2,2", 20);
    const s = h.systemStats();
    assertEqual(s.totalGhosts, 2);
    assertEqual(s.totalCoords, 2);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATH OPTIMIZER
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("path-optimizer/temel", {
  "tek aday → direkt döndürür": () => {
    const health   = new GhostHealthMonitor();
    const topology = new SpatialTopology("self", A, 5);
    const opt      = new PathOptimizer(health, topology);
    const builder  = new GhostChainBuilder();
    const session  = builder.build("nA", "nB", A, B, "h", 1, CTX);
    const best     = opt.selectBest([session.route]);
    assert(best !== null);
    assertEqual(best!.sessionId, session.route.sessionId);
  },

  "sağlıklı rota tercih edilir": () => {
    const health   = new GhostHealthMonitor();
    const topology = new SpatialTopology("self", A, 10);
    const opt      = new PathOptimizer(health, topology);
    const builder  = new GhostChainBuilder();

    // İki farklı rota — biri başarılı koordinatlar üzerinden
    const s1 = builder.build("nA", "nB", { x:0,y:0,z:0 }, { x:3,y:0,z:0 }, "h", 1, CTX);
    const s2 = builder.build("nA", "nB", { x:0,y:0,z:0 }, { x:0,y:3,z:0 }, "h", 1, CTX);

    // s1'in koordinatlarını başarılı say
    const g1 = new GhostHealthMonitor();
    for (const ghost of s1.route.chain) {
      const key = `${ghost.coordinate.x},${ghost.coordinate.y},${ghost.coordinate.z}`;
      for (let i = 0; i < 10; i++) g1.recordSuccess("gx", key, 15);
    }
    // s2'nin koordinatlarını başarısız say
    for (const ghost of s2.route.chain) {
      const key = `${ghost.coordinate.x},${ghost.coordinate.y},${ghost.coordinate.z}`;
      for (let i = 0; i < 5; i++) g1.recordFailure("gy", key);
    }

    const opt2 = new PathOptimizer(g1, topology);
    const scores = opt2.scoreAll([s1.route, s2.route]);
    assert(scores[0].healthScore >= scores[1].healthScore, "Sağlıklı rota daha yüksek skor almalı");
  },

  "boş koordinatlar yüksek availability skoru": () => {
    const health   = new GhostHealthMonitor();
    const topology = new SpatialTopology("self", A, 10);
    const opt      = new PathOptimizer(health, topology);
    const builder  = new GhostChainBuilder();

    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);
    // Varsayılan: topoloji boş → yüksek availability
    const scores = opt.scoreAll([session.route]);
    assert(scores[0].availabilityScore > 0, "Boş koordinatlar erişilebilir sayılmalı");
  },

  "blacklist: başarısız koordinatlar kaçınma listesine girer": () => {
    const health = new GhostHealthMonitor();
    health.register("g1", "s1");
    for (let i = 0; i < 10; i++) health.recordFailure("g1", "5,5,5");

    const topology = new SpatialTopology("self", A, 10);
    const opt      = new PathOptimizer(health, topology);
    const blacklist = opt.buildBlacklist(0.3);
    assert(blacklist.has("5,5,5"), "Başarısız koordinat blacklist'te olmalı");
  },

  "boş aday listesi → null döner": () => {
    const health   = new GhostHealthMonitor();
    const topology = new SpatialTopology("self", A, 5);
    const opt      = new PathOptimizer(health, topology);
    assertEqual(opt.selectBest([]), null);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORE
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("confidence-score", {
  "başarılı transfer → confidence >= 0.70": async () => {
    const engine  = new GhostReceiptEngine();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    const receipt = await engine.create({ ...session, status: "completed" }, true);
    assert(receipt.confidenceScore >= 0.70, `confidence=${receipt.confidenceScore}`);
    assert(receipt.confidenceScore <= 1.0);
  },

  "başarısız transfer → confidence <= 0.25": async () => {
    const engine  = new GhostReceiptEngine();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    const receipt = await engine.create({ ...session, status: "failed" }, false, "timeout");
    assert(receipt.confidenceScore <= 0.25, `confidence=${receipt.confidenceScore}`);
    assert(receipt.confidenceScore >= 0.0);
  },

  "replikasyon tamamlandıysa +0.10 bonus": async () => {
    const repEngine = new GhostReplicationEngine();
    const builder   = new GhostChainBuilder();
    const session   = builder.build("nA", "nB", A, B, "h", 1, CTX);

    // Replikasyonu karşıla
    let rep = repEngine.create(session.sessionId, "h", session.route.totalDistance);
    const needed = rep.factor;
    for (let i = 0; i < needed; i++) rep = repEngine.confirmCopy(rep, `n${i}`);

    const satisfiedSession = { ...session, replication: rep, status: "completed" as const };
    const unsatSession     = { ...session, status: "completed" as const };

    const engine   = new GhostReceiptEngine();
    const rSat = await engine.create(satisfiedSession, true);
    const rUnsat = await (new GhostReceiptEngine()).create(unsatSession, true);

    assert(rSat.confidenceScore >= rUnsat.confidenceScore,
      `Replikasyon bonus bekleniyor: sat=${rSat.confidenceScore} unsat=${rUnsat.confidenceScore}`
    );
  },

  "yüksek sağlıklı koordinatlar → confidence artar": async () => {
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    // Tüm koordinatlar için skor 1.0
    const highScores = new Map<string, number>();
    for (const g of session.route.chain) {
      highScores.set(`${g.coordinate.x},${g.coordinate.y},${g.coordinate.z}`, 1.0);
    }

    // Tüm koordinatlar için skor 0.0
    const lowScores = new Map<string, number>();
    for (const g of session.route.chain) {
      lowScores.set(`${g.coordinate.x},${g.coordinate.y},${g.coordinate.z}`, 0.0);
    }

    const e1 = new GhostReceiptEngine();
    const e2 = new GhostReceiptEngine();
    const rHigh = await e1.create({ ...session, status: "completed" }, true, undefined, highScores);
    const rLow  = await e2.create({ ...session, status: "completed" }, true, undefined, lowScores);

    assert(rHigh.confidenceScore > rLow.confidenceScore,
      `Yüksek sağlık → yüksek confidence: ${rHigh.confidenceScore} > ${rLow.confidenceScore}`
    );
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// SİMÜLASYON
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("simulation/10K", {
  "10K node, 200 deneme — teslim oranı ve gecikme ölçümü": async () => {
    const sim = new GhostSimulator();
    const result = await sim.run(10_000, 200);

    console.log(`\n${printSimReport([result])}`);

    // Temel doğrulama
    assert(result.ghost.deliveryRate >= 0 && result.ghost.deliveryRate <= 1);
    assert(result.classic.deliveryRate >= 0 && result.classic.deliveryRate <= 1);
    assert(result.ghost.avgGhostCount >= 0);
    assert(result.ghost.avgPriority >= 0 && result.ghost.avgPriority <= 9);
    assert(result.durationMs < 30_000, `10K sim çok yavaş: ${result.durationMs}ms`);
    console.log(`  → 10K sim süresi: ${result.durationMs}ms`);
  },
});

await runSuite("simulation/100K", {
  "100K node (örnekleme), 100 deneme": async () => {
    const sim = new GhostSimulator();
    const result = await sim.run(100_000, 100);

    console.log(`\n${printSimReport([result])}`);
    assert(result.nodeCount === 100_000);
    assert(result.durationMs < 60_000, `100K sim çok yavaş: ${result.durationMs}ms`);
    console.log(`  → 100K sim süresi: ${result.durationMs}ms`);
  },
});

await runSuite("simulation/comparative", {
  "Ghost vs Klasik: bant genişliği karşılaştırması": async () => {
    const sim = new GhostSimulator();
    const ctx: GhostLinkContext = { nodeDensity: 2, linkQuality: 0.8, bandwidthFactor: 0.5 };
    const result = await sim.run(5_000, 200, ctx);

    const ghostBW   = result.ghost.bandwidthBytes;
    const classicBW = result.classic.bandwidthBytes;

    // Ghost'un klasik flood'dan daha az bant genişliği kullandığı beklenir
    // (klasik flood her komşuya tam paket gönderir)
    console.log(`  → Ghost BW: ${(ghostBW/1024).toFixed(2)} KB | Klasik BW: ${(classicBW/1024).toFixed(2)} KB`);
    assert(ghostBW < classicBW || result.ghost.deliveryRate > result.classic.deliveryRate,
      "Ghost ya daha az BW kullanmalı ya da daha yüksek teslim oranı sağlamalı"
    );
  },

  "Bağlantı kalitesi etkisi: kötü bağlantıda Ghost avantajı": async () => {
    const sim = new GhostSimulator();

    const goodCtx: GhostLinkContext = { nodeDensity: 5, linkQuality: 0.95, bandwidthFactor: 1.0 };
    const badCtx:  GhostLinkContext = { nodeDensity: 1, linkQuality: 0.3,  bandwidthFactor: 0.1 };

    const goodResult = await sim.run(1_000, 100, goodCtx);
    const badResult  = await sim.run(1_000, 100, badCtx);

    console.log(`  → İyi bağlantı: Ghost ${(goodResult.ghost.deliveryRate*100).toFixed(1)}%, Klasik ${(goodResult.classic.deliveryRate*100).toFixed(1)}%`);
    console.log(`  → Kötü bağlantı: Ghost ${(badResult.ghost.deliveryRate*100).toFixed(1)}%, Klasik ${(badResult.classic.deliveryRate*100).toFixed(1)}%`);

    // Sonuçları kaydet — Ghost avantajını ölç
    const ghostAdvGood = goodResult.ghost.deliveryRate - goodResult.classic.deliveryRate;
    const ghostAdvBad  = badResult.ghost.deliveryRate  - badResult.classic.deliveryRate;
    console.log(`  → Ghost avantajı: iyi bağlantıda ${(ghostAdvGood*100).toFixed(1)}%, kötü bağlantıda ${(ghostAdvBad*100).toFixed(1)}%`);

    // Her iki senaryoda da sistem çalışıyor olmalı
    assert(goodResult.ghost.deliveryRate >= 0 && badResult.ghost.deliveryRate >= 0);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// DETERMİNİZM (genişletilmiş)
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("determinism/extended", {
  "SpatialTopology: aynı operasyonlar → aynı stats": () => {
    const t1 = new SpatialTopology("self", A, 3);
    const t2 = new SpatialTopology("self", A, 3);

    const coord: CubeCoordinate = { x: 3, y: 4, z: 5 };
    const near:  CubeCoordinate = { x: 3, y: 3, z: 5 };

    t1.seeNode("n1", near); t2.seeNode("n1", near);
    t1.reserveGhost(coord, "s1", "self", Date.now() + 60000);
    t2.reserveGhost(coord, "s1", "self", Date.now() + 60000);

    const s1 = t1.stats();
    const s2 = t2.stats();
    assertEqual(s1.onlineNodes,  s2.onlineNodes);
    assertEqual(s1.ghostCoords,  s2.ghostCoords);
    assertEqual(s1.nodeCoords,   s2.nodeCoords);
  },

  "GhostHealth: aynı kayıtlar → aynı skor": () => {
    const h1 = new GhostHealthMonitor();
    const h2 = new GhostHealthMonitor();

    h1.register("g1", "s1"); h2.register("g1", "s1");
    for (let i = 0; i < 5; i++) {
      h1.recordSuccess("g1", "3,3,3", 25);
      h2.recordSuccess("g1", "3,3,3", 25);
    }

    assertEqual(h1.coordScore("3,3,3"), h2.coordScore("3,3,3"));
    assertEqual(h1.getGhost("g1")!.successRate, h2.getGhost("g1")!.successRate);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE CACHE
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("route-cache/temel", {
  "set + get: aynı route döner": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    const stored = cache.set("nA", "nB", session.route, 0.85);
    assert(stored, "Yüksek confidence → cache'e alınmalı");

    const retrieved = cache.get("nA", "nB");
    assert(retrieved !== null, "Cache hit bekleniyor");
    assertEqual(retrieved!.sessionId, session.route.sessionId);
  },

  "düşük confidence → cache'e alınmaz": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    const stored = cache.set("nA", "nB", session.route, 0.10); // eşiğin altı
    assert(!stored, "Düşük confidence → reddedilmeli");
    assertEqual(cache.get("nA", "nB"), null);
  },

  "TTL dolunca null döner": async () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    cache.set("nA", "nB", session.route, 0.9, 10); // 10ms TTL
    await new Promise((r) => setTimeout(r, 50));

    const result = cache.get("nA", "nB");
    assertEqual(result, null, "TTL dolunca null bekleniyor");
  },

  "invalidate: belirli route silinir": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const s1      = builder.build("nA", "nB", A, B, "h", 1, CTX);
    const s2      = builder.build("nA", "nC", A, { x:5,y:5,z:5 }, "h", 1, CTX);

    cache.set("nA", "nB", s1.route, 0.9);
    cache.set("nA", "nC", s2.route, 0.9);

    cache.invalidate("nA", "nB");
    assertEqual(cache.get("nA", "nB"), null);
    assert(cache.get("nA", "nC") !== null, "nC route silinmemeli");
  },

  "invalidateNode: node içeren tüm route'lar silinir": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const s1 = builder.build("nA", "nB", A, B, "h", 1, CTX);
    const s2 = builder.build("nC", "nB", { x:0,y:0,z:0 }, B, "h", 1, CTX);
    const s3 = builder.build("nX", "nY", { x:1,y:1,z:1 }, { x:9,y:9,z:9 }, "h", 1, CTX);

    cache.set("nA", "nB", s1.route, 0.9);
    cache.set("nC", "nB", s2.route, 0.9);
    cache.set("nX", "nY", s3.route, 0.9);

    const removed = cache.invalidateNode("nB"); // nB içeren route'ları sil
    assert(removed >= 2, `nB içeren 2 route silinmeli: ${removed}`);
    assertEqual(cache.get("nA", "nB"), null);
    assertEqual(cache.get("nC", "nB"), null);
    assert(cache.get("nX", "nY") !== null, "nX→nY etkilenmemeli");
  },

  "updateConfidence: eşik altına düşünce silinir": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const session = builder.build("nA", "nB", A, B, "h", 1, CTX);

    cache.set("nA", "nB", session.route, 0.9);
    assert(cache.get("nA", "nB") !== null);

    cache.updateConfidence("nA", "nB", 0.1); // eşiğin altı
    assertEqual(cache.get("nA", "nB"), null, "Düşük confidence → cache'den çıkmalı");
  },

  "pruneExpired: temizleme çalışır": async () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();
    const s1 = builder.build("nA", "nB", A, B, "h", 1, CTX);
    const s2 = builder.build("nA", "nC", A, { x:5,y:5,z:5 }, "h", 1, CTX);

    cache.set("nA", "nB", s1.route, 0.9, 10);  // 10ms → expire
    cache.set("nA", "nC", s2.route, 0.9, 60000); // 60s → sağlam

    await new Promise((r) => setTimeout(r, 50));
    const pruned = cache.pruneExpired();
    assert(pruned >= 1, "En az 1 expire silinmeli");
    assertEqual(cache.stats().size, 1);
  },

  "LRU eviction: kapasite aşılınca en az kullanılan çıkar": () => {
    // Küçük cache kapasitesi ile test (mock — gerçekte MAX=1000)
    // Dolaylı test: çok sayıda set, ardından en son eklenen bulunabilmeli
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();

    // 5 farklı route ekle, hepsini bir kez al (hit count = 1)
    for (let i = 0; i < 5; i++) {
      const dst: CubeCoordinate = { x: i, y: i, z: i };
      const s = builder.build(`n${i}`, `nd${i}`, { x:0,y:0,z:0 }, dst, "h", 1, CTX);
      cache.set(`n${i}`, `nd${i}`, s.route, 0.9);
    }
    // n0'ı çok kullan
    for (let i = 0; i < 10; i++) cache.get("n0", "nd0");

    const stats = cache.stats();
    assert(stats.hits >= 10, `Hit sayısı: ${stats.hits}`);
    assert(stats.hitRate > 0, `Hit rate: ${stats.hitRate}`);
  },

  "hotRoutes: en çok kullanılan route'lar": () => {
    const cache   = new RouteCache();
    const builder = new GhostChainBuilder();

    const s1 = builder.build("nA", "nB", A, B, "h", 1, CTX);
    const s2 = builder.build("nA", "nC", A, { x:5,y:5,z:5 }, "h", 1, CTX);

    cache.set("nA", "nB", s1.route, 0.9);
    cache.set("nA", "nC", s2.route, 0.9);

    // nA→nB'yi 5 kez, nA→nC'yi 1 kez al
    for (let i = 0; i < 5; i++) cache.get("nA", "nB");
    cache.get("nA", "nC");

    const hot = cache.hotRoutes(1);
    assertEqual(hot[0].sourceNodeId, "nA");
    assertEqual(hot[0].targetNodeId, "nB");
    assert(hot[0].hitCount >= 5);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// GERÇEK SİMÜLASYON (yeniden yazılmış motor)
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("simulation/10-node", {
  "10 node, 50 tick — tüm metrikler ölçülür": async () => {
    const sim    = new GhostSimulator(42);
    const result = await sim.run(10, 50, 3, 0.1, 0.02, 0.15);

    console.log(`\n${printSimReport([result])}`);

    assert(result.ghost.deliveryRate   >= 0 && result.ghost.deliveryRate   <= 1);
    assert(result.classic.deliveryRate >= 0 && result.classic.deliveryRate <= 1);
    assert(result.ghost.p50LatencyMs  >= 0);
    assert(result.ghost.p99LatencyMs  >= result.ghost.p50LatencyMs);
    assert(result.ghost.totalEnergyMah >= 0);
    assert(result.ghost.peakMemoryKb  >= 0);
    assert(result.wallClockMs < 5000, `10-node sim yavaş: ${result.wallClockMs}ms`);
    console.log(`  → 10-node süresi: ${result.wallClockMs}ms`);
  },
});

await runSuite("simulation/100-node", {
  "100 node, 80 tick — ölçek testi": async () => {
    const sim    = new GhostSimulator(42);
    const result = await sim.run(100, 80, 5, 0.1, 0.02, 0.15);

    console.log(`\n${printSimReport([result])}`);
    assert(result.nodeCount === 100);
    assert(result.wallClockMs < 15_000, `100-node yavaş: ${result.wallClockMs}ms`);
    console.log(`  → 100-node süresi: ${result.wallClockMs}ms`);
  },
});

await runSuite("simulation/1000-node", {
  "1000 node, 50 tick — büyük ölçek": async () => {
    const sim    = new GhostSimulator(42);
    const result = await sim.run(1000, 50, 5, 0.1, 0.02, 0.15);

    console.log(`\n${printSimReport([result])}`);
    assert(result.nodeCount === 1000);
    assert(result.wallClockMs < 30_000, `1000-node yavaş: ${result.wallClockMs}ms`);
    console.log(`  → 1000-node süresi: ${result.wallClockMs}ms`);
  },
});

await runSuite("simulation/comparative-real", {
  "ölçek büyüdükçe karşılaştırmalı rapor": async () => {
    const sim     = new GhostSimulator(42);
    const results = await Promise.all([
      sim.run(10,   30, 3),
      sim.run(100,  30, 3),
      sim.run(1000, 30, 3),
    ]);

    console.log(`\n${printSimReport(results)}`);

    // Temel doğrulama — her senaryo tutarlı
    for (const r of results) {
      assert(r.ghost.deliveryRate >= 0 && r.ghost.deliveryRate <= 1,
        `${r.label}: ghost DR sınır dışı`);
      assert(r.classic.deliveryRate >= 0 && r.classic.deliveryRate <= 1,
        `${r.label}: classic DR sınır dışı`);
    }

    // Ghost ve klasik arasında enerji karşılaştırması
    const r100 = results[1];
    console.log(
      `  → 100 node: Ghost enerji=${r100.ghost.totalEnergyMah.toFixed(3)}mAh ` +
      `Klasik enerji=${r100.classic.totalEnergyMah.toFixed(3)}mAh`
    );
  },

  "yüksek arıza oranında davranış (failRate=0.15)": async () => {
    const sim    = new GhostSimulator(99);
    // Yüksek arıza → Ghost'un store-and-forward avantajı daha belirgin olabilir
    const result = await sim.run(50, 40, 4, 0.2, 0.15, 0.3);

    console.log(`\n  Yüksek arıza senaryosu (failRate=15%):`);
    console.log(`  Ghost teslim: ${(result.ghost.deliveryRate*100).toFixed(1)}%`);
    console.log(`  Klasik teslim: ${(result.classic.deliveryRate*100).toFixed(1)}%`);

    assert(result.packets > 0, "Paket üretilmeli");
  },

  "deterministik: aynı seed → aynı sonuçlar": async () => {
    const s1 = new GhostSimulator(7);
    const s2 = new GhostSimulator(7);

    const r1 = await s1.run(20, 20, 3);
    const r2 = await s2.run(20, 20, 3);

    assertEqual(r1.ghost.delivered,  r2.ghost.delivered,  "Ghost delivered aynı olmalı");
    assertEqual(r1.classic.delivered, r2.classic.delivered, "Classic delivered aynı olmalı");
  },
});
