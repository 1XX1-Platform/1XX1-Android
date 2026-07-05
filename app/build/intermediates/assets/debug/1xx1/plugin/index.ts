/**
 * 1XX1 Plugin SDK — Dışa Aktarma
 * Aşama 19 + Risk Düzeltmeleri + God-Object Önleme Refactor'ü
 *
 * Mimari geçiş: "distributed system core" → "platform ecosystem"
 * Çekirdek sistem DEĞİŞMEDEN, dış geliştiriciler bu SDK ile genişletebilir.
 *
 * Risk düzeltmeleri (Kaptan'ın 1. incelemesi):
 *   1. Capability Explosion  → capability-profiles.ts (önceden denetlenmiş izin demetleri)
 *   2. Sandbox Drift         → isolation-level.ts (zorunlu, doğrulanan izolasyon beyanı)
 *   3. Cross-plugin Risk     → plugin-dependency-graph.ts (DAG + blast-radius analizi)
 *
 * God-Object önleme (Kaptan'ın 2. incelemesi):
 *   PluginRegistry artık ince bir facade. Gerçek iş üç bağımsız sınıfa ayrıldı:
 *     PluginSecurityLayer    → manifest/versiyon/izolasyon doğrulama
 *     PluginGraphResolver    → cross-plugin etkileşim politikası (graf üzerinde)
 *     PluginLifecycleManager → register/activate/deactivate/suspend state makinesi
 *   Public API (PluginRegistry sınıfının dışa açık yüzeyi) DEĞİŞMEDİ.
 */
export * from "./core/plugin-types.ts";
export * from "./core/capability-profiles.ts";
export * from "./extension-points/data-plugins.ts";
export * from "./extension-points/observer-plugins.ts";
export * from "./sandbox/plugin-sandbox.ts";
export * from "./sandbox/isolation-level.ts";
export * from "./registry/plugin-dependency-graph.ts";
export * from "./registry/plugin-security-layer.ts";
export * from "./registry/plugin-graph-resolver.ts";
export * from "./registry/plugin-lifecycle-manager.ts";
export * from "./registry/plugin-registry.ts";
