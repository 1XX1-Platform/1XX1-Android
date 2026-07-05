/**
 * 1XX1 Cluster Observer
 * FAZ 5 — Observability
 *
 * KURAL: Core'u sadece OKUR. Asla değiştirmez.
 *
 * Core ─────► ClusterObserver   (tek yön)
 * ClusterObserver ───X──► Core  (yasak)
 */

export interface RaftStatus {
  role:        string;
  term:        number;
  commitIndex: number;
  logLength:   number;
  leaderId:    string | null;
  peers:       string[];
  votesReceived: number;
  leaderChanges: number;
  avgCommitMs:   number;
}

export interface PeerStatus {
  nodeId:     string;
  endpoint:   string;
  lastSeen:   number;
  reputation: number;
  source:     string;
  aliveMs:    number;
}

export interface GossipStatus {
  knownPeers:   number;
  alivePeers:   number;
  seedNodes:    number;
  lastGossipMs: number;
}

export interface DHTStatus {
  routingTableSize: number;
  storeSize:        number;
  selfEndpoint:     string;
}

export interface ClusterState {
  nodeId:      string;
  role:        string;
  uptime:      number;
  version:     string;
  logicalTime: number;
  raft:        RaftStatus;
  peers:       PeerStatus[];
  gossip:      GossipStatus;
  dht:         DHTStatus;
  reputation:  { trusted: number; flagged: number };
  health:      "green" | "yellow" | "red";
  warnings:    string[];
}

export class ClusterObserver {
  private _lastGossipMs = Date.now();

  private readonly _getNodeId:      () => string;
  private readonly _getRaft:        () => { status(): { role: string; term: number; commitIndex: number; logLength: number; leaderId: string|null; peers: string[]; votesReceived: number; leaderChanges: number; commitTimes: number[]; } };
  private readonly _getPeers:       () => Array<{ nodeId: string; endpoint: string; lastSeen: number; reputation: number; source: string; }>;
  private readonly _getDHT:         () => { stats(): { routingTableSize: number; storeSize: number; selfNodeId: string } };
  private readonly _getSeedCount:   () => number;
  private readonly _getReputation:  () => { trusted: number; flagged: number };
  private readonly _getLogicalTime: () => number;

  constructor(
    getNodeId:      () => string,
    getRaft:        () => { status(): { role: string; term: number; commitIndex: number; logLength: number; leaderId: string|null; peers: string[]; votesReceived: number; leaderChanges: number; commitTimes: number[]; } },
    getPeers:       () => Array<{ nodeId: string; endpoint: string; lastSeen: number; reputation: number; source: string; }>,
    getDHT:         () => { stats(): { routingTableSize: number; storeSize: number; selfNodeId: string } },
    getSeedCount:   () => number,
    getReputation:  () => { trusted: number; flagged: number },
    getLogicalTime: () => number,
  ) {
    this._getNodeId      = getNodeId;
    this._getRaft        = getRaft;
    this._getPeers       = getPeers;
    this._getDHT         = getDHT;
    this._getSeedCount   = getSeedCount;
    this._getReputation  = getReputation;
    this._getLogicalTime = getLogicalTime;
  }

  /** /raft/status */
  raftStatus(): RaftStatus {
    const s = this._getRaft().status();
    const avgCommit = s.commitTimes?.length > 0
      ? s.commitTimes.reduce((a: number, b: number) => a + b, 0) / s.commitTimes.length
      : 0;
    return {
      role:          s.role,
      term:          s.term,
      commitIndex:   s.commitIndex,
      logLength:     s.logLength,
      leaderId:      s.leaderId,
      peers:         s.peers,
      votesReceived: s.votesReceived ?? 0,
      leaderChanges: s.leaderChanges ?? 0,
      avgCommitMs:   Math.round(avgCommit),
    };
  }

  /** /cluster/state */
  clusterState(): ClusterState {
    const raft    = this.raftStatus();
    const peers   = this._getPeers();
    const dhtInfo = this._getDHT().stats();
    const rep     = this._getReputation();
    const now     = Date.now();
    const warnings: string[] = [];

    // Uyari uret
    if (raft.role === "candidate") warnings.push("Lider secimi devam ediyor");
    if (raft.leaderChanges > 5)   warnings.push(`Yuksek lider degisim sayisi: ${raft.leaderChanges}`);
    if (peers.filter(p => now - p.lastSeen < 90_000).length === 0 && peers.length > 0) {
      warnings.push("Tum peer'lar offline gorunuyor");
    }
    if (rep.flagged > 0) warnings.push(`${rep.flagged} Sybil isaretlenmis node`);

    // Genel saglik
    const health: "green" | "yellow" | "red" =
      warnings.length === 0   ? "green" :
      warnings.length <= 2    ? "yellow" :
      "red";

    return {
      nodeId:      this._getNodeId(),
      role:        raft.role,
      uptime:      process.uptime(),
      version:     "1.0.0",
      logicalTime: this._getLogicalTime(),
      raft,
      peers: peers.map(p => ({
        ...p,
        aliveMs: now - p.lastSeen,
      })),
      gossip: {
        knownPeers:   peers.length,
        alivePeers:   peers.filter(p => now - p.lastSeen < 90_000).length,
        seedNodes:    this._getSeedCount(),
        lastGossipMs: now - this._lastGossipMs,
      },
      dht: {
        routingTableSize: dhtInfo.routingTableSize,
        storeSize:        dhtInfo.storeSize,
        selfEndpoint:     dhtInfo.selfNodeId,
      },
      reputation: rep,
      health,
      warnings,
    };
  }

  notifyGossip(): void {
    this._lastGossipMs = Date.now();
  }
}
