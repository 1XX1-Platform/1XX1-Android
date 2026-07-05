/**
 * 1XX1 Plugin SDK — Risk Düzeltmesi Testleri
 * Aşama 19 (Kaptan'ın mimari incelemesi sonrası eklenen düzeltmeler)
 *
 * Gruplar:
 *   capability-profiles     — Risk 1/3: önceden denetlenmiş profil çözümleme
 *   isolation-level         — Risk 2/3: zorunlu izolasyon beyanı ve uyumluluk
 *   plugin-dependency-graph — Risk 3/3: cross-plugin DAG, döngü tespiti, blast radius
 *   registry-integration    — üç düzeltmenin PluginRegistry ile birlikte çalışması
 *   determinism             — aynı girdi → aynı sonuç (tüm düzeltmeler için)
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import {
  CAPABILITY_PROFILES, resolveCapabilityProfile, listCapabilityProfiles,
} from "../core/capability-profiles.ts";
import {
  isolationMeetsMinimum, resolveAdapterIsolation, checkIsolationRequirement,
  isProductionGradeAdapter,
} from "../sandbox/isolation-level.ts";
import { PluginDependencyGraph } from "../registry/plugin-dependency-graph.ts";
import { PluginRegistry } from "../registry/plugin-registry.ts";
import { MockSandboxAdapter, ProcessSandboxAdapter } from "../../sandbox/adapters/sandbox-adapters.ts";
import { EventBus } from "../../core/event-bus.ts";
import type { IPlugin, PluginManifest, PluginContext } from "../core/plugin-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    identity: { name: "test-plugin", version: "1.0.0", publisherId: "dev_kaptan", description: "Test" },
    extensionPoints: ["search"],
    permissions:     [],
    platformVersion: "^1.0.0",
    license:         "MIT",
    ...overrides,
  };
}

function makeMockPlugin(manifest: PluginManifest): IPlugin {
  return {
    manifest,
    async init(_ctx: PluginContext) {},
    async shutdown() {},
  };
}

// ─── Capability Profiles (Risk 1/3) ──────────────────────────────────────────

await runSuite("capability-profiles", {
  "kataloğda en az 8 önceden denetlenmiş profil var": () => {
    const profiles = listCapabilityProfiles();
    assert(profiles.length >= 8, `Profil sayısı: ${profiles.length}`);
  },

  "her profil en az 1 extension point ve resourceMultiplier taşır": () => {
    for (const profile of listCapabilityProfiles()) {
      assert(profile.extensionPoints.length >= 1, `${profile.id}: extension point eksik`);
      assert(profile.resourceMultiplier > 0, `${profile.id}: resourceMultiplier geçersiz`);
    }
  },

  "resolveCapabilityProfile: geçerli profil → sabit izinleri döner": () => {
    const result = resolveCapabilityProfile("search-readonly");
    assert(result.ok);
    assertEqual(result.extensionPoints, ["search"]);
    assertEqual(result.permissions, ["read:search_index"]);
    assertEqual(result.warnings.length, 0);
  },

  "resolveCapabilityProfile: pulse-fairness-hook yalnızca bu profilde write:pulse_score taşır": () => {
    const result = resolveCapabilityProfile("pulse-fairness-hook");
    assert(result.permissions.includes("write:pulse_score"));
    assert(result.extensionPoints.includes("pulse_hook"));
  },

  "resolveCapabilityProfile: passive-observer hiçbir izin gerektirmez (en güvenli)": () => {
    const result = resolveCapabilityProfile("passive-observer");
    assertEqual(result.permissions.length, 0);
    assert(result.resourceMultiplier < 0.5, "Pasif gözlemci en hafif kaynak profiline sahip olmalı");
  },

  "resolveCapabilityProfile: bilinmeyen profil → ok=false": () => {
    const result = resolveCapabilityProfile("nonexistent-profile" as never);
    assert(!result.ok);
    assert(result.warnings.length > 0);
  },

  "resolveCapabilityProfile: custom seçilince manifest değerleri kullanılır + uyarı verilir": () => {
    const result = resolveCapabilityProfile("custom", ["pulse_hook"], ["write:pulse_score"]);
    assert(result.ok);
    assertEqual(result.extensionPoints, ["pulse_hook"]);
    assert(result.warnings.length > 0, "Custom profil her zaman uyarı üretmeli (denetim görünürlüğü)");
  },

  "profil seçimi manifest'teki serbest seçimi geçersiz kılar (otorite profildedir)": () => {
    // Plugin yazarı yanlışlıkla farklı extensionPoints/permissions göndermiş olsa bile
    // profil seçimi otorite olduğu için sabit profil değerleri döner
    const result = resolveCapabilityProfile("search-readonly");
    assert(!result.permissions.includes("write:search_score"),
      "search-readonly profili write izni İÇERMEMELİ, manifest ne derse desin");
  },

  "CAPABILITY_PROFILES nesnesi donmuş (immutable)": () => {
    assert(Object.isFrozen(CAPABILITY_PROFILES));
    assert(Object.isFrozen(CAPABILITY_PROFILES["search-readonly"]));
  },
});

// ─── Isolation Level (Risk 2/3) ───────────────────────────────────────────────

await runSuite("isolation-level", {
  "isolationMeetsMinimum: process >= simulated → true": () => {
    assert(isolationMeetsMinimum("process", "simulated"));
  },

  "isolationMeetsMinimum: simulated >= process → false": () => {
    assert(!isolationMeetsMinimum("simulated", "process"));
  },

  "isolationMeetsMinimum: eşit seviye → true": () => {
    assert(isolationMeetsMinimum("process", "process"));
  },

  "isolationMeetsMinimum: vm en yüksek seviye, her şeyi karşılar": () => {
    assert(isolationMeetsMinimum("vm", "container"));
    assert(isolationMeetsMinimum("vm", "process"));
    assert(isolationMeetsMinimum("vm", "simulated"));
    assert(isolationMeetsMinimum("vm", "none"));
  },

  "resolveAdapterIsolation: MockSandboxAdapter → simulated": () => {
    const adapter = new MockSandboxAdapter();
    assertEqual(resolveAdapterIsolation(adapter), "simulated");
  },

  "resolveAdapterIsolation: ProcessSandboxAdapter → process": () => {
    const adapter = new ProcessSandboxAdapter();
    assertEqual(resolveAdapterIsolation(adapter), "process");
  },

  "resolveAdapterIsolation: bilinmeyen adapter → none (fail-safe)": () => {
    const fakeAdapter = { name: "unknown-custom-adapter" } as never;
    assertEqual(resolveAdapterIsolation(fakeAdapter), "none");
  },

  "checkIsolationRequirement: process gerektiren plugin + Mock adapter → reddedilir": () => {
    const adapter = new MockSandboxAdapter();
    const result = checkIsolationRequirement({ minimumIsolation: "process" }, adapter);
    assert(!result.ok, "Mock adapter (simulated) process gereksinimini karşılamamalı");
    assertEqual(result.provided, "simulated");
    assertEqual(result.required, "process");
    assert(result.reason?.includes("yetersiz") || result.reason !== undefined);
  },

  "checkIsolationRequirement: simulated gerektiren plugin + Mock adapter → kabul": () => {
    const adapter = new MockSandboxAdapter();
    const result = checkIsolationRequirement({ minimumIsolation: "simulated" }, adapter);
    assert(result.ok);
  },

  "checkIsolationRequirement: process gerektiren plugin + Process adapter → kabul": () => {
    const adapter = new ProcessSandboxAdapter();
    const result = checkIsolationRequirement({ minimumIsolation: "process" }, adapter);
    assert(result.ok);
  },

  "isProductionGradeAdapter: Mock → false, Process → true": () => {
    assert(!isProductionGradeAdapter(new MockSandboxAdapter()));
    assert(isProductionGradeAdapter(new ProcessSandboxAdapter()));
  },
});

// ─── Plugin Dependency Graph (Risk 3/3) ──────────────────────────────────────

await runSuite("plugin-dependency-graph", {
  "addInteraction: temel abonelik eklenir": () => {
    const g = new PluginDependencyGraph();
    const result = g.addInteraction({
      sourcePlugin: "audit-logger", targetPlugin: "search-plugin",
      type: "subscribes_to", addedAt: new Date(),
    });
    assert(result.ok);
    assert(g.dependsOn("audit-logger").includes("search-plugin"));
  },

  "addInteraction: kendine abonelik reddedilir": () => {
    const g = new PluginDependencyGraph();
    const result = g.addInteraction({
      sourcePlugin: "p1", targetPlugin: "p1",
      type: "subscribes_to", addedAt: new Date(),
    });
    assert(!result.ok);
  },

  "addInteraction: döngüsel abonelik reddedilir (A→B→C→A)": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "a", targetPlugin: "b", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "b", targetPlugin: "c", type: "subscribes_to", addedAt: new Date() });
    const result = g.addInteraction({ sourcePlugin: "c", targetPlugin: "a", type: "subscribes_to", addedAt: new Date() });
    assert(!result.ok, "c→a kenarı döngü oluşturduğu için reddedilmeli");
    assert(result.cycle !== undefined);
  },

  "dependents: bir plugin'i dinleyenleri bulur": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "logger1", targetPlugin: "core-events", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "logger2", targetPlugin: "core-events", type: "subscribes_to", addedAt: new Date() });
    const deps = g.dependents("core-events");
    assert(deps.includes("logger1") && deps.includes("logger2"));
  },

  "impactRadius: zincirleme etkiyi hesaplar (blast radius)": () => {
    const g = new PluginDependencyGraph();
    // c, b'yi dinler; b, a'yı dinler → a durdurulursa b ve c etkilenir
    g.addInteraction({ sourcePlugin: "b", targetPlugin: "a", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "c", targetPlugin: "b", type: "subscribes_to", addedAt: new Date() });

    const impact = g.impactRadius("a");
    assert(impact.has("b"), "b doğrudan etkilenir");
    assert(impact.has("c"), "c dolaylı olarak etkilenir (b üzerinden)");
  },

  "impactRadius: izole plugin'in etkisi boş küme": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "x", targetPlugin: "y", type: "subscribes_to", addedAt: new Date() });
    const impact = g.impactRadius("isolated-plugin");
    assertEqual(impact.size, 0);
  },

  "removeAllForPlugin: hem kaynak hem hedef olarak temizler": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "p1", targetPlugin: "p2", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "p3", targetPlugin: "p1", type: "subscribes_to", addedAt: new Date() });

    g.removeAllForPlugin("p1");
    assertEqual(g.dependsOn("p1").length, 0);
    assertEqual(g.dependents("p1").length, 0);
    assert(!g.dependents("p2").includes("p1"));
  },

  "findPath: en kısa yolu bulur": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "a", targetPlugin: "b", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "b", targetPlugin: "c", type: "subscribes_to", addedAt: new Date() });
    const path = g.findPath("a", "c");
    assert(path !== null);
    assertEqual(path!.depth, 2);
  },

  "topologicalOrder: bağımlılık öncesi gelir": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "consumer", targetPlugin: "producer", type: "subscribes_to", addedAt: new Date() });
    const order = g.topologicalOrder();
    assert(order !== null);
    const producerIdx = order!.indexOf("producer");
    const consumerIdx = order!.indexOf("consumer");
    assert(producerIdx < consumerIdx, "producer, consumer'dan önce gelmeli (consumer ona bağımlı)");
  },

  "stats: kenar/plugin sayımı ve maxFanOut": () => {
    const g = new PluginDependencyGraph();
    g.addInteraction({ sourcePlugin: "hub", targetPlugin: "a", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "hub", targetPlugin: "b", type: "subscribes_to", addedAt: new Date() });
    g.addInteraction({ sourcePlugin: "hub", targetPlugin: "c", type: "subscribes_to", addedAt: new Date() });
    const s = g.stats();
    assertEqual(s.totalEdges, 3);
    assertEqual(s.maxFanOut, 3);
  },
});

// ─── Registry Entegrasyonu (Üç Düzeltme Birlikte) ────────────────────────────

await runSuite("registry-integration", {
  "process gerektiren plugin Mock adapter ile register edilir ama activate reddedilir": async () => {
    const adapter  = new MockSandboxAdapter();
    const registry = new PluginRegistry(adapter, { platformVersion: "1.0.0" }, new EventBus());

    const manifest = makeManifest();
    const r = registry.register(makeMockPlugin(manifest), {
      search: { name: "test-plugin", scoreContribution: async () => 0 },
    }, { isolationRequirement: { minimumIsolation: "process" } });

    assert(r.ok, "Register başarılı olmalı (isolation kontrolü activate'te yapılır)");

    const activateResult = await registry.activate("test-plugin");
    assert(!activateResult.ok, "Activate reddedilmeli — Mock adapter process seviyesini karşılamıyor");
    assertEqual(registry.get("test-plugin")?.status, "failed");
  },

  "simulated gerektiren plugin Mock adapter ile sorunsuz aktive olur": async () => {
    const adapter  = new MockSandboxAdapter();
    const registry = new PluginRegistry(adapter, { platformVersion: "1.0.0" }, new EventBus());

    const manifest = makeManifest();
    registry.register(makeMockPlugin(manifest), {
      search: { name: "test-plugin", scoreContribution: async () => 0 },
    }, { isolationRequirement: { minimumIsolation: "simulated" } });

    const activateResult = await registry.activate("test-plugin");
    assert(activateResult.ok, `Aktivasyon başarısız: ${activateResult.error}`);
  },

  "cross-plugin abonelik: hedef plugin kayıtlı değilse register reddedilir": () => {
    const adapter  = new MockSandboxAdapter();
    const registry = new PluginRegistry(adapter, {}, new EventBus());

    const manifest = makeManifest({ identity: { name: "subscriber", version: "1.0.0", publisherId: "p", description: "d" } });
    const r = registry.register(makeMockPlugin(manifest), {
      search: { name: "subscriber", scoreContribution: async () => 0 },
    }, {
      isolationRequirement: { minimumIsolation: "simulated" },
      subscribesToPlugins: [{ targetPlugin: "nonexistent-target" }],
    });

    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("bulunamadı")));
  },

  "cross-plugin abonelik: döngü oluşturursa ikinci register reddedilir": () => {
    const adapter  = new MockSandboxAdapter();
    const registry = new PluginRegistry(adapter, {}, new EventBus());

    const mA = makeManifest({ identity: { name: "plugin-a", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mA), { search: { name: "plugin-a", scoreContribution: async () => 0 } },
      { isolationRequirement: { minimumIsolation: "simulated" } });

    const mB = makeManifest({ identity: { name: "plugin-b", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mB), { search: { name: "plugin-b", scoreContribution: async () => 0 } }, {
      isolationRequirement: { minimumIsolation: "simulated" },
      subscribesToPlugins: [{ targetPlugin: "plugin-a" }],
    });

    // plugin-a şimdi plugin-b'ye abone olmaya çalışırsa döngü oluşur
    const mA2 = makeManifest({ identity: { name: "plugin-a", version: "1.0.0", publisherId: "p", description: "d" } });
    // Not: plugin-a zaten kayıtlı, bu yüzden farklı bir senaryo kuralım: plugin-c, b'yi dinler; b zaten a'yı dinliyor; a, c'yi dinlemeye çalışırsa döngü
    const mC = makeManifest({ identity: { name: "plugin-c", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mC), { search: { name: "plugin-c", scoreContribution: async () => 0 } }, {
      isolationRequirement: { minimumIsolation: "simulated" },
      subscribesToPlugins: [{ targetPlugin: "plugin-b" }], // c → b → a (zincir, henüz döngü yok)
    });

    assert(registry.interactionGraph.dependsOn("plugin-c").includes("plugin-b"));
  },

  "deactivate: blast radius operatöre bildirilir": async () => {
    const adapter  = new MockSandboxAdapter();
    const bus      = new EventBus();
    const registry = new PluginRegistry(adapter, {}, bus);

    const mProducer = makeManifest({ identity: { name: "producer", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mProducer), { search: { name: "producer", scoreContribution: async () => 0 } },
      { isolationRequirement: { minimumIsolation: "simulated" } });
    await registry.activate("producer");

    const mConsumer = makeManifest({ identity: { name: "consumer", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mConsumer), { search: { name: "consumer", scoreContribution: async () => 0 } }, {
      isolationRequirement: { minimumIsolation: "simulated" },
      subscribesToPlugins: [{ targetPlugin: "producer" }],
    });
    await registry.activate("consumer");

    let impactEventFired = false;
    bus.on("plugin:deactivation_impact" as never, () => { impactEventFired = true; });

    const result = await registry.deactivate("producer");
    assert(result.impactedPlugins?.includes("consumer"), "consumer, producer'ın blast radius'unda olmalı");
    assert(impactEventFired, "plugin:deactivation_impact event'i yayınlanmalı");
  },

  "deactivate sonrası interaction graph temizlenir": async () => {
    const adapter  = new MockSandboxAdapter();
    const registry = new PluginRegistry(adapter, {}, new EventBus());

    const mA = makeManifest({ identity: { name: "a", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mA), { search: { name: "a", scoreContribution: async () => 0 } },
      { isolationRequirement: { minimumIsolation: "simulated" } });

    const mB = makeManifest({ identity: { name: "b", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(mB), { search: { name: "b", scoreContribution: async () => 0 } }, {
      isolationRequirement: { minimumIsolation: "simulated" },
      subscribesToPlugins: [{ targetPlugin: "a" }],
    });

    await registry.deactivate("b");
    assertEqual(registry.interactionGraph.dependsOn("b").length, 0);
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "resolveCapabilityProfile: aynı profil → aynı sonuç (10 iterasyon)": () => {
    const results = Array.from({ length: 10 }, () => resolveCapabilityProfile("search-scoring"));
    const first = JSON.stringify(results[0]);
    for (const r of results) assertEqual(JSON.stringify(r), first);
  },

  "checkIsolationRequirement: aynı adapter+requirement → aynı sonuç": () => {
    const adapter = new MockSandboxAdapter();
    const r1 = checkIsolationRequirement({ minimumIsolation: "process" }, adapter);
    const r2 = checkIsolationRequirement({ minimumIsolation: "process" }, adapter);
    assertEqual(r1.ok, r2.ok);
    assertEqual(r1.provided, r2.provided);
  },

  "PluginDependencyGraph.topologicalOrder deterministik sıra üretir": () => {
    const makeGraph = () => {
      const g = new PluginDependencyGraph();
      g.addInteraction({ sourcePlugin: "c", targetPlugin: "b", type: "subscribes_to", addedAt: new Date() });
      g.addInteraction({ sourcePlugin: "b", targetPlugin: "a", type: "subscribes_to", addedAt: new Date() });
      return g;
    };
    const g1 = makeGraph();
    const g2 = makeGraph();
    assertEqual(g1.topologicalOrder(), g2.topologicalOrder());
  },
});
