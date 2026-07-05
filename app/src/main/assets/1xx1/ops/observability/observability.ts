/**
 * 1XX1 Observability Layer
 * Aşama 20 — Operasyon 20.1
 *
 * Sistemin her noktasından veri toplama:
 *   Prometheus Metrics   → sayısal ölçüm (counter, gauge, histogram)
 *   OpenTelemetry Trace  → dağıtık istek takibi (span, baggage)
 *   Structured Log       → JSON formatı + correlation ID
 *
 * Architecture Freeze kuralı: Bu katman mevcut modüllere DOKUNMAZ.
 * Tamamen OPSİYONEL — çekirdek modüller bu modülü import etmez.
 * Sadece ops/observability/ → core/ tek yönlü bağımlılık (ILogger kullanımı).
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Correlation ID ──────────────────────────────────────────────────────────

let _correlationCounter = 0;

export function generateCorrelationId(): string {
  const ts  = Date.now().toString(36);
  const cnt = (++_correlationCounter).toString(36).padStart(4, "0");
  return `req_${ts}_${cnt}`;
}

// ─── Metrics Tipleri ─────────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name:        string;
  type:        MetricType;
  description: string;
  labels?:     string[];
  /** Histogram için bucket sınırları (ms veya bytes) */
  buckets?:    number[];
}

export interface MetricSample {
  name:      string;
  value:     number;
  labels:    Record<string, string>;
  timestamp: number;
}

// ─── Prometheus Format ────────────────────────────────────────────────────────

export class PrometheusRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters    = new Map<string, number>();
  private readonly gauges      = new Map<string, number>();
  private readonly histograms  = new Map<string, number[]>();

  /** Metrik tanımını kaydet */
  register(def: MetricDefinition): void {
    this.definitions.set(def.name, def);
    if (def.type === "counter") this.counters.set(def.name, 0);
    if (def.type === "gauge")   this.gauges.set(def.name, 0);
    if (def.type === "histogram") this.histograms.set(def.name, []);
  }

  /** Counter arttır */
  inc(name: string, by = 1): void {
    const cur = this.counters.get(name) ?? 0;
    this.counters.set(name, cur + by);
  }

  /** Gauge değerini ayarla */
  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Histogram'a değer ekle */
  observe(name: string, value: number): void {
    const hist = this.histograms.get(name) ?? [];
    hist.push(value);
    // Son 10.000 örnekle sınırlı (bellek yönetimi)
    if (hist.length > 10_000) hist.shift();
    this.histograms.set(name, hist);
  }

  /** Prometheus text format'ında çıktı üret */
  scrape(): string {
    const lines: string[] = [];

    for (const [name, def] of this.definitions) {
      lines.push(`# HELP ${name} ${def.description}`);
      lines.push(`# TYPE ${name} ${def.type}`);

      if (def.type === "counter") {
        lines.push(`${name} ${this.counters.get(name) ?? 0}`);
      }
      if (def.type === "gauge") {
        lines.push(`${name} ${this.gauges.get(name) ?? 0}`);
      }
      if (def.type === "histogram") {
        const values = this.histograms.get(name) ?? [];
        const count  = values.length;
        const sum    = values.reduce((a, b) => a + b, 0);
        const buckets = def.buckets ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

        for (const le of buckets) {
          const below = values.filter((v) => v <= le).length;
          lines.push(`${name}_bucket{le="${le}"} ${below}`);
        }
        lines.push(`${name}_bucket{le="+Inf"} ${count}`);
        lines.push(`${name}_count ${count}`);
        lines.push(`${name}_sum ${sum}`);
      }
    }

    return lines.join("\n");
  }

  /** Metrik anlık görüntüsü (test/debug için) */
  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [k, v] of this.counters) result[k] = v;
    for (const [k, v] of this.gauges) result[k] = v;
    for (const [k, vs] of this.histograms) {
      result[`${k}_count`] = vs.length;
      result[`${k}_sum`]   = vs.reduce((a, b) => a + b, 0);
    }
    return result;
  }
}

// ─── 1XX1 Platform Metrikleri ────────────────────────────────────────────────

export const PLATFORM_METRICS: MetricDefinition[] = [
  // Gossip
  { name: "x1_gossip_messages_total",       type: "counter",   description: "Toplam gossip mesajı (gönderilen+alınan)" },
  { name: "x1_gossip_duplicates_total",     type: "counter",   description: "Duplicate gossip mesajı (seenCache hit)" },
  { name: "x1_gossip_spread_total",         type: "counter",   description: "Gossip spread() çağrı sayısı" },
  // Consensus
  { name: "x1_raft_term_current",           type: "gauge",     description: "Mevcut Raft term numarası" },
  { name: "x1_raft_commit_index",           type: "gauge",     description: "Raft commit index" },
  { name: "x1_raft_election_total",         type: "counter",   description: "Toplam lider seçimi sayısı" },
  { name: "x1_raft_commit_duration_ms",     type: "histogram", description: "Komut commit süresi (ms)", buckets: [5,10,25,50,100,250] },
  // Pulse
  { name: "x1_pulse_tick_total",            type: "counter",   description: "Toplam pulse tick sayısı" },
  { name: "x1_pulse_eligible_projects",     type: "gauge",     description: "Mevcut pulse'da uygun proje sayısı" },
  { name: "x1_pulse_ranking_duration_ms",   type: "histogram", description: "Pulse sıralama süresi (ms)", buckets: [10,50,100,500,1000,2500] },
  // Search
  { name: "x1_search_queries_total",        type: "counter",   description: "Toplam arama isteği" },
  { name: "x1_search_latency_ms",           type: "histogram", description: "Arama latency (ms)", buckets: [5,10,25,50,100,250,500] },
  // P2P Transfer
  { name: "x1_p2p_chunks_transferred",      type: "counter",   description: "Toplam aktarılan chunk" },
  { name: "x1_p2p_transfer_bytes",          type: "counter",   description: "Toplam aktarılan byte" },
  { name: "x1_p2p_transfer_duration_ms",    type: "histogram", description: "Asset transfer süresi (ms)", buckets: [100,500,1000,5000,10000] },
  // Plugin
  { name: "x1_plugin_active_count",         type: "gauge",     description: "Aktif plugin sayısı" },
  { name: "x1_plugin_activations_total",    type: "counter",   description: "Toplam plugin aktivasyon sayısı" },
  { name: "x1_plugin_failures_total",       type: "counter",   description: "Toplam plugin başarısızlık sayısı" },
  // Snapshot
  { name: "x1_snapshot_taken_total",        type: "counter",   description: "Toplam snapshot alma sayısı" },
  { name: "x1_snapshot_duration_ms",        type: "histogram", description: "Snapshot alma süresi (ms)", buckets: [100,500,1000,5000] },
  { name: "x1_log_compaction_total",        type: "counter",   description: "Toplam log compaction sayısı" },
  // Node Health
  { name: "x1_node_active_peers",           type: "gauge",     description: "Aktif peer sayısı" },
  { name: "x1_node_status",                 type: "gauge",     description: "Node durumu (1=ACTIVE,2=DEGRADED,3=ISOLATED,0=OFFLINE)" },
];

/** Global registry — tüm modüller bu instance'ı kullanır (import ile) */
export function createPlatformRegistry(): PrometheusRegistry {
  const registry = new PrometheusRegistry();
  for (const def of PLATFORM_METRICS) registry.register(def);
  return registry;
}

// ─── OpenTelemetry Span (Minimal, Sıfır Bağımlılık) ─────────────────────────

export interface SpanContext {
  traceId:       string;
  spanId:        string;
  parentSpanId?: string;
  correlationId: string;
}

export interface Span {
  context:    SpanContext;
  name:       string;
  startMs:    number;
  attributes: Record<string, string | number | boolean>;
  events:     Array<{ name: string; timestamp: number }>;
  status:     "unset" | "ok" | "error";
  endMs?:     number;
}

let _traceCounter = 0;
let _spanCounter  = 0;

function genId(prefix: string, n: number): string {
  return `${prefix}_${Date.now().toString(36)}_${n.toString(36).padStart(4, "0")}`;
}

export class Tracer {
  private readonly spans: Span[] = [];
  private readonly maxSpans = 5_000;

  startSpan(name: string, parentCtx?: SpanContext): Span {
    const span: Span = {
      name,
      startMs: Date.now(),
      attributes: {},
      events: [],
      status: "unset",
      context: {
        traceId:       parentCtx?.traceId ?? genId("t", ++_traceCounter),
        spanId:        genId("s", ++_spanCounter),
        parentSpanId:  parentCtx?.spanId,
        correlationId: parentCtx?.correlationId ?? generateCorrelationId(),
      },
    };
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) this.spans.shift();
    return span;
  }

  endSpan(span: Span, status: Span["status"] = "ok"): void {
    span.endMs  = Date.now();
    span.status = status;
  }

  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  addEvent(span: Span, name: string): void {
    span.events.push({ name, timestamp: Date.now() });
  }

  /** Son N span (export/debug için) */
  recentSpans(n = 100): Span[] {
    return this.spans.slice(-n);
  }

  /** Ortalam latency (ms) belirli bir span adı için */
  avgLatency(spanName: string): number | null {
    const matching = this.spans.filter((s) => s.name === spanName && s.endMs);
    if (matching.length === 0) return null;
    const total = matching.reduce((sum, s) => sum + (s.endMs! - s.startMs), 0);
    return total / matching.length;
  }
}

// ─── Structured Logger ────────────────────────────────────────────────────────

export interface StructuredLogEntry {
  timestamp:     string;
  level:         "debug" | "info" | "warn" | "error";
  message:       string;
  service:       string;
  correlationId?: string;
  traceId?:      string;
  spanId?:       string;
  data?:         Record<string, unknown>;
}

export class StructuredLogger implements ILogger {
  private readonly buffer: StructuredLogEntry[] = [];
  private readonly maxBuffer = 10_000;
  private readonly service:  string;
  private readonly minLevel: "debug" | "info" | "warn" | "error";
  private readonly output:   (entry: StructuredLogEntry) => void;

  constructor(
    service: string,
    minLevel: "debug" | "info" | "warn" | "error" = "info",
    output: (entry: StructuredLogEntry) => void = (e) => {
      console.log(JSON.stringify(e));
    }
  ) {
    this.service  = service;
    this.minLevel = minLevel;
    this.output   = output;
  }

  private _write(
    level: StructuredLogEntry["level"],
    message: string,
    ctx?: { correlationId?: string; traceId?: string; spanId?: string; data?: Record<string, unknown> }
  ): void {
    const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
    if (LEVELS[level] < LEVELS[this.minLevel]) return;

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
      ...ctx,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.output(entry);
  }

  debug(msg: string, data?: Record<string, unknown>): void { this._write("debug", msg, { data }); }
  info(msg: string,  data?: Record<string, unknown>): void { this._write("info",  msg, { data }); }
  warn(msg: string,  data?: Record<string, unknown>): void { this._write("warn",  msg, { data }); }
  error(msg: string, data?: Record<string, unknown>): void { this._write("error", msg, { data }); }

  /** Correlation ID ile log (HTTP istek zinciri için) */
  withCorrelation(correlationId: string) {
    const parent = this;
    return {
      info:  (msg: string, data?: Record<string, unknown>) => parent._write("info",  msg, { correlationId, data }),
      warn:  (msg: string, data?: Record<string, unknown>) => parent._write("warn",  msg, { correlationId, data }),
      error: (msg: string, data?: Record<string, unknown>) => parent._write("error", msg, { correlationId, data }),
    };
  }

  /** Span bağlamıyla log */
  withSpan(span: Span) {
    const ctx = {
      traceId:       span.context.traceId,
      spanId:        span.context.spanId,
      correlationId: span.context.correlationId,
    };
    const parent = this;
    return {
      info:  (msg: string, data?: Record<string, unknown>) => parent._write("info",  msg, { ...ctx, data }),
      error: (msg: string, data?: Record<string, unknown>) => parent._write("error", msg, { ...ctx, data }),
    };
  }

  /** Son N log (API endpoint veya dashboard için) */
  recent(n = 100): StructuredLogEntry[] {
    return this.buffer.slice(-n);
  }

  /** Seviye bazlı filtre */
  filter(level: StructuredLogEntry["level"]): StructuredLogEntry[] {
    return this.buffer.filter((e) => e.level === level);
  }
}

// ─── Grafana Dashboard Tanımı (JSON stub) ────────────────────────────────────

/**
 * Grafana dashboard JSON tanımı.
 * Gerçek Grafana import'u için:
 *   Grafana UI → Dashboards → Import → JSON yapıştır
 */
export const GRAFANA_DASHBOARD_STUB = {
  title: "1XX1 Platform Overview",
  schemaVersion: 36,
  panels: [
    {
      title: "Node Status",
      type: "stat",
      targets: [{ expr: "x1_node_status" }],
    },
    {
      title: "Active Peers",
      type: "gauge",
      targets: [{ expr: "x1_node_active_peers" }],
    },
    {
      title: "Raft Term",
      type: "stat",
      targets: [{ expr: "x1_raft_term_current" }],
    },
    {
      title: "Gossip Messages/sec",
      type: "timeseries",
      targets: [{ expr: "rate(x1_gossip_messages_total[1m])" }],
    },
    {
      title: "Search Latency (p99)",
      type: "timeseries",
      targets: [{ expr: "histogram_quantile(0.99, rate(x1_search_latency_ms_bucket[5m]))" }],
    },
    {
      title: "Active Plugins",
      type: "stat",
      targets: [{ expr: "x1_plugin_active_count" }],
    },
  ],
};
