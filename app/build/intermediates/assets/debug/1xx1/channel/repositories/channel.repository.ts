/**
 * 1XX1 Kanal Repository'leri
 * Aşama 09 — Kanal Sistemi 2.0
 *
 * Aşama 07'deki UnitOfWork paterni izlenir.
 * In-memory implementasyon — Aşama 07 DB katmanına bağlanmaya hazır.
 * Her repository yalnızca CRUD — iş mantığı yok.
 */

import type {
  Channel, ChannelFollow, Release, TrustScore,
  ChannelVisibility, SemanticVersion,
} from "../entities/channel.entity.ts";
import { generateId } from "../../core/utils.ts";
import { ChannelErrorCode } from "../../core/errors.ts";
import { SystemError, ErrorCode } from "../../core/errors.ts";

// ─── IChannelRepository ───────────────────────────────────────────────────────

export interface IChannelRepository {
  create(data: Omit<Channel, "id" | "createdAt" | "updatedAt" | "stats">): Promise<Channel>;
  findById(id: string): Promise<Channel | null>;
  findBySlug(slug: string): Promise<Channel | null>;
  findByOwner(ownerId: string): Promise<Channel[]>;
  update(id: string, patch: Partial<Channel>): Promise<Channel | null>;
  delete(id: string): Promise<boolean>;
  listPublic(limit?: number, offset?: number): Promise<Channel[]>;
  incrementStat(id: string, field: keyof Channel["stats"], delta?: number): Promise<void>;
  count(): Promise<number>;
}

// ─── IReleaseRepository ───────────────────────────────────────────────────────

export interface IReleaseRepository {
  create(data: Omit<Release, "id" | "createdAt" | "updatedAt">): Promise<Release>;
  findById(id: string): Promise<Release | null>;
  findByProject(projectId: string): Promise<Release[]>;
  findByChannel(channelId: string): Promise<Release[]>;
  findLatest(projectId: string): Promise<Release | null>;
  findByVersion(projectId: string, versionStr: string): Promise<Release | null>;
  update(id: string, patch: Partial<Release>): Promise<Release | null>;
  setLatest(releaseId: string, projectId: string): Promise<void>;
  count(): Promise<number>;
}

// ─── IFollowRepository ────────────────────────────────────────────────────────

export interface IFollowRepository {
  follow(followerId: string, channelId: string, notify?: { onRelease: boolean; onDeprecated: boolean }): Promise<ChannelFollow>;
  unfollow(followerId: string, channelId: string): Promise<boolean>;
  isFollowing(followerId: string, channelId: string): Promise<boolean>;
  getFollowers(channelId: string): Promise<ChannelFollow[]>;
  getFollowing(followerId: string): Promise<ChannelFollow[]>;
  countFollowers(channelId: string): Promise<number>;
}

// ─── ITrustScoreRepository ────────────────────────────────────────────────────

export interface ITrustScoreRepository {
  save(score: TrustScore): Promise<TrustScore>;
  findByChannel(channelId: string): Promise<TrustScore | null>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// In-Memory Implementasyonlar
// ═══════════════════════════════════════════════════════════════════════════════

export class InMemoryChannelRepository implements IChannelRepository {
  private readonly store = new Map<string, Channel>();

  async create(data: Omit<Channel, "id" | "createdAt" | "updatedAt" | "stats">): Promise<Channel> {
    // Slug benzersizlik
    for (const ch of this.store.values()) {
      if (ch.slug === data.slug) {
        throw new SystemError({ code: ChannelErrorCode.CHANNEL_SLUG_TAKEN as never, message: `Slug zaten kullanımda: "${data.slug}"` });
      }
    }
    const now = new Date();
    const ch: Channel = {
      ...data,
      id: `ch_${generateId()}`,
      stats: { projectCount: 0, releaseCount: 0, followerCount: 0, totalDownloads: 0, lastActivity: now },
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(ch.id, ch);
    return { ...ch };
  }

  async findById(id: string): Promise<Channel | null> {
    const ch = this.store.get(id);
    return ch ? { ...ch, wallets: [...ch.wallets] } : null;
  }

  async findBySlug(slug: string): Promise<Channel | null> {
    for (const ch of this.store.values()) {
      if (ch.slug === slug) return { ...ch };
    }
    return null;
  }

  async findByOwner(ownerId: string): Promise<Channel[]> {
    return Array.from(this.store.values())
      .filter((ch) => ch.ownerId === ownerId)
      .map((ch) => ({ ...ch }));
  }

  async update(id: string, patch: Partial<Channel>): Promise<Channel | null> {
    const ch = this.store.get(id);
    if (!ch) return null;
    // Slug değişiyorsa benzersizlik kontrolü
    if (patch.slug && patch.slug !== ch.slug) {
      for (const other of this.store.values()) {
        if (other.id !== id && other.slug === patch.slug) {
          throw new SystemError({ code: ChannelErrorCode.CHANNEL_SLUG_TAKEN as never, message: `Slug zaten kullanımda: "${patch.slug}"` });
        }
      }
    }
    const updated = { ...ch, ...patch, id, updatedAt: new Date() };
    this.store.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async listPublic(limit = 20, offset = 0): Promise<Channel[]> {
    return Array.from(this.store.values())
      .filter((ch) => ch.visibility === "public")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((ch) => ({ ...ch }));
  }

  async incrementStat(id: string, field: keyof Channel["stats"], delta = 1): Promise<void> {
    const ch = this.store.get(id);
    if (!ch) return;
    const stats = { ...ch.stats };
    if (field === "lastActivity") {
      stats.lastActivity = new Date();
    } else {
      (stats as Record<string, number>)[field] = ((stats as Record<string, number>)[field] ?? 0) + delta;
    }
    ch.stats    = stats;
    ch.updatedAt = new Date();
  }

  async count(): Promise<number> { return this.store.size; }
}

// ─── In-Memory Release Repository ────────────────────────────────────────────

export class InMemoryReleaseRepository implements IReleaseRepository {
  private readonly store = new Map<string, Release>();

  async create(data: Omit<Release, "id" | "createdAt" | "updatedAt">): Promise<Release> {
    // Version benzersizlik
    for (const r of this.store.values()) {
      if (r.projectId === data.projectId && r.versionStr === data.versionStr) {
        throw new SystemError({ code: ChannelErrorCode.RELEASE_VERSION_EXISTS as never, message: `Sürüm zaten var: ${data.versionStr}` });
      }
    }
    const now = new Date();
    const release: Release = {
      ...data,
      id: `rel_${generateId()}`,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(release.id, release);
    return { ...release, artifacts: [...release.artifacts] };
  }

  async findById(id: string): Promise<Release | null> {
    const r = this.store.get(id);
    return r ? { ...r } : null;
  }

  async findByProject(projectId: string): Promise<Release[]> {
    return Array.from(this.store.values())
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async findByChannel(channelId: string): Promise<Release[]> {
    return Array.from(this.store.values())
      .filter((r) => r.channelId === channelId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async findLatest(projectId: string): Promise<Release | null> {
    const r = Array.from(this.store.values())
      .filter((r) => r.projectId === projectId && r.isLatest)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return r ? { ...r } : null;
  }

  async findByVersion(projectId: string, versionStr: string): Promise<Release | null> {
    for (const r of this.store.values()) {
      if (r.projectId === projectId && r.versionStr === versionStr) return { ...r };
    }
    return null;
  }

  async update(id: string, patch: Partial<Release>): Promise<Release | null> {
    const r = this.store.get(id);
    if (!r) return null;
    const updated = { ...r, ...patch, id, updatedAt: new Date() };
    this.store.set(id, updated);
    return { ...updated };
  }

  async setLatest(releaseId: string, projectId: string): Promise<void> {
    // Önce tüm proje sürümlerini isLatest=false yap
    for (const [id, r] of this.store) {
      if (r.projectId === projectId && r.isLatest) {
        this.store.set(id, { ...r, isLatest: false });
      }
    }
    // Sonra hedef sürümü işaretle
    const target = this.store.get(releaseId);
    if (target) this.store.set(releaseId, { ...target, isLatest: true });
  }

  async count(): Promise<number> { return this.store.size; }
}

// ─── In-Memory Follow Repository ─────────────────────────────────────────────

export class InMemoryFollowRepository implements IFollowRepository {
  private readonly store = new Map<string, ChannelFollow>(); // `${followerId}:${channelId}`

  private _key(f: string, c: string) { return `${f}:${c}`; }

  async follow(
    followerId: string,
    channelId:  string,
    notify = { onRelease: true, onDeprecated: false }
  ): Promise<ChannelFollow> {
    const key = this._key(followerId, channelId);
    if (this.store.has(key)) {
      throw new SystemError({ code: ChannelErrorCode.ALREADY_FOLLOWING as never, message: "Zaten takip ediyorsunuz" });
    }
    const follow: ChannelFollow = {
      followerId, channelId, notify,
      followedAt: new Date(),
    };
    this.store.set(key, follow);
    return follow;
  }

  async unfollow(followerId: string, channelId: string): Promise<boolean> {
    return this.store.delete(this._key(followerId, channelId));
  }

  async isFollowing(followerId: string, channelId: string): Promise<boolean> {
    return this.store.has(this._key(followerId, channelId));
  }

  async getFollowers(channelId: string): Promise<ChannelFollow[]> {
    return Array.from(this.store.values()).filter((f) => f.channelId === channelId);
  }

  async getFollowing(followerId: string): Promise<ChannelFollow[]> {
    return Array.from(this.store.values()).filter((f) => f.followerId === followerId);
  }

  async countFollowers(channelId: string): Promise<number> {
    return (await this.getFollowers(channelId)).length;
  }
}

// ─── In-Memory TrustScore Repository ─────────────────────────────────────────

export class InMemoryTrustScoreRepository implements ITrustScoreRepository {
  private readonly store = new Map<string, TrustScore>();

  async save(score: TrustScore): Promise<TrustScore> {
    this.store.set(score.channelId, score);
    return score;
  }

  async findByChannel(channelId: string): Promise<TrustScore | null> {
    return this.store.get(channelId) ?? null;
  }
}
