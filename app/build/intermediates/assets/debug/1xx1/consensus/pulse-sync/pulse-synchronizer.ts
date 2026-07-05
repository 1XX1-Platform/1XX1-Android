/**
 * 1XX1 Pulse Senkronizasyonu
 * Aşama 15 — Dağıtık Konsensüs ve Pulse Senkronizasyonu
 *
 * Pulse Engine (Aşama 10) tek bir düğümde çalışır.
 * Bu katman lider düğümün Pulse sonucunu tüm ağa konsensüsle yayar.
 *
 * Akış:
 *   PulseScheduler.tick() → lider RaftEngine.propose(pulse:commit) →
 *   Çoğunluk onayı → applyCmd → PulseBlock oluştur →
 *   PulseStore'a yaz → Gossip ile yay → Tüm düğümler aynı bloğu görür
 *
 * Garanti: Bir Pulse bloğu commit edildiğinde tüm dürüst düğümler aynı
 * sıralamayı görür — deterministik.
 */

import type { PulseEntry, PulseSnapshot } from "../../pulse/pulse-types.ts";
import type { PulseBlock, Term, LogIndex } from "../consensus-types.ts";
import type { RaftEngine } from "../raft/raft-engine.ts";
import type { NodeRuntime } from "../../distributed/node/node-runtime.ts";
import type { ILogger } from "../../core/interfaces.ts";
import { sha256Hex } from "../../distributed/security/signature.ts";

// ─── Pulse Block Chain ───────────────────────────────────────────────────────

export class PulseBlockChain {
  private readonly chain: PulseBlock[] = [];
  private readonly MAX_CHAIN = 1000; // son N blok in-memory

  /** Yeni blok ekle */
  append(block: PulseBlock): void {
    this.chain.push(block);
    if (this.chain.length > this.MAX_CHAIN) this.chain.shift();
  }

  /** En son blok */
  latest(): PulseBlock | null {
    return this.chain.at(-1) ?? null;
  }

  /** Pulse numarasına göre bul */
  findByPulse(pulseNumber: number): PulseBlock | null {
    return this.chain.findLast((b) => b.pulseNumber === pulseNumber) ?? null;
  }

  /** Zincir bütünlüğü doğrula */
  async verify(): Promise<{ ok: boolean; brokenAt?: number }> {
    for (let i = 1; i < this.chain.length; i++) {
      const prev = this.chain[i - 1];
      const curr = this.chain[i];
      if (curr.prevBlockHash !== prev.blockHash) {
        return { ok: false, brokenAt: i };
      }
    }
    return { ok: true };
  }

  /** Blok hash'i üret (deterministik) */
  static async computeBlockHash(block: Omit<PulseBlock, "blockHash">): Promise<string> {
    const input = JSON.stringify({
      pulseNumber:   block.pulseNumber,
      prevBlockHash: block.prevBlockHash,
      logIndex:      block.logIndex,
      term:          block.term,
      leaderId:      block.leaderId,
      entryCount:    block.entries.length,
      // Sıralı entry hash'leri (tüm veriyi değil özeti)
      topThree:      block.entries.slice(0, 3).map((e) => `${e.projectId}:${e.rank}:${e.score}`),
    });
    return sha256Hex(input);
  }

  length(): number { return this.chain.length; }
  all(): PulseBlock[] { return [...this.chain]; }
}

// ─── PulseSynchronizer ───────────────────────────────────────────────────────

export class PulseSynchronizer {
  readonly chain = new PulseBlockChain();

  constructor(
    raft:    RaftEngine,
    runtime: NodeRuntime,
    logger?: ILogger
  ) {
    this.logger = logger;
    this.runtime = runtime;
    this.raft = raft;}

  /**
   * Pulse snapshot'ını konsensüse gönder (yalnızca lider çağırır).
   * Çoğunluk onayından sonra applyPulseCommit() çağrılır.
   */
  async proposePulse(snapshot: PulseSnapshot): Promise<{ ok: boolean; error?: string }> {
    if (!this.raft.isLeader()) {
      return { ok: false, error: "NOT_LEADER" };
    }

    // Fairness snapshot'ını özet hash'e çevir (tüm veriyi log'a yazmak yerine)
    const fairnessHash = await sha256Hex(
      snapshot.entries.map((e) => `${e.projectId}:${e.score}:${e.fairness}`).join("|")
    );

    const result = await this.raft.propose({
      type:             "pulse:commit",
      pulseNumber:      snapshot.pulseNumber,
      entries:          snapshot.entries,
      fairnessSnapshot: fairnessHash,
    });

    if (result.ok) {
      this.logger?.info(`Pulse önerildi: #${snapshot.pulseNumber} (${snapshot.entries.length} proje)`);
    }
    return result;
  }

  /**
   * Raft log'undan commit edilen pulse komutunu uygula.
   * Bu metot tüm düğümlerde aynı sırayla çağrılır → determinizm.
   */
  async applyPulseCommit(
    pulseNumber: number,
    entries:     PulseEntry[],
    logIndex:    LogIndex,
    term:        Term
  ): Promise<PulseBlock> {
    const prev     = this.chain.latest();
    const prevHash = prev?.blockHash ?? "0".repeat(64);
    const leaderId = this.raft.getLeaderId() ?? this.runtime.nodeId;

    const blockWithoutHash: Omit<PulseBlock, "blockHash"> = {
      blockId:       `blk_${pulseNumber}_${term}`,
      pulseNumber,
      prevBlockHash: prevHash,
      logIndex,
      term,
      leaderId,
      entries,
      totalProjects: entries.length,
      rotated:       entries.filter((e) => e.demoted).map((e) => e.projectId),
      timestamp:     Date.now(),
      signatures:    {},
    };

    const blockHash = await PulseBlockChain.computeBlockHash(blockWithoutHash);
    const block: PulseBlock = { ...blockWithoutHash, blockHash };

    this.chain.append(block);

    // NodeRuntime'ın pulse store'una yaz
    const sig = await this.runtime["signer"].sign(
      new TextEncoder().encode(blockHash)
    );
    await this.runtime.stores.pulse.put(
      `block:${pulseNumber}`,
      block,
      this.runtime.nodeId,
      logIndex,
      sig
    );

    this.logger?.info(
      `Pulse commit: #${pulseNumber} → blok ${blockHash.slice(0, 12)}... ` +
      `(${entries.length} proje, term ${term})`
    );

    return block;
  }

  /**
   * Düğüm yeniden başlatıldığında zinciri gossip üzerinden geri yükle.
   */
  async syncFromPeers(): Promise<number> {
    const storeEntries = this.runtime.stores.pulse.all();
    let loaded = 0;

    const blocks = storeEntries
      .filter((e) => e.key.startsWith("block:"))
      .map((e) => e.value as PulseBlock)
      .sort((a, b) => a.pulseNumber - b.pulseNumber);

    for (const block of blocks) {
      this.chain.append(block);
      loaded++;
    }

    this.logger?.info(`Pulse zinciri yüklendi: ${loaded} blok`);
    return loaded;
  }

  /** Pulse numarasına göre blok sorgula */
  getBlock(pulseNumber: number): PulseBlock | null {
    return this.chain.findByPulse(pulseNumber);
  }

  /** En son Pulse listesi (tüm düğümlerde aynı) */
  currentEntries(): PulseEntry[] {
    return this.chain.latest()?.entries ?? [];
  }

  chainStats() {
    return {
      length:       this.chain.length(),
      latestPulse:  this.chain.latest()?.pulseNumber ?? -1,
      latestHash:   this.chain.latest()?.blockHash.slice(0, 16) ?? "none",
    };
  }
}
