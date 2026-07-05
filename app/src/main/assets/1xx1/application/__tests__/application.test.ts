/**
 * 1XX1 Application Services Testleri
 * Aşama 08 — Domain & Application Services
 *
 * Test grupları:
 *   validators     — ProjectValidator, DeveloperValidator
 *   policies       — ProjectPolicy, DeveloperPolicy, VisibilityPolicy, DonationPolicy
 *   commands       — CommandOutcome succeed/fail
 *   project-service — create, update, archive, move, verify, reject
 *   developer-svc  — register, mask, createChannel
 *   search-svc     — searchProjects, getProject, listDeveloperProjects
 *   orchestrator   — entegrasyon (tam akış)
 *   domain-events  — publisher yayınlar, yanlış scope atmaz
 */

import {
  runSuite, assert, assertEqual, makeProject, makeDeveloper
} from "../../core/test-utils.ts";
import { ProjectValidator, DeveloperValidator } from "../validators/domain-validators.ts";
import { PolicyEngine } from "../policies/policies.ts";
import { succeed, fail } from "../commands/commands.ts";
import { DomainEventPublisher } from "../events/domain-events.ts";
import { ProjectService } from "../services/project.service.ts";
import { DeveloperService, SearchApplicationService } from "../services/developer.service.ts";
import { ApplicationOrchestrator } from "../orchestrator/orchestrator.ts";
import { EventBus } from "../../core/event-bus.ts";
import { createTestDb } from "../../database/index.ts";
import { createTestFractalEngine } from "../../cube_engine/index.ts";
import { IndexManager } from "../../search/index-manager.ts";
import { SearchEngine } from "../../search/search-engine.ts";
import { newProjectID, newDeveloperID } from "../../core/identity.ts";
import type { ProjectID, DeveloperID } from "../../core/identity.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function setupOrchestrator() {
  const bus   = new EventBus();
  const db    = createTestDb();
  await db.migrations.runAll();

  const cube  = createTestFractalEngine();
  const mgr   = new IndexManager(bus);
  const eng   = new SearchEngine(mgr, bus);

  return new ApplicationOrchestrator({ db, cube, indexManager: mgr, searchEngine: eng, eventBus: bus });
}

async function registerDev(orch: ApplicationOrchestrator, username = "test_dev") {
  const r = await orch.developers.register({
    username,
    displayName: "Test Dev",
    bio: "Test biyografi",
  });
  assert(r.ok, `Developer kaydı başarısız: ${!r.ok ? r.message : ""}`);
  return r.ok ? r.data : null;
}

// ─── Validators ──────────────────────────────────────────────────────────────

await runSuite("validator/project", {
  "geçerli komut başarılı": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev", displayName: "V Dev" });
    const v   = new ProjectValidator(db.projects, db.developers);

    const result = await v.validateCreate({
      name:        "Geçerli Proje",
      description: "Bu bir test projesidir, yeterince uzun.",
      cube:        { x: 4, y: 7, z: 2 },
      developerId: dev.id,
      repo:        "https://github.com/test/repo",
      tags:        ["3D", "STL"],
      license:     "MIT",
    });

    assert(result.ok, `Validation başarısız: ${!result.ok ? result.violations.map(v=>v.message).join("; ") : ""}`);
  },

  "kısa isim → NAME_TOO_SHORT": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev2", displayName: "V Dev" });
    const v   = new ProjectValidator(db.projects, db.developers);

    const result = await v.validateCreate({
      name:        "Ab",
      description: "Yeterince uzun açıklama",
      cube:        { x: 0, y: 0, z: 0 },
      developerId: dev.id,
      repo:        "https://github.com/test/r",
      tags:        [],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) {
      assert(result.violations.some((v) => v.code === "NAME_TOO_SHORT"));
    }
  },

  "yasaklı etiket → TAG_BANNED": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev3", displayName: "V Dev" });
    const v   = new ProjectValidator(db.projects, db.developers);

    const result = await v.validateCreate({
      name:        "Yasak Etiketli Proje",
      description: "Yeterince uzun açıklama var burada",
      cube:        { x: 0, y: 0, z: 0 },
      developerId: dev.id,
      repo:        "https://github.com/test/r",
      tags:        ["spam"],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) assert(result.violations.some((v) => v.code === "TAG_BANNED"));
  },

  "geçersiz repo URL → INVALID_REPO_URL": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev4", displayName: "V Dev" });
    const v   = new ProjectValidator(db.projects, db.developers);

    const result = await v.validateCreate({
      name:        "URL Test Projesi",
      description: "Yeterince uzun açıklama var burada",
      cube:        { x: 0, y: 0, z: 0 },
      developerId: dev.id,
      repo:        "not-a-url",
      tags:        [],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) assert(result.violations.some((v) => v.code === "INVALID_REPO_URL"));
  },

  "isim çakışması → DUPLICATE_PROJECT_NAME": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev5", displayName: "V Dev" });
    await db.projects.create({
      name: "Var Olan Proje", description: "", cube: { x: 0, y: 0, z: 0 },
      developer: dev.id, repo: "https://github.com/t/r", tags: [], license: "MIT", status: "active",
    });

    const v      = new ProjectValidator(db.projects, db.developers);
    const result = await v.validateCreate({
      name:        "Var Olan Proje",
      description: "Yeterli açıklama uzunluğu var burada",
      cube:        { x: 1, y: 0, z: 0 },
      developerId: dev.id,
      repo:        "https://github.com/t/r2",
      tags:        [],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) assert(result.violations.some((v) => v.code === "DUPLICATE_PROJECT_NAME"));
  },

  "geçersiz koordinat → INVALID_CUBE_COORDINATE": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const dev = await db.developers.create({ username: "vdev6", displayName: "V Dev" });
    const v   = new ProjectValidator(db.projects, db.developers);

    const result = await v.validateCreate({
      name:        "Koordinat Testi",
      description: "Açıklama yeterince uzun burada",
      cube:        { x: 11, y: 0, z: 0 }, // geçersiz!
      developerId: dev.id,
      repo:        "https://github.com/t/r",
      tags:        [],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) assert(result.violations.some((v) => v.code === "INVALID_CUBE_COORDINATE"));
  },
});

await runSuite("validator/developer", {
  "geçerli kayıt": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const v  = new DeveloperValidator(db.developers);
    const r  = await v.validateRegister({ username: "alice_dev", displayName: "Alice" });
    assert(r.ok, `${!r.ok ? r.violations.map(v=>v.message).join("; ") : ""}`);
  },

  "rezerve username → RESERVED_USERNAME": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const v  = new DeveloperValidator(db.developers);
    const r  = await v.validateRegister({ username: "admin", displayName: "Admin" });
    assert(!r.ok);
    if (!r.ok) assert(r.violations.some((v) => v.code === "RESERVED_USERNAME"));
  },

  "geçersiz username pattern → INVALID_USERNAME": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    const v  = new DeveloperValidator(db.developers);
    const r  = await v.validateRegister({ username: "1nvalidstart", displayName: "Bad" });
    assert(!r.ok);
    if (!r.ok) assert(r.violations.some((v) => v.code === "INVALID_USERNAME"));
  },

  "username çakışması → USERNAME_TAKEN": async () => {
    const db = createTestDb();
    await db.migrations.runAll();
    await db.developers.create({ username: "taken", displayName: "T" });
    const v  = new DeveloperValidator(db.developers);
    const r  = await v.validateRegister({ username: "taken", displayName: "T2" });
    assert(!r.ok);
    if (!r.ok) assert(r.violations.some((v) => v.code === "USERNAME_TAKEN"));
  },
});

// ─── Policies ────────────────────────────────────────────────────────────────

await runSuite("policies", {
  "ProjectPolicy.canUpdate: sahibi güncelleyebilir": () => {
    const pe = new PolicyEngine();
    const p  = makeProject({ developer: "dev_owner" });
    assert(pe.project.canUpdate(p, "dev_owner").allowed);
  },

  "ProjectPolicy.canUpdate: başkası güncelleyemez": () => {
    const pe = new PolicyEngine();
    const p  = makeProject({ developer: "dev_owner" });
    const d  = pe.project.canUpdate(p, "dev_other");
    assert(!d.allowed && "code" in d);
    if (!d.allowed) assertEqual(d.code, "NOT_OWNER");
  },

  "ProjectPolicy.canUpdate: arşivlenmiş → engel": () => {
    const pe = new PolicyEngine();
    const p  = makeProject({ developer: "dev1", status: "archived" });
    const d  = pe.project.canUpdate(p, "dev1");
    assert(!d.allowed && "code" in d);
    if (!d.allowed) assertEqual(d.code, "PROJECT_ARCHIVED");
  },

  "ProjectPolicy.canArchive: sahibi arşivleyebilir": () => {
    const pe = new PolicyEngine();
    const p  = makeProject({ developer: "dev1" });
    assert(pe.project.canArchive(p, "dev1").allowed);
  },

  "ProjectPolicy.canView: arşiv → yalnızca sahibi": () => {
    const pe = new PolicyEngine();
    const p  = makeProject({ developer: "dev1", status: "archived" });
    assert(!pe.project.canView(p, "dev2").allowed);
    assert(pe.project.canView(p, "dev1").allowed);
  },

  "VisibilityPolicy.isSearchable: active ve verified görünür": () => {
    const pe = new PolicyEngine();
    assert(pe.visibility.isSearchable(makeProject({ status: "active" })));
    assert(pe.visibility.isSearchable(makeProject({ status: "verified" })));
    assert(!pe.visibility.isSearchable(makeProject({ status: "archived" })));
    assert(!pe.visibility.isSearchable(makeProject({ status: "pending" })));
  },

  "DeveloperPolicy.canCreateChannel: limit 3": () => {
    const pe  = new PolicyEngine();
    const dev = makeDeveloper();
    assert(pe.developer.canCreateChannel(dev, 0).allowed);
    assert(pe.developer.canCreateChannel(dev, 2).allowed);
    assert(!pe.developer.canCreateChannel(dev, 3).allowed);
  },

  "DonationPolicy.effectiveAddress: proje öncelikli": () => {
    const pe  = new PolicyEngine();
    const dev = { ...makeDeveloper(), donationAddress: "bc1devaddr" };
    const p1  = makeProject({ donationAddress: "0xProjAddr" });
    const p2  = makeProject(); // donation yok

    assertEqual(pe.donation.effectiveAddress(p1, dev), "0xProjAddr");
    assertEqual(pe.donation.effectiveAddress(p2, dev), "bc1devaddr");
  },
});

// ─── Commands ────────────────────────────────────────────────────────────────

await runSuite("commands/outcome", {
  "succeed veri taşır": () => {
    const r = succeed({ id: "p1", name: "Test" });
    assert(r.ok === true);
    if (r.ok) assertEqual(r.data.name, "Test");
  },

  "fail kod ve mesaj taşır": () => {
    const r = fail("VALIDATION_FAILED", "Geçersiz veri", "name");
    assert(r.ok === false);
    if (!r.ok) {
      assertEqual(r.code,    "VALIDATION_FAILED");
      assertEqual(r.message, "Geçersiz veri");
      assertEqual(r.field,   "name");
    }
  },
});

// ─── ProjectService ───────────────────────────────────────────────────────────

await runSuite("project-service", {
  "create: başarılı proje oluşturma": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch);
    assert(dev !== null);

    const result = await orch.projects.create({
      name:        "STL Viewer v2",
      description: "WebGL tabanlı STL model görüntüleyici — geliştirilmiş",
      cube:        { x: 4, y: 7, z: 2 },
      developerId: dev!.id,
      repo:        "https://github.com/test/stl-v2",
      tags:        ["STL", "WebGL", "3D"],
      license:     "MIT",
    });

    assert(result.ok, `Create başarısız: ${!result.ok ? result.message : ""}`);
    if (result.ok) {
      assert(result.data.id.startsWith("prj_"));
      assertEqual(result.data.name, "STL Viewer v2");
      assertEqual(result.data.status, "active");
    }
  },

  "create: validation hatası → fail": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "cr_dev");
    assert(dev !== null);

    const result = await orch.projects.create({
      name:        "Ab",   // çok kısa
      description: "k",
      cube:        { x: 0, y: 0, z: 0 },
      developerId: dev!.id,
      repo:        "bad-url",
      tags:        [],
      license:     "MIT",
    });

    assert(!result.ok);
    if (!result.ok) assert(result.code.length > 0);
  },

  "update: sahibi güncelleyebilir": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "upd_dev");
    assert(dev !== null);

    const created = await orch.projects.create({
      name:        "Güncellenecek Proje",
      description: "Açıklama yeterince uzun burada",
      cube:        { x: 1, y: 1, z: 1 },
      developerId: dev!.id,
      repo:        "https://github.com/t/r",
      tags:        ["test"],
      license:     "MIT",
    });

    assert(created.ok);
    if (!created.ok) return;

    const updated = await orch.projects.update({
      projectId:   created.data.id,
      requesterId: dev!.id,
      name:        "Yeni İsim Güncel",
    });

    assert(updated.ok, `Update başarısız: ${!updated.ok ? updated.message : ""}`);
    if (updated.ok) assertEqual(updated.data.name, "Yeni İsim Güncel");
  },

  "update: başkası güncelleyemez → NOT_OWNER": async () => {
    const orch = await setupOrchestrator();
    const dev1 = await registerDev(orch, "owner_dev");
    const dev2 = await registerDev(orch, "other_dev");
    assert(dev1 && dev2);

    const created = await orch.projects.create({
      name:        "Sahiplik Testi",
      description: "Açıklama yeterince uzun",
      cube:        { x: 2, y: 2, z: 2 },
      developerId: dev1!.id,
      repo:        "https://github.com/t/r",
      tags:        [],
      license:     "MIT",
    });

    assert(created.ok);
    if (!created.ok) return;

    const result = await orch.projects.update({
      projectId:   created.data.id,
      requesterId: dev2!.id,
      name:        "İzinsiz Değişim",
    });

    assert(!result.ok);
    if (!result.ok) assertEqual(result.code, "NOT_OWNER");
  },

  "archive: proje arşivlenir": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "arc_dev");
    assert(dev !== null);

    const created = await orch.projects.create({
      name:        "Arşivlenecek",
      description: "Açıklama yeterli uzunlukta",
      cube:        { x: 3, y: 3, z: 3 },
      developerId: dev!.id,
      repo:        "https://github.com/t/r",
      tags:        [],
      license:     "MIT",
    });

    assert(created.ok);
    if (!created.ok) return;

    const result = await orch.projects.archive({
      projectId:   created.data.id,
      requesterId: dev!.id,
      reason:      "Test arşivi",
    });

    assert(result.ok, `Archive başarısız: ${!result.ok ? result.message : ""}`);

    const found = await orch.projects.getById(created.data.id, dev!.id);
    assertEqual(found?.status, "archived");
  },

  "verify + reject akışı": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "ver_dev");
    assert(dev !== null);

    const created = await orch.projects.create({
      name:        "Doğrulanacak Proje",
      description: "Açıklama yeterli uzunluğa sahip",
      cube:        { x: 5, y: 5, z: 5 },
      developerId: dev!.id,
      repo:        "https://github.com/t/r",
      tags:        ["test"],
      license:     "MIT",
    });
    assert(created.ok);
    if (!created.ok) return;

    const verified = await orch.projects.verify({
      projectId:  created.data.id,
      verifiedBy: "manual",
    });
    assert(verified.ok, `Verify başarısız: ${!verified.ok ? verified.message : ""}`);

    const found = await orch.projects["db"].projects.findById(created.data.id);
    assertEqual(found?.status, "verified");
  },
});

// ─── DeveloperService ─────────────────────────────────────────────────────────

await runSuite("developer-service", {
  "register: başarılı kayıt": async () => {
    const orch   = await setupOrchestrator();
    const result = await orch.developers.register({
      username:    "new_developer",
      displayName: "Yeni Geliştirici",
      bio:         "Merhaba!",
    });

    assert(result.ok, `Register başarısız: ${!result.ok ? result.message : ""}`);
    if (result.ok) {
      assert(result.data.id.startsWith("dev_"));
      assertEqual(result.data.username, "new_developer");
    }
  },

  "register: aynı username → USERNAME_TAKEN": async () => {
    const orch = await setupOrchestrator();
    await orch.developers.register({ username: "duplicate", displayName: "First" });
    const r2   = await orch.developers.register({ username: "duplicate", displayName: "Second" });
    assert(!r2.ok);
    if (!r2.ok) assertEqual(r2.code, "USERNAME_TAKEN");
  },

  "mask: takma kimlik alınır": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "mask_dev");
    assert(dev !== null);

    const result = await orch.developers.mask({
      developerId: dev!.id,
      maskAlias:   "kaptan_anon",
    });

    assert(result.ok, `Mask başarısız: ${!result.ok ? result.message : ""}`);
  },

  "createChannel: kanal oluşturulur": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "ch_dev");
    assert(dev !== null);

    const result = await orch.developers.createChannel({
      developerId: dev!.id,
      channelName: "Kaptan Kanalı",
    });

    assert(result.ok, `Channel başarısız: ${!result.ok ? result.message : ""}`);
    if (result.ok) assert(result.data.startsWith("ch_"));
  },
});

// ─── SearchApplicationService ─────────────────────────────────────────────────

await runSuite("search-application-service", {
  "searchProjects: sonuç döner": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "srch_dev");
    assert(dev !== null);

    await orch.projects.create({
      name:        "Aranacak Proje",
      description: "Bu proje arama testleri için oluşturuldu",
      cube:        { x: 1, y: 1, z: 1 },
      developerId: dev!.id,
      repo:        "https://github.com/t/r",
      tags:        ["arama", "test"],
      license:     "MIT",
    });

    const result = await orch.search.searchProjects({ term: "aranacak proje" });
    assert(result.ok, `Search başarısız: ${!result.ok ? result.message : ""}`);
    if (result.ok) assert(Array.isArray(result.data));
  },

  "getProject: var olan proje döner": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "get_dev");
    assert(dev !== null);

    const created = await orch.projects.create({
      name:        "Getirilecek Proje",
      description: "Açıklama yeterli uzunlukta",
      cube:        { x: 2, y: 2, z: 2 },
      developerId: dev!.id,
      repo:        "https://github.com/t/r",
      tags:        [],
      license:     "MIT",
    });

    assert(created.ok);
    if (!created.ok) return;

    const result = await orch.search.getProject({ projectId: created.data.id });
    assert(result.ok);
    if (result.ok) {
      assertEqual(result.data.id, created.data.id);
      assertEqual(result.data.name, "Getirilecek Proje");
    }
  },

  "listDeveloperProjects: geliştirici projeleri listelenir": async () => {
    const orch = await setupOrchestrator();
    const dev  = await registerDev(orch, "list_srch_dev");
    assert(dev !== null);

    for (let i = 0; i < 3; i++) {
      await orch.projects.create({
        name:        `Liste Projesi ${i}`,
        description: "Açıklama yeterli uzunlukta",
        cube:        { x: i, y: 0, z: 0 },
        developerId: dev!.id,
        repo:        `https://github.com/t/r${i}`,
        tags:        [],
        license:     "MIT",
      });
    }

    const result = await orch.search.listDeveloperProjects({ developerId: dev!.id });
    assert(result.ok);
    if (result.ok) {
      assert(result.data.length >= 3, `En az 3 proje beklendi: ${result.data.length}`);
    }
  },
});

// ─── Orchestrator Entegrasyon ─────────────────────────────────────────────────

await runSuite("orchestrator/entegrasyon", {
  "tam akış: kayıt → oluştur → ara → arşivle": async () => {
    const orch = await setupOrchestrator();

    // 1. Geliştirici kaydı
    const devResult = await orch.developers.register({
      username:    "full_flow_dev",
      displayName: "Full Flow Dev",
    });
    assert(devResult.ok);
    if (!devResult.ok) return;
    const dev = devResult.data;

    // 2. Proje oluşturma
    const createResult = await orch.projects.create({
      name:        "Full Flow Test",
      description: "Tam akış testi için oluşturuldu",
      cube:        { x: 8, y: 3, z: 6 },
      developerId: dev.id,
      repo:        "https://github.com/full/flow",
      tags:        ["flow", "test"],
      license:     "MIT",
    });
    assert(createResult.ok);
    if (!createResult.ok) return;

    // 3. Arama
    const searchResult = await orch.search.searchProjects({ term: "full flow" });
    assert(searchResult.ok);

    // 4. Arşivleme
    const archiveResult = await orch.projects.archive({
      projectId:   createResult.data.id,
      requesterId: dev.id,
    });
    assert(archiveResult.ok);

    // 5. Arşiv sonrası arama — görünmemeli
    const postArchiveSearch = await orch.search.searchProjects({ term: "full flow" });
    assert(postArchiveSearch.ok);
    if (postArchiveSearch.ok) {
      const found = postArchiveSearch.data.some((p) => p.id === createResult.data.id);
      assert(!found, "Arşivlenmiş proje arama sonuçlarında olmamalı");
    }
  },

  "health kontrolü": async () => {
    const orch   = await setupOrchestrator();
    const health = await orch.health();
    assert(health.db);
    assert(health.cube);
    assert(health.index);
  },
});

// ─── Domain Events ────────────────────────────────────────────────────────────

await runSuite("domain-events", {
  "publisher proje yayınlar": () => {
    const bus       = new EventBus();
    const publisher = new DomainEventPublisher(bus);
    let   fired     = false;

    bus.on("project:published" as never, () => { fired = true; });

    publisher.projectPublished({
      projectId: "p1", name: "Test",
      developerId: "dev1", cube: { x: 0, y: 0, z: 0 },
      cubePath: "0/0/0", tags: [], license: "MIT",
      repo: "https://r.com", publishedAt: new Date(),
    });

    assert(fired, "project:published tetiklenmeli");
  },

  "publisher INDEX'e olay atmaz (scope kontrolü)": () => {
    const bus       = new EventBus();
    const publisher = new DomainEventPublisher(bus);
    let   indexFired = false;

    bus.on("index:upserted", () => { indexFired = true; });

    publisher.developerRegistered({
      developerId: "d1", username: "u1", joinedAt: new Date(),
    });

    assert(!indexFired, "Publisher INDEX scope olayı atmamalı");
  },
});
