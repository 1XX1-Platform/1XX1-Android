/**
 * 1XX1 Rotation Engine — Adil Döngü
 * Aşama 10 — Pulse Engine
 *
 * Kural: Hiçbir proje sonsuza kadar üstte kalamaz.
 *
 * Rotation mantığı:
 *   1. Top pozisyonundaki proje maxConsecutiveTop pulse'u doldurunca
 *      listede belirli bir mesafe aşağıya taşınır (demote).
 *   2. Fairness kaydı güncellenir: topCount++, lastTopPulse=now.
 *   3. Aşağıya taşınan projenin yerini en uzun süredir görmezden
 *      gelinen proje (en yüksek fairness skoru) alır (promote).
 *   4. Tüm işlem deterministik: aynı girdi → aynı çıktı.
 *
 * NOT: Rotasyon sıralamanın içinde gerçekleşir, skor formülünün dışında değil.
 * Rotasyon sonrası puanlar yeniden hesaplanmaz; yalnızca promoted/demoted
 * işaretleri ve fairness kayıtları güncellenir.
 */

import type { PulseEntry, FairnessRecord } from "../pulse-types.ts";
import type { ILogger } from "../../core/interfaces.ts";

export interface RotationConfig {
  /** Bir proje art arda en fazla kaç pulse'ta top kalabilir */
  maxConsecutiveTop: number;
  /** Demote edilen projenin kaç sıra aşağıya gönderileceği */
  demoteSteps:       number;
}

const DEFAULT_ROTATION: RotationConfig = {
  maxConsecutiveTop: 10,  // ~50 saniye (5s interval × 10)
  demoteSteps:       20,
};

export interface RotationResult {
  entries:          PulseEntry[];
  fairness:         Map<string, FairnessRecord>;
  rotated:          string[];  // demote olan proje ID'leri
  promoted:         string[];  // promote olan proje ID'leri
}

export class RotationEngine {
  private readonly cfg: RotationConfig;

  constructor(
    cfg: Partial<RotationConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.cfg = { ...DEFAULT_ROTATION, ...cfg };
  }

  /**
   * Mevcut sıralı liste üzerinde rotasyon uygula.
   * Sıralama değişirse promoted/demoted işaretleri güncellenir.
   *
   * @param entries       RankingEngine'den gelen sıralı liste
   * @param fairness      Mevcut fairness kayıtları (mutate edilecek)
   * @param currentPulse  Mevcut pulse numarası
   */
  apply(
    entries:      PulseEntry[],
    fairness:     Map<string, FairnessRecord>,
    currentPulse: number
  ): RotationResult {
    if (entries.length === 0) {
      return { entries, fairness, rotated: [], promoted: [] };
    }

    const result    = [...entries.map((e) => ({ ...e }))]; // kopya
    const rotated:  string[] = [];
    const promoted: string[] = [];

    // ── Top'taki projeleri kontrol et ──
    const topEntry = result[0];
    if (!topEntry) return { entries: result, fairness, rotated, promoted };

    const topRecord = fairness.get(topEntry.projectId);
    const consecutivePulses = topRecord?.lastTopPulse
      ? currentPulse - (topRecord.lastTopPulse - (topRecord.topCount - 1))
      : 0;

    if (consecutivePulses >= this.cfg.maxConsecutiveTop && result.length > 1) {
      // Top proje demote edilecek
      const demoteTo   = Math.min(this.cfg.demoteSteps, result.length - 1);
      const [demoted]  = result.splice(0, 1);
      result.splice(demoteTo, 0, demoted);

      demoted.demoted  = true;
      demoted.promoted = false;
      rotated.push(demoted.projectId);

      // Fairness kaydını güncelle: artık top değil
      const rec = this._getOrCreate(fairness, demoted.projectId, currentPulse);
      rec.lastTopPulse  = currentPulse;
      rec.topCount++;

      // Yeni top proje
      const newTop = result[0];
      if (newTop) {
        newTop.promoted  = true;
        newTop.demoted   = false;
        promoted.push(newTop.projectId);
        const newRec = this._getOrCreate(fairness, newTop.projectId, currentPulse);
        newRec.lastSeenPulse = currentPulse;
      }

      this.logger?.debug(
        `Rotasyon: ${demoted.projectId} → sıra ${demoteTo + 1}` +
        `, ${newTop?.projectId ?? "?"} → sıra 1`
      );
    } else {
      // Top proje değişmedi — sadece fairness kaydını güncelle
      const rec = this._getOrCreate(fairness, topEntry.projectId, currentPulse);
      rec.lastTopPulse  = currentPulse;
      rec.lastSeenPulse = currentPulse;
      rec.topCount++;
    }

    // Sıra numaralarını yenile
    result.forEach((e, i) => {
      e.rank = i + 1;
      const rec = this._getOrCreate(fairness, e.projectId, currentPulse);
      rec.lastSeenPulse = currentPulse;
    });

    return { entries: result, fairness, rotated, promoted };
  }

  /**
   * Fairness kaydı yoksa oluştur.
   * Mevcut kayıt mutate edilir (referans döner).
   */
  private _getOrCreate(
    fairness:     Map<string, FairnessRecord>,
    projectId:    string,
    currentPulse: number
  ): FairnessRecord {
    if (!fairness.has(projectId)) {
      fairness.set(projectId, {
        projectId,
        lastTopPulse:           0,
        topCount:               0,
        lastSeenPulse:          currentPulse,
        firstPulse:             currentPulse,
        penalty:                0,
        lastSignificantUpdate:  currentPulse,
      });
    }
    return fairness.get(projectId)!;
  }
}
