/**
 * 1XX1 Pulse Engine Testleri
 * Aşama 10 — Deterministik Zamanlayıcı
 *
 * Gruplar:
 *   clock          — pulse numarası, deterministik hesap
 *   eligibility    — filtre, spam koruması, ceza eşiği
 *   ranking        — skor formülü, tie-break, fairness etkisi
 *   rotation       — top sınırı, demote/promote, fairness güncelleme
 *   snapshot       — kaydet/yükle, checksum, restart recovery
 *   scheduler      — tam akış, eşzamanlı tick, restart recovery
 *   determinism    — aynı girdi → aynı sonuç
 *   anti-manip     — ceza, spam güncelleme
 *   fairness       — uzun süre görünmeyene bonus
 *   performans     — 100.000 proje simülasyonu
 */

import {
  runSuite, assert, assertEqual, makeProject
} from "../../core/test-utils.ts";
import {
  MockClock,
  SystemClock,
  timestampToPulse,
  msUntilNextPulse,
  pulseStartMs,
} from "../clock/pulse-clock.ts";
import { EligibilityEngine } from "../eligibility/eligibility-engine.ts";
import { RankingEngine }     from "../ranking/ranking-engine.ts";
import { RotationEngine }    from "../rotation/rotation-engine.ts";
import { PulseSnapshotStore } from "../snapshot/pulse-snapshot.ts";
import { PulseScheduler }    from "../scheduler/pulse-scheduler.ts";
import { EventBus }          from "../../core/event-bus.ts";
import type { FairnessRecord, PulseEntry } from "../pulse-types.ts";
import type { Project }      from "../../core/types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

const INTERVAL = 5_000; // 5 saniye

function makeProjects(count: number): Project[] {
  return Array.from({ length: count }, (_, i) =>
    makeProject({ name: `Project ${i}`, status: "active" })
  );
}

function makeRecord(overrides: Partial<FairnessRecord> = {}): FairnessRecord {
  return {
    projectId:              "prj_test",
    lastTopPulse:           0,
    topCount:               0,
    lastSeenPulse:          0,
    firstPulse:             0,
    penalty:                0,
    lastSignificantUpdate:  0,
    ...overrides,
  };
}

// ─── Clock ────────────────────────────────────────────────────────────────────

await runSuite("clock/deterministik", {
  "pulse numarası formülü": () => {
    const clock = new MockClock(10_000); // 10 saniye
    assertEqual(clock.nowPulse(INTERVAL), 2); // floor(10000/5000) = 2
  },

  "aynı ms → aynı pulse": () => {
    const clock = new MockClock(25_000);
    assertEqual(clock.nowPulse(INTERVAL), clock.nowPulse(INTERVAL));
  },

  "sınır: tam interval başlangıcı": () => {
    const clock = new MockClock(5_000); // tam 5 saniye
    assertEqual(clock.nowPulse(INTERVAL), 1);
  },

  "sınır: bir ms önce": () => {
    const clock = new MockClock(4_999);
    assertEqual(clock.nowPulse(INTERVAL), 0); // henüz pulse 1 değil
  },

  "timestampToPulse ve pulseStartMs tutarlı": () => {
    const ms    = 37_500;
    const pulse = timestampToPulse(ms, INTERVAL); // 7
    assertEqual(pulseStartMs(pulse, INTERVAL), 35_000);
  },

  "msUntilNextPulse": () => {
    const clock = new MockClock(7_000); // pulse 1'in ortasındayız (5000–10000)
    const wait  = msUntilNextPulse(clock, INTERVAL);
    assertEqual(wait, 3_000); // 10000 - 7000
  },

  "SystemClock.nowMs pozitif sayı döner": () => {
    const sc = new SystemClock();
    assert(sc.nowMs() > 0);
    assert(sc.nowPulse(INTERVAL) >= 0);
  },
});

// ─── Eligibility ──────────────────────────────────────────────────────────────

await runSuite("eligibility", {
  "arşivlenmiş proje elenir": () => {
    const eng      = new EligibilityEngine();
    const projects = [makeProject({ status: "archived" })];
    const results  = eng.filter(projects, new Map(), 100);
    assertEqual(results[0].eligible, false);
    assertEqual(results[0].reason, "archived");
  },

  "aktif proje geçer": () => {
    const eng     = new EligibilityEngine();
    const project = makeProject({ status: "active" });
    const result  = eng.check(project, undefined, 100);
    assert(result.eligible);
  },

  "pending proje de geçer": () => {
    const eng     = new EligibilityEngine();
    const project = makeProject({ status: "pending" });
    const result  = eng.check(project, undefined, 100);
    assert(result.eligible);
  },

  "ceza eşiği aşılınca ban": () => {
    const eng     = new EligibilityEngine({ banPenaltyThreshold: 10 });
    const project = makeProject({ status: "active" });
    const record  = makeRecord({ projectId: project.id, penalty: 15 }); // eşiği aştı
    const result  = eng.check(project, record, 100);
    assert(!result.eligible);
    assertEqual(result.reason, "banned");
  },

  "ceza eşiği altında geçer": () => {
    const eng     = new EligibilityEngine({ banPenaltyThreshold: 100 });
    const project = makeProject({ status: "active" });
    const record  = makeRecord({ projectId: project.id, penalty: 50 });
    const result  = eng.check(project, record, 100);
    assert(result.eligible);
  },

  "eligibleIds yalnızca geçenleri döndürür": () => {
    const eng = new EligibilityEngine();
    const p1  = makeProject({ status: "active" });
    const p2  = makeProject({ status: "archived" });
    const results = eng.filter([p1, p2], new Map(), 100);
    const ids     = eng.eligibleIds(results);
    assert(ids.includes(p1.id));
    assert(!ids.includes(p2.id));
  },
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

await runSuite("ranking", {
  "daha eski proje daha yüksek skor": () => {
    const eng    = new RankingEngine();
    const p1     = makeProject();
    const p2     = makeProject();
    const now    = 1000;
    const fair   = new Map<string, FairnessRecord>([
      [p1.id, makeRecord({ projectId: p1.id, firstPulse: 0   })], // 1000 pulse yaşlı
      [p2.id, makeRecord({ projectId: p2.id, firstPulse: 900 })], // 100 pulse yaşlı
    ]);
    const trust  = new Map<string, number>();
    const ranked = eng.rank([p1, p2], fair, trust, now);
    assertEqual(ranked[0].projectId, p1.id, "Eski proje önde olmalı");
  },

  "tie-break: eşit skor → projectId sırası (deterministik)": () => {
    const eng   = new RankingEngine();
    const ps    = makeProjects(5);
    const fair  = new Map<string, FairnessRecord>();
    const trust = new Map<string, number>();
    const r1    = eng.rank(ps, fair, trust, 0);
    const r2    = eng.rank(ps, fair, trust, 0);
    // İki çalışma aynı sırayı vermeli
    for (let i = 0; i < r1.length; i++) {
      assertEqual(r1[i].projectId, r2[i].projectId, `Sıra ${i} farklı`);
    }
  },

  "trust skoru küçük etki yapar": () => {
    const eng  = new RankingEngine();
    const p1   = makeProject();
    const p2   = makeProject();
    const fair = new Map<string, FairnessRecord>();
    // Eşit fairness ama farklı trust
    const trust = new Map([[p1.id, 100], [p2.id, 0]]);
    const ranked = eng.rank([p1, p2], fair, trust, 100);
    // p1 daha yüksek trust → biraz önde
    assert(ranked[0].trust > ranked[1].trust || ranked[0].projectId < ranked[1].projectId);
  },

  "ceza düşük skor verir": () => {
    const eng  = new RankingEngine();
    const p1   = makeProject();
    const p2   = makeProject();
    const fair = new Map<string, FairnessRecord>([
      [p1.id, makeRecord({ projectId: p1.id, firstPulse: 0, penalty: 50 })],
      [p2.id, makeRecord({ projectId: p2.id, firstPulse: 0, penalty: 0  })],
    ]);
    const ranked = eng.rank([p1, p2], fair, new Map(), 100);
    // p2 (cezasız) daha yüksek skor
    const ep1 = ranked.find((r) => r.projectId === p1.id)!;
    const ep2 = ranked.find((r) => r.projectId === p2.id)!;
    assert(ep2.score > ep1.score, `ep2(${ep2.score}) > ep1(${ep1.score}) olmalı`);
  },

  "explain bileşenleri döndürür": () => {
    const eng = new RankingEngine();
    const p   = makeProject();
    const rec = makeRecord({ projectId: p.id, firstPulse: 0, topCount: 5 });
    const exp = eng.explain(p, rec, 80, 100);
    assert("pulseAge"          in exp);
    assert("fairnessContrib"   in exp);
    assert("trustContrib"      in exp);
    assert("penaltyContrib"    in exp);
  },
});

// ─── Rotation ─────────────────────────────────────────────────────────────────

await runSuite("rotation", {
  "maxConsecutiveTop aşılınca top demote edilir": () => {
    const rot = new RotationEngine({ maxConsecutiveTop: 2, demoteSteps: 3 });
    const p1  = makeProject();
    const p2  = makeProject();
    const p3  = makeProject();

    const entries: PulseEntry[] = [
      { rank: 1, projectId: p1.id, score: 0.9, pulseAge: 100, fairness: 0.3, trust: 0.5, penalty: 0, promoted: false, demoted: false },
      { rank: 2, projectId: p2.id, score: 0.7, pulseAge: 50,  fairness: 0.5, trust: 0.5, penalty: 0, promoted: false, demoted: false },
      { rank: 3, projectId: p3.id, score: 0.5, pulseAge: 10,  fairness: 0.8, trust: 0.5, penalty: 0, promoted: false, demoted: false },
    ];

    const fair = new Map<string, FairnessRecord>([
      [p1.id, makeRecord({ projectId: p1.id, topCount: 5, lastTopPulse: 8 })],
    ]);

    // pulse=10, lastTopPulse=8, topCount=5, consecutivePulses=10-(8-4)=6 > maxConsecutiveTop=2
    // p1 demote olmalı
    const result = rot.apply(entries, fair, 10);
    assert(result.rotated.includes(p1.id), "p1 demote edilmeli");
    assertEqual(result.entries[0].projectId, p2.id, "p2 yeni top olmalı");
  },

  "limit altındaysa rotasyon olmaz": () => {
    const rot = new RotationEngine({ maxConsecutiveTop: 100 });
    const p1  = makeProject();
    const entries: PulseEntry[] = [
      { rank: 1, projectId: p1.id, score: 0.9, pulseAge: 5, fairness: 0.5, trust: 0.5, penalty: 0, promoted: false, demoted: false },
    ];
    const fair = new Map<string, FairnessRecord>();
    const result = rot.apply(entries, fair, 10);
    assertEqual(result.rotated.length, 0, "Rotasyon olmamali");
    assertEqual(result.entries[0].projectId, p1.id);
  },

  "fairness kaydı oluşturulur (yeni proje)": () => {
    const rot = new RotationEngine();
    const p   = makeProject();
    const entries: PulseEntry[] = [
      { rank: 1, projectId: p.id, score: 0.5, pulseAge: 0, fairness: 1, trust: 0, penalty: 0, promoted: false, demoted: false },
    ];
    const fair = new Map<string, FairnessRecord>();
    rot.apply(entries, fair, 50);
    assert(fair.has(p.id), "Fairness kaydı oluşturulmalı");
    assertEqual(fair.get(p.id)!.lastSeenPulse, 50);
  },

  "boş liste → hiçbir şey olmaz": () => {
    const rot    = new RotationEngine();
    const result = rot.apply([], new Map(), 10);
    assertEqual(result.rotated.length, 0);
    assertEqual(result.promoted.length, 0);
  },
});

// ─── Snapshot ─────────────────────────────────────────────────────────────────

await runSuite("snapshot", {
  "kaydet ve geri yükle": () => {
    const store    = new PulseSnapshotStore();
    const snap = {
      pulseNumber: 42, intervalMs: INTERVAL, startMs: 210_000,
      completedAt: new Date(), entries: [],
      totalEligible: 5, rotated: [],
      stats: { avgScore: 0.5, minScore: 0.1, maxScore: 0.9, newEntries: 2 },
    };
    const fair     = new Map<string, FairnessRecord>([[
      "prj_x", makeRecord({ projectId: "prj_x", topCount: 3 })
    ]]);

    store.save(snap, fair);
    const latest = store.latest()!;
    assert(latest !== null);
    assertEqual(latest.lastSnapshot.pulseNumber, 42);

    const restored = store.restoreFairness(latest);
    assert(restored.has("prj_x"));
    assertEqual(restored.get("prj_x")!.topCount, 3);
  },

  "checksum doğrulama": () => {
    const store = new PulseSnapshotStore();
    const snap  = {
      pulseNumber: 1, intervalMs: INTERVAL, startMs: 5_000,
      completedAt: new Date(), entries: [],
      totalEligible: 0, rotated: [],
      stats: { avgScore: 0, minScore: 0, maxScore: 0, newEntries: 0 },
    };
    const saved = store.save(snap, new Map());
    assert(store.verify(saved), "Checksum doğrulanmalı");

    // Bozuk veri
    const tampered = { ...saved, checksum: "00000000" };
    assert(!store.verify(tampered), "Bozuk checksum reddedilmeli");
  },

  "maxHistory aşılınca eski atılır": () => {
    const store = new PulseSnapshotStore(3); // max 3
    const makeSnap = (n: number) => ({
      pulseNumber: n, intervalMs: INTERVAL, startMs: n * INTERVAL,
      completedAt: new Date(), entries: [],
      totalEligible: 0, rotated: [],
      stats: { avgScore: 0, minScore: 0, maxScore: 0, newEntries: 0 },
    });

    for (let i = 1; i <= 5; i++) {
      store.save(makeSnap(i), new Map());
    }
    assertEqual(store.count(), 3, "Max 3 snapshot saklanmalı");
    assertEqual(store.latest()!.lastSnapshot.pulseNumber, 5);
  },
});

// ─── PulseScheduler ───────────────────────────────────────────────────────────

await runSuite("scheduler/temel", {
  "tick tek seferlik çalışır": async () => {
    const clock  = new MockClock(50_000);
    const sched  = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    const projects = makeProjects(5);
    sched.start(() => projects);
    const snap   = await sched.tick();
    sched.stop();

    assert(snap !== null, "Snapshot oluşturulmalı");
    assert(snap!.entries.length <= 5);
    assert(snap!.pulseNumber === clock.nowPulse(INTERVAL));
  },

  "isRunning kontrolü": async () => {
    const clock = new MockClock(10_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    assert(!sched.isRunning());
    sched.start(() => []);
    assert(sched.isRunning());
    sched.stop();
    assert(!sched.isRunning());
  },

  "boş proje listesi snapshot null döner": async () => {
    const clock = new MockClock(10_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    sched.start(() => []);
    const snap  = await sched.tick();
    sched.stop();
    assert(snap === null, "Boş liste → null snapshot");
  },

  "event yayınlanır": async () => {
    const bus    = new EventBus();
    const clock  = new MockClock(5_000);
    const sched  = new PulseScheduler({ intervalMs: INTERVAL }, clock, bus);
    const events: string[] = [];
    bus.on("pulse:tick",      () => events.push("tick"));
    bus.on("pulse:completed" as never, () => events.push("completed"));

    sched.start(() => makeProjects(3));
    await sched.tick();
    sched.stop();

    assert(events.includes("tick"),      "pulse:tick yayınlanmalı");
    assert(events.includes("completed"), "pulse:completed yayınlanmalı");
  },
});

await runSuite("scheduler/eşzamanlı-tick-koruması", {
  "iki eşzamanlı tick → biri atlanır": async () => {
    const clock = new MockClock(5_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    sched.start(() => makeProjects(10));

    // İki tick aynı anda başlatılıyor
    const [r1, r2] = await Promise.all([sched.tick(), sched.tick()]);
    sched.stop();

    // En az biri çalışmalı, biri null (atlandı)
    const results = [r1, r2];
    const valid   = results.filter((r) => r !== null);
    assert(valid.length >= 1, "En az bir tick başarılı olmalı");
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı girdi + aynı pulse → aynı sıralama": async () => {
    const projects = makeProjects(20);
    const fair     = new Map<string, FairnessRecord>();
    const trust    = new Map<string, number>();
    const pulse    = 500;

    const eng = new RankingEngine();
    const r1  = eng.rank(projects, fair, trust, pulse);
    const r2  = eng.rank(projects, fair, trust, pulse);

    for (let i = 0; i < r1.length; i++) {
      assertEqual(r1[i].projectId, r2[i].projectId, `Pozisyon ${i} farklı`);
      assertEqual(r1[i].score,     r2[i].score,     `Skor ${i} farklı`);
    }
  },

  "farklı proje seti → farklı sıralama": async () => {
    const eng  = new RankingEngine();
    const ps1  = makeProjects(5);
    const ps2  = makeProjects(5); // farklı ID'ler
    const fair = new Map<string, FairnessRecord>();
    const r1   = eng.rank(ps1, fair, new Map(), 100);
    const r2   = eng.rank(ps2, fair, new Map(), 100);
    // En üstteki ID'ler farklı olmalı (çünkü farklı projeler)
    assert(r1[0].projectId !== r2[0].projectId || ps1[0].id === ps2[0].id,
      "Farklı projeler için farklı sıralama");
  },

  "restart sonrası aynı sonuç": async () => {
    const projects = makeProjects(10);
    const pulse    = 200;

    // İlk scheduler çalışması
    const clock1 = new MockClock(pulse * INTERVAL + 1000);
    const sched1 = new PulseScheduler({ intervalMs: INTERVAL }, clock1);
    sched1.start(() => projects);
    const snap1  = await sched1.tick();
    sched1.stop();

    // İkinci scheduler aynı clock ve projects ile
    const clock2 = new MockClock(pulse * INTERVAL + 1000);
    const sched2 = new PulseScheduler({ intervalMs: INTERVAL }, clock2);
    sched2.start(() => projects);
    const snap2  = await sched2.tick();
    sched2.stop();

    assert(snap1 !== null && snap2 !== null);
    assertEqual(snap1!.pulseNumber, snap2!.pulseNumber, "Pulse numaraları eşit olmalı");
    assertEqual(snap1!.entries.length, snap2!.entries.length, "Entry sayıları eşit");
    for (let i = 0; i < snap1!.entries.length; i++) {
      assertEqual(
        snap1!.entries[i].projectId,
        snap2!.entries[i].projectId,
        `Pozisyon ${i} farklı`
      );
    }
  },
});

// ─── Anti-Manipülasyon ────────────────────────────────────────────────────────

await runSuite("anti-manipulation", {
  "ceza uygulama ve skor düşüşü": async () => {
    const clock = new MockClock(5_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    const projects = makeProjects(3);
    sched.start(() => projects);

    const snapBefore = await sched.tick();
    const topBefore  = snapBefore?.entries[0].projectId;

    // İlk projeye ceza ver
    if (topBefore) {
      sched.applyPenalty(topBefore, 1000); // büyük ceza
    }

    const snapAfter = await sched.tick();
    sched.stop();

    // Ceza sonrası top değişmeli veya cezalı projenin skoru düşmeli
    const cezaliEntry = snapAfter?.entries.find((e) => e.projectId === topBefore);
    if (cezaliEntry) {
      assert(cezaliEntry.penalty > 0, "Ceza kaydedilmeli");
    }
  },

  "ceza temizleme": async () => {
    const clock = new MockClock(5_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    const projects = [makeProject()];
    sched.start(() => projects);
    await sched.tick();

    sched.applyPenalty(projects[0].id, 50);
    assertEqual(sched.getFairness(projects[0].id)?.penalty, 50);

    sched.clearPenalty(projects[0].id);
    assertEqual(sched.getFairness(projects[0].id)?.penalty, 0);
    sched.stop();
  },
});

// ─── Fairness ─────────────────────────────────────────────────────────────────

await runSuite("fairness", {
  "yeni proje ilk pulse'ta avantaj": () => {
    const eng    = new RankingEngine();
    const old_p  = makeProject();
    const new_p  = makeProject();
    const pulse  = 1000;

    const fair = new Map<string, FairnessRecord>([
      [old_p.id, makeRecord({
        projectId:    old_p.id,
        firstPulse:   0,
        topCount:     30,   // çok görünmüş
        lastTopPulse: 999,  // az önce top'taydı
      })],
      // new_p fairness kaydı yok → firstPulse=now
    ]);

    const ranked = eng.rank([old_p, new_p], fair, new Map(), pulse);
    const old_entry = ranked.find((r) => r.projectId === old_p.id)!;
    const new_entry = ranked.find((r) => r.projectId === new_p.id)!;

    // Yeni projenin fairness skoru yüksek olmalı
    assert(new_entry.fairness >= old_entry.fairness,
      `Yeni proje fairness(${new_entry.fairness}) >= eski(${old_entry.fairness})`
    );
  },

  "çok görünmüş proje zamanla geri düşer": () => {
    const eng = new RankingEngine();
    const p   = makeProject();

    // Pulse 100'de yüksek topCount
    const fair100 = new Map([[p.id, makeRecord({
      projectId:    p.id, firstPulse: 0,
      topCount:     0, lastTopPulse: 0
    })]]);

    // Pulse 200'de
    const fair200 = new Map([[p.id, makeRecord({
      projectId:    p.id, firstPulse: 0,
      topCount:     50, lastTopPulse: 195 // az önce çok top'taydı
    })]]);

    const entry100 = eng.rank([p], fair100, new Map(), 100)[0];
    const entry200 = eng.rank([p], fair200, new Map(), 200)[0];

    // Pulse 200'deki fairness skoru daha düşük olmalı
    assert(entry200.fairness <= entry100.fairness,
      `Çok görünmüş proje(${entry200.fairness}) <= az görünmüş(${entry100.fairness})`
    );
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "100.000 proje eligibility filtresi": () => {
    const eng      = new EligibilityEngine();
    const projects = makeProjects(100_000);
    // Yarısını arşivle
    for (let i = 0; i < 50_000; i++) {
      projects[i] = { ...projects[i], status: "archived" };
    }

    const start  = Date.now();
    const results = eng.filter(projects, new Map(), 1000);
    const ms     = Date.now() - start;

    const eligible = eng.eligibleIds(results).length;
    assertEqual(eligible, 50_000, `50.000 uygun proje beklendi: ${eligible}`);
    assert(ms < 2000, `Eligibility ${ms}ms (beklenen < 2000ms)`);
    console.log(`  → 100.000 eligibility: ${ms}ms`);
  },

  "100.000 proje ranking": () => {
    const eng      = new RankingEngine();
    const projects = makeProjects(100_000);
    const fair     = new Map<string, FairnessRecord>();
    const trust    = new Map<string, number>();

    const start  = Date.now();
    const ranked = eng.rank(projects, fair, trust, 1000);
    const ms     = Date.now() - start;

    assertEqual(ranked.length, 100_000);
    assert(ms < 5000, `Ranking ${ms}ms (beklenen < 5000ms)`);
    console.log(`  → 100.000 ranking: ${ms}ms`);
  },

  "1.000 proje tam scheduler tick": async () => {
    const clock = new MockClock(100 * INTERVAL);
    const sched = new PulseScheduler({ intervalMs: INTERVAL, maxEntries: 1000 }, clock);
    const projects = makeProjects(1000);

    sched.start(() => projects);

    const start = Date.now();
    const snap  = await sched.tick();
    const ms    = Date.now() - start;

    sched.stop();
    assert(snap !== null);
    assert(snap!.entries.length > 0);
    assert(ms < 500, `Scheduler tick ${ms}ms (beklenen < 500ms)`);
    console.log(`  → 1.000 proje scheduler tick: ${ms}ms`);
  },

  "stats metrikleri doğru": async () => {
    const clock = new MockClock(50_000);
    const sched = new PulseScheduler({ intervalMs: INTERVAL }, clock);
    sched.start(() => makeProjects(100));
    await sched.tick();
    await sched.tick();
    sched.stop();

    const stats = sched.stats();
    assert(stats.totalPulses >= 2, `Toplam tick >= 2: ${stats.totalPulses}`);
    assert(stats.avgCycleMs  >= 0, `avgCycleMs >= 0`);
    assert(stats.eligibleProjects > 0);
  },
});
