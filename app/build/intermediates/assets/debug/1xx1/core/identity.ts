/**
 * 1XX1 Node Identity
 * FAZ 0.1 — Node Identity Standardizasyonu
 *
 * Her node kimliği:
 *   nodeId = base58(SHA-256(publicKey DER))
 *   Kalici: ~/.x1/identity.key
 *   Private key asla network'e cikmaz
 */

import * as fs         from "node:fs";
import * as path       from "node:path";
import * as nodeCrypto from "node:crypto";

// ─── Base58 (dis bagimlilik yok) ──────────────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(buf: Uint8Array): string {
  const bytes = Array.from(buf);
  let leading = 0;
  for (const b of bytes) { if (b === 0) leading++; else break; }
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = "";
  while (num > 0n) {
    result = B58[Number(num % 58n)] + result;
    num /= 58n;
  }
  return "1".repeat(leading) + result;
}

// ─── nodeId Turetme ───────────────────────────────────────────────────────────

export function deriveNodeId(publicKeyDer: Buffer): string {
  const hash = nodeCrypto.createHash("sha256").update(publicKeyDer).digest();
  return base58Encode(hash);
}

// ─── Kimlik Tipi ──────────────────────────────────────────────────────────────

export interface NodeIdentity {
  nodeId:        string;
  publicKeyB64:  string;
  privateKeyB64: string;
  algorithm:     "ed25519";
  createdAt:     number;
}

// ─── Disk Islemleri ───────────────────────────────────────────────────────────

const IDENTITY_DIR  = path.join(process.env.HOME ?? ".", ".x1");
const IDENTITY_FILE = path.join(IDENTITY_DIR, "identity.key");

export function loadIdentity(): NodeIdentity | null {
  try {
    if (!fs.existsSync(IDENTITY_FILE)) return null;
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as NodeIdentity;
  } catch { return null; }
}

export function saveIdentity(id: NodeIdentity): void {
  if (!fs.existsSync(IDENTITY_DIR)) fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(id, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function generateIdentity(): NodeIdentity {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding:  { type: "spki",  format: "der" },
  });
  const pubBuf = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey as any);
  const prvBuf = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey as any);
  const id: NodeIdentity = {
    nodeId:        deriveNodeId(pubBuf),
    publicKeyB64:  pubBuf.toString("base64"),
    privateKeyB64: prvBuf.toString("base64"),
    algorithm:     "ed25519",
    createdAt:     Date.now(),
  };
  saveIdentity(id);
  return id;
}

export function resolveIdentity(): NodeIdentity {
  return loadIdentity() ?? generateIdentity();
}

export function signData(id: NodeIdentity, data: Buffer): string {
  const key = nodeCrypto.createPrivateKey({
    key: Buffer.from(id.privateKeyB64, "base64"), format: "der", type: "pkcs8",
  });
  return nodeCrypto.sign(null, data, key).toString("base64");
}

export function verifySignature(publicKeyB64: string, data: Buffer, sigB64: string): boolean {
  try {
    const key = nodeCrypto.createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki",
    });
    return nodeCrypto.verify(null, data, key, Buffer.from(sigB64, "base64"));
  } catch { return false; }
}
