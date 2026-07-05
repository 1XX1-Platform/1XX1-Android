/**
 * 1XX1 Capability Catalog + Compatibility Matrix — FAZ 10 Block 2+3
 *
 * Catalog:  Plugin'in ne yapabildigini standart bicimiyle tanimlar.
 * Matrix:   Yukleme oncesi uyumluluk ve risk gosterir.
 *
 * Manifest "ne oldugunu" soylerse,
 * Catalog  "ne yapabildigini" gosterir.
 */

// ─── Capability Tipleri ───────────────────────────────────────────────────────

export type CapabilityCategory =
  | "storage"
  | "auth"
  | "routing"
  | "metrics"
  | "transform"
  | "policy"
  | "security"
  | "lifecycle";

export type CapabilityEntry = {
  pluginId:    string;
  version:     string;
  categories:  CapabilityCategory[];
  provides:    string[];   // sagladigi servisler
  requires:    string[];   // ihtiyac duydugu servisler
  interfaceVersion: string; // API kontrat versiyonu
  deprecated:  boolean;
  deprecatedAt?: number;
};

// ─── Compatibility Record ─────────────────────────────────────────────────────

export type CompatibilityRecord = {
  pluginA:      string;
  pluginB:      string;
  compatible:   boolean;
  minVersionA:  string;
  minVersionB:  string;
  riskLevel:    "none" | "low" | "medium" | "high";
  notes:        string;
};

// ─── Capability Catalog ───────────────────────────────────────────────────────

export class CapabilityCatalog {
  private entries = new Map<string, CapabilityEntry>();

  register(entry: CapabilityEntry): void {
    this.entries.set(entry.pluginId, entry);
  }

  get(pluginId: string): CapabilityEntry | null {
    return this.entries.get(pluginId) ?? null;
  }

  /** Belirli kategoriyi saglayan plugin'leri bul */
  byCategory(category: CapabilityCategory): CapabilityEntry[] {
    return [...this.entries.values()].filter(e => e.categories.includes(category));
  }

  /** Belirli servisi saglayan plugin'leri bul */
  byProvides(service: string): CapabilityEntry[] {
    return [...this.entries.values()].filter(e => e.provides.includes(service));
  }

  /** Deprecated plugin'ler */
  deprecated(): CapabilityEntry[] {
    return [...this.entries.values()].filter(e => e.deprecated);
  }

  remove(pluginId: string): void { this.entries.delete(pluginId); }
  all(): CapabilityEntry[]       { return [...this.entries.values()]; }
  count(): number                { return this.entries.size; }
}

// ─── Compatibility Matrix ─────────────────────────────────────────────────────

export class CompatibilityMatrix {
  private records: CompatibilityRecord[] = [];

  /** Uyumluluk kaydi ekle */
  add(record: CompatibilityRecord): void {
    // Varsa guncelle
    const idx = this.records.findIndex(
      r => (r.pluginA === record.pluginA && r.pluginB === record.pluginB) ||
           (r.pluginA === record.pluginB && r.pluginB === record.pluginA)
    );
    if (idx >= 0) this.records[idx] = record;
    else this.records.push(record);
  }

  /** Iki plugin uyumlu mu? */
  check(pluginA: string, pluginB: string): CompatibilityRecord | null {
    return this.records.find(
      r => (r.pluginA === pluginA && r.pluginB === pluginB) ||
           (r.pluginA === pluginB && r.pluginB === pluginA)
    ) ?? null;
  }

  /** Plugin'in tum uyumluluk kayitlari */
  forPlugin(pluginId: string): CompatibilityRecord[] {
    return this.records.filter(r => r.pluginA === pluginId || r.pluginB === pluginId);
  }

  /** Yuksek risk kayitlari */
  highRisk(): CompatibilityRecord[] {
    return this.records.filter(r => r.riskLevel === "high" || !r.compatible);
  }

  /** Yukleme oncesi risk ozeti */
  installRisk(pluginId: string, existingPlugins: string[]): {
    riskLevel: "none" | "low" | "medium" | "high";
    conflicts: string[];
    warnings:  string[];
  } {
    const conflicts: string[] = [];
    const warnings:  string[] = [];
    let maxRisk: "none" | "low" | "medium" | "high" = "none";

    const riskOrder = { none: 0, low: 1, medium: 2, high: 3 };

    for (const existing of existingPlugins) {
      const rec = this.check(pluginId, existing);
      if (!rec) continue;
      if (!rec.compatible) conflicts.push(existing);
      else if (rec.riskLevel !== "none") warnings.push(`${existing}: ${rec.notes}`);
      if (riskOrder[rec.riskLevel] > riskOrder[maxRisk]) maxRisk = rec.riskLevel;
    }

    return { riskLevel: maxRisk, conflicts, warnings };
  }

  all(): CompatibilityRecord[] { return [...this.records]; }
  count(): number               { return this.records.length; }
}
