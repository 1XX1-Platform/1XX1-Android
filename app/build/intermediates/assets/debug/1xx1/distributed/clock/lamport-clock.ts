/**
 * 1XX1 Lamport Clock
 * Aşama 14 — Dağıtık Düğüm Senkronizasyonu V2
 *
 * Dağıtık sistemlerde olayların nedensel sıralamasını sağlar.
 * number yerine sınıf — tip güvenliği + Vector Clock mirasına hazır.
 *
 * Kurallar:
 *   tick()          → yerel olay: +1
 *   merge(remote)   → uzak mesaj alındı: max(local, remote) + 1
 *   current()       → salt okunur değer
 *
 * İleride Vector Clock eklenebilmesi için IClock arayüzü.
 */

// ─── Saat Arayüzü ─────────────────────────────────────────────────────────────

export interface IClock {
  tick(): number;
  merge(remoteClock: number): number;
  current(): number;
  serialize(): number;
  restore(value: number): void;
  compareTo(other: IClock): -1 | 0 | 1;
}

// ─── Lamport Clock ────────────────────────────────────────────────────────────

export class LamportClock implements IClock {
  private _value: number;

  constructor(initial = 0) {
    this.initial = initial;
    this._value = initial;
  }

  /**
   * Yerel olay: saati 1 artır.
   * @returns Yeni değer
   */
  tick(): number {
    this._value += 1;
    return this._value;
  }

  /**
   * Uzak mesaj alındı: max(local, remote) + 1
   * Bu kural Lamport'un temel teoremini uygular:
   * "Eğer a → b ise C(a) < C(b)"
   *
   * @returns Güncellenmiş değer
   */
  merge(remoteClock: number): number {
    this._value = Math.max(this._value, remoteClock) + 1;
    return this._value;
  }

  /** Salt okunur mevcut değer */
  current(): number {
    return this._value;
  }

  /** Seri hale getir (snapshot/persist için) */
  serialize(): number {
    return this._value;
  }

  /** Önceki değerden geri yükle (restart recovery) */
  restore(value: number): void {
    if (typeof value !== "number" || value < 0) return;
    this._value = value;
  }

  /**
   * Başka bir Lamport Clock ile karşılaştır.
   * Deterministik toplam sıralama için kullanılır.
   */
  compareTo(other: IClock): -1 | 0 | 1 {
    const otherVal = other.current();
    if (this._value < otherVal) return -1;
    if (this._value > otherVal) return  1;
    return 0;
  }

  toString(): string {
    return `L(${this._value})`;
  }
}

// ─── Vector Clock (İleride) ───────────────────────────────────────────────────

/**
 * Vector Clock stub — Aşama 15+ için hazır slot.
 * IClock arayüzü korunduğundan üst katmanlar değişmeden çalışır.
 */
export class VectorClock implements IClock {
  private readonly vec: Map<string, number>;

  constructor(
    nodeId: string,
    initial: Map<string, number> = new Map()
  ) {
    this.vec = new Map(initial);
    if (!this.vec.has(nodeId)) this.vec.set(nodeId, 0);
  }

  tick(): number {
    const cur = this.vec.get(this.nodeId) ?? 0;
    this.vec.set(this.nodeId, cur + 1);
    return cur + 1;
  }

  /**
   * Vector merge: her bileşen için max.
   * remoteClock: serialize() çıktısı (basit toplam, gerçek merge için extend edilmeli).
   */
  merge(remoteClock: number): number {
    // Lamport uyumlu basit merge (tam Vector Clock için MessageEnvelope'a vektör ekle)
    const cur = this.vec.get(this.nodeId) ?? 0;
    const newVal = Math.max(cur, remoteClock) + 1;
    this.vec.set(this.nodeId, newVal);
    return newVal;
  }

  current(): number {
    return this.vec.get(this.nodeId) ?? 0;
  }

  serialize(): number {
    // Toplam değer (compat) — tam serialize: JSON.stringify(Object.fromEntries(vec))
    return Array.from(this.vec.values()).reduce((a, b) => a + b, 0);
  }

  restore(value: number): void {
    this.vec.set(this.nodeId, value);
  }

  compareTo(other: IClock): -1 | 0 | 1 {
    const a = this.serialize();
    const b = other.serialize();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Bileşen vektörünü döndür */
  vector(): ReadonlyMap<string, number> {
    return this.vec;
  }
}

// ─── Clock Factory ────────────────────────────────────────────────────────────

export type ClockType = "lamport" | "vector";

export function createClock(type: ClockType, nodeId: string, initial = 0): IClock {
  if (type === "vector") return new VectorClock(nodeId, new Map([[nodeId, initial]]));
  return new LamportClock(initial);
}
