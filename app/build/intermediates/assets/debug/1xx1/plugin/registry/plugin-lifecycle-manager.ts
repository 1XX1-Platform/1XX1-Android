/**
 * 1XX1 Plugin Lifecycle Manager
 * Aşama 19 — God-Object Önleme Refactor'ü
 *
 * KÖKEN: register()/activate()/deactivate()/suspend() metodlarının state
 * makinesi mantığı PluginRegistry'den ÇIKARILDI. Bu sınıf yalnızca
 * YAŞAM DÖNGÜSÜ DURUMUNDAN sorumludur — güvenlik doğrulaması
 * (PluginSecurityLayer) ve etkileşim grafiği (PluginGraphResolver) ayrı.
 *
 * PluginLifecycleManager bu iki katmanı KULLANIR ama onların iç mantığını
 * BİLMEZ — yalnızca sonuçlarını (ok/errors, isolation decision, impact
 * radius) tüketir. Bu, üç sınıfın birbirinden bağımsız test edilebilmesini
 * sağlar (tek sorumluluk ilkesi).
 */

import type { IPlugin, PluginStatus } from "../core/plugin-types.ts";
import type { IsolationRequirement } from "../sandbox/isolation-level.ts";
import { PluginSandboxRunner } from "../sandbox/plugin-sandbox.ts";
import type { ISandboxAdapter } from "../../sandbox/sandbox-types.ts";
import type { IEventBus, ILogger } from "../../core/interfaces.ts";

// ─── Plugin Kayıt Girişi ──────────────────────────────────────────────────────

export interface PluginLifecycleEntry<TImpl = Record<string, unknown>> {
  plugin:               IPlugin;
  status:               PluginStatus;
  registeredAt:         Date;
  activatedAt?:         Date;
  lastError?:           string;
  isolationRequirement: IsolationRequirement;
  implementations:      TImpl;
}

// ─── PluginLifecycleManager ───────────────────────────────────────────────────

export class PluginLifecycleManager<TImpl = Record<string, unknown>> {
  private readonly plugins = new Map<string, PluginLifecycleEntry<TImpl>>();
  private readonly runner:  PluginSandboxRunner;

  constructor(
    sandboxAdapter: ISandboxAdapter,
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.sandboxAdapter = sandboxAdapter;
    this.runner = new PluginSandboxRunner(sandboxAdapter, eventBus, logger);
  }

  // ─── Kayıt (yalnızca state ekleme — doğrulama dışarıda yapılmış olmalı) ──

  /**
   * Bir plugin kaydını ekle. ÖNKOŞUL: çağıran taraf (PluginRegistry facade)
   * PluginSecurityLayer.validateForRegistration() ve gerekirse
   * PluginGraphResolver.applySubscriptions() ile tüm doğrulamaları
   * ÖNCEDEN yapmış olmalıdır — bu metot artık koşulsuz ekler.
   */
  addRegistration(
    name:                 string,
    plugin:               IPlugin,
    implementations:      TImpl,
    isolationRequirement: IsolationRequirement
  ): void {
    this.plugins.set(name, {
      plugin, implementations, isolationRequirement,
      status: "registered",
      registeredAt: new Date(),
    });
    this.logger?.info(`Plugin kaydedildi: "${name}" v${plugin.manifest.identity.version}`);
  }

  // ─── Aktivasyon ──────────────────────────────────────────────────────────

  /**
   * Plugin'i aktive et. İzolasyon kontrolü ÇAĞIRAN TARAF (PluginRegistry)
   * tarafından `isolationCheck` parametresiyle sağlanır — bu sınıf
   * izolasyon mantığını bilmez, yalnızca sonucunu uygular.
   */
  async activate(
    pluginName:      string,
    isolationCheck:  { ok: boolean; reason?: string; provided?: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const reg = this.plugins.get(pluginName);
    if (!reg) return { ok: false, error: "Plugin kayıtlı değil" };
    if (reg.status === "active") return { ok: true };

    if (!isolationCheck.ok) {
      reg.status = "failed";
      reg.lastError = isolationCheck.reason;
      this.eventBus?.emit("plugin:isolation_rejected" as never, { name: pluginName, reason: isolationCheck.reason });
      return { ok: false, error: isolationCheck.reason };
    }

    reg.status = "initializing";
    const result = await this.runner.initPlugin(reg.plugin);

    if (result.ok) {
      reg.status = "active";
      reg.activatedAt = new Date();
      this.eventBus?.emit("plugin:activated" as never, { name: pluginName });
      this.logger?.info(`Plugin aktif: "${pluginName}" (izolasyon: ${isolationCheck.provided ?? "bilinmiyor"})`);
      return { ok: true };
    } else {
      reg.status = "failed";
      reg.lastError = result.error;
      this.eventBus?.emit("plugin:failed" as never, { name: pluginName, error: result.error });
      return { ok: false, error: result.error };
    }
  }

  // ─── Durdurma ────────────────────────────────────────────────────────────

  /**
   * Plugin'i durdur. `impactedPlugins` ÇAĞIRAN TARAF (PluginGraphResolver
   * aracılığıyla PluginRegistry) tarafından önceden hesaplanıp verilir —
   * bu sınıf graf mantığını bilmez, yalnızca raporu taşır.
   */
  async deactivate(
    pluginName:       string,
    impactedPlugins:  string[]
  ): Promise<{ ok: boolean; error?: string; impactedPlugins: string[] }> {
    const reg = this.plugins.get(pluginName);
    if (!reg) return { ok: false, error: "Plugin kayıtlı değil", impactedPlugins: [] };

    if (impactedPlugins.length > 0) {
      this.eventBus?.emit("plugin:deactivation_impact" as never, { name: pluginName, impactedPlugins });
    }

    reg.status = "shutting_down";
    const result = await this.runner.shutdownPlugin(reg.plugin);
    reg.status = "stopped";

    this.eventBus?.emit("plugin:deactivated" as never, { name: pluginName });
    return { ok: result.ok, error: result.error, impactedPlugins };
  }

  /** Geçici olarak askıya al (örn. sürekli ihlal/hata durumunda) */
  suspend(pluginName: string, reason: string): void {
    const reg = this.plugins.get(pluginName);
    if (!reg) return;
    reg.status = "suspended";
    reg.lastError = reason;
    this.logger?.warn(`Plugin askıya alındı: "${pluginName}" — ${reason}`);
    this.eventBus?.emit("plugin:suspended" as never, { name: pluginName, reason });
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  get(pluginName: string): PluginLifecycleEntry<TImpl> | undefined {
    return this.plugins.get(pluginName);
  }

  all(): PluginLifecycleEntry<TImpl>[] {
    return Array.from(this.plugins.values());
  }

  has(pluginName: string): boolean {
    return this.plugins.has(pluginName);
  }

  count(): number {
    return this.plugins.size;
  }

  names(): ReadonlySet<string> {
    return new Set(this.plugins.keys());
  }

  /** İsim → versiyon haritası (PluginSecurityLayer'ın bağımlılık kontrolü için) */
  versions(): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    for (const [name, reg] of this.plugins) {
      map.set(name, reg.plugin.manifest.identity.version);
    }
    return map;
  }

  /** Belirli bir extension point'e bağlı, AKTİF plugin'lerin implementasyonları */
  activeByExtensionPoint<K extends keyof TImpl>(key: K): NonNullable<TImpl[K]>[] {
    const result: NonNullable<TImpl[K]>[] = [];
    for (const reg of this.plugins.values()) {
      if (reg.status !== "active") continue;
      const impl = reg.implementations[key];
      if (impl) result.push(impl as NonNullable<TImpl[K]>);
    }
    return result;
  }

  /** Sağlık kontrolü tüm aktif plugin'ler için */
  async healthCheckAll(): Promise<Record<string, { healthy: boolean; detail?: string }>> {
    const results: Record<string, { healthy: boolean; detail?: string }> = {};
    for (const [name, reg] of this.plugins) {
      if (reg.status !== "active") continue;
      results[name] = await this.runner.checkHealth(reg.plugin);
    }
    return results;
  }

  stats() {
    const byStatus: Record<string, number> = {};
    for (const reg of this.plugins.values()) {
      byStatus[reg.status] = (byStatus[reg.status] ?? 0) + 1;
    }
    return { total: this.plugins.size, byStatus };
  }
}
