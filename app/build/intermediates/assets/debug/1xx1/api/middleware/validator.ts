/**
 * 1XX1 Request Validator
 * Aşama 06 — Middleware
 *
 * Sorumluluk: gelen DTO'ları doğrula ve sanitize et.
 * SearchEngine veya IndexManager'a hiçbir bağımlılık yoktur.
 * Yalnızca ham veriyi kontrol eder.
 *
 * Kurallar:
 *   query: string, 2–500 karakter
 *   limit: 1–100
 *   offset: ≥ 0
 *   weights: her bileşen 0–1, toplam ≤ 1.05 (yuvarlama payı)
 *   coord: x,y,z 0–10
 */

import { SystemError, ErrorCode } from "../../core/errors.ts";
import type {
  SearchRequestDTO,
  StreamSearchRequestDTO,
} from "../types.ts";

// ─── Sınırlar ─────────────────────────────────────────────────────────────────

const LIMITS = {
  QUERY_MIN:    2,
  QUERY_MAX:    500,
  LIMIT_MIN:    1,
  LIMIT_MAX:    100,
  OFFSET_MAX:   10_000,
  TAGS_MAX:     20,
  TAG_LEN_MAX:  64,
  COORD_MIN:    0,
  COORD_MAX:    10,
  WEIGHT_MIN:   0,
  WEIGHT_MAX:   1,
} as const;

// ─── ValidationResult ────────────────────────────────────────────────────────

export interface ValidationResult<T> {
  ok:     true;
  value:  T;
}

export interface ValidationError {
  ok:      false;
  errors:  string[];
}

export type ValidationOutcome<T> = ValidationResult<T> | ValidationError;

// ─── Validator ───────────────────────────────────────────────────────────────

export class RequestValidator {

  /**
   * POST /search body doğrulaması.
   * Geçerli ise sanitize edilmiş DTO döndürür.
   */
  validateSearch(body: unknown): ValidationOutcome<SearchRequestDTO> {
    const errors: string[] = [];

    if (!body || typeof body !== "object") {
      return { ok: false, errors: ["Request body geçerli bir JSON nesnesi olmalı"] };
    }

    const raw = body as Record<string, unknown>;

    // ── query ──
    const query = this._validateString("query", raw.query, {
      min: LIMITS.QUERY_MIN,
      max: LIMITS.QUERY_MAX,
      required: true,
    });
    if (typeof query === "string") {
      errors.push(query);
    }

    // ── limit ──
    const limit = this._validateInt("limit", raw.limit ?? 20, {
      min: LIMITS.LIMIT_MIN,
      max: LIMITS.LIMIT_MAX,
    });
    if (typeof limit === "string") errors.push(limit);

    // ── offset ──
    const offset = this._validateInt("offset", raw.offset ?? 0, {
      min: 0,
      max: LIMITS.OFFSET_MAX,
    });
    if (typeof offset === "string") errors.push(offset);

    // ── filter ──
    if (raw.filter !== undefined) {
      const filterErrors = this._validateFilter(raw.filter);
      errors.push(...filterErrors);
    }

    // ── weights ──
    if (raw.weights !== undefined) {
      const weightErrors = this._validateWeights(raw.weights);
      errors.push(...weightErrors);
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
      ok: true,
      value: {
        query:   (query as { value: string }).value,
        limit:   (limit as { value: number }).value,
        offset:  (offset as { value: number }).value,
        explain: raw.explain === true,
        filter:  raw.filter as SearchRequestDTO["filter"],
        weights: raw.weights as SearchRequestDTO["weights"],
      },
    };
  }

  /**
   * GET /search/stream query params doğrulaması.
   */
  validateStream(params: Record<string, string>): ValidationOutcome<StreamSearchRequestDTO> {
    const errors: string[] = [];
    const q = params["q"] ?? params["query"] ?? "";

    const query = this._validateString("q", q, {
      min: LIMITS.QUERY_MIN,
      max: LIMITS.QUERY_MAX,
      required: true,
    });
    if (typeof query === "string") errors.push(query);

    const limit = this._validateInt("limit", parseInt(params["limit"] ?? "20", 10), {
      min: LIMITS.LIMIT_MIN,
      max: LIMITS.LIMIT_MAX,
    });
    if (typeof limit === "string") errors.push(limit);

    if (errors.length > 0) return { ok: false, errors };

    return {
      ok: true,
      value: {
        query:  (query as { value: string }).value,
        limit:  (limit as { value: number }).value,
      },
    };
  }

  // ─── Yardımcılar ─────────────────────────────────────────────────────────

  private _validateString(
    field: string,
    value: unknown,
    opts: { min: number; max: number; required?: boolean }
  ): { value: string } | string {
    if (value === undefined || value === null || value === "") {
      if (opts.required) return `"${field}" zorunlu alan`;
      return { value: "" };
    }
    if (typeof value !== "string") return `"${field}" string olmalı`;
    const trimmed = value.trim();
    if (trimmed.length < opts.min) {
      return `"${field}" en az ${opts.min} karakter olmalı`;
    }
    if (trimmed.length > opts.max) {
      return `"${field}" en fazla ${opts.max} karakter olabilir`;
    }
    return { value: trimmed };
  }

  private _validateInt(
    field: string,
    value: unknown,
    opts: { min: number; max: number }
  ): { value: number } | string {
    const n = typeof value === "number" ? value : parseInt(String(value), 10);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return `"${field}" tam sayı olmalı`;
    }
    if (n < opts.min) return `"${field}" en az ${opts.min} olmalı`;
    if (n > opts.max) return `"${field}" en fazla ${opts.max} olabilir`;
    return { value: n };
  }

  private _validateFilter(filter: unknown): string[] {
    const errors: string[] = [];
    if (typeof filter !== "object" || !filter) return ["filter geçerli bir nesne olmalı"];

    const f = filter as Record<string, unknown>;

    if (f.tags !== undefined) {
      if (!Array.isArray(f.tags)) {
        errors.push("filter.tags dizi olmalı");
      } else {
        if (f.tags.length > LIMITS.TAGS_MAX) {
          errors.push(`filter.tags en fazla ${LIMITS.TAGS_MAX} eleman içerebilir`);
        }
        for (const tag of f.tags) {
          if (typeof tag !== "string") {
            errors.push("filter.tags elemanları string olmalı");
            break;
          }
          if (tag.length > LIMITS.TAG_LEN_MAX) {
            errors.push(`filter.tags etiketi en fazla ${LIMITS.TAG_LEN_MAX} karakter`);
            break;
          }
        }
      }
    }

    if (f.coord !== undefined) {
      const c = f.coord as Record<string, unknown>;
      for (const axis of ["x", "y", "z"] as const) {
        const v = Number(c[axis]);
        if (!Number.isInteger(v) || v < LIMITS.COORD_MIN || v > LIMITS.COORD_MAX) {
          errors.push(`filter.coord.${axis} 0–10 arası tam sayı olmalı`);
        }
      }
    }

    return errors;
  }

  private _validateWeights(weights: unknown): string[] {
    const errors: string[] = [];
    if (typeof weights !== "object" || !weights) return ["weights geçerli bir nesne olmalı"];

    const w = weights as Record<string, unknown>;
    const fields = ["semantic", "structural", "metadata", "recency"];
    let total = 0;

    for (const field of fields) {
      if (w[field] !== undefined) {
        const v = Number(w[field]);
        if (!Number.isFinite(v) || v < LIMITS.WEIGHT_MIN || v > LIMITS.WEIGHT_MAX) {
          errors.push(`weights.${field} 0–1 arası sayı olmalı`);
        } else {
          total += v;
        }
      }
    }

    // Toplam ağırlık 1.05'i geçmesin (yuvarlama payı)
    if (total > 1.05) {
      errors.push(`weights toplamı en fazla 1.0 olabilir (şu an: ${total.toFixed(2)})`);
    }

    return errors;
  }
}

/**
 * Doğrulama hatalarını SystemError'a çevir.
 * Route handler'lar bu fonksiyonu kullanır.
 */
export function throwIfInvalid<T>(result: ValidationOutcome<T>): asserts result is ValidationResult<T> {
  if (!result.ok) {
    throw new SystemError({
      code:    ErrorCode.INVALID_QUERY,
      message: result.errors.join("; "),
      severity: "low",
      context: { errors: result.errors },
    });
  }
}

export const validator = new RequestValidator();
