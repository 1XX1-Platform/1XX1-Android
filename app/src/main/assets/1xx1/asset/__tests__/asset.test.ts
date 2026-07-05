/**
 * 1XX1 Asset Bank Testleri
 * Aşama 11
 *
 * Gruplar:
 *   entities       — entity tipleri, yardımcılar, lisans sabitleri
 *   storage        — InMemoryStorageAdapter CRUD, URL
 *   metadata       — checksum, MIME tespiti, duplicate detection
 *   dependency     — DAG, döngü tespiti, yol bulma, istatistik
 *   repository     — CRUD, checksum indeksi, arama, sürüm
 *   service        — yükleme, duplicate, sürümleme, lisans, bağımlılık, indirme
 *   license-policy — uyumluluk matrisi
 *   performans     — 10.000 asset yükleme
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import {
  guessAssetType, isSupportedFormat, COPYLEFT_LICENSES,
  toAssetSummary,
} from "../entities/asset.entity.ts";
import type { Asset, AssetLicenseType } from "../entities/asset.entity.ts";
import { InMemoryStorageAdapter, buildStorageKey } from "../storage/storage-adapter.ts";
import { MetadataEngine, computeChecksum, detectMimeType } from "../metadata/metadata-engine.ts";
import { DependencyGraph } from "../dependency/dependency-graph.ts";
import { InMemoryAssetRepository } from "../repository/asset.repository.ts";
import { AssetService, checkLicenseCompatibility } from "../service/asset.service.ts";
import { EventBus } from "../../core/event-bus.ts";
import { newDeveloperID } from "../../core/identity.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function makeData(content = "test-content"): Uint8Array {
  return new TextEncoder().encode(content);
}

function makePngData(): Uint8Array {
  // PNG magic bytes
  return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(100).fill(0)]);
}

function makeStlData(): Uint8Array {
  // ASCII STL magic: "solid "
  return new TextEncoder().encode("solid test\nendsolid test");
}

function makeService(bus?: EventBus) {
  const repo    = new InMemoryAssetRepository();
  const storage = new InMemoryStorageAdapter();
  return new AssetService(repo, storage, bus ?? new EventBus());
}

const OWNER = newDeveloperID();

// ─── Entity Testleri ──────────────────────────────────────────────────────────

await runSuite("entities", {
  "guessAssetType: stl → 3d_model": () => assertEqual(guessAssetType("stl"), "3d_model"),
  "guessAssetType: png → texture":  () => assertEqual(guessAssetType("png"), "texture"),
  "guessAssetType: glsl → shader":  () => assertEqual(guessAssetType("glsl"), "shader"),
  "guessAssetType: py → script":    () => assertEqual(guessAssetType("py"), "script"),
  "guessAssetType: bilinmeyen → unknown": () => assertEqual(guessAssetType("xyz"), "unknown"),
  "guessAssetType: . ile uzantı":   () => assertEqual(guessAssetType(".stl"), "3d_model"),

  "isSupportedFormat: stl 3d_model'de var": () => assert(isSupportedFormat("3d_model", "stl")),
  "isSupportedFormat: png texture'da var":  () => assert(isSupportedFormat("texture", "png")),
  "isSupportedFormat: stl texture'da yok": () => assert(!isSupportedFormat("texture", "stl")),

  "COPYLEFT_LICENSES doğru içerik":  () => {
    assert(COPYLEFT_LICENSES.has("GPL-3.0"));
    assert(COPYLEFT_LICENSES.has("CC-BY-SA-4.0"));
    assert(!COPYLEFT_LICENSES.has("MIT"));
  },

  "toAssetSummary ISO string döndürür": () => {
    const asset: Asset = {
      assetId: "ast_1", ownerId: OWNER, type: "3d_model", format: "stl",
      title: "Test", description: "D", tags: ["3D"], license: "MIT",
      status: "active", versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    const sum = toAssetSummary(asset);
    assertEqual(sum.assetId, "ast_1");
    assert(typeof sum.createdAt === "string");
  },
});

// ─── Storage Testleri ─────────────────────────────────────────────────────────

await runSuite("storage/in-memory", {
  "put + get": async () => {
    const s   = new InMemoryStorageAdapter();
    const key = "test/key/file.stl";
    const d   = makeData("hello storage");
    await s.put(key, d, "model/stl");
    const got = await s.get(key);
    assert(got !== null);
    assertEqual(new TextDecoder().decode(got!), "hello storage");
  },

  "exists": async () => {
    const s = new InMemoryStorageAdapter();
    assert(!(await s.exists("missing")));
    await s.put("present", makeData(), "text/plain");
    assert(await s.exists("present"));
  },

  "delete": async () => {
    const s = new InMemoryStorageAdapter();
    await s.put("del-me", makeData(), "text/plain");
    assert(await s.delete("del-me"));
    assert(!(await s.exists("del-me")));
  },

  "list prefix": async () => {
    const s = new InMemoryStorageAdapter();
    await s.put("assets/dev1/a1/v1/f.stl", makeData(), "model/stl");
    await s.put("assets/dev1/a2/v1/f.png", makeData(), "image/png");
    await s.put("assets/dev2/a3/v1/f.obj", makeData(), "model/obj");
    const keys = await s.list("assets/dev1/");
    assertEqual(keys.length, 2);
    assert(keys.every((k) => k.startsWith("assets/dev1/")));
  },

  "getUrl döndürür": async () => {
    const s   = new InMemoryStorageAdapter();
    const key = "test/url/file.glb";
    await s.put(key, makeData(), "model/gltf-binary");
    const url = await s.getUrl(key);
    assert(url.includes("test/url/file.glb"));
  },

  "stats": async () => {
    const s = new InMemoryStorageAdapter();
    await s.put("f1", makeData("abc"), "text/plain");
    await s.put("f2", makeData("defgh"), "text/plain");
    const stats = await s.stats();
    assertEqual(stats.totalObjects, 2);
    assert(stats.totalBytes > 0);
  },

  "buildStorageKey güvenli format": () => {
    const key = buildStorageKey("dev_123", "ast_456", "ver_789", "model.stl");
    assert(key.startsWith("assets/"));
    assert(key.includes("dev_123"));
    assert(key.endsWith("model_stl")); // . → _
  },
});

// ─── Metadata Testleri ────────────────────────────────────────────────────────

await runSuite("metadata", {
  "computeChecksum SHA-256 üretir": async () => {
    const data = makeData("hello");
    const cs   = await computeChecksum(data);
    assert(cs.sha256.length === 64 || cs.sha256.length === 8, // fallback 8 char
      `SHA-256 length: ${cs.sha256.length}`
    );
    assert(/^[0-9a-f]+$/.test(cs.sha256), "Hex format olmalı");
  },

  "aynı içerik → aynı checksum": async () => {
    const d1 = makeData("same");
    const d2 = makeData("same");
    const [c1, c2] = await Promise.all([computeChecksum(d1), computeChecksum(d2)]);
    assertEqual(c1.sha256, c2.sha256);
  },

  "farklı içerik → farklı checksum": async () => {
    const [c1, c2] = await Promise.all([
      computeChecksum(makeData("aaa")),
      computeChecksum(makeData("bbb")),
    ]);
    assert(c1.sha256 !== c2.sha256);
  },

  "PNG magic bytes tespiti": () => {
    const { mimeType, ext } = detectMimeType(makePngData(), "image.png");
    assertEqual(mimeType, "image/png");
    assertEqual(ext, "png");
  },

  "STL ASCII tespiti": () => {
    const { ext } = detectMimeType(makeStlData(), "model.stl");
    assertEqual(ext, "stl");
  },

  "uzantıdan mime": () => {
    const { mimeType } = detectMimeType(makeData(), "shader.glsl");
    assert(mimeType.length > 0);
  },

  "MetadataEngine.extract tam sonuç döner": async () => {
    const eng  = new MetadataEngine();
    const meta = await eng.extract(makePngData(), "test.png");
    assertEqual(meta.format,    "png");
    assertEqual(meta.assetType, "texture");
    assert(meta.checksum.sha256.length > 0);
    assert(meta.size > 0);
  },

  "checkSize: sınır kontrolü": () => {
    const eng = new MetadataEngine();
    assert(eng.checkSize(1024));              // 1 KB
    assert(eng.checkSize(512 * 1024 * 1024)); // tam 512 MB
    assert(!eng.checkSize(0));                // sıfır
    assert(!eng.checkSize(512 * 1024 * 1024 + 1)); // aşıldı
  },

  "isDuplicate": async () => {
    const eng = new MetadataEngine();
    const d   = makeData("dup");
    const c1  = await computeChecksum(d);
    const c2  = await computeChecksum(d);
    assert(eng.isDuplicate(c1, c2));
    const c3  = await computeChecksum(makeData("different"));
    assert(!eng.isDuplicate(c1, c3));
  },
});

// ─── Dependency Graph Testleri ────────────────────────────────────────────────

await runSuite("dependency-graph", {
  "bağımlılık ekleme": () => {
    const g = new DependencyGraph();
    const r = g.addDependency({ sourceId: "a", targetId: "b", type: "uses", addedAt: new Date() });
    assert(r.ok);
    assert(g.directDependencies("a").includes("b"));
  },

  "döngüsel bağımlılık reddedilir": () => {
    const g = new DependencyGraph();
    g.addDependency({ sourceId: "a", targetId: "b", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "b", targetId: "c", type: "uses", addedAt: new Date() });
    const r = g.addDependency({ sourceId: "c", targetId: "a", type: "uses", addedAt: new Date() });
    assert(!r.ok, "c→a→b→c döngüsü reddedilmeli");
    assert(r.cycle !== undefined, "Döngü listesi dönmeli");
  },

  "kendine bağımlılık reddedilir": () => {
    const g = new DependencyGraph();
    const r = g.addDependency({ sourceId: "a", targetId: "a", type: "uses", addedAt: new Date() });
    assert(!r.ok);
  },

  "geçişli bağımlılıklar": () => {
    const g = new DependencyGraph();
    g.addDependency({ sourceId: "a", targetId: "b", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "b", targetId: "c", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "c", targetId: "d", type: "uses", addedAt: new Date() });
    const all = g.allDependencies("a");
    assert(all.has("b") && all.has("c") && all.has("d"));
  },

  "yol bulma (BFS en kısa)": () => {
    const g = new DependencyGraph();
    g.addDependency({ sourceId: "scene", targetId: "mesh",    type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "mesh",  targetId: "texture", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "texture", targetId: "shader", type: "uses", addedAt: new Date() });

    const path = g.findPath("scene", "shader");
    assert(path !== null, "Yol bulunmalı");
    assertEqual(path!.path[0], "scene");
    assertEqual(path!.path[path!.path.length - 1], "shader");
  },

  "bağımlılar (dependents)": () => {
    const g = new DependencyGraph();
    g.addDependency({ sourceId: "a", targetId: "shared", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "b", targetId: "shared", type: "uses", addedAt: new Date() });
    const deps = g.directDependents("shared");
    assert(deps.includes("a") && deps.includes("b"));
  },

  "istatistikler": () => {
    const g = new DependencyGraph();
    g.addDependency({ sourceId: "x", targetId: "y", type: "uses", addedAt: new Date() });
    g.addDependency({ sourceId: "y", targetId: "z", type: "uses", addedAt: new Date() });
    const stats = g.stats();
    assertEqual(stats.edges, 2);
    assertEqual(stats.nodes, 3);
  },
});

// ─── Repository Testleri ──────────────────────────────────────────────────────

await runSuite("repository", {
  "create + findById": async () => {
    const repo  = new InMemoryAssetRepository();
    const asset = await repo.create({
      ownerId: OWNER, type: "3d_model", format: "stl",
      title: "Test Model", description: "Açıklama",
      tags: ["3D", "STL"], license: "MIT", status: "active",
      versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
    });
    assert(asset.assetId.startsWith("ast_"));
    const found = await repo.findById(asset.assetId);
    assert(found !== null);
    assertEqual(found!.title, "Test Model");
  },

  "findByChecksum (duplicate detection)": async () => {
    const repo     = new InMemoryAssetRepository();
    const eng      = new MetadataEngine();
    const data     = makeData("unique content for checksum");
    const meta     = await eng.extract(data, "file.stl");
    const versionId = "ver_test";
    const file = {
      storageKey: "k", fileName: "f.stl", mimeType: "model/stl",
      size: 10, checksum: meta.checksum, uploadedAt: new Date(),
    };
    await repo.create({
      ownerId: OWNER, type: "3d_model", format: "stl",
      title: "Dup Test", description: "", tags: [], license: "MIT",
      status: "active",
      versions: [{ versionId, assetId: "ast_x", versionStr: "1.0.0",
        files: [file], changeLog: "", uploadedBy: OWNER, uploadedAt: new Date(), deprecated: false }],
      latestVersion: versionId, downloadCount: 0, referenceCount: 0,
    });

    const found = await repo.findByChecksum(meta.checksum.sha256);
    assert(found !== null, "Checksum ile asset bulunmalı");
  },

  "search: type filtresi": async () => {
    const repo = new InMemoryAssetRepository();
    await repo.create({
      ownerId: OWNER, type: "texture", format: "png",
      title: "Texture 1", description: "", tags: [], license: "CC0-1.0",
      status: "active", versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
    });
    await repo.create({
      ownerId: OWNER, type: "3d_model", format: "stl",
      title: "Model 1", description: "", tags: [], license: "MIT",
      status: "active", versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
    });

    const { assets: textures } = await repo.search({ type: "texture" });
    assertEqual(textures.length, 1);
    assertEqual(textures[0].type, "texture");
  },

  "search: term filtresi": async () => {
    const repo = new InMemoryAssetRepository();
    await repo.create({
      ownerId: OWNER, type: "shader", format: "glsl",
      title: "Water Shader", description: "Gerçekçi su efekti",
      tags: ["shader"], license: "MIT",
      status: "active", versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
    });
    const { assets } = await repo.search({ term: "water" });
    assert(assets.length > 0);
    assert(assets[0].title.toLowerCase().includes("water"));
  },

  "incrementDownload": async () => {
    const repo  = new InMemoryAssetRepository();
    const asset = await repo.create({
      ownerId: OWNER, type: "font", format: "ttf",
      title: "Free Font", description: "", tags: [], license: "OFL",
      status: "active", versions: [], latestVersion: "",
      downloadCount: 0, referenceCount: 0,
    });
    await repo.incrementDownload(asset.assetId);
    await repo.incrementDownload(asset.assetId);
    const found = await repo.findById(asset.assetId);
    assertEqual(found?.downloadCount, 2);
  },
});

// ─── Asset Service Testleri ───────────────────────────────────────────────────

await runSuite("asset-service/upload", {
  "başarılı yükleme": async () => {
    const svc = makeService();
    const r   = await svc.upload({
      ownerId: OWNER, title: "Test STL", description: "Bir test modeli",
      tags: ["test", "STL"], license: "MIT", fileName: "model.stl",
      data: makeStlData(),
    });
    assert(r.ok, `Yükleme başarısız: ${!r.ok ? r.message : ""}`);
    if (r.ok) {
      assert(r.data.assetId.startsWith("ast_"));
      assertEqual(r.data.format, "stl");
      assertEqual(r.data.type, "3d_model");
      assertEqual(r.data.license, "MIT");
      assertEqual(r.data.versions.length, 1);
    }
  },

  "duplicate detection: aynı içerik → aynı asset": async () => {
    const svc  = makeService();
    const data = makeData("exact same content here");

    const r1 = await svc.upload({
      ownerId: OWNER, title: "Original", description: "İlk",
      tags: [], license: "MIT", fileName: "f.txt", data,
    });
    assert(r1.ok);
    if (!r1.ok) return;

    const r2 = await svc.upload({
      ownerId: OWNER, title: "Duplicate", description: "İkinci",
      tags: [], license: "GPL-3.0", fileName: "g.txt", data,
    });
    assert(r2.ok);
    if (!r2.ok) return;

    // Aynı assetId döner (duplicate tespit)
    assertEqual(r1.data.assetId, r2.data.assetId, "Duplicate: aynı asset ID dönmeli");
  },

  "büyük dosya → FILE_TOO_LARGE": async () => {
    const svc       = makeService();
    const hugeData  = new Uint8Array(512 * 1024 * 1024 + 1); // 512MB + 1
    const r         = await svc.upload({
      ownerId: OWNER, title: "Too Big", description: "D",
      tags: [], license: "MIT", fileName: "huge.bin", data: hugeData,
    });
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "FILE_TOO_LARGE");
  },

  "event yayınlanır": async () => {
    const bus    = new EventBus();
    const svc    = makeService(bus);
    let   fired  = false;
    bus.on("asset:created" as never, () => { fired = true; });
    await svc.upload({
      ownerId: OWNER, title: "Event Test", description: "D",
      tags: [], license: "MIT", fileName: "test.png", data: makePngData(),
    });
    assert(fired, "asset:created yayınlanmalı");
  },
});

await runSuite("asset-service/versioning", {
  "sürüm ekleme": async () => {
    const svc = makeService();
    const r1  = await svc.upload({
      ownerId: OWNER, title: "Versioned Asset", description: "D",
      tags: [], license: "MIT", fileName: "m.stl",
      data: makeData("version 1"),
    });
    assert(r1.ok);
    if (!r1.ok) return;

    const r2 = await svc.addVersion({
      assetId:    r1.data.assetId,
      requesterId: OWNER,
      versionStr: "2.0.0",
      fileName:   "m_v2.stl",
      data:       makeData("version 2 completely different"),
      changeLog:  "Büyük değişiklikler",
    });
    assert(r2.ok, `Sürüm eklenemedi: ${!r2.ok ? r2.message : ""}`);
    if (r2.ok) {
      assertEqual(r2.data.versions.length, 2);
      assertEqual(r2.data.latestVersion, r2.data.versions[1].versionId);
    }
  },

  "versiyon çakışması → VERSION_EXISTS": async () => {
    const svc = makeService();
    const r1  = await svc.upload({
      ownerId: OWNER, title: "V Test", description: "D",
      tags: [], license: "MIT", fileName: "f.obj", data: makeData("v1 content"),
      versionStr: "1.0.0",
    });
    assert(r1.ok);
    if (!r1.ok) return;

    const r2 = await svc.addVersion({
      assetId: r1.data.assetId, requesterId: OWNER,
      versionStr: "1.0.0", // aynı versiyon!
      fileName: "f2.obj", data: makeData("different content but same version"),
      changeLog: "Test",
    });
    assert(!r2.ok);
    if (!r2.ok) assertEqual(r2.code, "VERSION_EXISTS");
  },
});

await runSuite("asset-service/dependency", {
  "bağımlılık ekleme": async () => {
    const svc = makeService();
    const r   = await svc.addDependency({
      sourceId: "ast_a", targetId: "ast_b",
      type: "uses", addedAt: new Date(),
    });
    assert(r.ok);
    assert(svc.getDependencies("ast_a").includes("ast_b"));
  },

  "döngüsel bağımlılık reddedilir": async () => {
    const svc = makeService();
    await svc.addDependency({ sourceId: "x", targetId: "y", type: "uses", addedAt: new Date() });
    await svc.addDependency({ sourceId: "y", targetId: "z", type: "uses", addedAt: new Date() });
    const r = await svc.addDependency({ sourceId: "z", targetId: "x", type: "uses", addedAt: new Date() });
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "CIRCULAR_DEPENDENCY");
  },

  "lisans uyumsuzluğu reddedilir": async () => {
    const svc = makeService();
    const r   = await svc.addDependency(
      { sourceId: "p1", targetId: "p2", type: "bundles", addedAt: new Date() },
      "GPL-3.0",   // parent: copyleft
      "MIT"        // child: permissive → uyumsuz
    );
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "LICENSE_INCOMPATIBLE");
  },
});

await runSuite("asset-service/download", {
  "indirme çalışır": async () => {
    const svc  = makeService();
    const data = makeData("downloadable content");
    const r    = await svc.upload({
      ownerId: OWNER, title: "Downloadable", description: "D",
      tags: [], license: "MIT", fileName: "dl.stl", data,
    });
    assert(r.ok);
    if (!r.ok) return;

    const dl = await svc.download(r.data.assetId);
    assert(dl !== null);
    assertEqual(new TextDecoder().decode(dl!.data), "downloadable content");
    assertEqual(dl!.fileName, "dl.stl");
  },

  "Proprietary lisans → indirme engeli": async () => {
    const svc = makeService();
    const r   = await svc.upload({
      ownerId: OWNER, title: "Proprietary Asset", description: "D",
      tags: [], license: "Proprietary", fileName: "prop.bin",
      data: makeData("secret"),
    });
    assert(r.ok);
    if (!r.ok) return;

    const dl = await svc.download(r.data.assetId);
    assert(dl === null, "Proprietary dosya indirilememeli");
  },

  "indirme sayacı artar": async () => {
    const repo    = new InMemoryAssetRepository();
    const storage = new InMemoryStorageAdapter();
    const svc     = new AssetService(repo, storage);

    const r = await svc.upload({
      ownerId: OWNER, title: "Counter", description: "D",
      tags: [], license: "MIT", fileName: "c.txt", data: makeData("c"),
    });
    assert(r.ok);
    if (!r.ok) return;

    await svc.download(r.data.assetId);
    await svc.download(r.data.assetId);
    const found = await repo.findById(r.data.assetId);
    assertEqual(found?.downloadCount, 2);
  },
});

// ─── Lisans Politikası ────────────────────────────────────────────────────────

await runSuite("license-policy", {
  "MIT + MIT → uyumlu": () => {
    const r = checkLicenseCompatibility("MIT", "MIT");
    assert(r.compatible);
  },
  "MIT + GPL-3.0 → uyumlu (MIT geniş izin verir)": () => {
    const r = checkLicenseCompatibility("MIT", "GPL-3.0");
    assert(r.compatible);
  },
  "GPL-3.0 + MIT → UYUMSUZ (copyleft türevi de copyleft olmalı)": () => {
    const r = checkLicenseCompatibility("GPL-3.0", "MIT");
    assert(!r.compatible);
  },
  "CC0 + anything → uyumlu": () => {
    assert(checkLicenseCompatibility("CC0-1.0", "MIT").compatible);
    assert(checkLicenseCompatibility("CC0-1.0", "GPL-3.0").compatible);
  },
  "Proprietary → her zaman uyumsuz": () => {
    assert(!checkLicenseCompatibility("Proprietary", "MIT").compatible);
    assert(!checkLicenseCompatibility("MIT", "Proprietary").compatible);
  },
  "CC-BY-SA-4.0 + MIT → UYUMSUZ (copyleft)": () => {
    const r = checkLicenseCompatibility("CC-BY-SA-4.0", "MIT");
    assert(!r.compatible);
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "10.000 asset arama indeksi": async () => {
    const repo  = new InMemoryAssetRepository();
    const types = ["3d_model", "texture", "shader", "script", "audio"] as const;
    const licenses = ["MIT", "GPL-3.0", "CC0-1.0", "Apache-2.0"] as AssetLicenseType[];

    const start = Date.now();
    for (let i = 0; i < 10_000; i++) {
      await repo.create({
        ownerId: `dev_${i % 100}`,
        type: types[i % types.length],
        format: "stl", title: `Asset ${i}`,
        description: `Asset açıklaması ${i}`,
        tags: [`tag${i % 20}`, `cat${i % 5}`],
        license: licenses[i % licenses.length],
        status: "active", versions: [], latestVersion: "",
        downloadCount: i % 1000, referenceCount: i % 100,
      });
    }
    const insertMs = Date.now() - start;
    assert(insertMs < 10_000, `10.000 insert ${insertMs}ms (beklenen < 10s)`);
    console.log(`  → 10.000 asset insert: ${insertMs}ms`);

    // Arama
    const s1 = Date.now();
    const { total } = await repo.search({ type: "texture" });
    const searchMs = Date.now() - s1;
    assert(total > 0);
    assert(searchMs < 500, `Arama ${searchMs}ms (beklenen < 500ms)`);
    console.log(`  → type=texture arama: ${searchMs}ms, ${total} sonuç`);
  },

  "checksum hesaplama hızı": async () => {
    const data  = new Uint8Array(1024 * 1024); // 1 MB
    crypto.getRandomValues(data);
    const start = Date.now();
    const { computeChecksum: cs } = await import("../metadata/metadata-engine.ts");
    await cs(data);
    const ms = Date.now() - start;
    assert(ms < 1000, `1MB checksum ${ms}ms (beklenen < 1000ms)`);
    console.log(`  → 1MB SHA-256: ${ms}ms`);
  },

  "1.000 node dependency graph": () => {
    const g     = new DependencyGraph();
    const start = Date.now();
    for (let i = 0; i < 999; i++) {
      g.addDependency({
        sourceId: `a${i}`, targetId: `a${i + 1}`,
        type: "uses", addedAt: new Date(),
      });
    }
    const ms    = Date.now() - start;
    const stats = g.stats();
    assertEqual(stats.edges, 999);
    assert(ms < 500, `1000 node graph ${ms}ms (beklenen < 500ms)`);
    console.log(`  → 1000 dep ekleme: ${ms}ms`);
  },
});
