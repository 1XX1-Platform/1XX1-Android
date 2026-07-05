/**
 * 1XX1 Pulse Engine Tipleri
 * Aşama 10 — Pulse Engine
 */

import type { Project } from "../core/types.ts";

// ─── Fairness Kaydı ──────────────────────────────────────────────────────────

/** Bir projenin Pulse geçmişindeki adalet verisi */
export interface FairnessRecord {
  projectId:       string;
  /** En son üst sırada görüldüğü pulse numarası */
  lastTopPulse:    number;
  /** Toplam üst sırada kalma sayısı */
  topCount:        number;
  /** En son görüldüğü pulse numarası (herhangi bir konumda) */
  lastSeenPulse:   number;
  /** Pulse sistemine girdiği an */
  firstPulse:      number;
  /** Manuel ceza puanı (manipülasyon tespitinde uygulanır) */
  penalty:         number;
  /** Son anlamlı güncelleme pulse numarası (spam koruması) */
  lastSignificantUpdate: number;
}

// ─── Pulse Girişi ────────────────────────────────────────────────────────────

/** Bir pulse döngüsündeki tek proje satırı */
export interface PulseEntry {
  rank:       number;
  projectId:  string;
  score:      number;
  pulseAge:   number;       // pulse sisteminde kaç pulse geçti
  fairness:   number;       // 0–1: daha az görünmüş → yüksek
  trust:      number;       // 0–1: kanal trust score
  penalty:    number;       // negatif: ceza
  promoted:   boolean;      // bu pulse'ta yükseldi mi?
  demoted:    boolean;      // bu pulse'ta düştü mü?
}

// ─── Pulse Snapshot ───────────────────────────────────────────────────────────

/** Tek bir pulse döngüsünün tamamlanmış görüntüsü */
export interface PulseSnapshot {
  pulseNumber: number;
  intervalMs:  number;
  startMs:     number;
  completedAt: Date;
  entries:     PulseEntry[];
  totalEligible: number;   // uygun proje sayısı
  rotated:     string[];   // bu pulse'ta rotasyona uğrayan proje ID'leri
  stats: {
    avgScore:  number;
    minScore:  number;
    maxScore:  number;
    newEntries: number;   // ilk kez listelenen projeler
  };
}

// ─── Eligibility Sonucu ──────────────────────────────────────────────────────

export type EligibilityReason =
  | "archived"
  | "banned"
  | "hidden"
  | "no_release"       // aktif sürüm yok
  | "policy_block"     // policy tarafından engellendi
  | "spam_detected";   // manipülasyon tespit edildi

export interface EligibilityResult {
  projectId:  string;
  eligible:   boolean;
  reason?:    EligibilityReason;
}

// ─── Pulse Engine İstatistikleri ──────────────────────────────────────────────

export interface PulseEngineStats {
  currentPulse:    number;
  isRunning:       boolean;
  totalPulses:     number;
  eligibleProjects: number;
  avgCycleMs:      number;  // pulse hesaplama süresi
  lastSnapshotAt?: Date;
}
