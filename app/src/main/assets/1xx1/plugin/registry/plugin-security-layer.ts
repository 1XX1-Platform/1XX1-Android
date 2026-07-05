/**
 * 1XX1 Plugin Security Layer
 * Aşama 19 — God-Object Önleme Refactor'ü
 *
 * KÖKEN: Bu dosyanın içeriği PluginRegistry'den ÇIKARILDI (taşındı,
 * yeniden yazılmadı). Kaptan'ın mimari incelemesindeki tespit:
 *
 *   "PluginRegistry artık 3 rol taşıyor: security enforcement,
 *    dependency graph engine, lifecycle manager → god-object riski"
 *
 * Bu sınıf yalnızca GÜVENLİK DOĞRULAMASINDAN sorumludur:
 *   - Manifest yapısal doğrulama (validateManifest çağrısı)
 *   - Platform/bağımlılık versiyon uyumluluğu (satisfiesVersion)
 *   - İzolasyon seviyesi gereksinimi kontrolü (checkIsolationRequirement)
 *   - Implementation/extensionPoint tutarlılığı
 *
 * Davranış DEĞİŞMEDİ — yalnızca PluginRegistry'den buraya taşındı.
 * Tüm mevcut testler (plugin.test.ts, risk-mitigations.test.ts) bu
 * sınıfın PluginRegistry içinden çağrılmasıyla aynı sonuçları üretir.
 */

import type { ExtensionPointType, PluginManifest } from "../core/plugin-types.ts";
import { validateManifest } from "../core/plugin-types.ts";
import type { ISandboxAdapter } from "../../sandbox/sandbox-types.ts";
import {
  checkIsolationRequirement, type IsolationRequirement,
} from "../sandbox/isolation-level.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Versiyon Uyumluluğu ──────────────────────────────────────────────────────

/**
 * Basit semver range kontrolü: "^1.2.0", "~1.2.0", "1.2.0", ">=1.0.0"
 * Tam semver kütüphanesi yerine minimal, bağımlılıksız bir implementasyon.
 * (PluginRegistry'den taşındı — davranış birebir aynı.)
 */
export function satisfiesVersion(version: string, range: string): boolean {
  const parse = (v: string) => v.replace(/^[\^~>=<]+/, "").split(".").map(Number);
  const [vMaj, vMin, vPatch] = parse(version);

  if (range.startsWith("^")) {
    const [rMaj, rMin, rPatch] = parse(range);
    if (vMaj !== rMaj) return false;
    if (vMaj === 0) return vMin === rMin && vPatch >= rPatch; // 0.x.y özel kural
    return vMin > rMin || (vMin === rMin && vPatch >= rPatch);
  }
  if (range.startsWith("~")) {
    const [rMaj, rMin, rPatch] = parse(range);
    return vMaj === rMaj && vMin === rMin && vPatch >= rPatch;
  }
  if (range.startsWith(">=")) {
    const [rMaj, rMin, rPatch] = parse(range);
    return vMaj > rMaj || (vMaj === rMaj && vMin > rMin) || (vMaj === rMaj && vMin === rMin && vPatch >= rPatch);
  }
  // Tam eşleşme
  const [rMaj, rMin, rPatch] = parse(range);
  return vMaj === rMaj && vMin === rMin && vPatch === rPatch;
}

// ─── Doğrulama Sonucu Tipleri ──────────────────────────────────────────────────

export interface SecurityCheckContext {
  /** Şu an kayıtlı plugin isimleri (isim çakışması/bağımlılık kontrolü için) */
  registeredNames:    ReadonlySet<string>;
  /** İsim → versiyon haritası (bağımlılık versiyon kontrolü için) */
  registeredVersions: ReadonlyMap<string, string>;
  /** Mevcut kayıtlı plugin sayısı (kapasite kontrolü için) */
  currentCount:       number;
}

export interface SecurityCheckResult {
  ok:     boolean;
  errors: string[];
}

export interface IsolationDecision {
  ok:       boolean;
  provided: string;
  required: string;
  reason?:  string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SecurityLayerConfig {
  platformVersion: string;
  maxPlugins:       number;
}

const DEFAULT_SECURITY_CONFIG: SecurityLayerConfig = {
  platformVersion: "1.0.0",
  maxPlugins:      100,
};

// ─── PluginSecurityLayer ──────────────────────────────────────────────────────

export class PluginSecurityLayer {
  private readonly cfg: SecurityLayerConfig;

  constructor(
    cfg: Partial<SecurityLayerConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg = { ...DEFAULT_SECURITY_CONFIG, ...cfg };
  }

  config(): Readonly<SecurityLayerConfig> { return this.cfg; }

  /**
   * Bir manifest'i kayıt öncesi tüm güvenlik/uyumluluk kurallarına göre
   * doğrula. Cross-plugin etkileşim (graph) kontrolü BU SINIFA AİT DEĞİLDİR
   * — o PluginGraphResolver'ın sorumluluğudur (ayrı endişe, ayrı sınıf).
   */
  validateForRegistration(
    manifest: PluginManifest,
    implementations: Record<string, unknown>,
    ctx: SecurityCheckContext
  ): SecurityCheckResult {
    const errors: string[] = [];

    // 1. Manifest yapısal doğrulama
    const validation = validateManifest(manifest);
    if (!validation.ok) errors.push(...validation.errors);

    // 2. Kapasite kontrolü
    if (ctx.currentCount >= this.cfg.maxPlugins) {
      errors.push(`Maksimum plugin sayısına ulaşıldı: ${this.cfg.maxPlugins}`);
    }

    // 3. İsim çakışması
    if (ctx.registeredNames.has(manifest.identity.name)) {
      errors.push(`Plugin zaten kayıtlı: "${manifest.identity.name}"`);
    }

    // 4. Platform versiyon uyumluluğu
    if (!satisfiesVersion(this.cfg.platformVersion, manifest.platformVersion)) {
      errors.push(
        `Platform versiyon uyumsuz: plugin "${manifest.platformVersion}" istiyor, ` +
        `platform "${this.cfg.platformVersion}" çalışıyor`
      );
    }

    // 5. Bağımlılık kontrolü
    for (const dep of manifest.dependencies ?? []) {
      const depVersion = ctx.registeredVersions.get(dep.name);
      if (depVersion === undefined) {
        errors.push(`Bağımlılık bulunamadı: "${dep.name}"`);
        continue;
      }
      if (!satisfiesVersion(depVersion, dep.versionRange)) {
        errors.push(
          `Bağımlılık versiyon uyumsuz: "${dep.name}" → ` +
          `mevcut ${depVersion}, istenen ${dep.versionRange}`
        );
      }
    }

    // 6. Implementation/extensionPoint tutarlılığı
    errors.push(...this._validateImplementations(manifest, implementations));

    if (errors.length > 0) {
      this.logger?.warn(`Plugin kaydı reddedildi: "${manifest.identity.name}" — ${errors.join("; ")}`);
    }

    return { ok: errors.length === 0, errors };
  }

  /**
   * Bir plugin'i aktive etmeden önce izolasyon gereksinimini denetle.
   * Mevcut sandboxAdapter beyan edilen minimum seviyeyi karşılamıyorsa
   * plugin SESSİZCE daha zayıf izolasyonla çalıştırılmaz.
   */
  checkIsolation(
    pluginName:  string,
    requirement: IsolationRequirement,
    adapter:     ISandboxAdapter
  ): IsolationDecision {
    const result = checkIsolationRequirement(requirement, adapter);
    if (!result.ok) {
      this.logger?.error(
        `Plugin aktivasyonu reddedildi (izolasyon yetersiz): "${pluginName}" — ${result.reason}`
      );
    }
    return result;
  }

  /** Bir manifest'in extensionPoints alanı ile sağlanan implementations'ın eşleştiğini doğrula */
  private _validateImplementations(
    manifest: PluginManifest,
    impl:     Record<string, unknown>
  ): string[] {
    const errors: string[] = [];
    const checks: Array<[ExtensionPointType, string]> = [
      ["search", "search"],
      ["asset_processor", "assetProcessor"],
      ["pulse_hook", "pulseModifier"],
      ["index_augmenter", "indexAugmenter"],
      ["event_interceptor", "eventInterceptor"],
      ["security_analyzer", "securityAnalyzer"],
      ["preview_generator", "previewGenerator"],
      ["consensus_extension", "consensusExtension"],
    ];

    for (const [ep, key] of checks) {
      const declares = manifest.extensionPoints.includes(ep);
      const provides  = impl[key] !== undefined;
      if (declares && !provides) {
        errors.push(`Manifest "${ep}" extension point'i beyan ediyor ama implementasyon sağlanmadı`);
      }
      if (provides && !declares) {
        errors.push(`"${key}" implementasyonu sağlandı ama manifest "${ep}" beyan etmiyor`);
      }
    }
    return errors;
  }
}
