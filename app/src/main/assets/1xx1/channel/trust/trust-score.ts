/**
 * 1XX1 Trust Score Engine
 * Aşama 09 — Kanal Sistemi 2.0
 *
 * Kara kutu yok. Her metrik açıklanabilir.
 * Kullanıcı hangi kriterin karşılanıp karşılanmadığını görebilir.
 *
 * Ağırlık tablosu:
 *   openSource         → 20 puan
 *   verified           → 20 puan
 *   reproducibleBuild  → 15 puan
 *   signedRelease      → 20 puan
 *   securityScan       → 15 puan
 *   maintainerActivity → 10 puan
 *   Toplam             → 100 puan
 *
 * Trust Score sıralamayı tek başına belirlemez.
 * Pulse Engine + semantic score + trust score birlikte değerlendirilir.
 */

import type { TrustMetrics, TrustScore, Release } from "../entities/channel.entity.ts";
import type { Project } from "../../core/types.ts";

// ─── Ağırlıklar ──────────────────────────────────────────────────────────────

const WEIGHTS: Record<keyof Omit<TrustMetrics, "totalScore" | "calculatedAt">, number> = {
  openSource:         20,
  verified:           20,
  reproducibleBuild:  15,
  signedRelease:      20,
  securityScan:       15,
  maintainerActivity: 10,
};

// ─── Açık Kaynak Lisanslar ────────────────────────────────────────────────────

const OSI_LICENSES = new Set([
  "MIT", "GPL", "Apache", "BSD", "LGPL", "MPL",
  "AGPL", "ISC", "Unlicense", "CC0",
]);

// ─── TrustScoreEngine ─────────────────────────────────────────────────────────

export class TrustScoreEngine {

  /**
   * Bir kanal için Trust Score hesapla.
   *
   * @param channelId  Kanal ID
   * @param projects   Kanala ait projeler
   * @param releases   Kanala ait sürümler
   * @param oldScore   Mevcut skor (geçmiş için)
   */
  calculate(
    channelId: string,
    projects:  Project[],
    releases:  Release[],
    oldScore?: TrustScore
  ): TrustScore {
    const metrics = this._computeMetrics(projects, releases);
    const total   = this._computeTotal(metrics);

    const history = oldScore
      ? [
          ...oldScore.history.slice(-4), // son 4 kayıt
          { score: oldScore.metrics.totalScore, at: oldScore.metrics.calculatedAt },
        ]
      : [];

    const metCount = Object.values(metrics).filter(Boolean).length;
    const total6   = Object.keys(WEIGHTS).length;

    return {
      channelId,
      metrics: {
        ...metrics,
        totalScore:  total,
        calculatedAt: new Date(),
      },
      summary: `${metCount}/${total6} kriter karşılandı — ${total} puan`,
      history,
    };
  }

  /**
   * Tek bir metrik açıklamasını döndür.
   */
  explain(metric: keyof Omit<TrustMetrics, "totalScore" | "calculatedAt">): string {
    const DESCRIPTIONS: Record<typeof metric, string> = {
      openSource:         "Tüm projeler OSI onaylı açık kaynak lisans taşımalı (MIT, GPL, Apache vb.)",
      verified:           "En az bir proje platform moderasyonundan geçmeli",
      reproducibleBuild:  "Yeniden üretilebilir derleme kanıtı sağlanmalı (Reproducible Builds)",
      signedRelease:      "En az bir sürüm GPG anahtarıyla imzalanmalı",
      securityScan:       "Güvenlik taraması yapılmış ve açık kritik sorun bulunmamalı",
      maintainerActivity: "Bakımcı son 90 gün içinde aktif olmalı",
    };
    return DESCRIPTIONS[metric];
  }

  /** Belirli bir metriğin puan değeri */
  weight(metric: keyof typeof WEIGHTS): number {
    return WEIGHTS[metric];
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _computeMetrics(
    projects: Project[],
    releases: Release[]
  ): Omit<TrustMetrics, "totalScore" | "calculatedAt"> {
    return {
      openSource:         this._checkOpenSource(projects),
      verified:           this._checkVerified(projects),
      reproducibleBuild:  this._checkReproducible(releases),
      signedRelease:      this._checkSigned(releases),
      securityScan:       false, // Aşama 12'de doldurulacak
      maintainerActivity: this._checkActivity(projects, releases),
    };
  }

  private _computeTotal(
    metrics: Omit<TrustMetrics, "totalScore" | "calculatedAt">
  ): number {
    let total = 0;
    for (const [key, val] of Object.entries(metrics)) {
      if (val) total += WEIGHTS[key as keyof typeof WEIGHTS] ?? 0;
    }
    return total;
  }

  private _checkOpenSource(projects: Project[]): boolean {
    if (projects.length === 0) return false;
    const active = projects.filter((p) => p.status !== "archived");
    if (active.length === 0) return false;
    return active.every((p) => OSI_LICENSES.has(p.license));
  }

  private _checkVerified(projects: Project[]): boolean {
    return projects.some((p) => p.status === "verified");
  }

  private _checkReproducible(releases: Release[]): boolean {
    // Sürüm notlarında "#reproducible" etiketi veya artifact checksum varlığı
    return releases.some((r) =>
      r.notes.toLowerCase().includes("#reproducible") ||
      r.artifacts.some((a) => a.checksums.sha512 || a.checksums.blake3)
    );
  }

  private _checkSigned(releases: Release[]): boolean {
    return releases.some((r) =>
      r.artifacts.some((a) => !!a.signedBy)
    );
  }

  private _checkActivity(projects: Project[], releases: Release[]): boolean {
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const cutoff      = new Date(Date.now() - NINETY_DAYS);

    const recentProject = projects.some((p) => p.updatedAt > cutoff);
    const recentRelease = releases.some((r) => r.createdAt > cutoff);
    return recentProject || recentRelease;
  }
}

export const trustScoreEngine = new TrustScoreEngine();
