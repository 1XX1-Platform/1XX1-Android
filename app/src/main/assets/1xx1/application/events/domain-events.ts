/**
 * 1XX1 Domain Events
 * Aşama 08 — Domain & Application Services
 *
 * Her domain olayı güçlü tipli bir payload taşır.
 * Application Services bu olayları EventBus'a yayınlar.
 * Diğer servisler dinleyebilir — CORE scope kuralları geçerlidir.
 *
 * Olay tasarımı prensibi:
 *   - Geçmiş zaman ("published", "archived") — olan bir şeyi anlatır
 *   - Yeterli veri — dinleyici tekrar DB'ye sorgu atmamalı
 *   - Değiştirilemez — yayınlanmış olay mutasyona uğramaz
 */

import type { Project, Developer, CubeCoordinate, LicenseType } from "../core/types.ts";
import type { IEventBus } from "../core/interfaces.ts";

// ─── Olay Yük Tipleri ────────────────────────────────────────────────────────

export interface ProjectPublishedPayload {
  projectId:   string;
  name:        string;
  developerId: string;
  cube:        CubeCoordinate;
  cubePath:    string;
  tags:        string[];
  license:     LicenseType;
  repo:        string;
  publishedAt: Date;
}

export interface ProjectVerifiedPayload {
  projectId:   string;
  verifiedAt:  Date;
  verifiedBy:  "ai" | "manual";
}

export interface ProjectRejectedPayload {
  projectId:   string;
  reason:      string;
  rejectedAt:  Date;
  rejectedBy:  "ai" | "policy" | "manual";
}

export interface ProjectArchivedPayload {
  projectId:   string;
  developerId: string;
  archivedAt:  Date;
  reason?:     string;
}

export interface DeveloperRegisteredPayload {
  developerId: string;
  username:    string;
  joinedAt:    Date;
}

export interface DeveloperMaskedPayload {
  developerId: string;
  maskAlias:   string;
  maskedAt:    Date;
}

export interface AssetLinkedPayload {
  projectId: string;
  assetId:   string;
  assetType: string;
  linkedAt:  Date;
}

export interface ChannelCreatedPayload {
  developerId: string;
  channelId:   string;
  channelName: string;
  createdAt:   Date;
}

// ─── Domain Event Publisher ───────────────────────────────────────────────────

/**
 * Tüm domain olaylarını yayınlayan yardımcı sınıf.
 * Application Services bu sınıfı kullanır; doğrudan eventBus.emit() değil.
 * Zorunlu scope ve idempotency key otomatik eklenir.
 */
export class DomainEventPublisher {

  constructor(bus: IEventBus) {
    this.bus = bus;}

  projectPublished(payload: ProjectPublishedPayload): void {
    this.bus.emit(
      "project:published" as never,
      { ...payload, scope: "core" },
      `proj-pub:${payload.projectId}`
    );
  }

  projectVerified(payload: ProjectVerifiedPayload): void {
    this.bus.emit(
      "project:verified" as never,
      { ...payload, scope: "core" },
      `proj-ver:${payload.projectId}`
    );
  }

  projectRejected(payload: ProjectRejectedPayload): void {
    this.bus.emit(
      "project:rejected" as never,
      { ...payload, scope: "core" },
      `proj-rej:${payload.projectId}:${payload.rejectedAt.getTime()}`
    );
  }

  projectArchived(payload: ProjectArchivedPayload): void {
    this.bus.emit(
      "project:archived",
      { ...payload, scope: "core" },
      `proj-arc:${payload.projectId}`
    );
  }

  developerRegistered(payload: DeveloperRegisteredPayload): void {
    this.bus.emit(
      "developer:registered" as never,
      { ...payload, scope: "core" },
      `dev-reg:${payload.developerId}`
    );
  }

  developerMasked(payload: DeveloperMaskedPayload): void {
    this.bus.emit(
      "developer:masked" as never,
      { ...payload, scope: "core" },
      `dev-mask:${payload.developerId}:${payload.maskAlias}`
    );
  }

  assetLinked(payload: AssetLinkedPayload): void {
    this.bus.emit(
      "asset:linked" as never,
      { ...payload, scope: "core" },
      `asset-link:${payload.projectId}:${payload.assetId}`
    );
  }

  channelCreated(payload: ChannelCreatedPayload): void {
    this.bus.emit(
      "channel:created" as never,
      { ...payload, scope: "core" },
      `ch-create:${payload.developerId}`
    );
  }
}
