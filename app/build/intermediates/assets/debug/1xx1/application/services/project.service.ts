/**
 * 1XX1 ProjectService
 * Aşama 08 — Domain & Application Services
 *
 * Projenin tüm yaşam döngüsünü yönetir.
 * Tek sorumluluk: koordinasyon.
 *   - Repository (kalıcı depolama)
 *   - CubeEngine (koordinat indeksleme)
 *   - IndexManager (arama indeksi)
 *   - EventStore (audit trail)
 *   - DomainEventPublisher (olay yayını)
 *   - Policy (yetki kontrolü)
 *   - Validator (iş doğrulaması)
 *   - Transaction (atomiklik)
 *
 * Bu servis SQL bilmez, küp algoritması bilmez, arama skoru bilmez.
 * Sadece orkestre eder.
 */

import type { IProjectRepository } from "../../core/interfaces.ts";
import type { Project } from "../../core/types.ts";
import type { UnitOfWork } from "../../database/index.ts";
import type { FractalCubeEngine } from "../../cube_engine/fractal-cube-engine.ts";
import type { IndexManager } from "../../search/index-manager.ts";
import type { ILogger } from "../../core/interfaces.ts";
import {
  CreateProjectCommand,
  UpdateProjectCommand,
  ArchiveProjectCommand,
  MoveProjectCommand,
  VerifyProjectCommand,
  RejectProjectCommand,
  CommandOutcome,
  succeed,
  fail,
} from "../commands/commands.ts";
import { ProjectValidator } from "../validators/domain-validators.ts";
import { PolicyEngine } from "../policies/policies.ts";
import { DomainEventPublisher } from "../events/domain-events.ts";
import { rootPath } from "../../cube_engine/cube-path.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";
import type { ProjectID } from "../../core/identity.ts";

// ─── ProjectService ───────────────────────────────────────────────────────────

export class ProjectService {
  private readonly validator: ProjectValidator;
  private readonly policy:    PolicyEngine;

  constructor(
    db:        UnitOfWork,
    cube:      FractalCubeEngine,
    index:     IndexManager,
    publisher: DomainEventPublisher,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.publisher = publisher;
    this.index = index;
    this.cube = cube;
    this.db = db;
    this.validator = new ProjectValidator(db.projects, db.developers);
    this.policy    = new PolicyEngine();
  }

  // ─── Oluşturma ────────────────────────────────────────────────────────────

  async create(cmd: CreateProjectCommand): Promise<CommandOutcome<Project>> {
    // 1. Doğrulama
    const validation = await this.validator.validateCreate(cmd);
    if (!validation.ok) {
      const v = validation.violations[0];
      return fail(v.code, v.message, v.field);
    }

    try {
      // 2. Atomik transaction: Repository + CubeEngine + IndexManager + EventStore
      const project = await this.db.tx.run(async (tx) => {
        // 2a. Kalıcı depolama
        const created = await this.db.projects.create({
          name:            cmd.name,
          description:     cmd.description,
          cube:            cmd.cube,
          developer:       cmd.developerId,
          repo:            cmd.repo,
          tags:            cmd.tags,
          license:         cmd.license,
          status:          "active",
          donationAddress: cmd.donationAddress,
        }, tx);

        // 2b. Event Store'a yaz
        await this.db.events.store(
          "core", "project:created",
          { projectId: created.id, cube: created.cube },
          `proj-create:${created.id}`,
          tx
        );

        return created;
      });

      // 3. CubeEngine'e indeksle (transaction dışı — eventually consistent)
      try {
        await this.cube.index(project);
      } catch (err) {
        this.logger?.warn(
          `CubeEngine index başarısız: ${project.id}`,
          { detail: err instanceof Error ? err.message : String(err) }
        );
        // Kritik değil — reconciliation düzeltecek
      }

      // 4. Arama indeksini güncelle
      this.index.indexProject(project);

      // 5. Domain event yayınla
      this.publisher.projectPublished({
        projectId:   project.id,
        name:        project.name,
        developerId: project.developer,
        cube:        project.cube,
        cubePath:    rootPath(project.cube),
        tags:        project.tags,
        license:     project.license,
        repo:        project.repo,
        publishedAt: new Date(),
      });

      this.logger?.info(`Proje oluşturuldu: ${project.id} → (${project.cube.x},${project.cube.y},${project.cube.z})`);
      return succeed(project);

    } catch (err) {
      this.logger?.error("Proje oluşturma hatası", err instanceof Error ? err : undefined);
      return fail(ErrorCode.INTERNAL_ERROR, "Proje oluşturulamadı");
    }
  }

  // ─── Güncelleme ───────────────────────────────────────────────────────────

  async update(cmd: UpdateProjectCommand): Promise<CommandOutcome<Project>> {
    const existing = await this.db.projects.findById(cmd.projectId);
    if (!existing) return fail(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${cmd.projectId}`);

    // Policy
    const decision = this.policy.project.canUpdate(existing, cmd.requesterId);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    // Validation
    const validation = await this.validator.validateUpdate(cmd);
    if (!validation.ok) {
      const v = validation.violations[0];
      return fail(v.code, v.message, v.field);
    }

    try {
      const updated = await this.db.tx.run(async (tx) => {
        const u = await this.db.projects.update(cmd.projectId, {
          name:            cmd.name,
          description:     cmd.description,
          repo:            cmd.repo,
          tags:            cmd.tags,
          license:         cmd.license,
          donationAddress: cmd.donationAddress,
        }, tx);
        if (!u) throw new SystemError({ code: ErrorCode.INTERNAL_ERROR, message: "Güncelleme başarısız" });

        await this.db.events.store(
          "core", "project:updated",
          { projectId: u.id, changes: Object.keys(cmd).filter((k) => k !== "projectId" && k !== "requesterId") },
          `proj-update:${u.id}:${Date.now()}`,
          tx
        );
        return u;
      });

      // Arama indeksini güncelle
      this.index.indexProject(updated);

      this.logger?.info(`Proje güncellendi: ${updated.id}`);
      return succeed(updated);

    } catch (err) {
      this.logger?.error("Proje güncelleme hatası", err instanceof Error ? err : undefined);
      return fail(ErrorCode.INTERNAL_ERROR, "Proje güncellenemedi");
    }
  }

  // ─── Arşivleme ────────────────────────────────────────────────────────────

  async archive(cmd: ArchiveProjectCommand): Promise<CommandOutcome<void>> {
    const existing = await this.db.projects.findById(cmd.projectId);
    if (!existing) return fail(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${cmd.projectId}`);

    const decision = this.policy.project.canArchive(existing, cmd.requesterId);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    try {
      await this.db.tx.run(async (tx) => {
        await this.db.projects.archive(cmd.projectId, tx);
        await this.db.events.store(
          "core", "project:archived",
          { projectId: cmd.projectId, reason: cmd.reason },
          `proj-arc:${cmd.projectId}`,
          tx
        );
      });

      // Arama indeksinden kaldır
      this.index.removeProject(cmd.projectId as ProjectID);
      // Cube indeksinden kaldır
      try { await this.cube.remove(cmd.projectId as ProjectID); } catch { /* ok */ }

      // Domain event
      this.publisher.projectArchived({
        projectId:   cmd.projectId,
        developerId: existing.developer,
        archivedAt:  new Date(),
        reason:      cmd.reason,
      });

      this.logger?.info(`Proje arşivlendi: ${cmd.projectId}`);
      return succeed(undefined);

    } catch (err) {
      this.logger?.error("Proje arşivleme hatası", err instanceof Error ? err : undefined);
      return fail(ErrorCode.INTERNAL_ERROR, "Proje arşivlenemedi");
    }
  }

  // ─── Taşıma ───────────────────────────────────────────────────────────────

  async move(cmd: MoveProjectCommand): Promise<CommandOutcome<void>> {
    const existing = await this.db.projects.findById(cmd.projectId);
    if (!existing) return fail(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${cmd.projectId}`);

    const decision = this.policy.project.canMove(existing, cmd.requesterId);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    // Koordinat doğrulama
    if (!this.cube.validate(cmd.newCube)) {
      return fail("INVALID_CUBE_COORDINATE", `Geçersiz koordinat: (${cmd.newCube.x},${cmd.newCube.y},${cmd.newCube.z})`);
    }

    try {
      // Yeni koordinat ile güncelle
      await this.db.tx.run(async (tx) => {
        await this.db.projects.update(cmd.projectId, { cube: cmd.newCube }, tx);
        await this.db.events.store(
          "cube", "cube:indexed",
          { projectId: cmd.projectId, fromCube: existing.cube, toCube: cmd.newCube },
          `proj-move:${cmd.projectId}:${Date.now()}`,
          tx
        );
      });

      // CubeEngine taşı
      const newPath = cmd.newPath ?? rootPath(cmd.newCube);
      try { await this.cube.move(cmd.projectId as ProjectID, newPath); } catch { /* ok */ }

      // IndexManager güncelle (koordinat değişti)
      const updated = await this.db.projects.findById(cmd.projectId);
      if (updated) this.index.indexProject(updated);

      this.logger?.info(`Proje taşındı: ${cmd.projectId} → (${cmd.newCube.x},${cmd.newCube.y},${cmd.newCube.z})`);
      return succeed(undefined);

    } catch (err) {
      this.logger?.error("Proje taşıma hatası", err instanceof Error ? err : undefined);
      return fail(ErrorCode.INTERNAL_ERROR, "Proje taşınamadı");
    }
  }

  // ─── Doğrulama / Reddetme ─────────────────────────────────────────────────

  async verify(cmd: VerifyProjectCommand): Promise<CommandOutcome<void>> {
    const existing = await this.db.projects.findById(cmd.projectId);
    if (!existing) return fail(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${cmd.projectId}`);

    const decision = this.policy.project.canVerify(existing);
    if (!decision.allowed) return fail(decision.code, decision.reason);

    await this.db.tx.run(async (tx) => {
      await this.db.projects.update(cmd.projectId, { status: "verified" }, tx);
      await this.db.events.store("core", "project:verified" as never, { projectId: cmd.projectId }, undefined, tx);
    });

    const updated = await this.db.projects.findById(cmd.projectId);
    if (updated) this.index.indexProject(updated);

    this.publisher.projectVerified({
      projectId:  cmd.projectId,
      verifiedAt: new Date(),
      verifiedBy: cmd.verifiedBy,
    });

    return succeed(undefined);
  }

  async reject(cmd: RejectProjectCommand): Promise<CommandOutcome<void>> {
    const existing = await this.db.projects.findById(cmd.projectId);
    if (!existing) return fail(ErrorCode.PROJECT_NOT_FOUND, `Proje bulunamadı: ${cmd.projectId}`);

    await this.db.tx.run(async (tx) => {
      await this.db.projects.update(cmd.projectId, { status: "pending" }, tx);
      await this.db.events.store(
        "core", "project:rejected" as never,
        { projectId: cmd.projectId, reason: cmd.reason },
        `proj-rej:${cmd.projectId}:${Date.now()}`,
        tx
      );
    });

    const updated = await this.db.projects.findById(cmd.projectId);
    if (updated) this.index.indexProject(updated);

    this.publisher.projectRejected({
      projectId:   cmd.projectId,
      reason:      cmd.reason,
      rejectedAt:  new Date(),
      rejectedBy:  cmd.rejectedBy,
    });

    return succeed(undefined);
  }

  // ─── Sorgular (read-only proxy) ───────────────────────────────────────────

  async getById(id: string, viewerId?: string): Promise<Project | null> {
    const project = await this.db.projects.findById(id);
    if (!project) return null;
    const decision = this.policy.project.canView(project, viewerId);
    return decision.allowed ? project : null;
  }
}
