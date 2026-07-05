/**
 * 1XX1 Plugin Runtime — FAZ 6
 *
 * Core'a dokunmaz. Sadece plugin lifecycle orkestrasyonu yapar.
 *
 * Lifecycle states:
 *   registered → installed → initialized → running → degraded → stopped → uninstalled
 *
 * Extension Point Registry (EPR): 8 immutable extension point
 * DAG: Dependency cycle detection + topological sort
 * Circuit Breaker: 5 hata → Degraded, 60s → Reset
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Extension Point Registry ────────────────────────────────────────────────

export const EXTENSION_POINTS = [
  "search",
  "asset_processor",
  "pulse_hook",
  "index_augmenter",
  "event_interceptor",
  "security_analyzer",
  "preview_generator",
  "consensus_extension",
] as const;

export type ExtensionPoint = typeof EXTENSION_POINTS[number];

export const EP_VERSIONS: Record<ExtensionPoint, string> = {
  search:               "v1",
  asset_processor:      "v1",
  pulse_hook:           "v1",
  index_augmenter:      "v1",
  event_interceptor:    "v1",
  security_analyzer:    "v1",
  preview_generator:    "v1",
  consensus_extension:  "v1",
};

// ─── Lifecycle States ────────────────────────────────────────────────────────

export type PluginState =
  | "registered" | "installed" | "initialized"
  | "running" | "degraded" | "quarantined"
  | "stopped" | "uninstalled";

export const VALID_TRANSITIONS: Record<PluginState, PluginState[]> = {
  registered:   ["installed", "uninstalled"],
  installed:    ["initialized", "uninstalled"],
  initialized:  ["running", "stopped"],
  running:      ["degraded", "stopped"],
  degraded:     ["running", "quarantined", "stopped"],
  quarantined:  ["stopped"],           // karantinadan direkt durdurmak gerekir
  stopped:      ["initialized", "uninstalled"],
  uninstalled:  [],
};

// ─── Plugin Record ───────────────────────────────────────────────────────────

export type PluginRecord = {
  id:           string;
  name:         string;
  version:      string;
  state:        PluginState;
  extensions:   ExtensionPoint[];
  deps:         string[];
  isolation:    "strict" | "shared";
  lifecycle:    "stateless" | "stateful";
  errors:       number;
  lastError:    number;
  calls:        number;
  totalMs:      number;
  registeredAt: number;
};

// ─── DAG ─────────────────────────────────────────────────────────────────────

export class PluginDAG {
  private edges = new Map<string, Set<string>>();

  add(id: string, deps: string[]): { ok: boolean; cycle?: string } {
    this.edges.set(id, new Set(deps));
    const cycle = this._cycle();
    if (cycle) { this.edges.delete(id); return { ok: false, cycle }; }
    return { ok: true };
  }

  remove(id: string): void {
    this.edges.delete(id);
    for (const d of this.edges.values()) d.delete(id);
  }

  installOrder(): string[] {
    const visited = new Set<string>(), order: string[] = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      // Once bagimliliklar
      for (const dep of this.edges.get(id) ?? []) visit(dep);
      order.push(id);
    };
    for (const id of this.edges.keys()) visit(id);
    return order; // bagimliliklar once, bagimlilar sonra
  }

  dependents(id: string): string[] {
    return [...this.edges.entries()]
      .filter(([, deps]) => deps.has(id))
      .map(([pid]) => pid);
  }

  private _cycle(): string | null {
    const visited = new Set<string>(), stack = new Set<string>();
    const dfs = (id: string): string | null => {
      visited.add(id); stack.add(id);
      for (const dep of this.edges.get(id) ?? []) {
        if (!visited.has(dep)) { const r = dfs(dep); if (r) return r; }
        else if (stack.has(dep)) return dep;
      }
      stack.delete(id); return null;
    };
    for (const id of this.edges.keys()) {
      if (!visited.has(id)) { const r = dfs(id); if (r) return r; }
    }
    return null;
  }
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

const CB_THRESHOLD = 5;
const CB_RESET_MS  = 60_000;

const shouldTrip  = (p: PluginRecord) => p.errors >= CB_THRESHOLD && Date.now() - p.lastError < CB_RESET_MS;
const shouldReset = (p: PluginRecord) => p.errors >= CB_THRESHOLD && Date.now() - p.lastError >= CB_RESET_MS;

// ─── Plugin Runtime ──────────────────────────────────────────────────────────

export class PluginRuntime {
  private readonly plugins  = new Map<string, PluginRecord>();
  private readonly dag      = new PluginDAG();
  private readonly handlers = new Map<string, Map<ExtensionPoint, (...args: unknown[]) => unknown>>();
  private readonly logger:  ILogger | undefined;

  constructor(logger?: ILogger) {
    this.logger = logger;
  }

  register(manifest: {
    id: string; name: string; version: string;
    extensions: ExtensionPoint[]; deps?: string[];
    isolation?: "strict" | "shared"; lifecycle?: "stateless" | "stateful";
  }): { ok: boolean; error?: string } {
    if (this.plugins.has(manifest.id)) return { ok: false, error: "ALREADY_REGISTERED" };

    const bad = manifest.extensions.filter(ep => !(EXTENSION_POINTS as readonly string[]).includes(ep));
    if (bad.length > 0) return { ok: false, error: `INVALID_EP: ${bad.join(",")}` };

    const dag = this.dag.add(manifest.id, manifest.deps ?? []);
    if (!dag.ok) return { ok: false, error: `DEPENDENCY_CYCLE: ${dag.cycle}` };

    for (const dep of manifest.deps ?? []) {
      if (!this.plugins.has(dep)) {
        this.dag.remove(manifest.id);
        return { ok: false, error: `DEP_NOT_FOUND: ${dep}` };
      }
    }

    this.plugins.set(manifest.id, {
      id: manifest.id, name: manifest.name, version: manifest.version,
      state: "registered", extensions: manifest.extensions,
      deps: manifest.deps ?? [], isolation: manifest.isolation ?? "shared",
      lifecycle: manifest.lifecycle ?? "stateless",
      errors: 0, lastError: 0, calls: 0, totalMs: 0, registeredAt: Date.now(),
    });
    this.logger?.info(`[Plugin] Registered: ${manifest.name}@${manifest.version}`);
    return { ok: true };
  }

  transition(id: string, to: PluginState): { ok: boolean; error?: string } {
    const p = this.plugins.get(id);
    if (!p) return { ok: false, error: "NOT_FOUND" };
    if (!VALID_TRANSITIONS[p.state].includes(to))
      return { ok: false, error: `INVALID_TRANSITION: ${p.state}→${to}` };
    p.state = to;
    return { ok: true };
  }

  registerHandler(id: string, ep: ExtensionPoint, fn: (...args: unknown[]) => unknown): void {
    if (!this.handlers.has(id)) this.handlers.set(id, new Map());
    this.handlers.get(id)!.set(ep, fn);
  }

  async invoke(ep: ExtensionPoint, args: unknown[], timeoutMs = 5000): Promise<{ results: unknown[]; errors: string[] }> {
    const results: unknown[] = [], errors: string[] = [];
    for (const [id, p] of this.plugins) {
      if (p.state !== "running" && p.state !== "degraded") continue;
      if (!p.extensions.includes(ep)) continue;
      if (shouldTrip(p)) { errors.push(`${id}:circuit_open`); continue; }
      if (shouldReset(p)) { p.errors = 0; this.transition(id, "running"); }
      const fn = this.handlers.get(id)?.get(ep);
      if (!fn) continue;
      const t0 = Date.now();
      try {
        const r = await Promise.race([
          Promise.resolve(fn(...args)),
          new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs)),
        ]);
        p.calls++; p.totalMs += Date.now() - t0;
        results.push(r);
      } catch (e) {
        p.errors++; p.lastError = Date.now();
        errors.push(`${id}:${String(e)}`);
        if (shouldTrip(p)) { this.transition(id, "degraded"); }
      }
    }
    return { results, errors };
  }

  uninstall(id: string): { ok: boolean; error?: string } {
    const p = this.plugins.get(id);
    if (!p) return { ok: false, error: "NOT_FOUND" };
    const deps = this.dag.dependents(id);
    if (deps.length > 0) return { ok: false, error: `DEPENDENTS: ${deps.join(",")}` };
    this.transition(id, "stopped");
    this.transition(id, "uninstalled");
    this.plugins.delete(id); this.dag.remove(id); this.handlers.delete(id);
    this.logger?.info(`[Plugin] Uninstalled: ${id}`);
    return { ok: true };
  }

  stats(id: string) {
    const p = this.plugins.get(id);
    if (!p) return null;
    return { avgMs: p.calls > 0 ? Math.round(p.totalMs / p.calls) : 0, calls: p.calls, errors: p.errors, state: p.state };
  }

  all():   PluginRecord[]            { return [...this.plugins.values()]; }
  get(id: string): PluginRecord | undefined { return this.plugins.get(id); }
  count(): number                    { return this.plugins.size; }
  installOrder(): string[]           { return this.dag.installOrder(); }
}
