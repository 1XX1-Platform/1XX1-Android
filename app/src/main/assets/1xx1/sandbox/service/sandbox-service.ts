/**
 * 1XX1 Sandbox Service — Ana Orkestratör
 * Aşama 13 — Sandbox
 *
 * Akış:
 *   1. Statik analiz raporu alındıysa kontrol et (isteğe bağlı)
 *   2. SessionManager'a kaydet
 *   3. ISandboxAdapter.run() → BehaviorReport
 *   4. BehaviorMonitor ihlalleri analiz et
 *   5. Policy Engine karar ver
 *   6. Domain event yayınla
 *
 * Kritik kural: SandboxService karar vermez.
 * "approve/reject/review" kararı Policy Engine'den gelir.
 */

import type { ISandboxAdapter, BehaviorReport, ResourceLimits } from "../sandbox-types.ts";
import { DEFAULT_LIMITS } from "../sandbox-types.ts";
import { SessionManager } from "../session/session-manager.ts";
import { BehaviorMonitor } from "../monitor/behavior-monitor.ts";
import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import type { SecurityReport } from "../../security/security-types.ts";
import { succeed, fail } from "../../application/commands/commands.ts";
import type { CommandOutcome } from "../../application/commands/commands.ts";

// ─── Sandbox Çalıştırma Komutu ───────────────────────────────────────────────

export interface RunSandboxCommand {
  command:         string;
  data:            Uint8Array;
  limits?:         Partial<ResourceLimits>;
  projectId?:      string;
  releaseId?:      string;
  assetId?:        string;
  /** Aşama 12 statik analiz raporunu eklersek ön kontrol yapılır */
  staticReport?:   SecurityReport;
}

export interface SandboxResult {
  sessionId:    string;
  report:       BehaviorReport;
  /** Policy kararı */
  decision:     "approve" | "manual_review" | "reject";
  decisionNote: string;
}

// ─── SandboxService ───────────────────────────────────────────────────────────

export class SandboxService {
  private readonly monitor  = new BehaviorMonitor();
  private readonly sessions = new SessionManager();

  constructor(
    adapter:   ISandboxAdapter,
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.adapter = adapter;}

  // ─── Çalıştır ────────────────────────────────────────────────────────────

  async run(cmd: RunSandboxCommand): Promise<CommandOutcome<SandboxResult>> {
    // Adaptör müsait mi?
    if (!(await this.adapter.isAvailable())) {
      return fail("ADAPTER_UNAVAILABLE", `Sandbox adaptörü hazır değil: ${this.adapter.name}`);
    }

    // Eşzamanlı oturum sınırı
    const session = this.sessions.register({
      projectId: cmd.projectId,
      releaseId: cmd.releaseId,
      assetId:   cmd.assetId,
      limits:    { ...DEFAULT_LIMITS, ...cmd.limits },
      status:    "running",
      command:   cmd.command,
    });

    if (!session) {
      return fail("SESSION_LIMIT", "Maksimum eşzamanlı sandbox oturumu sınırına ulaşıldı");
    }

    // Statik analiz ön kontrolü (kesin reject varsa sandbox'a girme)
    if (cmd.staticReport?.decision?.decision === "reject") {
      this.sessions.complete(session.sessionId, "cancelled");
      return fail("PRE_REJECTED",
        `Statik analiz reddi: ${cmd.staticReport.decision.reason}`);
    }

    this.eventBus?.emit("sandbox:started" as never, {
      sessionId: session.sessionId,
      adapter:   this.adapter.name,
      command:   cmd.command,
    });

    this.logger?.info(`Sandbox başladı: ${session.sessionId} (${this.adapter.name})`);

    let report: BehaviorReport;
    try {
      report = await this.adapter.run(
        cmd.command,
        cmd.data,
        session.limits,
        session.sessionId
      );
    } catch (err) {
      this.sessions.complete(session.sessionId, "crashed", -1);
      this.eventBus?.emit("sandbox:terminated" as never, { sessionId: session.sessionId });
      return fail("SANDBOX_ERROR", err instanceof Error ? err.message : "Sandbox çöküşü");
    }

    // Oturumu tamamla
    this.sessions.complete(session.sessionId, report.session.status, report.session.exitCode);

    // Davranış analizi
    const analysis = this.monitor.analyze(report.events, session.limits);

    // Ihlal varsa event yayınla
    for (const v of analysis.violations) {
      this.eventBus?.emit("behavior:detected" as never, {
        sessionId: session.sessionId,
        category:  v.category,
        detail:    v.detail,
      });
    }

    // Policy kararı
    const { decision, note } = this._makeDecision(report, analysis.violations.length);

    // Timeout / killed event
    if (report.session.status === "timeout") {
      this.eventBus?.emit("sandbox:timeout" as never, { sessionId: session.sessionId });
    }

    this.eventBus?.emit("sandbox:completed" as never, {
      sessionId: session.sessionId,
      decision,
      violations: analysis.violations.length,
      durationMs: report.session.durationMs,
    });

    this.logger?.info(
      `Sandbox tamamlandı: ${session.sessionId} — ${decision.toUpperCase()} ` +
      `(${analysis.violations.length} ihlal, ${report.session.durationMs ?? 0}ms)`
    );

    return succeed({
      sessionId:    session.sessionId,
      report,
      decision,
      decisionNote: note,
    });
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  getSession(sessionId: string) { return this.sessions.get(sessionId); }
  activeCount()                 { return this.sessions.stats().active; }
  sessionStats()                { return this.sessions.stats(); }
  recentHistory(n = 10)         { return this.sessions.recentHistory(n); }

  // ─── Policy Kararı ───────────────────────────────────────────────────────

  private _makeDecision(
    report:         BehaviorReport,
    violationCount: number
  ): { decision: "approve" | "manual_review" | "reject"; note: string } {
    // Sandbox çöktü → reddet
    if (report.session.status === "crashed") {
      return { decision: "reject", note: "Sandbox çalıştırma sırasında çöküş oluştu" };
    }

    // Timeout → incelemeye al
    if (report.session.status === "timeout") {
      return { decision: "manual_review", note: "Zaman aşımı — beklenenden uzun çalışma" };
    }

    // İhlal varsa
    if (violationCount > 0) {
      if (report.attemptedNetwork || report.spawnedProcess) {
        return { decision: "reject", note: `${violationCount} ihlal (ağ/süreç başlatma girişimi)` };
      }
      return { decision: "manual_review", note: `${violationCount} davranış ihlali tespit edildi` };
    }

    // Temiz
    return { decision: "approve", note: "Olağan dışı davranış gözlemlenmedi" };
  }
}
