/**
 * 1XX1 Policy Engine
 * Aşama 08 — Domain & Application Services
 *
 * Policy: "Bu işlem yapılabilir mi?" sorusunu yanıtlar.
 * Validator: "Bu veri doğru mu?" sorusunu yanıtlar.
 *
 * Ayrım kritiktir:
 *   - Policy → yetki, görünürlük, iş kuralı akışı
 *   - Validator → veri bütünlüğü, format, iş kısıtlamaları
 *
 * Policy katmanı stateless ve pure function tabanlıdır.
 * Hiçbir async I/O içermez (hız kritik).
 */

import type { Project, Developer, ProjectStatus } from "../core/types.ts";

// ─── Policy Sonucu ────────────────────────────────────────────────────────────

export interface PolicyGrant {
  allowed: true;
}

export interface PolicyDenial {
  allowed: false;
  code:    string;
  reason:  string;
}

export type PolicyDecision = PolicyGrant | PolicyDenial;

function grant(): PolicyGrant { return { allowed: true }; }
function deny(code: string, reason: string): PolicyDenial {
  return { allowed: false, code, reason };
}

// ─── ProjectPolicy ────────────────────────────────────────────────────────────

export class ProjectPolicy {

  /** Proje güncellenebilir mi? */
  canUpdate(project: Project, requesterId: string): PolicyDecision {
    if (project.developer !== requesterId) {
      return deny("NOT_OWNER", "Yalnızca proje sahibi güncelleyebilir");
    }
    if (project.status === "archived") {
      return deny("PROJECT_ARCHIVED", "Arşivlenmiş proje değiştirilemez");
    }
    return grant();
  }

  /** Proje arşivlenebilir mi? */
  canArchive(project: Project, requesterId: string): PolicyDecision {
    if (project.developer !== requesterId) {
      return deny("NOT_OWNER", "Yalnızca proje sahibi arşivleyebilir");
    }
    if (project.status === "archived") {
      return deny("ALREADY_ARCHIVED", "Proje zaten arşivlenmiş");
    }
    return grant();
  }

  /** Proje taşınabilir mi? */
  canMove(project: Project, requesterId: string): PolicyDecision {
    if (project.developer !== requesterId) {
      return deny("NOT_OWNER", "Yalnızca proje sahibi taşıyabilir");
    }
    if (project.status === "archived") {
      return deny("PROJECT_ARCHIVED", "Arşivlenmiş proje taşınamaz");
    }
    return grant();
  }

  /** Proje görüntülenebilir mi? (görünürlük politikası) */
  canView(project: Project, viewerId?: string): PolicyDecision {
    // Arşivlenmiş projeleri yalnızca sahibi görebilir
    if (project.status === "archived" && project.developer !== viewerId) {
      return deny("ARCHIVED_PRIVATE", "Arşivlenmiş projeler yalnızca sahibi tarafından görüntülenebilir");
    }
    return grant();
  }

  /** Proje doğrulanabilir mi? (moderasyon) */
  canVerify(project: Project): PolicyDecision {
    if (project.status === "verified") {
      return deny("ALREADY_VERIFIED", "Proje zaten doğrulanmış");
    }
    if (project.status === "archived") {
      return deny("PROJECT_ARCHIVED", "Arşivlenmiş proje doğrulanamaz");
    }
    return grant();
  }
}

// ─── DeveloperPolicy ──────────────────────────────────────────────────────────

export class DeveloperPolicy {

  /** Geliştirici kendi profilini güncelleyebilir mi? */
  canUpdateProfile(developerId: string, requesterId: string): PolicyDecision {
    if (developerId !== requesterId) {
      return deny("NOT_SELF", "Yalnızca kendi profilini güncelleyebilirsin");
    }
    return grant();
  }

  /** Geliştirici takma kimlik alabilir mi? */
  canMask(developer: Developer): PolicyDecision {
    // Şimdilik tüm geliştiriciler maskelenebilir
    // Aşama 14'te: belirli doğrulama seviyesi şartı eklenecek
    return grant();
  }

  /** Kanal oluşturabilir mi? */
  canCreateChannel(developer: Developer, existingChannelCount: number): PolicyDecision {
    const MAX_CHANNELS = 3;
    if (existingChannelCount >= MAX_CHANNELS) {
      return deny(
        "MAX_CHANNELS_REACHED",
        `Maksimum ${MAX_CHANNELS} kanal oluşturulabilir`
      );
    }
    return grant();
  }
}

// ─── VisibilityPolicy ─────────────────────────────────────────────────────────

/**
 * Proje listelerinde görünürlük filtresi.
 * Arama sonuçlarında hangi statüslerin görüneceğini belirler.
 */
export class VisibilityPolicy {

  /** Arama sonuçlarında gösterilebilecek durum listesi */
  searchableStatuses(): ProjectStatus[] {
    return ["active", "verified"];
  }

  /** Genel liste için görünür durum listesi */
  publicStatuses(): ProjectStatus[] {
    return ["active", "verified", "pending"];
  }

  /** Bu proje genel aramada görünür mü? */
  isSearchable(project: Project): boolean {
    return this.searchableStatuses().includes(project.status);
  }
}

// ─── DonationPolicy ───────────────────────────────────────────────────────────

/**
 * Bağış adresi politikası.
 * Proje bağış alabilir mi?
 */
export class DonationPolicy {

  /** Proje bağış adresi gösterebilir mi? */
  canShowDonation(project: Project, developer: Developer): PolicyDecision {
    if (project.status === "archived") {
      return deny("PROJECT_ARCHIVED", "Arşivlenmiş projeler bağış alamaz");
    }
    if (!developer.donationAddress && !project.donationAddress) {
      return deny("NO_ADDRESS", "Bağış adresi tanımlanmamış");
    }
    return grant();
  }

  /** Etkin bağış adresi (proje > geliştirici önceliği) */
  effectiveAddress(project: Project, developer: Developer): string | undefined {
    return project.donationAddress ?? developer.donationAddress;
  }
}

// ─── Policy Container ─────────────────────────────────────────────────────────

/** Tüm policy'leri tek noktadan sunar */
export class PolicyEngine {
  readonly project:    ProjectPolicy    = new ProjectPolicy();
  readonly developer:  DeveloperPolicy  = new DeveloperPolicy();
  readonly visibility: VisibilityPolicy = new VisibilityPolicy();
  readonly donation:   DonationPolicy   = new DonationPolicy();
}

export const policyEngine = new PolicyEngine();
