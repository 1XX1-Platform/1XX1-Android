/**
 * 1XX1 Plugin Graph Resolver
 * Aşama 19 — God-Object Önleme Refactor'ü
 *
 * KÖKEN: Bu sınıfın iş mantığı (atomik kenar ekleme/geri alma, blast-radius
 * raporlama) PluginRegistry.register()/deactivate() içinden ÇIKARILDI.
 *
 * Not: PluginDependencyGraph (plugin-dependency-graph.ts) zaten ayrı bir
 * dosyaydı — saf veri yapısı (DAG + BFS). PluginGraphResolver onun
 * ÜZERİNE ince bir politika katmanıdır: "register sırasında abonelikleri
 * nasıl ekleriz, hata olursa nasıl geri alırız, deactivate sırasında
 * etkiyi nasıl raporlarız" gibi orkestrasyon mantığı.
 *
 * Bu ayrım, Kaptan'ın tespit ettiği "dependency graph engine" rolünü
 * PluginRegistry'den tamamen çıkarır.
 */

import { PluginDependencyGraph } from "./plugin-dependency-graph.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Abonelik İsteği ──────────────────────────────────────────────────────────

export interface SubscriptionRequest {
  targetPlugin: string;
  eventTypes?:  string[];
}

export interface SubscriptionApplyResult {
  ok:     boolean;
  errors: string[];
}

// ─── PluginGraphResolver ──────────────────────────────────────────────────────

export class PluginGraphResolver {
  /** Saf veri yapısı — döngü tespiti, blast radius, topological order burada yaşar */
  readonly graph = new PluginDependencyGraph();

  constructor(logger?: ILogger) {
    this.logger = logger;}

  /**
   * Bir plugin'in talep ettiği cross-plugin aboneliklerini ön-kontrolden
   * geçirir: hedef plugin'lerin var olup olmadığını doğrular.
   * (Asıl graf mutasyonu applySubscriptions() ile yapılır — iki aşamalı
   * akış, register() içindeki "önce doğrula sonra uygula" deseniyle uyumlu.)
   */
  validateSubscriptions(
    requests:        SubscriptionRequest[],
    registeredNames: ReadonlySet<string>
  ): string[] {
    const errors: string[] = [];
    for (const req of requests) {
      if (!registeredNames.has(req.targetPlugin)) {
        errors.push(`Abone olunmak istenen plugin bulunamadı: "${req.targetPlugin}"`);
      }
    }
    return errors;
  }

  /**
   * Abonelikleri grafa ekle. Herhangi biri döngü oluşturursa TÜM ekleme
   * geri alınır (atomiklik) — kısmi/tutarsız graf durumu asla kalmaz.
   */
  applySubscriptions(
    sourcePlugin: string,
    requests:     SubscriptionRequest[]
  ): SubscriptionApplyResult {
    const errors: string[] = [];
    const applied: SubscriptionRequest[] = [];

    for (const req of requests) {
      const result = this.graph.addInteraction({
        sourcePlugin,
        targetPlugin: req.targetPlugin,
        type: "subscribes_to",
        eventTypes: req.eventTypes,
        addedAt: new Date(),
      });
      if (!result.ok) {
        errors.push(result.reason ?? "Cross-plugin abonelik reddedildi");
        break; // ilk hata yeterli — devamını deneme
      }
      applied.push(req);
    }

    if (errors.length > 0) {
      // Atomiklik: kısmen eklenmiş kenarları geri al
      for (const req of applied) {
        this.graph.removeInteraction(sourcePlugin, req.targetPlugin);
      }
      this.logger?.warn(`Plugin kaydı reddedildi (cross-plugin döngü): "${sourcePlugin}"`);
      return { ok: false, errors };
    }

    return { ok: true, errors: [] };
  }

  /**
   * Bir plugin durdurulmadan önce etki alanını (blast radius) hesapla
   * ve logla. Saf sorgu — graf'ı mutasyona uğratmaz.
   */
  computeImpact(pluginName: string): string[] {
    const impacted = Array.from(this.graph.impactRadius(pluginName));
    if (impacted.length > 0) {
      this.logger?.warn(
        `Plugin "${pluginName}" durduruluyor — ${impacted.length} bağımlı plugin etkilenecek: ${impacted.join(", ")}`
      );
    }
    return impacted;
  }

  /** Plugin durdurulduktan sonra grafdan tamamen temizle (kaynak + hedef) */
  cleanup(pluginName: string): void {
    this.graph.removeAllForPlugin(pluginName);
  }

  /** Denetim paneli için graf istatistikleri */
  stats() {
    return this.graph.stats();
  }
}
