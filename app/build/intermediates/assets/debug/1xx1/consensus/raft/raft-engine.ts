/**
 * 1XX1 Raft Konsensüs Motoru — V2
 * Aşama 15 (güncellendi)
 *
 * V2 iyileştirmeleri:
 *   - Deterministik election timeout (seededRandom(nodeId:attempt))
 *   - ConsensusCommand genel payload yapısı
 *   - Log compaction hook (ILogCompactor)
 *   - TransportChannel ayrımı (RpcSender'a kanal parametresi)
 *   - Pulse Engine Raft'ı bilmez (CommandApplier genel dispatch)
 */

import type {
  Term, LogIndex, NodeRole, RaftLogEntry, ConsensusCommand,
  RequestVoteRPC, RequestVoteResponse,
  AppendEntriesRPC, AppendEntriesResponse,
  ConsensusState, ConsensusMetrics, RaftRPC,
  TransportChannel, ILogCompactor,
} from "../consensus-types.ts";
import { deterministicElectionTimeout, NoopLogCompactor } from "../consensus-types.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";

// ─── Yapılandırma ─────────────────────────────────────────────────────────────

export interface RaftConfig {
  electionTimeoutMinMs: number;
  electionTimeoutMaxMs: number;
  heartbeatIntervalMs:  number;
  clusterSize:          number;
  /** true → deterministik timeout (test); false → Math.random() (production) */
  deterministicTimeout: boolean;
}

const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionTimeoutMinMs:  150,
  electionTimeoutMaxMs:  300,
  heartbeatIntervalMs:   50,
  clusterSize:           3,
  deterministicTimeout:  false, // production varsayılanı
};

// ─── RPC Göndericisi ─────────────────────────────────────────────────────────

export type RpcSender = (
  toNodeId: string,
  rpc:      RaftRPC,
  channel:  TransportChannel
) => Promise<void>;

export type CommandApplier = (command: ConsensusCommand, index: LogIndex) => Promise<void>;

// ─── RaftEngine ───────────────────────────────────────────────────────────────

export class RaftEngine {
  // Persistent State
  private currentTerm: Term        = 0;
  private votedFor:    string|null = null;
  private log:         RaftLogEntry[] = [];

  // Volatile State
  private role:        NodeRole    = "follower";
  private leaderId:    string|null = null;
  private commitIndex: LogIndex    = -1;
  private lastApplied: LogIndex    = -1;

  // Leader State
  private nextIndex:   Map<string, LogIndex> = new Map();
  private matchIndex:  Map<string, LogIndex> = new Map();

  // Election State
  private votesReceived = new Set<string>();
  private electionAttempt = 0;
  private electionTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  // Metrics
  private electionCount = 0;
  private leaderChanges = 0;
  private commitTimes:  number[] = [];

  private readonly cfg:    RaftConfig;
  private readonly peers:  string[];
  private _running = false;

  constructor(
    nodeId:     string,
    peers:           string[],
    sendRpc:    RpcSender,
    applyCmd:   CommandApplier,
    cfg:             Partial<RaftConfig> = {},
    compactor:  ILogCompactor = new NoopLogCompactor(),
    private readonly logger?:    ILogger
  ) {
    this.cfg   = { ...DEFAULT_RAFT_CONFIG, ...cfg, clusterSize: peers.length + 1 };
    this.peers = peers;
  }

  // ─── Yaşam Döngüsü ───────────────────────────────────────────────────────

  start(): void {
    if (this._running) return;
    this._running = true;
    this._resetElectionTimer();
    this.logger?.info(`Raft başladı: ${this.nodeId} (${this.cfg.clusterSize} düğüm)`);
  }

  stop(): void {
    this._running = false;
    this._clearTimers();
  }

  // ─── Komut Önerisi ───────────────────────────────────────────────────────

  async propose(command: ConsensusCommand): Promise<{ ok: boolean; error?: string; leaderId?: string }> {
    if (this.role !== "leader") {
      return { ok: false, error: "NOT_LEADER", leaderId: this.leaderId ?? undefined };
    }

    // FAZ 2.2 — Hash-chained log
    const prevEntry  = this.log.at(-1);
    const prevHash   = prevEntry?.entryHash ?? "0".repeat(64);
    const payload    = JSON.stringify(command);
    const checksum   = await sha256Hex(payload);
    const entryHash  = await sha256Hex(prevHash + checksum);

    const entry: RaftLogEntry = {
      term:      this.currentTerm,
      index:     this.log.length,
      command,
      timestamp: Date.now(),
      nodeId:    this.nodeId,
      checksum,
      prevHash,
      entryHash,
    };

    this.log.push(entry);
    await this._sendAppendEntries();
    return { ok: true };
  }

  /**
   * FAZ 2.1 — commitIndex asla geri gitmez.
   * Bu invariant'ı ihlal eden herhangi bir çağrı reddedilir.
   */
  private _safeSetCommitIndex(newIndex: LogIndex): boolean {
    if (newIndex < this.commitIndex) {
      this.logger?.warn(`[FAZ2] commitIndex geri sarma engellendi: ${this.commitIndex} → ${newIndex}`);
      return false;
    }
    this.commitIndex = newIndex;
    return true;
  }

  /**
   * FAZ 2.1 — Stale leader rejection.
   * Eğer başka bir lider benden yüksek term ile mesaj gönderiyorsa
   * derhal follower ol.
   */
  private _checkStaleLeader(remoteTerm: Term, remoteLeaderId?: string | null): boolean {
    if (remoteTerm > this.currentTerm) {
      this.logger?.warn(`[FAZ2] Stale leader tespiti: term ${this.currentTerm} → ${remoteTerm}`);
      this._becomeFollower(remoteTerm, remoteLeaderId ?? null);
      return true; // stale
    }
    return false;
  }

  /**
   * FAZ 2.2 — Follower log hash-chain doğrulaması.
   * Gelen entry'nin prevHash'i bizim son entry'nin entryHash'iyle eşleşmeli.
   */
  private async _verifyHashChain(entry: RaftLogEntry): Promise<boolean> {
    if (!entry.prevHash || !entry.entryHash) return true;

    // PATCH A — Log Matching Property (Raft core invariant):
    // If two logs contain an entry with the same index and term,
    // then the logs are identical in all entries up through the given index.
    // Biz bunu hash-chain ile enforce ediyoruz:
    // prevHash, bir onceki entry'nin entryHash'i olmali.
    const prevEntry    = this.log.findLast((e) => e.index === entry.index - 1);
    const expectedPrev = prevEntry?.entryHash ?? "0".repeat(64);

    if (entry.prevHash !== expectedPrev) {
      this.logger?.warn(
        `[FAZ2] Log Matching violation: index=${entry.index} ` +
        `prevHash mismatch (expected ${expectedPrev.slice(0,8)}... got ${entry.prevHash.slice(0,8)}...)`
      );
      return false;
    }

    const expectedHash = await sha256Hex(entry.prevHash + entry.checksum);
    if (expectedHash !== entry.entryHash) {
      this.logger?.warn(`[FAZ2] Hash integrity failure: index=${entry.index}`);
      return false;
    }

    return true;
  }

  // ─── RPC Alıcı ───────────────────────────────────────────────────────────

  async handleRpc(rpc: RaftRPC, fromNodeId: string): Promise<void> {
    if (!this._running) return;

    if ("term" in rpc && rpc.term > this.currentTerm) {
      this._becomeFollower(rpc.term, null);
    }

    switch (rpc.type) {
      case "request_vote":    await this._handleRequestVote(rpc, fromNodeId);   break;
      case "vote_response":   await this._handleVoteResponse(rpc, fromNodeId);  break;
      case "append_entries":  await this._handleAppendEntries(rpc, fromNodeId); break;
      case "append_response": await this._handleAppendResponse(rpc, fromNodeId);break;
    }
  }

  // ─── Durum ───────────────────────────────────────────────────────────────

  state(): ConsensusState {
    return {
      nodeId: this.nodeId, role: this.role, currentTerm: this.currentTerm,
      votedFor: this.votedFor, leaderId: this.leaderId,
      commitIndex: this.commitIndex, lastApplied: this.lastApplied,
      logLength: this.log.length,
    };
  }

  metrics(): ConsensusMetrics {
    const avg = this.commitTimes.length > 0
      ? this.commitTimes.reduce((a,b)=>a+b,0)/this.commitTimes.length : 0;
    return {
      term: this.currentTerm, role: this.role, logLength: this.log.length,
      commitIndex: this.commitIndex, electionCount: this.electionCount,
      leaderChanges: this.leaderChanges, avgCommitMs: Math.round(avg),
      pendingEntries: this.log.length - (this.commitIndex + 1),
    };
  }

  isLeader():    boolean       { return this.role === "leader"; }
  getLeaderId(): string|null   { return this.leaderId; }
  getRole():     NodeRole      { return this.role; }
  getTerm():     Term          { return this.currentTerm; }
  getLog():      RaftLogEntry[]{ return [...this.log]; }

  restoreLog(entries: RaftLogEntry[], term: Term): void {
    this.log         = entries;
    this.currentTerm = term;
    this.commitIndex = entries.length - 1;
    this.lastApplied = entries.length - 1;
  }

  // ─── Compaction ──────────────────────────────────────────────────────────

  /**
   * Log'u güvenle kısalt.
   * Aşama 18: IncrementalLogCompactor varsa truncate() ile gerçek kesme yapılır
   * (yalnızca commitIndex'e kadar, retainTail kadar son girdi korunur).
   * NoopLogCompactor (Aşama 15 varsayılanı) ile geriye dönük uyumlu kalır.
   */
  async compact(upToIndex: LogIndex): Promise<void> {
    // IncrementalLogCompactor mı yoksa basit ILogCompactor mı?
    const maybeTruncate = (this.compactor as { truncate?: typeof this._truncateViaCompactor }).truncate;

    if (typeof maybeTruncate === "function") {
      // Gerçek compactor: kendi güvenlik mantığı (retainTail) ile kessin
      await this._truncateViaCompactor();
    } else {
      // Basit/Noop compactor: eski davranış korunur
      await this.compactor.compact(upToIndex);
      if (upToIndex >= 0 && upToIndex < this.log.length) {
        this.log = this.log.slice(upToIndex + 1);
        this.logger?.info(`Log compaction: [0..${upToIndex}] kısaltıldı`);
      }
    }
  }

  /** IncrementalLogCompactor.truncate() ile güvenli kesme (yalnızca tip uyumluysa çağrılır) */
  private async _truncateViaCompactor(): Promise<void> {
    const compactor = this.compactor as unknown as {
      truncate(log: RaftLogEntry[], commitIndex: LogIndex): Promise<{ newLog: RaftLogEntry[] }>;
      shouldTrigger?(logLength: number, commitIndex: LogIndex): boolean;
    };

    const { newLog } = await compactor.truncate(this.log, this.commitIndex);
    this.log = newLog;
  }

  /**
   * Otomatik compaction kontrolü — her commit sonrası çağrılabilir.
   * Politika (shouldTrigger) sağlanmıyorsa hiçbir şey yapmaz.
   */
  private async _maybeAutoCompact(): Promise<void> {
    const compactor = this.compactor as unknown as {
      shouldTrigger?(logLength: number, commitIndex: LogIndex): boolean;
    };
    if (typeof compactor.shouldTrigger === "function" &&
        compactor.shouldTrigger(this.log.length, this.commitIndex)) {
      await this.compact(this.commitIndex);
    }
  }

  // ─── Election ────────────────────────────────────────────────────────────

  private _electionTimeout(): number {
    if (this.cfg.deterministicTimeout) {
      return deterministicElectionTimeout(
        this.nodeId,
        this.cfg.electionTimeoutMinMs,
        this.cfg.electionTimeoutMaxMs,
        this.electionAttempt
      );
    }
    return this.cfg.electionTimeoutMinMs +
      Math.floor(Math.random() * (this.cfg.electionTimeoutMaxMs - this.cfg.electionTimeoutMinMs));
  }

  private _resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (!this._running) return;
    this.electionTimer = setTimeout(() => this._startElection(), this._electionTimeout());
  }

  private async _startElection(): Promise<void> {
    if (!this._running) return;
    this.currentTerm++;
    this.role           = "candidate";
    this.votedFor       = this.nodeId;
    this.votesReceived  = new Set([this.nodeId]);
    this.electionCount++;
    this.electionAttempt++;

    this.logger?.info(`Seçim: ${this.nodeId} (term ${this.currentTerm}, attempt ${this.electionAttempt})`);

    const last = this.log.at(-1);
    const rpc: RequestVoteRPC = {
      type: "request_vote", term: this.currentTerm,
      candidateId: this.nodeId,
      lastLogIndex: last?.index ?? -1, lastLogTerm: last?.term ?? -1,
    };

    await Promise.all(this.peers.map((p) => this.sendRpc(p, rpc, "consensus")));
    this._resetElectionTimer();
  }

  private async _handleRequestVote(rpc: RequestVoteRPC, from: string): Promise<void> {
    let granted = false;
    if (rpc.term >= this.currentTerm &&
        (this.votedFor === null || this.votedFor === rpc.candidateId) &&
        this._isLogUpToDate(rpc.lastLogIndex, rpc.lastLogTerm)) {
      granted      = true;
      this.votedFor = rpc.candidateId;
      this._resetElectionTimer();
    }
    await this.sendRpc(from, {
      type: "vote_response", term: this.currentTerm,
      voteGranted: granted, voterId: this.nodeId,
    }, "consensus");
  }

  private async _handleVoteResponse(rpc: RequestVoteResponse, _from: string): Promise<void> {
    if (this.role !== "candidate" || rpc.term !== this.currentTerm) return;
    if (!rpc.voteGranted) return;
    this.votesReceived.add(rpc.voterId);
    const majority = Math.floor(this.cfg.clusterSize / 2) + 1;
    if (this.votesReceived.size >= majority) await this._becomeLeader();
  }

  // ─── Leader ──────────────────────────────────────────────────────────────

  private async _becomeLeader(): Promise<void> {
    this.role           = "leader";
    this.leaderId       = this.nodeId;
    this.electionAttempt = 0;
    this.leaderChanges++;

    for (const p of this.peers) {
      this.nextIndex.set(p,  this.log.length);
      this.matchIndex.set(p, -1);
    }

    this.logger?.info(`Lider: ${this.nodeId} (term ${this.currentTerm})`);
    await this.propose({ type: "noop", payload: {} });

    this._clearTimers();
    this.heartbeatTimer = setInterval(() => this._sendAppendEntries(), this.cfg.heartbeatIntervalMs);
  }

  /**
   * FAZ 4 Hardening — Split-brain detection
   * Baska bir lider gorursek, term esit veya buyukse follower ol.
   * Bu _checkStaleLeader ile cakismaz:
   *   _checkStaleLeader: kendi term'imiz kucukse follower ol
   *   _detectSplitBrain: ayni term'de baska lider gorursek follower ol
   */
  private _detectSplitBrain(remoteTerm: Term, remoteLeaderId: string): boolean {
    if (
      this.role === "leader" &&
      remoteTerm === this.currentTerm &&
      remoteLeaderId !== this.nodeId
    ) {
      // Ayni term'de iki lider — split-brain!
      this.logger?.warn(
        `[SPLIT-BRAIN] term=${this.currentTerm} ` +
        `iki lider: ${this.nodeId} ve ${remoteLeaderId} — follower olunuyor`
      );
      this._becomeFollower(this.currentTerm + 1, remoteLeaderId);
      return true;
    }
    return false;
  }

  private _becomeFollower(term: Term, leaderId: string|null): void {
    const wasLeader = this.role === "leader";
    this.role        = "follower";
    this.currentTerm = term;
    this.votedFor    = null;
    this.leaderId    = leaderId;
    if (wasLeader) this._clearTimers();
    this._resetElectionTimer();
  }

  /**
   * Aşama 18 düzeltmesi: nextIdx artık dizi pozisyonu değil entry.index
   * olarak yorumlanır. _findByIndex() ve _sliceFromIndex() compaction
   * sonrası kısalmış log'da da doğru çalışır.
   */
  private async _sendAppendEntries(): Promise<void> {
    if (this.role !== "leader" || !this._running) return;

    await Promise.all(this.peers.map(async (peer) => {
      const nextIdx   = this.nextIndex.get(peer) ?? 0;
      const prevIndex = nextIdx - 1;
      const prevEntry = prevIndex >= 0 ? this._findByIndex(prevIndex) : null;

      const rpc: AppendEntriesRPC = {
        type: "append_entries", term: this.currentTerm, leaderId: this.nodeId,
        prevLogIndex: prevIndex, prevLogTerm: prevEntry?.term ?? -1,
        entries: this._sliceFromIndex(nextIdx), leaderCommit: this.commitIndex,
      };
      await this.sendRpc(peer, rpc, "consensus");
    }));
  }

  /** entry.index >= fromIndex olan tüm girdiler (dizi pozisyonu değil, index alanına göre) */
  private _sliceFromIndex(fromIndex: LogIndex): RaftLogEntry[] {
    return this.log.filter((e) => e.index >= fromIndex);
  }

  // ─── AppendEntries ────────────────────────────────────────────────────────

  private async _handleAppendEntries(rpc: AppendEntriesRPC, from: string): Promise<void> {
    this._resetElectionTimer();

    // FAZ 2.1 — Stale leader rejection
    if (this._checkStaleLeader(rpc.term, rpc.leaderId)) {
      // _becomeFollower zaten çağrıldı — tekrar işle
    }

    // FAZ 4 — Split-brain detection (ayni term'de baska lider)
    if (rpc.leaderId && this._detectSplitBrain(rpc.term, rpc.leaderId)) {
      // Follower olduk — devam et
    }

    if (rpc.term < this.currentTerm) {
      await this.sendRpc(from, {
        type: "append_response", term: this.currentTerm,
        success: false, matchIndex: -1, nodeId: this.nodeId,
      }, "consensus");
      return;
    }

    this._becomeFollower(rpc.term, rpc.leaderId);

    if (rpc.prevLogIndex >= 0) {
      const prev = this._findByIndex(rpc.prevLogIndex);
      const alreadyCompacted = rpc.prevLogIndex <= this._compactedUpTo();
      if (!alreadyCompacted && (!prev || prev.term !== rpc.prevLogTerm)) {
        await this.sendRpc(from, {
          type: "append_response", term: this.currentTerm,
          success: false, matchIndex: this.log.at(-1)?.index ?? -1, nodeId: this.nodeId,
        }, "consensus");
        return;
      }
    }

    for (let i = 0; i < rpc.entries.length; i++) {
      const entry   = rpc.entries[i];

      // FAZ 2.2 — Hash-chain doğrulama
      const hashOk = await this._verifyHashChain(entry);
      if (!hashOk) {
        this.logger?.warn(`[FAZ2] Tutarsız log reddedildi: index=${entry.index}`);
        await this.sendRpc(from, {
          type: "append_response", term: this.currentTerm,
          success: false, matchIndex: this.log.at(-1)?.index ?? -1, nodeId: this.nodeId,
        }, "consensus");
        return;
      }

      const existIdx = this.log.findIndex((e) => e.index === entry.index);
      if (existIdx >= 0) {
        if (this.log[existIdx].term !== entry.term) {
          this.log = this.log.slice(0, existIdx);
          this.log.push(entry);
        }
      } else {
        this.log.push(entry);
      }
    }

    // FAZ 2.3 — commitIndex asla geri gitmez
    if (rpc.leaderCommit > this.commitIndex) {
      const lastIdx = this.log.at(-1)?.index ?? -1;
      this._safeSetCommitIndex(Math.min(rpc.leaderCommit, lastIdx));
      await this._applyCommitted();
    }

    await this.sendRpc(from, {
      type: "append_response", term: this.currentTerm,
      success: true, matchIndex: this.log.at(-1)?.index ?? -1, nodeId: this.nodeId,
    }, "consensus");
  }

  /** Compactor'ın en son kestiği index — AppendEntries uyumluluk kontrolü için */
  private _compactedUpTo(): LogIndex {
    const compactor = this.compactor as unknown as { lastCompacted?: () => LogIndex };
    return typeof compactor.lastCompacted === "function" ? compactor.lastCompacted() : -1;
  }

  private async _handleAppendResponse(rpc: AppendEntriesResponse, from: string): Promise<void> {
    if (this.role !== "leader") return;
    if (rpc.success) {
      this.matchIndex.set(from, rpc.matchIndex);
      this.nextIndex.set(from, rpc.matchIndex + 1);
      await this._maybeCommit();
    } else {
      const next = (this.nextIndex.get(from) ?? 1) - 1;
      this.nextIndex.set(from, Math.max(0, next));
    }
  }

  // ─── Commit ──────────────────────────────────────────────────────────────

  /**
   * Aşama 18 düzeltmesi: `n` artık dizi pozisyonu değil entry.index değeridir.
   * Compaction sonrası log.length ile en yüksek index eşleşmeyebilir
   * (log kısalmış olabilir) — bu yüzden this.log.at(-1).index kullanılır.
   */
  private async _maybeCommit(): Promise<void> {
    if (this.role !== "leader") return;
    const majority = Math.floor(this.cfg.clusterSize / 2) + 1;
    const highestIndex = this.log.at(-1)?.index ?? -1;

    for (let n = highestIndex; n > this.commitIndex; n--) {
      const entry = this._findByIndex(n);
      if (!entry || entry.term !== this.currentTerm) continue;
      let count = 1;
      for (const [, m] of this.matchIndex) { if (m >= n) count++; }
      if (count >= majority) {
        const t0 = Date.now();
        // FAZ 2.3 — commitIndex asla geri gitmez
        if (!this._safeSetCommitIndex(n)) break;
        await this._applyCommitted();
        this.commitTimes.push(Date.now() - t0);
        if (this.commitTimes.length > 100) this.commitTimes.shift();
        break;
      }
    }
  }

  /**
   * Commit edilen girdileri sırayla uygula.
   *
   * Aşama 18 düzeltmesi: this.log[this.lastApplied] dizi POZİSYONU ile
   * erişiyordu — compaction sonrası log kısaldığında bu pozisyon artık
   * entry.index ile eşleşmez (örn. log[0].index artık 0 değil, 1000 olabilir).
   * _findByIndex() ile entry.index alanına göre arama yapılır — compaction
   * sonrasında da doğru çalışır.
   */
  private async _applyCommitted(): Promise<void> {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this._findByIndex(this.lastApplied);
      if (entry) await this.applyCmd(entry.command, this.lastApplied);
    }
    // Her commit turundan sonra otomatik compaction politikasını kontrol et
    await this._maybeAutoCompact();
  }

  /** Log içinde entry.index alanına göre ara (dizi pozisyonu değil — compaction güvenli) */
  private _findByIndex(index: LogIndex): RaftLogEntry | undefined {
    // Çoğunlukla log[0].index ile index arasındaki fark sabittir (compaction yoksa 0)
    // ama compaction sonrası fark değişebilir; bu yüzden lineer/offset araması yapılır.
    if (this.log.length === 0) return undefined;
    const firstIndex = this.log[0].index;
    const pos = index - firstIndex;
    if (pos >= 0 && pos < this.log.length && this.log[pos].index === index) {
      return this.log[pos];
    }
    // Offset varsayımı tutmazsa (örn. ara silme), güvenli fallback: lineer arama
    return this.log.find((e) => e.index === index);
  }

  private _isLogUpToDate(lastIdx: LogIndex, lastTerm: Term): boolean {
    const our = this.log.at(-1);
    if (!our)                return true;
    if (lastTerm > our.term) return true;
    if (lastTerm < our.term) return false;
    return lastIdx >= our.index;
  }

  private _clearTimers(): void {
    if (this.electionTimer)  clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.electionTimer = this.heartbeatTimer = undefined;
  }
}
