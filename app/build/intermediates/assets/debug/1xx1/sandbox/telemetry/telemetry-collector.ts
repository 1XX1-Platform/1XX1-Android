/**
 * 1XX1 Telemetry Collector
 * Aşama 13 — Sandbox
 *
 * Sandbox oturumu sırasında kaynak kullanımını ölçer.
 * MockSandboxAdapter için simüle edilmiş değerler,
 * ProcessSandboxAdapter için süreç ölçümleri kullanılır.
 */

import type { TelemetrySnapshot, BehaviorEvent, ResourceLimits } from "../sandbox-types.ts";

export class TelemetryCollector {
  private samples: Array<{ cpuMs: number; memBytes: number; ts: Date }> = [];
  private diskBytes  = 0;
  private netBytes   = 0;

  /** Ölçüm ekle (süreç ölçümü veya simülasyon) */
  record(cpuMs: number, memBytes: number): void {
    this.samples.push({ cpuMs, memBytes, ts: new Date() });
  }

  /** Disk yazma kaydı */
  recordDiskWrite(bytes: number): void { this.diskBytes += bytes; }

  /** Ağ trafiği kaydı */
  recordNetwork(bytes: number): void { this.netBytes += bytes; }

  /** Snapshot oluştur */
  snapshot(
    sessionId: string,
    events:    BehaviorEvent[],
    overrides: Partial<TelemetrySnapshot> = {}
  ): TelemetrySnapshot {
    const totalCpu  = this.samples.reduce((a, s) => a + s.cpuMs, 0);
    const lastMem   = this.samples.at(-1)?.memBytes ?? 0;
    const peakMem   = Math.max(...this.samples.map((s) => s.memBytes), 0);
    const violations = events.filter((e) => e.severity === "violation").length;

    return {
      sessionId,
      capturedAt:      new Date(),
      cpuMs:           overrides.cpuMs           ?? totalCpu,
      memoryBytes:     overrides.memoryBytes      ?? lastMem,
      peakMemoryBytes: overrides.peakMemoryBytes  ?? peakMem,
      diskWriteBytes:  overrides.diskWriteBytes   ?? this.diskBytes,
      networkBytes:    overrides.networkBytes     ?? this.netBytes,
      eventCount:      events.length,
      violationCount:  violations,
      ...overrides,
    };
  }

  /** Sınır ihlalleri var mı? */
  checkLimits(limits: ResourceLimits): {
    cpuExceeded:    boolean;
    memExceeded:    boolean;
    diskExceeded:   boolean;
  } {
    const totalCpu = this.samples.reduce((a, s) => a + s.cpuMs, 0);
    const peakMem  = Math.max(...this.samples.map((s) => s.memBytes), 0);
    return {
      cpuExceeded:  totalCpu     > limits.cpuTimeMs,
      memExceeded:  peakMem      > limits.maxMemoryBytes,
      diskExceeded: this.diskBytes > limits.maxDiskBytes,
    };
  }

  reset(): void {
    this.samples    = [];
    this.diskBytes  = 0;
    this.netBytes   = 0;
  }
}
