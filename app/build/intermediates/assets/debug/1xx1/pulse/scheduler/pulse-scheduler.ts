/**
 * 1XX1 Pulse Scheduler — Ana Orkestratör
 * Aşama 10 — Pulse Engine
 *
 * Tüm bileşenleri koordine eder:
 *   Clock → Eligibility → Ranking → Rotation → Snapshot → Events
 *
 * Determinizm garantisi:
 *   Aynı proje seti + aynı fairness kaydı + aynı pulse numarası
 *   → her zaman aynı sıralama
 *
 * Eşzamanlı tick koruması:
 *   Bir tick hesaplanırken ikinci tick başlamaz.
 *   _running bayrağı bunu garantiler.
 *
 * Restart recovery:
 *   start() çağrısında SnapshotStore'dan son durum yüklenir.
 *   Pulse numarası kaldığı yerden devam eder.
 */

import type { IEventBus, ILogger } from "../../core/interfaces.ts";
import type { Project } from "../../core/types.ts";
import type { FairnessRecord, PulseSnapshot, PulseEntry, PulseEngineStats } from "../pulse-types.ts";
import { EligibilityEngine } from "../eligibility/eligibility-engine.ts";
import { RankingEngine }    from "../ranking/ranking-engine.ts";
import { RotationEngine }   from "../rotation/rotation-engine.ts";
import { PulseSnapshotStore } from "../snapshot/pulse-snapshot.ts";
import type { IClock } from "../clock/pulse-clock.ts";
import { systemClock } from "../clock/pulse-clock.ts";

export interface PulseSchedulerConfig {
  intervalMs:        number;   // 5000
  maxEntries:        number;   // liste max boyutu
  maxConsecutiveTop: number;
  demoteSteps:       number;
  fairnessWeight:    number;
  trustWeight:       number;
  maxSnapshotHistory: number;
}

const DEFAULT_CONFIG: PulseSchedulerConfig = {
  intervalMs:         5_000,
  maxEntries:         1_000,
  maxConsecutiveTop:  10,
  demoteSteps:        20,
  fairnessWeight:     0.40,
  trustWeight:        0.10,
  maxSnapshotHistory: 10,
};

export class PulseScheduler {
  private readonly eligibility: EligibilityEngine;
  private readonly ranking:     RankingEngine;
  private readonly rotation:    RotationEngine;
  private readonly snapshots:   PulseSnapshotStore;

  /** Fairness kaydı: projectId → FairnessRecord */
  private fairness = new Map<string, FairnessRecord>();
  /** Son snapshot */
  private lastSnapshot: PulseSnapshot | null = null;
  /** Proje kaynağı: pulse her tick'te bunu çağırır */
  private projectSource?: () => Project[] | Promise<Project[]>;
  /** Trust skorları */
  private trustSource?: (projectId: string) => number;

  private _running     = false;
  private _ticking     = false;  // eşzamanlı tick koruması
  private _timer?: ReturnType<typeof setInterval>;
  private _totalPulses = 0;
  private _totalCycleMs = 0;
  private _cfg:          PulseSchedulerConfig;

  constructor(
    cfg: Partial<PulseSchedulerConfig> = {},
    clock:    IClock   = systemClock,
    eventBus?: IEventBus,
    logger?:  ILogger
  ) {
    this.logger = logger;
    this.eventBus = eventBus;
    this.clock = clock;
    this._cfg = { ...DEFAULT_CONFIG, ...cfg };

    this.eligibility = new EligibilityEngine({}, logger);
    this.ranking     = new RankingEngine({
      fair:    this._cfg.fairnessWeight,
      trust:   this._cfg.trustWeight,
      age:     1 - this._cfg.fairnessWeight - this._cfg.trustWeight,
      penalty: 1.0,
    });
    this.rotation    = new RotationEngine({
      maxConsecutiveTop: this._cfg.maxConsecutiveTop,
      demoteSteps:       this._cfg.demoteSteps,
    }, logger);
    this.snapshots   = new PulseSnapshotStore(this._cfg.maxSnapshotHistory);
  }

  // ─── Başlatma ────────────────────────────────────────────────────────────

  start(
    projectSource: () => Project[] | Promise<Project[]>,
    trustSource?:  (projectId: string) => number
  ): void {
    if (this._running) {
      this.logger?.warn("PulseScheduler zaten çalışıyor");
      return;
    }

    this.projectSource = projectSource;
    this.trustSource   = trustSource;

    // Restart recovery: son snapshot'tan fairness yükle
    const saved = this.snapshots.latest();
    if (saved && this.snapshots.verify(saved)) {
      this.fairness = this.snapshots.restoreFairness(saved);
      this.logger?.info(
        `PulseScheduler recovery: pulse ${saved.lastSnapshot.pulseNumber}, ` +
        `${this.fairness.size} fairness kaydı yüklendi`
      );
    }

    this._running = true;

    // İlk tick'i hemen çalıştır
    this._tick();

    this._timer = setInterval(() => this._tick(), this._cfg.intervalMs);

    this.eventBus?.emit("pulse:started" as never, {
      intervalMs:  this._cfg.intervalMs,
      startedAt:   new Date().toISOString(),
    });

    this.logger?.info(`PulseScheduler başladı (${this._cfg.intervalMs}ms interval)`);
  }

  stop(): void {
    if (!this._running) return;
    if (this._timer) clearInterval(this._timer);
    this._running = false;
    this.logger?.info("PulseScheduler durduruldu");
  }

  isRunning(): boolean { return this._running; }

  // ─── Manuel Tick (test için) ──────────────────────────────────────────────

  async tick(): Promise<PulseSnapshot | null> {
    return this._tick();
  }

  // ─── Fairness Yönetimi ────────────────────────────────────────────────────

  /** Proje fairness kaydını döndür */
  getFairness(projectId: string): FairnessRecord | undefined {
    return this.fairness.get(projectId);
  }

  /** Manuel ceza uygula (moderasyon) */
  applyPenalty(projectId: string, amount: number): void {
    const rec = this.fairness.get(projectId);
    if (rec) {
      rec.penalty += amount;
      this.logger?.info(`Ceza uygulandı: ${projectId} +${amount} (toplam: ${rec.penalty})`);
    }
  }

  /** Cezayı kaldır */
  clearPenalty(projectId: string): void {
    const rec = this.fairness.get(projectId);
    if (rec) rec.penalty = 0;
  }

  /** Anlamlı güncelleme kaydı (spam koruması için) */
  recordSignificantUpdate(projectId: string, currentPulse: number): void {
    const rec = this.fairness.get(projectId);
    if (rec) rec.lastSignificantUpdate = currentPulse;
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  currentSnapshot(): PulseSnapshot | null { return this.lastSnapshot; }

  stats(): PulseEngineStats {
    return {
      currentPulse:     this.clock.nowPulse(this._cfg.intervalMs),
      isRunning:        this._running,
      totalPulses:      this._totalPulses,
      eligibleProjects: this.lastSnapshot?.totalEligible ?? 0,
      avgCycleMs:       this._totalPulses > 0
        ? Math.round(this._totalCycleMs / this._totalPulses) : 0,
      lastSnapshotAt:   this.lastSnapshot?.completedAt,
    };
  }

  snapshotHistory(n = 5) {
    return this.snapshots.recent(n).map((s) => s.lastSnapshot);
  }

  // ─── Ana Tick ────────────────────────────────────────────────────────────

  private async _tick(): Promise<PulseSnapshot | null> {
    // Eşzamanlı tick koruması
    if (this._ticking) {
      this.logger?.warn("PulseScheduler: tick hâlâ çalışıyor, atlandı");
      return null;
    }
    this._ticking = true;
    const tickStart = Date.now();

    try {
      const currentPulse = this.clock.nowPulse(this._cfg.intervalMs);

      // 1. Projeleri al
      const allProjects = this.projectSource
        ? await Promise.resolve(this.projectSource())
        : [];

      if (allProjects.length === 0) {
        this._ticking = false;
        return null;
      }

      // 2. Eligibility filtresi
      const eligResults = this.eligibility.filter(allProjects, this.fairness, currentPulse);
      const eligibleIds  = new Set(this.eligibility.eligibleIds(eligResults));
      const eligible     = allProjects.filter((p) => eligibleIds.has(p.id));

      // 3. Trust skorları
      const trustScores = new Map<string, number>();
      for (const p of eligible) {
        trustScores.set(p.id, (this.trustSource?.(p.id) ?? 0));
      }

      // 4. Sıralama
      const ranked = this.ranking.rank(
        eligible.slice(0, this._cfg.maxEntries),
        this.fairness,
        trustScores,
        currentPulse
      );

      // 5. Rotasyon
      const rotResult = this.rotation.apply(ranked, this.fairness, currentPulse);

      // 6. İstatistikler
      const scores    = rotResult.entries.map((e) => e.score);
      const avgScore  = scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

      // 7. Snapshot oluştur
      const snapshot: PulseSnapshot = {
        pulseNumber:   currentPulse,
        intervalMs:    this._cfg.intervalMs,
        startMs:       currentPulse * this._cfg.intervalMs,
        completedAt:   new Date(),
        entries:       rotResult.entries,
        totalEligible: eligible.length,
        rotated:       rotResult.rotated,
        stats: {
          avgScore:   Math.round(avgScore * 10000) / 10000,
          minScore:   scores.length > 0 ? Math.min(...scores) : 0,
          maxScore:   scores.length > 0 ? Math.max(...scores) : 0,
          newEntries: rotResult.entries.filter((e) => !this.fairness.has(e.projectId)).length,
        },
      };

      this.lastSnapshot = snapshot;

      // 8. Snapshot kaydet (restart recovery için)
      this.snapshots.save(snapshot, this.fairness);

      // 9. Event yayınla
      this._emitEvents(snapshot, rotResult.rotated, rotResult.promoted);

      // 10. Metrikler
      const cycleMs = Date.now() - tickStart;
      this._totalPulses++;
      this._totalCycleMs += cycleMs;

      this.logger?.debug(
        `Pulse #${currentPulse}: ${eligible.length} proje, ` +
        `${rotResult.rotated.length} rotasyon, ${cycleMs}ms`
      );

      this._ticking = false;
      return snapshot;

    } catch (err) {
      this.logger?.error("Pulse tick hatası", err instanceof Error ? err : undefined);
      this._ticking = false;
      return null;
    }
  }

  private _emitEvents(
    snapshot: PulseSnapshot,
    rotated:  string[],
    promoted: string[]
  ): void {
    if (!this.eventBus) return;

    this.eventBus.emit("pulse:tick", {
      pulseNumber:  snapshot.pulseNumber,
      eligible:     snapshot.totalEligible,
      entries:      snapshot.entries.length,
      rotated:      rotated.length,
    });

    this.eventBus.emit("pulse:completed" as never, {
      pulseNumber: snapshot.pulseNumber,
      completedAt: snapshot.completedAt.toISOString(),
      avgScore:    snapshot.stats.avgScore,
    });

    for (const id of promoted) {
      this.eventBus.emit("project:promoted" as never, {
        projectId:   id,
        pulseNumber: snapshot.pulseNumber,
      });
    }

    for (const id of rotated) {
      this.eventBus.emit("project:demoted" as never, {
        projectId:   id,
        pulseNumber: snapshot.pulseNumber,
      });
    }
  }
}
