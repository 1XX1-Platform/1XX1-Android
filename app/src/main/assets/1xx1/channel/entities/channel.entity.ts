/**
 * 1XX1 Kanal (Ada) Domain Entity'leri
 * Aşama 09 — Kanal Sistemi 2.0
 *
 * Her geliştirici bir "ada" (island) sahibidir.
 * Ada = mikro ekosistem: projeler + sürümler + varlıklar + cüzdanlar + takipçiler
 *
 * Tasarım prensibi:
 *   - Platform hiçbir ödeme işlemez — cüzdanlar yalnızca görüntülenir
 *   - Reklam yok, algoritma yok — takip = yalnızca bildirim
 *   - Trust Score açıklanabilir metriklerden oluşur
 *   - Her entity bağımsız yaşam döngüsüne sahiptir
 */

// ─── Görünürlük ───────────────────────────────────────────────────────────────

export type ChannelVisibility = "public" | "unlisted" | "private";

// ─── Cüzdan ──────────────────────────────────────────────────────────────────

export type CryptoNetwork = "bitcoin" | "ethereum" | "monero" | "litecoin" | "custom";

export interface Wallet {
  id:        string;
  network:   CryptoNetwork;
  address:   string;
  label?:    string;      // "BTC bağış" gibi kısa etiket
  addedAt:   Date;
}

// ─── Kanal (Ada) Entity ───────────────────────────────────────────────────────

export interface Channel {
  id:          string;
  ownerId:     string;        // developer ID
  slug:        string;        // URL-safe: "kaptan-studio"
  mask?:       string;        // takma kimlik gösterim adı
  title:       string;        // "Kaptan Stüdyo"
  description: string;
  visibility:  ChannelVisibility;
  wallets:     Wallet[];
  verified:    boolean;
  tags:        string[];      // kanal kategorileri
  socialLinks: SocialLink[];
  stats:       ChannelStats;
  createdAt:   Date;
  updatedAt:   Date;
}

export interface SocialLink {
  platform: "github" | "gitlab" | "website" | "mastodon" | "matrix" | "custom";
  url:      string;
  label?:   string;
}

export interface ChannelStats {
  projectCount:   number;
  releaseCount:   number;
  followerCount:  number;
  totalDownloads: number;  // Aşama 11'de doldurulacak
  lastActivity:   Date;
}

// ─── Sürüm (Release) ─────────────────────────────────────────────────────────

export type ReleaseStatus =
  | "draft"        // hazırlanıyor
  | "published"    // yayında
  | "deprecated"   // kullanımı önerilmiyor
  | "yanked";      // kritik hata — indirme engellendi

/** Semantik versiyon: major.minor.patch[-prerelease] */
export interface SemanticVersion {
  major:      number;
  minor:      number;
  patch:      number;
  prerelease?: string;   // "alpha.1", "beta.2", "rc.1"
}

export type PlatformTarget =
  | "windows-x64" | "windows-arm64"
  | "linux-x64"   | "linux-arm64"   | "linux-x86"
  | "macos-x64"   | "macos-arm64"
  | "wasm"        | "android"       | "ios"
  | "source"      | "universal";

export interface ReleaseArtifact {
  id:           string;
  name:         string;           // "myapp-1.0.0-linux-x64.tar.gz"
  platform:     PlatformTarget;
  size:         number;           // byte
  downloadUrl:  string;
  checksums: {
    sha256?: string;
    sha512?: string;
    blake3?: string;
  };
  signedBy?:    string;           // GPG key fingerprint
  uploadedAt:   Date;
}

export interface Release {
  id:          string;
  projectId:   string;
  channelId:   string;
  version:     SemanticVersion;
  versionStr:  string;            // "1.0.0" veya "1.0.0-beta.1"
  title:       string;            // "v1.0.0 — Kararlı Sürüm"
  notes:       string;            // Markdown sürüm notları
  status:      ReleaseStatus;
  artifacts:   ReleaseArtifact[];
  tags:        string[];
  isLatest:    boolean;
  isPrerelease: boolean;
  publishedAt?: Date;
  deprecatedAt?: Date;
  createdAt:   Date;
  updatedAt:   Date;
}

// ─── Takip (Follow) ──────────────────────────────────────────────────────────

export interface ChannelFollow {
  followerId: string;   // developer ID veya anonim token
  channelId:  string;
  followedAt: Date;
  /** Bildirim tercihleri */
  notify: {
    onRelease:    boolean;
    onDeprecated: boolean;
  };
}

// ─── Trust Score ─────────────────────────────────────────────────────────────

/**
 * Açıklanabilir güven metrikleri.
 * Her metrik boolean veya 0–1 arası skor taşır.
 * Hiçbir kara kutu — kullanıcı her metriği görebilir.
 */
export interface TrustMetrics {
  /** Tüm projeler OSI onaylı açık kaynak lisans taşıyor mu? */
  openSource:          boolean;
  /** En az bir proje platform tarafından doğrulandı mı? */
  verified:            boolean;
  /** Yeniden üretilebilir derleme kanıtı var mı? */
  reproducibleBuild:   boolean;
  /** En az bir sürüm GPG ile imzalandı mı? */
  signedRelease:       boolean;
  /** Güvenlik taramasından geçti mi? (Aşama 12'de doldurulacak) */
  securityScan:        boolean;
  /** Bakımcı son 90 gün içinde aktif mi? */
  maintainerActivity:  boolean;
  /** Hesaplanan ağırlıklı toplam (0–100) */
  totalScore:          number;
  /** Son hesaplama zamanı */
  calculatedAt:        Date;
}

export interface TrustScore {
  channelId: string;
  metrics:   TrustMetrics;
  /** Kısa açıklama: "4/6 kriter karşılandı" */
  summary:   string;
  /** Değişim geçmişi (son 5) */
  history:   Array<{ score: number; at: Date }>;
}

// ─── Kanal Özet Görünümü (API yanıtı) ────────────────────────────────────────

export interface ChannelSummary {
  id:          string;
  slug:        string;
  title:       string;
  description: string;
  ownerId:     string;
  verified:    boolean;
  trustScore:  number;   // 0–100
  stats:       ChannelStats;
  tags:        string[];
  createdAt:   string;   // ISO
}

export function toChannelSummary(ch: Channel, trustScore = 0): ChannelSummary {
  return {
    id:          ch.id,
    slug:        ch.slug,
    title:       ch.title,
    description: ch.description,
    ownerId:     ch.ownerId,
    verified:    ch.verified,
    trustScore,
    stats:       ch.stats,
    tags:        ch.tags,
    createdAt:   ch.createdAt.toISOString(),
  };
}
