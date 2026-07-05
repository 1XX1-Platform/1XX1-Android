/**
 * 1XX1 Analysis Pipeline — Ana Orkestratör
 * Aşama 12 — Security Analysis Engine
 *
 * Akış:
 *   Input
 *     → MetadataAnalyzer   (her dosya)
 *     → StaticAnalyzer     (kaynak kodu)
 *     → BinaryAnalyzer     (binary/wasm)
 *     → DependencyAnalyzer (bağımlılık dosyaları)
 *     → RiskEngine.aggregate()
 *     → PolicyEngine.decide()
 *   → SecurityReport
 *
 * Özellikler:
 *   - Paralel analizör çalıştırma (Promise.allSettled)
 *   - Analizör hatası pipeline'ı durdurmaz
 *   - Her analizör bağımsız çalışır
 *   - Deterministik: aynı girdi → aynı rapor
 *   - EventBus entegrasyonu
 */

import type {
  IAnalyzer, AnalysisInput, SecurityReport, AnalyzerResult, AnalysisStatus,
} from "../security-types.ts";
import { RiskEngine, PolicyEngine } from "../risk/risk-policy.ts";
import { StaticAnalyzer } from "../analyzers/static-analyzer.ts";
import { BinaryAnalyzer, MetadataAnalyzerChecker, DependencyAnalyzerChecker } from "../analyzers/other-analyzers.ts";
import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import { generateId } from "../../core/utils.ts";

// ─── Pipeline Yapılandırması ──────────────────────────────────────────────────

export interface PipelineConfig {
  /** Tek analizör için maksimum süre (ms) */
  analyzerTimeoutMs: number;
  /** Pipeline'ı iptal et (büyük dosya vb.) */
  maxInputSizeBytes: number;
  /** Paralel mi, sıralı mı çalıştır */
  parallel: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
  analyzerTimeoutMs: 10_000,  // 10 saniye
  maxInputSizeBytes: 100 * 1024 * 1024, // 100 MB
  parallel: true,
};

// ─── AnalysisPipeline ─────────────────────────────────────────────────────────

export class AnalysisPipeline {
  private readonly riskEngine   = new RiskEngine();
  private readonly policyEngine: PolicyEngine;
  private readonly analyzers:    IAnalyzer[];
  private readonly cfg:          PipelineConfig;

  constructor(
    analyzers?:    IAnalyzer[],
    policyEngine?: PolicyEngine,
    cfg:           Partial<PipelineConfig> = {},
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.cfg          = { ...DEFAULT_CONFIG, ...cfg };
    this.policyEngine = policyEngine ?? new PolicyEngine();
    this.analyzers    = analyzers ?? [
      new MetadataAnalyzerChecker(),
      new StaticAnalyzer(),
      new BinaryAnalyzer(),
      new DependencyAnalyzerChecker(),
    ];
  }

  /**
   * Tam analiz pipeline'ı çalıştır.
   * @param input     Analiz edilecek girdi
   * @returns         Tamamlanmış SecurityReport
   */
  async run(input: AnalysisInput): Promise<SecurityReport> {
    const startedAt  = new Date();
    const analysisId = input.analysisId;

    this.logger?.info(`Analiz başladı: ${analysisId} (${input.fileName}, ${input.data.byteLength} byte)`);

    // Yayın: analiz başladı
    this.eventBus?.emit("analysis:started" as never, {
      analysisId, fileName: input.fileName, assetId: input.assetId,
    });

    // Boyut kontrolü
    if (input.data.byteLength > this.cfg.maxInputSizeBytes) {
      const report = this._failReport(input, startedAt, `Dosya çok büyük: ${input.data.byteLength} byte`);
      this.eventBus?.emit("analysis:failed" as never, { analysisId, reason: report.status });
      return report;
    }

    // Analizörleri çalıştır
    let results: AnalyzerResult[];
    try {
      results = this.cfg.parallel
        ? await this._runParallel(input)
        : await this._runSequential(input);
    } catch (err) {
      const report = this._failReport(input, startedAt, err instanceof Error ? err.message : "Pipeline hatası");
      this.eventBus?.emit("analysis:failed" as never, { analysisId });
      return report;
    }

    // Risk topla
    const { findings, overallRisk, summary } = this.riskEngine.aggregate(results);
    const sortedFindings = this.riskEngine.sortFindings(findings);

    // Kısmi rapor (karar hariç)
    const partial: Omit<SecurityReport, "decision"> = {
      analysisId,
      assetId:    input.assetId,
      projectId:  input.projectId,
      fileName:   input.fileName,
      status:     "completed",
      results,
      findings:   sortedFindings,
      overallRisk,
      summary,
      startedAt,
      completedAt: new Date(),
      durationMs:  Date.now() - startedAt.getTime(),
    };

    // Policy kararı
    const decision = this.policyEngine.decide(partial);

    const report: SecurityReport = { ...partial, decision };

    this.logger?.info(
      `Analiz tamamlandı: ${analysisId} — ${decision.decision.toUpperCase()} ` +
      `(${summary.critical}C/${summary.high}H/${summary.medium}M/${summary.low}L, ${partial.durationMs}ms)`
    );

    // Yayın: tamamlandı
    this.eventBus?.emit("analysis:completed" as never, {
      analysisId, decision: decision.decision, overallRisk,
    });

    // Yayın: onay / ret
    if (decision.decision === "approve") {
      this.eventBus?.emit("analysis:approved" as never, { analysisId, assetId: input.assetId });
    } else if (decision.decision === "reject") {
      this.eventBus?.emit("analysis:rejected" as never, {
        analysisId, assetId: input.assetId, reason: decision.reason,
      });
    }

    return report;
  }

  // ─── Paralel Çalıştırma ───────────────────────────────────────────────────

  private async _runParallel(input: AnalysisInput): Promise<AnalyzerResult[]> {
    const tasks = this.analyzers.map((a) => this._runWithTimeout(a, input));
    const settled = await Promise.allSettled(tasks);

    return settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const analyzer = this.analyzers[i].name;
      this.logger?.warn(`Analizör hatası: ${analyzer} — ${s.reason}`);
      return {
        analyzer,
        findings:   [],
        risk:       "none" as const,
        durationMs: 0,
        skipped:    true,
        skipReason: `Hata: ${s.reason}`,
      };
    });
  }

  private async _runSequential(input: AnalysisInput): Promise<AnalyzerResult[]> {
    const results: AnalyzerResult[] = [];
    for (const a of this.analyzers) {
      try {
        results.push(await this._runWithTimeout(a, input));
      } catch (err) {
        this.logger?.warn(`Analizör hatası: ${a.name} — ${err}`);
        results.push({
          analyzer: a.name, findings: [], risk: "none",
          durationMs: 0, skipped: true, skipReason: `Hata: ${err}`,
        });
      }
    }
    return results;
  }

  private async _runWithTimeout(
    analyzer: IAnalyzer,
    input:    AnalysisInput
  ): Promise<AnalyzerResult> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${analyzer.name}`)), this.cfg.analyzerTimeoutMs)
    );
    return Promise.race([analyzer.analyze(input), timeout]);
  }

  // ─── Yardımcılar ─────────────────────────────────────────────────────────

  private _failReport(
    input:     AnalysisInput,
    startedAt: Date,
    reason:    string
  ): SecurityReport {
    return {
      analysisId: input.analysisId,
      assetId:    input.assetId,
      fileName:   input.fileName,
      status:     "failed" as AnalysisStatus,
      results:    [],
      findings:   [],
      overallRisk: "none",
      summary:    { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      startedAt,
      completedAt: new Date(),
      durationMs:  Date.now() - startedAt.getTime(),
      decision: {
        decision: "reject",
        reason,
        triggers:  [],
        decidedAt: new Date(),
        decidedBy: "policy_engine",
      },
    };
  }
}

// ─── Yardımcı: AnalysisInput Oluşturucu ─────────────────────────────────────

export function createAnalysisInput(
  data:      Uint8Array,
  fileName:  string,
  mimeType:  string,
  overrides: Partial<AnalysisInput> = {}
): AnalysisInput {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return {
    analysisId: `anl_${generateId()}`,
    fileName,
    data,
    mimeType,
    format: ext,
    ...overrides,
  };
}
