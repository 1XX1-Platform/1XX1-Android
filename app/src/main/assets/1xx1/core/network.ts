/**
 * 1XX1 Network Utilities
 * Endpoint normalization — asla 0.0.0.0 saklanmaz
 */

import * as os from "node:os";

/** Gercek LAN IP'sini bul (0.0.0.0 degil) */
export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal && addr.address !== "0.0.0.0") {
        return addr.address;
      }
    }
  }
  return "127.0.0.1"; // fallback
}

/** Bind address'i gercek IP'ye cevir */
export function normalizeEndpoint(bindIp: string, port: number): string {
  if (bindIp === "0.0.0.0" || bindIp === "::" || bindIp === "") {
    return `http://${getLocalIP()}:${port}`;
  }
  return `http://${bindIp}:${port}`;
}
