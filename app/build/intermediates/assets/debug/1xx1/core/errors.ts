/**
 * 1XX1 Hata Modeli
 * Aşama 01 — Çekirdek Mimari (Ek: Hata Sözleşmesi)
 *
 * Tüm modüller bu sözleşmeyi kullanır.
 * Hiçbir modül ham Error fırlatmaz — her zaman SystemError döner.
 */

// ─── Hata Kodları ─────────────────────────────────────────────────────────────

export const ErrorCode = {
  // Koordinat hataları
  INVALID_COORDINATE:        "INVALID_COORDINATE",
  COORDINATE_OUT_OF_BOUNDS:  "COORDINATE_OUT_OF_BOUNDS",

  // Küp hataları
  CUBE_FULL:                 "CUBE_FULL",
  CUBE_NOT_FOUND:            "CUBE_NOT_FOUND",
  CUBE_ALREADY_EXISTS:       "CUBE_ALREADY_EXISTS",

  // Proje hataları
  PROJECT_NOT_FOUND:         "PROJECT_NOT_FOUND",
  PROJECT_ALREADY_EXISTS:    "PROJECT_ALREADY_EXISTS",
  PROJECT_VALIDATION_FAILED: "PROJECT_VALIDATION_FAILED",

  // Geliştirici hataları
  DEVELOPER_NOT_FOUND:       "DEVELOPER_NOT_FOUND",
  DEVELOPER_ALREADY_EXISTS:  "DEVELOPER_ALREADY_EXISTS",

  // Arama hataları
  SEARCH_TERM_TOO_SHORT:     "SEARCH_TERM_TOO_SHORT",
  SEARCH_INDEX_ERROR:        "SEARCH_INDEX_ERROR",

  // Nabız hataları
  PULSE_ALREADY_RUNNING:     "PULSE_ALREADY_RUNNING",
  PULSE_NOT_RUNNING:         "PULSE_NOT_RUNNING",

  // Genel
  VALIDATION_FAILED:         "VALIDATION_FAILED",
  NOT_IMPLEMENTED:           "NOT_IMPLEMENTED",
  INTERNAL_ERROR:            "INTERNAL_ERROR",
  UNAUTHORIZED:              "UNAUTHORIZED",
  RATE_LIMITED:              "RATE_LIMITED",

  // API hataları (Aşama 06)
  INVALID_QUERY:             "INVALID_QUERY",
  QUERY_TIMEOUT:             "QUERY_TIMEOUT",
  LIMIT_EXCEEDED:            "LIMIT_EXCEEDED",
  ENGINE_FAILURE:            "ENGINE_FAILURE",
  STREAM_ABORTED:            "STREAM_ABORTED",
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

// ─── HTTP Benzeri Hata Kategorileri ──────────────────────────────────────────

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

// ─── Sistem Hatası ────────────────────────────────────────────────────────────

export interface SystemErrorOptions {
  code: ErrorCode;
  message: string;
  severity?: ErrorSeverity;
  context?: Record<string, unknown>;
  cause?: Error;
}

export class SystemError extends Error {
  readonly code: ErrorCode;
  readonly severity: ErrorSeverity;
  readonly context: Record<string, unknown>;
  readonly timestamp: Date;

  constructor(options: SystemErrorOptions) {
    super(options.message);
    this.name = "SystemError";
    this.code = options.code;
    this.severity = options.severity ?? "medium";
    this.context = options.context ?? {};
    this.timestamp = new Date();

    // cause zinciri (Node 16.9+ / Deno 1.27+)
    if (options.cause) {
      this.cause = options.cause;
    }
  }

  /** Loglama için düz nesne döndürür */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
    };
  }

  /** API yanıtı için güvenli temsil (stack trace içermez) */
  toApiError(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

// ─── Hızlı Fabrika Fonksiyonları ──────────────────────────────────────────────

export const Errors = {
  invalidCoordinate: (coord: unknown) =>
    new SystemError({
      code: ErrorCode.INVALID_COORDINATE,
      message: `Geçersiz koordinat: ${JSON.stringify(coord)}`,
      severity: "low",
      context: { coord },
    }),

  cubeFull: (coord: unknown, maxCapacity: number) =>
    new SystemError({
      code: ErrorCode.CUBE_FULL,
      message: `Küp dolu (max: ${maxCapacity}): ${JSON.stringify(coord)}`,
      severity: "low",
      context: { coord, maxCapacity },
    }),

  projectNotFound: (id: string) =>
    new SystemError({
      code: ErrorCode.PROJECT_NOT_FOUND,
      message: `Proje bulunamadı: ${id}`,
      severity: "low",
      context: { id },
    }),

  developerNotFound: (id: string) =>
    new SystemError({
      code: ErrorCode.DEVELOPER_NOT_FOUND,
      message: `Geliştirici bulunamadı: ${id}`,
      severity: "low",
      context: { id },
    }),

  notImplemented: (feature: string) =>
    new SystemError({
      code: ErrorCode.NOT_IMPLEMENTED,
      message: `Henüz uygulanmadı: ${feature}`,
      severity: "low",
      context: { feature },
    }),

  internal: (message: string, cause?: Error) =>
    new SystemError({
      code: ErrorCode.INTERNAL_ERROR,
      message,
      severity: "critical",
      cause,
    }),
} as const;

// ─── Tip Koruması ─────────────────────────────────────────────────────────────

export function isSystemError(err: unknown): err is SystemError {
  return err instanceof SystemError;
}

// Kanal hataları (Aşama 09)
export const ChannelErrorCode = {
  CHANNEL_NOT_FOUND:       "CHANNEL_NOT_FOUND",
  CHANNEL_SLUG_TAKEN:      "CHANNEL_SLUG_TAKEN",
  CHANNEL_ALREADY_EXISTS:  "CHANNEL_ALREADY_EXISTS",
  RELEASE_NOT_FOUND:       "RELEASE_NOT_FOUND",
  RELEASE_VERSION_EXISTS:  "RELEASE_VERSION_EXISTS",
  WALLET_LIMIT_EXCEEDED:   "WALLET_LIMIT_EXCEEDED",
  WALLET_DUPLICATE:        "WALLET_DUPLICATE",
  ALREADY_FOLLOWING:       "ALREADY_FOLLOWING",
  NOT_FOLLOWING:           "NOT_FOLLOWING",
  CHANNEL_PRIVATE:         "CHANNEL_PRIVATE",
} as const;
