/**
 * 1XX1 Ghost Cube — Matematik Katmanı
 * 1331 Spatial Mesh Protocol (SMP)
 *
 * Temel formüller (değişmez — tüm sistemle uyumlu):
 *   DR(n)  = n===0 ? 0 : 1+(n-1)%9      → dijital kök, 1-9 arası
 *   T(n)   = n*(n+1)/2                    → üçgensel sayı
 *   d(A,B) = |Ax-Bx|+|Ay-By|+|Az-Bz|    → Manhattan mesafesi (zaten core/utils.ts'te)
 *
 * KRİTİK KARAR:
 *   DR(d) → ghost SAYISI DEĞİL.
 *   DR(d) → priority (1-9), replication factor, routing seed.
 *
 *   Ghost sayısı ayrı formülle:
 *   ghostCount = ceil(d / effectiveDensity)
 *   effectiveDensity = nodeDensity × linkQuality × bandwidthFactor
 *
 * Neden ayrı?
 *   DR Berlin→İstanbul ile aynı odayı aynı ağırlıkta değerlendirirdi.
 *   Fiziksel faktörler (bant genişliği, yoğunluk) ghost sayısını belirlemeli.
 */

import type { CubeCoordinate } from "../../core/types.ts";
import {
  manhattanDistance, isValidCoord, getNeighbors, coordToKey,
} from "../../core/utils.ts";

// ─── Temel Formüller ─────────────────────────────────────────────────────────

/**
 * F1: Dijital Kök — 1 ile 9 arasında döngüsel değer.
 * Ghost sisteminde: transfer'in öncelik seviyesi, routing seed, replikasyon faktörü.
 * Ghost SAYISINI belirlemez.
 */
export function DR(n: number): number {
  if (n === 0) return 0;
  return 1 + (n - 1) % 9;
}

/**
 * F2: Üçgensel Sayı — kümülatif mesafe biriktirici.
 * Ghost sisteminde: bant genişliği hesabında ağırlık.
 */
export function T(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * F3: Etki azalması — mesafeyle ters orantılı.
 * Ghost sisteminde: komşu ghost'un link kalitesine katkısı.
 */
export function influence(distance: number, k = 1): number {
  return 1 / (1 + k * distance * distance);
}

// ─── Ghost Sayısı Hesabı ──────────────────────────────────────────────────────

export interface LinkContext {
  /** Fiziksel node yoğunluğu: A→B arasında kaç bilinen node var (0 = bilinmiyor) */
  nodeDensity:   number;
  /** Bağlantı kalitesi: 0.0 (çok kötü) → 1.0 (mükemmel) */
  linkQuality:   number;
  /** Bant genişliği faktörü: BLE=0.1, WiFi=0.5, LAN=1.0 */
  bandwidthFactor: number;
}

/**
 * Ghost Küp sayısını hesapla.
 *
 * Düşük yoğunluk + kötü bağlantı → daha fazla ghost (daha fazla ara nokta gerekli)
 * Yüksek yoğunluk + iyi bağlantı → daha az ghost (zaten fiziksel node'lar var)
 *
 * Minimum 1, maksimum d (her adım için bir ghost).
 */
export function ghostCount(
  d:    number,
  ctx:  LinkContext
): number {
  if (d === 0) return 0;
  if (d === 1) return 0; // Zaten komşu — ghost gerekmez

  // Efektif yoğunluk: fiziksel node'lar + bağlantı kalitesi + bant genişliği
  const effectiveDensity = Math.max(
    0.5, // minimum yoğunluk (her zaman en az bir ghost arası)
    ctx.nodeDensity * ctx.linkQuality * ctx.bandwidthFactor
  );

  const count = Math.ceil(d / effectiveDensity);

  // Sınırlar: min 1, max d-1 (başlangıç ve bitiş hariç)
  return Math.max(1, Math.min(count, d - 1));
}

/**
 * Transfer önceliği — DR(d) kullanır.
 * 1 = en düşük, 9 = en yüksek öncelik.
 */
export function transferPriority(d: number): number {
  return DR(d);
}

/**
 * Replikasyon faktörü — DR(d) kullanır.
 * Kaç kopya tutulsun.
 */
export function replicationFactor(d: number): number {
  return DR(d);
}

/**
 * Routing seed — DR(d)'den deterministik sayı üret.
 * Aynı mesafe → her zaman aynı seed → deterministik ghost zinciri.
 */
export function routingSeed(nodeIdA: string, nodeIdB: string, d: number): number {
  const base = DR(d);
  // İki node ID'sinin hash'i ile karıştır (deterministik ama node'a özgü)
  const aSum = nodeIdA.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const bSum = nodeIdB.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  return (base * 31 + aSum + bSum) % 1331; // 1331 = 11³
}

// ─── Koordinat Interpolasyonu ─────────────────────────────────────────────────

/**
 * A ile B arasında n adet mantıksal ara nokta üret.
 * Düz çizgi interpolasyon — fiziksel değil mantıksal koordinat.
 * Her koordinat 0-10 arasında (1331 küp uzayı).
 */
export function interpolateCoordinates(
  a: CubeCoordinate,
  b: CubeCoordinate,
  n: number  // ghost sayısı
): CubeCoordinate[] {
  if (n === 0) return [];

  const points: CubeCoordinate[] = [];
  const steps = n + 1; // n+1 parçaya böl (A ve B dahil değil)

  for (let i = 1; i <= n; i++) {
    const t = i / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    const z = Math.round(a.z + (b.z - a.z) * t);

    // 0-10 sınırına kırp
    points.push({
      x: Math.max(0, Math.min(10, x)),
      y: Math.max(0, Math.min(10, y)),
      z: Math.max(0, Math.min(10, z)),
    });
  }

  return points;
}

// ─── Komşuluk Doğrulama + Zincir Tamamlama ───────────────────────────────────

/**
 * İki koordinat komşu mu? (Manhattan mesafesi = 1)
 */
export function areNeighbors(a: CubeCoordinate, b: CubeCoordinate): boolean {
  return manhattanDistance(a, b) === 1;
}

/**
 * Zincirde komşu olmayan ardışık çift var mı?
 */
export function findGaps(chain: CubeCoordinate[]): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  for (let i = 0; i < chain.length - 1; i++) {
    if (!areNeighbors(chain[i], chain[i + 1])) {
      gaps.push([i, i + 1]);
    }
  }
  return gaps;
}

/**
 * Zinciri tam komşuluk zinciri haline getir.
 * Komşu olmayan iki nokta arasına özyinelemeli ara nokta ekler.
 * Döngü koruması: maksimum derinlik sınırı.
 *
 * Sonuç: her ardışık çift Manhattan d=1 komşu.
 */
export function fillChain(
  chain: CubeCoordinate[],
  maxDepth = 20
): CubeCoordinate[] {
  if (maxDepth <= 0) return chain; // döngü koruması

  const result: CubeCoordinate[] = [chain[0]];
  const seen = new Set<string>([coordToKey(chain[0])]);

  for (let i = 1; i < chain.length; i++) {
    const prev = result[result.length - 1];
    const curr = chain[i];

    if (areNeighbors(prev, curr)) {
      // Zaten komşu
      if (!seen.has(coordToKey(curr))) {
        result.push(curr);
        seen.add(coordToKey(curr));
      }
    } else {
      // Komşu değil — tek ara nokta bul (açgözlü yaklaşım)
      const bridge = _findBridgeStep(prev, curr, seen);
      if (bridge) {
        result.push(bridge);
        seen.add(coordToKey(bridge));
        // Şimdi bridge ile curr komşu mu kontrol et
        if (!areNeighbors(bridge, curr)) {
          // Hâlâ değilse özyinelemeli
          const sub = fillChain([bridge, curr], maxDepth - 1);
          for (const p of sub.slice(1)) {
            if (!seen.has(coordToKey(p))) {
              result.push(p);
              seen.add(coordToKey(p));
            }
          }
        } else {
          if (!seen.has(coordToKey(curr))) {
            result.push(curr);
            seen.add(coordToKey(curr));
          }
        }
      } else {
        // Geçici köprü bulunamadı — direkt ekle (en kötü durum)
        if (!seen.has(coordToKey(curr))) {
          result.push(curr);
          seen.add(coordToKey(curr));
        }
      }
    }
  }

  return result;
}

/**
 * prev'den curr'a tek adım ilerle — curr'a en yakın komşuyu seç.
 * Greedy: Manhattan mesafesini en çok azaltan yönde git.
 */
function _findBridgeStep(
  prev: CubeCoordinate,
  curr: CubeCoordinate,
  seen: Set<string>
): CubeCoordinate | null {
  const neighbors = getNeighbors(prev, 1).filter(
    (n) => isValidCoord(n) && !seen.has(coordToKey(n))
  );

  if (neighbors.length === 0) return null;

  // curr'a en yakın komşuyu seç
  return neighbors.reduce((best, n) => {
    const db = manhattanDistance(n, curr);
    const dc = manhattanDistance(best, curr);
    return db < dc ? n : best;
  });
}

// ─── Yardımcı İhracat (core/utils.ts fonksiyonları yeniden dışa aç) ─────────

export { manhattanDistance, isValidCoord, getNeighbors, coordToKey };
export type { CubeCoordinate };
