/**
 * 1XX1 Güvenlik Analiz Motoru — Ortak Tipler
 * Aşama 12 — Security Analysis Engine
 *
 * Temel prensipler:
 *   - Hiçbir analiz motoru karar vermez → karar Policy Engine'e aittir
 *   - Kara kutu sonuç kabul edilmez → her bulgu açıklanabilir
 *   - Adaptör mimarisi → yeni analizörler drop-in eklenebilir
 *   - Dosya çalıştırılmaz → çalıştırma Aşama 13 Sandbox'a aittir
 *   - Deterministik → aynı girdi → aynı rapor
 */

// ─── Risk Seviyeleri ──────────────────────────────────────────────────────────

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export const RISK_PRIORITY: Record<RiskLevel, number> = {
  none:     0,
  low:      1,
  medium:   2,
  high:     3,
  critical: 4,
};

/** En yüksek risk seviyesini seç */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_PRIORITY[a] >= RISK_PRIORITY[b] ? a : b;
}

// ─── Tekil Bulgu ─────────────────────────────────────────────────────────────

export type FindingCategory =
  | "secret"           // gizli anahtar, şifre, token
  | "shell_exec"       // shell komutu çalıştırma
  | "dynamic_code"     // eval, exec, dinamik kod
  | "network_access"   // HTTP, socket, DNS
  | "fs_access"        // dosya sistemi erişimi (okuma/yazma)
  | "process_spawn"    // süreç oluşturma
  | "binary_exec"      // yürütülebilir payload
  | "suspicious_import"// şüpheli kütüphane importu
  | "compressed_payload"  // içinde sıkıştırılmış payload
  | "license_violation"   // lisans uyumsuzluğu
  | "known_vulnerability" // bilinen CVE
  | "abandoned_dep"       // terk edilmiş bağımlılık
  | "checksum_mismatch"   // checksum uyuşmazlığı
  | "mime_mismatch"       // içerik ≠ MIME iddiası
  | "oversized"           // boyut sınırı aşımı
  | "obfuscated_code"     // gizlenmiş kod
  | "self_modifying"      // kendini değiştiren kod belirtisi
  | "info";              // bilgi niteliğinde (risk yok)

export interface Finding {
  /** Bulgunun benzersiz ID'si */
  id:          string;
  /** Risk seviyesi */
  risk:        RiskLevel;
  /** Kategori */
  category:    FindingCategory;
  /** Kısa başlık */
  title:       string;
  /** Açıklama — kullanıcıya gösterilecek */
  description: string;
  /** Etkilenen dosya yolu (varsa) */
  file?:       string;
  /** Satır numarası (kaynak kodu ise) */
  line?:       number;
  /** Bulgunun hangi parça üzerinde çalıştığı (max 200 karakter) */
  snippet?:    string;
  /** Önerilen düzeltme */
  recommendation?: string;
  /** Hangi analizör buldu */
  analyzer:    string;
}

// ─── Analizör Arayüzü ─────────────────────────────────────────────────────────

export interface AnalysisInput {
  /** Analiz ID'si (pipeline genelinde aynı kalır) */
  analysisId: string;
  /** Dosya adı */
  fileName:   string;
  /** Dosya içeriği */
  data:       Uint8Array;
  /** MIME tipi (metadata'dan) */
  mimeType:   string;
  /** Dosya uzantısı */
  format:     string;
  /** Asset ID (bağlam için) */
  assetId?:   string;
  /** Proje ID'si (dependency analizi için) */
  projectId?: string;
}

export interface AnalyzerResult {
  /** Hangi analizör */
  analyzer:    string;
  /** Bulgular */
  findings:    Finding[];
  /** Bu analizör için toplam risk */
  risk:        RiskLevel;
  /** Analizör kaç ms çalıştı */
  durationMs:  number;
  /** Analizör çalışıp çalışmadı */
  skipped:     boolean;
  /** Atlama sebebi (varsa) */
  skipReason?: string;
}

export interface IAnalyzer {
  readonly name: string;
  /** Bu analizör bu girdi için uygulanabilir mi? */
  canAnalyze(input: AnalysisInput): boolean;
  /** Analiz yürüt */
  analyze(input: AnalysisInput): Promise<AnalyzerResult>;
}

// ─── Analiz Durumu ────────────────────────────────────────────────────────────

export type AnalysisStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

// ─── Yığılmış Rapor ─────────────────────────────────────────────────────────

export interface SecurityReport {
  analysisId:    string;
  assetId?:      string;
  projectId?:    string;
  fileName:      string;
  status:        AnalysisStatus;
  /** Pipeline'daki tüm analizörlerin sonuçları */
  results:       AnalyzerResult[];
  /** Tüm bulgular (tüm analizörlerden) */
  findings:      Finding[];
  /** Hesaplanan toplam risk */
  overallRisk:   RiskLevel;
  /** Özet istatistikler */
  summary: {
    total:       number;
    critical:    number;
    high:        number;
    medium:      number;
    low:         number;
    info:        number;
  };
  /** Policy kararı (engine tarafından doldurulur) */
  decision?:     PolicyDecision;
  startedAt:     Date;
  completedAt?:  Date;
  durationMs?:   number;
}

// ─── Policy Kararı ───────────────────────────────────────────────────────────

export type PolicyDecisionType = "approve" | "reject" | "manual_review";

export interface PolicyDecision {
  decision:    PolicyDecisionType;
  reason:      string;
  /** Hangi bulgular bu karara yol açtı */
  triggers:    string[];   // Finding ID'leri
  decidedAt:   Date;
  decidedBy:   "policy_engine";
}
