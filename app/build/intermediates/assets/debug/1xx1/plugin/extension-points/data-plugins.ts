/**
 * 1XX1 Plugin SDK — Extension Point Arayüzleri (1/2)
 * Aşama 19
 *
 * Her arayüz, mevcut çekirdek sistemdeki gerçek bir entegrasyon noktasına
 * karşılık gelir. Bunlar plugin yazarlarının implemente edeceği sözleşmelerdir.
 *
 *   ISearchPlugin      → search/ modülüne ek skor/filtre katkısı
 *   IAssetProcessor    → asset/ modülüne ek format desteği
 *   IPulseModifier     → pulse/ modülüne sınırlı, denetlenebilir skor katkısı
 *   IIndexAugmenter    → arama indeksine ek alan/metadata katkısı
 *
 * KRİTİK KURAL (INVARIANTS.md ile uyumlu):
 *   Hiçbir plugin arayüzü doğrudan Repository/Store yazmaz.
 *   Hiçbir plugin Pulse sıralamasını parayla ilişkilendiremez (II-1 korunur).
 *   IPulseModifier'ın maksimum etkisi sınırlıdır (aşağıda MAX_PLUGIN_PULSE_WEIGHT).
 */

import type { PluginContext } from "../core/plugin-types.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// ISearchPlugin
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arama sonuçlarına ek skor bileşeni veya filtre katkısı sağlar.
 * Search Engine'in READ-ONLY kuralı (INVARIANTS I-2) burada da geçerlidir:
 * plugin arama indeksine asla yazamaz, yalnızca skor hesaplamasına katkı sağlar.
 */
export interface ISearchPlugin {
  readonly name: string;

  /**
   * Bir arama sonucu adayı için ek skor üret (0–1 aralığında, normalize).
   * Bu skor, ana ScoringEngine'in (Aşama 04) skoruna küçük bir ağırlıkla
   * eklenir — plugin tek başına sıralamayı domine edemez.
   */
  scoreContribution(params: {
    query:      string;
    candidate:  { id: string; type: string; metadata: Record<string, unknown> };
  }): Promise<number>;

  /**
   * Opsiyonel: belirli adayları sonuçlardan filtrele (örn. içerik politikası).
   * true dönerse aday sonuçlarda KALIR, false dönerse elenir.
   */
  shouldInclude?(candidate: { id: string; type: string }): Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IAssetProcessor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Asset Bank'a (Aşama 11) yeni dosya formatı desteği ekler.
 * MetadataEngine'in genişletilmiş hali — plugin yazarı yeni bir
 * AssetType/format kombinasyonu için metadata çıkarımı sağlayabilir.
 */
export interface IAssetProcessor {
  readonly name: string;

  /** Bu processor hangi format/uzantıları işleyebilir? */
  canProcess(format: string, mimeType: string): boolean;

  /**
   * Format'a özgü ek metadata çıkar (asset.entity.ts'teki temel
   * metadata'ya ek olarak — checksum/size zaten çekirdek tarafından yapılır).
   */
  extractMetadata(data: Uint8Array, fileName: string): Promise<{
    customFields: Record<string, string | number | boolean>;
    /** İsteğe bağlı: bu asset bir önizlemeyi destekliyor mu (preview/core entegrasyonu) */
    previewable: boolean;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPulseModifier
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pulse Engine'in (Aşama 10) fairness/ranking hesaplamasına SINIRLI katkı sağlar.
 *
 * GÜVENLİK SINIRI: Plugin'in toplam etkisi MAX_PLUGIN_PULSE_WEIGHT ile sınırlıdır.
 * Bu, "para/bağış sıralamayı hiçbir zaman etkilemez" değişmezini (INVARIANTS II-1)
 * plugin ekosisteminde de korumak içindir — kötü niyetli veya hatalı bir plugin
 * tek başına Pulse sıralamasını domine edemez.
 */
export const MAX_PLUGIN_PULSE_WEIGHT = 0.05; // ana formülün toplam ağırlığının %5'i

export interface IPulseModifier {
  readonly name: string;

  /**
   * Bir proje için ek skor katkısı öner (-1..+1 aralığında, normalize).
   * Ana RankingEngine bu değeri MAX_PLUGIN_PULSE_WEIGHT ile çarparak uygular:
   *   finalScore = coreScore + (modifierScore × MAX_PLUGIN_PULSE_WEIGHT)
   *
   * Asla doğrudan finalScore üretemez — yalnızca öneri sunar.
   */
  proposeAdjustment(params: {
    projectId:   string;
    pulseNumber: number;
    /** Salt-okunur bağlam — plugin bunu mutasyona uğratamaz */
    context: {
      currentRank:   number;
      fairnessScore: number;
      trustScore:    number;
    };
  }): Promise<number>;

  /** Bu modifier'ın önerisi neden bu değer? (şeffaflık — explain() ile uyumlu) */
  explain?(projectId: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IIndexAugmenter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arama indeksine (search/ modülü) ek alan/metadata katkısı sağlar.
 * Örnek kullanım: bir plugin, projeler için "popülerlik trendi" gibi
 * türetilmiş bir alan ekleyip bunu aranabilir hale getirebilir.
 *
 * Augmenter indeksi DOĞRUDAN YAZMAZ — yalnızca indeksleme sırasında
 * çağrılan saf bir fonksiyon sağlar; çekirdek SearchIndex bu veriyi alıp
 * kendi kontrolünde indeksler (I-2 ihlali değil).
 */
export interface IIndexAugmenter {
  readonly name: string;

  /** Hangi varlık tipleri için ek alan üretilecek */
  readonly appliesTo: Array<"project" | "channel" | "asset" | "release">;

  /**
   * Verilen varlık için ek aranabilir alan(lar) üret.
   * Dönen anahtar/değerler SearchIndex'in ReverseIndex'ine
   * `aug:<key>:<value>` formatında eklenir.
   */
  augment(entity: { id: string; type: string; data: Record<string, unknown> }): Promise<Record<string, string>>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin Bazlı Sözleşme Doğrulayıcılar (yardımcı)
// ═══════════════════════════════════════════════════════════════════════════════

/** Bir IPulseModifier önerisinin sınırlar içinde olup olmadığını doğrula */
export function clampPulseAdjustment(raw: number): number {
  return Math.max(-1, Math.min(1, raw)) * MAX_PLUGIN_PULSE_WEIGHT;
}

/** Bir ISearchPlugin skor katkısının [0,1] aralığında olduğunu doğrula */
export function clampSearchScore(raw: number): number {
  return Math.max(0, Math.min(1, raw));
}
