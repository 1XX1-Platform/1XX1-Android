/**
 * 1XX1 Behavior Monitor
 * Aşama 13 — Sandbox
 *
 * BehaviorEvent'leri kategorize eder, önem derecesi atar,
 * ihlalleri ayrıştırır.
 *
 * Kural: Monitor karar vermez. Yalnızca gözlemler ve raporlar.
 */

import type { BehaviorEvent, BehaviorCategory, ResourceLimits } from "../sandbox-types.ts";

export interface ViolationRule {
  category:  BehaviorCategory | "any";
  severity:  BehaviorEvent["severity"];
  condition: (event: BehaviorEvent, limits: ResourceLimits) => boolean;
  message:   (event: BehaviorEvent) => string;
}

const DEFAULT_RULES: ViolationRule[] = [
  {
    category: "network_connect", severity: "violation",
    condition: (_, lim) => !lim.allowNetwork,
    message:   (e) => `İzinsiz ağ bağlantısı: ${e.detail}`,
  },
  {
    category: "network_listen", severity: "violation",
    condition: (_, lim) => !lim.allowNetwork,
    message:   (e) => `İzinsiz port dinleme: ${e.detail}`,
  },
  {
    category: "resource_limit", severity: "violation",
    condition: () => true,
    message:   (e) => `Kaynak sınırı aşıldı: ${e.detail}`,
  },
  {
    category: "process_spawn", severity: "violation",
    condition: () => true,
    message:   (e) => `Alt süreç başlatma girişimi: ${e.detail}`,
  },
];

export class BehaviorMonitor {
  constructor(rules: ViolationRule[] = DEFAULT_RULES) {
    this.rules = rules;}

  /**
   * Olayları analiz et, ihlalleri döndür.
   */
  analyze(events: BehaviorEvent[], limits: ResourceLimits): {
    violations: BehaviorEvent[];
    warnings:   BehaviorEvent[];
    info:       BehaviorEvent[];
    categories: Map<BehaviorCategory, number>;
  } {
    const violations: BehaviorEvent[] = [];
    const warnings:   BehaviorEvent[] = [];
    const info:       BehaviorEvent[] = [];
    const categories  = new Map<BehaviorCategory, number>();

    for (const event of events) {
      // Kategori sayacı
      categories.set(event.category, (categories.get(event.category) ?? 0) + 1);

      // İhlal kuralı tetiklendi mi?
      const triggered = this.rules.find(
        (r) =>
          (r.category === "any" || r.category === event.category) &&
          r.condition(event, limits)
      );

      if (triggered) {
        violations.push({ ...event, severity: "violation",
          detail: triggered.message(event) });
      } else if (event.severity === "warning") {
        warnings.push(event);
      } else {
        info.push(event);
      }
    }

    return { violations, warnings, info, categories };
  }

  /** Özet istatistik */
  summarize(events: BehaviorEvent[]): string[] {
    const cats = new Map<BehaviorCategory, number>();
    for (const e of events) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
    return Array.from(cats.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => `${cat}: ${n}`);
  }
}
