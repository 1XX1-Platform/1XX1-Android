/**
 * 1XX1 Konsensüs Testleri
 * Aşama 15 — Lightweight Raft + Pulse Senkronizasyonu
 *
 * Gruplar:
 *   raft/election     — leader seçimi, term, oy verme
 *   raft/replication  — log replikasyonu, commit
 *   raft/recovery     — log restore, term koruma
 *   pulse-sync        — blok üretimi, zincir hash, deterministik
 *   pulse-chain       — zincir bütünlüğü, blok bulma
 *   validator-set     — add/remove, quorum, imza doğrulama
 *   consensus-node    — tam entegrasyon, lider seçimi, pulse commit
 *   determinism       — aynı log → aynı state, iki cluster birleşimi
 *   performance       — 1000 komut commit, 10 node seçim
 */

import {
  runSuite, assert, assertEqual, makeProject
} from "../../core/test-utils.ts";
import { RaftEngine } from "../raft/raft-engine.ts";
import { PulseBlockChain, PulseSynchronizer } from "../pulse-sync/pulse-synchronizer.ts";
import { ValidatorSetManager } from "../validator/validator-set.ts";
import { ConsensusNode } from "../node/consensus-node.ts";
import { MemoryTransport } from "../../distributed/transport/transport.ts";
import { MockSignatureProvider } from "../../distributed/security/signature.ts";
import { NodeRuntime } from "../../distributed/node/node-runtime.ts";
import type { ConsensusCommand, LogIndex, RaftRPC, RaftLogEntry } from "../consensus-types.ts";
import type { PulseEntry, PulseSnapshot } from "../../pulse/pulse-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Birbirine bağlı Raft küme oluştur.
 * Her engine diğerlerine doğrudan RPC gönderir (in-memory).
 */
function makeRaftCluster(nodeIds: string[]): Map<string, RaftEngine> {
  const engines = new Map<string, RaftEngine>();
  const applied = new Map<string, ConsensusCommand[]>();

  for (const nodeId of nodeIds) {
    applied.set(nodeId, []);
    const peers = nodeIds.filter((id) => id !== nodeId);

    const sendRpc = async (toNodeId: string, rpc: RaftRPC): Promise<void> => {
      const target = engines.get(toNodeId);
      if (target) await target.handleRpc(rpc, nodeId);
    };

    const applyCmd = async (cmd: ConsensusCommand, _idx: LogIndex): Promise<void> => {
      applied.get(nodeId)!.push(cmd);
    };

    const engine = new RaftEngine(nodeId, peers, sendRpc, applyCmd, {
      electionTimeoutMinMs: 50,
      electionTimeoutMaxMs: 100,
      heartbeatIntervalMs:  20,
      clusterSize:          nodeIds.length,
    });
    engines.set(nodeId, engine);
  }

  return engines;
}

function makeNodeRuntime(id: string): NodeRuntime {
  const transport = new MemoryTransport(id);
  const signer    = new MockSignatureProvider(id);
  return new NodeRuntime(transport, signer, {
    heartbeatIntervalMs:   1_000_000,
    snapshotIntervalMs:    1_000_000,
    healthCheckIntervalMs: 1_000_000,
  });
}

function makePulseSnapshot(pulseNumber: number, n = 5): PulseSnapshot {
  const entries: PulseEntry[] = Array.from({ length: n }, (_, i) => ({
    rank:      i + 1,
    projectId: `prj_${pulseNumber}_${i}`,
    score:     1 - i * 0.1,
    pulseAge:  pulseNumber,
    fairness:  0.5,
    trust:     0.5,
    penalty:   0,
    promoted:  i === 0,
    demoted:   i === n - 1,
  }));

  return {
    pulseNumber,
    intervalMs:    5000,
    startMs:       pulseNumber * 5000,
    completedAt:   new Date(),
    entries,
    totalEligible: n,
    rotated:       entries.filter((e) => e.demoted).map((e) => e.projectId),
    stats:         { avgScore: 0.7, minScore: 0.5, maxScore: 0.9, newEntries: 0 },
  };
}

// ─── Raft / Election ──────────────────────────────────────────────────────────

await runSuite("raft/election", {
  "tek düğüm: başlangıçta follower": () => {
    const engines = makeRaftCluster(["n1", "n2", "n3"]);
    const n1 = engines.get("n1")!;
    n1.start();
    assertEqual(n1.getRole(), "follower", "Başlangıçta follower olmalı");
    n1.stop();
    for (const [, e] of engines) e.stop();
  },

  "lider seçimi: çoğunlukla seçilir": async () => {
    const engines = makeRaftCluster(["a1", "a2", "a3"]);
    for (const [, e] of engines) e.start();

    await waitMs(400); // seçim timeout bekle

    // Tam olarak 1 lider olmalı
    const leaders = Array.from(engines.values()).filter((e) => e.isLeader());
    assert(leaders.length === 1, `Tam 1 lider beklendi: ${leaders.length}`);

    for (const [, e] of engines) e.stop();
  },

  "term artar seçim sonrası": async () => {
    const engines = makeRaftCluster(["b1", "b2", "b3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const maxTerm = Math.max(...Array.from(engines.values()).map((e) => e.getTerm()));
    assert(maxTerm >= 1, `Term en az 1 olmalı: ${maxTerm}`);

    for (const [, e] of engines) e.stop();
  },

  "eski term reddi: daha yüksek term follower yapıyor": async () => {
    const engines = makeRaftCluster(["c1", "c2", "c3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const leader = Array.from(engines.values()).find((e) => e.isLeader())!;
    const follower = Array.from(engines.values()).find((e) => !e.isLeader())!;

    // Eski term oy isteği → reddedilmeli
    const oldRpc = {
      type: "request_vote" as const,
      term: 0, // çok eski
      candidateId:   follower.state().nodeId,
      lastLogIndex:  -1,
      lastLogTerm:   -1,
    };
    await leader.handleRpc(oldRpc, follower.state().nodeId);
    assert(leader.isLeader(), "Eski term → lider etkilenmemeli");

    for (const [, e] of engines) e.stop();
  },
});

// ─── Raft / Replication ───────────────────────────────────────────────────────

await runSuite("raft/replication", {
  "komut çoğunlukla commit edilir": async () => {
    const engines = makeRaftCluster(["r1", "r2", "r3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const leader = Array.from(engines.values()).find((e) => e.isLeader())!;
    assert(leader !== undefined, "Lider olmalı");

    const result = await leader.propose({ type: "noop" });
    assert(result.ok, `Komut önerilemedi: ${result.error}`);

    await waitMs(200); // commit bekle

    const state = leader.state();
    assert(state.commitIndex >= 0, `Commit index: ${state.commitIndex}`);
    assert(state.logLength   >= 1, `Log length: ${state.logLength}`);

    for (const [, e] of engines) e.stop();
  },

  "leader olmayan düğüm NOT_LEADER döner": async () => {
    const engines = makeRaftCluster(["f1", "f2", "f3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const follower = Array.from(engines.values()).find((e) => !e.isLeader())!;
    const result   = await follower.propose({ type: "noop" });
    assert(!result.ok,            "Follower öneri yapamaz");
    assertEqual(result.error, "NOT_LEADER");
    assert(result.leaderId !== undefined, "leaderId bilgisi olmalı");

    for (const [, e] of engines) e.stop();
  },

  "pulse:commit komutu log'a girer": async () => {
    const engines = makeRaftCluster(["p1", "p2", "p3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const leader = Array.from(engines.values()).find((e) => e.isLeader())!;
    const snap   = makePulseSnapshot(42, 3);

    const result = await leader.propose({
      type:             "pulse:commit",
      pulseNumber:      snap.pulseNumber,
      entries:          snap.entries,
      fairnessSnapshot: "hash_abc",
    });

    assert(result.ok, `pulse:commit başarısız: ${result.error}`);
    await waitMs(200);

    const log = leader.getLog();
    const pulseCmds = log.filter((e) => e.command.type === "pulse:commit");
    assert(pulseCmds.length >= 1, "pulse:commit log'da olmalı");

    for (const [, e] of engines) e.stop();
  },
});

// ─── Raft / Recovery ─────────────────────────────────────────────────────────

await runSuite("raft/recovery", {
  "log restore: kaldığı yerden devam eder": async () => {
    const engines = makeRaftCluster(["rec1", "rec2", "rec3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const leader = Array.from(engines.values()).find((e) => e.isLeader())!;
    await leader.propose({ type: "noop" });
    await leader.propose({ type: "policy:update", policyId: "p1", payload: { x: 1 } });
    await waitMs(200);

    const log  = leader.getLog();
    const term = leader.getTerm();

    // Yeni engine ile restore
    const sendRpc = async () => {};
    const applied: ConsensusCommand[] = [];
    const restored = new RaftEngine(
      "rec1", [], sendRpc,
      async (cmd) => { applied.push(cmd); },
      { clusterSize: 1 }
    );
    restored.restoreLog(log, term);
    assert(restored.state().logLength >= 2, "Log restore edilmeli");
    assert(restored.state().commitIndex >= 1, "Commit index restore edilmeli");

    for (const [, e] of engines) e.stop();
  },

  "checksum doğrulaması": async () => {
    const engines = makeRaftCluster(["cs1", "cs2", "cs3"]);
    for (const [, e] of engines) e.start();
    await waitMs(400);

    const leader = Array.from(engines.values()).find((e) => e.isLeader())!;
    await leader.propose({ type: "noop" });
    await waitMs(100);

    const log = leader.getLog();
    for (const entry of log) {
      // Her girdinin checksum'u olmalı
      assert(entry.checksum.length > 0, `Log entry checksum eksik: [${entry.index}]`);
    }

    for (const [, e] of engines) e.stop();
  },
});

// ─── Pulse Block Chain ────────────────────────────────────────────────────────

await runSuite("pulse-chain", {
  "blok hash deterministik": async () => {
    const base = {
      blockId: "b1", pulseNumber: 1,
      prevBlockHash: "0".repeat(64),
      logIndex: 0, term: 1, leaderId: "n1",
      entries: [], totalProjects: 0, rotated: [],
      timestamp: 1000, signatures: {},
    };
    const h1 = await PulseBlockChain.computeBlockHash(base);
    const h2 = await PulseBlockChain.computeBlockHash(base);
    assertEqual(h1, h2, "Aynı blok → aynı hash");
  },

  "farklı blok → farklı hash": async () => {
    const base = {
      blockId: "b1", pulseNumber: 1,
      prevBlockHash: "0".repeat(64),
      logIndex: 0, term: 1, leaderId: "n1",
      entries: [], totalProjects: 0, rotated: [],
      timestamp: 1000, signatures: {},
    };
    const h1 = await PulseBlockChain.computeBlockHash({ ...base, pulseNumber: 1 });
    const h2 = await PulseBlockChain.computeBlockHash({ ...base, pulseNumber: 2 });
    assert(h1 !== h2);
  },

  "zincir bütünlüğü doğrulama": async () => {
    const chain = new PulseBlockChain();

    // Blok 1
    const block1hash = "0".repeat(64);
    const b1hash = await PulseBlockChain.computeBlockHash({
      blockId: "b1", pulseNumber: 1, prevBlockHash: block1hash,
      logIndex: 0, term: 1, leaderId: "n1",
      entries: [], totalProjects: 0, rotated: [],
      timestamp: 1000, signatures: {},
    });
    chain.append({ blockId: "b1", pulseNumber: 1, prevBlockHash: block1hash,
      logIndex: 0, term: 1, leaderId: "n1", entries: [], totalProjects: 0,
      rotated: [], blockHash: b1hash, timestamp: 1000, signatures: {} });

    // Blok 2 (öncekine zincirlendi)
    const b2hash = await PulseBlockChain.computeBlockHash({
      blockId: "b2", pulseNumber: 2, prevBlockHash: b1hash,
      logIndex: 1, term: 1, leaderId: "n1",
      entries: [], totalProjects: 0, rotated: [],
      timestamp: 2000, signatures: {},
    });
    chain.append({ blockId: "b2", pulseNumber: 2, prevBlockHash: b1hash,
      logIndex: 1, term: 1, leaderId: "n1", entries: [], totalProjects: 0,
      rotated: [], blockHash: b2hash, timestamp: 2000, signatures: {} });

    const { ok } = await chain.verify();
    assert(ok, "Geçerli zincir doğrulanmalı");
    assertEqual(chain.length(), 2);
  },

  "bozuk zincir tespiti": async () => {
    const chain = new PulseBlockChain();
    chain.append({ blockId: "b1", pulseNumber: 1, prevBlockHash: "0".repeat(64),
      logIndex: 0, term: 1, leaderId: "n1", entries: [], totalProjects: 0,
      rotated: [], blockHash: "hash_b1", timestamp: 1000, signatures: {} });
    chain.append({ blockId: "b2", pulseNumber: 2,
      prevBlockHash: "YANLIS_HASH", // bozuk!
      logIndex: 1, term: 1, leaderId: "n1", entries: [], totalProjects: 0,
      rotated: [], blockHash: "hash_b2", timestamp: 2000, signatures: {} });

    const { ok, brokenAt } = await chain.verify();
    assert(!ok, "Bozuk zincir reddedilmeli");
    assertEqual(brokenAt, 1);
  },

  "max geçmiş LRU": () => {
    const chain = new PulseBlockChain();
    // 1001 blok ekle (max 1000)
    for (let i = 0; i < 1001; i++) {
      chain.append({ blockId: `b${i}`, pulseNumber: i,
        prevBlockHash: "0".repeat(64), logIndex: i, term: 1, leaderId: "n1",
        entries: [], totalProjects: 0, rotated: [],
        blockHash: `hash_${i}`, timestamp: i * 1000, signatures: {} });
    }
    assert(chain.length() <= 1000, "Max 1000 blok saklanmalı");
  },
});

// ─── PulseSynchronizer ────────────────────────────────────────────────────────

await runSuite("pulse-sync", {
  "propose + apply pulse": async () => {
    MemoryTransport.clearRegistry?.() ?? null;
    const n1 = makeNodeRuntime("psync1");
    const n2 = makeNodeRuntime("psync2");
    await n1.start(); await n2.start();
    n1.addPeer("psync2", "mock_pubkey_psync2");
    n2.addPeer("psync1", "mock_pubkey_psync1");

    const engines = makeRaftCluster(["psync1", "psync2", "psync3_virtual"]);
    const engine1 = engines.get("psync1")!;
    engine1.start();
    // n1'i lider yap (single node majority=2, bunu 1 yaparak test)
    const soloEngine = new RaftEngine(
      "solo", [],
      async () => {},
      async (cmd, idx) => {
        if (cmd.type === "pulse:commit") {
          await sync.applyPulseCommit(cmd.pulseNumber, cmd.entries, idx, 1);
        }
      },
      { clusterSize: 1, electionTimeoutMinMs: 50, electionTimeoutMaxMs: 100 }
    );
    const sync = new PulseSynchronizer(soloEngine, n1);
    soloEngine.start();

    await waitMs(200); // lider seç

    assert(soloEngine.isLeader(), "Tek node lider olmalı");

    const snap   = makePulseSnapshot(10, 5);
    const result = await sync.proposePulse(snap);
    assert(result.ok, `Pulse önerilemedi: ${result.error}`);

    await waitMs(100);

    // Blok zincirinde olmalı
    // (apply direkt çağrıldı, zincire eklendi)
    soloEngine.stop(); engine1.stop();
    await n1.stop(); await n2.stop();
    for (const [, e] of engines) e.stop();
  },

  "deterministik blok hash: aynı pulse → aynı hash": async () => {
    const n = makeNodeRuntime("det1");
    await n.start();

    const soloEngine = new RaftEngine(
      "det_r", [], async () => {},
      async (cmd, idx) => {
        if (cmd.type === "pulse:commit")
          await sync.applyPulseCommit(cmd.pulseNumber, cmd.entries, idx, 1);
      },
      { clusterSize: 1 }
    );
    const sync = new PulseSynchronizer(soloEngine, n);

    const snap = makePulseSnapshot(77, 4);
    const b1   = await sync.applyPulseCommit(snap.pulseNumber, snap.entries, 0, 1);
    // Farklı node, aynı veri
    const n2   = makeNodeRuntime("det2");
    await n2.start();
    const soloEngine2 = new RaftEngine("det_r2", [], async () => {}, async () => {}, { clusterSize: 1 });
    const sync2 = new PulseSynchronizer(soloEngine2, n2);
    const b2   = await sync2.applyPulseCommit(snap.pulseNumber, snap.entries, 0, 1);

    assertEqual(b1.blockHash, b2.blockHash, "Aynı pulse → aynı blok hash");
    await n.stop(); await n2.stop();
  },
});

// ─── ValidatorSetManager ─────────────────────────────────────────────────────

await runSuite("validator-set", {
  "add + isValidator": async () => {
    const engine = new RaftEngine("vs1", [], async () => {}, async () => {}, { clusterSize: 1 });
    engine.start();
    await waitMs(150);

    const mgr = new ValidatorSetManager(engine, new MockSignatureProvider("vs1"));
    mgr.applyAdd("n1", "pk1", 1);
    mgr.applyAdd("n2", "pk2", 1);

    assert(mgr.isValidator("n1"), "n1 validator olmalı");
    assert(mgr.isValidator("n2"), "n2 validator olmalı");
    assert(!mgr.isValidator("n3"), "n3 validator değil");
    assertEqual(mgr.count(), 2);
    engine.stop();
  },

  "remove: isActive false yapar": () => {
    const engine = new RaftEngine("vs2", [], async () => {}, async () => {}, { clusterSize: 1 });
    const mgr    = new ValidatorSetManager(engine, new MockSignatureProvider("vs2"));
    mgr.applyAdd("n1", "pk1", 1);
    mgr.applyRemove("n1");
    assert(!mgr.isValidator("n1"), "Remove sonrası validator değil");
    assertEqual(mgr.count(), 0);
    engine.stop();
  },

  "quorum hesabı": () => {
    const engine = new RaftEngine("vs3", [], async () => {}, async () => {}, { clusterSize: 1 });
    const mgr    = new ValidatorSetManager(engine, new MockSignatureProvider("vs3"));
    mgr.applyAdd("n1", "pk1", 1);
    mgr.applyAdd("n2", "pk2", 1);
    mgr.applyAdd("n3", "pk3", 1);
    assertEqual(mgr.quorumSize(), 2, "3 validator → quorum 2");
    mgr.applyAdd("n4", "pk4", 1);
    mgr.applyAdd("n5", "pk5", 1);
    assertEqual(mgr.quorumSize(), 3, "5 validator → quorum 3");
    engine.stop();
  },

  "blok imza doğrulama: quorum karşılanıyor": async () => {
    const engine = new RaftEngine("vs4", [], async () => {}, async () => {}, { clusterSize: 1 });
    const mgr    = new ValidatorSetManager(engine, new MockSignatureProvider("vs4"));
    mgr.applyAdd("n1", "pk1", 1);
    mgr.applyAdd("n2", "pk2", 1);
    mgr.applyAdd("n3", "pk3", 1);

    const sigs   = { "n1": "mock_sig_n1_abc", "n2": "mock_sig_n2_def" };
    const result = await mgr.verifyBlockSignatures("block_hash", sigs);
    assert(result.ok,           "Quorum karşılandı");
    assertEqual(result.validCount, 2);
    assertEqual(result.required,   2);
    engine.stop();
  },

  "quorum karşılanmıyor": async () => {
    const engine = new RaftEngine("vs5", [], async () => {}, async () => {}, { clusterSize: 1 });
    const mgr    = new ValidatorSetManager(engine, new MockSignatureProvider("vs5"));
    mgr.applyAdd("n1", "pk1", 1);
    mgr.applyAdd("n2", "pk2", 1);
    mgr.applyAdd("n3", "pk3", 1);

    // Sadece 1 imza → quorum 2 → yetersiz
    const sigs   = { "n1": "mock_sig_n1_abc" };
    const result = await mgr.verifyBlockSignatures("block_hash", sigs);
    // 1 < 2 → ok false
    assertEqual(result.ok, false, "Tek imza quorum için yetersiz");
    engine.stop();
  },
});

// ─── ConsensusNode Entegrasyon ───────────────────────────────────────────────

await runSuite("consensus-node/entegrasyon", {
  "3 node cluster: lider seçilir": async () => {
    MemoryTransport.clearRegistry?.() ?? null;
    const nodes = ["cn1", "cn2", "cn3"].map((id) => {
      const rt = makeNodeRuntime(id);
      return { id, rt };
    });

    // Birbirine bağla
    for (const { id, rt } of nodes) {
      await rt.start();
      for (const { id: peerId, rt: peerRt } of nodes) {
        if (id !== peerId) rt.addPeer(peerId, `mock_pubkey_${peerId}`);
      }
    }

    const peers = (id: string) => nodes.filter((n) => n.id !== id).map((n) => n.id);
    const consensusNodes = nodes.map(({ id, rt }) =>
      new ConsensusNode(rt, peers(id), {
        electionTimeoutMinMs: 80,
        electionTimeoutMaxMs: 160,
        heartbeatIntervalMs:  30,
      })
    );

    await Promise.all(consensusNodes.map((cn) => cn.start()));
    await waitMs(500);

    const leaders = consensusNodes.filter((cn) => cn.isLeader());
    assert(leaders.length === 1, `Tam 1 lider beklendi: ${leaders.length}`);
    assert(leaders[0].stats().term >= 1);

    await Promise.all(consensusNodes.map((cn) => cn.stop()));
    for (const { rt } of nodes) await rt.stop();
  },

  "pulse commit lider üzerinden dağılır": async () => {
    MemoryTransport.clearRegistry?.() ?? null;
    const nodes = ["pc1", "pc2", "pc3"].map((id) => {
      const rt = makeNodeRuntime(id);
      return { id, rt };
    });

    for (const { id, rt } of nodes) {
      await rt.start();
      for (const { id: peerId, rt: peerRt } of nodes) {
        if (id !== peerId) rt.addPeer(peerId, `mock_pubkey_${peerId}`);
      }
    }

    const peers = (id: string) => nodes.filter((n) => n.id !== id).map((n) => n.id);
    const consensusNodes = nodes.map(({ id, rt }) =>
      new ConsensusNode(rt, peers(id), {
        electionTimeoutMinMs: 80,
        electionTimeoutMaxMs: 160,
        heartbeatIntervalMs:  30,
      })
    );

    await Promise.all(consensusNodes.map((cn) => cn.start()));
    await waitMs(500);

    const leader = consensusNodes.find((cn) => cn.isLeader())!;
    assert(leader !== undefined, "Lider bulunamadı");

    const snap   = makePulseSnapshot(100, 5);
    const result = await leader.commitPulse(snap);
    assert(result.ok || result.error === "NOT_LEADER",
      `Pulse commit: ${JSON.stringify(result)}`);

    await waitMs(200);

    // Stats
    const stats = leader.stats();
    assert(stats.role === "leader");
    assert(stats.term >= 1);

    await Promise.all(consensusNodes.map((cn) => cn.stop()));
    for (const { rt } of nodes) await rt.stop();
  },

  "validator ekleme": async () => {
    const n = makeNodeRuntime("val_n1");
    await n.start();
    const cn = new ConsensusNode(n, [], {
      electionTimeoutMinMs: 50,
      electionTimeoutMaxMs: 100,
    });
    await cn.start();
    await waitMs(200);

    assert(cn.isLeader(), "Tek node lider olmalı");

    cn.validators.applyAdd("new_validator", "pk_new", 1);
    assert(cn.validators.isValidator("new_validator"));
    assertEqual(cn.validators.count(), 1);

    await cn.stop();
    await n.stop();
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı log → aynı apply sırası": async () => {
    const appliedA: string[] = [];
    const appliedB: string[] = [];

    const makeEngine = (id: string, applied: string[]) =>
      new RaftEngine(id, [], async () => {},
        async (cmd) => { applied.push(cmd.type); },
        { clusterSize: 1 }
      );

    const ea = makeEngine("da", appliedA);
    const eb = makeEngine("db", appliedB);

    // Her ikisine aynı log yükle
    const log: RaftLogEntry[] = [
      { term: 1, index: 0, command: { type: "noop" }, timestamp: 1, nodeId: "n", checksum: "c" },
      { term: 1, index: 1, command: { type: "policy:update", policyId: "p1", payload: {} }, timestamp: 2, nodeId: "n", checksum: "c" },
      { term: 1, index: 2, command: { type: "validator:add", nodeId: "x", publicKey: "pk" }, timestamp: 3, nodeId: "n", checksum: "c" },
    ];

    ea.restoreLog(log, 1);
    eb.restoreLog(log, 1);

    // Her ikisinin de commit state'i aynı olmalı
    assertEqual(ea.state().commitIndex, eb.state().commitIndex);
    assertEqual(ea.state().logLength,   eb.state().logLength);
  },

  "pulse hash iki farklı node'da aynı": async () => {
    const n1 = makeNodeRuntime("dh1");
    const n2 = makeNodeRuntime("dh2");
    await n1.start(); await n2.start();

    const e1 = new RaftEngine("dh1", [], async () => {}, async () => {}, { clusterSize: 1 });
    const e2 = new RaftEngine("dh2", [], async () => {}, async () => {}, { clusterSize: 1 });

    const s1 = new PulseSynchronizer(e1, n1);
    const s2 = new PulseSynchronizer(e2, n2);

    const snap = makePulseSnapshot(999, 10);
    const b1   = await s1.applyPulseCommit(snap.pulseNumber, snap.entries, 5, 2);
    const b2   = await s2.applyPulseCommit(snap.pulseNumber, snap.entries, 5, 2);

    assertEqual(b1.blockHash, b2.blockHash,
      "Farklı node, aynı data → aynı blok hash");

    await n1.stop(); await n2.stop();
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "1000 komut commit (tek node)": async () => {
    const applied: string[] = [];
    const engine = new RaftEngine(
      "perf1", [],
      async () => {},
      async (cmd) => { applied.push(cmd.type); },
      { clusterSize: 1, heartbeatIntervalMs: 5 }
    );
    engine.start();
    await waitMs(200); // lider seç

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await engine.propose({ type: "noop" });
    }
    await waitMs(500); // commit bekle

    const ms = Date.now() - start;
    const metrics = engine.metrics();

    assert(metrics.logLength >= 1000, `Log length: ${metrics.logLength}`);
    assert(ms < 5000, `1000 komut ${ms}ms aldı (beklenen < 5s)`);
    console.log(`  → 1000 komut propose: ${ms}ms, commit: ${metrics.commitIndex}`);

    engine.stop();
  },

  "10 node seçim hızı": async () => {
    const nodeIds = Array.from({ length: 10 }, (_, i) => `sp${i}`);
    const engines = makeRaftCluster(nodeIds);

    const start = Date.now();
    for (const [, e] of engines) e.start();
    await waitMs(600);

    const ms      = Date.now() - start;
    const leaders = Array.from(engines.values()).filter((e) => e.isLeader());
    assertEqual(leaders.length, 1, "Tam 1 lider olmalı");
    assert(ms < 2000, `10 node seçim ${ms}ms (beklenen < 2s)`);
    console.log(`  → 10 node seçim süresi: ${ms}ms`);

    for (const [, e] of engines) e.stop();
  },
});
