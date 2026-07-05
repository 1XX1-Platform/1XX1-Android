/**
 * 1XX1 Kanal Servisleri
 * Aşama 09 — Kanal Sistemi 2.0
 *
 *   ChannelService   — kanal yaşam döngüsü + cüzdan yönetimi
 *   ReleaseService   — sürüm yönetimi
 *   FollowService    — takip sistemi
 *   WalletManager    — cüzdan ekleme/kaldırma (ChannelService içinde)
 *
 * Tüm servisler:
 *   ✓ Policy kontrolü
 *   ✓ Domain event yayını
 *   ✓ CommandOutcome döndürür
 *   ✗ Asla ham SQL bilmez
 */

import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import type {
  Channel, Release, ChannelFollow, Wallet,
  CryptoNetwork, ReleaseArtifact, SemanticVersion,
  ChannelVisibility, SocialLink,
} from "../entities/channel.entity.ts";
import type {
  IChannelRepository, IReleaseRepository,
  IFollowRepository, ITrustScoreRepository,
} from "../repositories/channel.repository.ts";
import type { IProjectRepository } from "../../core/interfaces.ts";
import { TrustScoreEngine } from "../trust/trust-score.ts";
import { succeed, fail } from "../../application/commands/commands.ts";
import type { CommandOutcome } from "../../application/commands/commands.ts";
import { generateId } from "../../core/utils.ts";
import { ChannelErrorCode } from "../../core/errors.ts";
import { ErrorCode } from "../../core/errors.ts";

// ─── Slug Üretici ─────────────────────────────────────────────────────────────

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

// ─── Semver Utility ───────────────────────────────────────────────────────────

function parseVersion(v: string): SemanticVersion | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    major:      parseInt(m[1], 10),
    minor:      parseInt(m[2], 10),
    patch:      parseInt(m[3], 10),
    prerelease: m[4],
  };
}

function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // prerelease < kararlı
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return 0;
}

// ─── Cüzdan Doğrulama ─────────────────────────────────────────────────────────

const WALLET_PATTERNS: Record<CryptoNetwork, RegExp> = {
  bitcoin:  /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{6,87}$/,
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  monero:   /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
  litecoin: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
  custom:   /^.{10,100}$/,
};

function isValidWalletAddress(network: CryptoNetwork, address: string): boolean {
  return WALLET_PATTERNS[network]?.test(address) ?? false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ChannelService
// ═══════════════════════════════════════════════════════════════════════════════

export class ChannelService {
  private readonly trust = new TrustScoreEngine();

  constructor(
    channels:   IChannelRepository,
    trustRepo:  ITrustScoreRepository,
    projects:   IProjectRepository,
    eventBus?:  IEventBus,
    logger?:    ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.projects = projects;
    this.trustRepo = trustRepo;
    this.channels = channels;}

  // ─── Kanal Oluşturma ─────────────────────────────────────────────────────

  async create(data: {
    ownerId:     string;
    title:       string;
    description: string;
    visibility?: ChannelVisibility;
    mask?:       string;
    tags?:       string[];
    socialLinks?: SocialLink[];
  }): Promise<CommandOutcome<Channel>> {
    // Başlıktan otomatik slug üret
    const baseSlug = toSlug(data.title);
    let   slug     = baseSlug;

    // Çakışma varsa sayaç ekle
    let attempt = 0;
    while (await this.channels.findBySlug(slug)) {
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }

    // Sahibin zaten kanalı var mı?
    const existing = await this.channels.findByOwner(data.ownerId);
    const MAX_CHANNELS = 3;
    if (existing.length >= MAX_CHANNELS) {
      return fail("MAX_CHANNELS_REACHED", `Maksimum ${MAX_CHANNELS} kanal oluşturulabilir`);
    }

    try {
      const channel = await this.channels.create({
        ownerId:     data.ownerId,
        slug,
        title:       data.title,
        description: data.description,
        visibility:  data.visibility ?? "public",
        wallets:     [],
        verified:    false,
        tags:        data.tags ?? [],
        socialLinks: data.socialLinks ?? [],
        mask:        data.mask,
      });

      this.eventBus?.emit("channel:created" as never, {
        channelId: channel.id,
        ownerId:   channel.ownerId,
        slug:      channel.slug,
      });

      this.logger?.info(`Kanal oluşturuldu: ${channel.id} (${channel.slug})`);
      return succeed(channel);
    } catch (err) {
      return fail(ErrorCode.INTERNAL_ERROR, "Kanal oluşturulamadı");
    }
  }

  // ─── Kanal Güncelleme ────────────────────────────────────────────────────

  async update(
    channelId:   string,
    requesterId: string,
    patch: {
      title?:       string;
      description?: string;
      visibility?:  ChannelVisibility;
      mask?:        string;
      tags?:        string[];
      socialLinks?: SocialLink[];
    }
  ): Promise<CommandOutcome<Channel>> {
    const channel = await this.channels.findById(channelId);
    if (!channel) return fail(ChannelErrorCode.CHANNEL_NOT_FOUND, "Kanal bulunamadı");
    if (channel.ownerId !== requesterId) return fail(ErrorCode.UNAUTHORIZED, "Yalnızca kanal sahibi güncelleyebilir");

    const updateData: Partial<Channel> = { ...patch };
    if (patch.title) updateData.slug = toSlug(patch.title);

    const updated = await this.channels.update(channelId, updateData);
    if (!updated) return fail(ErrorCode.INTERNAL_ERROR, "Güncelleme başarısız");

    this.eventBus?.emit("channel:updated" as never, { channelId, changes: Object.keys(patch) });
    return succeed(updated);
  }

  // ─── Cüzdan Yönetimi ─────────────────────────────────────────────────────

  async addWallet(
    channelId:   string,
    requesterId: string,
    network:     CryptoNetwork,
    address:     string,
    label?:      string
  ): Promise<CommandOutcome<Wallet>> {
    const channel = await this.channels.findById(channelId);
    if (!channel) return fail(ChannelErrorCode.CHANNEL_NOT_FOUND, "Kanal bulunamadı");
    if (channel.ownerId !== requesterId) return fail(ErrorCode.UNAUTHORIZED, "Yetkisiz");

    const MAX_WALLETS = 8;
    if (channel.wallets.length >= MAX_WALLETS) {
      return fail(ChannelErrorCode.WALLET_LIMIT_EXCEEDED, `Maksimum ${MAX_WALLETS} cüzdan eklenebilir`);
    }

    if (channel.wallets.some((w) => w.address === address)) {
      return fail(ChannelErrorCode.WALLET_DUPLICATE, "Bu adres zaten ekli");
    }

    if (!isValidWalletAddress(network, address)) {
      return fail("INVALID_WALLET_ADDRESS", `${network} için geçersiz adres`);
    }

    const wallet: Wallet = {
      id:      `wlt_${generateId()}`,
      network,
      address,
      label,
      addedAt: new Date(),
    };

    const updated = await this.channels.update(channelId, {
      wallets: [...channel.wallets, wallet],
    });

    if (!updated) return fail(ErrorCode.INTERNAL_ERROR, "Cüzdan eklenemedi");

    this.eventBus?.emit("wallet:added" as never, { channelId, walletId: wallet.id, network });
    this.logger?.info(`Cüzdan eklendi: ${channelId} — ${network}`);
    return succeed(wallet);
  }

  async removeWallet(
    channelId:   string,
    requesterId: string,
    walletId:    string
  ): Promise<CommandOutcome<void>> {
    const channel = await this.channels.findById(channelId);
    if (!channel) return fail(ChannelErrorCode.CHANNEL_NOT_FOUND, "Kanal bulunamadı");
    if (channel.ownerId !== requesterId) return fail(ErrorCode.UNAUTHORIZED, "Yetkisiz");

    const newWallets = channel.wallets.filter((w) => w.id !== walletId);
    if (newWallets.length === channel.wallets.length) {
      return fail("WALLET_NOT_FOUND", "Cüzdan bulunamadı");
    }

    await this.channels.update(channelId, { wallets: newWallets });
    this.eventBus?.emit("wallet:removed" as never, { channelId, walletId });
    return succeed(undefined);
  }

  // ─── Trust Score ─────────────────────────────────────────────────────────

  async refreshTrustScore(channelId: string): Promise<void> {
    const channel = await this.channels.findById(channelId);
    if (!channel) return;

    const allProjects = await this.projects.findByDeveloper(channel.ownerId);
    const old         = await this.trustRepo.findByChannel(channelId);
    const score       = this.trust.calculate(channelId, allProjects, [], old ?? undefined);

    await this.trustRepo.save(score);
    this.logger?.debug(`Trust Score güncellendi: ${channelId} → ${score.metrics.totalScore}`);
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  async getBySlug(slug: string): Promise<Channel | null> {
    return this.channels.findBySlug(slug);
  }

  async getById(id: string): Promise<Channel | null> {
    return this.channels.findById(id);
  }

  async listPublic(limit?: number, offset?: number): Promise<Channel[]> {
    return this.channels.listPublic(limit, offset);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ReleaseService
// ═══════════════════════════════════════════════════════════════════════════════

export class ReleaseService {

  constructor(
    releases:  IReleaseRepository,
    channels:  IChannelRepository,
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.channels = channels;
    this.releases = releases;}

  async publish(data: {
    projectId:    string;
    channelId:    string;
    requesterId:  string;
    versionStr:   string;
    title:        string;
    notes:        string;
    artifacts?:   Omit<ReleaseArtifact, "id" | "uploadedAt">[];
    tags?:        string[];
    isPrerelease?: boolean;
  }): Promise<CommandOutcome<Release>> {
    // Kanal sahiplik kontrolü
    const channel = await this.channels.findById(data.channelId);
    if (!channel) return fail(ChannelErrorCode.CHANNEL_NOT_FOUND, "Kanal bulunamadı");
    if (channel.ownerId !== data.requesterId) return fail(ErrorCode.UNAUTHORIZED, "Yetkisiz");

    // Semver doğrulama
    const version = parseVersion(data.versionStr);
    if (!version) {
      return fail("INVALID_VERSION", `Geçersiz sürüm formatı: "${data.versionStr}" (major.minor.patch bekleniyor)`);
    }

    const artifacts: ReleaseArtifact[] = (data.artifacts ?? []).map((a) => ({
      ...a,
      id:         `art_${generateId()}`,
      uploadedAt: new Date(),
    }));

    try {
      const release = await this.releases.create({
        projectId:    data.projectId,
        channelId:    data.channelId,
        version,
        versionStr:   data.versionStr,
        title:        data.title,
        notes:        data.notes,
        status:       "published",
        artifacts,
        tags:         data.tags ?? [],
        isLatest:     true,
        isPrerelease: data.isPrerelease ?? !!version.prerelease,
        publishedAt:  new Date(),
      });

      // Bu sürümü en son olarak işaretle
      await this.releases.setLatest(release.id, data.projectId);

      // Kanal istatistiklerini güncelle
      await this.channels.incrementStat(data.channelId, "releaseCount");
      await this.channels.incrementStat(data.channelId, "lastActivity");

      this.eventBus?.emit("release:published" as never, {
        releaseId:   release.id,
        projectId:   data.projectId,
        channelId:   data.channelId,
        versionStr:  data.versionStr,
        isPrerelease: release.isPrerelease,
      });

      this.logger?.info(`Sürüm yayınlandı: ${release.id} (${data.versionStr})`);
      return succeed(release);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sürüm yayınlanamadı";
      return fail("RELEASE_FAILED", msg);
    }
  }

  async deprecate(
    releaseId:   string,
    requesterId: string,
    channelId:   string
  ): Promise<CommandOutcome<void>> {
    const release = await this.releases.findById(releaseId);
    if (!release) return fail(ChannelErrorCode.RELEASE_NOT_FOUND, "Sürüm bulunamadı");

    const channel = await this.channels.findById(channelId);
    if (!channel || channel.ownerId !== requesterId) {
      return fail(ErrorCode.UNAUTHORIZED, "Yetkisiz");
    }

    await this.releases.update(releaseId, {
      status:       "deprecated",
      deprecatedAt: new Date(),
      isLatest:     false,
    });

    this.eventBus?.emit("release:deprecated" as never, {
      releaseId,
      channelId,
      versionStr: release.versionStr,
    });

    return succeed(undefined);
  }

  async getLatest(projectId: string): Promise<Release | null> {
    return this.releases.findLatest(projectId);
  }

  async listByProject(projectId: string): Promise<Release[]> {
    const all = await this.releases.findByProject(projectId);
    // Semver sıralama (yüksek → düşük)
    return all.sort((a, b) => -compareVersions(a.version, b.version));
  }

  async listByChannel(channelId: string): Promise<Release[]> {
    return this.releases.findByChannel(channelId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FollowService
// ═══════════════════════════════════════════════════════════════════════════════

export class FollowService {

  constructor(
    follows:   IFollowRepository,
    channels:  IChannelRepository,
    eventBus?: IEventBus,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.channels = channels;
    this.follows = follows;}

  async follow(
    followerId: string,
    channelId:  string,
    notify?:    { onRelease: boolean; onDeprecated: boolean }
  ): Promise<CommandOutcome<ChannelFollow>> {
    const channel = await this.channels.findById(channelId);
    if (!channel) return fail(ChannelErrorCode.CHANNEL_NOT_FOUND, "Kanal bulunamadı");
    if (channel.visibility === "private" && channel.ownerId !== followerId) {
      return fail(ChannelErrorCode.CHANNEL_PRIVATE, "Özel kanal takip edilemez");
    }
    if (channel.ownerId === followerId) {
      return fail("SELF_FOLLOW", "Kendi kanalınızı takip edemezsiniz");
    }

    try {
      const follow = await this.follows.follow(followerId, channelId, notify);
      await this.channels.incrementStat(channelId, "followerCount");

      this.eventBus?.emit("channel:followed" as never, { followerId, channelId });
      this.logger?.debug(`Takip: ${followerId} → ${channelId}`);
      return succeed(follow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Takip başarısız";
      return fail("FOLLOW_FAILED", msg);
    }
  }

  async unfollow(
    followerId: string,
    channelId:  string
  ): Promise<CommandOutcome<void>> {
    const ok = await this.follows.unfollow(followerId, channelId);
    if (!ok) return fail(ChannelErrorCode.NOT_FOLLOWING, "Bu kanalı zaten takip etmiyorsunuz");
    await this.channels.incrementStat(channelId, "followerCount", -1);
    this.eventBus?.emit("channel:unfollowed" as never, { followerId, channelId });
    return succeed(undefined);
  }

  async getFollowers(channelId: string): Promise<ChannelFollow[]> {
    return this.follows.getFollowers(channelId);
  }

  async getFollowing(followerId: string): Promise<ChannelFollow[]> {
    return this.follows.getFollowing(followerId);
  }

  async isFollowing(followerId: string, channelId: string): Promise<boolean> {
    return this.follows.isFollowing(followerId, channelId);
  }

  /** Sürüm yayınlandığında bildirim alacak takipçiler */
  async notifyOnRelease(channelId: string): Promise<string[]> {
    const followers = await this.follows.getFollowers(channelId);
    return followers
      .filter((f) => f.notify.onRelease)
      .map((f) => f.followerId);
  }
}
