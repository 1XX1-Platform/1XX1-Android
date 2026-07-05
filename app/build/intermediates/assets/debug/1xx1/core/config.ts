/**
 * 1XX1 Yapılandırma Sistemi
 * Aşama 01 Ek + Aşama 03 + Aşama 10 (Pulse Engine genişletme)
 */

export interface CubeConfig {
  dimension:       number;
  splitThreshold:  number;
  maxDepth:        number;
  mergeThreshold:  number;
}

export interface PulseConfig {
  /** Pulse aralığı (ms). Varsayılan: 5000 = 5 saniye */
  intervalMs:           number;
  /** Pulse listesinde tutulan maksimum proje sayısı */
  maxEntries:           number;
  /** (Eski uyumluluk) */
  resetThreshold:       number;
  /** Top'tan Bottom'a rotasyon: her N pulse'da bir en üstteki aşağı gider */
  rotationWindowPulses: number;
  /** Bir projenin art arda kalabileceği maksimum top pulse sayısı */
  maxConsecutiveTop:    number;
  /** Fairness ağırlığı 0–1 */
  fairnessWeight:       number;
  /** Trust Score ağırlığı 0–1 */
  trustWeight:          number;
  /** Snapshot geçmiş sayısı */
  maxSnapshotHistory:   number;
}

export interface SearchConfig {
  minTermLength:  number;
  maxResults:     number;
  fuzzyThreshold: number;
}

export interface ApiConfig {
  port:        number;
  corsOrigins: string[];
  rateLimit:   number;
}

export interface IdConfig {
  prefixes: {
    project:   string;
    developer: string;
    cube:      string;
    event:     string;
  };
}

export interface SystemConfig {
  cube:    CubeConfig;
  pulse:   PulseConfig;
  search:  SearchConfig;
  api:     ApiConfig;
  id:      IdConfig;
  debug:   boolean;
  version: string;
}

export const DEFAULT_CONFIG: Readonly<SystemConfig> = Object.freeze({
  cube: {
    dimension:       11,
    splitThreshold:  64,
    maxDepth:        0,
    mergeThreshold:  8,
  },
  pulse: {
    intervalMs:           5_000,
    maxEntries:           1_000,
    resetThreshold:       100,
    rotationWindowPulses: 1,     // her pulse'da en üsttekini döndür
    maxConsecutiveTop:    3,     // 3 pulse art arda en üstte kalamaz
    fairnessWeight:       0.60,  // fairness baskın
    trustWeight:          0.10,  // küçük etki
    maxSnapshotHistory:   50,
  },
  search: {
    minTermLength:   2,
    maxResults:      50,
    fuzzyThreshold:  0.7,
  },
  api: {
    port:        8080,
    corsOrigins: ["*"],
    rateLimit:   60,
  },
  id: {
    prefixes: {
      project:   "prj",
      developer: "dev",
      cube:      "cub",
      event:     "evt",
    },
  },
  debug:   false,
  version: "0.1.0",
});

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]; };

function deepMerge<T extends object>(base: T, override: DeepPartial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const val = override[key];
    if (val !== undefined && val !== null) {
      if (typeof val === "object" && !Array.isArray(val)) {
        result[key] = deepMerge(base[key] as object, val as DeepPartial<object>) as T[typeof key];
      } else {
        result[key] = val as T[typeof key];
      }
    }
  }
  return result;
}

export class ConfigManager {
  private config: SystemConfig;

  constructor(overrides: DeepPartial<SystemConfig> = {}) {
    this.overrides = overrides;
    this.config = deepMerge(DEFAULT_CONFIG as SystemConfig, overrides);
    this.validate();
  }

  get(): Readonly<SystemConfig> { return this.config; }

  patch(overrides: DeepPartial<SystemConfig>): void {
    this.config = deepMerge(this.config, overrides);
    this.validate();
  }

  totalCells(): number {
    const d = this.config.cube.dimension;
    return d * d * d;
  }

  maxCoordValue(): number { return this.config.cube.dimension - 1; }

  isUnlimitedDepth(): boolean { return this.config.cube.maxDepth === 0; }

  isDepthAllowed(depth: number): boolean {
    if (this.config.cube.maxDepth === 0) return true;
    return depth <= this.config.cube.maxDepth;
  }

  private validate(): void {
    const { cube, pulse, search } = this.config;
    if (cube.dimension < 2 || cube.dimension > 100) throw new Error(`Geçersiz küp boyutu: ${cube.dimension}`);
    if (cube.splitThreshold < 1) throw new Error("splitThreshold en az 1 olmalı");
    if (cube.maxDepth < 0) throw new Error("maxDepth negatif olamaz");
    if (pulse.intervalMs < 100) throw new Error(`Pulse aralığı çok kısa: ${pulse.intervalMs}ms`);
    if (search.minTermLength < 1) throw new Error("Minimum arama uzunluğu en az 1 olmalı");
  }
}

export const config = new ConfigManager();
