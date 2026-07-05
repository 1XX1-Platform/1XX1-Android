/**
 * 1XX1 Plugin Registry — Facade
 * Aşama 19 — Plugin SDK (God-Object Önleme Refactor'ü)
 *
 * MİMARİ NOT (Kaptan'ın incelemesi sonrası):
 *   Önceki PluginRegistry tek dosyada üç ayrı sorumluluk taşıyordu:
 *   security enforcement + dependency graph engine + lifecycle manager.
 *   Bu, büyüdükçe "god-object" riski taşıyordu.
 *
 *   Bu sınıf artık yalnızca İNCE BİR FACADE'DİR. Gerçek iş üç bağımsız,
 *   tek-sorumluluklu sınıfa devredildi:
 *
 *     PluginSecurityLayer    → manifest/versiyon/izolasyon doğrulama
 *     PluginGraphResolver    → cross-plugin etkileşim grafiği (DAG, blast radius)
 *     PluginLifecycleManager → register/activate/deactivate/suspend state makinesi
 *
 *   PUBLIC API BİREBİR AYNI KALDI — mevcut tüm testler (plugin.test.ts,
 *   risk-mitigations.test.ts) değişmeden geçer. Bu bir davranış değişikliği
 *   değil, iç yapı refactor'üdür.
 *
 * Akış (değişmedi):
 *   register(plugin) → validateManifest() → dependency check →
 *   PluginSandboxRunner.initPlugin() → status: active
 */

import type { IPlugin } from "../core/plugin-types.ts";
import type { ISearchPlugin, IAssetProcessor, IPulseModifier, IIndexAugmenter } from "../extension-points/data-plugins.ts";
import type {
  IEventInterceptor, ISecurityAnalyzerPlugin, IPreviewGeneratorPlugin, IConsensusExtension,
} from "../extension-points/observer-plugins.ts";
import type { ISandboxAdapter } from "../../sandbox/sandbox-types.ts";
import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import type { IsolationRequirement } from "../sandbox/isolation-level.ts";

import { PluginSecurityLayer, satisfiesVersion } from "./plugin-security-layer.ts";
import { PluginGraphResolver, type SubscriptionRequest } from "./plugin-graph-resolver.ts";
import {
  PluginLifecycleManager, type PluginLifecycleEntry,
} from "./plugin-lifecycle-manager.ts";

// satisfiesVersion'ı geriye dönük uyumluluk için yeniden export et
// (eski import yolu: "./plugin-registry.ts" → hâlâ çalışır)
export { satisfiesVersion };

// ─── Plugin Implementasyon Demeti (değişmedi) ────────────────────────────────

export interface PluginImplementations {
  search?:               ISearchPlugin;
  assetProcessor?:        IAssetProcessor;
  pulseModifier?:          IPulseModifier;
  indexAugmenter?:         IIndexAugmenter;
  eventInterceptor?:       IEventInterceptor;
  securityAnalyzer?:       ISecurityAnalyzerPlugin;
  previewGenerator?:       IPreviewGeneratorPlugin;
  consensusExtension?:     IConsensusExtension;
}

/** Facade seviyesinde public tip: register/get/all metodlarının döndürdüğü kayıt şekli */
export type PluginRegistration = PluginLifecycleEntry<PluginImplementations>;

// ─── Registry Config (değişmedi) ─────────────────────────────────────────────

export interface PluginRegistryConfig {
  platformVersion:  string;
  maxPlugins:       number;
}

const DEFAULT_REGISTRY_CONFIG: PluginRegistryConfig = {
  platformVersion: "1.0.0",
  maxPlugins:      100,
};

// ─── register() Opsiyonları (değişmedi) ──────────────────────────────────────

export interface RegisterOptions {
  isolationRequirement?: IsolationRequirement;
  subscribesToPlugins?:  SubscriptionRequest[];
}

// ─── PluginRegistry (Facade) ──────────────────────────────────────────────────

export class PluginRegistry {
  private readonly security:  PluginSecurityLayer;
  private readonly graph:     PluginGraphResolver;
  private readonly lifecycle: PluginLifecycleManager<PluginImplementations>;

  /** Geriye dönük uyumluluk: eski kod `registry.interactionGraph.X()` çağırabilir */
  get interactionGraph() { return this.graph.graph; }

  constructor(
    sandboxAdapter: ISandboxAdapter,
    cfg: Partial<PluginRegistryConfig> = {},
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.sandboxAdapter = sandboxAdapter;
    this.eventBus = eventBus;
    this.logger = logger;
    const fullCfg = { ...DEFAULT_REGISTRY_CONFIG, ...cfg };
    this.security  = new PluginSecurityLayer(fullCfg, logger);
    this.graph     = new PluginGraphResolver(logger);
    this.lifecycle = new PluginLifecycleManager<PluginImplementations>(sandboxAdapter, eventBus, logger);
  }

  // ─── Kayıt + Doğrulama ────────────────────────────────────────────────────

  /**
   * Plugin'i kaydet. Davranış birebir aynı — yalnızca üç bağımsız katmana
   * (security → graph → lifecycle) sırayla devredilir.
   */
  register(
    plugin: IPlugin,
    implementations: PluginImplementations = {},
    opts: RegisterOptions = {}
  ): { ok: boolean; errors: string[] } {
    const manifest = plugin.manifest;
    const name      = manifest.identity.name;
    const isolationRequirement: IsolationRequirement =
      opts.isolationRequirement ?? { minimumIsolation: "process", rationale: "varsayılan: production-grade izolasyon" };

    // 1. Güvenlik/uyumluluk doğrulaması (PluginSecurityLayer)
    const securityResult = this.security.validateForRegistration(
      manifest,
      implementations as Record<string, unknown>,
      {
        registeredNames:    this.lifecycle.names(),
        registeredVersions: this.lifecycle.versions(),
        currentCount:       this.lifecycle.count(),
      }
    );

    // 2. Cross-plugin abonelik ön-kontrolü (PluginGraphResolver)
    const subscriptionErrors = this.graph.validateSubscriptions(
      opts.subscribesToPlugins ?? [],
      this.lifecycle.names()
    );

    const allErrors = [...securityResult.errors, ...subscriptionErrors];
    if (allErrors.length > 0) {
      return { ok: false, errors: allErrors };
    }

    // 3. Abonelikleri grafa uygula (atomik — döngü varsa geri alınır)
    const graphResult = this.graph.applySubscriptions(name, opts.subscribesToPlugins ?? []);
    if (!graphResult.ok) {
      return { ok: false, errors: graphResult.errors };
    }

    // 4. Yaşam döngüsü kaydı (PluginLifecycleManager)
    this.lifecycle.addRegistration(name, plugin, implementations, isolationRequirement);

    return { ok: true, errors: [] };
  }

  // ─── Aktivasyon ──────────────────────────────────────────────────────────

  async activate(pluginName: string): Promise<{ ok: boolean; error?: string }> {
    const reg = this.lifecycle.get(pluginName);
    if (!reg) return { ok: false, error: "Plugin kayıtlı değil" };

    const isolationDecision = this.security.checkIsolation(
      pluginName, reg.isolationRequirement, this.sandboxAdapter
    );

    return this.lifecycle.activate(pluginName, isolationDecision);
  }

  /** Tüm kayıtlı (henüz aktif olmayan) plugin'leri sırayla aktive et */
  async activateAll(): Promise<{ activated: string[]; failed: string[] }> {
    const activated: string[] = [];
    const failed: string[] = [];

    for (const reg of this.lifecycle.all()) {
      const name = reg.plugin.manifest.identity.name;
      if (reg.status === "active") { activated.push(name); continue; }
      const result = await this.activate(name);
      if (result.ok) activated.push(name); else failed.push(name);
    }

    return { activated, failed };
  }

  // ─── Durdurma ────────────────────────────────────────────────────────────

  async deactivate(pluginName: string): Promise<{ ok: boolean; error?: string; impactedPlugins?: string[] }> {
    const impacted = this.graph.computeImpact(pluginName);
    const result    = await this.lifecycle.deactivate(pluginName, impacted);
    this.graph.cleanup(pluginName);
    return result;
  }

  suspend(pluginName: string, reason: string): void {
    this.lifecycle.suspend(pluginName, reason);
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  get(pluginName: string): PluginRegistration | undefined {
    return this.lifecycle.get(pluginName);
  }

  all(): PluginRegistration[] {
    return this.lifecycle.all();
  }

  activeByExtensionPoint<K extends keyof PluginImplementations>(
    key: K
  ): NonNullable<PluginImplementations[K]>[] {
    return this.lifecycle.activeByExtensionPoint(key);
  }

  async healthCheckAll(): Promise<Record<string, { healthy: boolean; detail?: string }>> {
    return this.lifecycle.healthCheckAll();
  }

  stats() {
    return this.lifecycle.stats();
  }
}
