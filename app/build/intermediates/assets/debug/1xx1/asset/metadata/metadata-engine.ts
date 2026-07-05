/**
 * 1XX1 Metadata Engine
 * Aşama 11 — Asset Bank
 *
 * Her yüklemede otomatik olarak çıkarılır:
 *   - SHA-256 checksum (duplicate detection için)
 *   - SHA-512 checksum (ek güvenlik)
 *   - MIME tipi (uzantı + magic bytes)
 *   - Dosya boyutu
 *   - Format doğrulama
 *   - Thumbnail bilgisi (Aşama 12'de AI ile zenginleşecek)
 *
 * Bu modül saf fonksiyonlar içerir; I/O yapmaz.
 * Storage Adapter ve Repository'den bağımsızdır.
 */

import type { Checksum, AssetType } from "../entities/asset.entity.ts";
import { guessAssetType } from "../entities/asset.entity.ts";

// ─── Magic Bytes (dosya imzaları) ─────────────────────────────────────────────

const MAGIC_BYTES: Array<{
  signature: number[];
  offset:    number;
  mimeType:  string;
  ext:       string;
}> = [
  // Görsel
  { signature: [0x89, 0x50, 0x4E, 0x47],       offset: 0, mimeType: "image/png",         ext: "png"  },
  { signature: [0xFF, 0xD8, 0xFF],               offset: 0, mimeType: "image/jpeg",        ext: "jpg"  },
  { signature: [0x47, 0x49, 0x46],               offset: 0, mimeType: "image/gif",         ext: "gif"  },
  { signature: [0x52, 0x49, 0x46, 0x46],         offset: 0, mimeType: "image/webp",        ext: "webp" },
  // 3D
  { signature: [0x73, 0x6F, 0x6C, 0x69, 0x64],  offset: 0, mimeType: "model/stl",         ext: "stl"  }, // "solid"
  { signature: [0x67, 0x6C, 0x54, 0x46],         offset: 0, mimeType: "model/gltf-binary", ext: "glb"  }, // glTF
  // Ses
  { signature: [0x52, 0x49, 0x46, 0x46],         offset: 0, mimeType: "audio/wav",         ext: "wav"  },
  { signature: [0x49, 0x44, 0x33],               offset: 0, mimeType: "audio/mpeg",        ext: "mp3"  },
  { signature: [0x66, 0x4C, 0x61, 0x43],         offset: 0, mimeType: "audio/flac",        ext: "flac" },
  // Video
  { signature: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], offset: 0, mimeType: "video/mp4", ext: "mp4" },
  // Döküman
  { signature: [0x25, 0x50, 0x44, 0x46],         offset: 0, mimeType: "application/pdf",   ext: "pdf"  },
  // WebAssembly
  { signature: [0x00, 0x61, 0x73, 0x6D],         offset: 0, mimeType: "application/wasm",  ext: "wasm" },
  // Font
  { signature: [0x00, 0x01, 0x00, 0x00],         offset: 0, mimeType: "font/ttf",          ext: "ttf"  },
  { signature: [0x4F, 0x54, 0x54, 0x4F],         offset: 0, mimeType: "font/otf",          ext: "otf"  },
  { signature: [0x77, 0x4F, 0x46, 0x46],         offset: 0, mimeType: "font/woff",         ext: "woff" },
  { signature: [0x77, 0x4F, 0x46, 0x32],         offset: 0, mimeType: "font/woff2",        ext: "woff2"},
];

// ─── Checksum Hesaplama ───────────────────────────────────────────────────────

/**
 * SHA-256 ve SHA-512 hesapla (Web Crypto API).
 * Node.js 18+ ve Deno destekler.
 */
export async function computeChecksum(data: Uint8Array): Promise<Checksum> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const [sha256Buf, sha512Buf] = await Promise.all([
      crypto.subtle.digest("SHA-256", data),
      crypto.subtle.digest("SHA-512", data),
    ]);
    return {
      sha256: bufToHex(sha256Buf),
      sha512: bufToHex(sha512Buf),
    };
  }

  // Fallback: Node.js crypto modülü
  try {
    const { createHash } = await import("node:crypto");
    return {
      sha256: createHash("sha256").update(data).digest("hex"),
      sha512: createHash("sha512").update(data).digest("hex"),
    };
  } catch {
    // Minimal fallback (test ortamı)
    return { sha256: simpleHash(data) };
  }
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Test ortamı için basit hash (kriptografik değil) */
function simpleHash(data: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < data.length; i++) {
    h = (h * 31 + data[i]) >>> 0;
  }
  return h.toString(16).padStart(8, "0").padEnd(64, "0");
}

// ─── MIME Tespiti ─────────────────────────────────────────────────────────────

/** Magic bytes ile MIME tipini belirle */
export function detectMimeType(
  data:     Uint8Array,
  fileName: string
): { mimeType: string; ext: string } {
  // Magic bytes kontrolü
  for (const magic of MAGIC_BYTES) {
    let match = true;
    for (let i = 0; i < magic.signature.length; i++) {
      if (data[magic.offset + i] !== magic.signature[i]) { match = false; break; }
    }
    if (match) return { mimeType: magic.mimeType, ext: magic.ext };
  }

  // Uzantıdan tahmin
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return { mimeType: extToMime(ext), ext };
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    // Metin
    txt: "text/plain", md: "text/markdown", html: "text/html",
    css: "text/css",   csv: "text/csv",     json: "application/json",
    // 3D
    stl: "model/stl", obj: "model/obj", ply: "model/ply",
    gltf: "model/gltf+json", glb: "model/gltf-binary",
    // Kod
    js: "application/javascript", ts: "application/typescript",
    py: "text/x-python", sh: "application/x-sh",
    wasm: "application/wasm",
    // CAD
    step: "model/step", stp: "model/step",
    // Diğer
    zip: "application/zip", tar: "application/x-tar",
    gz: "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

// ─── Metadata Sonucu ─────────────────────────────────────────────────────────

export interface ExtractedMetadata {
  checksum:    Checksum;
  mimeType:    string;
  size:        number;
  format:      string;           // uzantı: "stl", "png", vb.
  assetType:   AssetType;        // tahmin edilen tip
  valid:       boolean;          // format geçerli mi?
  thumbnail?:  string;           // Aşama 12'de doldurulacak
}

// ─── Metadata Engine ──────────────────────────────────────────────────────────

export class MetadataEngine {

  /**
   * Dosya verisinden metadata çıkar.
   * Async: checksum hesaplaması için.
   */
  async extract(data: Uint8Array, fileName: string): Promise<ExtractedMetadata> {
    const checksum  = await computeChecksum(data);
    const { mimeType, ext } = detectMimeType(data, fileName);
    const assetType = guessAssetType(ext);

    return {
      checksum,
      mimeType,
      size:      data.byteLength,
      format:    ext,
      assetType,
      valid:     ext.length > 0 && mimeType !== "application/octet-stream",
      thumbnail: undefined, // Aşama 12
    };
  }

  /**
   * Dosya boyutu sınır kontrolü.
   * @param maxBytes varsayılan: 512 MB
   */
  checkSize(bytes: number, maxBytes = 512 * 1024 * 1024): boolean {
    return bytes > 0 && bytes <= maxBytes;
  }

  /** İki checksum aynı mı? (duplicate detection) */
  isDuplicate(a: Checksum, b: Checksum): boolean {
    return a.sha256 === b.sha256;
  }
}

export const metadataEngine = new MetadataEngine();
