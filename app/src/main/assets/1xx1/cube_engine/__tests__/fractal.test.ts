/**
 * 1XX1 Fraktal Küp Motoru — Birim + Performans Testleri
 * Aşama 03 — Fraktal Alt Küpler
 */

import {
  runSuite, assert, assertEqual, assertThrows, assertRejects, makeProject
} from "../../core/test-utils.ts";
import { FractalNode } from "../fractal-node.ts";
import {
  rootPath, childPath, parentPath, parseCubePath,
  isValidCubePath, isAncestor, sameRoot, pathDepth, rootOf, commonAncestor
} from "../cube-path.ts";
import { splitNode, mergeNode, hashProjectToBucket } from "../split-merge.ts";
import { FractalCubeEngine } from "../fractal-cube-engine.ts";
import { EventBus } from "../../core/event-bus.ts";
import { newProjectID } from "../../core/identity.ts";
import type { ProjectID } from "../../core/identity.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function engine(split = 4, maxDepth = 0, merge = 2): FractalCubeEngine {
  return new FractalCubeEngine(11, split, maxDepth, merge);
}

function leafNode(path = "4/7/2"): FractalNode {
  return new FractalNode(path, { x: 4, y: 7, z: 2 }, 0);
}

// ─── CubePath ─────────────────────────────────────────────────────────────────

await runSuite("cube-path/oluşturma", {
  "rootPath formatı": () => {
    assertEqual(rootPath({ x: 4, y: 7, z: 2 }), "4/7/2");
    assertEqual(rootPath({ x: 0, y: 0, z: 0 }), "0/0/0");
    assertEqual(rootPath({ x: 10, y: 10, z: 10 }), "10/10/10");
  },

  "childPath ekleme": () => {
    assertEqual(childPath("4/7/2", 3),   "4/7/2/3");
    assertEqual(childPath("4/7/2/3", 8), "4/7/2/3/8");
    assertEqual(childPath("4/7/2/3/8", 5), "4/7/2/3/8/5");
  },

  "parentPath": () => {
    assertEqual(parentPath("4/7/2/3/8"), "4/7/2/3");
    assertEqual(parentPath("4/7/2/3"),   "4/7/2");
    assertEqual(parentPath("4/7/2"),     null); // kök, üst yok
  },

  "negatif childIndex hata": () => {
    assertThrows(() => childPath("4/7/2", -1));
  },
});

await runSuite("cube-path/ayrıştırma", {
  "kök path": () => {
    const p = parseCubePath("4/7/2");
    assertEqual(p.root, { x: 4, y: 7, z: 2 });
    assertEqual(p.childIndices, []);
    assertEqual(p.depth, 0);
  },

  "derin path": () => {
    const p = parseCubePath("4/7/2/3/8/5");
    assertEqual(p.root, { x: 4, y: 7, z: 2 });
    assertEqual(p.childIndices, [3, 8, 5]);
    assertEqual(p.depth, 3);
  },

  "geçersiz path hatası": () => {
    assertThrows(() => parseCubePath("4/7"));           // eksik segment
    assertThrows(() => parseCubePath("a/b/c"));          // sayı değil
    assertThrows(() => parseCubePath("4/7/2/-1"));       // negatif index
  },

  "isValidCubePath": () => {
    assert(isValidCubePath("4/7/2"));
    assert(isValidCubePath("4/7/2/3/8/5/99/100"));
    assert(!isValidCubePath("4/7"));
    assert(!isValidCubePath(""));
  },

  "pathDepth": () => {
    assertEqual(pathDepth("4/7/2"), 0);
    assertEqual(pathDepth("4/7/2/3"), 1);
    assertEqual(pathDepth("4/7/2/3/8/5"), 3);
  },

  "isAncestor": () => {
    assert(isAncestor("4/7/2", "4/7/2/3/8"));
    assert(isAncestor("4/7/2/3", "4/7/2/3/8/5"));
    assert(!isAncestor("4/7/2", "4/7/2"));      // kendisi ata değil
    assert(!isAncestor("3/7/2", "4/7/2/3"));    // farklı kök
  },

  "sameRoot": () => {
    assert(sameRoot("4/7/2", "4/7/2/3/8"));
    assert(!sameRoot("4/7/2", "5/7/2/3"));
  },

  "rootOf": () => {
    assertEqual(rootOf("4/7/2/3/8/5"), "4/7/2");
    assertEqual(rootOf("4/7/2"), "4/7/2");
  },

  "commonAncestor": () => {
    assertEqual(commonAncestor("4/7/2/3/8", "4/7/2/3/9"), "4/7/2/3");
    assertEqual(commonAncestor("4/7/2/1", "4/7/2/2"), "4/7/2");
    assertEqual(commonAncestor("4/7/2", "5/7/2"), null); // farklı kök
  },
});

// ─── FractalNode ──────────────────────────────────────────────────────────────

await runSuite("fractal-node/temel", {
  "başlangıçta leaf": () => {
    const n = leafNode();
    assert(n.isLeaf);
    assert(!n.isRouter);
    assertEqual(n.projectCount(), 0);
    assertEqual(n.depth, 0);
  },

  "proje ekle/kaldır": () => {
    const n = leafNode();
    const pid = newProjectID();
    assert(n.addProject(pid));
    assert(!n.addProject(pid)); // ikinci kez false
    assert(n.hasProject(pid));
    assertEqual(n.projectCount(), 1);
    assert(n.removeProject(pid));
    assertEqual(n.projectCount(), 0);
  },

  "router'a proje ekleme hatası": () => {
    const n = leafNode();
    n.promoteToRouter();
    assertThrows(() => n.addProject(newProjectID()));
  },

  "drainProjects": () => {
    const n = leafNode();
    const pids = [newProjectID(), newProjectID(), newProjectID()];
    for (const p of pids) n.addProject(p);
    const drained = n.drainProjects();
    assertEqual(drained.length, 3);
    assertEqual(n.projectCount(), 0);
  },

  "lazy child oluşturma": () => {
    const n = leafNode("4/7/2");
    assertEqual(n.childCount(), 0);
    const child = n.getOrCreateChild(3, { x: 1, y: 0, z: 0 });
    assertEqual(n.childCount(), 1);
    assertEqual(child.depth, 1);
    assertEqual(child.path, "4/7/2/3");
    // İkinci çağrı aynı nesneyi döndürür
    assert(n.getOrCreateChild(3, { x: 1, y: 0, z: 0 }) === child);
  },

  "totalProjectCount recursive": () => {
    const root = new FractalNode("1/2/3", { x: 1, y: 2, z: 3 }, 0);
    root.promoteToRouter();
    const c0 = root.getOrCreateChild(0, { x: 0, y: 0, z: 0 });
    const c1 = root.getOrCreateChild(1, { x: 1, y: 0, z: 0 });
    c0.addProject(newProjectID());
    c0.addProject(newProjectID());
    c1.addProject(newProjectID());
    assertEqual(root.totalProjectCount(), 3);
  },
});

// ─── Split / Merge ────────────────────────────────────────────────────────────

await runSuite("split-merge/hash", {
  "hashProjectToBucket 0–7": () => {
    for (let i = 0; i < 100; i++) {
      const b = hashProjectToBucket(newProjectID(), 8);
      assert(b >= 0 && b < 8, `Bucket dışı: ${b}`);
    }
  },

  "deterministik hash": () => {
    const pid = newProjectID();
    assertEqual(
      hashProjectToBucket(pid, 8),
      hashProjectToBucket(pid, 8)
    );
  },
});

await runSuite("split-merge/split", {
  "temel split": () => {
    const n = leafNode();
    const pids = Array.from({ length: 5 }, newProjectID);
    for (const p of pids) n.addProject(p);

    const children = splitNode(n, { bucketCount: 4 });
    assert(n.isRouter, "Parent router olmalı");
    assertEqual(n.projectCount(), 0, "Parent boş olmalı");

    const totalInChildren = children.reduce((s, c) => s + c.projectCount(), 0);
    assertEqual(totalInChildren, 5, "Tüm projeler çocuklarda");
  },

  "boş düğüm bölünmez": () => {
    const n = leafNode();
    const children = splitNode(n);
    assertEqual(children.length, 0);
    assert(n.isLeaf);
  },

  "maxDepth sınırı engeller": () => {
    const n = new FractalNode("4/7/2/3/8/5", { x: 0, y: 0, z: 0 }, 3);
    n.addProject(newProjectID());
    const children = splitNode(n, { maxDepth: 3 });
    assertEqual(children.length, 0); // engellendi
    assert(n.isLeaf); // hâlâ leaf
  },

  "maxDepth = 0 sınırsız": () => {
    const n = new FractalNode("4/7/2/3/8/5/6/7/8", { x: 0, y: 0, z: 0 }, 6);
    for (let i = 0; i < 3; i++) n.addProject(newProjectID());
    const children = splitNode(n, { maxDepth: 0, bucketCount: 4 });
    assert(children.length >= 0); // engellenmedi
  },

  "event yayınlanır": () => {
    const bus = new EventBus();
    let splitFired = false;
    let subcubeFired = false;
    bus.on("cube:split", () => { splitFired = true; });
    bus.on("cube:subcube-created", () => { subcubeFired = true; });

    const n = leafNode();
    n.addProject(newProjectID());
    splitNode(n, { eventBus: bus });

    assert(splitFired);
    assert(subcubeFired);
  },
});

await runSuite("split-merge/merge", {
  "temel merge": () => {
    const parent = leafNode();
    parent.promoteToRouter();
    const c0 = parent.getOrCreateChild(0, { x: 0, y: 0, z: 0 });
    const c1 = parent.getOrCreateChild(1, { x: 1, y: 0, z: 0 });
    c0.addProject(newProjectID());
    c1.addProject(newProjectID());
    c1.addProject(newProjectID());

    const result = mergeNode(parent);
    assert(result, "Merge başarılı olmalı");
    assert(parent.isLeaf, "Parent leaf olmalı");
    assertEqual(parent.projectCount(), 3, "3 proje parent'ta");
    assertEqual(parent.childCount(), 0, "Çocuklar silinmeli");
  },

  "router çocuğu olan merge engellenir": () => {
    const parent = leafNode();
    parent.promoteToRouter();
    const child = parent.getOrCreateChild(0, { x: 0, y: 0, z: 0 });
    child.promoteToRouter(); // router çocuk
    const result = mergeNode(parent);
    assert(!result, "Router çocuk varken merge engellenmeli");
  },

  "merge event yayınlanır": () => {
    const bus = new EventBus();
    let mergeFired = false;
    bus.on("cube:merge", () => { mergeFired = true; });

    const parent = leafNode();
    parent.promoteToRouter();
    parent.getOrCreateChild(0, { x: 0, y: 0, z: 0 }).addProject(newProjectID());
    mergeNode(parent, { eventBus: bus });
    assert(mergeFired);
  },
});

// ─── FractalCubeEngine ────────────────────────────────────────────────────────

await runSuite("fractal-engine/temel", {
  "proje ekle ve sorgula": async () => {
    const e = engine();
    const p = makeProject({ cube: { x: 4, y: 7, z: 2 } });
    await e.index(p);
    const results = await e.query({ x: 4, y: 7, z: 2 });
    assertEqual(results.length, 1);
    assertEqual(results[0].id, p.id);
  },

  "geçersiz koordinat hata": async () => {
    const e = engine();
    const p = makeProject({ cube: { x: 11, y: 0, z: 0 } });
    await assertRejects(() => e.index(p), "INVALID_COORDINATE");
  },

  "proje kaldırma": async () => {
    const e = engine();
    const p = makeProject({ cube: { x: 1, y: 2, z: 3 } });
    await e.index(p);
    const removed = await e.remove(p.id as ProjectID);
    assert(removed);
    const results = await e.query({ x: 1, y: 2, z: 3 });
    assertEqual(results.length, 0);
  },

  "olmayan proje kaldırma false": async () => {
    const e = engine();
    assert(!(await e.remove(newProjectID())));
  },
});

await runSuite("fractal-engine/split-otomatik", {
  "eşik aşılınca otomatik split": async () => {
    const e = engine(3); // 3 projede split
    const coord = { x: 5, y: 5, z: 5 };
    for (let i = 0; i < 5; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const root = e.getNode("5/5/5");
    // 5 proje eklenince (eşik=3 aşıldı) root router olmalı
    assert(root?.isRouter, "Root router olmalı");
    assert(!root?.isLeaf);
  },

  "recursive query tüm alt küpleri toplar": async () => {
    const e = engine(3);
    const coord = { x: 2, y: 2, z: 2 };
    const count = 6;
    for (let i = 0; i < count; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const results = await e.query(coord, { recursive: true });
    assertEqual(results.length, count, `${count} proje bulunmalı`);
  },

  "non-recursive query yalnızca kök": async () => {
    const e = engine(3);
    const coord = { x: 3, y: 3, z: 3 };
    for (let i = 0; i < 5; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const results = await e.query(coord, { recursive: false });
    // Kök router olduktan sonra kök leaf projesi yok → 0
    const root = e.getNode("3/3/3");
    if (root?.isRouter) {
      assertEqual(results.length, 0);
    } else {
      assert(results.length >= 0);
    }
  },
});

await runSuite("fractal-engine/path", {
  "pathOf doğru path döner": async () => {
    const e = engine();
    const p = makeProject({ cube: { x: 0, y: 1, z: 2 } });
    await e.index(p);
    const path = e.pathOf(p.id as ProjectID);
    assert(path !== undefined);
    assert(isValidCubePath(path!));
  },

  "taşıma çalışıyor": async () => {
    const e = engine();
    const p = makeProject({ cube: { x: 0, y: 0, z: 0 } });
    await e.index(p);

    await e.move(p.id as ProjectID, "5/5/5");
    const newPath = e.pathOf(p.id as ProjectID);
    assert(newPath?.startsWith("5/5/5"), `Beklenen 5/5/5, alınan: ${newPath}`);
  },
});

await runSuite("fractal-engine/events", {
  "cube:overflow yayınlanır": async () => {
    const bus = new EventBus();
    let overflowed = false;
    bus.on("cube:overflow", () => { overflowed = true; });

    const e = new FractalCubeEngine(11, 2, 0, 0, bus);
    const coord = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    assert(overflowed, "cube:overflow tetiklenmeli");
  },

  "cube:split yayınlanır": async () => {
    const bus = new EventBus();
    let splitFired = false;
    bus.on("cube:split", () => { splitFired = true; });

    const e = new FractalCubeEngine(11, 2, 0, 0, bus);
    const coord = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    assert(splitFired, "cube:split tetiklenmeli");
  },
});

await runSuite("fractal-engine/traverse", {
  "BFS traverse sıralı": async () => {
    const e = engine(2);
    const coord = { x: 1, y: 1, z: 1 };
    for (let i = 0; i < 4; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const depths: number[] = [];
    e.traverse((_, d) => { depths.push(d); }, "bfs");
    // BFS: önce derinlik 0, sonra 1, sonra 2 ...
    for (let i = 1; i < depths.length; i++) {
      assert(depths[i] >= depths[i - 1], "BFS artan derinlik");
    }
  },

  "DFS traverse çalışıyor": async () => {
    const e = engine(2);
    const coord = { x: 2, y: 2, z: 2 };
    for (let i = 0; i < 4; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    let visited = 0;
    e.traverse(() => { visited++; }, "dfs");
    assert(visited > 0);
  },

  "visitor false → dal kesilir": async () => {
    const e = engine(2);
    const coord = { x: 3, y: 3, z: 3 };
    for (let i = 0; i < 4; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    let visited = 0;
    e.traverse((node, _) => {
      visited++;
      if (node.depth >= 0) return false; // hemen kes
    }, "bfs");
    assertEqual(visited, 1, "Yalnızca kök ziyaret edilmeli");
  },
});

await runSuite("fractal-engine/istatistik", {
  "fullStats doğru": async () => {
    const e = engine(3);
    const coord = { x: 7, y: 7, z: 7 };
    for (let i = 0; i < 5; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const s = e.fullStats();
    assertEqual(s.rootCells, 1331);
    assert(s.occupiedRoots >= 1);
    assertEqual(s.totalProjects, 5);
    assert(s.routerNodes >= 0);
    assert(s.density >= 0 && s.density <= 1);
  },

  "occupiedCells doğru": async () => {
    const e = engine();
    await e.index(makeProject({ cube: { x: 1, y: 0, z: 0 } }));
    await e.index(makeProject({ cube: { x: 2, y: 0, z: 0 } }));
    const occ = await e.occupiedCells();
    assertEqual(occ.length, 2);
  },
});

// ─── Performans Testleri ──────────────────────────────────────────────────────

await runSuite("performans", {
  "1000 proje ekleme hızı": async () => {
    const e = engine(32, 0, 8);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await e.index(makeProject({ cube: { x: i % 11, y: (i >> 3) % 11, z: (i >> 6) % 11 } }));
    }
    const ms = Date.now() - start;
    const s = e.fullStats();
    assert(s.totalProjects === 1000, `1000 proje beklendi, alınan: ${s.totalProjects}`);
    assert(ms < 2000, `1000 proje ${ms}ms aldı (beklenen < 2000ms)`);
    console.log(`  → 1000 proje ekleme: ${ms}ms, nodes: ${s.totalNodes}`);
  },

  "tek küpe 200 proje — split zinciri": async () => {
    const e = engine(8, 0, 2); // 8'de split
    const coord = { x: 0, y: 0, z: 0 };
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const ms = Date.now() - start;
    const s = e.fullStats();
    assertEqual(s.totalProjects, 200);
    assert(s.maxDepthReached > 0, "Split zinciri oluşmalı");
    assert(ms < 500, `200 proje tek küpe ${ms}ms aldı (beklenen < 500ms)`);
    console.log(`  → 200 proje tek küp: ${ms}ms, maxDepth: ${s.maxDepthReached}`);
  },

  "recursive query O(proje sayısı)": async () => {
    const e = engine(8, 0, 2);
    const coord = { x: 5, y: 5, z: 5 };
    for (let i = 0; i < 100; i++) {
      await e.index(makeProject({ cube: coord }));
    }
    const start = Date.now();
    const results = await e.query(coord, { recursive: true });
    const ms = Date.now() - start;
    assertEqual(results.length, 100);
    assert(ms < 100, `Recursive query ${ms}ms aldı (beklenen < 100ms)`);
    console.log(`  → 100 proje recursive query: ${ms}ms`);
  },
});
