/**
 * 1XX1 Cube Engine — Dışa Aktarma
 * Aşama 02 + Aşama 03 + Risk Giderme
 */

export * from "./cube-cell.ts";
export * from "./cube-engine.ts";
export * from "./cube-path.ts";
export * from "./fractal-node.ts";
export * from "./split-merge.ts";
export * from "./split-policy.ts";
export * from "./path-registry.ts";
export * from "./node-lock.ts";
export * from "./recursion-guard.ts";
export * from "./fractal-cube-engine.ts";

import { FractalCubeEngine } from "./fractal-cube-engine.ts";
import { DEFAULT_SPLIT_POLICY } from "./split-policy.ts";
import { config } from "../core/config.ts";
import { eventBus } from "../core/event-bus.ts";
import { logger } from "../core/logger.ts";

export function createFractalCubeEngine(): FractalCubeEngine {
  const cfg = config.get().cube;
  return new FractalCubeEngine(
    {
      dimension:      cfg.dimension,
      mergeThreshold: cfg.mergeThreshold,
      splitPolicy: {
        ...DEFAULT_SPLIT_POLICY,
        baseSplitThreshold: cfg.splitThreshold,
        maxDepth: cfg.maxDepth,
      },
    },
    eventBus,
    logger
  );
}

export function createTestFractalEngine(overrides: {
  dimension?:      number;
  splitThreshold?: number;
  maxDepth?:       number;
  mergeThreshold?: number;
  softDepthLimit?: number;
  hardDepthLimit?: number;
} = {}): FractalCubeEngine {
  return new FractalCubeEngine({
    dimension:      overrides.dimension      ?? 11,
    mergeThreshold: overrides.mergeThreshold ?? 2,
    splitPolicy: {
      baseSplitThreshold: overrides.splitThreshold ?? 4,
      maxDepth:           overrides.maxDepth       ?? 0,
      softDepthLimit:     overrides.softDepthLimit ?? 12,
      hardDepthLimit:     overrides.hardDepthLimit ?? 0,
      adaptive:           false,
      adaptiveFactor:     1.5,
      maxPathSegments:    0,
    },
  });
}

export const fractalCubeEngine = createFractalCubeEngine();
