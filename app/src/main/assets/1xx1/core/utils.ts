/**
 * 1XX1 Core Utilities
 * Aşama 01 — Çekirdek Mimari
 *
 * Tüm modüllerin kullanabileceği saf (pure) yardımcı fonksiyonlar.
 * Dış bağımlılık içermez. Test edilmesi kolaydır.
 */

import type { CubeCoordinate } from "./types.ts";

// ─── ID Üretimi ───────────────────────────────────────────────────────────────

/** Basit, çarpışmasız benzersiz ID üretir */
export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

// ─── Koordinat Araçları ───────────────────────────────────────────────────────

/** Koordinatı string anahtara dönüştürür: "4,7,2" */
export function coordToKey(coord: CubeCoordinate): string {
  return `${coord.x},${coord.y},${coord.z}`;
}

/** String anahtarı koordinata dönüştürür */
export function keyToCoord(key: string): CubeCoordinate {
  const parts = key.split(",").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Geçersiz koordinat anahtarı: "${key}"`);
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/** Koordinatın 1331 sisteminde geçerli olup olmadığını kontrol eder */
export function isValidCoord(coord: CubeCoordinate): boolean {
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10;
  return inRange(coord.x) && inRange(coord.y) && inRange(coord.z);
}

/** İki koordinat arasındaki Manhattan mesafesini hesaplar */
export function manhattanDistance(a: CubeCoordinate, b: CubeCoordinate): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

/** İki koordinat arasındaki Euclidean mesafesini hesaplar */
export function euclideanDistance(a: CubeCoordinate, b: CubeCoordinate): number {
  return Math.sqrt(
    Math.pow(a.x - b.x, 2) +
    Math.pow(a.y - b.y, 2) +
    Math.pow(a.z - b.z, 2)
  );
}

/** Verilen koordinatın komşularını döndürür (radius dahilinde) */
export function getNeighbors(
  coord: CubeCoordinate,
  radius = 1
): CubeCoordinate[] {
  const neighbors: CubeCoordinate[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = coord.x + dx;
        const ny = coord.y + dy;
        const nz = coord.z + dz;
        if (nx >= 0 && nx <= 10 && ny >= 0 && ny <= 10 && nz >= 0 && nz <= 10) {
          neighbors.push({ x: nx, y: ny, z: nz });
        }
      }
    }
  }
  return neighbors;
}

// ─── String Araçları ─────────────────────────────────────────────────────────

/** Metni normalleştirir: küçük harf, trim, çoklu boşluk temizleme */
export function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Metinden arama token'larını çıkarır */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[\s,\-_./]+/)
    .filter((t) => t.length > 1);
}

// ─── Zaman Araçları ───────────────────────────────────────────────────────────

/** ISO 8601 tarih string'i döndürür */
export function nowISO(): string {
  return new Date().toISOString();
}

/** İki tarih arasındaki milisaniye farkını döndürür */
export function msSince(date: Date): number {
  return Date.now() - date.getTime();
}

// ─── Hata Araçları ───────────────────────────────────────────────────────────

/** Bilinmeyen hatayı Error nesnesine dönüştürür */
export function toError(unknown: unknown): Error {
  if (unknown instanceof Error) return unknown;
  return new Error(String(unknown));
}
