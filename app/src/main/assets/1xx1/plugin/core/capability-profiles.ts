/**
 * 1XX1 Plugin SDK — Capability Profile Sistemi
 * Aşama 19 (Risk Düzeltmesi 1/3)
 *
 * PROBLEM (Kaptan'ın tespiti — "Capability Explosion Risk"):
 *   Plugin sayısı arttıkça extension point × permission kombinasyonları
 *   çarpımsal olarak büyür. Her plugin yazarı manifest'te tek tek izin
 *   seçerse: (a) hata yapma olasılığı artar, (b) registry'de izin
 *   kombinasyonlarını denetlemek karmaşıklaşır, (c) benzer amaçlı
 *   plugin'ler arasında tutarsız izin profilleri oluşur.
 *
 * ÇÖZÜM: Sabit, küçük sayıda CapabilityProfile — her biri önceden
 * denetlenmiş bir (extensionPoints, permissions) demeti. Plugin yazarı
 * tek tek izin seçmek yerine bir profil seçer; registry yalnızca
 * profillerin KENDİSİNİ bir kez denetler (manifest validasyonu O(1)
 * profil kontrolüne iner, O(n) izin kombinasyonu denetimi değil).
 *
 * "custom" profili hâlâ mevcuttur (Aşama 19'un orijinal serbest izin
 * seçimi) — ancak registry bunu varsayılan olarak DAHA SIKI denetler
 * (bkz. validateManifest çağrısında profile=custom uyarısı).
 */

import type { ExtensionPointType, PluginPermission } from "./plugin-types.ts";

// ─── Capability Profile Tanımı ───────────────────────────────────────────────

export interface CapabilityProfile {
  readonly id:              string;
  readonly description:     string;
  readonly extensionPoints: readonly ExtensionPointType[];
  readonly permissions:     readonly PluginPermission[];
  /** Bu profilin maksimum sandbox kaynak çarpanı (1.0 = PLUGIN_RESOURCE_LIMITS aynen) */
  readonly resourceMultiplier: number;
}

// ─── Önceden Denetlenmiş Profil Kataloğu ─────────────────────────────────────

/**
 * Her profil, gerçek bir kullanım senaryosuna karşılık gelir ve
 * ADR-010'daki güvenlik sınırlarıyla (deny-by-default, pulse weight cap,
 * consensus write-ban) tutarlıdır. Yeni profil eklemek registry kodunu
 * DEĞİŞTİRMEZ — yalnızca bu kataloğa satır eklenir.
 */
export const CAPABILITY_PROFILES: Readonly<Record<string, CapabilityProfile>> = Object.freeze({

  /** Salt-okunur arama katkısı — en yaygın, en düşük riskli profil */
  "search-readonly": Object.freeze({
    id: "search-readonly",
    description: "Arama sonuçlarına salt-okunur skor/filtre katkısı",
    extensionPoints: Object.freeze(["search"]),
    permissions:     Object.freeze(["read:search_index"]),
    resourceMultiplier: 0.5, // hafif iş yükü — sandbox daha sıkı
  }),

  /** Arama skoruna yazma izni olan, biraz daha geniş profil */
  "search-scoring": Object.freeze({
    id: "search-scoring",
    description: "Arama skoruna doğrudan katkı sağlayan eklenti",
    extensionPoints: Object.freeze(["search"]),
    permissions:     Object.freeze(["read:search_index", "write:search_score"]),
    resourceMultiplier: 0.5,
  }),

  /** Asset format desteği ekleyen işlemci */
  "asset-format-extension": Object.freeze({
    id: "asset-format-extension",
    description: "Yeni dosya formatı için metadata çıkarımı",
    extensionPoints: Object.freeze(["asset_processor"]),
    permissions:     Object.freeze(["read:asset_metadata"]),
    resourceMultiplier: 1.0,
  }),

  /** Pulse fairness'e sınırlı katkı — yalnızca bu profil write:pulse_score taşır */
  "pulse-fairness-hook": Object.freeze({
    id: "pulse-fairness-hook",
    description: "Pulse sıralamasına MAX_PLUGIN_PULSE_WEIGHT ile sınırlı katkı",
    extensionPoints: Object.freeze(["pulse_hook"]),
    permissions:     Object.freeze(["read:pulse_snapshot", "write:pulse_score"]),
    resourceMultiplier: 0.5,
  }),

  /** Pasif gözlemci — yalnızca event dinler, hiçbir şey yazamaz */
  "passive-observer": Object.freeze({
    id: "passive-observer",
    description: "Yalnızca event gözlemleyen, audit/metrik amaçlı eklenti",
    extensionPoints: Object.freeze(["event_interceptor", "consensus_extension"]),
    permissions:     Object.freeze([]), // hiçbir izin gerekmez — yalnızca pasif callback
    resourceMultiplier: 0.25, // en hafif profil
  }),

  /** Güvenlik analiz eklentisi — IAnalyzer uyumlu */
  "security-analyzer-extension": Object.freeze({
    id: "security-analyzer-extension",
    description: "Ek statik/davranışsal analiz kuralı",
    extensionPoints: Object.freeze(["security_analyzer"]),
    permissions:     Object.freeze(["read:asset_metadata"]),
    resourceMultiplier: 1.5, // analiz işi daha ağır olabilir
  }),

  /** Önizleme üretici eklenti — IPreviewExtractor uyumlu */
  "preview-format-extension": Object.freeze({
    id: "preview-format-extension",
    description: "Yeni dosya formatı için önizleme üretimi",
    extensionPoints: Object.freeze(["preview_generator"]),
    permissions:     Object.freeze(["read:asset_metadata"]),
    resourceMultiplier: 1.0,
  }),

  /** İndeks zenginleştirici — yalnızca ek aranabilir alan üretir */
  "index-field-augmenter": Object.freeze({
    id: "index-field-augmenter",
    description: "Arama indeksine ek aranabilir alan katkısı",
    extensionPoints: Object.freeze(["index_augmenter"]),
    permissions:     Object.freeze(["read:search_index"]),
    resourceMultiplier: 0.5,
  }),
});

export type CapabilityProfileId = keyof typeof CAPABILITY_PROFILES;

// ─── Profil Doğrulama ve Çözümleme ────────────────────────────────────────────

export interface ProfileResolution {
  ok:               boolean;
  extensionPoints:  ExtensionPointType[];
  permissions:      PluginPermission[];
  resourceMultiplier: number;
  /** "custom" seçildiyse veya profil bulunamadıysa uyarılar */
  warnings:         string[];
}

/**
 * Bir manifest'in profil seçimini çözümle.
 *
 * - Geçerli bir CapabilityProfileId verilirse → o profilin sabit
 *   extensionPoints/permissions/resourceMultiplier'ı döner (manifest'teki
 *   serbest seçim YOK SAYILIR — profil otoritedir, tutarlılık garantisi).
 * - "custom" verilirse → manifest'in kendi extensionPoints/permissions'ı
 *   kullanılır ama warnings dizisinde bu açıkça işaretlenir (registry
 *   loglarında ve denetim panellerinde görünür olması için).
 */
export function resolveCapabilityProfile(
  profileId:               CapabilityProfileId | "custom",
  customExtensionPoints?:  ExtensionPointType[],
  customPermissions?:      PluginPermission[]
): ProfileResolution {
  if (profileId === "custom") {
    return {
      ok: true,
      extensionPoints:   customExtensionPoints ?? [],
      permissions:       customPermissions ?? [],
      resourceMultiplier: 1.0,
      warnings: [
        'Profil: "custom" — önceden denetlenmiş profil kullanılmıyor. ' +
        "Registry bu plugin'i daha sıkı denetler ve denetim panelinde işaretler.",
      ],
    };
  }

  const profile = CAPABILITY_PROFILES[profileId];
  if (!profile) {
    return {
      ok: false,
      extensionPoints: [], permissions: [], resourceMultiplier: 1.0,
      warnings: [`Bilinmeyen capability profile: "${profileId}"`],
    };
  }

  return {
    ok: true,
    extensionPoints:   [...profile.extensionPoints],
    permissions:       [...profile.permissions],
    resourceMultiplier: profile.resourceMultiplier,
    warnings: [],
  };
}

/** Tüm profil kataloğunu listele (admin paneli / dokümantasyon için) */
export function listCapabilityProfiles(): CapabilityProfile[] {
  return Object.values(CAPABILITY_PROFILES);
}
