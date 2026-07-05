/**
 * 1XX1 Platform — Giriş Noktası
 * Aşama 25 — Tam Entegrasyon
 *
 * Bu dosya sistemi GERÇEKTEN başlatır:
 *   1. EventBus + Structured Logger + Prometheus Metrics
 *   2. NodeRuntime (Gossip + Transport + Snapshot)
 *   3. IndexManager + SearchEngine
 *   4. PulseScheduler (5 saniyelik fairness tick)
 *   5. PluginRegistry
 *   6. HTTP Server → API + UI + SSE stream
 *   7. Ghost Mesh Transport (opsiyonel)
 *
 * Çalıştırma:
 *   node --experimental-strip-types main.ts
 *   veya: npm start  (tsx ile)
 */

import * as http from "node:http";
import * as fs   from "node:fs";
import * as path from "node:path";
import * as url  from "node:url";

// ─── Mesh Transport ───────────────────────────────────────────────────────────
import { LANTransport }      from "./mesh/link/physical-transports.ts";
import { LinkManager, TRANSPORT_PROFILES } from "./mesh/link/link-manager.ts";
import { GhostTransport }    from "./mesh/ghost/ghost-transport.ts";

// ─── FAZ 0 — Identity + Time ──────────────────────────────────────────────────
import { resolveIdentity }   from "./core/identity.ts";
import { updateLogicalTime, logTimestamp } from "./core/logical-time.ts";

// ─── Cekirdek ─────────────────────────────────────────────────────────────────
import { EventBus }          from "./core/event-bus.ts";
import { ConsoleLogger }     from "./core/logger.ts";
import { MemoryTransport }   from "./distributed/transport/transport.ts";
import { MockSignatureProvider } from "./distributed/security/signature.ts";
import { NodeRuntime }       from "./distributed/node/node-runtime.ts";
import { IndexManager }      from "./search/index-manager.ts";
import { SearchEngine }      from "./search/search-engine.ts";
import { PulseScheduler }    from "./pulse/scheduler/pulse-scheduler.ts";
import { PluginRegistry }    from "./plugin/registry/plugin-registry.ts";
import { MockSandboxAdapter } from "./sandbox/adapters/sandbox-adapters.ts";
import {
  StructuredLogger, createPlatformRegistry,
} from "./ops/observability/observability.ts";
import type { Project } from "./core/types.ts";

import { ClusterObserver } from "./ops/observability/cluster-observer.ts";
import { getLogicalTime } from "./core/logical-time.ts";

// ─── FAZ 3 — DHT + NAT ───────────────────────────────────────────────────────
import { KademliaEngine } from "./distributed/dht/kademlia.ts";
import { discoverExternalIp } from "./distributed/nat/nat-traversal.ts";
import { normalizeEndpoint, getLocalIP } from "./core/network.ts";

// ─── FAZ 1 — Gossip Discovery ────────────────────────────────────────────────
import { GossipDiscovery } from "./distributed/discovery/gossip-discovery.ts";

// ─── FAZ 0: Kalici Kimlik Coz ─────────────────────────────────────────────────
const IDENTITY = resolveIdentity();

// ─── Konfigürasyon ────────────────────────────────────────────────────────────

const CFG = {
  nodeId:      process.env.X1_NODE_ID ?? IDENTITY.nodeId,
  uiPort:      parseInt(process.env.X1_UI_PORT   ?? "1331"),
  apiPort:     parseInt(process.env.X1_API_PORT  ?? "8080"),
  peers:       (process.env.X1_PEERS ?? "").split(",").filter(Boolean),
  logLevel:    (process.env.X1_LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  pulseMs:     parseInt(process.env.X1_PULSE_INTERVAL_MS  ?? "5000"),
  snapMs:      parseInt(process.env.X1_SNAPSHOT_INTERVAL_MS ?? "60000"),
  openBrowser: process.env.X1_NO_BROWSER !== "true",
};

// ─── Servis Katmanı ───────────────────────────────────────────────────────────

const log      = new StructuredLogger("x1-main", CFG.logLevel);
const bus      = new EventBus();
const metrics  = createPlatformRegistry();

// FAZ 1: Gossip Discovery
const gossip = new GossipDiscovery(
  IDENTITY,
  `http://0.0.0.0:${CFG.uiPort}`,
  () => 3,   // getTerm — Raft entegrasyonunda gercek term gelecek
  (nodeId, endpoint) => {
    bus.emit("peer:update" as never, { id: nodeId, endpoint, status: "active" });
  },
  log
);

// NodeRuntime
const transport = new MemoryTransport(CFG.nodeId);
const signer    = new MockSignatureProvider(CFG.nodeId);
const node      = new NodeRuntime(transport, signer, {
  heartbeatIntervalMs:   CFG.pulseMs,
  snapshotIntervalMs:    CFG.snapMs,
  healthCheckIntervalMs: 10_000,
});

// Search
const indexMgr = new IndexManager(bus);
const search   = new SearchEngine(indexMgr, bus);

// Pulse
const pulse = new PulseScheduler(
  { intervalMs: CFG.pulseMs, maxRankSize: 100 },
  undefined, bus
);

// Plugin
const plugins = new PluginRegistry(new MockSandboxAdapter(), { platformVersion: "1.0.0" }, bus);

// Demo projeler (gerçek DB olmadan sistemi doldurmak için)
const DEMO_PROJECTS: Project[] = [
  {
    id: "p1", name: "1XX1 Core Engine", description: "Fraktal küp motoru, 1331 koordinat sistemi",
    cube: { x: 1, y: 3, z: 3 }, developer: "kaptan", repo: "https://github.com/kaptan/1xx1",
    tags: ["platform", "core", "distributed"], license: "MIT", status: "active",
    createdAt: new Date("2026-01-01"), updatedAt: new Date(),
  },
  {
    id: "p2", name: "Ghost Mesh SMP", description: "1331 Spatial Mesh Protocol — offline P2P routing",
    cube: { x: 3, y: 1, z: 3 }, developer: "kaptan", repo: "https://github.com/kaptan/smp",
    tags: ["mesh", "p2p", "offline"], license: "MIT", status: "active",
    createdAt: new Date("2026-02-01"), updatedAt: new Date(),
  },
  {
    id: "p3", name: "Pulse Engine", description: "Deterministik fairness sıralama — para etkisiz",
    cube: { x: 3, y: 3, z: 1 }, developer: "kaptan", repo: "https://github.com/kaptan/pulse",
    tags: ["pulse", "ranking", "fairness"], license: "MIT", status: "active",
    createdAt: new Date("2026-03-01"), updatedAt: new Date(),
  },
  {
    id: "p4", name: "Kaptan STL Viewer", description: "WebGL 3D model görüntüleyici, FEM analizi",
    cube: { x: 5, y: 5, z: 5 }, developer: "kaptan", repo: "https://github.com/kaptan/stl",
    tags: ["3d", "webgl", "stl"], license: "MIT", status: "active",
    createdAt: new Date("2026-04-01"), updatedAt: new Date(),
  },
  {
    id: "p5", name: "Raft Consensus", description: "Lightweight Raft — deterministik lider seçimi",
    cube: { x: 7, y: 2, z: 8 }, developer: "kaptan", repo: "https://github.com/kaptan/raft",
    tags: ["consensus", "raft", "distributed"], license: "MIT", status: "beta",
    createdAt: new Date("2026-05-01"), updatedAt: new Date(),
  },
];

// ─── SSE Bağlı İstemciler ────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(type: string, data: unknown): void {
  const msg = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); }
    catch { sseClients.delete(client); }
  }
}

// EventBus → SSE köprüsü (pulse:tick bootstrap'ta ayrıca bağlanıyor)
bus.on("raft:update"    as never, (d: unknown) =>   broadcastSSE("raft",   d));
bus.on("plugin:update"  as never, (d: unknown) =>   broadcastSSE("plugin", d));
bus.on("index:upserted" as never, (d: unknown) => { broadcastSSE("index",  d); metrics.inc("x1_gossip_messages_total"); });
bus.on("peer:update"    as never, (d: unknown) =>   broadcastSSE("peer",   d));

// ─── UI Statik Dosya Sunucusu ─────────────────────────────────────────────────

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const UI_DIR    = path.join(__dirname, "ui", "app");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
server.keepAliveTimeout = 60000;
server.headersTimeout   = 65000;
  const u = new URL(req.url ?? "/", `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // ── /app (WebView modu — SSE yok, saf polling) ───────────────────────────
  if (u.pathname === "/app") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>1XX1</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0E1116;color:#E8EDF5;font-family:monospace;height:100vh;display:flex;flex-direction:column}
header{background:#12161D;padding:12px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1F2530}
.logo{color:#5B8CFF;font-size:18px;font-weight:bold;letter-spacing:2px}
.dot{width:10px;height:10px;border-radius:50%;background:#27C46A;margin-left:auto;transition:background 0.3s}
.dot.off{background:#FF4444}
.status{font-size:11px;color:#6B7A90}
main{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.card{background:#12161D;border:1px solid #1F2530;border-radius:10px;padding:14px}
.card-label{font-size:10px;color:#6B7A90;letter-spacing:1px;margin-bottom:6px}
.card-value{font-size:22px;color:#5B8CFF;font-weight:bold}
.card-sub{font-size:11px;color:#6B7A90;margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pulse-list{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.pulse-item{display:flex;align-items:center;gap:10px;padding:10px;background:#0E1116;border-radius:8px}
.rank{color:#5B8CFF;font-size:13px;width:20px}
.name{flex:1;font-size:13px}
.score{color:#6B7A90;font-size:12px}
.bar{height:3px;background:#5B8CFF;border-radius:2px;margin-top:4px}
</style>
</head>
<body>
<header>
  <span class="logo">1XX1</span>
  <span class="status" id="st">baglaniyor...</span>
  <div class="dot" id="dot"></div>
</header>
<main>
  <div class="grid">
    <div class="card">
      <div class="card-label">PULSE</div>
      <div class="card-value" id="pulse">#—</div>
      <div class="card-sub" id="pulseAge">—</div>
    </div>
    <div class="card">
      <div class="card-label">PROJELER</div>
      <div class="card-value" id="projects">—</div>
      <div class="card-sub">indexlenmis</div>
    </div>
    <div class="card">
      <div class="card-label">NODE</div>
      <div class="card-value" style="font-size:14px" id="nodeId">—</div>
      <div class="card-sub" id="role">—</div>
    </div>
    <div class="card">
      <div class="card-label">UPTIME</div>
      <div class="card-value" style="font-size:16px" id="uptime">—</div>
      <div class="card-sub">saniye</div>
    </div>
  </div>
  <div class="card">
    <div class="card-label">PULSE SIRASLAMASI</div>
    <div class="pulse-list" id="rankList"></div>
  </div>
</main>
<script>
const PROJECTS = ${JSON.stringify(DEMO_PROJECTS.map(p => ({ id: p.id, name: p.name })))};

async function refresh() {
  try {
    const base = window.location.origin;
    const r = await fetch(base + '/health');
    const d = await r.json();
    document.getElementById('dot').className = 'dot';
    document.getElementById('st').textContent = 'AKTIF · ' + d.nodeId.slice(0,8);
    document.getElementById('pulse').textContent = '#' + d.pulse;
    document.getElementById('nodeId').textContent = d.nodeId.slice(0,10);
    document.getElementById('role').textContent = d.role.toUpperCase();
    document.getElementById('uptime').textContent = Math.floor(d.uptime);
    
    const pr = await fetch(base + '/api/pulse');
    const pd = await pr.json();
    if (pd.ranked) {
      document.getElementById('projects').textContent = pd.ranked.length;
      const list = document.getElementById('rankList');
      list.innerHTML = pd.ranked.slice(0,6).map((r,i) => {
        const name = PROJECTS.find(p=>p.id===r.projectId)?.name || r.projectId;
        const pct = Math.round(r.score * 100);
        return '<div class="pulse-item"><span class="rank">' + (i+1) + '</span><div style="flex:1"><div class="name">' + name + '</div><div class="bar" style="width:' + pct + '%"></div></div><span class="score">' + pct + '%</span></div>';
      }).join('');
    }
  } catch {
    document.getElementById('dot').className = 'dot off';
    document.getElementById('st').textContent = 'OFFLINE';
  }
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
    return;
  }

  // ── /raft/status (FAZ 5) ─────────────────────────────────────────────────
  if (u.pathname === "/raft/status") {
    json(observer.raftStatus());
    return;
  }

  // ── /cluster/state (FAZ 5) ───────────────────────────────────────────────
  if (u.pathname === "/cluster/state") {
    json(observer.clusterState());
    return;
  }

  // ── /dht/find-node (FAZ 3.3) ─────────────────────────────────────────────
  if (u.pathname === "/dht/find-node" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const reqData = JSON.parse(body);
        const response = dht.handleFindNode(reqData);
        json(response);
      } catch (e) { json({ error: String(e) }, 400); }
    });
    return;
  }

  // ── /dht/store (FAZ 3.3) ─────────────────────────────────────────────────
  if (u.pathname === "/dht/store" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const reqData = JSON.parse(body);
        json(dht.handleStore(reqData));
      } catch (e) { json({ error: String(e) }, 400); }
    });
    return;
  }

  // ── /dht/stats (FAZ 3.3 debug) ───────────────────────────────────────────
  if (u.pathname === "/dht/stats") {
    json(dht.stats());
    return;
  }

  // ── /gossip/handshake (FAZ 1.3) ──────────────────────────────────────────
  if (u.pathname === "/gossip/handshake" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const reqData = JSON.parse(body);
        const response = gossip.handleHandshake(reqData);
        // LANTransport'a da peer olarak ekle (ghostTransport hazirsa)
        if (typeof ghostTransport !== "undefined" && ghostTransport) {
          (ghostTransport as any).addPeer?.(reqData.nodeId, reqData.endpoint);
        }
        json(response);
      } catch (e) {
        json({ error: String(e) }, 400);
      }
    });
    return;
  }

  // ── /gossip/peers (FAZ 1.3) ───────────────────────────────────────────────
  if (u.pathname === "/gossip/peers") {
    json(gossip.getPeersResponse());
    return;
  }

  // ── /nodes (FAZ 5.1) ──────────────────────────────────────────────────────
  if (u.pathname === "/nodes") {
    json({
      self:  { nodeId: IDENTITY.nodeId, endpoint: normalizeEndpoint("0.0.0.0", CFG.uiPort), role: "leader" },
      peers: gossip.alivePeers(),
      total: gossip.peerCount() + 1,
    });
    return;
  }

  // ── /identity (FAZ 0.1) ──────────────────────────────────────────────────
  if (u.pathname === "/identity") {
    json({
      nodeId:      IDENTITY.nodeId,
      publicKey:   IDENTITY.publicKeyB64,
      algorithm:   "ed25519",
      createdAt:   IDENTITY.createdAt,
      uptime:      process.uptime(),
      role:        "leader",
      logicalTime: updateLogicalTime(),
    });
    return;
  }

  // ── /health ──────────────────────────────────────────────────────────────
  if (u.pathname === "/health") {
    const health = node.health.status();
    json({
      status:   health.status ?? "active",
      nodeId:   CFG.nodeId,
      role:     "leader",
      peers:    node.peers.count(),
      uptime:   process.uptime(),
      version:  "1.0.0",
      pulse:    pulse.currentSnapshot()?.pulseNumber ?? 0,
      plugins:  plugins.stats(),
    });
    return;
  }

  // ── /ready ────────────────────────────────────────────────────────────────
  if (u.pathname === "/ready") {
    json({ ready: true });
    return;
  }

  // ── /metrics (Prometheus) ─────────────────────────────────────────────────
  if (u.pathname === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(metrics.scrape());
    return;
  }

  // ── /events (SSE) ─────────────────────────────────────────────────────────
  if (u.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });

    // İlk mesaj: mevcut durum
    const snap = pulse.currentSnapshot();
    res.write(`data: ${JSON.stringify({ type: "health", data: {
      nodeId: CFG.nodeId, role: "leader", status: "active",
      peers: CFG.peers.map((p) => ({ id: p, role: "follower", status: "active" })),
    }})}\n\n`);

    if (snap) {
      res.write(`data: ${JSON.stringify({ type: "pulse", data: {
        number: snap.pulseNumber,
        items:  (snap.ranked ?? []).slice(0, 10).map((r) => ({
          id:    r.projectId,
          name:  DEMO_PROJECTS.find((p) => p.id === r.projectId)?.name ?? r.projectId,
          score: r.score,
        })),
      }})}\n\n`);
    }

    // Plugin durumu
    res.write(`data: ${JSON.stringify({ type: "plugin", data: {
      list: plugins.all().map((r) => ({
        name:     r.plugin.manifest.identity.name,
        status:   r.status,
        manifest: r.plugin.manifest,
      })),
    }})}\n\n`);

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── /search ───────────────────────────────────────────────────────────────
  if (u.pathname === "/search") {
    const query  = u.searchParams.get("q") ?? "";
    const limit  = parseInt(u.searchParams.get("limit") ?? "20");
    const offset = parseInt(u.searchParams.get("offset") ?? "0");

    if (!query) { json({ results: [], total: 0 }); return; }

    try {
      const results = search.search({ query, limit, offset });
      const start = Date.now();
      metrics.observe("x1_search_latency_ms", Date.now() - start);
      metrics.inc("x1_search_queries_total");
      json({ query, results, total: results.length });
    } catch (e) {
      json({ error: String(e), results: [], total: 0 }, 500);
    }
    return;
  }

  // ── /api/projects ──────────────────────────────────────────────────────────
  if (u.pathname === "/api/projects") {
    json({ projects: DEMO_PROJECTS, total: DEMO_PROJECTS.length });
    return;
  }

  // ── /api/pulse ────────────────────────────────────────────────────────────
  if (u.pathname === "/api/pulse") {
    const snap = pulse.currentSnapshot();
    if (!snap) { json({ pulse: null, ranked: [] }); return; }
    const entries = snap.entries ?? snap.ranked ?? [];
    json({
      pulseNumber: snap.pulseNumber,
      timestamp:   snap.timestamp,
      ranked: entries.slice(0, 20).map((r: any) => ({
        projectId: r.projectId,
        score:     r.score,
        name: DEMO_PROJECTS.find((p) => p.id === r.projectId)?.name ?? r.projectId,
      })),
    });
    return;
  }

  // ── /api/plugins ──────────────────────────────────────────────────────────
  if (u.pathname === "/api/plugins") {
    json(plugins.all().map((r) => ({
      name:        r.plugin.manifest.identity.name,
      version:     r.plugin.manifest.identity.version,
      description: r.plugin.manifest.identity.description,
      status:      r.status,
      extensions:  r.plugin.manifest.extensionPoints,
      activatedAt: r.activatedAt,
    })));
    return;
  }

  // ── /admin/snapshot ────────────────────────────────────────────────────────
  if (u.pathname === "/admin/snapshot" && req.method === "POST") {
    node.takeSnapshot().then((snap) => {
      metrics.inc("x1_snapshot_taken_total");
      const msg = `Snapshot alındı: ${snap?.hash ?? "—"}`;
      log.info(msg);
      broadcastSSE("log", { level: "info", message: msg, timestamp: Date.now() });
      json({ ok: true, hash: snap?.hash, takenAt: new Date().toISOString() });
    }).catch((e) => json({ ok: false, error: String(e) }, 500));
    return;
  }

  // ── /admin/reconnect-peers ────────────────────────────────────────────────
  if (u.pathname === "/admin/reconnect-peers" && req.method === "POST") {
    for (const peer of CFG.peers) node.addPeer(peer, "mock_key");
    json({ ok: true, peers: CFG.peers });
    return;
  }

  // ── Statik UI ─────────────────────────────────────────────────────────────
  let filePath = (u.pathname === "/" || u.pathname === "")
    ? path.join(UI_DIR, "index.html")
    : path.join(UI_DIR, u.pathname);

  if (!filePath.startsWith(UI_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (!fs.existsSync(filePath))      filePath = path.join(UI_DIR, "index.html");

  serveFile(res, filePath);
});

// ─── Başlatma ────────────────────────────────────────────────────────────────

// FAZ 3 — DHT module scope
let dht: KademliaEngine = new KademliaEngine("pending", "http://localhost:1331");
// FAZ 5 — Observability module scope
let observer: ClusterObserver;

async function bootstrap() {
  // 1. NodeRuntime
  await node.start();
  for (const peer of CFG.peers) node.addPeer(peer, "mock_key");
  log.info(`NodeRuntime başlatıldı: ${CFG.nodeId}`);

  // 1b. Gossip Discovery basalt
  await gossip.start();
  log.info(`GossipDiscovery baslatildi (${CFG.peers.length} seed peer)`);

  // Manuel peer'lari gossip'e de ekle
  for (const peer of CFG.peers) {
    gossip.addPeer(peer, `http://${peer}:${CFG.uiPort}`, "manual");
  }

  // 1c. FAZ 3 — DHT Engine baslat
  const extIp = await discoverExternalIp(log).catch(() => null);
  const selfEndpoint = extIp
    ? `http://${extIp}:${CFG.uiPort}`
    : `http://localhost:${CFG.uiPort}`;

  dht = new KademliaEngine(IDENTITY.nodeId, selfEndpoint, log);

  // Gossip peer'larini DHT'ye de ekle
  gossip.alivePeers().forEach(p => dht.addContact({
    nodeId:   p.nodeId,
    endpoint: p.endpoint,
    lastSeen: p.lastSeen,
  }));

  // DHT periyodik refresh (her 5 dakika)
  setInterval(() => { void dht.refresh(); dht.cleanExpired(); }, 5 * 60_000);
  log.info(`DHT baslatildi: selfEndpoint=${selfEndpoint}, routing=${dht.size()} node`);

  // FAZ 5 — Observability observer (Core'u sadece okur)
  observer = new ClusterObserver(
    () => IDENTITY.nodeId,
    () => ({
      status: () => ({
        role:          "leader",
        term:          3,
        commitIndex:   (node as any).raft?.commitIndex ?? 0,
        logLength:     (node as any).raft?.log?.length ?? 0,
        leaderId:      IDENTITY.nodeId,
        peers:         gossip.alivePeers().map(p => p.nodeId),
        votesReceived: 0,
        leaderChanges: 0,
        commitTimes:   [],
      })
    }),
    () => gossip.alivePeers().map(p => ({
      nodeId:     p.nodeId,
      endpoint:   p.endpoint,
      lastSeen:   p.lastSeen,
      reputation: p.reputation,
      source:     p.source,
    })),
    () => dht,
    () => gossip.peers().all().filter(p => p.source === "seed").length,
    () => ({ trusted: 0, flagged: 0 }),
    () => getLogicalTime(),
  );
  const nodeCoord = {
    x: Math.abs(CFG.nodeId.charCodeAt(0)) % 11,
    y: Math.abs(CFG.nodeId.charCodeAt(1) ?? 5) % 11,
    z: Math.abs(CFG.nodeId.charCodeAt(2) ?? 3) % 11,
  };
  const linkMgr  = new LinkManager(CFG.nodeId);
  const lanTransport = new LANTransport(CFG.nodeId, 13310, log);
  linkMgr.register({ transport: lanTransport, ...TRANSPORT_PROFILES.lan });
  const ghostTransport = new GhostTransport(CFG.nodeId, nodeCoord, linkMgr, undefined, log);

  try {
    await ghostTransport.start();
    log.info(`Ghost Mesh aktif: koordinat=(${nodeCoord.x},${nodeCoord.y},${nodeCoord.z}), LAN multicast 239.255.13.31:13310`);
    // Mesh'ten gelen peer'ları Raft/Gossip sistemine bağla
    ghostTransport.onMessage(async (env, from) => {
      bus.emit("peer:update" as never, { id: from, status: "active" });
    });
  } catch (e) {
    log.warn(`Ghost Mesh başlatılamadı (normal — ağ izni gerekebilir): ${String(e)}`);
  }

  // 2. Demo projeleri indeksle
  for (const project of DEMO_PROJECTS) {
    indexMgr.indexProject(project);
  }
  log.info(`${DEMO_PROJECTS.length} proje indekslendi`);

  // 3. Pulse scheduler
  pulse.start(() => DEMO_PROJECTS);
  log.info(`PulseScheduler başlatıldı (${CFG.pulseMs}ms interval)`);

  // 4. Pulse tick → SSE (EventBus: "pulse:tick")
  bus.on("pulse:tick" as never, (d: any) => {
    const snap = pulse.currentSnapshot();
    metrics.set("x1_pulse_eligible_projects", d?.eligible ?? 0);
    metrics.inc("x1_pulse_tick_total");
    broadcastSSE("pulse", {
      number: d?.pulseNumber ?? 0,
      items:  (snap?.ranked ?? []).slice(0, 10).map((r: any) => ({
        id:    r.projectId,
        name:  DEMO_PROJECTS.find((p) => p.id === r.projectId)?.name ?? r.projectId,
        score: r.score,
      })),
    });
  });

  // 5. HTTP Server
  server.listen(CFG.uiPort, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  1XX1 PLATFORM — ÇALIŞIYOR                         ║
║                                                      ║
║  UI      →  http://localhost:${String(CFG.uiPort).padEnd(24)}║
║  Health  →  http://localhost:${String(CFG.uiPort).padEnd(18)}/health  ║
║  Arama   →  http://localhost:${String(CFG.uiPort).padEnd(18)}/search  ║
║  Metrics →  http://localhost:${String(CFG.uiPort).padEnd(16)}/metrics  ║
║                                                      ║
║  Node    →  ${CFG.nodeId.slice(0, 40).padEnd(40)}║
║  Pulse   →  ${String(CFG.pulseMs).padEnd(3)}ms interval                         ║
║  Projeler→  ${String(DEMO_PROJECTS.length).padEnd(40)}║
╚══════════════════════════════════════════════════════╝
    `);

    log.info("1XX1 Platform hazır", {
      ui:      `http://localhost:${CFG.uiPort}`,
      nodeId:  CFG.nodeId,
      peers:   CFG.peers.length,
      projects: DEMO_PROJECTS.length,
    });
  });

  // 6. Raft metrik simülasyonu (gerçek Raft SSE'ye bağlanana kadar)
  let term = 3, commitIdx = 0;
  setInterval(() => {
    commitIdx++;
    metrics.set("x1_raft_term_current",  term);
    metrics.set("x1_raft_commit_index",  commitIdx);
    metrics.set("x1_node_active_peers",  CFG.peers.length);
    metrics.set("x1_node_status",        1);
    metrics.set("x1_plugin_active_count", plugins.all().filter((r) => r.status === "active").length);
    broadcastSSE("raft", { term, commitIndex: commitIdx, role: "leader", leaderId: CFG.nodeId });
  }, 10_000);

  // 7. Tarayıcı aç (opsiyonel)
  if (CFG.openBrowser) {
    const openCmd = process.platform === "darwin" ? "open"
                  : process.platform === "win32"  ? "start"
                  :                                  "xdg-open";
    import("node:child_process").then(({ spawn }) => {
      spawn(openCmd, [`http://localhost:${CFG.uiPort}`], { detached: true, stdio: "ignore" });
    }).catch(() => {});
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info(`Kapatilıyor (${signal})...`);
  gossip.stop();
  pulse.stop();
  await node.stop();
  server.close(() => { log.info("Sunucu kapatıldı."); process.exit(0); });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Başlat ───────────────────────────────────────────────────────────────────

bootstrap().catch((e) => {
  console.error("Başlatma hatası:", e);
  process.exit(1);
});
