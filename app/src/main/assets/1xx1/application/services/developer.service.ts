/**
 * 1XX1 DeveloperService + SearchApplicationService
 * Aşama 08 — Domain & Application Services
 *
 * DeveloperService: geliştirici yaşam döngüsü
 * SearchApplicationService: arama motorunu API'den tamamen ayırır
 */

import type { Developer } from "../../core/types.ts";
import type { UnitOfWork } from "../../database/index.ts";
import type { SearchEngine } from "../../search/search-engine.ts";
import type { ILogger } from "../../core/interfaces.ts";
import {
  RegisterDeveloperCommand,
  UpdateDeveloperCommand,
  MaskDeveloperCommand,
  CreateChannelCommand,
  CommandOutcome,
  succeed,
  fail,
} from "../commands/commands.ts";
import {
  SearchProjectsQuery,
  GetProjectQuery,
  ListDeveloperProjectsQuery,
  QueryOutcome,
  queryOk,
  queryErr,
  toProjectSummary,
} from "../queries/queries.ts";
import { DeveloperValidator } from "../validators/domain-validators.ts";
import { PolicyEngine } from "../policies/policies.ts";
import { DomainEventPublisher } from "../events/domain-events.ts";
import { ErrorCode } from "../../core/errors.ts";
import { newProjectID } from "../../core/identity.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// DeveloperService
// ═══════════════════════════════════════════════════════════════════════════════

export class DeveloperService {
  private readonly validator: DeveloperValidator;
  private readonly policy:    PolicyEngine;

  constructor(
    db:        UnitOfWork,
    publisher: DomainEventPublisher,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.publisher = publisher;
    this.db = db;
    this.validator = new DeveloperValidator(db.developers);
    this.policy    = new PolicyEngine();
  }

  // ─── Kayıt ──────────────────────────────────────────────────────────────

  async register(cmd: RegisterDeveloperCommand): Promise<CommandOutcome<Developer>> {
    const validation = await this.validator.validateRegister(cmd);
    if (!validation.ok) {
      const v = validation.violations[0];
      return fail(v.code, v.message, v.field);
    }

    try {
      const developer = await this.db.tx.run(async (tx) => {
        const dev = await this.db.developers.create({
          username:        cmd.username,
          displayName:     cmd.displayName,
          bio:             cmd.bio,
          website:         cmd.website,
          donationAddress: cmd.donationAddress,
        }, tx);

        await this.db.events.store(
          "core", "developer:registered" as never,
          { developerId: dev.id, username: dev.username },
          `dev-reg:${dev.id}`,
          tx
        );
        return dev;
      });

      this.publisher.developerRegistered({
        developerId: developer.id,
        username:    developer.username,
        joinedAt:    developer.joinedAt,
      });

      this.logger?.info(`Geliştirici kayıt: ${developer.id} (@${developer.username})`);
      return succeed(developer);

    } catch (err) {
      this.logger?.error("Geliştirici kayıt hatası", err instanceof Error ? err : undefined);
      return fail(ErrorCode.INTERNAL_ERROR, "Geliştirici kaydedilemedi");
    }
  }

  // ─── Profil Güncelleme ───────────────────────────────────────────────────

  async updateProfile(cmd: UpdateDeveloperCommand): Promise<CommandOutcome<Developer>> {
    const decision = this.policy.developer.canUpdateProfile(cmd.developerId, cmd.developerId);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    const existing = await this.db.developers.findById(cmd.developerId);
    if (!existing) return fail(ErrorCode.DEVELOPER_NOT_FOUND, `Geliştirici bulunamadı: ${cmd.developerId}`);

    const updated = await this.db.developers.update(cmd.developerId, {
      displayName:     cmd.displayName,
      bio:             cmd.bio,
      website:         cmd.website,
      donationAddress: cmd.donationAddress,
    });

    if (!updated) return fail(ErrorCode.INTERNAL_ERROR, "Güncelleme başarısız");

    this.logger?.info(`Geliştirici güncellendi: ${cmd.developerId}`);
    return succeed(updated);
  }

  // ─── Takma Kimlik ────────────────────────────────────────────────────────

  async mask(cmd: MaskDeveloperCommand): Promise<CommandOutcome<void>> {
    const developer = await this.db.developers.findById(cmd.developerId);
    if (!developer) return fail(ErrorCode.DEVELOPER_NOT_FOUND, `Geliştirici bulunamadı: ${cmd.developerId}`);

    const decision = this.policy.developer.canMask(developer);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    // Takma kimlik çakışması kontrolü
    const existing = await this.db.developers.findByUsername(cmd.maskAlias);
    if (existing) return fail("MASK_ALIAS_TAKEN", `"${cmd.maskAlias}" takma kimliği zaten kullanılıyor`);

    await this.db.events.store(
      "core", "developer:masked" as never,
      { developerId: cmd.developerId, maskAlias: cmd.maskAlias },
      `dev-mask:${cmd.developerId}:${cmd.maskAlias}`
    );

    this.publisher.developerMasked({
      developerId: cmd.developerId,
      maskAlias:   cmd.maskAlias,
      maskedAt:    new Date(),
    });

    this.logger?.info(`Geliştirici maskelendi: ${cmd.developerId} → @${cmd.maskAlias}`);
    return succeed(undefined);
  }

  // ─── Kanal Oluşturma ─────────────────────────────────────────────────────

  async createChannel(cmd: CreateChannelCommand): Promise<CommandOutcome<string>> {
    const developer = await this.db.developers.findById(cmd.developerId);
    if (!developer) return fail(ErrorCode.DEVELOPER_NOT_FOUND, `Geliştirici bulunamadı: ${cmd.developerId}`);

    // Mevcut kanal sayısını hesapla (şimdilik event store'dan)
    const events = await this.db.events.findByType("core", "channel:created" as never, 100, 0);
    const devChannels = events.filter((e) => e.payload["developerId"] === cmd.developerId);

    const decision = this.policy.developer.canCreateChannel(developer, devChannels.length);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    const channelId = `ch_${Date.now().toString(36)}`;

    await this.db.events.store(
      "core", "channel:created" as never,
      { developerId: cmd.developerId, channelId, channelName: cmd.channelName },
      `ch-create:${cmd.developerId}:${channelId}`
    );

    this.publisher.channelCreated({
      developerId: cmd.developerId,
      channelId,
      channelName: cmd.channelName,
      createdAt:   new Date(),
    });

    this.logger?.info(`Kanal oluşturuldu: ${channelId} (@${developer.username})`);
    return succeed(channelId);
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Developer | null> {
    return this.db.developers.findById(id);
  }

  async getByUsername(username: string): Promise<Developer | null> {
    return this.db.developers.findByUsername(username);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SearchApplicationService
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SearchEngine'i API katmanından ve diğer servislerden ayırır.
 * Tüm arama iş akışları bu servis üzerinden geçer.
 *
 * Bu servis:
 *   ✓ SearchEngine'i çağırır (read-only)
 *   ✓ Visibility politikasını uygular (arşivlenenler filtrelenir)
 *   ✓ Query sonuçlarını domain modellerine dönüştürür
 *   ✗ Asla veri yazmaz
 */
export class SearchApplicationService {
  private readonly policy = new PolicyEngine();

  constructor(
    searchEngine: SearchEngine,
    db:           UnitOfWork,
    logger?:      ILogger
  ) {
    this.logger = logger;
    this.db = db;
    this.searchEngine = searchEngine;}

  async searchProjects(query: SearchProjectsQuery): Promise<QueryOutcome<ReturnType<typeof toProjectSummary>[]>> {
    const start = Date.now();

    try {
      const response = await this.searchEngine.search({
        term:    query.term,
        filter:  query.filter ? {
          license:     query.filter.license,
          tags:        query.filter.tags,
          developerId: query.filter.developerId,
          status:      query.filter.status,
          coord:       query.filter.cube,
        } : undefined,
        options: {
          limit:   query.limit   ?? 20,
          offset:  query.offset  ?? 0,
          explain: query.explain ?? false,
        },
      });

      // Proje verilerini repository'den çek ve görünürlük filtresi uygula
      const projects: ReturnType<typeof toProjectSummary>[] = [];
      for (const hit of response.hits) {
        const project = await this.db.projects.findById(hit.projectId);
        if (!project) continue;
        if (!this.policy.visibility.isSearchable(project)) continue;
        projects.push(toProjectSummary(project));
      }

      this.logger?.debug(
        `Arama: "${query.term}" → ${projects.length} sonuç (${Date.now() - start}ms)`
      );

      return queryOk(projects, {
        total:       response.total,
        limit:       response.limit,
        offset:      response.offset,
        executionMs: response.executionMs,
      });

    } catch (err) {
      this.logger?.error("Arama hatası", err instanceof Error ? err : undefined);
      return queryErr(ErrorCode.ENGINE_FAILURE, "Arama gerçekleştirilemedi");
    }
  }

  async getProject(query: GetProjectQuery): Promise<QueryOutcome<ReturnType<typeof toProjectSummary>>> {
    const project = await this.db.projects.findById(query.projectId);
    if (!project) return queryErr(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${query.projectId}`);
    if (!this.policy.visibility.isSearchable(project)) {
      return queryErr("NOT_VISIBLE", "Bu proje görüntülenemiyor");
    }
    return queryOk(toProjectSummary(project));
  }

  async listDeveloperProjects(
    query: ListDeveloperProjectsQuery
  ): Promise<QueryOutcome<ReturnType<typeof toProjectSummary>[]>> {
    const projects = await this.db.projects.findByDeveloper(query.developerId);
    const filtered = projects.filter((p) =>
      !query.status || p.status === query.status
    );
    const page = filtered.slice(
      query.offset ?? 0,
      (query.offset ?? 0) + (query.limit ?? 20)
    );
    return queryOk(page.map(toProjectSummary), {
      total:  filtered.length,
      limit:  query.limit  ?? 20,
      offset: query.offset ?? 0,
    });
  }
}
