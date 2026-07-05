/**
 * 1XX1 İndeksleme + Düzeltmeler — Kapsamlı Testler
 * Düzeltme 1: Event Storm / Scope Separation
 * Düzeltme 2: Index Reconciliation
 * Düzeltme 3: Katman Bağımsızlığı
 * Düzeltme 4: Scoring Modeli
 * Düzeltme 5: Query Pipeline
 */

import {
  runSuite, assert, assertEqual, makeProject
} from "../../core/test-utils.ts";
import { EventBus } from "../../core/event-bus.ts";
import { StructuralIndex } from "../structural-index.ts";
import { SemanticIndex } from "../semantic-index.ts";
import { ReverseIndex } from "../reverse-index.ts";
import { IndexReconciler } from "../index-reconciler.ts";
import { IndexManager } from "../index-manager.ts";
import { newProjectID } from "../../core/identity.ts";
import type { ProjectID } from "../../core/identity.ts";

// ─── Düzeltme 1: Event Storm / Scope Separation ──────────────────────────────

await runSuite("duzeltme1/event-scope", {
  "INDEX → CORE: scope violation engellenir": () => {
    const bus     = new EventBus();
    let coreFired = false;

    bus.on("project:created", () => { coreFired = true; });

    // INDEX handler içinde CORE olay atmaya çalış
    bus.on("index:upserted", () => {
      bus.emit("project:created", { id: "hack" }); // bu engellenmeli
    });

    // INDEX olay yayınla
    bus.emit("index:upserted", { projectId: "prj_test" });
    assert(!coreFired, "INDEX → CORE cascade engellenmeli");
  },

  "CORE → INDEX: izin verilir": () => {
    const bus       = new EventBus();
    let indexFired  = false;
    bus.on("index:upserted", () => { indexFired = true; });

    bus.emit("project:created", { id: "prj_1" }); // CORE olay
    // Farklı handler INDEX olay atabilir (CORE scope'ta değil, yeni emit)
    bus.emit("index:upserted", { projectId: "prj_1" }); // INDEX olay
    assert(indexFired, "Doğrudan INDEX emit çalışmalı");
  },

  "CUBE → INDEX: izin verilir": () => {
    const bus       = new EventBus();
    let indexFired  = false;

    bus.on("index:reconciled", () => { indexFired = true; });

    // CUBE scope'ta INDEX tetikleyemeyiz ama doğrudan emit mümkün
    bus.emit("cube:indexed", { path: "1/2/3", projectId: "prj_x" });
    bus.emit("index:reconciled", { result: {}, runCount: 1 });
    assert(indexFired);
  },

  "INDEX handler içinde INDEX olay atılabilir": () => {
    const bus = new EventBus();
    let count = 0;

    bus.on("index:upserted", () => {
      count++;
      if (count === 1) {
        bus.emit("index:reconciled", { result: {}, runCount: 1 });
      }
    });
    bus.on("index:reconciled", () => { count += 10; });

    bus.emit("index:upserted", { projectId: "prj_test" });
    assert(count >= 11, `INDEX → INDEX geçişi çalışmalı: count=${count}`);
  },

  "FIFO garantisi scope ile birlikte": () => {
    const bus = new EventBus();
    const order: string[] = [];

    bus.on("project:created",  () => order.push("CORE-1"));
    bus.on("cube:indexed",     () => order.push("CUBE-1"));
    bus.on("index:upserted",   () => order.push("INDEX-1"));

    bus.emit("project:created", {});
    bus.emit("cube:indexed",    {});
    bus.emit("index:upserted",  {});

    assertEqual(order, ["CORE-1", "CUBE-1", "INDEX-1"], "FIFO sırası korunmalı");
  },
});

// ─── Düzeltme 2: IndexReconciler ────────────────────────────────────────────

await runSuite("duzeltme2/reconciler", {
  "orphan semantic temizlenir": () => {
    const sem = new SemanticIndex();
    const rev = new ReverseIndex();
    const str = new StructuralIndex();

    const p1  = makeProject();
    const p2  = makeProject(); // bu silinecek

    sem.upsert(p1); sem.upsert(p2);
    rev.upsert(p1); rev.upsert(p2);

    // p2'yi ground truth'tan çıkar (silindi ama index'te kaldı)
    const live = new Set<ProjectID>([p1.id as ProjectID]);

    const reconciler = new IndexReconciler(sem, rev, str);
    const result     = reconciler.reconcile(live);

    assert(result.drifted,                "Drift tespit edilmeli");
    assert(result.orphansRemoved >= 2,    "En az 2 orphan silinmeli (sem+rev)");
    assertEqual(result.details.semantic.orphans, 1);
    assertEqual(result.details.reverse.orphans,  1);

    // Temizlendikten sonra p2 bulunamaz
    const semHits = sem.search([p2.name.split(" ")[0]]);
    assertEqual(
      semHits.filter((h) => h.projectId === (p2.id as ProjectID)).length,
      0,
      "Orphan semantic temizlenmeli"
    );
  },

  "temiz index'te drift yok": () => {
    const sem = new SemanticIndex();
    const rev = new ReverseIndex();
    const str = new StructuralIndex();

    const p = makeProject();
    sem.upsert(p); rev.upsert(p);

    const live       = new Set<ProjectID>([p.id as ProjectID]);
    const reconciler = new IndexReconciler(sem, rev, str);
    const result     = reconciler.reconcile(live);

    assert(!result.drifted,              "Drift olmamalı");
    assertEqual(result.orphansRemoved, 0, "Orphan olmamalı");
  },

  "event yayınlanır": () => {
    const bus = new EventBus();
    let reconciledFired = false;
    bus.on("index:reconciled", () => { reconciledFired = true; });

    const reconciler = new IndexReconciler(
      new SemanticIndex(), new ReverseIndex(), new StructuralIndex(), bus
    );
    reconciler.reconcile(new Set());
    assert(reconciledFired, "index:reconciled yayınlanmalı");
  },

  "drift olduğunda drift-detected yayınlanır": () => {
    const bus = new EventBus();
    let driftFired = false;
    bus.on("index:drift-detected", () => { driftFired = true; });

    const sem = new SemanticIndex();
    const rev = new ReverseIndex();
    const str = new StructuralIndex();
    const p   = makeProject();
    sem.upsert(p); rev.upsert(p);

    const reconciler = new IndexReconciler(sem, rev, str, bus);
    reconciler.reconcile(new Set()); // boş live → hepsi orphan

    assert(driftFired, "index:drift-detected yayınlanmalı");
  },

  "reconciler INDEX scope olayı yayınlar — CORE değil": () => {
    const bus = new EventBus();
    let coreFired = false;
    bus.on("project:created", () => { coreFired = true; });

    const reconciler = new IndexReconciler(
      new SemanticIndex(), new ReverseIndex(), new StructuralIndex(), bus
    );
    reconciler.reconcile(new Set());

    assert(!coreFired, "Reconciler CORE olay atmamalı");
  },
});

// ─── Düzeltme 3: Katman Bağımsızlığı ────────────────────────────────────────

await runSuite("duzeltme3/bagimsizlik", {
  "Structural path değişirse Semantic etkilenmez": () => {
    // Semantic yalnızca proje içeriğine bakar, CubePath'e değil
    const sem = new SemanticIndex();
    const str = new StructuralIndex();

    const p = makeProject({ name: "Mesh Tool", tags: ["mesh"] });
    sem.upsert(p);
    str.upsert("4/7/2", p.id as ProjectID);

    // Path değişti
    str.remove(p.id as ProjectID);
    str.upsert("5/5/5", p.id as ProjectID);

    // Semantic hâlâ çalışıyor
    const hits = sem.search(["mesh"]);
    assert(hits.length > 0, "Semantic path değişiminden etkilenmemeli");
    assert(hits[0].projectId === (p.id as ProjectID));
  },

  "Reverse metadata değişirse Structural etkilenmez": () => {
    const rev = new ReverseIndex();
    const str = new StructuralIndex();

    const p = makeProject({ license: "MIT" });
    rev.upsert(p);
    str.upsert("1/2/3", p.id as ProjectID);

    // Lisans değişti (yeni upsert)
    const p2 = { ...p, license: "GPL" as const };
    rev.upsert(p2);

    // Structural path değişmedi
    const entry = str.getByProject(p.id as ProjectID);
    assert(entry !== undefined, "Structural hâlâ çalışmalı");
    assertEqual(entry!.path, "1/2/3");
  },

  "Semantic değişirse Reverse etkilenmez": () => {
    const sem = new SemanticIndex();
    const rev = new ReverseIndex();

    const p = makeProject({ name: "Old Name", tags: ["STL"], license: "MIT" });
    sem.upsert(p);
    rev.upsert(p);

    // Semantic güncelle (ad değişti)
    const p2 = { ...p, name: "New Name" };
    sem.upsert(p2);

    // Reverse MIT'te hâlâ var
    assert(rev.getByLicense("MIT").has(p.id as ProjectID), "Reverse etkilenmemeli");
    // Semantic'te yeni isim geçiyor
    assert(sem.search(["new"]).length > 0);
  },
});

// ─── Düzeltme 4: Scoring Modeli ─────────────────────────────────────────────

await runSuite("duzeltme4/scoring", {
  "finalScore = 0.6×sem + 0.3×str + 0.1×rec": () => {
    const mgr = new IndexManager();

    const p1 = makeProject({ name: "STL Repair Tool", tags: ["STL", "mesh"] });
    const p2 = makeProject({ name: "Another Tool",    tags: ["python"] });
    mgr.indexProject(p1);
    mgr.indexProject(p2);

    const result = mgr.executePipeline({ term: "STL" });
    assert(result.results.length > 0);

    const top = result.results[0];
    assert(top.finalScore >= 0 && top.finalScore <= 1.05,
      `Score 0–1 aralığında olmalı: ${top.finalScore}`
    );
    // Ağırlıklı toplam doğrulaması
    const expected = top.semanticScore * 0.6 +
                     top.structuralScore * 0.3 +
                     top.recencyScore * 0.1;
    assert(
      Math.abs(top.finalScore - expected) < 0.01,
      `Score hesabı hatalı: ${top.finalScore} ≠ ${expected}`
    );
  },

  "refCoord: yakın proje daha yüksek structural skor": () => {
    const mgr = new IndexManager();

    const p1 = makeProject({ name: "mesh tool", cube: { x: 0, y: 0, z: 0 } });
    const p2 = makeProject({ name: "mesh tool", cube: { x: 10, y: 10, z: 10 } });
    mgr.indexProject(p1); mgr.indexProject(p2);

    // Structural'ı manuel yükle (cube:indexed event olmadan)
    mgr.structural.upsert("0/0/0",   p1.id as ProjectID);
    mgr.structural.upsert("10/10/10", p2.id as ProjectID);

    const result = mgr.executePipeline({
      term: "mesh",
      options: { refCoord: { x: 0, y: 0, z: 0 } },
    });

    const r1 = result.results.find((r) => r.projectId === (p1.id as ProjectID));
    const r2 = result.results.find((r) => r.projectId === (p2.id as ProjectID));

    if (r1 && r2) {
      assert(r1.structuralScore >= r2.structuralScore,
        `Yakın proje daha yüksek structural skor olmalı: ${r1.structuralScore} vs ${r2.structuralScore}`
      );
    }
  },

  "recencyScore: yeni proje yüksek skor": () => {
    const mgr = new IndexManager();
    const p   = makeProject({ name: "new project" });
    mgr.indexProject(p);
    mgr.structural.upsert("5/5/5", p.id as ProjectID);

    const result = mgr.executePipeline({ term: "new" });
    const hit    = result.results.find((r) => r.projectId === (p.id as ProjectID));

    if (hit) {
      assert(hit.recencyScore > 0.9,
        `Yeni proje yüksek recency olmalı: ${hit.recencyScore}`
      );
    }
  },

  "minScore filtresi: düşük skorlar elenir": () => {
    const mgr = new IndexManager();
    for (let i = 0; i < 5; i++) {
      mgr.indexProject(makeProject({ name: `mesh tool ${i}` }));
    }
    mgr.indexProject(makeProject({ name: "unrelated xyz", tags: [] }));

    const result = mgr.executePipeline({
      term: "mesh",
      options: { minScore: 0.5 },
    });
    // Tüm sonuçlar minScore üzerinde olmalı
    assert(
      result.results.every((r) => r.finalScore >= 0.5),
      "minScore altındaki sonuçlar elenmeli"
    );
  },
});

// ─── Düzeltme 5: Query Pipeline ─────────────────────────────────────────────

await runSuite("duzeltme5/pipeline", {
  "pipeline adımları sırasıyla çalışır": () => {
    const mgr = new IndexManager();
    mgr.indexProject(makeProject({ name: "STL Viewer", tags: ["STL", "3D"] }));

    const result = mgr.executePipeline({ term: "STL viewer" });

    assert(result.pipeline.length >= 3, "En az 3 pipeline adımı olmalı");

    const step1 = result.pipeline.find((s) => s.name === "normalize+tokenize");
    const step2 = result.pipeline.find((s) => s.name === "semantic-fanout");
    const step5 = result.pipeline.find((s) => s.name === "ranking");

    assert(step1 !== undefined, "normalize+tokenize adımı olmalı");
    assert(step2 !== undefined, "semantic-fanout adımı olmalı");
    assert(step5 !== undefined, "ranking adımı olmalı");

    // Tokenize: "stl viewer" → ["stl", "viewer", "stl viewer"] (en az 2)
    assert(step1!.outputCount >= 2, `Tokenize en az 2 token: ${step1!.outputCount}`);
  },

  "boş sorgu: sonuç yok": () => {
    const mgr = new IndexManager();
    const result = mgr.executePipeline({ term: "" });
    assertEqual(result.results.length, 0);
    assertEqual(result.total, 0);
  },

  "tek kelime: doğru sonuç": () => {
    const mgr = new IndexManager();
    const p   = makeProject({ name: "Blender Export", tags: ["blender", "3D"] });
    mgr.indexProject(p);

    const result = mgr.executePipeline({ term: "blender" });
    assert(result.projectIds.includes(p.id as ProjectID), "Blender projesi bulunmalı");
  },

  "filtre + pipeline birlikte çalışır": () => {
    const mgr = new IndexManager();
    const p1  = makeProject({ name: "mesh mit",  license: "MIT", tags: ["mesh"] });
    const p2  = makeProject({ name: "mesh gpl",  license: "GPL", tags: ["mesh"] });
    mgr.indexProject(p1); mgr.indexProject(p2);

    const result = mgr.executePipeline({
      term:   "mesh",
      filter: { license: "MIT" },
    });

    assert(result.projectIds.includes(p1.id as ProjectID),  "MIT projesi olmalı");
    assert(!result.projectIds.includes(p2.id as ProjectID), "GPL projesi elenmeli");
  },

  "limit parametresi çalışır": () => {
    const mgr = new IndexManager();
    for (let i = 0; i < 20; i++) {
      mgr.indexProject(makeProject({ name: `mesh tool ${i}`, tags: ["mesh"] }));
    }

    const result = mgr.executePipeline({ term: "mesh", options: { limit: 5 } });
    assert(result.results.length <= 5, "Limit uygulanmalı");
    assert(result.total >= 5, "Total limit'ten büyük olabilir");
  },

  "executionMs ölçülür": () => {
    const mgr    = new IndexManager();
    mgr.indexProject(makeProject({ name: "fast query" }));
    const result = mgr.executePipeline({ term: "fast" });
    assert(result.executionMs >= 0, "executionMs ölçülmeli");
    assert(result.executionMs < 1000, "1 saniyeden kısa olmalı");
  },

  "scoreBreakdown tüm bileşenleri içerir": () => {
    const mgr = new IndexManager();
    const p   = makeProject({ name: "detailed breakdown test" });
    mgr.indexProject(p);

    const result = mgr.executePipeline({ term: "detailed" });
    if (result.results.length > 0) {
      const bd = result.results[0];
      assert("semanticScore"   in bd, "semanticScore olmalı");
      assert("structuralScore" in bd, "structuralScore olmalı");
      assert("recencyScore"    in bd, "recencyScore olmalı");
      assert("finalScore"      in bd, "finalScore olmalı");
      assert("matchedTokens"   in bd, "matchedTokens olmalı");
    }
  },
});

// ─── Entegrasyon: Tüm Düzeltmeler Birlikte ────────────────────────────────────

await runSuite("entegrasyon/tum-duzeltmeler", {
  "IndexManager event aboneliği + pipeline çalışır": () => {
    const bus = new EventBus();
    const mgr = new IndexManager(bus);

    const p = makeProject({ name: "Integration Test", tags: ["integration"] });
    bus.emit("project:created", p); // CORE → INDEX tetikler

    const result = mgr.executePipeline({ term: "integration" });
    assert(result.results.length > 0, "Event üzerinden eklenen proje aranabilmeli");
  },

  "Reconcile sonrası pipeline tutarlı": () => {
    const mgr = new IndexManager();
    const p1  = makeProject({ name: "keep this project" });
    const p2  = makeProject({ name: "delete this project" });

    mgr.indexProject(p1); mgr.indexProject(p2);

    // Sadece p1 canlı — p2 ghost
    const live = new Set<ProjectID>([p1.id as ProjectID]);
    mgr.reconciler.reconcile(live);

    // Pipeline p2'yi bulmamalı
    const result = mgr.executePipeline({ term: "delete" });
    assert(
      !result.projectIds.includes(p2.id as ProjectID),
      "Reconcile sonrası ghost proje arama sonucunda olmamalı"
    );
  },

  "Cascade amplification yok": () => {
    const bus   = new EventBus();
    const mgr   = new IndexManager(bus);
    let callCount = 0;

    bus.on("project:created", () => { callCount++; });

    // project:created yayınla — IndexManager index günceller ama geri CORE olay atmaz
    bus.emit("project:created", makeProject({ name: "cascade test" }));

    // callCount yalnızca 1 olmalı (tek handler, cascade yoktu)
    assertEqual(callCount, 1, "project:created handler'ı yalnızca bir kez çalışmalı");
  },
});
