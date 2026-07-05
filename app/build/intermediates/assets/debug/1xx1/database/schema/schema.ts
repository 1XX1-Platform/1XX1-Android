/**
 * 1XX1 Veritabanı Şema Tanımları
 * Aşama 07 — Persistence Katmanı
 *
 * Tablo yapıları TypeScript sabitleri olarak tanımlanır.
 * Migration sistemi bu tanımları SQL'e dönüştürür.
 * Hiçbir üst katman bu dosyayı import etmez — yalnızca migration ve mapper kullanır.
 */

// ─── Tablo Adları ─────────────────────────────────────────────────────────────

export const TABLE = {
  PROJECTS:        "projects",
  DEVELOPERS:      "developers",
  CUBE_SNAPSHOTS:  "cube_snapshots",
  EVENTS:          "events",
  CUBE_INDEX:      "cube_index",      // küp-proje ilişkisi (Aşama 07)
} as const;

export type TableName = typeof TABLE[keyof typeof TABLE];

// ─── Kolon Tipleri ────────────────────────────────────────────────────────────

export type PgType =
  | "TEXT"
  | "VARCHAR(255)"
  | "INTEGER"
  | "BIGINT"
  | "BOOLEAN"
  | "TIMESTAMPTZ"
  | "JSONB"
  | "TEXT[]"
  | "NUMERIC(6,4)";

export interface ColumnDef {
  type:        PgType;
  notNull?:    boolean;
  primaryKey?: boolean;
  default?:    string;     // SQL ifadesi (örn. "NOW()", "'active'")
  unique?:     boolean;
  references?: { table: TableName; column: string };
}

// ─── Tablo Şemaları ───────────────────────────────────────────────────────────

/** projects tablosu */
export const SCHEMA_PROJECTS: Record<string, ColumnDef> = {
  id:          { type: "TEXT",         primaryKey: true, notNull: true },
  name:        { type: "VARCHAR(255)", notNull: true },
  description: { type: "TEXT",         notNull: true, default: "''" },
  cube_x:      { type: "INTEGER",      notNull: true },
  cube_y:      { type: "INTEGER",      notNull: true },
  cube_z:      { type: "INTEGER",      notNull: true },
  cube_path:   { type: "TEXT",         notNull: true },          // "4/7/2"
  developer_id:{ type: "TEXT",         notNull: true },
  repo:        { type: "TEXT",         notNull: true, default: "''" },
  tags:        { type: "TEXT[]",       notNull: true, default: "ARRAY[]::TEXT[]" },
  license:     { type: "VARCHAR(255)", notNull: true, default: "'Unknown'" },
  status:      { type: "VARCHAR(255)", notNull: true, default: "'active'" },
  donation_address: { type: "TEXT" },
  created_at:  { type: "TIMESTAMPTZ",  notNull: true, default: "NOW()" },
  updated_at:  { type: "TIMESTAMPTZ",  notNull: true, default: "NOW()" },
};

/** developers tablosu */
export const SCHEMA_DEVELOPERS: Record<string, ColumnDef> = {
  id:               { type: "TEXT",         primaryKey: true, notNull: true },
  username:         { type: "VARCHAR(255)", notNull: true, unique: true },
  display_name:     { type: "VARCHAR(255)", notNull: true },
  bio:              { type: "TEXT" },
  website:          { type: "TEXT" },
  donation_address: { type: "TEXT" },
  joined_at:        { type: "TIMESTAMPTZ",  notNull: true, default: "NOW()" },
};

/** events tablosu — Event Store */
export const SCHEMA_EVENTS: Record<string, ColumnDef> = {
  event_id:         { type: "TEXT",         primaryKey: true, notNull: true },
  scope:            { type: "VARCHAR(255)", notNull: true },      // "core" | "cube" | "index"
  event_type:       { type: "VARCHAR(255)", notNull: true },
  payload:          { type: "JSONB",         notNull: true, default: "'{}'::jsonb" },
  idempotency_key:  { type: "TEXT",          unique: true },
  created_at:       { type: "TIMESTAMPTZ",   notNull: true, default: "NOW()" },
};

/** cube_snapshots tablosu — Snapshot Sistemi */
export const SCHEMA_CUBE_SNAPSHOTS: Record<string, ColumnDef> = {
  snapshot_id: { type: "TEXT",       primaryKey: true, notNull: true },
  cube_path:   { type: "TEXT",       notNull: true },
  payload:     { type: "JSONB",      notNull: true },             // düğüm durumu JSON
  checksum:    { type: "TEXT",       notNull: true },             // SHA-256 hex
  created_at:  { type: "TIMESTAMPTZ", notNull: true, default: "NOW()" },
};

/** cube_index tablosu — Küp-Proje ilişkisi */
export const SCHEMA_CUBE_INDEX: Record<string, ColumnDef> = {
  cube_path:   { type: "TEXT",         notNull: true },
  project_id:  { type: "TEXT",         notNull: true,
                 references: { table: TABLE.PROJECTS, column: "id" } },
  depth:       { type: "INTEGER",      notNull: true, default: "0" },
  indexed_at:  { type: "TIMESTAMPTZ",  notNull: true, default: "NOW()" },
};

// ─── İndeks Tanımları ─────────────────────────────────────────────────────────

export interface IndexDef {
  name:    string;
  table:   TableName;
  columns: string[];
  unique?: boolean;
  method?: "btree" | "gin" | "hash";  // GIN: JSONB / diziler için
}

export const INDEXES: IndexDef[] = [
  // projects
  { name: "idx_projects_developer_id", table: TABLE.PROJECTS,  columns: ["developer_id"] },
  { name: "idx_projects_cube_path",    table: TABLE.PROJECTS,  columns: ["cube_path"] },
  { name: "idx_projects_status",       table: TABLE.PROJECTS,  columns: ["status"] },
  { name: "idx_projects_license",      table: TABLE.PROJECTS,  columns: ["license"] },
  { name: "idx_projects_created_at",   table: TABLE.PROJECTS,  columns: ["created_at"] },
  { name: "idx_projects_tags",         table: TABLE.PROJECTS,  columns: ["tags"],
    method: "gin" },   // GIN: dizi araması için
  { name: "idx_projects_cube_xyz",     table: TABLE.PROJECTS,
    columns: ["cube_x", "cube_y", "cube_z"] },
  // developers
  { name: "idx_developers_username",   table: TABLE.DEVELOPERS, columns: ["username"], unique: true },
  // events
  { name: "idx_events_scope_type",     table: TABLE.EVENTS,     columns: ["scope", "event_type"] },
  { name: "idx_events_created_at",     table: TABLE.EVENTS,     columns: ["created_at"] },
  { name: "idx_events_ikey",           table: TABLE.EVENTS,     columns: ["idempotency_key"], unique: true },
  // cube_snapshots
  { name: "idx_snapshots_cube_path",   table: TABLE.CUBE_SNAPSHOTS, columns: ["cube_path"] },
  { name: "idx_snapshots_created_at",  table: TABLE.CUBE_SNAPSHOTS, columns: ["created_at"] },
  // cube_index
  { name: "idx_cube_index_path",       table: TABLE.CUBE_INDEX,  columns: ["cube_path"] },
  { name: "idx_cube_index_project",    table: TABLE.CUBE_INDEX,  columns: ["project_id"] },
];
