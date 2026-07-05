/**
 * 1XX1 Aşama 18 Testleri — Snapshot + Log Compaction
 *
 * Gruplar:
 *   log-compactor        — shouldTrigger, truncate, retainTail güvenliği
 *   raft-compaction       — RaftEngine.compact() entegrasyonu, commit sonrası index bütünlüğü
 *   incremental-snapshot  — full vs incremental, delta hesaplama, otomatik full tetikleme
 *   snapshot-streamer     — split/assemble, bozuk chunk tespiti, eksik chunk
 *   fast-join             — sponsor/client akışı, protokol uyumsuzluğu reddi
 *   determinism            — aynı zincir → aynı restore sonucu
 *   performans             — büyük log compaction, çok parçalı snapshot streaming
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import {
  IncrementalLogCompactor,
} from "../compaction/log-compactor.ts";
import {
  IncrementalSnapshotBuilder, restoreFromChain,
} from "../compaction/incremental-snapshot.ts";
import {
  SnapshotStreamer, SNAPSHOT_CHUNK_SIZE,
} from "../compaction/snapshot-streamer.ts";
import {
  FastJoinSponsor, FastJoinClient,
} from "../join/fast-join.ts";
import { RaftEngine } from "../raft/raft-engine.ts";
import { NoopLogCompactor } from "../consensus-types.ts";
import {
  createStoreCollection, EventLog,
} from "../../distributed/sync/sync-engine.ts";
import type { ConsensusCommand, LogIndex, RaftRPC, RaftLogEntry } from "../consensus-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeLogEntry(index: number, term = 1): RaftLogEntry {
  return {
    term, index, command: { type: "noop", payload: {} },
    timestamp: Date.now(), nodeId: "n1", checksum: `cs${index}`,
  };
}

/** Tek node Raft engine — deterministik test için (lider, eşsiz çoğunluk) */
function makeSoloRaft(
  applyCmd: (cmd: ConsensusCommand, idx: LogIndex) => Promise<void> = async () => {},
  compactor = new NoopLogCompactor()
) {
  return new RaftEngine(
    "solo", [], async () => {}, applyCmd,
    { clusterSize: 1, electionTimeoutMinMs: 30, electionTimeoutMaxMs: 60, heartbeatIntervalMs: 10 },
    compactor
  );
}

// ─── IncrementalLogCompactor ───────────────────────────────────────────────────

await runSuite("log-compactor", {
  "shouldTrigger: küçük log → false": () => {
    const c = new IncrementalLogCompactor({ triggerSize: 1000 });
    assert(!c.shouldTrigger(100, 50));
  },

  "shouldTrigger: büyük log + commit var → true": () => {
    const c = new IncrementalLogCompactor({ triggerSize: 100, minIntervalMs: 0 });
    assert(c.shouldTrigger(200, 150));
  },

  "shouldTrigger: commit yoksa → false": () => {
    const c = new IncrementalLogCompactor({ triggerSize: 100 });
    assert(!c.shouldTrigger(200, -1));
  },

  "shouldTrigger: minInterval dolmadıysa → false": async () => {
    const c = new IncrementalLogCompactor({ triggerSize: 10, minIntervalMs: 10_000 });
    await c.compact(5); // _lastCompactionAt güncellenir
    assert(!c.shouldTrigger(200, 100), "Min interval dolmadan tekrar tetiklenmemeli");
  },

  "truncate: commitIndex'e kadar (retainTail hariç) keser": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 5 });
    const log = Array.from({ length: 100 }, (_, i) => makeLogEntry(i));
    const { newLog, result } = await c.truncate(log, 90); // commit=90, retainTail=5 → upTo=85

    assertEqual(result.beforeLength, 100);
    assert(result.truncated > 0, "Bir şey silinmeli");
    assert(newLog.every((e) => e.index > result.upToIndex), "Kalan girdiler upToIndex'ten büyük olmalı");
    assertEqual(result.upToIndex, 85);
  },

  "truncate: retainTail asla commit edilmemişi silmez": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 10 });
    const log = Array.from({ length: 50 }, (_, i) => makeLogEntry(i));
    // commitIndex çok düşük → kesme güvenli olmayabilir
    const { result } = await c.truncate(log, 5);
    assert(result.upToIndex <= 5, "commitIndex'i aşan kesme yapılmamalı");
  },

  "truncate: ikinci kez aynı index → no-op": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 5 });
    const log = Array.from({ length: 100 }, (_, i) => makeLogEntry(i));
    const r1 = await c.truncate(log, 90);
    const r2 = await c.truncate(r1.newLog, 90); // aynı commit, zaten compact edilmiş
    assertEqual(r2.result.truncated, 0, "Tekrar tetiklenmemeli");
  },

  "lastCompacted ve history takibi": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 0 });
    const log = Array.from({ length: 20 }, (_, i) => makeLogEntry(i));
    await c.truncate(log, 15);
    assertEqual(c.lastCompacted(), 15);
    const hist = c.getHistory();
    assertEqual(hist.length, 1);
    assert(c.totalTruncated() > 0);
  },

  "checksum digest üretimi (denetim)": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 0 });
    const log = Array.from({ length: 10 }, (_, i) => makeLogEntry(i));
    const { result } = await c.truncate(log, 8);
    assert(result.truncatedDigest.length > 0);
    assert(result.truncatedDigest !== "0".repeat(64), "Gerçek digest üretilmeli");
  },
});

// ─── RaftEngine Compaction Entegrasyonu ───────────────────────────────────────

await runSuite("raft-compaction", {
  "compact() sonrası getLog() kısalmış log döner": async () => {
    const compactor = new IncrementalLogCompactor({ retainTail: 2, minIntervalMs: 0 });
    const engine = makeSoloRaft(async () => {}, compactor);
    engine.start();
    await waitMs(100);

    // 20 komut commit et
    for (let i = 0; i < 20; i++) await engine.propose({ type: "noop", payload: {} });
    await waitMs(150);

    const beforeLen = engine.getLog().length;
    assert(beforeLen >= 20, `En az 20 girdi olmalı: ${beforeLen}`);

    await engine.compact(engine.state().commitIndex);
    const afterLen = engine.getLog().length;

    assert(afterLen <= beforeLen, "Compaction sonrası log küçülmeli veya eşit kalmalı");
    engine.stop();
  },

  "compaction sonrası yeni komutlar doğru işlenir (index bütünlüğü)": async () => {
    const applied: number[] = [];
    const compactor = new IncrementalLogCompactor({ retainTail: 1, minIntervalMs: 0 });
    const engine = makeSoloRaft(
      async (_cmd, idx) => { applied.push(idx); },
      compactor
    );
    engine.start();
    await waitMs(100);

    for (let i = 0; i < 10; i++) await engine.propose({ type: "noop", payload: {} });
    await waitMs(150);

    await engine.compact(engine.state().commitIndex);

    // Compaction sonrası yeni komutlar
    for (let i = 0; i < 5; i++) await engine.propose({ type: "noop", payload: {} });
    await waitMs(150);

    // applied dizisi sürekli artan index'ler içermeli (boşluk/tekrar olmamalı)
    for (let i = 1; i < applied.length; i++) {
      assert(applied[i] > applied[i - 1], `Index sırası bozulmamalı: ${applied[i-1]} → ${applied[i]}`);
    }
    engine.stop();
  },

  "NoopLogCompactor ile eski davranış korunur (geriye uyumluluk)": async () => {
    const engine = makeSoloRaft(async () => {}, new NoopLogCompactor());
    engine.start();
    await waitMs(80);
    for (let i = 0; i < 5; i++) await engine.propose({ type: "noop", payload: {} });
    await waitMs(100);

    const before = engine.getLog().length;
    await engine.compact(2); // basit slice davranışı
    const after = engine.getLog().length;
    assert(after <= before, "Noop compactor da log'u kısaltabilmeli (basit slice)");
    engine.stop();
  },

  "commit + apply compaction sonrası da çalışmaya devam eder": async () => {
    let commitCount = 0;
    const compactor = new IncrementalLogCompactor({ retainTail: 0, triggerSize: 5, minIntervalMs: 0 });
    const engine = makeSoloRaft(async () => { commitCount++; }, compactor);
    engine.start();
    await waitMs(80);

    // Otomatik compaction tetiklenecek kadar komut gönder
    for (let i = 0; i < 30; i++) await engine.propose({ type: "noop", payload: {} });
    await waitMs(300);

    assert(commitCount >= 30, `Tüm komutlar commit edilmeli: ${commitCount}`);
    engine.stop();
  },
});

// ─── IncrementalSnapshotBuilder ───────────────────────────────────────────────

await runSuite("incremental-snapshot", {
  "ilk snapshot her zaman full": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    const builder = new IncrementalSnapshotBuilder(stores);
    const snap = await builder.take("n1", 1, 0);
    assertEqual(snap.kind, "full");
    assert(snap.storeDeltas.projects.length >= 1);
  },

  "ikinci snapshot incremental olur": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 100 });
    await builder.take("n1", 1, 0);

    stores.projects.put("p2", { name: "Y" }, "n1", 2, "sig");
    const snap2 = await builder.take("n1", 2, 1);
    assertEqual(snap2.kind, "incremental");
  },

  "incremental yalnızca değişen kayıtları içerir": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "A" }, "n1", 1, "sig");
    stores.projects.put("p2", { name: "B" }, "n1", 2, "sig");
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 100 });
    await builder.take("n1", 1, 0); // full: p1, p2

    stores.projects.put("p3", { name: "C" }, "n1", 3, "sig"); // yalnızca p3 yeni
    const snap2 = await builder.take("n1", 2, 1);

    assertEqual(snap2.storeDeltas.projects.length, 1, "Yalnızca p3 delta'da olmalı");
    assertEqual(snap2.storeDeltas.projects[0].key, "p3");
  },

  "fullSnapshotInterval aşılınca otomatik full tetiklenir": async () => {
    const stores  = createStoreCollection();
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 3 });

    const kinds: string[] = [];
    for (let i = 0; i < 7; i++) {
      stores.projects.put(`p${i}`, { v: i }, "n1", i + 1, "sig");
      const snap = await builder.take("n1", i, i);
      kinds.push(snap.kind);
    }

    // İlk her zaman full; sonra her 3 incremental'dan sonra tekrar full
    assertEqual(kinds[0], "full");
    assert(kinds.includes("incremental"), "Aradakiler incremental olmalı");
    // İkinci full en geç 4. snapshot'ta gelmeli (0:full,1,2,3:full,...)
    assertEqual(kinds[4], "full");
  },

  "chainSince: son full'dan itibaren zinciri döndürür": async () => {
    const stores  = createStoreCollection();
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 2 });
    for (let i = 0; i < 5; i++) {
      stores.projects.put(`p${i}`, { v: i }, "n1", i + 1, "sig");
      await builder.take("n1", i, i);
    }
    const chain = builder.chainSince();
    assertEqual(chain[0].kind, "full", "Zincir full ile başlamalı");
  },

  "stats: full/incremental sayımı": async () => {
    const stores  = createStoreCollection();
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 2 });
    for (let i = 0; i < 6; i++) {
      stores.projects.put(`p${i}`, { v: i }, "n1", i + 1, "sig");
      await builder.take("n1", i, i);
    }
    const stats = builder.stats();
    assert(stats.fullCount >= 1);
    assert(stats.incrementalCount >= 1);
  },

  "restoreFromChain: zincir uygulanınca tüm kayıtlar mevcut olur": async () => {
    const stores  = createStoreCollection();
    const builder = new IncrementalSnapshotBuilder(stores, { fullSnapshotInterval: 100 });

    stores.projects.put("p1", { name: "A" }, "n1", 1, "sig");
    await builder.take("n1", 1, 0);
    stores.projects.put("p2", { name: "B" }, "n1", 2, "sig");
    await builder.take("n1", 2, 1);

    const chain = builder.chainSince();
    const target = createStoreCollection();
    const { restoredEntries } = await restoreFromChain(target, chain);

    assert(restoredEntries >= 2);
    assert(target.projects.get("p1") !== undefined);
    assert(target.projects.get("p2") !== undefined);
  },
});

// ─── SnapshotStreamer ─────────────────────────────────────────────────────────

await runSuite("snapshot-streamer", {
  "split + assemble: küçük snapshot tek chunk": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    const builder = new IncrementalSnapshotBuilder(stores);
    const snap    = await builder.take("n1", 1, 0);

    const streamer = new SnapshotStreamer();
    const { chunks } = await streamer.split(snap);
    assert(chunks.length >= 1);

    const result = await streamer.assemble(chunks);
    assert(result.ok, `Assemble başarısız: ${result.error}`);
    assertEqual(result.snapshot!.hash, snap.hash);
  },

  "split: büyük snapshot çok chunk üretir": async () => {
    const stores  = createStoreCollection();
    // Büyük veri üret (chunk boyutunu aşacak kadar)
    for (let i = 0; i < 2000; i++) {
      stores.projects.put(`p${i}`, { name: `Project ${i}`, desc: "x".repeat(100) }, "n1", i + 1, "sig");
    }
    const builder = new IncrementalSnapshotBuilder(stores);
    const snap    = await builder.take("n1", 1, 0);

    const streamer = new SnapshotStreamer();
    const { chunks } = await streamer.split(snap);
    assert(chunks.length > 1, `Büyük snapshot tek chunk'a sığmamalı: ${chunks.length}`);

    const result = await streamer.assemble(chunks);
    assert(result.ok, `Assemble başarısız: ${result.error}`);
    assertEqual(result.snapshot!.storeDeltas.projects.length, 2000);
  },

  "bozuk chunk tespiti": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    const builder = new IncrementalSnapshotBuilder(stores);
    const snap    = await builder.take("n1", 1, 0);

    const streamer = new SnapshotStreamer();
    const { chunks } = await streamer.split(snap);

    const corrupted = [...chunks];
    corrupted[0] = { ...corrupted[0], data: corrupted[0].data + "BOZUK" };

    const result = await streamer.assemble(corrupted);
    assert(!result.ok, "Bozuk chunk reddedilmeli");
    assert(result.error?.includes("bozuk"));
  },

  "eksik chunk tespiti": async () => {
    const stores  = createStoreCollection();
    for (let i = 0; i < 2000; i++) {
      stores.projects.put(`p${i}`, { v: "x".repeat(100) }, "n1", i + 1, "sig");
    }
    const builder = new IncrementalSnapshotBuilder(stores);
    const snap    = await builder.take("n1", 1, 0);

    const streamer = new SnapshotStreamer();
    const { chunks } = await streamer.split(snap);
    if (chunks.length < 2) return; // garanti çoklu chunk değilse atla

    const incomplete = chunks.slice(0, -1); // son chunk eksik
    const result = await streamer.assemble(incomplete);
    assert(!result.ok, "Eksik chunk listesi reddedilmeli");
    assert(result.error?.includes("Eksik"));
  },

  "progress hesaplama": async () => {
    const stores  = createStoreCollection();
    for (let i = 0; i < 2000; i++) {
      stores.projects.put(`p${i}`, { v: "x".repeat(100) }, "n1", i + 1, "sig");
    }
    const builder  = new IncrementalSnapshotBuilder(stores);
    const snap     = await builder.take("n1", 1, 0);
    const streamer = new SnapshotStreamer();
    const { chunks } = await streamer.split(snap);

    if (chunks.length < 2) return;

    const partial = chunks.slice(0, 1);
    const prog = streamer.progress(partial, chunks.length);
    assertEqual(prog.status, "streaming");
    assertEqual(prog.receivedChunks, 1);
    assertEqual(prog.totalChunks, chunks.length);
  },
});

// ─── Fast Join ────────────────────────────────────────────────────────────────

await runSuite("fast-join", {
  "sponsor: protokol uyumsuzluğu → reject": () => {
    const stores  = createStoreCollection();
    const eventLog = new EventLog();
    const builder  = new IncrementalSnapshotBuilder(stores);
    const sponsor  = new FastJoinSponsor(builder, eventLog);

    const offer = sponsor.evaluateJoinRequest(
      { requestingNodeId: "new1", publicKey: "pk", protocolVersion: "0.9.0" },
      "1.0.0"
    );
    assertEqual(offer.decision, "reject");
    assert(offer.reason?.includes("Protokol"));
  },

  "sponsor: snapshot yoksa reject": () => {
    const stores  = createStoreCollection();
    const eventLog = new EventLog();
    const builder  = new IncrementalSnapshotBuilder(stores);
    const sponsor  = new FastJoinSponsor(builder, eventLog);

    const offer = sponsor.evaluateJoinRequest(
      { requestingNodeId: "new1", publicKey: "pk", protocolVersion: "1.0.0" },
      "1.0.0"
    );
    assertEqual(offer.decision, "reject");
    assert(offer.reason?.includes("snapshot"));
  },

  "sponsor: snapshot varsa accept": async () => {
    const stores  = createStoreCollection();
    stores.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    const eventLog = new EventLog();
    const builder  = new IncrementalSnapshotBuilder(stores);
    await builder.take("n1", 1, 0);
    const sponsor  = new FastJoinSponsor(builder, eventLog);

    const offer = sponsor.evaluateJoinRequest(
      { requestingNodeId: "new1", publicKey: "pk", protocolVersion: "1.0.0" },
      "1.0.0"
    );
    assertEqual(offer.decision, "accept");
    assert(offer.snapshotHash !== undefined);
  },

  "tam akış: sponsor hazırlar, client katılır": async () => {
    const sponsorStores = createStoreCollection();
    sponsorStores.projects.put("p1", { name: "A" }, "n1", 1, "sig");
    sponsorStores.projects.put("p2", { name: "B" }, "n1", 2, "sig");
    sponsorStores.channels.put("c1", { title: "Kanal" }, "n1", 1, "sig");

    const eventLog = new EventLog();
    eventLog.append({ timestamp: Date.now(), clockValue: 1, nodeId: "n1", storeName: "projects", eventType: "put", key: "p1", data: {} });

    const builder = new IncrementalSnapshotBuilder(sponsorStores);
    await builder.take("n1", 1, 0); // snapshot alındıktan SONRA event eklenmiş gibi davranır

    const sponsor = new FastJoinSponsor(builder, eventLog);
    const { chunksPerSnapshot } = await sponsor.prepareSnapshotChunks();
    const pendingEvents = sponsor.pendingEvents(0);

    const clientStores = createStoreCollection();
    const client = new FastJoinClient(clientStores);

    let replayedKeys: string[] = [];
    const result = await client.join(chunksPerSnapshot, pendingEvents, async (entry) => {
      replayedKeys.push(entry.key);
    });

    assert(result.ok, `Join başarısız: ${result.error}`);
    assert(result.syncedEntries >= 3, `En az 3 kayıt senkronize olmalı: ${result.syncedEntries}`);
    assert(clientStores.projects.get("p1") !== undefined);
    assert(clientStores.projects.get("p2") !== undefined);
    assert(clientStores.channels.get("c1") !== undefined);
  },

  "client: bozuk chunk'larla join başarısız olur": async () => {
    const sponsorStores = createStoreCollection();
    sponsorStores.projects.put("p1", { name: "A" }, "n1", 1, "sig");
    const builder = new IncrementalSnapshotBuilder(sponsorStores);
    await builder.take("n1", 1, 0);

    const eventLog = new EventLog();
    const sponsor  = new FastJoinSponsor(builder, eventLog);
    const { chunksPerSnapshot } = await sponsor.prepareSnapshotChunks();

    // İlk snapshot'ın ilk chunk'ını boz
    const corrupted = chunksPerSnapshot.map((chunks) => [...chunks]);
    corrupted[0][0] = { ...corrupted[0][0], data: corrupted[0][0].data + "X" };

    const clientStores = createStoreCollection();
    const client = new FastJoinClient(clientStores);
    const result = await client.join(corrupted, [], async () => {});

    assert(!result.ok, "Bozuk chunk ile join başarısız olmalı");
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı zincir → aynı restore sonucu (2 bağımsız hedef)": async () => {
    const sourceStores = createStoreCollection();
    sourceStores.projects.put("p1", { name: "A" }, "n1", 1, "sig");
    sourceStores.projects.put("p2", { name: "B" }, "n1", 2, "sig");
    const builder = new IncrementalSnapshotBuilder(sourceStores);
    await builder.take("n1", 1, 0);
    const chain = builder.chainSince();

    const target1 = createStoreCollection();
    const target2 = createStoreCollection();
    const r1 = await restoreFromChain(target1, chain);
    const r2 = await restoreFromChain(target2, chain);

    assertEqual(r1.restoredEntries, r2.restoredEntries);
    const cs1 = await target1.projects.checksum();
    const cs2 = await target2.projects.checksum();
    assertEqual(cs1, cs2, "İki bağımsız restore aynı checksum vermeli");
  },

  "snapshot hash deterministik (aynı içerik, 2 builder)": async () => {
    const stores1 = createStoreCollection();
    const stores2 = createStoreCollection();
    stores1.projects.put("p1", { name: "X" }, "n1", 1, "sig");
    stores2.projects.put("p1", { name: "X" }, "n1", 1, "sig");

    const b1 = new IncrementalSnapshotBuilder(stores1);
    const b2 = new IncrementalSnapshotBuilder(stores2);
    const s1 = await b1.take("n1", 5, 0);
    const s2 = await b2.take("n1", 5, 0);

    assertEqual(s1.hash, s2.hash, "Aynı içerik aynı clockValue → aynı hash");
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "10.000 girdili log compaction < 1s": async () => {
    const c = new IncrementalLogCompactor({ retainTail: 100 });
    const log = Array.from({ length: 10_000 }, (_, i) => makeLogEntry(i));

    const start = Date.now();
    const { result } = await c.truncate(log, 9_500);
    const ms = Date.now() - start;

    assert(ms < 1000, `10K log compaction ${ms}ms (beklenen < 1s)`);
    assert(result.truncated > 9000);
    console.log(`  → 10.000 girdi compaction: ${ms}ms`);
  },

  "5000 kayıtlı snapshot streaming < 3s": async () => {
    const stores = createStoreCollection();
    for (let i = 0; i < 5000; i++) {
      stores.projects.put(`p${i}`, { name: `P${i}`, desc: "x".repeat(50) }, "n1", i + 1, "sig");
    }
    const builder  = new IncrementalSnapshotBuilder(stores);
    const snap     = await builder.take("n1", 1, 0);
    const streamer = new SnapshotStreamer();

    const start = Date.now();
    const { chunks } = await streamer.split(snap);
    const result = await streamer.assemble(chunks);
    const ms = Date.now() - start;

    assert(result.ok);
    assert(ms < 3000, `5000 kayıt streaming ${ms}ms (beklenen < 3s)`);
    console.log(`  → 5000 kayıt split+assemble (${chunks.length} chunk): ${ms}ms`);
  },

  "fast join 1000 kayıt < 2s": async () => {
    const sponsorStores = createStoreCollection();
    for (let i = 0; i < 1000; i++) {
      sponsorStores.projects.put(`p${i}`, { name: `P${i}` }, "n1", i + 1, "sig");
    }
    const eventLog = new EventLog();
    const builder  = new IncrementalSnapshotBuilder(sponsorStores);
    await builder.take("n1", 1, 0);
    const sponsor  = new FastJoinSponsor(builder, eventLog);

    const start = Date.now();
    const { chunksPerSnapshot } = await sponsor.prepareSnapshotChunks();
    const clientStores = createStoreCollection();
    const client = new FastJoinClient(clientStores);
    const result = await client.join(chunksPerSnapshot, [], async () => {});
    const ms = Date.now() - start;

    assert(result.ok);
    assertEqual(result.syncedEntries, 1000);
    assert(ms < 2000, `1000 kayıt fast join ${ms}ms (beklenen < 2s)`);
    console.log(`  → 1000 kayıt fast join: ${ms}ms`);
  },
});
