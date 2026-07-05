/**
 * 1XX1 Causal Tracer — FAZ 8 Block 2
 *
 * "Hangi plugin sistemi bozdu?" sorusunu cevaplar.
 *
 * Her invokasyon zinciri trace edilir.
 * Hata yayilimi geri izlenerek kok neden bulunur.
 *
 * Core'a dokunmaz.
 */

export type TraceEvent = {
  traceId:   string;
  pluginId:  string;
  ep:        string;
  ts:        number;
  durationMs: number;
  success:   boolean;
  errorMsg?: string;
  parentId?: string;  // hangi cagri bu cagriyi tetikledi
};

export type CausalChain = {
  rootPluginId: string;
  chain:        TraceEvent[];
  affected:     string[];  // etkilenen plugin'ler
  rootCause:    string;    // aciklama
};

const MAX_TRACES = 1000;

export class CausalTracer {
  private traces: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.traces.push(event);
    if (this.traces.length > MAX_TRACES) this.traces.shift();
  }

  /** Son N saniyede kimin hata urettigi */
  errorsInWindow(windowMs: number): Map<string, number> {
    const cutoff = Date.now() - windowMs;
    const counts = new Map<string, number>();
    for (const t of this.traces) {
      if (t.ts < cutoff || t.success) continue;
      counts.set(t.pluginId, (counts.get(t.pluginId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Kok neden analizi:
   * En cok hataya neden olan plugin + etkiledigi downstream plugin'ler
   */
  findRootCause(windowMs = 60_000): CausalChain | null {
    const errors = this.errorsInWindow(windowMs);
    if (errors.size === 0) return null;

    // En cok hata ureten plugin = kok neden adayi
    let rootPluginId = "";
    let maxErrors    = 0;
    for (const [id, cnt] of errors) {
      if (cnt > maxErrors) { maxErrors = cnt; rootPluginId = id; }
    }

    const cutoff = Date.now() - windowMs;
    const chain  = this.traces.filter(t => t.ts >= cutoff && t.pluginId === rootPluginId);

    // Etkilenen plugin'ler: root'tan sonra hata uretmeye baslayan diger plugin'ler
    const rootFirstError = chain.find(t => !t.success)?.ts ?? Date.now();
    const affected = [...errors.keys()].filter(id => {
      if (id === rootPluginId) return false;
      const firstErr = this.traces.find(t => t.pluginId === id && !t.success && t.ts >= rootFirstError);
      return firstErr !== undefined;
    });

    return {
      rootPluginId,
      chain,
      affected,
      rootCause: `${rootPluginId} produced ${maxErrors} errors in ${windowMs}ms window`,
    };
  }

  /** Belirli plugin'in trace gecmisi */
  historyOf(pluginId: string, limit = 50): TraceEvent[] {
    return this.traces.filter(t => t.pluginId === pluginId).slice(-limit);
  }

  /** Ortalama gecikme per plugin */
  avgLatency(pluginId: string, windowMs = 60_000): number {
    const cutoff = Date.now() - windowMs;
    const recent = this.traces.filter(t => t.pluginId === pluginId && t.ts >= cutoff);
    if (recent.length === 0) return 0;
    return recent.reduce((s, t) => s + t.durationMs, 0) / recent.length;
  }

  /** Toplam trace sayisi */
  count(): number { return this.traces.length; }

  clear(pluginId?: string): void {
    if (pluginId) this.traces = this.traces.filter(t => t.pluginId !== pluginId);
    else this.traces = [];
  }
}
