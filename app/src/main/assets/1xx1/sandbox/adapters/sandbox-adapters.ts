/**
 * 1XX1 Sandbox Adaptörleri
 * Aşama 13
 *
 * ISandboxAdapter'ın somut implementasyonları.
 * Gerçek çalışma ortamı adaptör arkasında — hiçbir üst katman
 * "nasıl çalıştırıldığını" bilmez.
 *
 * MockSandboxAdapter   — test ve CI için, hiç dışarı çıkmaz
 * ProcessSandboxAdapter — Node.js child_process ile gerçek yürütme
 *
 * İleride: ContainerSandboxAdapter (Docker), WasmSandboxAdapter (WASM runtime)
 */

import type {
  ISandboxAdapter, ResourceLimits, BehaviorReport,
  BehaviorEvent, SandboxSession, TelemetrySnapshot, BehaviorCategory,
} from "../sandbox-types.ts";
import { DEFAULT_LIMITS } from "../sandbox-types.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { generateId } from "../../core/utils.ts";

// ─── Yardımcı: event üretici ─────────────────────────────────────────────────

function makeEvent(
  sessionId: string,
  category:  BehaviorCategory,
  detail:    string,
  severity:  BehaviorEvent["severity"] = "info",
  data?:     Record<string, unknown>
): BehaviorEvent {
  return {
    id: `bev_${generateId().slice(0, 8)}`,
    sessionId, category,
    timestamp: new Date(),
    detail, severity, data,
  };
}

function makeSession(
  sessionId: string,
  command:   string,
  limits:    ResourceLimits,
  overrides: Partial<SandboxSession> = {}
): SandboxSession {
  return {
    sessionId, command, limits,
    status:    "completed",
    startedAt: new Date(),
    ...overrides,
  };
}

function makeTelemetry(
  sessionId: string,
  events:    BehaviorEvent[],
  overrides: Partial<TelemetrySnapshot> = {}
): TelemetrySnapshot {
  const violations = events.filter((e) => e.severity === "violation").length;
  return {
    sessionId,
    capturedAt:      new Date(),
    cpuMs:           0,
    memoryBytes:     0,
    peakMemoryBytes: 0,
    diskWriteBytes:  0,
    networkBytes:    0,
    eventCount:      events.length,
    violationCount:  violations,
    ...overrides,
  };
}

function buildReport(
  session:   SandboxSession,
  events:    BehaviorEvent[],
  telemetry: TelemetrySnapshot
): BehaviorReport {
  const violations     = events.filter((e) => e.severity === "violation");
  const observations   = _buildObservations(events, telemetry);
  const attemptedNetwork = events.some((e) => e.category === "network_connect" || e.category === "network_listen");
  const wroteFiles      = events.some((e) => e.category === "file_write");
  const spawnedProcess  = events.some((e) => e.category === "process_spawn");

  return {
    sessionId:   session.sessionId,
    session,
    events,
    telemetry,
    observations,
    violations,
    attemptedNetwork,
    wroteFiles,
    spawnedProcess,
    completedAt: new Date(),
  };
}

function _buildObservations(events: BehaviorEvent[], tel: TelemetrySnapshot): string[] {
  const obs: string[] = [];
  if (tel.violationCount > 0) obs.push(`${tel.violationCount} kaynak limiti ihlali`);
  if (events.some((e) => e.category === "network_connect")) obs.push("Ağ bağlantısı girişimi tespit edildi");
  if (events.some((e) => e.category === "file_write"))      obs.push("Dosya sistemi yazma işlemi tespit edildi");
  if (events.some((e) => e.category === "process_spawn"))   obs.push("Alt süreç başlatma girişimi");
  if (events.some((e) => e.category === "exception"))       obs.push("Çalışma sırasında istisna oluştu");
  if (obs.length === 0) obs.push("Olağan dışı davranış gözlemlenmedi");
  return obs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MockSandboxAdapter — Test ve CI
// ═══════════════════════════════════════════════════════════════════════════════

export interface MockBehaviorOverride {
  /** Simüle edilecek davranış olayları */
  events?:    Array<{ category: BehaviorCategory; detail: string; severity: BehaviorEvent["severity"] }>;
  /** Çıkış kodu */
  exitCode?:  number;
  /** Durum */
  status?:    SandboxSession["status"];
  /** CPU kullanımı (ms) */
  cpuMs?:     number;
  /** Bellek kullanımı (byte) */
  memoryBytes?: number;
  /** Yapay gecikme (ms) — timeout testi için */
  delayMs?:   number;
}

export class MockSandboxAdapter implements ISandboxAdapter {
  readonly name = "mock";
  private override: MockBehaviorOverride;

  constructor(override: MockBehaviorOverride = {}) {
    this.override = override;
  }

  setOverride(o: MockBehaviorOverride): void { this.override = o; }

  async run(
    command:   string,
    data:      Uint8Array,
    limits:    ResourceLimits,
    sessionId: string
  ): Promise<BehaviorReport> {
    // Yapay gecikme
    if (this.override.delayMs) {
      await new Promise((r) => setTimeout(r, this.override.delayMs));
    }

    const startedAt = new Date();
    const events: BehaviorEvent[] = [];

    // Stdout event: komut çalıştırıldı
    events.push(makeEvent(sessionId, "stdout",
      `Mock: komut çalıştırıldı (${data.byteLength} byte)`, "info"));

    // Override'dan ek event'ler
    for (const e of (this.override.events ?? [])) {
      events.push(makeEvent(sessionId, e.category, e.detail, e.severity));
    }

    // Komut içeriğinde şüpheli pattern simülasyonu
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    if (/fetch|XMLHttpRequest|axios/i.test(text)) {
      events.push(makeEvent(sessionId, "network_connect",
        "Mock: ağ API kullanımı tespit edildi", "warning",
        { pattern: "fetch/XMLHttpRequest" }));
    }
    if (/fs\.writeFile|open.*'w'/i.test(text)) {
      events.push(makeEvent(sessionId, "file_write",
        "Mock: dosya yazma tespit edildi", "warning"));
    }
    if (/child_process|subprocess|os\.system/i.test(text)) {
      events.push(makeEvent(sessionId, "process_spawn",
        "Mock: alt süreç başlatma tespit edildi", "violation"));
    }

    const status     = this.override.status ?? "completed";
    const cpuMs      = this.override.cpuMs  ?? Math.floor(Math.random() * 200);
    const memBytes   = this.override.memoryBytes ?? 4 * 1024 * 1024;
    const durationMs = Date.now() - startedAt.getTime();

    const session = makeSession(sessionId, command, limits, {
      status,
      startedAt,
      endedAt:   new Date(),
      exitCode:  this.override.exitCode ?? 0,
      durationMs,
    });

    const telemetry = makeTelemetry(sessionId, events, {
      cpuMs,
      memoryBytes:     memBytes,
      peakMemoryBytes: memBytes * 1.2,
    });

    return buildReport(session, events, telemetry);
  }

  async isAvailable(): Promise<boolean> { return true; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ProcessSandboxAdapter — Node.js child_process ile gerçek yürütme
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gerçek Node.js süreç izolasyonu.
 * Tam konteyner izolasyonu için ContainerSandboxAdapter (Aşama 14) kullanılacak.
 * Bu adaptör: wall-time timeout + çıkış kodu + stdout/stderr izleme.
 */
export class ProcessSandboxAdapter implements ISandboxAdapter {
  readonly name = "process";

  constructor(logger?: ILogger) {
    this.logger = logger;}

  async run(
    command:   string,
    data:      Uint8Array,
    limits:    ResourceLimits,
    sessionId: string
  ): Promise<BehaviorReport> {
    const startedAt = new Date();
    const events: BehaviorEvent[] = [];
    let status: SandboxSession["status"] = "running";

    try {
      const { spawn } = await import("node:child_process");
      const args      = command.split(" ");
      const proc      = spawn(args[0], args.slice(1), {
        timeout: limits.wallTimeMs,
        killSignal: "SIGKILL",
        stdio: ["pipe", "pipe", "pipe"],
      });

      // stdin'e veri gönder
      proc.stdin?.write(data);
      proc.stdin?.end();

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        events.push(makeEvent(sessionId, "stdout",
          chunk.toString("utf-8").slice(0, 200), "info"));
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        events.push(makeEvent(sessionId, "stderr",
          chunk.toString("utf-8").slice(0, 200), "warning"));
      });

      const exitCode = await new Promise<number>((resolve) => {
        proc.on("close", (code: number | null, signal: string | null) => {
          if (signal === "SIGKILL") {
            events.push(makeEvent(sessionId, "signal", `SIGKILL — zaman aşımı`, "violation"));
            status = "timeout";
          } else {
            status = "completed";
          }
          resolve(code ?? -1);
        });
        proc.on("error", (err: Error) => {
          events.push(makeEvent(sessionId, "exception", err.message, "violation"));
          status = "crashed";
          resolve(-1);
        });
      });

      const durationMs = Date.now() - startedAt.getTime();
      const session    = makeSession(sessionId, command, limits, {
        status, startedAt, endedAt: new Date(), exitCode, durationMs,
      });

      const telemetry = makeTelemetry(sessionId, events, {
        cpuMs: Math.min(durationMs, limits.cpuTimeMs),
      });

      return buildReport(session, events, telemetry);

    } catch (err) {
      this.logger?.error("ProcessSandbox: süreç hatası", err instanceof Error ? err : undefined);
      const session = makeSession(sessionId, command, limits, {
        status: "crashed", startedAt, endedAt: new Date(), exitCode: -1,
        durationMs: Date.now() - startedAt.getTime(),
      });
      events.push(makeEvent(sessionId, "exception",
        err instanceof Error ? err.message : "Bilinmeyen hata", "violation"));
      return buildReport(session, events, makeTelemetry(sessionId, events));
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import("node:child_process");
      return true;
    } catch {
      return false;
    }
  }
}
