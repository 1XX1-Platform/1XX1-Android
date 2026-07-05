/**
 * 1XX1 NAT Traversal
 * FAZ 3.2 — Internet connectivity under NAT
 *
 * Strateji (oncelik sirasi):
 *   1. Direct connection (same network / public IP)
 *   2. STUN (discover external IP:port)
 *   3. Hole punching (symmetric NAT bypass)
 *   4. Relay fallback (turn-like, son care)
 *
 * Not: Tam STUN/TURN implementasyonu icin WebRTC veya
 * harici kutuphane gerekir. Bu modul:
 *   - External IP tespiti (STUN-lite HTTP fallback)
 *   - Endpoint tipleri
 *   - Relay proxy mimarisi
 * saglar.
 */

import type { ILogger } from "../../core/interfaces.ts";

// ─── Endpoint Tipleri ─────────────────────────────────────────────────────────

export type EndpointType =
  | "direct"        // dogrudan erisim (LAN veya public IP)
  | "stun"          // STUN ile kesfedilmis dis IP
  | "hole-punch"    // UDP hole punching
  | "relay";        // relay sunucu uzerinden

export interface NetworkEndpoint {
  url:      string;
  type:     EndpointType;
  latencyMs?: number;
  reliable:   boolean;
}

// ─── STUN-lite: HTTP fallback ile dis IP tespiti ──────────────────────────────

const STUN_FALLBACK_URLS = [
  "https://api.ipify.org?format=json",
  "https://api4.my-ip.io/ip.json",
];

export async function discoverExternalIp(logger?: ILogger): Promise<string | null> {
  for (const url of STUN_FALLBACK_URLS) {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!r.ok) continue;
      const data = await r.json() as Record<string, string>;
      const ip   = data.ip ?? data.query ?? null;
      if (ip && isValidIp(ip)) {
        logger?.info(`[NAT] Dis IP kesfedildi: ${ip}`);
        return ip;
      }
    } catch { /* devam */ }
  }
  logger?.warn("[NAT] Dis IP tespit edilemedi — dogrudan baglanti denenecek");
  return null;
}

// ─── Endpoint Cozumleme ───────────────────────────────────────────────────────

export async function resolveEndpoints(
  port:    number,
  logger?: ILogger
): Promise<NetworkEndpoint[]> {
  const endpoints: NetworkEndpoint[] = [];

  // 1. Localhost (test/dev)
  endpoints.push({
    url:      `http://127.0.0.1:${port}`,
    type:     "direct",
    reliable: true,
  });

  // 2. Dis IP (STUN-lite)
  const extIp = await discoverExternalIp(logger);
  if (extIp) {
    endpoints.push({
      url:      `http://${extIp}:${port}`,
      type:     "stun",
      reliable: true,
    });
  }

  return endpoints;
}

// ─── Baglanti kalitesi olcumu ─────────────────────────────────────────────────

export async function measureLatency(url: string): Promise<number | null> {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return Date.now() - t0;
  } catch {
    return null;
  }
}

/**
 * En iyi endpoint'i sec: dusuk gecikme + guvenilir
 */
export async function selectBestEndpoint(
  endpoints: NetworkEndpoint[]
): Promise<NetworkEndpoint | null> {
  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const latency = await measureLatency(ep.url);
      return { ...ep, latencyMs: latency ?? Infinity };
    })
  );

  const reachable = results
    .filter(r => r.status === "fulfilled" && r.value.latencyMs < Infinity)
    .map(r => (r as PromiseFulfilledResult<NetworkEndpoint & { latencyMs: number }>).value)
    .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0));

  return reachable[0] ?? null;
}

// ─── Relay Fallback ───────────────────────────────────────────────────────────

/**
 * Relay: Dogrudan baglanti kurulamadiginda
 * trafigi bilen bir peer uzerinden yonlendir.
 *
 * Mimari: A → relay_node → B
 * relay_node = her ikisini de bilen bir gossip peer'i
 */
export function canUseRelay(
  targetNodeId: string,
  knownPeers:   Array<{ nodeId: string; knownPeers?: string[] }>
): string | null {
  // Hem source hem target'i bilen peer bul
  for (const peer of knownPeers) {
    if (peer.knownPeers?.includes(targetNodeId)) {
      return peer.nodeId; // relay olarak kullanilabilir
    }
  }
  return null;
}

// ─── Yardimci ─────────────────────────────────────────────────────────────────

function isValidIp(ip: string): boolean {
  // IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return ip.split(".").every(p => parseInt(p) <= 255);
  }
  // IPv6 (basit kontrol)
  return ip.includes(":");
}

export { isValidIp };
