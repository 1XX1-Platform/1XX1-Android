/**
 * 1XX1 Session Manager
 * Aşama 13 — Sandbox
 *
 * Eşzamanlı sandbox oturumlarını yönetir.
 * Maksimum eşzamanlı oturum sınırı: maxConcurrent
 * Geçmiş: historySize son oturum saklanır
 */

import type { SandboxSession, SessionStatus } from "../sandbox-types.ts";
import { generateId } from "../../core/utils.ts";

export class SessionManager {
  private readonly active  = new Map<string, SandboxSession>();
  private readonly history: SandboxSession[] = [];
  private readonly maxConcurrent: number;
  private readonly historySize:   number;

  constructor(opts: { maxConcurrent?: number; historySize?: number } = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 5;
    this.historySize   = opts.historySize   ?? 100;
  }

  /** Yeni oturum kaydı oluştur */
  register(overrides: Partial<SandboxSession> = {}): SandboxSession | null {
    if (this.active.size >= this.maxConcurrent) return null;

    const session: SandboxSession = {
      sessionId: `ssn_${generateId()}`,
      limits:    overrides.limits ?? {
        cpuTimeMs: 5000, maxMemoryBytes: 128*1024*1024,
        maxDiskBytes: 10*1024*1024, wallTimeMs: 30000, allowNetwork: false,
      },
      status:    "pending",
      startedAt: new Date(),
      ...overrides,
    };

    this.active.set(session.sessionId, session);
    return session;
  }

  /** Oturum tamamlandı */
  complete(sessionId: string, status: SessionStatus, exitCode?: number): void {
    const session = this.active.get(sessionId);
    if (!session) return;

    const ended: SandboxSession = {
      ...session,
      status,
      endedAt:   new Date(),
      exitCode,
      durationMs: Date.now() - session.startedAt.getTime(),
    };

    this.active.delete(sessionId);
    this.history.unshift(ended);
    if (this.history.length > this.historySize) this.history.pop();
  }

  /** Aktif oturum sorgula */
  get(sessionId: string): SandboxSession | undefined {
    return this.active.get(sessionId) ?? this.history.find((s) => s.sessionId === sessionId);
  }

  /** Tüm aktif oturumlar */
  activeAll(): SandboxSession[] { return Array.from(this.active.values()); }

  /** Son N oturum */
  recentHistory(n = 10): SandboxSession[] { return this.history.slice(0, n); }

  /** İstatistikler */
  stats(): {
    active: number; maxConcurrent: number;
    historyCount: number; available: boolean;
  } {
    return {
      active:        this.active.size,
      maxConcurrent: this.maxConcurrent,
      historyCount:  this.history.length,
      available:     this.active.size < this.maxConcurrent,
    };
  }
}
