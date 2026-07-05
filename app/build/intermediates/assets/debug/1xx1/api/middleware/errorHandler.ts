/**
 * 1XX1 Error Handler
 * Aşama 06 — Middleware
 *
 * Tüm modüllerden gelen SystemError'ları HTTP yanıtına çevirir.
 * Ham Error veya bilinmeyen tipler INTERNAL_ERROR'a dönüşür.
 * Stack trace üretimde asla istemciye gönderilmez.
 */

import { SystemError, isSystemError, ErrorCode } from "../../core/errors.ts";
import { errorToStatus } from "../types.ts";
import type { ApiErrorDTO } from "../types.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── HTTP Yanıt Temsili ───────────────────────────────────────────────────────

export interface HttpError {
  status:  number;
  body:    ApiErrorDTO;
}

// ─── ErrorHandler ─────────────────────────────────────────────────────────────

export class ErrorHandler {

  constructor(logger?: ILogger) {
    this.logger = logger;}

  /**
   * Herhangi bir hatayı HTTP hata temsiline çevir.
   */
  handle(err: unknown, requestId?: string): HttpError {
    if (isSystemError(err)) {
      return this._fromSystemError(err, requestId);
    }

    if (err instanceof Error) {
      return this._fromGenericError(err, requestId);
    }

    return this._unknown(requestId);
  }

  private _fromSystemError(err: SystemError, requestId?: string): HttpError {
    const status = errorToStatus(err.code);

    // 5xx hataları logla
    if (status >= 500) {
      this.logger?.error(`API hata [${err.code}]: ${err.message}`, err, {
        requestId,
        context: err.context,
      });
    } else {
      this.logger?.debug(`API istemci hatası [${err.code}]: ${err.message}`, {
        requestId,
      });
    }

    return {
      status,
      body: err.toApiError(),
    };
  }

  private _fromGenericError(err: Error, requestId?: string): HttpError {
    this.logger?.error("Beklenmeyen hata", err, { requestId });
    return {
      status: 500,
      body: {
        code:    ErrorCode.INTERNAL_ERROR,
        message: "Sunucu hatası. Lütfen daha sonra tekrar deneyin.",
      },
    };
  }

  private _unknown(requestId?: string): HttpError {
    this.logger?.error("Bilinmeyen hata tipi", undefined, { requestId });
    return {
      status: 500,
      body: {
        code:    ErrorCode.INTERNAL_ERROR,
        message: "Beklenmeyen hata.",
      },
    };
  }
}

export const errorHandler = new ErrorHandler();
