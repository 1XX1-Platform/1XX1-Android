/**
 * 1XX1 Channel — Dışa Aktarma ve ChannelUnitOfWork
 * Aşama 09 — Kanal Sistemi 2.0
 */

export * from "./entities/channel.entity.ts";
export * from "./repositories/channel.repository.ts";
export * from "./trust/trust-score.ts";
export * from "./services/channel.services.ts";

import type { IProjectRepository } from "../core/interfaces.ts";
import type { IEventBus, ILogger } from "../core/interfaces.ts";
import {
  InMemoryChannelRepository,
  InMemoryReleaseRepository,
  InMemoryFollowRepository,
  InMemoryTrustScoreRepository,
} from "./repositories/channel.repository.ts";
import {
  ChannelService,
  ReleaseService,
  FollowService,
} from "./services/channel.services.ts";
import { TrustScoreEngine } from "./trust/trust-score.ts";

// ─── ChannelUnitOfWork ────────────────────────────────────────────────────────

export class ChannelUnitOfWork {
  readonly channelRepo:   InMemoryChannelRepository;
  readonly releaseRepo:   InMemoryReleaseRepository;
  readonly followRepo:    InMemoryFollowRepository;
  readonly trustRepo:     InMemoryTrustScoreRepository;

  readonly channelService: ChannelService;
  readonly releaseService: ReleaseService;
  readonly followService:  FollowService;
  readonly trustEngine:    TrustScoreEngine;

  constructor(
    projectRepo: IProjectRepository,
    eventBus?:   IEventBus,
    logger?:     ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.projectRepo = projectRepo;
    this.channelRepo = new InMemoryChannelRepository();
    this.releaseRepo = new InMemoryReleaseRepository();
    this.followRepo  = new InMemoryFollowRepository();
    this.trustRepo   = new InMemoryTrustScoreRepository();
    this.trustEngine = new TrustScoreEngine();

    this.channelService = new ChannelService(
      this.channelRepo, this.trustRepo, projectRepo, eventBus, logger
    );
    this.releaseService = new ReleaseService(
      this.releaseRepo, this.channelRepo, eventBus, logger
    );
    this.followService  = new FollowService(
      this.followRepo, this.channelRepo, eventBus, logger
    );
  }
}
