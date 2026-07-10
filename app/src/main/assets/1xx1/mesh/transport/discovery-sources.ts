/**
 * 1XX1 Discovery Sources — FAZ T.3
 *
 * Mevcut kesif mekanizmalarini TransportManager'a baglayan ince adaptorler.
 * Her kaynak SADECE reportSighting cagirir — karar vermez, filtrelemez;
 * hayalet reddi ve tekillestirme manager'da tek noktadadir.
 *
 * ANDROID KOPRU SOZLESMESI (Kotlin tarafi icin):
 *   Kotlin ne bulursa (WiFi Direct IP, BLE MAC, NFC/QR icerigi) su endpoint'e
 *   POST eder:  /transport/discovery?medium=X&ip=A.B.C.D  veya &hint=MAC
 *   Node tarafi bunu manager.reportSighting'e cevirir. Kotlin karar VERMEZ.
 */

import type { TransportManager, PeerSighting } from "./transport-manager.ts";

// ─── 1. Subnet Sweep adaptoru (impl: node — CALISIYOR) ───────────────────────
// main.ts'teki sweepOnce zaten /health yokluyor; bulundugunda bunu cagirir.

export function makeSweepReporter(mgr: TransportManager) {
  return function reportSweepHit(nodeId: string, ip: string, port: number): void {
    mgr.reportSighting({
      nodeId,
      endpoint: `http://${ip}:${port}`,
      medium:   "subnet-sweep",
      ts:       Date.now(),
    });
  };
}

// ─── 2. UDP Multicast adaptoru (impl: node — LANTransport uzerinden) ─────────
// GhostTransport.onMessage icinden gelen (env, from) ciftini gorusa cevirir.

export function makeMulticastReporter(mgr: TransportManager, port: number) {
  return function reportMulticast(fromNodeId: string, fromIp: string | null): void {
    const s: PeerSighting = {
      nodeId: fromNodeId,
      medium: "udp-multicast",
      ts:     Date.now(),
    };
    if (fromIp) s.endpoint = `http://${fromIp}:${port}`;
    mgr.reportSighting(s);
  };
}

// ─── 3. Android Koprusu (impl: bridge — WiFiDirect/BLE/NFC/QR/mDNS) ──────────
// HTTP handler'a takilir: /transport/discovery

export function handleBridgeSighting(
  mgr: TransportManager,
  params: URLSearchParams,
  port: number,
): { ok: boolean; error?: string } {
  const medium = params.get("medium") ?? "";
  const ip     = params.get("ip");
  const nodeId = params.get("nodeId") ?? undefined;
  const hint   = params.get("hint")   ?? undefined;

  const allowed = new Set(["wifi-direct", "ble", "bt-classic", "nfc", "qr", "mdns"]);
  if (!allowed.has(medium)) return { ok: false, error: `bilinmeyen medium: ${medium}` };
  if (!ip && !hint && !nodeId) return { ok: false, error: "ip, hint veya nodeId gerekli" };

  const s: PeerSighting = { medium, ts: Date.now() };
  if (nodeId) s.nodeId = nodeId;
  if (hint)   s.hint   = hint;
  if (ip)     s.endpoint = `http://${ip}:${port}`;

  const peer = mgr.reportSighting(s);
  return peer ? { ok: true } : { ok: false, error: "gorus reddedildi (hayalet/self)" };
}

// ─── 4. QR / NFC icerik formati (kesif verisi standardi) ────────────────────
// Bir cihaz kimligini QR'a basar / NFC'ye yazar; okuyan taraf parse edip bildirir.
//   Format: 1XX1|<nodeId>|<ip>|<port>
//   Ornek : 1XX1|6a7Seh...V4GJ|10.59.20.187|1331

export function encodePairingCode(nodeId: string, ip: string, port: number): string {
  return `1XX1|${nodeId}|${ip}|${port}`;
}

export function decodePairingCode(code: string):
  { nodeId: string; ip: string; port: number } | null {
  const parts = code.split("|");
  if (parts.length !== 4 || parts[0] !== "1XX1") return null;
  const port = parseInt(parts[3]);
  if (!parts[1] || !parts[2] || !Number.isFinite(port)) return null;
  return { nodeId: parts[1], ip: parts[2], port };
}

export function reportPairingCode(mgr: TransportManager, code: string, medium: "qr" | "nfc"): boolean {
  const d = decodePairingCode(code);
  if (!d) return false;
  return mgr.reportSighting({
    nodeId: d.nodeId,
    endpoint: `http://${d.ip}:${d.port}`,
    medium, ts: Date.now(),
  }) !== null;
}

// ─── 5. HTTP Connection tasiyicisi (impl: node — mevcut gossip yolu) ─────────
// Manager'in "wifi-ayni-ag / hotspot / lan" merdiven basamaklari icin
// gercek gonderim: peer'in dogrulanmis endpoint'ine HTTP POST.

export function makeHttpTransport(
  mgr: TransportManager,
  specId: "wifi-ayni-ag" | "wifi-hotspot" | "lan-ethernet",
) {
  return {
    specId,
    isUp: () => true,
    canReach: (nodeId: string) => {
      const p = mgr.resolve(nodeId);
      return !!(p && p.endpoint);
    },
    send: async (nodeId: string, env: { type: string; from: string; payload: unknown; ts: number }) => {
      const p = mgr.resolve(nodeId);
      if (!p || !p.endpoint) throw new Error("endpoint yok");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      try {
        const res = await fetch(`${p.endpoint}/gossip/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(env),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } finally { clearTimeout(timer); }
    },
  };
}
