/**
 * 1XX1 Seed Nodes
 * FAZ 3.1 — Bootstrap Network
 *
 * Oncelik sirasi:
 *   1. X1_SEEDS env var (virgülle ayrilmis URL listesi)
 *   2. DEFAULT_SEEDS (kalici seed listesi)
 *   3. LAN multicast (otomatik — seed gerekmez)
 *
 * Seed node = Internet uzerinden ilk baglanti noktasi.
 * Seed olmayanlar icin LAN yeterli.
 * Seed node'lar sadece peer listesi verir, veri saklamaz.
 */

export interface SeedNode {
  url:      string;   // "https://seed1.1xx1.net" veya "http://ip:port"
  priority: number;   // 0=yüksek oncelik
  region:   string;   // cografi yakinlik icin
}

export const DEFAULT_SEEDS: SeedNode[] = [
  // Gercek seed node'lar deploy edilince buraya eklenecek.
  // Simdilik bos — X1_SEEDS env var ile override edilebilir.
  // { url: "https://seed1.1xx1.net", priority: 0, region: "eu" },
  // { url: "https://seed2.1xx1.net", priority: 0, region: "us" },
];

export function getSeedNodes(): SeedNode[] {
  const env = process.env.X1_SEEDS;
  if (env) {
    return env.split(",").map((s, i) => ({
      url:      s.trim(),
      priority: i,
      region:   "custom",
    })).filter(s => s.url.length > 0);
  }
  return DEFAULT_SEEDS;
}

export function getSeedUrls(): string[] {
  return getSeedNodes().map(s => s.url);
}

export function isSeedConfigured(): boolean {
  return getSeedNodes().length > 0;
}

/** En iyi seed'i sec (priority + region'a gore) */
export function getBestSeeds(maxCount = 3): SeedNode[] {
  return getSeedNodes()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxCount);
}
