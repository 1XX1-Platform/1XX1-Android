/**
 * 1XX1 Logger
 * Aşama 01 — Çekirdek Mimari
 *
 * Basit, modüler konsol logger.
 * Üretimde (production) bu implementasyon dosya tabanlı
 * veya yapılandırılmış JSON logger ile değiştirilebilir —
 * ILogger arayüzü sayesinde diğer modüller etkilenmez.
 */

import type { ILogger } from "./interfaces.ts";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m", // cyan
  INFO:  "\x1b[32m", // green
  WARN:  "\x1b[33m", // yellow
  ERROR: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export class ConsoleLogger implements ILogger {
  private readonly prefix: string;
  private readonly enableDebug: boolean;

  constructor(prefix = "1XX1", enableDebug = false) {
    this.prefix = prefix;
    this.enableDebug = enableDebug;
  }

  private write(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    const color = LEVEL_COLORS[level];
    const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const base = `${color}[${level}]${RESET} ${time} [${this.prefix}] ${message}`;

    if (meta && Object.keys(meta).length > 0) {
      console.log(base, meta);
    } else {
      console.log(base);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("INFO", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("WARN", message, meta);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    this.write("ERROR", message, { ...meta, ...(error ? { err: error.message } : {}) });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.enableDebug) return;
    this.write("DEBUG", message, meta);
  }
}

/** Uygulama genelinde kullanılacak varsayılan logger */
export const logger = new ConsoleLogger("1XX1", false);
