/**
 * 1XX1 Mesh — 1331 Spatial Mesh Protocol (SMP)
 *
 * Katman sıralaması (üstten alta):
 *   Application
 *     Cube Engine (koordinat, DR, Manhattan)
 *     Ghost Layer
 *       SpatialTopology   ← k-hop lokal harita, ghost rezervasyon
 *       GhostChainBuilder ← zincir inşa
 *       GhostRouter       ← yönlendirme kararı (hop/store/drop/direct)
 *       GhostHealth       ← süreç içi metrik
 *       PathOptimizer     ← en iyi zinciri seç (sağlık + gecikme + erişilebilirlik)
 *       GhostReplication  ← DR × kopya sayısı
 *       GhostReceipt      ← transfer izi + confidence score
 *     Mesh Layer
 *       GhostTransport    ← ITransport implementasyonu (tek entegrasyon noktası)
 *       LinkManager       ← BLE/WiFi/LAN otomatik seçimi
 *     Simulation
 *       GhostSimulator    ← 10K/100K/1M node, Ghost vs klasik mesh
 */

export * from "./ghost/ghost-math.ts";
export * from "./ghost/ghost-types.ts";
export * from "./ghost/ghost-chain.ts";
export * from "./ghost/ghost-router.ts";
export * from "./ghost/ghost-health.ts";
export * from "./ghost/ghost-replication-receipt.ts";
export * from "./ghost/ghost-transport.ts";
export * from "./ghost/spatial-topology.ts";
export * from "./ghost/path-optimizer.ts";
export * from "./ghost/route-cache.ts";
export * from "./link/link-manager.ts";
export * from "./simulation/ghost-simulator.ts";
export * from "./link/physical-transports.ts";
