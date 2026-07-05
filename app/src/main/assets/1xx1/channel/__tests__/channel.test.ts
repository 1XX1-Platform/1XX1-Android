/**
 * 1XX1 Kanal Sistemi Testleri
 * Aşama 09 — Kanal (Ada) Sistemi 2.0
 *
 * Gruplar:
 *   channel-service  — oluşturma, güncelleme, cüzdan, slug
 *   release-service  — yayın, semver, deprecate, sıralama
 *   follow-service   — takip, bırakma, bildirim listesi
 *   trust-engine     — metrik hesaplama, ağırlıklar, açıklama
 *   wallet-manager   — adres doğrulama, limit, çakışma
 *   entegrasyon      — tam akış: kanal → sürüm → takip → trust
 */

import {
  runSuite, assert, assertEqual, makeProject, makeDeveloper
} from "../../core/test-utils.ts";
import {
  ChannelUnitOfWork,
  TrustScoreEngine,
  InMemoryChannelRepository,
  InMemoryReleaseRepository,
  InMemoryFollowRepository,
  InMemoryTrustScoreRepository,
} from "../index.ts";
import { ChannelService, ReleaseService, FollowService } from "../services/channel.services.ts";
import { EventBus } from "../../core/event-bus.ts";
import { createTestDb } from "../../database/index.ts";
import { newDeveloperID } from "../../core/identity.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function makeTestChannel(svc: ChannelService, ownerId: string, title = "Test Kanalı") {
  const r = await svc.create({
    ownerId,
    title,
    description: "Test kanalı açıklaması",
    visibility:  "public",
    tags:        ["test"],
  });
  assert(r.ok, `Kanal oluşturma başarısız: ${!r.ok ? r.message : ""}`);
  return r.ok ? r.data : null;
}

function makeUoW(bus?: EventBus) {
  const db  = createTestDb();
  const bus_ = bus ?? new EventBus();
  // Basit IProjectRepository mock
  const projRepo = {
    create: async () => makeProject() as never,
    findById: async () => null,
    findByCube: async () => [],
    findByDeveloper: async () => [],
    update: async () => null,
    archive: async () => false,
    listAll: async () => [],
    count: async () => 0,
  };
  return new ChannelUnitOfWork(projRepo, bus_);
}

// ─── ChannelService ───────────────────────────────────────────────────────────

await runSuite("channel-service/oluşturma", {
  "başarılı kanal oluşturma": async () => {
    const uow = makeUoW();
    const ownerId = newDeveloperID();
    const r = await uow.channelService.create({
      ownerId, title: "STL Stüdyo", description: "3D yazılım kanalı",
    });
    assert(r.ok, `${!r.ok ? r.message : ""}`);
    if (!r.ok) return;
    assertEqual(r.data.title,    "STL Stüdyo");
    assertEqual(r.data.ownerId,  ownerId);
    assert(r.data.id.startsWith("ch_"));
    assert(r.data.slug.includes("stl"));
    assertEqual(r.data.wallets,  []);
    assertEqual(r.data.verified, false);
  },

  "slug otomatik üretilir": async () => {
    const uow = makeUoW();
    const r = await uow.channelService.create({
      ownerId: newDeveloperID(),
      title:   "Mesh & Repair Tools!",
      description: "Açıklama",
    });
    assert(r.ok);
    if (r.ok) assert(/^[a-z0-9-]+$/.test(r.data.slug), `Slug: ${r.data.slug}`);
  },

  "slug çakışmasında sayaç eklenir": async () => {
    const uow = makeUoW();
    const a = await uow.channelService.create({ ownerId: newDeveloperID(), title: "Kanal", description: "D1" });
    const b = await uow.channelService.create({ ownerId: newDeveloperID(), title: "Kanal", description: "D2" });
    assert(a.ok && b.ok);
    if (a.ok && b.ok) assert(a.data.slug !== b.data.slug, "Slug'lar farklı olmalı");
  },

  "MAX 3 kanal sınırı": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    for (let i = 0; i < 3; i++) {
      const r = await uow.channelService.create({ ownerId, title: `Kanal ${i}`, description: "D" });
      assert(r.ok, `${i}. kanal oluşturulamadı`);
    }
    const r4 = await uow.channelService.create({ ownerId, title: "Kanal 4", description: "D" });
    assert(!r4.ok);
    if (!r4.ok) assertEqual(r4.code, "MAX_CHANNELS_REACHED");
  },
});

await runSuite("channel-service/güncelleme", {
  "sahibi güncelleyebilir": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const upd = await uow.channelService.update(ch!.id, ownerId, {
      title:       "Yeni Başlık",
      description: "Güncellendi",
    });
    assert(upd.ok);
    if (upd.ok) assertEqual(upd.data.title, "Yeni Başlık");
  },

  "başkası güncelleyemez": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const upd = await uow.channelService.update(ch!.id, newDeveloperID(), { title: "Hırsız" });
    assert(!upd.ok);
    if (!upd.ok) assertEqual(upd.code, "UNAUTHORIZED");
  },
});

await runSuite("channel-service/cüzdan", {
  "BTC cüzdan eklenir": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const r = await uow.channelService.addWallet(
      ch!.id, ownerId, "bitcoin",
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
    );
    assert(r.ok, `Cüzdan eklenemedi: ${!r.ok ? r.message : ""}`);
    if (r.ok) {
      assert(r.data.id.startsWith("wlt_"));
      assertEqual(r.data.network, "bitcoin");
    }
  },

  "ETH cüzdan eklenir": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const r = await uow.channelService.addWallet(
      ch!.id, ownerId, "ethereum",
      "0x742d35Cc6634C0532925a3b8D4C1Aa1d7B4e2c7"
    );
    assert(r.ok, `ETH cüzdan eklenemedi: ${!r.ok ? r.message : ""}`);
  },

  "geçersiz adres → INVALID_WALLET_ADDRESS": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const r = await uow.channelService.addWallet(ch!.id, ownerId, "bitcoin", "invalid-addr");
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "INVALID_WALLET_ADDRESS");
  },

  "aynı adres iki kez → WALLET_DUPLICATE": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    const addr    = "0x742d35Cc6634C0532925a3b8D4C1Aa1d7B4e2c7";

    await uow.channelService.addWallet(ch!.id, ownerId, "ethereum", addr);
    const r2 = await uow.channelService.addWallet(ch!.id, ownerId, "ethereum", addr);
    assert(!r2.ok);
    if (!r2.ok) assertEqual(r2.code, "WALLET_DUPLICATE");
  },

  "cüzdan kaldırılır": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const added = await uow.channelService.addWallet(
      ch!.id, ownerId, "ethereum",
      "0x742d35Cc6634C0532925a3b8D4C1Aa1d7B4e2c7"
    );
    assert(added.ok);
    if (!added.ok) return;

    const removed = await uow.channelService.removeWallet(ch!.id, ownerId, added.data.id);
    assert(removed.ok);
  },
});

// ─── ReleaseService ───────────────────────────────────────────────────────────

await runSuite("release-service/yayın", {
  "başarılı sürüm yayını": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const r = await uow.releaseService.publish({
      projectId:   "prj_test",
      channelId:   ch!.id,
      requesterId: ownerId,
      versionStr:  "1.0.0",
      title:       "v1.0.0 — İlk Kararlı Sürüm",
      notes:       "# Değişiklikler\n- İlk sürüm\n#reproducible",
      artifacts:   [{
        name:        "myapp-1.0.0-linux-x64.tar.gz",
        platform:    "linux-x64",
        size:        1024 * 1024 * 5,
        downloadUrl: "https://example.com/releases/1.0.0/linux.tar.gz",
        checksums:   { sha256: "abc123" },
      }],
    });

    assert(r.ok, `Sürüm yayınlanamadı: ${!r.ok ? r.message : ""}`);
    if (r.ok) {
      assert(r.data.id.startsWith("rel_"));
      assertEqual(r.data.versionStr,   "1.0.0");
      assertEqual(r.data.status,       "published");
      assertEqual(r.data.isLatest,     true);
      assertEqual(r.data.isPrerelease, false);
      assertEqual(r.data.artifacts.length, 1);
    }
  },

  "semver doğrulaması": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const r = await uow.releaseService.publish({
      projectId: "prj_t", channelId: ch!.id, requesterId: ownerId,
      versionStr: "not-a-version", title: "Bad", notes: "Notes",
    });
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "INVALID_VERSION");
  },

  "prerelease tespiti": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const r = await uow.releaseService.publish({
      projectId: "prj_t", channelId: ch!.id, requesterId: ownerId,
      versionStr: "2.0.0-beta.1", title: "Beta", notes: "Beta notes",
    });
    assert(r.ok);
    if (r.ok) assert(r.data.isPrerelease === true, "Beta prerelease olmalı");
  },

  "version çakışması": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    await uow.releaseService.publish({
      projectId: "prj_t", channelId: ch!.id, requesterId: ownerId,
      versionStr: "1.0.0", title: "V1", notes: "Notes",
    });
    const r2 = await uow.releaseService.publish({
      projectId: "prj_t", channelId: ch!.id, requesterId: ownerId,
      versionStr: "1.0.0", title: "V1 Again", notes: "Notes",
    });
    assert(!r2.ok);
    if (!r2.ok) assert(r2.code === "RELEASE_FAILED" || r2.message.includes("Sürüm"));
  },

  "deprecate: sürüm kullanımdan kaldırılır": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const pub = await uow.releaseService.publish({
      projectId: "prj_t", channelId: ch!.id, requesterId: ownerId,
      versionStr: "0.9.0", title: "Old", notes: "Notes",
    });
    assert(pub.ok);
    if (!pub.ok) return;

    const dep = await uow.releaseService.deprecate(pub.data.id, ownerId, ch!.id);
    assert(dep.ok);

    const updated = await uow.releaseRepo.findById(pub.data.id);
    assertEqual(updated?.status, "deprecated");
  },

  "listByProject semver sıralaması": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    for (const v of ["1.0.0", "1.2.0", "0.9.0", "2.0.0"]) {
      await uow.releaseService.publish({
        projectId: "prj_order", channelId: ch!.id, requesterId: ownerId,
        versionStr: v, title: `v${v}`, notes: "Notes",
      });
    }

    const list = await uow.releaseService.listByProject("prj_order");
    assertEqual(list[0].versionStr, "2.0.0", "En yüksek sürüm başta olmalı");
    assertEqual(list[1].versionStr, "1.2.0");
    assertEqual(list[2].versionStr, "1.0.0");
    assertEqual(list[3].versionStr, "0.9.0");
  },
});

// ─── FollowService ────────────────────────────────────────────────────────────

await runSuite("follow-service", {
  "takip et + bırak": async () => {
    const uow      = makeUoW();
    const ownerId  = newDeveloperID();
    const follower = newDeveloperID();
    const ch       = await makeTestChannel(uow.channelService, ownerId);
    assert(ch !== null);

    const follow = await uow.followService.follow(follower, ch!.id);
    assert(follow.ok, `Takip başarısız: ${!follow.ok ? follow.message : ""}`);
    assert(await uow.followService.isFollowing(follower, ch!.id));

    const unfollow = await uow.followService.unfollow(follower, ch!.id);
    assert(unfollow.ok);
    assert(!(await uow.followService.isFollowing(follower, ch!.id)));
  },

  "kendi kanalı takip edilemez": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const r = await uow.followService.follow(ownerId, ch!.id);
    assert(!r.ok);
    if (!r.ok) assertEqual(r.code, "SELF_FOLLOW");
  },

  "iki kez takip → ALREADY_FOLLOWING": async () => {
    const uow      = makeUoW();
    const ownerId  = newDeveloperID();
    const follower = newDeveloperID();
    const ch       = await makeTestChannel(uow.channelService, ownerId);

    await uow.followService.follow(follower, ch!.id);
    const r2 = await uow.followService.follow(follower, ch!.id);
    assert(!r2.ok);
    if (!r2.ok) assert(r2.code.includes("FOLLOW") || r2.message.includes("zaten"));
  },

  "takipçi sayısı güncellenir": async () => {
    const uow      = makeUoW();
    const ownerId  = newDeveloperID();
    const ch       = await makeTestChannel(uow.channelService, ownerId);

    for (let i = 0; i < 3; i++) {
      await uow.followService.follow(newDeveloperID(), ch!.id);
    }
    const count = await uow.followRepo.countFollowers(ch!.id);
    assertEqual(count, 3);
  },

  "notifyOnRelease: yalnızca bildirim isteyen takipçiler": async () => {
    const uow     = makeUoW();
    const ownerId = newDeveloperID();
    const ch      = await makeTestChannel(uow.channelService, ownerId);

    const f1 = newDeveloperID();
    const f2 = newDeveloperID();
    await uow.followService.follow(f1, ch!.id, { onRelease: true,  onDeprecated: false });
    await uow.followService.follow(f2, ch!.id, { onRelease: false, onDeprecated: true });

    const notify = await uow.followService.notifyOnRelease(ch!.id);
    assert(notify.includes(f1), "f1 bildirim listesinde olmalı");
    assert(!notify.includes(f2), "f2 bildirim listesinde olmamalı");
  },
});

// ─── Trust Score ──────────────────────────────────────────────────────────────

await runSuite("trust-score", {
  "boş kanal: 0 puan": () => {
    const engine = new TrustScoreEngine();
    const score  = engine.calculate("ch_1", [], []);
    assertEqual(score.metrics.totalScore, 0);
    assert(!score.metrics.openSource);
    assert(!score.metrics.verified);
    assert(!score.metrics.maintainerActivity);
  },

  "openSource: tüm projeler MIT → true": () => {
    const engine   = new TrustScoreEngine();
    const projects = [
      makeProject({ license: "MIT", status: "active" }),
      makeProject({ license: "MIT", status: "active" }),
    ];
    const score = engine.calculate("ch_os", projects, []);
    assert(score.metrics.openSource, "openSource true olmalı");
    assertEqual(score.metrics.totalScore, 20);
  },

  "openSource: Unknown lisans → false": () => {
    const engine   = new TrustScoreEngine();
    const projects = [makeProject({ license: "Unknown", status: "active" })];
    const score    = engine.calculate("ch_un", projects, []);
    assert(!score.metrics.openSource);
  },

  "verified: doğrulanmış proje → true": () => {
    const engine   = new TrustScoreEngine();
    const projects = [makeProject({ status: "verified" })];
    const score    = engine.calculate("ch_v", projects, []);
    assert(score.metrics.verified);
  },

  "signedRelease: imzalı artifact → true": () => {
    const engine = new TrustScoreEngine();
    const releases = [{
      id: "rel_1", projectId: "p1", channelId: "ch_1",
      version: { major: 1, minor: 0, patch: 0 }, versionStr: "1.0.0",
      title: "v1", notes: "Notes", status: "published" as const,
      artifacts: [{
        id: "art_1", name: "myapp.tar.gz", platform: "linux-x64" as const,
        size: 1000, downloadUrl: "https://r.com/1", checksums: { sha256: "abc" },
        signedBy: "0xABCDEF", uploadedAt: new Date(),
      }],
      tags: [], isLatest: true, isPrerelease: false,
      publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }];
    const score = engine.calculate("ch_sig", [], releases);
    assert(score.metrics.signedRelease, "signedRelease true olmalı");
  },

  "reproducibleBuild: #reproducible not → true": () => {
    const engine = new TrustScoreEngine();
    const releases = [{
      id: "rel_r", projectId: "p1", channelId: "ch_1",
      version: { major: 1, minor: 0, patch: 0 }, versionStr: "1.0.0",
      title: "v1", notes: "Bu sürüm #reproducible olarak işaretlendi",
      status: "published" as const, artifacts: [], tags: [],
      isLatest: true, isPrerelease: false,
      publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    }];
    const score = engine.calculate("ch_rb", [], releases);
    assert(score.metrics.reproducibleBuild);
  },

  "maintainerActivity: son 90 gün → true": () => {
    const engine = new TrustScoreEngine();
    const recent = makeProject({ status: "active" });
    recent.updatedAt = new Date(); // şimdi
    const score = engine.calculate("ch_act", [recent], []);
    assert(score.metrics.maintainerActivity, "Aktif bakımcı true olmalı");
  },

  "summary formatı": () => {
    const engine = new TrustScoreEngine();
    const score  = engine.calculate("ch_sum", [], []);
    assert(score.summary.includes("kriter"), `Summary: ${score.summary}`);
    assert(score.summary.includes("puan"), `Summary: ${score.summary}`);
  },

  "explain metod açıklama döndürür": () => {
    const engine = new TrustScoreEngine();
    const desc   = engine.explain("openSource");
    assert(desc.length > 10);
    assert(desc.includes("OSI") || desc.includes("lisans"));
  },

  "geçmiş eklenir": () => {
    const engine = new TrustScoreEngine();
    const first  = engine.calculate("ch_h", [], []);
    assertEqual(first.history.length, 0);
    const second = engine.calculate("ch_h", [], [], first);
    assertEqual(second.history.length, 1);
    assertEqual(second.history[0].score, 0);
  },
});

// ─── Entegrasyon ──────────────────────────────────────────────────────────────

await runSuite("entegrasyon/tam-akış", {
  "kanal → sürüm → takip → trust": async () => {
    const bus     = new EventBus();
    const uow     = makeUoW(bus);
    const ownerId = newDeveloperID();
    const follId  = newDeveloperID();

    const events: string[] = [];
    bus.on("channel:created"  as never, () => events.push("ch:created"));
    bus.on("release:published" as never, () => events.push("rel:published"));
    bus.on("channel:followed"  as never, () => events.push("ch:followed"));

    // 1. Kanal oluştur
    const ch = await uow.channelService.create({
      ownerId, title: "Entegrasyon Kanalı", description: "Test",
      tags: ["integration"],
    });
    assert(ch.ok);
    if (!ch.ok) return;

    // 2. Sürüm yayınla
    const rel = await uow.releaseService.publish({
      projectId:   "prj_int",
      channelId:   ch.data.id,
      requesterId: ownerId,
      versionStr:  "1.0.0",
      title:       "v1.0.0",
      notes:       "İlk sürüm #reproducible",
      artifacts: [{
        name: "app.wasm", platform: "wasm",
        size: 512_000, downloadUrl: "https://r.com/app.wasm",
        checksums: { sha256: "deadbeef" }, signedBy: "0xKAPTAN",
      }],
    });
    assert(rel.ok, `Sürüm: ${!rel.ok ? rel.message : ""}`);

    // 3. Takip et
    const follow = await uow.followService.follow(follId, ch.data.id);
    assert(follow.ok);

    // 4. Olaylar doğrula
    assert(events.includes("ch:created"),   "ch:created yayınlanmalı");
    assert(events.includes("rel:published"), "rel:published yayınlanmalı");
    assert(events.includes("ch:followed"),  "ch:followed yayınlanmalı");

    // 5. Trust Score hesapla (mock proje ile)
    const projects = [makeProject({ license: "MIT", status: "verified" })];
    const releases = rel.ok ? [rel.data] : [];
    const score    = uow.trustEngine.calculate(ch.data.id, projects, releases);
    assert(score.metrics.totalScore > 0, `Score > 0: ${score.metrics.totalScore}`);
    assert(score.metrics.signedRelease, "GPG imzalı");
    assert(score.metrics.reproducibleBuild, "#reproducible var");

    // 6. Bildirim listesi
    const notify = await uow.followService.notifyOnRelease(ch.data.id);
    assert(notify.includes(follId), "Takipçi bildirim listesinde");
  },
});
