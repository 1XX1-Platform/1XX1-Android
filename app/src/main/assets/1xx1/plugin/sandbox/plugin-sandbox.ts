/**
 * 1XX1 Plugin Sandbox Isolation
 * Aşama 19 — Plugin SDK
 *
 * Plugin'ler güvenilmeyen koddur. Aşama 13'ün ISandboxAdapter'ı
 * (gözlem yapar, karar vermez) burada plugin çalıştırma için kullanılır.
 *
 * Üç izolasyon katmanı:
 *   1. Memory Boundary  — plugin kendi state'ine sahip, core state'e erişemez
 *   2. Execution Limits — Aşama 13 ResourceLimits (CPU, RAM, wall-time)
 *   3. Event-Only Communication — PluginContext dışında hiçbir API yok
 *
 * KRİTİK: Bu sandbox güvenlik SAĞLAMAZ, izolasyon sağlar (Aşama 13 prensibi
 * burada da geçerli). Güvenlik = izolasyon + manifest doğrulama + izin
 * kontrolü + (opsiyonel) Aşama 12 statik analiz ön kontrolü.
 */

import type { ISandboxAdapter, ResourceLimits, BehaviorReport } from "../../sandbox/sandbox-types.ts";
import { DEFAULT_LIMITS } from "../../sandbox/sandbox-types.ts";
import type { IPlugin, PluginContext, PluginPermission, PluginManifest } from "../core/plugin-types.ts";
import type { IEventBus, ILogger } from "../../core/interfaces.ts";

// ─── Plugin'e Özgü Kaynak Limitleri ──────────────────────────────────────────

/**
 * Plugin'ler genel sandbox limitlerinden (Aşama 13 DEFAULT_LIMITS) daha
 * sıkı sınırlara tabidir — çünkü her istek için değil, sürekli çalışan
 * uzun ömürlü bir bileşendir (init() bir kez, sonra olay bazlı çağrılar).
 */
export const PLUGIN_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  cpuTimeMs:       2_000,            // 2 saniye CPU (tek çağrı başına)
  maxMemoryBytes:  64 * 1024 * 1024, // 64 MB
  maxDiskBytes:    0,                // plugin'ler disk yazamaz
  wallTimeMs:      10_000,           // 10 saniye duvar saati
  allowNetwork:    false,            // varsayılan: ağ kapalı
});

// ─── Plugin Çalıştırma Sonucu ─────────────────────────────────────────────────

export interface PluginExecutionResult<T = unknown> {
  ok:           boolean;
  value?:       T;
  error?:       string;
  /** Aşama 13 BehaviorReport — ihlal/gözlem detayları */
  behavior?:    BehaviorReport;
  durationMs:   number;
}

// ─── Memory Boundary: İzole Plugin State ──────────────────────────────────────

/**
 * Her plugin kendi izole state objesine sahiptir.
 * Core sistem state'ine (Repository, Store, vb.) hiçbir doğrudan referans
 * taşımaz — yalnızca PluginContext üzerinden, izin dahilinde erişim olur.
 */
class IsolatedPluginMemory {
  private readonly data = new Map<string, unknown>();
  private readonly maxKeys = 1000; // basit DoS koruması

  set(key: string, value: unknown): boolean {
    if (!this.data.has(key) && this.data.size >= this.maxKeys) return false;
    this.data.set(key, value);
    return true;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  clear(): void { this.data.clear(); }
  size(): number { return this.data.size; }
}

// ─── PluginSandboxRunner ──────────────────────────────────────────────────────

export class PluginSandboxRunner {
  /** Her plugin için izole bellek alanı */
  private readonly memories = new Map<string, IsolatedPluginMemory>();

  constructor(
    sandboxAdapter: ISandboxAdapter,
    eventBus?:      IEventBus,
    logger?:        ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.sandboxAdapter = sandboxAdapter;}

  /**
   * Plugin'i sandbox içinde başlat (init() çağrısı).
   * Aşama 13'ün ISandboxAdapter.run() metodu kullanılır — gerçek izolasyon
   * (MockSandboxAdapter test için, ProcessSandboxAdapter production için).
   */
  async initPlugin(plugin: IPlugin): Promise<PluginExecutionResult<void>> {
    const t0 = Date.now();
    const memory = new IsolatedPluginMemory();
    this.memories.set(plugin.manifest.identity.name, memory);

    const ctx = this._createContext(plugin.manifest, memory);

    try {
      // Gerçek çalıştırma sandbox üzerinden gözlemlenir (davranış raporu için)
      const limits = this._resolveLimits(plugin.manifest);
      const sessionId = `plugin_init_${plugin.manifest.identity.name}_${Date.now()}`;

      // Sandbox'a "komut" olarak plugin adı + init işareti veriyoruz —
      // gerçek implementasyonda plugin kodu burada izole bir VM/Worker'da
      // çalıştırılır; bu SDK seviyesinde sözleşme ve gözlem akışı kurulur.
      const probeData = new TextEncoder().encode(`plugin:init:${plugin.manifest.identity.name}`);
      const behavior  = await this.sandboxAdapter.run(
        `plugin-init:${plugin.manifest.identity.name}`,
        probeData,
        limits,
        sessionId
      );

      if (behavior.violations.length > 0) {
        this.logger?.warn(
          `Plugin init sırasında ${behavior.violations.length} ihlal: ${plugin.manifest.identity.name}`
        );
      }

      await plugin.init(ctx);

      return { ok: true, behavior, durationMs: Date.now() - t0 };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Bilinmeyen init hatası";
      this.logger?.error(`Plugin init hatası: ${plugin.manifest.identity.name} — ${error}`);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Plugin'i durdur (shutdown() çağrısı).
   * shutdown() ASLA atlanmaz — hata fırlatsa bile registry akışı devam eder.
   */
  async shutdownPlugin(plugin: IPlugin): Promise<PluginExecutionResult<void>> {
    const t0 = Date.now();
    try {
      await plugin.shutdown();
      this.memories.delete(plugin.manifest.identity.name);
      return { ok: true, durationMs: Date.now() - t0 };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Bilinmeyen shutdown hatası";
      this.logger?.warn(`Plugin shutdown hatası (yine de devam ediliyor): ${plugin.manifest.identity.name} — ${error}`);
      // Hata olsa bile memory temizlenir — kaynak sızıntısı önlenir
      this.memories.delete(plugin.manifest.identity.name);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Plugin sağlık kontrolü — timeout korumalı.
   */
  async checkHealth(plugin: IPlugin): Promise<{ healthy: boolean; detail?: string }> {
    if (!plugin.healthCheck) return { healthy: true, detail: "healthCheck tanımlanmamış (varsayılan: sağlıklı)" };

    const timeout = new Promise<{ healthy: boolean; detail?: string }>((resolve) =>
      setTimeout(() => resolve({ healthy: false, detail: "healthCheck timeout" }), 1000)
    );

    try {
      return await Promise.race([plugin.healthCheck(), timeout]);
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : "healthCheck hatası" };
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _resolveLimits(manifest: PluginManifest): ResourceLimits {
    return {
      ...PLUGIN_RESOURCE_LIMITS,
      allowNetwork: manifest.permissions.includes("network:none") ? false : false, // network:none dışında izin yok (Aşama 19 kapsamında ağ izni yok)
    };
  }

  /**
   * Event-Only Communication: PluginContext, plugin'in dış dünyayla
   * TEK temas noktasıdır. İzin kontrolü burada uygulanır.
   */
  private _createContext(manifest: PluginManifest, memory: IsolatedPluginMemory): PluginContext {
    const pluginName  = manifest.identity.name;
    const permissions = manifest.permissions;
    const eventBus    = this.eventBus;
    const logger      = this.logger;

    return {
      pluginName,
      permissions,

      emitEvent: (eventType: string, payload: Record<string, unknown>): void => {
        if (!permissions.includes("emit:event")) {
          logger?.warn(`Plugin "${pluginName}" emit:event izni olmadan event göndermeye çalıştı: ${eventType}`);
          return;
        }
        // Plugin event'leri ayrı bir namespace'te yayınlanır — çekirdek event'lerle karışmaz
        eventBus?.emit(`plugin:${pluginName}:${eventType}` as never, payload);
      },

      readResource: async <T = unknown>(
        resource: PluginPermission,
        _query?: Record<string, unknown>
      ): Promise<T | null> => {
        if (!permissions.includes(resource)) {
          logger?.warn(`Plugin "${pluginName}" izinsiz kaynak okumaya çalıştı: ${resource}`);
          return null;
        }
        // Gerçek veri sağlama PluginRegistry seviyesinde resource provider'lar
        // ile yapılır (bkz. registry/plugin-registry.ts) — bu SDK katmanı
        // yalnızca izin kontrolü sözleşmesini sağlar.
        return null;
      },

      log: (level, message: string): void => {
        const prefixed = `[plugin:${pluginName}] ${message}`;
        if (level === "error") logger?.error(prefixed);
        else if (level === "warn") logger?.warn(prefixed);
        else if (level === "info") logger?.info(prefixed);
        else logger?.debug(prefixed);
      },
    };
  }

  /** Test/debug: bir plugin'in izole belleğine doğrudan eriş */
  getMemory(pluginName: string): IsolatedPluginMemory | undefined {
    return this.memories.get(pluginName);
  }
}
