/**
 * 1XX1 Cube Engine — Birim Testleri
 * Aşama 02 — 1331 Cube Engine
 */

import { runSuite, assert, assertEqual, assertRejects, makeProject, makeCoord } from "../../core/test-utils.ts";
import { CubeEngine } from "../cube-engine.ts";
import { ErrorCode } from "../../core/errors.ts";
import { newProjectID } from "../../core/identity.ts";
import { EventBus } from "../../core/event-bus.ts";

function engine(dimension = 11, maxPerCell = 64): CubeEngine {
  return new CubeEngine(dimension, maxPerCell);
}

await runSuite("cube_engine/init", {
  "11³ = 1331 hücre oluşturulur": () => {
    const e = engine();
    const stats = e.fullStats();
    assertEqual(stats.totalCells, 1331);
    assertEqual(stats.occupiedCells, 0);
    assertEqual(stats.totalProjects, 0);
    assertEqual(stats.density, 0);
  },

  "5³ = 125 hücre oluşturulur": () => {
    const e = engine(5);
    assertEqual(e.fullStats().totalCells, 125);
  },

  "tüm koordinatlar geçerli": () => {
    const e = engine();
    for (let x = 0; x <= 10; x++) {
      for (let y = 0; y <= 10; y++) {
        for (let z = 0; z <= 10; z++) {
          assert(e.validate({ x, y, z }), `(${x},${y},${z}) geçersiz`);
        }
      }
    }
  },

  "sınır dışı koordinatlar geçersiz": () => {
    const e = engine();
    assert(!e.validate({ x: 11, y: 0, z: 0 }));
    assert(!e.validate({ x: -1, y: 0, z: 0 }));
    assert(!e.validate({ x: 0, y: 0, z: 11 }));
  },
});

await runSuite("cube_engine/index", {
  "proje indekslenir ve sorgulanır": async () => {
    const e = engine();
    const proj = makeProject({ cube: { x: 4, y: 7, z: 2 } });
    await e.index(proj);

    const results = await e.query({ x: 4, y: 7, z: 2 });
    assertEqual(results.length, 1);
    assertEqual(results[0].id, proj.id);
  },

  "geçersiz koordinat hata fırlatır": async () => {
    const e = engine();
    const proj = makeProject({ cube: { x: 11, y: 0, z: 0 } });
    await assertRejects(() => e.index(proj), ErrorCode.INVALID_COORDINATE);
  },

  "dolu küp hata fırlatır": async () => {
    const e = engine(11, 2); // max 2 proje
    const coord = { x: 0, y: 0, z: 0 };
    await e.index(makeProject({ cube: coord }));
    await e.index(makeProject({ cube: coord }));
    await assertRejects(
      () => e.index(makeProject({ cube: coord })),
      ErrorCode.CUBE_FULL
    );
  },

  "aynı proje tekrar eklenemez (idempotent)": async () => {
    const e = engine();
    const proj = makeProject({ cube: { x: 1, y: 1, z: 1 } });
    await e.index(proj);
    await e.index(proj); // ikinci kez
    const cell = e.getCell({ x: 1, y: 1, z: 1 });
    assertEqual(cell?.size(), 1); // hâlâ 1
  },

  "proje taşınınca eski hücre boşalır": async () => {
    const e = engine();
    const proj = makeProject({ cube: { x: 0, y: 0, z: 0 } });
    await e.index(proj);

    // Yeni koordinata taşı
    const newCoord = { x: 5, y: 5, z: 5 };
    await e.move(proj.id as Parameters<typeof e.move>[0], newCoord);

    const oldCell = e.getCell({ x: 0, y: 0, z: 0 });
    const newCell = e.getCell(newCoord);
    assertEqual(oldCell?.size(), 0);
    assertEqual(newCell?.size(), 1);
  },
});

await runSuite("cube_engine/remove", {
  "proje kaldırılır": async () => {
    const e = engine();
    const proj = makeProject({ cube: { x: 2, y: 3, z: 4 } });
    const pid = proj.id as Parameters<typeof e.remove>[0];
    await e.index(proj);
    const removed = await e.remove(pid);
    assert(removed);
    assertEqual(e.getCell({ x: 2, y: 3, z: 4 })?.size(), 0);
  },

  "olmayan proje kaldırma false döner": async () => {
    const e = engine();
    const removed = await e.remove(newProjectID());
    assert(!removed);
  },
});

await runSuite("cube_engine/neighbors", {
  "merkez koordinatın komşuları": async () => {
    const e = engine();
    const center = { x: 5, y: 5, z: 5 };
    const n1 = { x: 6, y: 5, z: 5 };
    const n2 = { x: 5, y: 6, z: 5 };

    await e.index(makeProject({ cube: n1 }));
    await e.index(makeProject({ cube: n2 }));

    const neighbors = await e.neighbors(center, 1);
    assert(neighbors.has("6,5,5"));
    assert(neighbors.has("5,6,5"));
    assert(!neighbors.has("5,5,5")); // merkez dahil değil
  },

  "boş komşular sonuçta yok": async () => {
    const e = engine();
    const neighbors = await e.neighbors({ x: 5, y: 5, z: 5 }, 1);
    assertEqual(neighbors.size, 0);
  },

  "radius=2 daha geniş alan": async () => {
    const e = engine();
    await e.index(makeProject({ cube: { x: 7, y: 5, z: 5 } })); // mesafe 2
    const neighbors = await e.neighbors({ x: 5, y: 5, z: 5 }, 2);
    assert(neighbors.has("7,5,5"));
  },
});

await runSuite("cube_engine/stats", {
  "istatistikler doğru hesaplanır": async () => {
    const e = engine();
    await e.index(makeProject({ cube: { x: 0, y: 0, z: 0 } }));
    await e.index(makeProject({ cube: { x: 0, y: 0, z: 0 } })); // aynı hücre, 2 proje
    await e.index(makeProject({ cube: { x: 1, y: 0, z: 0 } }));

    const s = e.fullStats();
    assertEqual(s.occupiedCells, 2);
    assertEqual(s.totalProjects, 3);
    assertEqual(s.maxCellLoad, 2);
    assert(s.density > 0 && s.density < 1);
  },

  "occupiedCells listesi doğru": async () => {
    const e = engine();
    await e.index(makeProject({ cube: { x: 3, y: 3, z: 3 } }));
    const occ = await e.occupiedCells();
    assertEqual(occ.length, 1);
    assertEqual(occ[0], { x: 3, y: 3, z: 3 });
  },
});

await runSuite("cube_engine/events", {
  "cube:indexed olayı yayınlanır": async () => {
    const bus = new EventBus();
    const e = new CubeEngine(11, 64, bus);
    let fired = false;
    bus.on("cube:indexed", () => { fired = true; });
    await e.index(makeProject({ cube: { x: 1, y: 2, z: 3 } }));
    assert(fired);
  },

  "taşıma olayı yayınlanır": async () => {
    const bus = new EventBus();
    const e = new CubeEngine(11, 64, bus);
    const proj = makeProject({ cube: { x: 0, y: 0, z: 0 } });
    await e.index(proj);

    let eventCount = 0;
    bus.on("cube:indexed", () => { eventCount++; });
    await e.move(proj.id as Parameters<typeof e.move>[0], { x: 1, y: 1, z: 1 });
    assert(eventCount > 0);
  },
});
