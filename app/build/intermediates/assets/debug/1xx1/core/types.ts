/**
 * 1XX1 Core Type Definitions
 * Aşama 01 + Düzeltme: Event Scope Ayrımı
 *
 * Düzeltme 1: Olay kategorileri — cascade amplification önlemi
 *   CORE events   → her modül dinleyebilir
 *   INDEX events  → yalnızca index katmanı yayınlar/dinler
 *   REACTIVE events → CORE tetikler, CORE'a geri dönmez
 *
 * Kural: INDEX → CORE tetiklemez (cycle prevention)
 */

// ─── Koordinat ───────────────────────────────────────────────────────────────

export interface CubeCoordinate {
  x: number; // 0–10
  y: number; // 0–10
  z: number; // 0–10
}

// ─── Proje ───────────────────────────────────────────────────────────────────

export type ProjectStatus = "active" | "archived" | "pending" | "verified";
export type LicenseType   = "MIT" | "GPL" | "Apache" | "BSD" | "Custom" | "Unknown";

export interface Project {
  id: string;
  name: string;
  description: string;
  cube: CubeCoordinate;
  developer: string;
  repo: string;
  tags: string[];
  license: LicenseType;
  status: ProjectStatus;
  donationAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Geliştirici / Kanal ─────────────────────────────────────────────────────

export interface Developer {
  id: string;
  username: string;
  displayName: string;
  bio?: string;
  website?: string;
  donationAddress?: string;
  joinedAt: Date;
}

// ─── Arama ───────────────────────────────────────────────────────────────────

export interface SearchQuery {
  term: string;
  tags?: string[];
  cube?: Partial<CubeCoordinate>;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  projects: Project[];
  total: number;
  path: string[];        // arama yolu: ["STL", "CAD", "Mesh", "Repair"]
  cubeHits: CubeCoordinate[];
}

// ─── Nabız (Pulse) ───────────────────────────────────────────────────────────

export interface PulseEntry {
  projectId: string;
  score: number;
  lastSeen: Date;
  position: number;
}

export interface PulseSnapshot {
  timestamp: Date;
  entries: PulseEntry[];
  cycleCount: number;
}

// ─── API Yanıtı ──────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: number;
}

// ─── Sistem Olayları — Scope Ayrımlı (Düzeltme 1) ────────────────────────────

/**
 * CORE Events: proje yaşam döngüsü.
 * Her modül yayınlayabilir veya dinleyebilir.
 * INDEX layer bu olayları dinler, ama geri CORE'a olay atmaz.
 */
export type CoreEventType =
  | "project:created"
  | "project:updated"
  | "project:archived"
  | "pulse:tick"
  | "search:executed";

/**
 * CUBE Events: küp motoru operasyonları.
 * Yalnızca CubeEngine yayınlar.
 * INDEX layer dinleyebilir; CORE dinleyebilir.
 * INDEX → CUBE olay atmaz.
 */
export type CubeEventType =
  | "cube:indexed"
  | "cube:split"
  | "cube:merge"
  | "cube:overflow"
  | "cube:subcube-created"
  | "cube:subcube-removed"
  | "cube:path-changed";

/**
 * INDEX Events: indeks katmanı iç operasyonları.
 * Yalnızca IndexManager ve alt katmanlar yayınlar.
 * CORE ve CUBE bu olayları ASLA dinlemez (cycle prevention).
 * Sadece dış monitoring, audit, test dinleyebilir.
 */
export type IndexEventType =
  | "index:upserted"
  | "index:removed"
  | "index:reconciled"
  | "index:drift-detected";

/** Birleşik tip — EventBus'un type parametresi */
export type SystemEventType = CoreEventType | CubeEventType | IndexEventType;

export interface SystemEvent<T = unknown> {
  type: SystemEventType;
  payload: T;
  timestamp: Date;
  /** Hangi scope'ta oluştu — cycle detection için */
  scope: "core" | "cube" | "index";
}

// ─── Domain Events (Aşama 08) ─────────────────────────────────────────────────

/**
 * DOMAIN Events: iş kuralı olayları.
 * Application Services tarafından yayınlanır.
 * Scope: "core" — tüm modüller dinleyebilir.
 */
export type DomainEventType =
  | "project:published"      // proje ilk kez yayına alındı
  | "project:verified"       // güvenlik doğrulamasından geçti
  | "project:rejected"       // güvenlik doğrulamasından geçemedi
  | "developer:registered"   // yeni geliştirici kaydoldu
  | "developer:masked"       // geliştirici takma kimlik aldı
  | "asset:linked"           // projeye varlık bağlandı
  | "channel:created";       // geliştirici kanalı oluşturuldu

// types.ts'deki SystemEventType'a ekliyoruz
// (TypeScript genişletme: mevcut tip değiştirilmeden union eklenir)
