/**
 * 1XX1 Plugin SDK — Extension Point Arayüzleri (2/2)
 * Aşama 19
 *
 *   IEventInterceptor      → herhangi bir domain event'ini gözlemleme (salt-okunur)
 *   ISecurityAnalyzerPlugin → security/ modülüne ek analiz kuralı (IAnalyzer uyumlu)
 *   IPreviewGeneratorPlugin → preview/core/ modülüne ek format desteği (IPreviewExtractor uyumlu)
 *   IConsensusExtension     → consensus/ modülüne salt-okunur gözlem (asla oy/komut önermez)
 */

// Mevcut çekirdek arayüzlerle bilinçli tip uyumu — plugin yazarı zaten
// bildiği IAnalyzer/IPreviewExtractor desenini burada da kullanır.
import type {
  AnalysisInput, AnalyzerResult,
} from "../../security/security-types.ts";
import type {
  ExtractParams, PreviewResult,
} from "../../preview/core/preview-types.ts";
import type { ConsensusState, PulseBlock } from "../../consensus/consensus-types.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// IEventInterceptor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sistemdeki herhangi bir domain event'ini gözlemler.
 *
 * KRİTİK SINIR: Interceptor asla event'i MUTASYONA UĞRATAMAZ veya
 * event akışını DURDURAMAZ — yalnızca pasif gözlemci (audit log,
 * webhook tetikleme, metrik toplama gibi yan etkiler için).
 * Bu, EventBus'ın "hiçbir zaman Storage'ı bilmez" kuralının (I-7)
 * plugin tarafındaki yansımasıdır: interceptor da Storage'a yazamaz,
 * yalnızca emitEvent() ile YENİ event üretebilir (PluginContext üzerinden).
 */
export interface IEventInterceptor {
  readonly name: string;

  /** Hangi event türlerini dinlemek istiyor (boş = hepsi) */
  readonly eventFilter?: string[];

  /**
   * Event geldiğinde çağrılır. Dönüş değeri YOKTUR — bu kasıtlıdır,
   * interceptor event akışını etkileyemez (fire-and-forget).
   */
  onEvent(eventType: string, payload: Record<string, unknown>, timestamp: number): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ISecurityAnalyzerPlugin
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aşama 12'nin IAnalyzer arayüzüyle YAPISAL OLARAK UYUMLUDUR — bir plugin
 * yazarı bu arayüzü implemente ederse, AnalysisPipeline'a doğrudan
 * (PluginAnalyzerAdapter ile) eklenebilir.
 *
 * Fark: çekirdek IAnalyzer'lar (StaticAnalyzer, BinaryAnalyzer vb.) güvenilir
 * kod olarak doğrudan çalışır; plugin analizörler SANDBOX içinde çalışır
 * (Aşama 13 ISandboxAdapter ile izole edilir).
 */
export interface ISecurityAnalyzerPlugin {
  readonly name: string;
  canAnalyze(input: AnalysisInput): boolean;
  analyze(input: AnalysisInput): Promise<AnalyzerResult>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPreviewGeneratorPlugin
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aşama 17'nin IPreviewExtractor arayüzüyle YAPISAL OLARAK UYUMLUDUR.
 * PreviewService.registerExtractor() zaten bu genişlemeye Aşama 17'de
 * hazırlanmıştı — Plugin SDK onu resmi hale getirir.
 *
 * Platform bağımsızlık kuralı (I-11) plugin'ler için de geçerlidir:
 * bir IPreviewGeneratorPlugin asla document/window/HTMLElement kullanamaz.
 */
export interface IPreviewGeneratorPlugin {
  readonly name: string;
  canExtract(mimeType: string, ext: string): boolean;
  extract(params: ExtractParams): Promise<PreviewResult>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IConsensusExtension
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Consensus katmanına (Aşama 15/18) SALT-OKUNUR gözlem erişimi sağlar.
 *
 * KRİTİK SINIR: Bir plugin asla Raft'a komut öneremez (propose), asla
 * validator olamaz, asla oy kullanamaz. Bu, sistemin Sybil-direnç
 * garantisini korur (ADR-006: "Herkes Raft'a katılırsa Sybil attack riski").
 *
 * Kullanım örnekleri: dashboard için consensus durumu izleme, Pulse blok
 * zincirini harici bir denetim sistemine yansıtma, anomali tespiti.
 */
export interface IConsensusExtension {
  readonly name: string;

  /** Raft durumu değiştiğinde çağrılır (lider seçimi, term değişimi vb.) */
  onStateChange?(state: ConsensusState): Promise<void>;

  /** Yeni bir Pulse bloğu commit edildiğinde çağrılır */
  onPulseBlockCommitted?(block: PulseBlock): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adapter Yardımcıları — Plugin Arayüzünü Çekirdek Arayüze Köprüler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bir ISecurityAnalyzerPlugin'i, Aşama 12'nin AnalysisPipeline'ının
 * beklediği IAnalyzer arayüzüne uyarlar. Sandbox içinde çalıştırma
 * sorumluluğu PluginSandboxRunner'a aittir (bkz. plugin/sandbox/).
 */
export function adaptSecurityPlugin(plugin: ISecurityAnalyzerPlugin) {
  return {
    name: `plugin:${plugin.name}`,
    canAnalyze: (input: AnalysisInput) => plugin.canAnalyze(input),
    analyze:    (input: AnalysisInput) => plugin.analyze(input),
  };
}

/** Bir IPreviewGeneratorPlugin'i, PreviewService.registerExtractor() için uyarlar */
export function adaptPreviewPlugin(plugin: IPreviewGeneratorPlugin) {
  return {
    name: `plugin:${plugin.name}`,
    canExtract: (mimeType: string, ext: string) => plugin.canExtract(mimeType, ext),
    extract:    (params: ExtractParams) => plugin.extract(params),
  };
}
