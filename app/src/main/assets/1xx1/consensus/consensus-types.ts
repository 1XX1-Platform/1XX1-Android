/**
 * 1XX1 Konsensüs Tipleri — V2
 * Aşama 15 (güncellendi) → Aşama 16
 *
 * İyileştirmeler:
 *   1. ConsensusCommand: genel payload yapısı (Pulse'a özgü değil)
 *   2. ValidatorWeight alanı eklendi (şimdilik weight=1, ileride stake/DAO)
 *   3. PulseBlock: blockNumber, pulseHash, snapshotHash, validatorRoot eklendi
 *   4. Transport channel ayrımı (CONSENSUS | GOSSIP | SNAPSHOT | TRANSFER)
 *   5. Deterministik pseudo-random için seed arayüzü
 */

// ─── Term ve Log Index ───────────────────────────────────────────────────────
export type Term     = number;
export type LogIndex = number;
export type NodeRole = "follower" | "candidate" | "leader";

// ─── Transport Channel ───────────────────────────────────────────────────────

/**
 * Her kanal kendi önceliğine sahip.
 * QoS: CONSENSUS > SNAPSHOT > GOSSIP > TRANSFER
 * İleride QUIC stream multiplexing ile gerçek kanal izolasyonu.
 */
export type TransportChannel =
  | "consensus"   // Raft RPC — yüksek öncelik, düşük latency
  | "gossip"      // Veri yayılımı — eventual, tolerant
  | "snapshot"    // Snapshot transferi — büyük, sıralı
  | "transfer";   // Asset chunk transferi — bulk

// ─── Genel Konsensüs Komutu ──────────────────────────────────────────────────

/**
 * ConsensusCommand artık Pulse'a özgü değil.
 * Her commit edilen komut bir CommandType ve opaque payload taşır.
 * Uygulama katmanı CommandType'a göre dispatch eder.
 *
 * Mevcut tüm tipler korundu; yeni tipler kırıcı değişiklik olmadan eklenebilir.
 */
export type CommandType =
  // Pulse
  | "pulse:commit"
  | "pulse:penalty"
  // Validator
  | "validator:add"
  | "validator:remove"
  // Politika
  | "policy:update"
  // Asset / Proje / Kanal — ileride
  | "asset:publish"
  | "project:archive"
  | "channel:update"
  | "snapshot:commit"
  // Sistem
  | "noop";

export interface ConsensusCommand {
  type:    CommandType;
  payload: ConsensusPayload;
}

export type ConsensusPayload =
  | PulseCommitPayload
  | PulsePenaltyPayload
  | ValidatorAddPayload
  | ValidatorRemovePayload
  | PolicyUpdatePayload
  | AssetPublishPayload
  | ProjectArchivePayload
  | ChannelUpdatePayload
  | SnapshotCommitPayload
  | NoopPayload;

export interface PulseCommitPayload {
  pulseNumber:      number;
  entries:          import("../pulse/pulse-types.ts").PulseEntry[];
  fairnessSnapshot: string;
}

export interface PulsePenaltyPayload {
  projectId: string;
  amount:    number;
  reason:    string;
}

export interface ValidatorAddPayload {
  nodeId:    string;
  publicKey: string;
  weight:    number; // şimdilik 1, ileride stake
}

export interface ValidatorRemovePayload {
  nodeId: string;
  reason: string;
}

export interface PolicyUpdatePayload {
  policyId: string;
  data:     unknown;
}

export interface AssetPublishPayload {
  assetId:     string;
  contentHash: string;
  ownerId:     string;
}

export interface ProjectArchivePayload {
  projectId:   string;
  requesterId: string;
  reason?:     string;
}

export interface ChannelUpdatePayload {
  channelId: string;
  patch:     unknown;
}

export interface SnapshotCommitPayload {
  snapshotHash: string;
  storeHashes:  Record<string, string>;
  logPosition:  number;
}

export interface NoopPayload {}

// ─── Raft Log Girdisi ────────────────────────────────────────────────────────

export interface RaftLogEntry {
  term:      Term;
  index:     LogIndex;
  command:   ConsensusCommand;
  timestamp: number;
  nodeId:    string;
  checksum:  string;
  /** FAZ 2.2 — Hash-chained log: SHA256(prevHash + payload) */
  prevHash:  string;
  /** Bu entry'nin kendi hash'i */
  entryHash: string;
}

// ─── Raft RPC ────────────────────────────────────────────────────────────────

export interface RequestVoteRPC {
  type:         "request_vote";
  term:         Term;
  candidateId:  string;
  lastLogIndex: LogIndex;
  lastLogTerm:  Term;
}

export interface RequestVoteResponse {
  type:        "vote_response";
  term:        Term;
  voteGranted: boolean;
  voterId:     string;
}

export interface AppendEntriesRPC {
  type:         "append_entries";
  term:         Term;
  leaderId:     string;
  prevLogIndex: LogIndex;
  prevLogTerm:  Term;
  entries:      RaftLogEntry[];
  leaderCommit: LogIndex;
}

export interface AppendEntriesResponse {
  type:       "append_response";
  term:       Term;
  success:    boolean;
  matchIndex: LogIndex;
  nodeId:     string;
}

export type RaftRPC =
  | RequestVoteRPC
  | RequestVoteResponse
  | AppendEntriesRPC
  | AppendEntriesResponse;

// ─── Deterministik Pseudo-Random ─────────────────────────────────────────────

/**
 * nodeId → seed → deterministik random.
 * Test'lerde her çalışmada aynı timeout → %100 tekrar edilebilir.
 *
 * xorshift32 algoritması: hızlı, deterministic, no external deps.
 */
export function seededRandom(seed: string): () => number {
  // Seed'i sayıya çevir (FNV-1a hash)
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h === 0 ? 1 : h;

  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    state = state >>> 0;
    return (state >>> 0) / 0xFFFFFFFF;
  };
}

/** Election timeout: min + seededRandom(nodeId) * (max - min) */
export function deterministicElectionTimeout(
  nodeId:  string,
  min:     number,
  max:     number,
  attempt: number = 0  // yeniden seçimde farklı timeout için
): number {
  const rng = seededRandom(`${nodeId}:${attempt}`);
  return Math.floor(min + rng() * (max - min));
}

// ─── Pulse Block V2 ──────────────────────────────────────────────────────────

export interface PulseBlock {
  /** Global blok numarası (genesis=0'dan başlar) */
  blockNumber:    number;
  /** Aşama 14 blok ID'si */
  blockId:        string;
  pulseNumber:    number;
  /** Önceki bloğun hash'i */
  prevBlockHash:  string;
  /** Sadece Pulse entries hash'i */
  pulseHash:      string;
  /** Tüm store snapshot hash'i (opsiyonel — her blokta değil) */
  snapshotHash?:  string;
  /** Aktif validator seti Merkle root (deterministik) */
  validatorRoot:  string;
  /** Raft log index */
  logIndex:       LogIndex;
  /** Raft term */
  term:           Term;
  leaderId:       string;
  entries:        import("../pulse/pulse-types.ts").PulseEntry[];
  totalProjects:  number;
  rotated:        string[];
  /** SHA-256(tüm alanlar hariç blockHash ve signatures) */
  blockHash:      string;
  timestamp:      number;
  /** nodeId → Ed25519 imzası */
  signatures:     Record<string, string>;
}

// ─── Validator Seti ──────────────────────────────────────────────────────────

export interface ValidatorInfo {
  nodeId:       string;
  publicKey:    string;
  /** Oy ağırlığı — şimdilik hepsi 1, ileride stake/DAO/Federation */
  weight:       number;
  addedAt:      number;
  addedByTerm:  Term;
  isActive:     boolean;
}

/** Ağırlıklı quorum: toplam ağırlığın > %50'si */
export function weightedQuorum(validators: ValidatorInfo[]): number {
  const total = validators.filter((v) => v.isActive)
    .reduce((s, v) => s + v.weight, 0);
  return Math.floor(total / 2) + 1;
}

// ─── Konsensüs Durumu ────────────────────────────────────────────────────────

export interface ConsensusState {
  nodeId:      string;
  role:        NodeRole;
  currentTerm: Term;
  votedFor:    string | null;
  leaderId:    string | null;
  commitIndex: LogIndex;
  lastApplied: LogIndex;
  logLength:   number;
}

// ─── Log Compaction ──────────────────────────────────────────────────────────

/**
 * Log compaction arayüzü — şimdilik stub, Aşama 18'de implemente edilir.
 * Kullanım: snapshot alındıktan sonra snapshot.logPosition'a kadar log truncate et.
 */
export interface ILogCompactor {
  /** Snapshot al ve bu index'e kadar log'u kesilebilir hale getir */
  compact(upToIndex: LogIndex): Promise<void>;
  /** Son snapshot bilgisi */
  lastCompacted(): LogIndex;
}

export class NoopLogCompactor implements ILogCompactor {
  private _lastCompacted: LogIndex = -1;
  async compact(upToIndex: LogIndex): Promise<void> {
    // Gerçek implementation: Aşama 18
    this._lastCompacted = upToIndex;
  }
  lastCompacted(): LogIndex { return this._lastCompacted; }
}

// ─── Konsensüs Metrikleri ────────────────────────────────────────────────────

export interface ConsensusMetrics {
  term:           Term;
  role:           NodeRole;
  logLength:      number;
  commitIndex:    LogIndex;
  electionCount:  number;
  leaderChanges:  number;
  avgCommitMs:    number;
  pendingEntries: number;
}
