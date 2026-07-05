/**
 * 1XX1 Plugin SDK Testleri
 * Aşama 19
 *
 * Gruplar:
 *   manifest-validation   — name/version/permission/extensionPoint kuralları
 *   version-compat        — satisfiesVersion (^, ~, >=, tam eşleşme)
 *   pulse-modifier-limits  — MAX_PLUGIN_PULSE_WEIGHT sınırı (kritik güvenlik)
 *   search-plugin-clamp    — clampSearchScore [0,1] sınırı
 *   sandbox-isolation       — init/shutdown akışı, izole bellek, izin kontrolü
 *   event-only-comm         — PluginContext emitEvent izin kontrolü
 *   registry-lifecycle       — register → activate → deactivate, hata yönetimi
 *   registry-dependency       — bağımlılık çözümleme, eksik/uyumsuz bağımlılık
 *   extension-point-binding   — gerçek senaryo: arama/pulse/preview plugin entegrasyonu
 *   determinism               — aynı manifest → aynı doğrulama sonucu
 *   performans                — 50 plugin kaydı + aktivasyon
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import {
  validateManifest, NO_PERMISSIONS,
  type PluginManifest, type IPlugin, type PluginContext,
} from "../core/plugin-types.ts";
import {
  clampPulseAdjustment, clampSearchScore, MAX_PLUGIN_PULSE_WEIGHT,
  type ISearchPlugin, type IPulseModifier,
} from "../extension-points/data-plugins.ts";
import { PluginSandboxRunner } from "../sandbox/plugin-sandbox.ts";
import { PluginRegistry, satisfiesVersion } from "../registry/plugin-registry.ts";
import { MockSandboxAdapter } from "../../sandbox/adapters/sandbox-adapters.ts";
import { EventBus } from "../../core/event-bus.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    identity: {
      name: "test-plugin", version: "1.0.0",
      publisherId: "dev_kaptan", description: "Test eklentisi",
    },
    extensionPoints: ["search"],
    permissions:     [],
    platformVersion: "^1.0.0",
    license:         "MIT",
    ...overrides,
  };
}

function makeMockPlugin(manifest: PluginManifest, behavior: {
  initThrows?: boolean; shutdownThrows?: boolean;
} = {}): IPlugin {
  let initCalled = false, shutdownCalled = false;
  return {
    manifest,
    async init(_ctx: PluginContext) {
      initCalled = true;
      if (behavior.initThrows) throw new Error("Kasıtlı init hatası");
    },
    async shutdown() {
      shutdownCalled = true;
      if (behavior.shutdownThrows) throw new Error("Kasıtlı shutdown hatası");
    },
    async healthCheck() {
      return { healthy: initCalled && !shutdownCalled };
    },
  };
}

function makeRegistry(platformVersion = "1.0.0") {
  const adapter = new MockSandboxAdapter();
  const bus     = new EventBus();
  return new PluginRegistry(adapter, { platformVersion }, bus);
}

/**
 * Test'ler MockSandboxAdapter (isolation: "simulated") kullanır.
 * register() çağrılarında bunu açıkça belirtmek için yardımcı opts.
 * Production'da varsayılan "process" istenir — testler bunu BİLİNÇLİ
 * olarak gevşetir (sandbox-isolation.ts test grubu bu farkı ayrıca test eder).
 */
const TEST_ISOLATION = { isolationRequirement: { minimumIsolation: "simulated" as const } };

// ─── Manifest Doğrulama ───────────────────────────────────────────────────────

await runSuite("manifest-validation", {
  "geçerli manifest → ok": () => {
    const r = validateManifest(makeManifest());
    assert(r.ok, `Hatalar: ${r.errors.join("; ")}`);
  },

  "geçersiz isim (büyük harf) → reddedilir": () => {
    const r = validateManifest(makeManifest({
      identity: { name: "Test-Plugin", version: "1.0.0", publisherId: "p", description: "d" },
    }));
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("plugin adı")));
  },

  "geçersiz isim (çok kısa) → reddedilir": () => {
    const r = validateManifest(makeManifest({
      identity: { name: "ab", version: "1.0.0", publisherId: "p", description: "d" },
    }));
    assert(!r.ok);
  },

  "geçersiz versiyon (semver değil) → reddedilir": () => {
    const r = validateManifest(makeManifest({
      identity: { name: "test-plugin", version: "v1", publisherId: "p", description: "d" },
    }));
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("versiyon")));
  },

  "publisherId eksik → reddedilir": () => {
    const r = validateManifest(makeManifest({
      identity: { name: "test-plugin", version: "1.0.0", publisherId: "", description: "d" },
    }));
    assert(!r.ok);
  },

  "boş extensionPoints → reddedilir": () => {
    const r = validateManifest(makeManifest({ extensionPoints: [] }));
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("extensionPoint")));
  },

  "bilinmeyen extension point → reddedilir": () => {
    const r = validateManifest(makeManifest({ extensionPoints: ["foo_bar" as never] }));
    assert(!r.ok);
  },

  "bilinmeyen izin → reddedilir": () => {
    const r = validateManifest(makeManifest({ permissions: ["fly:to_moon" as never] }));
    assert(!r.ok);
  },

  "write:pulse_score izni pulse_hook olmadan → reddedilir": () => {
    const r = validateManifest(makeManifest({
      extensionPoints: ["search"],
      permissions: ["write:pulse_score"],
    }));
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("pulse_hook")));
  },

  "write:pulse_score izni pulse_hook ile → kabul": () => {
    const r = validateManifest(makeManifest({
      extensionPoints: ["pulse_hook"],
      permissions: ["write:pulse_score"],
    }));
    assert(r.ok, `Hatalar: ${r.errors.join("; ")}`);
  },

  "write:search_score izni search olmadan → reddedilir": () => {
    const r = validateManifest(makeManifest({
      extensionPoints: ["pulse_hook"],
      permissions: ["write:search_score"],
    }));
    assert(!r.ok);
  },
});

// ─── Versiyon Uyumluluğu ──────────────────────────────────────────────────────

await runSuite("version-compat", {
  "caret (^): aynı major, yüksek minor/patch → uyumlu": () => {
    assert(satisfiesVersion("1.5.2", "^1.0.0"));
    assert(satisfiesVersion("1.0.0", "^1.0.0"));
  },
  "caret (^): farklı major → uyumsuz": () => {
    assert(!satisfiesVersion("2.0.0", "^1.0.0"));
  },
  "caret (^): düşük minor → uyumsuz": () => {
    assert(!satisfiesVersion("1.0.0", "^1.2.0"));
  },
  "tilde (~): yalnızca patch artışı → uyumlu": () => {
    assert(satisfiesVersion("1.2.5", "~1.2.0"));
    assert(!satisfiesVersion("1.3.0", "~1.2.0"));
  },
  "gte (>=): her zaman yüksek → uyumlu": () => {
    assert(satisfiesVersion("2.5.0", ">=1.0.0"));
    assert(!satisfiesVersion("0.9.0", ">=1.0.0"));
  },
  "tam eşleşme": () => {
    assert(satisfiesVersion("1.2.3", "1.2.3"));
    assert(!satisfiesVersion("1.2.4", "1.2.3"));
  },
});

// ─── Pulse Modifier Güvenlik Sınırı (KRİTİK) ─────────────────────────────────

await runSuite("pulse-modifier-limits", {
  "MAX_PLUGIN_PULSE_WEIGHT sabiti küçük (≤0.05)": () => {
    assert(MAX_PLUGIN_PULSE_WEIGHT <= 0.05, "Plugin etkisi ana formülün %5'ini aşmamalı");
  },

  "clampPulseAdjustment: maksimum öneri (+1) → MAX_WEIGHT ile sınırlı": () => {
    const result = clampPulseAdjustment(1.0);
    assertEqual(result, MAX_PLUGIN_PULSE_WEIGHT);
  },

  "clampPulseAdjustment: minimum öneri (-1) → -MAX_WEIGHT": () => {
    const result = clampPulseAdjustment(-1.0);
    assertEqual(result, -MAX_PLUGIN_PULSE_WEIGHT);
  },

  "clampPulseAdjustment: aralık dışı değer (örn. 100) → yine sınırlı": () => {
    const result = clampPulseAdjustment(100);
    assertEqual(result, MAX_PLUGIN_PULSE_WEIGHT, "Kötü niyetli/hatalı plugin değeri bile sınırlanmalı");
  },

  "clampPulseAdjustment: kötü niyetli plugin sıralamayı domine edemez": () => {
    // Senaryo: ana skor formülü en yüksek 1.0 üretebilir (pulseAge×0.5+fairness×0.4+trust×0.1)
    // plugin etkisi bunun yanında ihmal edilebilir kalmalı
    const maliciousAdjustment = clampPulseAdjustment(9999);
    const coreScoreMax = 1.0;
    assert(maliciousAdjustment < coreScoreMax * 0.1,
      "Plugin etkisi ana skorun %10'undan bile küçük olmalı"
    );
  },
});

// ─── Search Plugin Skor Sınırı ────────────────────────────────────────────────

await runSuite("search-plugin-clamp", {
  "clampSearchScore: [0,1] aralığında tutar": () => {
    assertEqual(clampSearchScore(0.5), 0.5);
    assertEqual(clampSearchScore(-5), 0);
    assertEqual(clampSearchScore(5), 1);
  },
});

// ─── Sandbox Isolation ────────────────────────────────────────────────────────

await runSuite("sandbox-isolation", {
  "initPlugin: başarılı init → ok": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const plugin  = makeMockPlugin(makeManifest());

    const result = await runner.initPlugin(plugin);
    assert(result.ok, `Init başarısız: ${result.error}`);
    assert(result.behavior !== undefined, "Sandbox davranış raporu üretilmeli");
  },

  "initPlugin: plugin init() hata fırlatırsa yakalanır": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const plugin  = makeMockPlugin(makeManifest(), { initThrows: true });

    const result = await runner.initPlugin(plugin);
    assert(!result.ok);
    assert(result.error?.includes("Kasıtlı"));
  },

  "shutdownPlugin: hata fırlatsa bile memory temizlenir": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const plugin  = makeMockPlugin(makeManifest(), { shutdownThrows: true });

    await runner.initPlugin(plugin);
    assert(runner.getMemory("test-plugin") !== undefined, "Init sonrası memory oluşmalı");

    const result = await runner.shutdownPlugin(plugin);
    assert(!result.ok, "Hata raporlanmalı");
    assert(runner.getMemory("test-plugin") === undefined, "Hata olsa da memory temizlenmeli");
  },

  "checkHealth: healthCheck tanımsızsa varsayılan sağlıklı": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const plugin: IPlugin = {
      manifest: makeManifest(),
      async init() {}, async shutdown() {},
      // healthCheck tanımlanmadı
    };
    const result = await runner.checkHealth(plugin);
    assert(result.healthy);
  },

  "checkHealth: timeout korumalı": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const plugin: IPlugin = {
      manifest: makeManifest(),
      async init() {}, async shutdown() {},
      async healthCheck() {
        await new Promise((r) => setTimeout(r, 5000)); // çok uzun
        return { healthy: true };
      },
    };
    const start = Date.now();
    const result = await runner.checkHealth(plugin);
    const ms = Date.now() - start;
    assert(!result.healthy, "Timeout sonrası unhealthy dönmeli");
    assert(ms < 1500, `Timeout 1s civarında olmalı: ${ms}ms`);
  },

  "memory boundary: her plugin izole bellek alır": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);
    const p1 = makeMockPlugin(makeManifest({ identity: { name: "plugin-a", version: "1.0.0", publisherId: "p", description: "d" } }));
    const p2 = makeMockPlugin(makeManifest({ identity: { name: "plugin-b", version: "1.0.0", publisherId: "p", description: "d" } }));

    await runner.initPlugin(p1);
    await runner.initPlugin(p2);

    const mem1 = runner.getMemory("plugin-a")!;
    const mem2 = runner.getMemory("plugin-b")!;
    mem1.set("key", "değer-a");
    mem2.set("key", "değer-b");

    assertEqual(mem1.get("key"), "değer-a");
    assertEqual(mem2.get("key"), "değer-b");
    assert(mem1 !== mem2, "İzole bellek alanları ayrı objeler olmalı");
  },
});

// ─── Event-Only Communication ─────────────────────────────────────────────────

await runSuite("event-only-comm", {
  "emit:event izni yoksa event gönderilmez": async () => {
    const adapter = new MockSandboxAdapter();
    const bus     = new EventBus();
    const runner  = new PluginSandboxRunner(adapter, bus);

    let received = false;
    bus.on("plugin:no-perm-plugin:custom" as never, () => { received = true; });

    const manifest = makeManifest({
      identity: { name: "no-perm-plugin", version: "1.0.0", publisherId: "p", description: "d" },
      permissions: [], // emit:event YOK
    });
    let capturedCtx: PluginContext | null = null;
    const plugin: IPlugin = {
      manifest,
      async init(ctx) { capturedCtx = ctx; ctx.emitEvent("custom", { x: 1 }); },
      async shutdown() {},
    };

    await runner.initPlugin(plugin);
    assert(!received, "İzinsiz event yayınlanmamalı");
  },

  "emit:event izni varsa event ayrı namespace'te yayınlanır": async () => {
    const adapter = new MockSandboxAdapter();
    const bus     = new EventBus();
    const runner  = new PluginSandboxRunner(adapter, bus);

    let receivedPayload: unknown = null;
    bus.on("plugin:has-perm-plugin:custom" as never, (payload: unknown) => { receivedPayload = payload; });

    const manifest = makeManifest({
      identity: { name: "has-perm-plugin", version: "1.0.0", publisherId: "p", description: "d" },
      permissions: ["emit:event"],
    });
    const plugin: IPlugin = {
      manifest,
      async init(ctx) { ctx.emitEvent("custom", { x: 42 }); },
      async shutdown() {},
    };

    await runner.initPlugin(plugin);
    assert(receivedPayload !== null, "İzinli event yayınlanmalı");
    assertEqual((receivedPayload as { x: number }).x, 42);
  },

  "readResource: izinsiz kaynak null döner": async () => {
    const adapter = new MockSandboxAdapter();
    const runner  = new PluginSandboxRunner(adapter);

    const manifest = makeManifest({ permissions: [] });
    let resourceResult: unknown = "başlangıç";
    const plugin: IPlugin = {
      manifest,
      async init(ctx) {
        resourceResult = await ctx.readResource("read:pulse_snapshot");
      },
      async shutdown() {},
    };

    await runner.initPlugin(plugin);
    assertEqual(resourceResult, null);
  },
});

// ─── Registry Lifecycle ───────────────────────────────────────────────────────

await runSuite("registry-lifecycle", {
  "register: geçerli plugin → ok": () => {
    const registry = makeRegistry();
    const manifest  = makeManifest();
    const plugin    = makeMockPlugin(manifest);
    const dummySearchPlugin: ISearchPlugin = {
      name: "test-plugin",
      scoreContribution: async () => 0.5,
    };
    const r = registry.register(plugin, { search: dummySearchPlugin }, TEST_ISOLATION);
    assert(r.ok, `Hatalar: ${r.errors.join("; ")}`);
  },

  "register: extensionPoint beyan edilip implementasyon verilmezse reddedilir": () => {
    const registry = makeRegistry();
    const plugin    = makeMockPlugin(makeManifest({ extensionPoints: ["search"] }));
    const r = registry.register(plugin, {}, TEST_ISOLATION); // search implementasyonu YOK
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("implementasyon")));
  },

  "register: aynı isim iki kez → ikincisi reddedilir": () => {
    const registry = makeRegistry();
    const m1 = makeManifest();
    const impl: { search: ISearchPlugin } = { search: { name: "test-plugin", scoreContribution: async () => 0 } };
    registry.register(makeMockPlugin(m1), impl, TEST_ISOLATION);
    const r2 = registry.register(makeMockPlugin(m1), impl, TEST_ISOLATION);
    assert(!r2.ok);
    assert(r2.errors.some((e) => e.includes("zaten kayıtlı")));
  },

  "register: platform versiyon uyumsuzluğu → reddedilir": () => {
    const registry = makeRegistry("1.0.0");
    const manifest  = makeManifest({ platformVersion: "^2.0.0" }); // platform 1.0.0 ile uyumsuz
    const r = registry.register(makeMockPlugin(manifest), {
      search: { name: "test-plugin", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("Platform versiyon")));
  },

  "activate: register sonrası init çağrılır, status active olur": async () => {
    const registry = makeRegistry();
    const manifest  = makeManifest();
    const plugin    = makeMockPlugin(manifest);
    registry.register(plugin, { search: { name: "test-plugin", scoreContribution: async () => 0 } }, TEST_ISOLATION);

    const result = await registry.activate("test-plugin");
    assert(result.ok, `Aktivasyon başarısız: ${result.error}`);
    assertEqual(registry.get("test-plugin")?.status, "active");
  },

  "activate: init hata fırlatırsa status failed olur": async () => {
    const registry = makeRegistry();
    const manifest  = makeManifest();
    const plugin    = makeMockPlugin(manifest, { initThrows: true });
    registry.register(plugin, { search: { name: "test-plugin", scoreContribution: async () => 0 } }, TEST_ISOLATION);

    const result = await registry.activate("test-plugin");
    assert(!result.ok);
    assertEqual(registry.get("test-plugin")?.status, "failed");
  },

  "deactivate: status stopped olur": async () => {
    const registry = makeRegistry();
    const manifest  = makeManifest();
    const plugin    = makeMockPlugin(manifest);
    registry.register(plugin, { search: { name: "test-plugin", scoreContribution: async () => 0 } }, TEST_ISOLATION);
    await registry.activate("test-plugin");

    const result = await registry.deactivate("test-plugin");
    assert(result.ok);
    assertEqual(registry.get("test-plugin")?.status, "stopped");
  },

  "suspend: status suspended olur, sebep kaydedilir": () => {
    const registry = makeRegistry();
    const manifest  = makeManifest();
    registry.register(makeMockPlugin(manifest), { search: { name: "test-plugin", scoreContribution: async () => 0 } }, TEST_ISOLATION);
    registry.suspend("test-plugin", "Sürekli ihlal");
    const reg = registry.get("test-plugin")!;
    assertEqual(reg.status, "suspended");
    assertEqual(reg.lastError, "Sürekli ihlal");
  },

  "activateAll: birden fazla plugin sırayla aktive edilir": async () => {
    const registry = makeRegistry();
    for (const name of ["plugin-x", "plugin-y", "plugin-z"]) {
      const m = makeManifest({ identity: { name, version: "1.0.0", publisherId: "p", description: "d" } });
      registry.register(makeMockPlugin(m), { search: { name, scoreContribution: async () => 0 } }, TEST_ISOLATION);
    }
    const result = await registry.activateAll();
    assertEqual(result.activated.length, 3);
    assertEqual(result.failed.length, 0);
  },

  "healthCheckAll: yalnızca aktif plugin'ler kontrol edilir": async () => {
    const registry = makeRegistry();
    const m1 = makeManifest({ identity: { name: "active-one", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(m1), { search: { name: "active-one", scoreContribution: async () => 0 } }, TEST_ISOLATION);
    await registry.activate("active-one");

    const health = await registry.healthCheckAll();
    assert("active-one" in health);
    assertEqual(Object.keys(health).length, 1);
  },

  "stats: durum bazlı sayım": async () => {
    const registry = makeRegistry();
    const m1 = makeManifest({ identity: { name: "p1", version: "1.0.0", publisherId: "p", description: "d" } });
    const m2 = makeManifest({ identity: { name: "p2", version: "1.0.0", publisherId: "p", description: "d" } });
    registry.register(makeMockPlugin(m1), { search: { name: "p1", scoreContribution: async () => 0 } }, TEST_ISOLATION);
    registry.register(makeMockPlugin(m2), { search: { name: "p2", scoreContribution: async () => 0 } }, TEST_ISOLATION);
    await registry.activate("p1");

    const stats = registry.stats();
    assertEqual(stats.total, 2);
    assertEqual(stats.byStatus["active"], 1);
    assertEqual(stats.byStatus["registered"], 1);
  },
});

// ─── Bağımlılık Çözümleme ─────────────────────────────────────────────────────

await runSuite("registry-dependency", {
  "bağımlılık bulunamazsa reddedilir": () => {
    const registry = makeRegistry();
    const manifest  = makeManifest({
      identity: { name: "dependent", version: "1.0.0", publisherId: "p", description: "d" },
      dependencies: [{ name: "missing-dep", versionRange: "^1.0.0" }],
    });
    const r = registry.register(makeMockPlugin(manifest), {
      search: { name: "dependent", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("Bağımlılık bulunamadı")));
  },

  "bağımlılık mevcutsa ve uyumluysa kabul edilir": () => {
    const registry = makeRegistry();
    const baseManifest = makeManifest({
      identity: { name: "base-lib", version: "1.2.0", publisherId: "p", description: "d" },
    });
    registry.register(makeMockPlugin(baseManifest), {
      search: { name: "base-lib", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);

    const dependentManifest = makeManifest({
      identity: { name: "dependent", version: "1.0.0", publisherId: "p", description: "d" },
      dependencies: [{ name: "base-lib", versionRange: "^1.0.0" }],
    });
    const r = registry.register(makeMockPlugin(dependentManifest), {
      search: { name: "dependent", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);
    assert(r.ok, `Hatalar: ${r.errors.join("; ")}`);
  },

  "bağımlılık versiyon uyumsuzsa reddedilir": () => {
    const registry = makeRegistry();
    const baseManifest = makeManifest({
      identity: { name: "base-lib", version: "0.5.0", publisherId: "p", description: "d" },
    });
    registry.register(makeMockPlugin(baseManifest), {
      search: { name: "base-lib", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);

    const dependentManifest = makeManifest({
      identity: { name: "dependent", version: "1.0.0", publisherId: "p", description: "d" },
      dependencies: [{ name: "base-lib", versionRange: "^1.0.0" }], // 0.5.0 uyumsuz
    });
    const r = registry.register(makeMockPlugin(dependentManifest), {
      search: { name: "dependent", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);
    assert(!r.ok);
    assert(r.errors.some((e) => e.includes("versiyon uyumsuz")));
  },
});

// ─── Extension Point Entegrasyon Senaryoları ─────────────────────────────────

await runSuite("extension-point-binding", {
  "ISearchPlugin: activeByExtensionPoint ile çekirdeğe bağlanabilir": async () => {
    const registry = makeRegistry();
    const searchImpl: ISearchPlugin = {
      name: "fuzzy-tr",
      scoreContribution: async ({ query, candidate }) =>
        query.length > 0 && candidate.id.includes("test") ? 0.8 : 0,
    };
    const manifest = makeManifest({
      identity: { name: "fuzzy-tr", version: "1.0.0", publisherId: "p", description: "d" },
    });
    registry.register(makeMockPlugin(manifest), { search: searchImpl }, TEST_ISOLATION);
    await registry.activate("fuzzy-tr");

    const activePlugins = registry.activeByExtensionPoint("search");
    assertEqual(activePlugins.length, 1);
    const score = await activePlugins[0].scoreContribution({
      query: "motor", candidate: { id: "test_1", type: "project", metadata: {} },
    });
    assertEqual(score, 0.8);
  },

  "IPulseModifier: clamp ile birlikte güvenli kullanım": async () => {
    const registry = makeRegistry();
    const pulseImpl: IPulseModifier = {
      name: "trend-booster",
      proposeAdjustment: async () => 1.0, // maksimum öneri (kötü niyetli olsa bile)
    };
    const manifest = makeManifest({
      identity: { name: "trend-booster", version: "1.0.0", publisherId: "p", description: "d" },
      extensionPoints: ["pulse_hook"],
      permissions: ["write:pulse_score", "read:pulse_snapshot"],
    });
    registry.register(makeMockPlugin(manifest), { pulseModifier: pulseImpl }, TEST_ISOLATION);
    await registry.activate("trend-booster");

    const activeMods = registry.activeByExtensionPoint("pulseModifier");
    assertEqual(activeMods.length, 1);

    const rawSuggestion = await activeMods[0].proposeAdjustment({
      projectId: "p1", pulseNumber: 100,
      context: { currentRank: 5, fairnessScore: 0.5, trustScore: 0.5 },
    });
    const appliedEffect = clampPulseAdjustment(rawSuggestion);
    assert(appliedEffect <= MAX_PLUGIN_PULSE_WEIGHT, "Uygulanan etki sınırlı kalmalı");
  },

  "deactive edilen plugin activeByExtensionPoint'te görünmez": async () => {
    const registry = makeRegistry();
    const manifest = makeManifest();
    registry.register(makeMockPlugin(manifest), {
      search: { name: "test-plugin", scoreContribution: async () => 0 },
    }, TEST_ISOLATION);
    await registry.activate("test-plugin");
    assertEqual(registry.activeByExtensionPoint("search").length, 1);

    await registry.deactivate("test-plugin");
    assertEqual(registry.activeByExtensionPoint("search").length, 0);
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı manifest → aynı doğrulama sonucu (10 iterasyon)": () => {
    const manifest = makeManifest({ permissions: ["write:pulse_score"] }); // hatalı kombinasyon
    const results = Array.from({ length: 10 }, () => validateManifest(manifest));
    const first = results[0];
    for (const r of results) {
      assertEqual(r.ok, first.ok);
      assertEqual(r.errors.length, first.errors.length);
    }
  },

  "clampPulseAdjustment deterministik": () => {
    for (let i = 0; i < 20; i++) {
      assertEqual(clampPulseAdjustment(0.7), clampPulseAdjustment(0.7));
    }
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "50 plugin kayıt + aktivasyon < 2s": async () => {
    const registry = makeRegistry();
    const start = Date.now();

    for (let i = 0; i < 50; i++) {
      const name = `perf-plugin-${i}`;
      const manifest = makeManifest({
        identity: { name, version: "1.0.0", publisherId: "p", description: "d" },
      });
      registry.register(makeMockPlugin(manifest), {
        search: { name, scoreContribution: async () => 0 },
      }, TEST_ISOLATION);
    }
    const { activated, failed } = await registry.activateAll();
    const ms = Date.now() - start;

    assertEqual(activated.length, 50);
    assertEqual(failed.length, 0);
    assert(ms < 2000, `50 plugin kayıt+aktivasyon ${ms}ms (beklenen < 2s)`);
    console.log(`  → 50 plugin register+activate: ${ms}ms`);
  },
});
