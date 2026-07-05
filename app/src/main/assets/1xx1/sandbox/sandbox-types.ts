/**
 * 1XX1 Sandbox Çalıştırma Ortamı — Ortak Tipler
 * Aşama 13
 *
 * Temel mimari ayrım:
 *   Sandbox güvenlik sağlamaz — izolasyon sağlar.
 *   Güvenlik = izolasyon + statik analiz (Aşama 12) + davranış + politika.
 *
 * Sandbox'ın tek görevi: gözlem. Karar Policy Engine'e aittir.
 */

export interface ResourceLimits {
  cpuTimeMs:       number;   // CPU kullanım süresi (ms)
  maxMemoryBytes:  number;   // Bellek sınırı (byte)
  maxDiskBytes:    number;   // Disk yazma sınırı (byte)
  wallTimeMs:      number;   // Duvar saati zaman aşımı (ms)
  allowNetwork:    boolean;  // Ağ erişimi
}

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  cpuTimeMs:       5_000,
  maxMemoryBytes:  128 * 1024 * 1024,
  maxDiskBytes:    10  * 1024 * 1024,
  wallTimeMs:      30_000,
  allowNetwork:    false,
});

export type SessionStatus =
  | "pending" | "running" | "completed"
  | "timeout" | "killed" | "crashed" | "cancelled";

export type BehaviorCategory =
  | "file_read" | "file_write" | "file_delete"
  | "network_connect" | "network_listen"
  | "process_spawn" | "env_access"
  | "stdout" | "stderr" | "signal"
  | "exception" | "resource_limit";

export interface BehaviorEvent {
  id:        string;
  sessionId: string;
  category:  BehaviorCategory;
  timestamp: Date;
  detail:    string;
  severity:  "info" | "warning" | "violation";
  data?:     Record<string, unknown>;
}

export interface TelemetrySnapshot {
  sessionId:       string;
  capturedAt:      Date;
  cpuMs:           number;
  memoryBytes:     number;
  peakMemoryBytes: number;
  diskWriteBytes:  number;
  networkBytes:    number;
  eventCount:      number;
  violationCount:  number;
}

export interface SandboxSession {
  sessionId:  string;
  projectId?: string;
  releaseId?: string;
  assetId?:   string;
  limits:     ResourceLimits;
  status:     SessionStatus;
  startedAt:  Date;
  endedAt?:   Date;
  exitCode?:  number;
  durationMs?: number;
  command?:   string;
}

export interface BehaviorReport {
  sessionId:        string;
  session:          SandboxSession;
  events:           BehaviorEvent[];
  telemetry:        TelemetrySnapshot;
  observations:     string[];
  violations:       BehaviorEvent[];
  attemptedNetwork: boolean;
  wroteFiles:       boolean;
  spawnedProcess:   boolean;
  completedAt:      Date;
}

export interface ISandboxAdapter {
  readonly name: string;
  run(
    command:   string,
    data:      Uint8Array,
    limits:    ResourceLimits,
    sessionId: string
  ): Promise<BehaviorReport>;
  isAvailable(): Promise<boolean>;
}
