/**
 * 1XX1 CubePath Sistemi
 * Aşama 03 — Fraktal Alt Küpler
 *
 * Kural 4: Her küp benzersiz bir yol (path) ile tanımlanır.
 *
 * Örnekler:
 *   "4/7/2"         → kök seviye küp (4,7,2)
 *   "4/7/2/3"       → alt küp derinlik-1
 *   "4/7/2/3/8"     → alt küp derinlik-2
 *   "4/7/2/3/8/5"   → alt küp derinlik-3
 *
 * Path formatı: "{x}/{y}/{z}[/{childIndex}]*"
 * Kök düzey: x/y/z (3 segment)
 * Her ek segment bir alt küp seviyesi ekler.
 *
 * CubeID yalnızca görüntüleme; adresleme CubePath'ten.
 */

import type { CubeCoordinate } from "../core/types.ts";

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/** Bir CubePath string'i */
export type CubePath = string;

/** Ayrıştırılmış path bileşenleri */
export interface ParsedCubePath {
  /** Kök koordinat (her zaman mevcuttur) */
  root: CubeCoordinate;
  /** Kökten sonraki alt küp indeksleri */
  childIndices: number[];
  /** Toplam derinlik (0 = kök) */
  depth: number;
  /** Ham string */
  raw: string;
}

// ─── Path Oluşturma ───────────────────────────────────────────────────────────

/** Koordinattan kök CubePath oluştur: "4/7/2" */
export function rootPath(coord: CubeCoordinate): CubePath {
  return `${coord.x}/${coord.y}/${coord.z}`;
}

/** Mevcut path'e alt küp indeksi ekle: "4/7/2" + 3 → "4/7/2/3" */
export function childPath(parent: CubePath, childIndex: number): CubePath {
  if (childIndex < 0 || !Number.isInteger(childIndex)) {
    throw new Error(`Geçersiz alt küp indeksi: ${childIndex}`);
  }
  return `${parent}/${childIndex}`;
}

/** Path'in üst path'ini döndür: "4/7/2/3/8" → "4/7/2/3" */
export function parentPath(path: CubePath): CubePath | null {
  const segments = path.split("/");
  if (segments.length <= 3) return null; // kök, üst yok
  return segments.slice(0, -1).join("/");
}

// ─── Path Ayrıştırma ─────────────────────────────────────────────────────────

/** CubePath'i ayrıştır */
export function parseCubePath(path: CubePath): ParsedCubePath {
  const segments = path.split("/");

  if (segments.length < 3) {
    throw new Error(`Geçersiz CubePath: "${path}" (en az 3 segment gerekli)`);
  }

  const [xs, ys, zs, ...rest] = segments;
  const x = parseInt(xs, 10);
  const y = parseInt(ys, 10);
  const z = parseInt(zs, 10);

  if (isNaN(x) || isNaN(y) || isNaN(z)) {
    throw new Error(`CubePath kök koordinatı geçersiz: "${path}"`);
  }

  const childIndices = rest.map((s, i) => {
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 0) {
      throw new Error(`CubePath segment ${i + 3} geçersiz: "${s}"`);
    }
    return n;
  });

  return {
    root: { x, y, z },
    childIndices,
    depth: childIndices.length,
    raw: path,
  };
}

/** Path geçerli mi? (hata fırlatmadan) */
export function isValidCubePath(path: CubePath): boolean {
  try {
    parseCubePath(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Path Karşılaştırma ───────────────────────────────────────────────────────

/** a, b'nin atası mı? ("4/7/2", "4/7/2/3/8" → true) */
export function isAncestor(ancestor: CubePath, descendant: CubePath): boolean {
  if (ancestor === descendant) return false;
  return descendant.startsWith(ancestor + "/");
}

/** a ve b aynı kök küpü mü paylaşıyor? */
export function sameRoot(a: CubePath, b: CubePath): boolean {
  const ra = a.split("/").slice(0, 3).join("/");
  const rb = b.split("/").slice(0, 3).join("/");
  return ra === rb;
}

/** Path derinliği (kök = 0) */
export function pathDepth(path: CubePath): number {
  return path.split("/").length - 3;
}

/** Kök path'ini döndür */
export function rootOf(path: CubePath): CubePath {
  return path.split("/").slice(0, 3).join("/");
}

/** İki path arasındaki ortak ata */
export function commonAncestor(a: CubePath, b: CubePath): CubePath | null {
  const sa = a.split("/");
  const sb = b.split("/");
  const common: string[] = [];
  const min = Math.min(sa.length, sb.length);

  for (let i = 0; i < min; i++) {
    if (sa[i] === sb[i]) common.push(sa[i]);
    else break;
  }

  if (common.length < 3) return null;
  return common.join("/");
}
