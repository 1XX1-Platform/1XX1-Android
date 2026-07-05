/**
 * 1XX1 Ghost Cube — Tip Tanımları
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Sorumluluk ayrımı (her tip tek iş yapar):
 *   GhostCube        → uzayda geçici rezervasyon noktası (SADECE bu)
 *   GhostRoute       → zincir + alternatif rotalar + döngü koruması
 *   GhostReceipt     → transfer tamamlandıktan sonra kalan iz
 *   GhostReplication → kaç kopya, nerede (DR formülüyle)
 *
 * Ghost asla:
 *   - Veri depolamaz (veri hash'i taşır, kendisi değil)
 *   - Karar vermez (Router kararı verir)
 *   - Kalıcı olmaz (expiresAt sonrası silinir)
 */

import type { CubeCoordinate } from "../../core/types.ts";

// ─── Sabitler ────────────────────────────────────────────────────────────────

/** Varsayılan Ghost ömrü: 10 dakika */
export const GHOST_DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Maksimum hop sayısı (döngü koruması) */
export const GHOST_MAX_HOPS = 30;

/** Maksimum Ghost zinciri uzunluğu */
export const GHOST_MAX_CHAIN = 60;

// ─── Ghost Durumu ─────────────────────────────────────────────────────────────

export type GhostState =
  | "reserved"   // koordinat rezerve edildi, transfer başlamadı
  | "active"     // veri bu ghost üzerinden akıyor
  | "delivered"  // payload iletildi
  | "expired"    // TTL doldu — silinmeyi bekliyor
  | "failed";    // bağlantı koptu

// ─── GhostCube — Uzayda Geçici Rezervasyon ───────────────────────────────────

/**
 * Ghost Küp'ün tek sorumluluğu: mantıksal küp uzayında
 * geçici bir noktayı bir transfer oturumuna REZERVE ETMEK.
 *
 * "Ghost o koordinatı geçici olarak işgal ediyor."
 * İş bitince TTL dolar, koordinat tekrar boşa çıkar.
 */
export interface GhostCube {
  /** Benzersiz ghost kimliği */
  readonly id:          string;
  /** Hangi transfer oturumuna ait */
  readonly sessionId:   string;
  /** Mantıksal küp koordinatı (0-10 her eksen) */
  readonly coordinate:  CubeCoordinate;
  /** Kim rezerve etti (kaynak node) */
  readonly reservedBy:  string;

  // Zincir içi konum
  readonly hopIndex:    number;    // zincirde kaçıncı sırada (0'dan başlar)
  readonly totalHops:   number;    // toplam ghost sayısı

  // Zaman yönetimi
  readonly createdAt:   number;    // unixMs
  readonly expiresAt:   number;    // unixMs — bu andan sonra silinir

  // Durum (mutable — state machine)
  state: GhostState;

  // Taşınan verinin kanıtı (veri kendisi değil!)
  readonly payloadHash: string;    // SHA-256(taşınan veri)
  readonly chunkIndex:  number;    // kaçıncı chunk
  readonly totalChunks: number;    // toplam chunk sayısı
}

// ─── GhostRoute — Zincir + Alternatifler ──────────────────────────────────────

/**
 * Router'ın yönettiği rota bilgisi.
 * Ghost küpler sadece rezervasyon noktaları —
 * zinciri kim nasıl kullanacağını GhostRoute belirler.
 */
export interface GhostRoute {
  readonly sessionId:   string;
  /** Ana zincir: source → G0 → G1 → ... → target */
  readonly chain:       GhostCube[];
  /** Alternatif zincirler (ana rota başarısız olursa) */
  readonly alternatives: GhostCube[][];
  /** Döngü koruması: daha önce geçilen koordinatlar */
  readonly visited:     ReadonlySet<string>;
  /** DR(d) → öncelik seviyesi 1-9 */
  readonly priority:    number;
  /** routingSeed → deterministik seçim */
  readonly seed:        number;
  /** Kaynak ve hedef node'lar */
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  /** Toplam Manhattan mesafesi */
  readonly totalDistance: number;
}

// ─── GhostReceipt — Transfer İzi ──────────────────────────────────────────────

/**
 * Ghost'lar expiresAt sonrası silinir.
 * Ama izleri GhostReceipt olarak her cihazda kalır.
 * Bu iz: kim ne zaman hangi koordinatlardan geçerek veri gönderdi.
 *
 * Parçalı saklama: her cihaz zincirin SADECE kendi gördüğü kısmını saklar.
 */
export interface GhostReceipt {
  readonly sessionId:    string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;

  /** SHA-256(ghost koordinatları birleşimi) — zincir parmak izi */
  readonly routeHash:    string;
  /** SHA-256(taşınan veri) — veri bütünlük kanıtı */
  readonly payloadHash:  string;

  /** Ghost'ların geçtiği koordinatlar (bu cihazın gördüğü kısım) */
  readonly spatialLog:   CubeCoordinate[];
  /** Kaç ghost kullanıldı */
  readonly ghostCount:   number;
  /** DR(d) → öncelik seviyesi */
  readonly priority:     number;
  /** Toplam Manhattan mesafesi */
  readonly distance:     number;

  /** Transfer ne zaman tamamlandı */
  readonly completedAt:  number;
  /** Transfer başarılı mıydı */
  readonly success:      boolean;
  readonly failReason?:  string;

  /**
   * Confidence Score — bu rotaya ne kadar güvenilmeli? (0.0–1.0)
   *
   * Hesaplama:
   *   success=true  → temel 0.7
   *   + sağlık skoru katkısı (GhostHealthMonitor koordinat başarı oranı)
   *   + gecikme cezası (yüksek gecikme → düşük güven)
   *   + replikasyon bonus (kopya sayısı yeterliyse +0.1)
   *
   * 0.90+ → çok güvenilir rota (PathOptimizer önceliklendirir)
   * 0.50  → bilinmiyor / ilk kullanım
   * 0.20- → başarısız rota (PathOptimizer kaçınır)
   *
   * Zaman içinde birikir: aynı rota tekrar kullanılınca güncellenir.
   */
  readonly confidenceScore: number;
}

// ─── GhostReplication — Kopya Yönetimi ───────────────────────────────────────

/**
 * DR(d) formülü burada devreye girer.
 * Ghost sayısını değil, kaç kopya tutulacağını belirler.
 */
export interface GhostReplication {
  readonly sessionId:      string;
  readonly payloadHash:    string;
  /** DR(d) → replication factor (1-9) */
  readonly factor:         number;
  /** Kopyaların saklandığı node'lar */
  readonly copies:         string[];     // nodeId[]
  /** Her kopyanın durumu */
  readonly copyStatus:     Record<string, "pending" | "confirmed" | "lost">;
  /** Yeterli kopya var mı? (copies.length >= factor) */
  readonly satisfied:      boolean;
}

// ─── Session — Transfer Oturumu ───────────────────────────────────────────────

/**
 * Bir transferin tüm bileşenlerini bir arada tutan üst kap.
 * GhostChainBuilder ve GhostRouter bu tipi üretir.
 */
export interface GhostSession {
  readonly sessionId:    string;
  readonly route:        GhostRoute;
  readonly replication:  GhostReplication;
  readonly startedAt:    number;
  status: "building" | "routing" | "transferring" | "completed" | "failed";
  receipt?: GhostReceipt;
}

// ─── Link Context ─────────────────────────────────────────────────────────────

export interface GhostLinkContext {
  /** Arada bilinen fiziksel node sayısı */
  nodeDensity:     number;
  /** Bağlantı kalitesi 0.0-1.0 */
  linkQuality:     number;
  /**
   * Kullanılabilir fiziksel transport'un bant genişliği faktörü:
   *   BLE:          0.1
   *   WiFi Direct:  0.5
   *   LAN:          1.0
   */
  bandwidthFactor: number;
}
