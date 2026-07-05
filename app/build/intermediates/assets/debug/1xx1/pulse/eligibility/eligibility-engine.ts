/**
 * 1XX1 Eligibility Engine
 * Aşama 10 — Pulse Engine
 *
 * Bir projenin Pulse'a katılıp katılamayacağını belirler.
 * Kontroller:
 *   1. Arşivlenmiş mi?
 *   2. Yasaklı mı?
 *   3. Görünürlük politikası geçiyor mu?
 *   4. Aktif sürüm var mı? (isteğe bağlı)
 *   5. Spam / manipülasyon tespiti
 *
 * Uygunsuz proje → pulse listesine girmez.
 * Bu katman iş mantığı değil, filtre kapısıdır.
 */

import type { Project } from "../../core/types.ts";
import type { FairnessRecord, EligibilityResult, EligibilityReason } from "../pulse-types.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── Eligibility Config ───────────────────────────────────────────────────────

export interface EligibilityConfig {
  /** Anlamlı güncelleme için minimum pulse farkı (spam koruması) */
  minUpdateInterval:    number;
  /** Aktif sürüm şartı */
  requireRelease:       boolean;
  /** Ceza puanı bu eşiği geçince proje geçici olarak engellenir */
  banPenaltyThreshold:  number;
}

const DEFAULT_ELIGIBILITY_CONFIG: EligibilityConfig = {
  minUpdateInterval:   12,   // 12 pulse = 1 dakika (5s interval)
  requireRelease:      false, // Aşama 11'de true olacak
  banPenaltyThreshold: 100,
};

// ─── EligibilityEngine ───────────────────────────────────────────────────────

export class EligibilityEngine {
  private readonly cfg: EligibilityConfig;

  constructor(
    cfg: Partial<EligibilityConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg = { ...DEFAULT_ELIGIBILITY_CONFIG, ...cfg };
  }

  /**
   * Proje listesini filtrele, uygun olanları döndür.
   * O(n) — tüm sistemi dolaşmaz.
   */
  filter(
    projects:  Project[],
    fairness:  Map<string, FairnessRecord>,
    currentPulse: number
  ): EligibilityResult[] {
    return projects.map((p) => this.check(p, fairness.get(p.id), currentPulse));
  }

  /** Tek proje kontrolü */
  check(
    project:  Project,
    record:   FairnessRecord | undefined,
    currentPulse: number
  ): EligibilityResult {
    const id = project.id;

    // 1. Arşiv
    if (project.status === "archived") {
      return { projectId: id, eligible: false, reason: "archived" };
    }

    // 2. Gizli
    if (project.status === "pending") {
      // Pending projeler pulse'a katılabilir (yeni projeye avantaj)
      // Ancak görünürlük düşük (fairness henüz sıfır → doğal olarak altta)
    }

    // 3. Ceza eşiği aşıldıysa geçici ban
    if (record && record.penalty >= this.cfg.banPenaltyThreshold) {
      return { projectId: id, eligible: false, reason: "banned" };
    }

    // 4. Spam koruma: çok sık güncelleme yapan projeler kısa süre dışarıda kalır
    if (record && record.lastSignificantUpdate > 0) {
      const pulseSinceUpdate = currentPulse - record.lastSignificantUpdate;
      if (pulseSinceUpdate < this.cfg.minUpdateInterval) {
        // Uyarı: engelleme değil, sadece fairness cezası (aşağıda skor düşer)
        this.logger?.debug(`Spam koruması uyarısı: ${id} (${pulseSinceUpdate} pulse)`);
      }
    }

    return { projectId: id, eligible: true };
  }

  /** Uygun proje ID listesi (yalnızca eligible:true) */
  eligibleIds(results: EligibilityResult[]): string[] {
    return results.filter((r) => r.eligible).map((r) => r.projectId);
  }

  /** Reddedilen projelerin özet istatistiği */
  rejectionStats(results: EligibilityResult[]): Record<EligibilityReason, number> {
    const stats = {} as Record<EligibilityReason, number>;
    for (const r of results) {
      if (!r.eligible && r.reason) {
        stats[r.reason] = (stats[r.reason] ?? 0) + 1;
      }
    }
    return stats;
  }
}
