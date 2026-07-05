/**
 * 1XX1 Plugin SDK — İzolasyon Seviyesi Beyanı
 * Aşama 19 (Risk Düzeltmesi 2/3)
 *
 * PROBLEM (Kaptan'ın tespiti — "Sandbox Drift Risk"):
 *   ISandboxAdapter arayüzü var ve PluginSandboxRunner onu sarmalıyor,
 *   ama "runtime isolation enforcement hangi seviyede?" sorusu açık
 *   bırakılmıştı. MockSandboxAdapter (gerçek izolasyon YOK, yalnızca
 *   simülasyon) ile ProcessSandboxAdapter (gerçek OS process izolasyonu)
 *   arasındaki fark plugin yazarına veya operatöre görünür değildi —
 *   yanlışlıkla production'da Mock adapter kullanılırsa hiç fark edilmez
 *   (sessiz güvenlik açığı = "drift").
 *
 * ÇÖZÜM: Her ISandboxAdapter kendi IsolationLevel'ını BEYAN ETMEK
 * ZORUNDADIR. PluginRegistry, bir plugin'i aktive etmeden önce manifest'in
 * talep ettiği minimum izolasyon seviyesi ile mevcut adapter'ın sağladığı
 * seviyeyi KARŞILAŞTIRIR — uyumsuzsa aktivasyon REDDEDİLİR (sessizce
 * daha zayıf izolasyonla çalıştırmak yerine).
 */

import type { ISandboxAdapter } from "../../sandbox/sandbox-types.ts";

// ─── İzolasyon Seviyeleri (Düşükten Yükseğe) ─────────────────────────────────

/**
 * none      → izolasyon yok (yalnızca test/geliştirme, ASLA production)
 * simulated → davranış simüle edilir, gerçek OS izolasyonu yok (MockSandboxAdapter)
 * process   → ayrı OS process'i, kaynak limitleri OS seviyesinde (ProcessSandboxAdapter)
 * container → ayrı konteyner (namespace + cgroup) — Aşama 14'ün roadmap'inde
 * vm        → tam sanal makine veya V8 isolate / WASM sandbox — en güçlü seviye
 */
export type IsolationLevel = "none" | "simulated" | "process" | "container" | "vm";

const ISOLATION_RANK: Record<IsolationLevel, number> = {
  none:      0,
  simulated: 1,
  process:   2,
  container: 3,
  vm:        4,
};

/** level1 >= level2 mi? (yeterince güçlü izolasyon mu sağlıyor) */
export function isolationMeetsMinimum(provided: IsolationLevel, required: IsolationLevel): boolean {
  return ISOLATION_RANK[provided] >= ISOLATION_RANK[required];
}

// ─── Adapter'ın Kendi İzolasyon Seviyesini Beyan Etmesi ──────────────────────

/**
 * Mevcut ISandboxAdapter implementasyonlarının (Aşama 13) hangi seviyeyi
 * sağladığını burada AÇIKÇA eşliyoruz — adapter kodu (sandbox/ modülü)
 * değiştirilmeden, isim bazlı bir kayıt tablosu ile.
 *
 * Yeni bir adapter eklendiğinde (örn. ContainerSandboxAdapter, Aşama 14
 * roadmap'inde bahsedilmişti) burada bir satır eklenir — registry kodu
 * değişmez.
 */
const KNOWN_ADAPTER_ISOLATION: Record<string, IsolationLevel> = {
  "mock":    "simulated", // sandbox/adapters/sandbox-adapters.ts → MockSandboxAdapter
  "process": "process",   // sandbox/adapters/sandbox-adapters.ts → ProcessSandboxAdapter
  // "container": "container",  // ileride: ContainerSandboxAdapter (Docker)
  // "wasm":      "vm",         // ileride: WasmSandboxAdapter
};

/**
 * Bir ISandboxAdapter'ın sağladığı izolasyon seviyesini sorgula.
 * Bilinmeyen adapter adı → en düşük güven seviyesi ("none") varsayılır
 * (fail-safe: tanımadığımız bir adapter'a asla yüksek güven vermeyiz).
 */
export function resolveAdapterIsolation(adapter: ISandboxAdapter): IsolationLevel {
  return KNOWN_ADAPTER_ISOLATION[adapter.name] ?? "none";
}

// ─── Manifest'te Zorunlu Minimum İzolasyon Beyanı ────────────────────────────

export interface IsolationRequirement {
  /** Bu plugin'in çalışması için kabul edilebilir minimum izolasyon */
  minimumIsolation: IsolationLevel;
  /** Neden bu seviye gerekli (denetim/dokümantasyon için, opsiyonel) */
  rationale?: string;
}

export interface IsolationCheckResult {
  ok:               boolean;
  required:         IsolationLevel;
  provided:         IsolationLevel;
  reason?:          string;
}

/**
 * Plugin'in talep ettiği minimum izolasyon ile registry'nin elindeki
 * adapter'ın sağladığı seviyeyi karşılaştır.
 *
 * Bu kontrol PluginRegistry.activate() çağrısından ÖNCE yapılmalıdır —
 * uyumsuzluk varsa plugin hiç sandbox'a girmeden reddedilir (drift'i
 * "sessizce daha zayıf çalıştırmak" yerine "açıkça reddetmek" olarak çözer).
 */
export function checkIsolationRequirement(
  requirement: IsolationRequirement,
  adapter:     ISandboxAdapter
): IsolationCheckResult {
  const provided = resolveAdapterIsolation(adapter);
  const ok = isolationMeetsMinimum(provided, requirement.minimumIsolation);

  return {
    ok,
    required: requirement.minimumIsolation,
    provided,
    reason: ok
      ? undefined
      : `Adapter "${adapter.name}" (${provided}) plugin'in istediği minimum izolasyonu ` +
        `(${requirement.minimumIsolation}) karşılamıyor. Production'da en az "process" ` +
        `seviyesi önerilir; "simulated" yalnızca test/geliştirme içindir.`,
  };
}

/**
 * Operatör için kolaylık: bir adapter'ın production'a uygun olup
 * olmadığını tek satırda sorgula ("simulated" ve "none" production'da kabul edilmez).
 */
export function isProductionGradeAdapter(adapter: ISandboxAdapter): boolean {
  const level = resolveAdapterIsolation(adapter);
  return isolationMeetsMinimum(level, "process");
}
