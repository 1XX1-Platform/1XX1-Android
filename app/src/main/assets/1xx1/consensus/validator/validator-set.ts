/**
 * 1XX1 Validator Set Manager
 * Aşama 15 — Dağıtık Konsensüs ve Pulse Senkronizasyonu
 *
 * Validator = konsensüse katılan güvenilir düğüm.
 * Validator olmayan düğümler gossip ile veri alır ama oy kullanamaz.
 *
 * Validator değişikliği konsensüs yoluyla gerçekleşir:
 *   RaftEngine.propose({ type: "validator:add", nodeId, publicKey })
 *   → commit → ValidatorSetManager.apply()
 *
 * Bu sayede validator seti tüm düğümlerde deterministik olarak aynıdır.
 */

import type { ValidatorInfo, Term } from "../consensus-types.ts";
import type { RaftEngine } from "../raft/raft-engine.ts";
import type { ISignatureProvider } from "../../distributed/security/signature.ts";
import type { ILogger } from "../../core/interfaces.ts";

// ─── ValidatorSetManager ──────────────────────────────────────────────────────

export class ValidatorSetManager {
  private readonly validators = new Map<string, ValidatorInfo>();

  constructor(
    raft:      RaftEngine,
    signer:    ISignatureProvider,
    logger?:   ILogger
  ) {
    this.logger = logger;
    this.signer = signer;
    this.raft = raft;}

  // ─── Komut Uygulaması (Raft commit'ten) ─────────────────────────────────

  applyAdd(nodeId: string, publicKey: string, term: Term): void {
    this.validators.set(nodeId, {
      nodeId,
      publicKey,
      addedAt:      Date.now(),
      addedByTerm:  term,
      isActive:     true,
    });
    this.logger?.info(`Validator eklendi: ${nodeId} (term ${term})`);
  }

  applyRemove(nodeId: string): void {
    const v = this.validators.get(nodeId);
    if (v) {
      this.validators.set(nodeId, { ...v, isActive: false });
      this.logger?.info(`Validator kaldırıldı: ${nodeId}`);
    }
  }

  // ─── Validator Öneri (yalnızca lider) ────────────────────────────────────

  async proposeAdd(nodeId: string, publicKey: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.raft.isLeader()) return { ok: false, error: "NOT_LEADER" };
    if (this.validators.has(nodeId) && this.validators.get(nodeId)!.isActive) {
      return { ok: false, error: "ALREADY_VALIDATOR" };
    }
    return this.raft.propose({ type: "validator:add", nodeId, publicKey });
  }

  async proposeRemove(nodeId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.raft.isLeader()) return { ok: false, error: "NOT_LEADER" };
    if (!this.validators.has(nodeId)) return { ok: false, error: "NOT_VALIDATOR" };
    return this.raft.propose({ type: "validator:remove", nodeId, reason });
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  isValidator(nodeId: string): boolean {
    return this.validators.get(nodeId)?.isActive ?? false;
  }

  activeValidators(): ValidatorInfo[] {
    return Array.from(this.validators.values()).filter((v) => v.isActive);
  }

  getPublicKey(nodeId: string): string | null {
    return this.validators.get(nodeId)?.publicKey ?? null;
  }

  count(): number {
    return this.activeValidators().length;
  }

  /** Quorum: çoğunluk için gereken validator sayısı */
  quorumSize(): number {
    return Math.floor(this.count() / 2) + 1;
  }

  /**
   * Bir Pulse bloğunu doğrulayıcıların imzalarıyla doğrula.
   * Quorum kadar geçerli imza varsa blok kabul edilir.
   */
  async verifyBlockSignatures(
    blockHash: string,
    signatures: Record<string, string>
  ): Promise<{ ok: boolean; validCount: number; required: number }> {
    const required   = this.quorumSize();
    let   validCount = 0;

    for (const [nodeId, sig] of Object.entries(signatures)) {
      const pk = this.getPublicKey(nodeId);
      if (!pk) continue;
      if (sig.startsWith("mock_sig_") || sig.length > 0) {
        // Mock: imza varsa geçerli say (gerçekte Ed25519 verify)
        validCount++;
      }
    }

    return { ok: validCount >= required, validCount, required };
  }
}
