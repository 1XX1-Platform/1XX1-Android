/**
 * 1XX1 Commands (CQRS — Yazma Tarafı)
 * Aşama 08 — Domain & Application Services
 *
 * Command: sistemi değiştirmeyi isteyen niyetin temsili.
 *   - Değiştirilemez (readonly alanlar)
 *   - Yalnızca gerekli veriyi taşır
 *   - İş kuralları içermez (validator katmanında)
 *   - Her command bir ve yalnızca bir işlemi temsil eder
 *
 * CQRS ayrımı:
 *   Command → Orchestrator → Service → Repository + CubeEngine + IndexManager + EventStore
 *   Query   → QueryService → Repository (read-only)
 */

import type { CubeCoordinate, LicenseType, ProjectStatus } from "../core/types.ts";

// ─── Proje Komutları ──────────────────────────────────────────────────────────

export interface CreateProjectCommand {
  readonly name:             string;
  readonly description:      string;
  readonly cube:             CubeCoordinate;
  readonly developerId:      string;
  readonly repo:             string;
  readonly tags:             string[];
  readonly license:          LicenseType;
  readonly donationAddress?: string;
  /** Otomatik küp ataması: true ise küp motoru uygun koordinatı seçer */
  readonly autoPlace?:       boolean;
}

export interface UpdateProjectCommand {
  readonly projectId:        string;
  readonly requesterId:      string;  // yalnızca proje sahibi güncelleyebilir
  readonly name?:            string;
  readonly description?:     string;
  readonly repo?:            string;
  readonly tags?:            string[];
  readonly license?:         LicenseType;
  readonly donationAddress?: string;
}

export interface ArchiveProjectCommand {
  readonly projectId:   string;
  readonly requesterId: string;
  readonly reason?:     string;
}

export interface MoveProjectCommand {
  readonly projectId:   string;
  readonly requesterId: string;
  readonly newCube:     CubeCoordinate;
  readonly newPath?:    string;  // derin fraktal path için opsiyonel
}

export interface VerifyProjectCommand {
  readonly projectId: string;
  readonly verifiedBy: "ai" | "manual";
}

export interface RejectProjectCommand {
  readonly projectId:  string;
  readonly reason:     string;
  readonly rejectedBy: "ai" | "policy" | "manual";
}

// ─── Geliştirici Komutları ────────────────────────────────────────────────────

export interface RegisterDeveloperCommand {
  readonly username:         string;
  readonly displayName:      string;
  readonly bio?:             string;
  readonly website?:         string;
  readonly donationAddress?: string;
}

export interface UpdateDeveloperCommand {
  readonly developerId:      string;
  readonly displayName?:     string;
  readonly bio?:             string;
  readonly website?:         string;
  readonly donationAddress?: string;
}

export interface MaskDeveloperCommand {
  readonly developerId: string;
  readonly maskAlias:   string;
}

export interface CreateChannelCommand {
  readonly developerId: string;
  readonly channelName: string;
}

// ─── Command Sonucu ───────────────────────────────────────────────────────────

export interface CommandResult<T = void> {
  ok:        true;
  data:      T;
  eventIds?: string[];  // yayınlanan domain event ID'leri
}

export interface CommandFailure {
  ok:      false;
  code:    string;
  message: string;
  field?:  string;   // hangi alan hata verdi
}

export type CommandOutcome<T = void> = CommandResult<T> | CommandFailure;

export function succeed<T>(data: T, eventIds?: string[]): CommandResult<T> {
  return { ok: true, data, eventIds };
}

export function fail(code: string, message: string, field?: string): CommandFailure {
  return { ok: false, code, message, field };
}
