/**
 * 1XX1 Pulse Clock — Deterministik Zaman Kaynağı
 * Aşama 10 — Pulse Engine
 *
 * Temel denklem:
 *   pulseNumber = floor(unixTimeMs / intervalMs)
 *
 * Bu sayede:
 *   - Tüm düğümler UTC'den aynı pulse numarasını hesaplar
 *   - Yeniden başlatmada pulse kaldığı yerden devam eder
 *   - Interval değişince geçmiş okunabilir kalır
 *   - Test ortamında MockClock ile saat taklit edilir
 */

export interface IClock {
  nowMs(): number;
  nowPulse(intervalMs: number): number;
}

export class SystemClock implements IClock {
  nowMs(): number { return Date.now(); }
  nowPulse(intervalMs: number): number { return Math.floor(this.nowMs() / intervalMs); }
}

export class MockClock implements IClock {
  private _ms: number;
  constructor(startMs = 1_000_000) {
    this.startMs = startMs; this._ms = startMs; }
  advance(ms: number): void { this._ms += ms; }
  set(ms: number): void { this._ms = ms; }
  nowMs(): number { return this._ms; }
  nowPulse(intervalMs: number): number { return Math.floor(this._ms / intervalMs); }
}

export function pulseStartMs(pulse: number, intervalMs: number): number { return pulse * intervalMs; }
export function pulseEndMs(pulse: number, intervalMs: number): number { return (pulse + 1) * intervalMs - 1; }
export function timestampToPulse(ms: number, intervalMs: number): number { return Math.floor(ms / intervalMs); }
export function msUntilNextPulse(clock: IClock, intervalMs: number): number {
  const now = clock.nowMs();
  return ((Math.floor(now / intervalMs) + 1) * intervalMs) - now;
}

export const systemClock = new SystemClock();
