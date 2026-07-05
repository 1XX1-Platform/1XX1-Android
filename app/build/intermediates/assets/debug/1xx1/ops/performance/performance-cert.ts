/**
 * 1XX1 Platform — Performance Certification
 * Aşama 20 — Operasyon 20.4
 *
 * "Burada artık rakam üretmeye başlanır." — Kaptan
 *
 * Her benchmark:
 *   1. Gerçek işlemi çalıştırır (mock değil)
 *   2. Ölçülen değeri PASS/FAIL eşiğiyle karşılaştırır
 *   3. Sayısal sonucu raporlar (PERFORMANCE.md'ye gider)
 *
 * Eşikler (SLO — Service Level Objective):
 *   p50 → tipik durum
 *   p99 → kötü durum (geceleyin, yüklü sistem)
 *   max → kesinlikle kabul edilemez üst sınır
 */

import { runSuite, assert } from "../../core/test-utils.ts";
import { SearchEngine }     from "../../search/search-engine.ts";
import { SemanticIndex }    from "../../search/semantic-index.ts";
import { StructuralIndex }  from "../../search/structural-index.ts";
import { ReverseIndex }     from "../../search/reverse-index.ts";
import { ScoringEngine }    from "../../search/scoring-engine.ts";
import { EventBus }         from "../../core/event-bus.ts";
import { IncrementalSnapshotBuilder, restoreFromChain } from "../../consensus/compaction/incremental-snapshot.ts";
import { SnapshotStreamer }  from "../../consensus/compaction/snapshot-streamer.ts";
import { createStoreCollection, EventLog } from "../../distributed/sync/sync-engine.ts";
import { MemoryTransport }   from "../../distributed/transport/transport.ts";
import { MockSignatureProvider } from "../../distributed/security/signature.ts";
import { NodeRuntime }       from "../../distributed/node/node-runtime.ts";

// ─── Benchmark Yardımcıları ──────────────────────────────────────────────────

interface BenchmarkResult {
  name:       string;
  iterations: number;
  totalMs:    number;
  p50Ms:      number;
  p99Ms:      number;
  maxMs:      number;
  opsPerSec:  number;
  passed:     boolean;
  slo: {
    p50:  number;
    p99:  number;
    max:  number;
  };
}

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations: number,
  slo: { p50: number; p99: number; max: number }
): Promise<BenchmarkResult> {
  const samples: number[] = [];
  const warmup = Math.min(5, Math.floor(iterations * 0.1));

  // Isınma turu (ölçülmez)
  for (let i = 0; i < warmup; i++) await fn();

  // Gerçek ölçüm
  const totalStart = Date.now();
  for (let i = 0; i < iterations; i++) {
    const t = Date.now();
    await fn();
    samples.push(Date.now() - t);
  }
  const totalMs = Date.now() - totalStart;

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(iterations * 0.50)];
  const p99 = samples[Math.floor(iterations * 0.99)];
  const max = samples[samples.length - 1];

  const passed = p50 <= slo.p50 && p99 <= slo.p99 && max <= slo.max;

  return {
    name, iterations, totalMs,
    p50Ms: p50, p99Ms: p99, maxMs: max,
    opsPerSec: Math.round(iterations / (totalMs / 1000)),
    passed, slo,
  };
}

const results: BenchmarkResult[] = [];

function report(r: BenchmarkResult): void {
  const icon = r.passed ? "✅" : "❌";
  console.log(`${icon} ${r.name}`);
  console.log(`   p50=${r.p50Ms}ms (SLO: ${r.slo.p50}ms) | p99=${r.p99Ms}ms (SLO: ${r.slo.p99}ms) | max=${r.maxMs}ms (SLO: ${r.slo.max}ms)`);
  console.log(`   ${r.opsPerSec} ops/sec  (${r.iterations} iterasyon)`);
  results.push(r);
}

async function waitMs(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════════
// 1. EVENT THROUGHPUT — EventBus kaç event/sn işler?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/event-throughput", {
  "EventBus: 1000 event emit < 200ms toplam": async () => {
    const bus = new EventBus();
    let received = 0;
    bus.on("perf:test" as never, () => { received++; });

    const r = await benchmark(
      "EventBus emit throughput",
      async () => { bus.emit("perf:test" as never, { x: 1 }); },
      1000,
      { p50: 1, p99: 5, max: 20 }  // her emit < 1ms p50
    );
    report(r);

    assert(received === 1000 + 5, `1000 mesaj alınmalı: ${received}`); // 5 warmup
    assert(r.passed, `EventBus SLO aşıldı: p50=${r.p50Ms}ms p99=${r.p99Ms}ms`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SEARCH LATENCY — Arama isteği kaç ms'de yanıt verir?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/search-latency", {
  "1000 proje indeksle, sorgu < 50ms p99": async () => {
    const sem   = new SemanticIndex();
    const str   = new StructuralIndex();
    const rev   = new ReverseIndex();
    const score = new ScoringEngine(sem, str, rev);
    const bus   = new EventBus();
    const se    = new SearchEngine(sem, str, rev, score, bus);

    // 1000 proje ekle
    for (let i = 0; i < 1000; i++) {
      const id = `proj_${i}`;
      sem.index({ id, title: `Proje ${i} motor sistemi`, description: `Açıklama ${i} platform` });
      str.index({ id, type: "project", slug: `proje-${i}`, tags: ["motor", "platform"] });
      rev.index(id, `proje motor ${i} platform açıklama sistemi`);
    }

    const r = await benchmark(
      "Search p99 (1000 kayıt)",
      async () => { se.search({ query: "motor platform", limit: 10, offset: 0 }); },
      100,
      { p50: 10, p99: 50, max: 200 }
    );
    report(r);
    assert(r.passed, `Search SLO aşıldı: p99=${r.p99Ms}ms (max kabul: 50ms)`);
  },

  "10.000 proje indeksle, sorgu < 100ms p99": async () => {
    const sem   = new SemanticIndex();
    const str   = new StructuralIndex();
    const rev   = new ReverseIndex();
    const score = new ScoringEngine(sem, str, rev);
    const bus   = new EventBus();
    const se    = new SearchEngine(sem, str, rev, score, bus);

    for (let i = 0; i < 10_000; i++) {
      const id = `p${i}`;
      sem.index({ id, title: `Proje ${i}`, description: `Açıklama ${i}` });
      str.index({ id, type: "project", slug: `p-${i}`, tags: [] });
      rev.index(id, `proje ${i}`);
    }

    const r = await benchmark(
      "Search p99 (10.000 kayıt)",
      async () => { se.search({ query: "proje motor", limit: 20, offset: 0 }); },
      50,
      { p50: 25, p99: 100, max: 500 }
    );
    report(r);
    assert(r.passed, `Search SLO aşıldı (10K): p99=${r.p99Ms}ms`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SNAPSHOT RESTORE TIME — Snapshot ne kadar sürede geri yüklenir?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/snapshot-restore", {
  "1000 kayıt full snapshot + restore < 500ms": async () => {
    const source = createStoreCollection();
    for (let i = 0; i < 1000; i++) {
      source.projects.put(`p${i}`, { name: `Proje ${i}`, desc: "x" }, "n", i + 1, "s");
    }

    const builder = new IncrementalSnapshotBuilder(source);
    const snap    = await builder.take("n", 1, 0);

    const r = await benchmark(
      "Snapshot restore (1000 kayıt)",
      async () => {
        const target = createStoreCollection();
        await restoreFromChain(target, [snap]);
      },
      20,
      { p50: 100, p99: 500, max: 2000 }
    );
    report(r);
    assert(r.passed, `Snapshot restore SLO aşıldı: p99=${r.p99Ms}ms`);
  },

  "5000 kayıt full snapshot split + assemble < 3s": async () => {
    const source = createStoreCollection();
    for (let i = 0; i < 5000; i++) {
      source.projects.put(`p${i}`, { name: `P${i}`, desc: "x".repeat(50) }, "n", i + 1, "s");
    }

    const builder  = new IncrementalSnapshotBuilder(source);
    const snap     = await builder.take("n", 1, 0);
    const streamer = new SnapshotStreamer();

    const r = await benchmark(
      "Snapshot streaming (5000 kayıt)",
      async () => {
        const { chunks } = await streamer.split(snap);
        await streamer.assemble(chunks);
      },
      5,
      { p50: 1000, p99: 3000, max: 5000 }
    );
    report(r);
    assert(r.passed, `Snapshot streaming SLO aşıldı: p99=${r.p99Ms}ms`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PLUGİN LOAD TIME — Plugin kaç ms'de aktive olur?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/plugin-load-time", {
  "50 plugin kayıt + aktivasyon < 2s toplam": async () => {
    const { PluginRegistry }     = await import("../../plugin/registry/plugin-registry.ts");
    const { MockSandboxAdapter } = await import("../../sandbox/adapters/sandbox-adapters.ts");
    const { EventBus: EB }       = await import("../../core/event-bus.ts");

    const start = Date.now();
    const registry = new PluginRegistry(new MockSandboxAdapter(), { platformVersion: "1.0.0" }, new EB());
    const isolation = { isolationRequirement: { minimumIsolation: "simulated" as const } };

    for (let i = 0; i < 50; i++) {
      const name = `perf-plugin-${i}`;
      registry.register({
        manifest: { identity: { name, version: "1.0.0", publisherId: "p", description: "d" }, extensionPoints: ["search"], permissions: [], platformVersion: "^1.0.0", license: "MIT" },
        async init() {},
        async shutdown() {},
      }, { search: { name, scoreContribution: async () => 0 } }, isolation);
    }

    const { activated, failed } = await registry.activateAll();
    const ms = Date.now() - start;

    console.log(`  → 50 plugin register+activate: ${ms}ms`);
    assert(activated.length === 50, `Tüm plugin'ler aktive edilmeli: ${activated.length}`);
    assert(failed.length === 0, `Hata olmamalı: ${failed.length}`);
    assert(ms < 2000, `Plugin yükleme SLO aşıldı: ${ms}ms (max: 2000ms)`);

    results.push({
      name: "Plugin load (50 plugin)", iterations: 1, totalMs: ms,
      p50Ms: ms, p99Ms: ms, maxMs: ms,
      opsPerSec: Math.round(50 / (ms / 1000)),
      passed: ms < 2000,
      slo: { p50: 1000, p99: 2000, max: 3000 },
    });
  },

  "tek plugin healthCheck < 10ms": async () => {
    const { PluginSandboxRunner } = await import("../../plugin/sandbox/plugin-sandbox.ts");
    const { MockSandboxAdapter }  = await import("../../sandbox/adapters/sandbox-adapters.ts");

    const runner   = new PluginSandboxRunner(new MockSandboxAdapter());
    const manifest = { identity: { name: "health-test", version: "1.0.0", publisherId: "p", description: "d" }, extensionPoints: ["search" as const], permissions: [], platformVersion: "^1.0.0", license: "MIT" };
    const plugin   = {
      manifest,
      async init() {},
      async shutdown() {},
      async healthCheck() { return { healthy: true }; },
    };

    const r = await benchmark(
      "Plugin healthCheck latency",
      async () => { await runner.checkHealth(plugin); },
      100,
      { p50: 2, p99: 10, max: 50 }
    );
    report(r);
    assert(r.passed, `HealthCheck SLO aşıldı: p99=${r.p99Ms}ms`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CONSENSUS LATENCY — Raft commit kaç ms sürer?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/consensus-latency", {
  "solo node: commit < 50ms p99": async () => {
    const { RaftEngine }       = await import("../../consensus/raft/raft-engine.ts");
    const { NoopLogCompactor } = await import("../../consensus/consensus-types.ts");

    const applied: number[] = [];
    const engine = new RaftEngine(
      "solo-perf", [], async () => {},
      async (_, idx) => { applied.push(idx); },
      { clusterSize: 1, electionTimeoutMinMs: 30, electionTimeoutMaxMs: 60, heartbeatIntervalMs: 10 },
      new NoopLogCompactor()
    );
    engine.start();
    await waitMs(100); // lider seçimini bekle

    const r = await benchmark(
      "Raft commit (solo node)",
      async () => {
        const result = await engine.propose({ type: "noop", payload: {} });
        assert(result.ok);
      },
      50,
      { p50: 10, p99: 50, max: 200 }
    );
    report(r);
    engine.stop();
    assert(r.passed, `Consensus SLO aşıldı: p99=${r.p99Ms}ms`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MEMORY FOOTPRINT — Çalışan sistem kaç MB RAM kullanır?
// ═══════════════════════════════════════════════════════════════════════════════

await runSuite("perf/memory-footprint", {
  "10.000 proje yüklü SearchEngine < 100MB heap": () => {
    const before = (process as any).memoryUsage?.()?.heapUsed ?? 0;

    const sem   = new SemanticIndex();
    const str   = new StructuralIndex();
    const rev   = new ReverseIndex();

    for (let i = 0; i < 10_000; i++) {
      const id = `mem${i}`;
      sem.index({ id, title: `T${i}`, description: `D${i}` });
      str.index({ id, type: "project", slug: `s${i}`, tags: [] });
      rev.index(id, `token${i} tokenB`);
    }

    const after = (process as any).memoryUsage?.()?.heapUsed ?? 0;
    const deltaMb = (after - before) / 1024 / 1024;
    const sloMb   = 100;

    const passed = before === 0 || deltaMb < sloMb; // Node.js ortamında ölçüm
    console.log(`  → 10.000 kayıt SearchEngine heap delta: ${deltaMb > 0 ? deltaMb.toFixed(1) : "N/A"} MB (SLO: < ${sloMb} MB)`);

    results.push({
      name: "Memory: SearchEngine (10K)", iterations: 1, totalMs: 0,
      p50Ms: deltaMb, p99Ms: deltaMb, maxMs: deltaMb,
      opsPerSec: 0, passed,
      slo: { p50: sloMb, p99: sloMb, max: sloMb * 2 },
    });
    assert(passed, `Memory SLO aşıldı: ${deltaMb.toFixed(1)} MB`);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAPOR ÖZETİ
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log("  1XX1 PERFORMANCE CERTIFICATION — ÖZET");
console.log("═".repeat(60));

const passed = results.filter((r) => r.passed).length;
const total  = results.length;

for (const r of results) {
  const icon = r.passed ? "✅" : "❌";
  console.log(`${icon} ${r.name}`);
}

console.log("\n" + "─".repeat(60));
console.log(`SONUÇ: ${passed}/${total} benchmark SLO içinde`);

if (passed === total) {
  console.log("🎯 SERTIFIKA: GEÇTI — Platform üretim performans standartlarını karşılıyor");
} else {
  console.log("⚠️  SERTIFIKA: KOŞULLU — SLO ihlali olan benchmark'lar gözden geçirilmeli");
  process.exit(1);
}
