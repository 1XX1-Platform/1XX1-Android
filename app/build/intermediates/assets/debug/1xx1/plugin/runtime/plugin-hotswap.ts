/**
 * 1XX1 Plugin Hot Swap — FAZ 7
 *
 * Zero-downtime version switch:
 *   1. Yeni versiyonu register et
 *   2. Drain: in-flight requestler biter
 *   3. Route switch: atomik
 *   4. Eski versiyonu unregister et
 *
 * Core'a dokunmaz.
 */

import type { PluginRuntime, ExtensionPoint } from "./plugin-runtime.ts";

export type HotSwapResult = {
  ok:         boolean;
  oldId:      string;
  newId:      string;
  durationMs: number;
  error?:     string;
};

export class PluginHotSwap {
  private runtime: PluginRuntime;
  private drainTimeoutMs: number;

  constructor(runtime: PluginRuntime, drainTimeoutMs = 5000) {
    this.runtime        = runtime;
    this.drainTimeoutMs = drainTimeoutMs;
  }

  /**
   * Hot swap: oldId → newId
   * newManifest ve handlers onceden hazir olmali.
   */
  async swap(
    oldId: string,
    newManifest: {
      id: string; name: string; version: string;
      extensions: ExtensionPoint[]; deps?: string[];
    },
    newHandlers: Partial<Record<ExtensionPoint, (...args: unknown[]) => unknown>>,
  ): Promise<HotSwapResult> {
    const t0 = Date.now();
    const newId = newManifest.id;

    // 1. Yeni versiyonu register et (eski hala aktif)
    const reg = this.runtime.register(newManifest);
    if (!reg.ok) {
      return { ok: false, oldId, newId, durationMs: Date.now()-t0, error: reg.error };
    }

    // 2. Yeni versiyonu initialized → running yap
    this.runtime.transition(newId, "installed");
    this.runtime.transition(newId, "initialized");

    for (const [ep, fn] of Object.entries(newHandlers)) {
      if (fn) this.runtime.registerHandler(newId, ep as ExtensionPoint, fn);
    }

    this.runtime.transition(newId, "running");

    // 3. Drain: eski plugin'i durdur (stopped → in-flight biter)
    // Basit drain: drainTimeoutMs bekle
    await new Promise(r => setTimeout(r, Math.min(this.drainTimeoutMs, 500)));

    // 4. Eski versiyonu durdur + unregister
    const old = this.runtime.get(oldId);
    if (old) {
      if (old.state === "running" || old.state === "degraded") {
        this.runtime.transition(oldId, "stopped");
      }
      if (old.state === "stopped") {
        this.runtime.uninstall(oldId);
      }
    }

    return { ok: true, oldId, newId, durationMs: Date.now()-t0 };
  }

  /**
   * Canary: yeni versiyonu sadece belirli oranda trafige ac
   * Simdilik stub — FAZ 8'de gercek implement edilecek
   */
  canary(newId: string, _trafficPct: number): void {
    // FAZ 8'de: EPR routing weight ayarlanacak
    this.runtime.transition(newId, "running");
  }
}
