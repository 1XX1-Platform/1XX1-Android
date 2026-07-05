/**
 * 1XX1 ConsensusNode — Konsensüs Orkestratörü
 * Aşama 15
 *
 * NodeRuntime (Aşama 14) üzerine konsensüs katmanı ekler.
 * Raft + PulseSynchronizer + ValidatorSet birleştirir.
 *
 * Entegrasyon:
 *   ConsensusNode → NodeRuntime.stores.pulse (Pulse blokları)
 *   ConsensusNode → PulseScheduler (Pulse sonuçlarını al)
 *   ConsensusNode → RaftEngine (konsensüs)
 *   ConsensusNode → ValidatorSetManager (kim oy kullanabilir)
 */

import { RaftEngine } from "../raft/raft-engine.ts";
import { PulseSynchronizer } from "../pulse-sync/pulse-synchronizer.ts";
import { ValidatorSetManager } from "../validator/validator-set.ts";
import type { NodeRuntime } from "../../distributed/node/node-runtime.ts";
import type { PulseSnapshot } from "../../pulse/pulse-types.ts";
import type { ConsensusCommand, LogIndex, ConsensusState } from "../consensus-types.ts";
import type { RaftRPC } from "../consensus-types.ts";
import type { MessageEnvelope } from "../../distributed/envelope/message-envelope.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { createEnvelope } from "../../distributed/envelope/message-envelope.ts";
import { computePayloadChecksum } from "../../distributed/security/signature.ts";

// ─── ConsensusNode Config ─────────────────────────────────────────────────────

export interface ConsensusNodeConfig {
  /** Validator olarak başlasın mı? */
  bootstrapAsValidator: boolean;
  /** İlk validator seti (bootstrap) */
  initialValidators:    Array<{ nodeId: string; publicKey: string }>;
  /** Raft timeout'ları */
  electionTimeoutMinMs: number;
  electionTimeoutMaxMs: number;
  heartbeatIntervalMs:  number;
}

const DEFAULT_CONSENSUS_CONFIG: ConsensusNodeConfig = {
  bootstrapAsValidator: true,
  initialValidators:    [],
  electionTimeoutMinMs: 150,
  electionTimeoutMaxMs: 300,
  heartbeatIntervalMs:  50,
};

// ─── ConsensusNode ────────────────────────────────────────────────────────────

export class ConsensusNode {
  readonly raft:       RaftEngine;
  readonly pulseSync:  PulseSynchronizer;
  readonly validators: ValidatorSetManager;

  private _running = false;

  constructor(
    runtime: NodeRuntime,
    peers: string[],
    cfg:   Partial<ConsensusNodeConfig> = {},
    logger?: ILogger
  ) {
    this.logger = logger;
    this.peers = peers;
    this.runtime = runtime;
    const fullCfg = { ...DEFAULT_CONSENSUS_CONFIG, ...cfg };

    // Raft RPC gönderici: NodeRuntime.transport üzerinden
    const sendRpc = async (toNodeId: string, rpc: RaftRPC): Promise<void> => {
      const checksum = await computePayloadChecksum(rpc);
      const sig      = await runtime["signer"].sign(
        new TextEncoder().encode(JSON.stringify(rpc))
      );
      const env = createEnvelope({
        senderNodeId:  runtime.nodeId,
        messageType:   "sync:request",
        topic:         "system",
        logicalClock:  runtime.clock.tick(),
        ttl:           1, // Raft mesajları yayılmaz, direkt gönderilir
        payload:       { _raft: true, rpc },
        checksum,
        signature:     sig,
      });
      await runtime["transport"].send(toNodeId, env);
    };

    // Raft komut uygulayıcısı
    const applyCmd = async (cmd: ConsensusCommand, index: LogIndex): Promise<void> => {
      await this._applyCommand(cmd, index);
    };

    this.raft = new RaftEngine(
      runtime.nodeId,
      peers,
      sendRpc,
      applyCmd,
      {
        electionTimeoutMinMs: fullCfg.electionTimeoutMinMs,
        electionTimeoutMaxMs: fullCfg.electionTimeoutMaxMs,
        heartbeatIntervalMs:  fullCfg.heartbeatIntervalMs,
        clusterSize:          peers.length + 1,
      },
      logger
    );

    this.pulseSync  = new PulseSynchronizer(this.raft, runtime, logger);
    this.validators = new ValidatorSetManager(this.raft, runtime["signer"], logger);

    // Bootstrap validators
    for (const v of fullCfg.initialValidators) {
      this.validators.applyAdd(v.nodeId, v.publicKey, 0);
    }

    // NodeRuntime gelen Raft mesajlarını yönlendir
    this._setupMessageHandler();
  }

  // ─── Yaşam Döngüsü ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.raft.start();
    await this.pulseSync.syncFromPeers();
    this.logger?.info(`ConsensusNode başladı: ${this.runtime.nodeId}`);
  }

  async stop(): Promise<void> {
    this._running = false;
    this.raft.stop();
  }

  isRunning():  boolean { return this._running; }
  isLeader():   boolean { return this.raft.isLeader(); }

  // ─── Pulse Commit API ────────────────────────────────────────────────────

  /**
   * Pulse Engine'den gelen snapshot'ı konsensüse gönder.
   * Yalnızca lider düğüm çağırır; diğerleri Raft üzerinden alır.
   */
  async commitPulse(snapshot: PulseSnapshot): Promise<{ ok: boolean; error?: string }> {
    return this.pulseSync.proposePulse(snapshot);
  }

  // ─── Komut Uygulaması ────────────────────────────────────────────────────

  private async _applyCommand(cmd: ConsensusCommand, index: LogIndex): Promise<void> {
    switch (cmd.type) {
      case "pulse:commit":
        await this.pulseSync.applyPulseCommit(
          cmd.pulseNumber,
          cmd.entries,
          index,
          this.raft.getTerm()
        );
        break;

      case "pulse:penalty":
        // PulseScheduler'a ceza bildir (runtime event bus üzerinden)
        this.runtime["eventBus"]?.emit("pulse:penalty" as never, {
          projectId: cmd.projectId,
          amount:    cmd.amount,
          reason:    cmd.reason,
        });
        break;

      case "validator:add":
        this.validators.applyAdd(cmd.nodeId, cmd.publicKey, this.raft.getTerm());
        break;

      case "validator:remove":
        this.validators.applyRemove(cmd.nodeId);
        break;

      case "policy:update":
        await this.runtime.stores.policies.put(
          cmd.policyId,
          cmd.payload,
          this.runtime.nodeId,
          index,
          "consensus"
        );
        break;

      case "noop":
        // lider seçimi sonrası boş komut — hiçbir şey yapma
        break;
    }
  }

  // ─── Raft Mesaj Yönlendirme ───────────────────────────────────────────────

  private _setupMessageHandler(): void {
    this.runtime.gossip.onMessage(async (env: MessageEnvelope) => {
      // Raft mesajları gossip üzerinden değil, direkt transport üzerinden gelir
      // Ama gossip handler'da iken _raft flag'i varsa yönlendir
      const payload = env.payload as Record<string, unknown>;
      if (payload?._raft && payload.rpc) {
        await this.raft.handleRpc(payload.rpc as RaftRPC, env.senderNodeId);
      }
    });
  }

  // ─── Durum Sorgular ──────────────────────────────────────────────────────

  consensusState(): ConsensusState { return this.raft.state(); }

  stats() {
    return {
      nodeId:    this.runtime.nodeId,
      role:      this.raft.getRole(),
      term:      this.raft.getTerm(),
      isLeader:  this.raft.isLeader(),
      leaderId:  this.raft.getLeaderId(),
      raft:      this.raft.metrics(),
      pulse:     this.pulseSync.chainStats(),
      validators: this.validators.count(),
    };
  }
}
