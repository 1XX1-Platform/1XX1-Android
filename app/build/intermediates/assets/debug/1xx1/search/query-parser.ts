/**
 * 1XX1 QueryParser
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Sorumluluk: ham metin → ParsedQuery
 *   - normalize + tokenize
 *   - intent detection
 *   - CubePath / koordinat tespiti
 *   - varsayılan seçenekleri doldur
 *
 * Bu modül hiçbir index veya engine'e bağımlı değil.
 * Saf metin analizi yapar.
 */

import type { ParsedQuery, QueryIntent, RawQuery, QueryOptions, QueryFilter } from "./search-types.ts";
import type { CubeCoordinate } from "../core/types.ts";
import { tokenize, normalize } from "./tokenizer.ts";
import { isValidCubePath, parseCubePath } from "../cube_engine/cube-path.ts";
import { isValidCoord } from "../core/utils.ts";

// ─── Varsayılan Seçenekler ────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<QueryOptions> = {
  limit:       20,
  offset:      0,
  minScore:    0.0,
  weights:     {},
  includePath: false,
  explain:     false,
};

// ─── Intent Sinyalleri ────────────────────────────────────────────────────────

/**
 * Structural sinyal kalıpları:
 *   "4/7/2"           → tam CubePath
 *   "cube:4/7/2"      → açık etiket
 *   "4,7,2"           → koordinat üçlüsü
 *   "@4/7/2"          → @ öneki
 */
const STRUCTURAL_PATTERNS = [
  /^cube:\d+\/\d+\/\d+/i,    // cube:4/7/2
  /^@\d+\/\d+\/\d+/,         // @4/7/2
  /^\d+\/\d+\/\d+(\/\d+)*/,  // 4/7/2 veya 4/7/2/3/8
  /^\d+,\d+,\d+$/,            // 4,7,2
];

// ─── QueryParser ─────────────────────────────────────────────────────────────

export class QueryParser {

  /**
   * Ana parse metodu.
   * Ham sorguyu alır, zenginleştirilmiş ParsedQuery döndürür.
   */
  parse(raw: RawQuery): ParsedQuery {
    const term       = raw.term?.trim() ?? "";
    const normalized = normalize(term);
    const { tokens } = tokenize(term, { removeStops: true, includeNgrams: false });

    const intent      = this._detectIntent(normalized);
    const targetCoord = this._extractCoord(normalized);
    const targetPath  = this._extractPath(normalized);

    const options: Required<QueryOptions> = {
      ...DEFAULT_OPTIONS,
      ...raw.options,
      weights: { ...DEFAULT_OPTIONS.weights, ...raw.options?.weights },
    };

    const filter: QueryFilter = raw.filter ?? {};

    // Structural query'de filter.coord'u da doldur
    if (targetCoord && !filter.coord) {
      filter.coord = targetCoord;
    }

    return {
      raw:        term,
      normalized,
      tokens:     this._cleanTokens(tokens, normalized),
      intent,
      targetCoord,
      targetPath,
      filter,
      options,
    };
  }

  // ─── Intent Detection ────────────────────────────────────────────────────

  /**
   * Sorgu niyetini tespit et.
   *
   *   Structural sinyal varsa → structural (yalnız) veya hybrid (kelime de varsa)
   *   Aksi hâlde → semantic
   */
  detectIntent(term: string): QueryIntent {
    return this._detectIntent(normalize(term));
  }

  private _detectIntent(normalized: string): QueryIntent {
    const hasStructural = STRUCTURAL_PATTERNS.some((p) => p.test(normalized));
    if (!hasStructural) return "semantic";

    // Structural sinyalin yanında anlamlı kelimeler de var mı?
    const stripped = this._stripStructuralSignals(normalized);
    const { tokens } = tokenize(stripped, { removeStops: true });
    return tokens.length > 0 ? "hybrid" : "structural";
  }

  // ─── Koordinat/Path Çıkarma ──────────────────────────────────────────────

  private _extractCoord(normalized: string): CubeCoordinate | undefined {
    // "4,7,2" formatı
    const commaMatch = normalized.match(/(\d+),(\d+),(\d+)/);
    if (commaMatch) {
      const coord = {
        x: parseInt(commaMatch[1], 10),
        y: parseInt(commaMatch[2], 10),
        z: parseInt(commaMatch[3], 10),
      };
      if (isValidCoord(coord)) return coord;
    }

    // CubePath formatı: "4/7/2" veya "cube:4/7/2"
    const pathStr = this._extractRawPath(normalized);
    if (pathStr) {
      try {
        const parsed = parseCubePath(pathStr);
        if (isValidCoord(parsed.root)) return parsed.root;
      } catch { /* geçersiz path */ }
    }

    return undefined;
  }

  private _extractPath(normalized: string): string | undefined {
    const raw = this._extractRawPath(normalized);
    if (raw && isValidCubePath(raw)) return raw;
    return undefined;
  }

  private _extractRawPath(normalized: string): string | undefined {
    // "cube:4/7/2/3" → "4/7/2/3"
    const cubeMatch = normalized.match(/cube:(\d+\/\d+\/\d+(?:\/\d+)*)/i);
    if (cubeMatch) return cubeMatch[1];

    // "@4/7/2" → "4/7/2"
    const atMatch = normalized.match(/@(\d+\/\d+\/\d+(?:\/\d+)*)/);
    if (atMatch) return atMatch[1];

    // Saf "4/7/2" — yalnızca başta veya tek başına
    const plainMatch = normalized.match(/(?:^|\s)(\d+\/\d+\/\d+(?:\/\d+)*)(?:\s|$)/);
    if (plainMatch) return plainMatch[1];

    return undefined;
  }

  private _stripStructuralSignals(normalized: string): string {
    return normalized
      .replace(/cube:\d+\/\d+\/\d+(\/\d+)*/gi, "")
      .replace(/@\d+\/\d+\/\d+(\/\d+)*/g, "")
      .replace(/\d+\/\d+\/\d+(\/\d+)*/g, "")
      .replace(/\d+,\d+,\d+/g, "")
      .trim();
  }

  private _cleanTokens(tokens: string[], normalized: string): string[] {
    // Structural sinyalleri token listesinden temizle
    const stripped = this._stripStructuralSignals(normalized);
    const { tokens: clean } = tokenize(stripped, { removeStops: true });
    // Özgün tokenları da dahil et (intersection değil union)
    const merged = new Set([...tokens, ...clean]);
    return Array.from(merged).filter((t) => t.length >= 2);
  }
}

/** Tekil örnek */
export const queryParser = new QueryParser();
