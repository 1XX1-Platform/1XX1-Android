/**
 * 1XX1 Plugin SDK — Plugin Etkileşim Grafiği
 * Aşama 19 (Risk Düzeltmesi 3/3)
 *
 * PROBLEM (Kaptan'ın tespiti — "Cross-plugin interaction risk"):
 *   Mevcut model yalnızca plugin→core ve plugin→EventBus etkileşimini
 *   tanımlıyordu. Ancak emitEvent() ile bir plugin'in event'i, başka
 *   bir IEventInterceptor plugin'i tarafından dinlenebilir — bu, registry
 *   tarafından hiç görünmeyen, İMPLİCİT bir bağımlılık grafiği oluşturur.
 *   Zamanla: (a) hangi plugin hangisine "bağımlı" belirsizleşir,
 *   (b) bir plugin deactivate edilince başka plugin'lerin sessizce
 *   bozulması riski doğar, (c) çalıştırma sırası deterministik olmayabilir.
 *
 * ÇÖZÜM: Aşama 11'in DependencyGraph'ı (asset/dependency/) ile AYNI
 * desende — DAG + BFS döngü tespiti — bir PluginDependencyGraph.
 * Farkı: kenarlar artık "asset bağımlılığı" değil "plugin event
 * aboneliği" anlamına gelir. Bir plugin, başka bir plugin'in event'ini
 * dinlemek istediğinde bunu manifest'te AÇIKÇA beyan etmek zorundadır
 * (subscribesToEvents alanı) — registry bu beyanı graf olarak modelleyip
 * döngüsel abonelik zincirlerini (A dinler B'yi, B dinler A'yı → sonsuz
 * döngü riski) reddeder.
 */

// ─── Etkileşim Kenarı ─────────────────────────────────────────────────────────

export type PluginInteractionType =
  | "subscribes_to"  // sourcePlugin, targetPlugin'in event'lerini dinler
  | "depends_on";     // sourcePlugin, targetPlugin'in registry'de aktif olmasını gerektirir (manifest.dependencies zaten var — bu, EVENT bazlı ek bağı temsil eder)

export interface PluginInteractionEdge {
  sourcePlugin: string;
  targetPlugin: string;
  type:         PluginInteractionType;
  /** Hangi event türü/türleri için (subscribes_to ise) */
  eventTypes?:  string[];
  addedAt:      Date;
}

// ─── Sonuç Tipleri (Aşama 11 DependencyGraph ile simetrik) ───────────────────

export interface InteractionCheckResult {
  ok:      boolean;
  reason?: string;
  cycle?:  string[];
}

export interface InteractionPath {
  path:  string[];
  depth: number;
}

// ─── PluginDependencyGraph ────────────────────────────────────────────────────

/**
 * Aşama 11'in DependencyGraph'ıyla bilinçli olarak aynı algoritma deseni:
 * DAG zorunluluğu + BFS ile döngü tespiti. Bu, kod tekrarı değil —
 * plugin/ modülü asset/ modülünü import EDEMEZ (DEPENDENCY_RULES.md),
 * bu yüzden aynı kanıtlanmış desen plugin'e özgü olarak yeniden yazıldı.
 */
export class PluginDependencyGraph {
  private readonly edges = new Map<string, Set<string>>();
  private readonly edgeDetails = new Map<string, Map<string, PluginInteractionEdge>>();

  // ─── Kenar Ekleme ────────────────────────────────────────────────────────

  /**
   * Bir plugin etkileşimi (örn. abonelik) ekle.
   * Döngü oluşturuyorsa reddedilir — A→B→C→A zinciri kurulamaz.
   */
  addInteraction(edge: PluginInteractionEdge): InteractionCheckResult {
    const { sourcePlugin, targetPlugin } = edge;

    if (sourcePlugin === targetPlugin) {
      return { ok: false, reason: "Bir plugin kendi event'ine abone olamaz" };
    }

    // Döngü kontrolü: targetPlugin'den sourcePlugin'e zaten bir yol var mı?
    const existingPath = this._findPath(targetPlugin, sourcePlugin);
    if (existingPath) {
      return {
        ok: false,
        reason: `Döngüsel plugin etkileşimi: ${[...existingPath, sourcePlugin].join(" → ")}`,
        cycle: [...existingPath, sourcePlugin],
      };
    }

    if (!this.edges.has(sourcePlugin)) this.edges.set(sourcePlugin, new Set());
    this.edges.get(sourcePlugin)!.add(targetPlugin);

    if (!this.edgeDetails.has(sourcePlugin)) this.edgeDetails.set(sourcePlugin, new Map());
    this.edgeDetails.get(sourcePlugin)!.set(targetPlugin, edge);

    return { ok: true };
  }

  removeInteraction(sourcePlugin: string, targetPlugin: string): boolean {
    const removed = this.edges.get(sourcePlugin)?.delete(targetPlugin) ?? false;
    this.edgeDetails.get(sourcePlugin)?.delete(targetPlugin);
    if (this.edges.get(sourcePlugin)?.size === 0) this.edges.delete(sourcePlugin);
    return removed;
  }

  /** Bir plugin deactivate edildiğinde tüm etkileşimlerini temizle */
  removeAllForPlugin(pluginName: string): number {
    let removed = 0;
    // Kaynak olarak
    if (this.edges.delete(pluginName)) removed++;
    this.edgeDetails.delete(pluginName);
    // Hedef olarak (başkaları bu plugin'i dinliyorsa)
    for (const [src, targets] of this.edges) {
      if (targets.delete(pluginName)) {
        removed++;
        this.edgeDetails.get(src)?.delete(pluginName);
      }
    }
    return removed;
  }

  // ─── Sorgular ────────────────────────────────────────────────────────────

  /** Bu plugin'in dinlediği (bağımlı olduğu) plugin'ler */
  dependsOn(pluginName: string): string[] {
    return Array.from(this.edges.get(pluginName) ?? []);
  }

  /** Bu plugin'i dinleyen (ona bağımlı olan) plugin'ler — deactivate öncesi etki analizi için kritik */
  dependents(pluginName: string): string[] {
    const result: string[] = [];
    for (const [src, targets] of this.edges) {
      if (targets.has(pluginName)) result.push(src);
    }
    return result;
  }

  /**
   * Bir plugin'i devre dışı bırakmanın "blast radius"ı — hangi
   * plugin'ler doğrudan veya dolaylı olarak etkilenir.
   * Registry, deactivate() öncesi bunu operatöre göstermelidir.
   */
  impactRadius(pluginName: string): Set<string> {
    const visited = new Set<string>();
    const stack    = [pluginName];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dependent of this.dependents(current)) {
        if (!visited.has(dependent)) {
          visited.add(dependent);
          stack.push(dependent);
        }
      }
    }
    return visited;
  }

  /** İki plugin arasında bir etkileşim zinciri var mı (BFS, en kısa yol) */
  findPath(from: string, to: string): InteractionPath | null {
    const path = this._findPath(from, to);
    return path ? { path, depth: path.length - 1 } : null;
  }

  /** Tüm sistemdeki etkileşim grafiği istatistikleri — denetim paneli için */
  stats(): { totalEdges: number; pluginCount: number; maxFanOut: number } {
    const plugins = new Set<string>();
    let totalEdges = 0;
    let maxFanOut  = 0;

    for (const [src, targets] of this.edges) {
      plugins.add(src);
      for (const t of targets) plugins.add(t);
      totalEdges += targets.size;
      maxFanOut = Math.max(maxFanOut, targets.size);
    }

    return { totalEdges, pluginCount: plugins.size, maxFanOut };
  }

  /** Topolojik sıralama — deterministik çalıştırma sırası için (örn. event dispatch sırası) */
  topologicalOrder(): string[] | null {
    const visited  = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const allNodes = new Set<string>();
    for (const [src, targets] of this.edges) {
      allNodes.add(src);
      for (const t of targets) allNodes.add(t);
    }

    const visit = (node: string): boolean => {
      if (visited.has(node)) return true;
      if (visiting.has(node)) return false; // döngü — olmamalı (addInteraction zaten engeller)
      visiting.add(node);
      for (const dep of (this.edges.get(node) ?? [])) {
        if (!visit(dep)) return false;
      }
      visiting.delete(node);
      visited.add(node);
      result.push(node);
      return true;
    };

    for (const node of allNodes) {
      if (!visit(node)) return null; // beklenmeyen döngü tespit edildi
    }

    return result;
  }

  // ─── Private: BFS Yol Bul (Aşama 11 DependencyGraph._findPath ile aynı desen) ──

  private _findPath(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      for (const neighbor of (this.edges.get(id) ?? [])) {
        const newPath = [...path, neighbor];
        if (neighbor === to) return newPath;
        queue.push({ id: neighbor, path: newPath });
      }
    }
    return null;
  }
}
