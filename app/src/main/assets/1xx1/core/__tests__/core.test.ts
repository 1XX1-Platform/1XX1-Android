/**
 * 1XX1 Core — Birim Testleri
 * Aşama 01 — Çekirdek Mimari
 */

import { runSuite, assert, assertEqual, assertThrows } from "../test-utils.ts";
import {
  coordToKey, keyToCoord, isValidCoord,
  manhattanDistance, euclideanDistance,
  getNeighbors, normalizeText, tokenize,
  generateId
} from "../utils.ts";
import { EventBus } from "../event-bus.ts";
import { SystemError, Errors, isSystemError, ErrorCode } from "../errors.ts";
import { ConfigManager, DEFAULT_CONFIG } from "../config.ts";
import {
  newProjectID, newDeveloperID, newEventID,
  cubeIDFromCoord, coordFromCubeID,
  isProjectID, isDeveloperID, isCubeID
} from "../identity.ts";

await runSuite("core/utils", {
  "coordToKey doğru format": () => {
    assertEqual(coordToKey({ x: 4, y: 7, z: 2 }), "4,7,2");
    assertEqual(coordToKey({ x: 0, y: 0, z: 0 }), "0,0,0");
    assertEqual(coordToKey({ x: 10, y: 10, z: 10 }), "10,10,10");
  },

  "keyToCoord geri dönüşüm": () => {
    const c = keyToCoord("4,7,2");
    assertEqual(c, { x: 4, y: 7, z: 2 });
  },

  "isValidCoord sınır kontrolleri": () => {
    assert(isValidCoord({ x: 0, y: 0, z: 0 }));
    assert(isValidCoord({ x: 10, y: 10, z: 10 }));
    assert(!isValidCoord({ x: 11, y: 0, z: 0 }));
    assert(!isValidCoord({ x: -1, y: 0, z: 0 }));
    assert(!isValidCoord({ x: 1.5, y: 0, z: 0 }));
  },

  "manhattanDistance hesaplaması": () => {
    assertEqual(manhattanDistance({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), 3);
    assertEqual(manhattanDistance({ x: 4, y: 7, z: 2 }, { x: 4, y: 7, z: 2 }), 0);
  },

  "getNeighbors radius=1": () => {
    const n = getNeighbors({ x: 5, y: 5, z: 5 }, 1);
    // 3³ - 1 = 26 komşu (köşe dahil)
    assertEqual(n.length, 26);
  },

  "getNeighbors kenar koordinatı": () => {
    const n = getNeighbors({ x: 0, y: 0, z: 0 }, 1);
    // Sadece 7 komşu (sınır dışı filtrelenir)
    assertEqual(n.length, 7);
  },

  "normalizeText ve tokenize": () => {
    assertEqual(normalizeText("  Hello  World  "), "hello world");
    assertEqual(tokenize("STL-Repair_Tool"), ["stl", "repair", "tool"]);
    assertEqual(tokenize("a"), []); // tek harf filtre
  },

  "generateId benzersizliği": () => {
    const ids = new Set(Array.from({ length: 1000 }, generateId));
    assertEqual(ids.size, 1000);
  },
});

await runSuite("core/errors", {
  "SystemError yapısı": () => {
    const err = Errors.projectNotFound("prj_abc");
    assert(err instanceof SystemError);
    assert(isSystemError(err));
    assertEqual(err.code, ErrorCode.PROJECT_NOT_FOUND);
    assertEqual(err.name, "SystemError");
  },

  "toJSON çalışıyor": () => {
    const err = Errors.invalidCoordinate({ x: 99 });
    const json = err.toJSON();
    assert("code" in json);
    assert("timestamp" in json);
  },

  "toApiError stack içermiyor": () => {
    const err = Errors.internal("test");
    const api = err.toApiError();
    assert(!("stack" in api));
    assert("code" in api && "message" in api);
  },
});

await runSuite("core/config", {
  "varsayılan değerler doğru": () => {
    const cm = new ConfigManager();
    assertEqual(cm.get().cube.dimension, 11);
    assertEqual(cm.totalCells(), 1331);
    assertEqual(cm.maxCoordValue(), 10);
    assertEqual(cm.get().pulse.intervalMs, 5000);
  },

  "override birleştirme": () => {
    const cm = new ConfigManager({ cube: { dimension: 5 } });
    assertEqual(cm.get().cube.dimension, 5);
    assertEqual(cm.totalCells(), 125);
    // Diğerleri varsayılan kaldı
    assertEqual(cm.get().pulse.intervalMs, 5000);
  },

  "geçersiz config hata fırlatır": () => {
    assertThrows(() => new ConfigManager({ cube: { dimension: 1 } }));
    assertThrows(() => new ConfigManager({ pulse: { intervalMs: 50 } }));
  },
});

await runSuite("core/identity", {
  "ProjectID prefix": () => {
    const id = newProjectID();
    assert(isProjectID(id));
    assert(id.startsWith("prj_"));
  },

  "DeveloperID prefix": () => {
    const id = newDeveloperID();
    assert(isDeveloperID(id));
    assert(id.startsWith("dev_"));
  },

  "CubeID deterministik": () => {
    const coord = { x: 4, y: 7, z: 2 };
    assertEqual(cubeIDFromCoord(coord), cubeIDFromCoord(coord));
    assert(isCubeID(cubeIDFromCoord(coord)));
  },

  "CubeID geri dönüşüm": () => {
    const coord = { x: 3, y: 8, z: 1 };
    const id = cubeIDFromCoord(coord);
    assertEqual(coordFromCubeID(id), coord);
  },

  "ID benzersizliği": () => {
    const ids = new Set([
      ...Array.from({ length: 500 }, newProjectID),
      ...Array.from({ length: 500 }, newDeveloperID),
    ]);
    assertEqual(ids.size, 1000);
  },
});

await runSuite("core/event-bus", {
  "olay yayınlanıp alınıyor": () => {
    const bus = new EventBus();
    let received = false;
    bus.on("project:created", () => { received = true; });
    bus.emit("project:created", { id: "prj_test" });
    assert(received);
  },

  "off ile handler kaldırılıyor": () => {
    const bus = new EventBus();
    let count = 0;
    const handler = () => { count++; };
    bus.on("project:created", handler);
    bus.emit("project:created", {});
    bus.off("project:created", handler);
    bus.emit("project:created", {});
    assertEqual(count, 1);
  },

  "handler hatası sistemi çökertmiyor": () => {
    const bus = new EventBus();
    bus.on("project:created", () => { throw new Error("handler hatası"); });
    // Bu satır hata fırlatmamalı
    bus.emit("project:created", {});
    assert(true);
  },

  "birden fazla handler": () => {
    const bus = new EventBus();
    let total = 0;
    bus.on("pulse:tick", () => { total += 1; });
    bus.on("pulse:tick", () => { total += 10; });
    bus.emit("pulse:tick", {});
    assertEqual(total, 11);
  },
});
