/**
 * 1XX1 Domain Validators
 * Aşama 08 — Domain & Application Services
 *
 * Bu katman API DTO doğrulaması DEĞİLDİR.
 * İş kurallarını doğrular:
 *
 *   ✓ Aynı isimde proje var mı?
 *   ✓ Lisans çakışması var mı?
 *   ✓ CubePath geçerli ve erişilebilir mi?
 *   ✓ Yasaklı etiket var mı?
 *   ✓ Eksik zorunlu metadata var mı?
 *   ✓ Repo URL geçerli mi?
 *   ✓ Donation address formatı doğru mu?
 *   ✓ Geliştirici username çakışıyor mu?
 *   ✓ Rate: geliştirici günlük proje sınırını aştı mı?
 *
 * Validator sonuçları toplanır (birden fazla hata aynı anda döner).
 */

import type { CreateProjectCommand, UpdateProjectCommand, RegisterDeveloperCommand } from "../commands/commands.ts";
import type { IProjectRepository, IDeveloperRepository } from "../core/interfaces.ts";
import type { CubeCoordinate } from "../core/types.ts";
import { isValidCoord } from "../core/utils.ts";
import { isValidCubePath } from "../cube_engine/cube-path.ts";

// ─── Doğrulama Sonucu ────────────────────────────────────────────────────────

export interface ValidationViolation {
  field:   string;
  code:    string;
  message: string;
}

export interface ValidationSuccess {
  ok:         true;
  violations: [];
}

export interface ValidationFailure {
  ok:         false;
  violations: ValidationViolation[];
}

export type ValidationOutcome = ValidationSuccess | ValidationFailure;

function ok(): ValidationSuccess {
  return { ok: true, violations: [] };
}

function fail(violations: ValidationViolation[]): ValidationFailure {
  return { ok: false, violations };
}

// ─── Yasaklı Etiketler ────────────────────────────────────────────────────────

const BANNED_TAGS = new Set([
  "spam", "test123", "xxx", "adult", "nsfw",
  "virus", "malware", "hack", "crack", "keygen",
]);

const BANNED_WORDS_IN_NAME = new Set([
  "scam", "phishing", "malware", "virus",
]);

// ─── URL Doğrulama ────────────────────────────────────────────────────────────

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidRepoUrl(url: string): boolean {
  if (!isValidUrl(url)) return false;
  // Bilinen kod hosting platformları veya kendi sunucu
  const KNOWN_HOSTS = [
    "github.com", "gitlab.com", "codeberg.org",
    "sr.ht", "gitea.io", "bitbucket.org",
  ];
  try {
    const u    = new URL(url);
    const host = u.hostname.toLowerCase();
    return KNOWN_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

// ─── Crypto Adres Doğrulama ───────────────────────────────────────────────────

/**
 * Basit format kontrolü (gerçek blockchain doğrulaması Aşama 11'de).
 * BTC: 1... veya 3... veya bc1...
 * ETH: 0x...
 */
function isValidDonationAddress(addr: string): boolean {
  if (!addr || addr.length < 10 || addr.length > 100) return false;
  return (
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr) || // BTC legacy
    /^bc1[ac-hj-np-z02-9]{6,87}$/.test(addr)         || // BTC segwit
    /^0x[0-9a-fA-F]{40}$/.test(addr)                  || // ETH
    /^[a-z2-7]{58}$/.test(addr)                            // generic base32 (XTZ vb.)
  );
}

// ─── ProjectValidator ─────────────────────────────────────────────────────────

export class ProjectValidator {

  constructor(
    projectRepo: IProjectRepository,
    developerRepo?: IDeveloperRepository
  ) {
    this.developerRepo = developerRepo;
    this.projectRepo = projectRepo;}

  /**
   * CreateProjectCommand için tam iş doğrulaması.
   * Tüm ihlaller toplanır, ilk hatada durulmaz.
   */
  async validateCreate(cmd: CreateProjectCommand): Promise<ValidationOutcome> {
    const violations: ValidationViolation[] = [];

    // ── İsim ──
    this._validateName(cmd.name, violations);

    // ── Açıklama ──
    if (!cmd.description || cmd.description.trim().length < 10) {
      violations.push({
        field:   "description",
        code:    "DESCRIPTION_TOO_SHORT",
        message: "Açıklama en az 10 karakter olmalı",
      });
    }

    // ── Repo URL ──
    this._validateRepo(cmd.repo, violations);

    // ── Etiketler ──
    this._validateTags(cmd.tags, violations);

    // ── Küp koordinatı ──
    this._validateCube(cmd.cube, violations);

    // ── Donation address ──
    if (cmd.donationAddress) {
      this._validateDonation(cmd.donationAddress, violations);
    }

    // ── Geliştirici varlığı ──
    if (this.developerRepo) {
      const dev = await this.developerRepo.findById(cmd.developerId);
      if (!dev) {
        violations.push({
          field:   "developerId",
          code:    "DEVELOPER_NOT_FOUND",
          message: `Geliştirici bulunamadı: ${cmd.developerId}`,
        });
      }
    }

    // ── İsim çakışması ──
    await this._checkNameConflict(cmd.name, cmd.developerId, undefined, violations);

    // ── Günlük rate limit ──
    await this._checkDailyProjectLimit(cmd.developerId, violations);

    return violations.length === 0 ? ok() : fail(violations);
  }

  /** UpdateProjectCommand doğrulaması */
  async validateUpdate(cmd: UpdateProjectCommand): Promise<ValidationOutcome> {
    const violations: ValidationViolation[] = [];

    // Proje varlığı + sahiplik
    const project = await this.projectRepo.findById(cmd.projectId);
    if (!project) {
      return fail([{
        field: "projectId",
        code:  "PROJECT_NOT_FOUND",
        message: `Proje bulunamadı: ${cmd.projectId}`,
      }]);
    }

    if (project.developer !== cmd.requesterId) {
      return fail([{
        field: "requesterId",
        code:  "UNAUTHORIZED",
        message: "Yalnızca proje sahibi güncelleyebilir",
      }]);
    }

    if (project.status === "archived") {
      return fail([{
        field: "projectId",
        code:  "PROJECT_ARCHIVED",
        message: "Arşivlenmiş proje güncellenemez",
      }]);
    }

    if (cmd.name)  this._validateName(cmd.name, violations);
    if (cmd.repo)  this._validateRepo(cmd.repo, violations);
    if (cmd.tags)  this._validateTags(cmd.tags, violations);
    if (cmd.donationAddress) this._validateDonation(cmd.donationAddress, violations);

    if (cmd.name && cmd.name !== project.name) {
      await this._checkNameConflict(cmd.name, project.developer, cmd.projectId, violations);
    }

    return violations.length === 0 ? ok() : fail(violations);
  }

  // ─── Özel Doğrulayıcılar ─────────────────────────────────────────────────

  private _validateName(name: string, v: ValidationViolation[]): void {
    if (!name || name.trim().length < 3) {
      v.push({ field: "name", code: "NAME_TOO_SHORT", message: "İsim en az 3 karakter olmalı" });
      return;
    }
    if (name.length > 120) {
      v.push({ field: "name", code: "NAME_TOO_LONG", message: "İsim en fazla 120 karakter olabilir" });
    }
    const lower = name.toLowerCase();
    for (const word of BANNED_WORDS_IN_NAME) {
      if (lower.includes(word)) {
        v.push({ field: "name", code: "NAME_BANNED_WORD", message: `İsimde yasaklı ifade: "${word}"` });
      }
    }
  }

  private _validateRepo(repo: string, v: ValidationViolation[]): void {
    if (!repo || !isValidRepoUrl(repo)) {
      v.push({
        field:   "repo",
        code:    "INVALID_REPO_URL",
        message: "Repo URL'si geçerli bir kod hosting adresi olmalı (GitHub, GitLab, Codeberg vb.)",
      });
    }
  }

  private _validateTags(tags: string[], v: ValidationViolation[]): void {
    if (tags.length > 15) {
      v.push({ field: "tags", code: "TOO_MANY_TAGS", message: "En fazla 15 etiket eklenebilir" });
    }
    for (const tag of tags) {
      if (tag.length > 32) {
        v.push({ field: "tags", code: "TAG_TOO_LONG", message: `Etiket çok uzun: "${tag}"` });
      }
      if (BANNED_TAGS.has(tag.toLowerCase())) {
        v.push({ field: "tags", code: "TAG_BANNED", message: `Yasaklı etiket: "${tag}"` });
      }
      if (!/^[a-zA-Z0-9\-_.+]+$/.test(tag)) {
        v.push({ field: "tags", code: "TAG_INVALID_CHARS", message: `Etiket geçersiz karakter içeriyor: "${tag}"` });
      }
    }
  }

  private _validateCube(cube: CubeCoordinate, v: ValidationViolation[]): void {
    if (!isValidCoord(cube)) {
      v.push({
        field:   "cube",
        code:    "INVALID_CUBE_COORDINATE",
        message: `Küp koordinatı geçersiz: (${cube.x},${cube.y},${cube.z}) — her eksen 0–10 arası olmalı`,
      });
    }
  }

  private _validateDonation(addr: string, v: ValidationViolation[]): void {
    if (!isValidDonationAddress(addr)) {
      v.push({
        field:   "donationAddress",
        code:    "INVALID_DONATION_ADDRESS",
        message: "Bağış adresi geçerli bir kripto cüzdan adresi olmalı",
      });
    }
  }

  private async _checkNameConflict(
    name:        string,
    developerId: string,
    excludeId:   string | undefined,
    v:           ValidationViolation[]
  ): Promise<void> {
    const existing = await this.projectRepo.findByDeveloper(developerId);
    const conflict = existing.find(
      (p) => p.name.toLowerCase() === name.toLowerCase() &&
             p.status !== "archived" &&
             p.id !== excludeId
    );
    if (conflict) {
      v.push({
        field:   "name",
        code:    "DUPLICATE_PROJECT_NAME",
        message: `Bu geliştiricide "${name}" isimli aktif proje zaten var`,
      });
    }
  }

  private async _checkDailyProjectLimit(developerId: string, v: ValidationViolation[]): Promise<void> {
    const DAILY_LIMIT = 10;
    const projects    = await this.projectRepo.findByDeveloper(developerId);
    const today       = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount  = projects.filter((p) => p.createdAt >= today).length;
    if (todayCount >= DAILY_LIMIT) {
      v.push({
        field:   "developerId",
        code:    "DAILY_LIMIT_EXCEEDED",
        message: `Günlük proje sınırına ulaşıldı (${DAILY_LIMIT}). Yarın tekrar deneyin.`,
      });
    }
  }
}

// ─── DeveloperValidator ───────────────────────────────────────────────────────

const RESERVED_USERNAMES = new Set([
  "admin", "system", "root", "api", "1xx1", "kaptan",
  "support", "help", "info", "security", "moderator",
]);

const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/;

export class DeveloperValidator {

  constructor(developerRepo: IDeveloperRepository) {
    this.developerRepo = developerRepo;}

  async validateRegister(cmd: RegisterDeveloperCommand): Promise<ValidationOutcome> {
    const violations: ValidationViolation[] = [];

    // ── Username ──
    if (!USERNAME_PATTERN.test(cmd.username)) {
      violations.push({
        field:   "username",
        code:    "INVALID_USERNAME",
        message: "Username 3–30 karakter, harf ile başlamalı, harf/rakam/tire/alt çizgi içerebilir",
      });
    } else if (RESERVED_USERNAMES.has(cmd.username.toLowerCase())) {
      violations.push({
        field:   "username",
        code:    "RESERVED_USERNAME",
        message: `"${cmd.username}" kullanılamaz (rezerve edilmiş)`,
      });
    } else {
      const existing = await this.developerRepo.findByUsername(cmd.username);
      if (existing) {
        violations.push({
          field:   "username",
          code:    "USERNAME_TAKEN",
          message: `"${cmd.username}" zaten kullanılıyor`,
        });
      }
    }

    // ── Display name ──
    if (!cmd.displayName || cmd.displayName.trim().length < 2) {
      violations.push({
        field:   "displayName",
        code:    "DISPLAY_NAME_TOO_SHORT",
        message: "Görünen ad en az 2 karakter olmalı",
      });
    }
    if (cmd.displayName && cmd.displayName.length > 64) {
      violations.push({
        field:   "displayName",
        code:    "DISPLAY_NAME_TOO_LONG",
        message: "Görünen ad en fazla 64 karakter olabilir",
      });
    }

    // ── Website ──
    if (cmd.website && !isValidUrl(cmd.website)) {
      violations.push({
        field:   "website",
        code:    "INVALID_WEBSITE_URL",
        message: "Website geçerli bir URL olmalı (http:// veya https://)",
      });
    }

    // ── Donation address ──
    if (cmd.donationAddress && !isValidDonationAddress(cmd.donationAddress)) {
      violations.push({
        field:   "donationAddress",
        code:    "INVALID_DONATION_ADDRESS",
        message: "Bağış adresi geçerli bir kripto cüzdan adresi olmalı",
      });
    }

    return violations.length === 0 ? ok() : fail(violations);
  }
}
