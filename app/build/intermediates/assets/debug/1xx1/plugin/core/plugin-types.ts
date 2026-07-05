/**
 * 1XX1 Plugin SDK — Çekirdek Tipler
 * Aşama 19 — Plugin SDK
 *
 * Mimari geçiş: "distributed system core" → "platform ecosystem"
 *
 * Temel prensip: sistem çekirdeği DEĞİŞMEDEN genişler.
 * Mevcut genişleme noktaları (IAnalyzer, IPreviewExtractor, ISandboxAdapter)
 * zaten birer mikro-plugin arayüzüydü — bu SDK onları resmi, yönetilen,
 * sandboxed bir çatı altında birleştirir.
 *
 * Her plugin:
 *   1. IPlugin sözleşmesini implemente eder (name, version, init, shutdown)
 *   2. Bir veya daha fazla Extension Point'e bağlanır
 *   3. Sandbox içinde çalışır (Aşama 13 ISandboxAdapter ile izole)
 *   4. Yalnızca event-only iletişim kurar — doğrudan core state erişimi yok
 */

// ─── Plugin Kimliği ───────────────────────────────────────────────────────────

/** Semantik versiyon string: "1.2.3" veya "1.2.3-beta.1" */
export type SemVerString = string;

export interface PluginIdentity {
  /** Benzersiz plugin adı (örn. "1xx1-search-fuzzy-tr") */
  name:        string;
  /** Plugin versiyonu */
  version:     SemVerString;
  /** Yayıncı/geliştirici ID'si */
  publisherId: string;
  /** İnsan okunabilir açıklama */
  description: string;
}

// ─── Extension Point Tipleri ──────────────────────────────────────────────────

/**
 * Bir plugin'in bağlanabileceği genişleme noktaları.
 * Her tip, mevcut sistemdeki gerçek bir arayüze karşılık gelir:
 *   search          → ISearchPlugin (search/ modülüne ek skor/filtre)
 *   asset_processor → IAssetProcessor (asset/ modülüne ek format desteği)
 *   pulse_hook      → IPulseModifier (pulse/ modülüne ek fairness/skor kuralı)
 *   index_augmenter → arama indeksine ek alan/skor katkısı
 *   event_interceptor → herhangi bir domain event'ini gözlemleme (asla mutasyon)
 *   security_analyzer → IAnalyzer (security/ modülüne ek analiz kuralı)
 *   preview_generator → IPreviewExtractor (preview/core/ modülüne ek format)
 *   consensus_extension → IConsensusExtension (consensus/ modülüne salt-okunur gözlem)
 */
export type ExtensionPointType =
  | "search"
  | "asset_processor"
  | "pulse_hook"
  | "index_augmenter"
  | "event_interceptor"
  | "security_analyzer"
  | "preview_generator"
  | "consensus_extension";

// ─── Plugin Manifest ──────────────────────────────────────────────────────────

/**
 * Bir plugin'in kurulum öncesi beyan ettiği statik bilgi.
 * Registry, manifest'i sandbox'a girmeden önce doğrular.
 */
export interface PluginManifest {
  identity:          PluginIdentity;
  /** Hangi extension point(ler)e bağlanacak */
  extensionPoints:   ExtensionPointType[];
  /** Bu plugin'in ihtiyaç duyduğu izinler (en az ayrıcalık prensibi) */
  permissions:       PluginPermission[];
  /** Bağımlı olduğu diğer plugin'ler (varsa) */
  dependencies?:     Array<{ name: string; versionRange: string }>;
  /** Desteklenen 1XX1 platform versiyon aralığı */
  platformVersion:   string;
  /** Lisans (Aşama 11 AssetLicenseType ile uyumlu) */
  license:           string;
}

// ─── İzin Modeli ──────────────────────────────────────────────────────────────

/**
 * Plugin'in talep edebileceği izinler.
 * Varsayılan: hiçbir izin yok (deny-by-default).
 * Sandbox (Aşama 13 ResourceLimits ile) yalnızca izin verilenleri açar.
 */
export type PluginPermission =
  | "read:search_index"      // arama indeksini okuyabilir
  | "read:pulse_snapshot"     // güncel pulse listesini okuyabilir
  | "read:asset_metadata"     // asset metadata'sını okuyabilir (binary değil)
  | "write:search_score"      // arama skoruna katkı sağlayabilir
  | "write:pulse_score"       // pulse fairness skoruna katkı sağlayabilir (sınırlı ağırlık)
  | "emit:event"              // domain event yayınlayabilir (yeni event türü)
  | "network:none";           // (varsayılan, açıkça belirtilmesi önerilir)

export const NO_PERMISSIONS: readonly PluginPermission[] = Object.freeze([]);

// ─── Plugin Yaşam Döngüsü Durumu ──────────────────────────────────────────────

export type PluginStatus =
  | "registered"   // manifest doğrulandı, henüz init edilmedi
  | "initializing" // init() çalışıyor
  | "active"       // çalışıyor, extension point'lere bağlı
  | "suspended"     // geçici olarak durduruldu (hata/limit aşımı)
  | "shutting_down" // shutdown() çalışıyor
  | "stopped"       // tamamen durduruldu
  | "failed";       // init veya çalışma sırasında kurtarılamaz hata

// ─── Çekirdek IPlugin Arayüzü ─────────────────────────────────────────────────

/**
 * Her plugin'in implemente etmesi gereken minimal sözleşme.
 * Bu arayüz kasıtlı olarak küçük tutulmuştur — gerçek işlevsellik
 * extension-points/ altındaki spesifik arayüzlerden (ISearchPlugin vb.) gelir.
 */
export interface IPlugin {
  readonly manifest: PluginManifest;

  /**
   * Plugin başlatılırken çağrılır.
   * PluginContext üzerinden yalnızca izin verilen kaynaklara erişebilir.
   */
  init(ctx: PluginContext): Promise<void>;

  /**
   * Plugin durdurulurken çağrılır — kaynakları temizler.
   * shutdown() asla atlanmaz; hata fırlatsa bile registry devam eder.
   */
  shutdown(): Promise<void>;

  /**
   * Sağlık kontrolü — registry periyodik olarak çağırabilir.
   * Plugin kendi iç durumunu raporlar (örn. "hâlâ çalışıyor mu").
   */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

// ─── Plugin Context (Sandbox'tan Plugin'e Sağlanan Sınırlı API) ──────────────

/**
 * Plugin'in dış dünya ile TEK temas noktası.
 * Doğrudan core state erişimi YOK — yalnızca bu context üzerinden,
 * yalnızca manifest'te beyan edilen izinler kapsamında etkileşim mümkün.
 */
export interface PluginContext {
  readonly pluginName: string;
  readonly permissions: readonly PluginPermission[];

  /** Yalnızca event-only iletişim — doğrudan fonksiyon çağrısı yok */
  emitEvent(eventType: string, payload: Record<string, unknown>): void;

  /** İzin varsa salt-okunur veri erişimi (kategori bazlı, granüler) */
  readResource<T = unknown>(resource: PluginPermission, query?: Record<string, unknown>): Promise<T | null>;

  /** Plugin'e özel loglama — ana sistem logger'ından izole */
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

// ─── Manifest Doğrulama ───────────────────────────────────────────────────────

export interface ManifestValidationResult {
  ok:     boolean;
  errors: string[];
}

const VALID_EXTENSION_POINTS = new Set<ExtensionPointType>([
  "search", "asset_processor", "pulse_hook", "index_augmenter",
  "event_interceptor", "security_analyzer", "preview_generator", "consensus_extension",
]);

const VALID_PERMISSIONS = new Set<PluginPermission>([
  "read:search_index", "read:pulse_snapshot", "read:asset_metadata",
  "write:search_score", "write:pulse_score", "emit:event", "network:none",
]);

/** Plugin kuralları: name regex, version semver, en az 1 extension point */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

export function validateManifest(manifest: PluginManifest): ManifestValidationResult {
  const errors: string[] = [];

  if (!NAME_PATTERN.test(manifest.identity.name)) {
    errors.push(`Geçersiz plugin adı: "${manifest.identity.name}" (küçük harf, rakam, -, _ ; 3-64 karakter)`);
  }
  if (!SEMVER_PATTERN.test(manifest.identity.version)) {
    errors.push(`Geçersiz versiyon: "${manifest.identity.version}" (semver bekleniyor: x.y.z)`);
  }
  if (!manifest.identity.publisherId) {
    errors.push("publisherId zorunludur");
  }
  if (manifest.extensionPoints.length === 0) {
    errors.push("En az bir extensionPoint belirtilmelidir");
  }
  for (const ep of manifest.extensionPoints) {
    if (!VALID_EXTENSION_POINTS.has(ep)) {
      errors.push(`Bilinmeyen extension point: "${ep}"`);
    }
  }
  for (const p of manifest.permissions) {
    if (!VALID_PERMISSIONS.has(p)) {
      errors.push(`Bilinmeyen izin: "${p}"`);
    }
  }
  // write:pulse_score izni yalnızca pulse_hook extension point ile birlikte anlamlı
  if (manifest.permissions.includes("write:pulse_score") &&
      !manifest.extensionPoints.includes("pulse_hook")) {
    errors.push('write:pulse_score izni yalnızca "pulse_hook" extension point ile kullanılabilir');
  }
  if (manifest.permissions.includes("write:search_score") &&
      !manifest.extensionPoints.includes("search")) {
    errors.push('write:search_score izni yalnızca "search" extension point ile kullanılabilir');
  }

  return { ok: errors.length === 0, errors };
}
